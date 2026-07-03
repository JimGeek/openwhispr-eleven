const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

// ElevenLabs Scribe v2 Realtime streaming STT client.
//
// Mirrors the structure of deepgramStreaming.js / openaiRealtimeStreaming.js so it
// drops into the existing streaming-provider plumbing (see NOTES.md §2/§3). The
// WebSocket lives in the main process; the API key is passed in via `connect()` and
// never logged. Audio in is PCM 16-bit / 16 kHz / mono / little-endian — the exact
// format the renderer's AudioWorklet already emits, so no resampling is needed.

const SAMPLE_RATE = 16000;
const MODEL_ID = "scribe_v2_realtime";
const WEBSOCKET_TIMEOUT_MS = 15000;
const FLUSH_TIMEOUT_MS = 2000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 s of 16-bit PCM buffered pre-ready

// Verified against the live ElevenLabs API reference (2026-07-03). IMPORTANT: these
// error `message_type` values have NO "scribe_" prefix and several do NOT end in
// "_error", so we match against this explicit Set rather than a suffix test.
const ERROR_TYPES = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "input_error",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
  "transcriber_error",
]);

// Maps each error type to a user-facing message and how the caller should react.
// `fatal` → stop the session; otherwise it is transient/retryable or a soft notice.
// (SPEC §6.4, re-keyed to the verified type strings.)
const ERROR_INFO = {
  auth_error: { message: "Invalid ElevenLabs API key.", fatal: true },
  unaccepted_terms: {
    message: "Accept the ElevenLabs Speech-to-Text terms in your dashboard.",
    fatal: true,
  },
  quota_exceeded: { message: "ElevenLabs quota/credits exhausted.", fatal: true },
  resource_exhausted: { message: "ElevenLabs quota/credits exhausted.", fatal: true },
  rate_limited: { message: "Rate limited, retrying…", fatal: false, retry: true },
  commit_throttled: { message: "Rate limited, retrying…", fatal: false, retry: true },
  session_time_limit_exceeded: {
    message: "Session limit reached; reconnecting.",
    fatal: false,
    rotate: true,
  },
  chunk_size_exceeded: { message: "Audio chunk too large.", fatal: false },
  insufficient_audio_activity: { message: "No speech detected.", fatal: false, soft: true },
  input_error: { message: "Transcription input error, retrying…", fatal: false, retry: true },
  transcriber_error: { message: "Transcription error, retrying…", fatal: false, retry: true },
  queue_overflow: { message: "Transcription error, retrying…", fatal: false, retry: true },
  error: { message: "Transcription error, retrying…", fatal: false, retry: true },
};

class ElevenRealtimeStreaming {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isDisconnecting = false;

    // Callbacks assigned by the caller after construction.
    this.onReady = null;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;

    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;

    // Transcript accumulation. ElevenLabs commits one segment per utterance; we keep
    // the committed segments and emit the FULL accumulated text on each commit (the
    // renderer slices the new segment as a delta — see NOTES.md §2).
    this.finalSegments = [];
    this.currentPartial = "";

    // Audio that arrives before `session_started` is buffered, then flushed on ready.
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.audioBytesSent = 0;

