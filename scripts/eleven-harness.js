/**
 * Phase 2 isolation harness for ElevenRealtimeStreaming (SPEC §9 Phase 2).
 *
 * Reads a WAV file, streams it to the ElevenLabs Scribe v2 Realtime WebSocket as
 * real-time-paced PCM16 chunks, and prints partial → committed transcript events.
 * Proves auth, config, chunking, and message parsing independent of the UI.
 *
 * Runs under Electron (not plain node) because src/helpers/debugLogger.js requires
 * electron's `app`. The API key comes from the ELEVENLABS_API_KEY env var (never a file).
 *
 *   ELEVENLABS_API_KEY=... node_modules/.bin/electron scripts/eleven-harness.js <file.wav> [--lang gu]
 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const ElevenRealtimeStreaming = require("../src/helpers/elevenRealtimeStreaming");

const CHUNK_MS = 100; // frame size in ms of audio per send
const REALTIME_PACING = true; // sleep CHUNK_ms between sends so VAD sees realistic timing

function parseArgs(argv) {
  const args = argv.slice(2).filter((a) => a && a !== ".");
  const out = { wav: null, language: undefined };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--lang" && args[i + 1]) {
      out.language = args[i + 1];
      i += 1;
    } else if (a.startsWith("--lang=")) {
      out.language = a.split("=", 2)[1];
    } else if (!a.startsWith("--")) {
      out.wav = a;
    }
  }
  return out;
}

/** Minimal WAV parser: returns { sampleRate, channels, bitsPerSample, pcm }. */
function parseWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt = null;
  let pcm = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      pcm = buffer.subarray(body, body + size);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !pcm) throw new Error("Missing fmt or data chunk");
  return { ...fmt, pcm };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const { wav, language } = parseArgs(process.argv);
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    console.error("ERROR: set ELEVENLABS_API_KEY in the environment.");
    return 1;
  }
  if (!wav) {
    console.error("ERROR: pass a WAV file path.");
    return 1;
  }
  const wavPath = path.resolve(wav);
  if (!fs.existsSync(wavPath)) {
    console.error(`ERROR: file not found: ${wavPath}`);
    return 1;
  }

  const { sampleRate, channels, bitsPerSample, pcm } = parseWav(fs.readFileSync(wavPath));
  console.log(
    `[harness] WAV: ${path.basename(wavPath)} — ${sampleRate}Hz ${channels}ch ${bitsPerSample}bit, ` +
      `${pcm.length} PCM bytes (~${(pcm.length / (sampleRate * channels * (bitsPerSample / 8))).toFixed(1)}s)`
  );
  if (sampleRate !== 16000 || channels !== 1 || bitsPerSample !== 16) {
    console.warn(
      "[harness] WARNING: expected 16000Hz / 1ch / 16bit. Re-encode with: " +
        "ffmpeg -i in.wav -ar 16000 -ac 1 -c:a pcm_s16le out.wav"
    );
  }

  const client = new ElevenRealtimeStreaming();
  let partialCount = 0;
  let committedCount = 0;
  let lastPartial = "";

  client.onReady = () => console.log("[harness] session_started — streaming audio…");
  client.onPartialTranscript = (text) => {
    partialCount += 1;
    if (text !== lastPartial) {
      lastPartial = text;
      console.log(`  ~ partial:   ${text}`);
    }
  };
  client.onFinalTranscript = (text) => {
    committedCount += 1;
    console.log(`  ✓ committed: ${text}`);
  };
  client.onError = (err) => {
    console.error(`[harness] error [${err.kind || "?"}${err.fatal ? " FATAL" : ""}]: ${err.message}`);
  };

  console.log("[harness] connecting…");
  await client.connect({ apiKey, language, commitStrategy: "vad", noVerbatim: true });

  // Stream PCM in CHUNK_MS frames, paced ~1x real-time so VAD commits realistically.
  const bytesPerChunk = Math.floor((sampleRate * channels * (bitsPerSample / 8) * CHUNK_MS) / 1000);
  for (let i = 0; i < pcm.length; i += bytesPerChunk) {
    client.sendAudio(pcm.subarray(i, i + bytesPerChunk), false);
    if (REALTIME_PACING) await sleep(CHUNK_MS);
  }

  console.log("[harness] audio sent, flushing + waiting for final commit…");
  const { text } = await client.disconnect();
  // Give any last committed frame a moment to land after flush.
  await sleep(500);

  console.log("\n========================================");
  console.log(`[harness] partials: ${partialCount}  committed segments: ${committedCount}`);
  console.log(`[harness] FINAL TRANSCRIPT:\n${text || "(empty)"}`);
  console.log("========================================");
  return text && text.length ? 0 : 2;
}

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    console.error("[harness] FATAL:", err && err.stack ? err.stack : err);
    code = 1;
  }
  app.exit(code);
});