    this.currentModel = MODEL_ID;
  }

  get completedSegments() {
    return this.finalSegments;
  }

  getFullTranscript() {
    return this.finalSegments.join(" ").trim();
  }

  /**
   * @param {object} options tuning knobs; see SPEC Appendix A for dictation defaults.
   * @returns {string} the full wss:// URL with query params.
   */
  buildWebSocketUrl(options = {}) {
    const params = new URLSearchParams({
      model_id: MODEL_ID,
      audio_format: "pcm_16000",
      commit_strategy: options.commitStrategy || "vad",
      vad_silence_threshold_secs: String(options.vadSilenceThresholdSecs ?? 1.2),
      vad_threshold: String(options.vadThreshold ?? 0.4),
      min_speech_duration_ms: String(options.minSpeechDurationMs ?? 100),
      min_silence_duration_ms: String(options.minSilenceDurationMs ?? 100),
      no_verbatim: String(options.noVerbatim ?? true),
    });

    const lang = options.language && options.language !== "auto" ? options.language : null;
    if (lang) params.set("language_code", lang);

    if (Array.isArray(options.keyterms)) {
      // ElevenLabs limits: max 50 keyterms, 20 chars each (+20% cost). Dedupe, filter,
      // and cap so an over-long dictionary/snippet list can't break the request.
      const seen = new Set();
      let count = 0;
      for (const raw of options.keyterms) {
        const term = String(raw || "").trim();
        if (!term || term.length > 20) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        params.append("keyterms", term);
        if (++count >= 50) break;
      }
    }

    return `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;
  }

  /**
   * Open the socket and resolve once the server sends `session_started`.
   * @param {object} options must include `apiKey`.
   */
  async connect(options = {}) {
    const { apiKey } = options;
    if (!apiKey) throw new Error("ElevenLabs API key is required");

    if (this.isConnected || this.isConnecting) {
      debugLogger.debug("Eleven realtime already connected/connecting");
      return;
    }

    this.isConnecting = true;
    this.finalSegments = [];
    this.currentPartial = "";
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.audioBytesSent = 0;
    this.isDisconnecting = false;

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("Eleven realtime connecting", {
      model: MODEL_ID,
      commitStrategy: options.commitStrategy || "vad",
      language: options.language || "auto",
    });

    let ws;
    try {
      ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });
    } catch (err) {
      this.isConnecting = false;
      this.cleanup();
      throw err;
    }

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.isConnecting = false;
        this.cleanup();
        reject(new Error("ElevenLabs realtime connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = ws;

      ws.on("open", () => {
        debugLogger.debug("Eleven realtime WebSocket opened");
      });

      ws.on("message", (data) => this.handleMessage(data));

      ws.on("error", (error) => {
        debugLogger.error("Eleven realtime WebSocket error", { error: error.message });
        this.isConnecting = false;
        this.cleanup();
        if (this.pendingReject) {
          this.pendingReject(error);
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        this.onError?.(error);
      });

      ws.on("close", (code, reason) => {
        const wasActive = this.isConnected;
        this.isConnecting = false;
        debugLogger.debug("Eleven realtime WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`WebSocket closed before ready (code: ${code})`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        this.cleanup();
        if (wasActive && !this.isDisconnecting) {
          this.onSessionEnd?.({ text: this.getFullTranscript() });
        }
      });
    });
  }

  handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      debugLogger.error("Eleven realtime message parse error", { error: err.message });
      return;
    }

    const type = msg.message_type;
    switch (type) {
      case "session_started": {
        this.sessionId = msg.session_id || null;
        this.isConnected = true;
        this.isConnecting = false;
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        debugLogger.debug("Eleven realtime session started", { sessionId: this.sessionId });
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        this.onReady?.();
        this.flushColdStartBuffer();
        break;
      }

      case "partial_transcript": {
        this.currentPartial = msg.text || "";
        // Emit the full running transcript (committed segments + live partial) for the
        // preview overlay. Interim — will change.
        const preview = `${this.getFullTranscript()} ${this.currentPartial}`.trim();
        this.onPartialTranscript?.(preview);
        break;
      }

      case "committed_transcript":
      case "committed_transcript_with_timestamps": {
        const segment = (msg.text || "").trim();
        if (segment) this.finalSegments.push(segment);
        this.currentPartial = "";
        if (segment) {
          this.onFinalTranscript?.(this.getFullTranscript(), Date.now());
          debugLogger.debug("Eleven realtime segment committed", {
            segmentPreview: segment.slice(0, 80),
            segments: this.finalSegments.length,
          });
        }
        break;
      }

      default: {
        if (ERROR_TYPES.has(type)) {
          this.handleError(msg);
        } else {
          debugLogger.debug("Eleven realtime unhandled message", { type });
        }
      }
    }
  }

  handleError(msg) {
    const type = msg.message_type;
    const info = ERROR_INFO[type] || { message: "Transcription error.", fatal: false };
    const detail = msg.message || msg.error || "";
    if (info.soft) {
      debugLogger.debug("Eleven realtime soft notice", { type, detail });
    } else {
      debugLogger.error("Eleven realtime error event", { type, detail });
    }
    const error = new Error(info.message);
    error.kind = type;
    error.fatal = !!info.fatal;
    error.retry = !!info.retry;
    error.rotate = !!info.rotate;
    error.soft = !!info.soft;
    this.onError?.(error);
  }

  /**
   * Send a PCM16 frame. Frames arriving before the session is ready are buffered.
   * @param {Buffer} pcmBuffer raw PCM 16-bit mono 16 kHz little-endian
   * @param {boolean} commit force-commit the current buffer (used on stop/flush)
   * @returns {boolean} whether the frame was sent immediately
   */
  sendAudio(pcmBuffer, commit = false) {
    if (!this.ws) return false;

    if (this.ws.readyState !== WebSocket.OPEN || !this.isConnected) {
      if (
        this.ws.readyState === WebSocket.CONNECTING &&
        this.coldStartBufferSize < COLD_START_BUFFER_MAX
      ) {
        const copy = Buffer.from(pcmBuffer);
        this.coldStartBuffer.push(copy);
        this.coldStartBufferSize += copy.length;
      }
      return false;
    }

    this.flushColdStartBuffer();
    this._sendChunk(pcmBuffer, commit);
    return true;
  }

  _sendChunk(pcmBuffer, commit = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const audioBase64 = pcmBuffer && pcmBuffer.length ? Buffer.from(pcmBuffer).toString("base64") : "";
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: audioBase64,
        commit,
        sample_rate: SAMPLE_RATE,
      })
    );
    if (pcmBuffer) this.audioBytesSent += pcmBuffer.length;
  }

  flushColdStartBuffer() {
    if (this.coldStartBuffer.length === 0) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    debugLogger.debug("Eleven realtime flushing cold-start buffer", {
      chunks: this.coldStartBuffer.length,
      bytes: this.coldStartBufferSize,
    });
    for (const buf of this.coldStartBuffer) {
      this._sendChunk(buf, false);
    }
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  /**
   * Flush any trailing audio with a final commit, wait for the last committed segment
   * (or a short timeout), then close.
   * @returns {Promise<{ text: string }>}
   */
  async disconnect() {
    debugLogger.debug("Eleven realtime disconnect", {
      audioBytesSent: this.audioBytesSent,
      segments: this.finalSegments.length,
      readyState: this.ws?.readyState,
    });

    if (!this.ws) return { text: this.getFullTranscript() };
    this.isDisconnecting = true;

    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.once("open", () => this.ws?.close());
      const result = { text: this.getFullTranscript() };
      this.isDisconnecting = false;
      return result;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      if (this.audioBytesSent > 0) {
        const prevOnFinal = this.onFinalTranscript;
        await new Promise((resolve) => {
          const tid = setTimeout(() => {
            debugLogger.debug("Eleven realtime flush timeout, using accumulated text");
            resolve();
          }, FLUSH_TIMEOUT_MS);
          const done = () => {
            clearTimeout(tid);
            this.onFinalTranscript = prevOnFinal;
            resolve();
          };
          // One final commit to flush trailing buffered audio.
          this.onFinalTranscript = (text, ts) => {
            prevOnFinal?.(text, ts);
            done();
          };
          try {
            this._sendChunk(Buffer.alloc(0), true);
          } catch {
            done();
          }
        });
      }
      try {
        this.ws.close();
      } catch {}
    }

    const result = { text: this.getFullTranscript() };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  /**
   * Force-commit the current buffer immediately (e.g. on push-to-talk release in
   * manual mode). In VAD mode the server auto-commits; this just flushes early.
   */
  finalize() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendChunk(Buffer.alloc(0), true);
    }
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      connecting: this.isConnecting,
      sessionId: this.sessionId,
      segments: this.finalSegments.length,
      audioBytesSent: this.audioBytesSent,
      model: this.currentModel,
    };
  }

  cleanup() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
  }
}

module.exports = ElevenRealtimeStreaming;
