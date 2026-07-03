# NOTES.md — Phase 0 Recon Path Map (openwhispr-eleven)

> Output of SPEC.md Phase 0. Maps every SPEC/ROADMAP item to a **real, verified** file path in this
> fork's `HEAD`. Every downstream phase references this file. Line numbers are from the fork at clone
> time (upstream `main` @ `01f8557b`); treat them as strong hints and re-confirm before editing.

**Fork:** `JimGeek/openwhispr-eleven` (from `OpenWhispr/openwhispr`, MIT). `upstream` remote wired.
**Stack (verified):** Electron 41, React 19, TypeScript, Tailwind v4, Vite, `ws` WebSocket lib,
`better-sqlite3`, `onnxruntime-node`, `@napi-rs/keyring`. Node **24** required (`.nvmrc`, `engines.node >=24`).

---

## 0. Headline findings (these change/de-risk the plan)

1. **Audio format is already exactly what ElevenLabs wants — no resampling, no ffmpeg spawn.**
   Streaming capture is renderer-side via an `AudioWorklet`. The capture `AudioContext` is hard-created
   at **16 000 Hz** (`src/helpers/audioManager.js:2575`) and the worklet emits **PCM 16-bit / 16 kHz /
   mono / little-endian** in **50 ms / 800-sample / 1600-byte** frames
   (`src/helpers/audioManager.js:246-288`). Deepgram/AssemblyAI/Corti consume this unchanged. ElevenLabs
   `audio_format=pcm_16000` is a drop-in match. **SPEC §3 (the "most likely to break" part) is effectively
   solved by reuse.** The 24 kHz constant in `openaiRealtimeStreaming.js:6` is OpenAI-only and never
   reflects captured audio.

2. **Injection is clipboard-paste, not synthetic keystrokes** (`src/helpers/clipboard.js`: macOS
   AppleScript, Windows PowerShell SendKeys / nircmd, Linux XTest/xdotool/wtype/ydotool). This confirms
   SPEC §4.3's warning: **strategy B (commit-only) is the correct default.** Strategy A (live typing) must
   re-paste with prior-text selection, **not** emit backspaces.

3. **The terminal transcript→cursor path is provider-agnostic.** `onTranscriptionComplete → safePaste →
   window.electronAPI.pasteText → clipboard.js` keys off a `"<name>-streaming"` source string. A new
   provider gets injection **for free** — no `clipboard.js` / `useAudioRecording.js` edits.

4. **Two streaming plumbing patterns exist.** Pattern A ("sidecar": Deepgram, AssemblyAI, Corti) — dedicated
   IPC channels + own client field. Pattern B ("realtime": OpenAI, Tinfoil) — shared `dictation-realtime-*`
   channels. **Mirror Pattern A / Deepgram** for ElevenLabs (cleanest, self-contained).

5. ⚠️ **Node 24 is a Phase 1 prerequisite.** `.nvmrc=24`, `engine-strict=true` in `.npmrc`. Local machine
   is on Node 22. Run `nvm install 24 && nvm use 24` before any `npm ci` / `npm install` (running install
   on a different major version corrupts `package-lock.json` and breaks CI `npm ci`).

6. ⚠️ **CI cross-compiles x64 on an Apple Silicon runner** (`release.yml` mac matrix both on `macos-latest`)
   and does **not** rebuild `better-sqlite3` / `onnxruntime-node` / `@napi-rs/keyring` for x64 (only
   `ffmpeg-static` is arch-corrected). This is exactly SPEC §8.1's Intel risk. **Fix in Phase 6:** use a
   real `macos-13` Intel runner for the x64 leg.

---

## 1. SPEC recon target → real path map (ROADMAP Phase 0 checklist)

| SPEC / ROADMAP item | Real path (verified) | Notes |
|---|---|---|
| OpenAI-Realtime provider (template) | `src/helpers/openaiRealtimeStreaming.js` | 391 lines. `ws` client; Pattern B. |
| Sibling STT streaming providers | `src/helpers/deepgramStreaming.js` (887), `assemblyAiStreaming.js` (595), `cortiStreaming.js` | **Deepgram = closest template** (pure STT, 16 kHz, partial/final). |
| Audio-capture path (streaming) | `src/helpers/audioManager.js` | Worklet `getWorkletBlobUrl()` `:246-288`; `startStreamingRecording()` `:2599-2739`. |
| Audio output format | (see Headline #1) | PCM16 / 16 kHz / mono / LE, 50 ms frames. **Reusable as-is.** |
| Text-injection module | `src/helpers/clipboard.js` | Clipboard-paste per-OS. Entry `window.electronAPI.pasteText`. |
| Provider registry (models) | `src/models/modelRegistryData.json` (`transcriptionProviders` @ `:135+`) + `src/models/ModelRegistry.ts` (`getStreamingTranscriptionProviders()` `:330-339`) | Streaming = model with `streaming:true`. |
| Streaming provider selection (runtime) | `src/helpers/audioManager.js` — `STREAMING_PROVIDERS` `:118-185`, `getStreamingProviderName()` `:334-347`, `getStreamingProvider()` `:329-332` | Driven by settings `cloudTranscriptionProvider` / `cloudTranscriptionModel` / `cloudTranscriptionMode`. |
| Settings UI picker | `src/components/TranscriptionModelPicker.tsx` | `CLOUD_PROVIDER_TABS` `:202-210`; `PROVIDER_CREDENTIALS` `:229-275`; render loop `:972-1020`. |
| Settings store | `src/stores/settingsStore.ts` + `src/hooks/useSettings.ts` | localStorage; `BOOLEAN_SETTINGS` `:106`, `NUMERIC_SETTINGS` `:153`, `ARRAY_SETTINGS` `:146`, `SECRET_IPC_SAVERS` `:755`. |
| Config-panel UI template | `src/components/SettingsPage.tsx` — `renderWhisperVadSettings()` `:1406-1525` | **Copy this** for the ElevenLabs sliders/toggles/dropdown panel. |
| Keychain wrapper | `src/helpers/environment.js` (`SECRET_KEYS` `:9-28`, `_getKey`/`_saveKey` `:248-267`) + `src/helpers/secretCrypto.js` | `@napi-rs/keyring` master key, AES-256-GCM, per-secret `userData/secure-keys/{ENV}.enc`; `safeStorage` fallback. |
| Key IPC surface | `src/helpers/ipcHandlers.js` (`get-/save-*-key` @ `:798-804`, `:2604-2845`) + `preload.js` (`:352-415`) | kebab-case `get-<provider>-key` / `save-<provider>-key`. |
| Global-hotkey registration | `src/helpers/hotkeyManager.js` (+ `windowsKeyManager.js`, `gnomeShortcut.js`, `hyprlandShortcut.js`) | Named slots: `dictation`, `agent`, `voiceAgent`, `meeting`. |
| electron-builder config | `electron-builder.json` (+ `electron-builder.unsigned-win.json`) | mac `dmg`+`zip` `:132-155`; win `nsis`+`portable` `:156-171`; linux `:172-177`. |
| Entitlements / Info.plist | `resources/mac/entitlements.mac.plist`; `mac.extendInfo` `electron-builder.json:148-154` | Has `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSAccessibilityUsageDescription`. |
| CI | `.github/workflows/release.yml` (only app pipeline; tag `v*.*.*`) + 10 sidecar/scan workflows | See Headline #6. |
| afterSign hook | **DOES NOT EXIST** (upstream CLAUDE.md is stale) | Only hook is `scripts/afterPack.js`. Unsigned mac = `CSC_IDENTITY_AUTO_DISCOVERY=false` + `--dir`. |

---

## 2. The streaming-client contract (what ElevenRealtimeClient must implement)

Class shape mirrored from `deepgramStreaming.js` / `openaiRealtimeStreaming.js`:

**Methods**
- `async connect(options)` — `options = { apiKey|token, model, language, sampleRate|inputRate, keyterms, ... }`;
  resolves when the session is live.
- `sendAudio(pcmBuffer: Buffer)` — Node Buffer of PCM16; returns bool; base64-encodes & pushes over the WS.
- `async disconnect(flush)` — commits/closes, returns `{ text }`.
- `cleanup()`. Pattern-A adds: `warmup(options)`, `hasWarmConnection()`, `getCachedToken()`/`cacheToken()`,
  `getStatus()`, `finalize()`; fields `isConnected`, `ws`, `audioBytesSent`, `currentModel`.

**Callbacks (assigned by main after construction)**
- `onPartialTranscript(text)` — interim; overlay/live-preview only.
- `onFinalTranscript(fullAccumulatedText, timestamp?)` — **must emit the FULL accumulated transcript**; the
  renderer slices the new segment as a delta at `audioManager.js:2681-2684`.
- `onError(Error)`
- `onSessionEnd({ text })`

**Audio IN path:** worklet → `audioManager.js:2656-2659` `provider.send(data)` → `window.electronAPI.<x>Send`
→ `preload.js` `ipcRenderer.send("<x>-streaming-send", buf)` → `ipcHandlers.js` `ipcMain.on(...)` →
`client.sendAudio(Buffer.from(buf))`.

**Transcript OUT path:** `onFinalTranscript` → `win.webContents.send("<x>-final-transcript", text)` →
`preload.js onXFinalTranscript` → renderer `provider.onFinal` (`audioManager.js:2678-2688`) → on stop
`stopStreamingRecording()` → `onTranscriptionComplete({text, source:"<x>-streaming"})`
(`audioManager.js:3093-3098`) → `useAudioRecording.js:146-152` `safePaste(...)` → `pasteText` → `clipboard.js`.

Live incremental paste (strategy A) hook already exists: `this.onStreamingCommit?.(newSegment)` in
`audioManager.js:2686`.

---

## 3. Add-a-provider recipe (mirror Deepgram / Pattern A) — the Phase 3/4 edit set

Provider key: **`elevenlabs`**. Files to touch:

**A. NEW `src/helpers/elevenRealtimeStreaming.js`** — model on `deepgramStreaming.js`. Class
`ElevenRealtimeStreaming` implementing the §2 contract. Builds the WSS URL
(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&...`), opens with
`xi-api-key` header, parses `session_started` / `partial_transcript` / `committed_transcript` / `*_error`.
`onFinalTranscript` emits full accumulated text. `module.exports = ElevenRealtimeStreaming;`

**B. `src/helpers/ipcHandlers.js`** — `require("./elevenRealtimeStreaming")` (~`:11-15`); field
`this.elevenLabsStreaming = null` (~`:338-341`); handler block mirroring Deepgram (`:7182-7391`):
`elevenlabs-streaming-warmup|start|stop|status` (`ipcMain.handle`) + `elevenlabs-streaming-send|finalize`
(`ipcMain.on`); in `-start`, assign the 4 callbacks that `win.webContents.send("elevenlabs-<partial|final>-transcript"|"elevenlabs-error"|"elevenlabs-session-end", …)`, then `connect({ ...options, apiKey })`.
Add BYOK key fetch (`this.environmentManager.getElevenLabsKey()`).

**C. `preload.js`** (mirror Deepgram `:551-573`) — `elevenLabsStreamingWarmup/Start/Stop/Status`
(`invoke`), `elevenLabsStreamingSend/Finalize` (`send`), and listeners `onElevenLabsPartialTranscript`,
`onElevenLabsFinalTranscript`, `onElevenLabsError`, `onElevenLabsSessionEnd`.

**D. `src/helpers/audioManager.js`** — add `elevenlabs` entry to `STREAMING_PROVIDERS` (`:118-185`,
mirror `deepgram` `:120-130`); add selection branch in `getStreamingProviderName()` (`:334-347`).

**E. Keychain** — `environment.js`: add `"ELEVENLABS_API_KEY"` to `SECRET_KEYS` (`:9-28`) +
`getElevenLabsKey()`/`saveElevenLabsKey()` (~`:269`). `ipcHandlers.js`: `get-/save-elevenlabs-key`
(~`:2604`). `preload.js`: `getElevenLabsKey`/`saveElevenLabsKey` (~`:352-415`).

**F. Settings store** — `settingsStore.ts`: `elevenlabs → "saveElevenLabsKey"` in `SECRET_IPC_SAVERS`
(`:755`); hydrate `getElevenLabsKey` in `initializeSettings` (`:1977-2013`); add `elevenLabsApiKey` + ~10
config fields to `SettingsState` (`:395+`), type registries, initial state (`:835+`), setters; expose all
in `useSettings.ts` `useSettingsInternal`.

**G. Settings UI** — `modelRegistryData.json`: add `elevenlabs` to `transcriptionProviders` with a
`streaming:true` model (`:135+`). `TranscriptionModelPicker.tsx`: add tab (`:202`), extend
`ProviderCredentialField.key` union + `PROVIDER_CREDENTIALS` (`:213-275`), wire `credentialValues`/
`credentialSetters` (`:716-737`). `SettingsPage.tsx`: add `renderElevenLabsSettings()` panel modeled on
`renderWhisperVadSettings()` (`:1406-1525`), render in `TranscriptionSection` (~`:372`). **No dedicated
tag-input component** exists — copy the inline `customDictionary` tag pattern (`:772`) for `keyterms`.

**H. i18n** — every new label/description needs keys in all 9 `src/locales/*/translation.json` files
(CLAUDE.md i18n rule). Do NOT translate brand/technical terms.

**No edits needed** to `useAudioRecording.js` or `clipboard.js` (injection is provider-agnostic).

---

## 4. Packaging / CI facts (Phase 6)

- **Targets:** mac `dmg`+`zip` (arch via CLI `--x64`/`--arm64`, **no universal target configured**), win
  `nsis`+`portable` (x64), linux AppImage/deb/rpm/tar.gz. `npmRebuild:true`; `afterPack:scripts/afterPack.js`.
- **Signing:** mac identity `"Gizmo Labs Inc. (T832773L2J)"` + `notarize:true` are **hardcoded** in
  `electron-builder.json`. For our unsigned builds we must override (mirror `electron-builder.unsigned-win.json`
  with a new `unsigned-mac` config nulling `identity`/`notarize`, or pass
  `CSC_IDENTITY_AUTO_DISCOVERY=false --config.mac.notarize=false --config.mac.identity=null`).
- **Unsigned scripts:** `npm run pack` = `CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --dir`.
  `electron-builder.unsigned-win.json` exists but is **unwired** in `package.json`.
- **Native modules needing per-arch rebuild:** `better-sqlite3`, `onnxruntime-node`, `@napi-rs/keyring`,
  `ffmpeg-static` (all in `asarUnpack`). Rebuilt via `postinstall: electron-builder install-app-deps`.
- **Sidecars downloaded per-arch** (`prebuild:mac`/`prebuild:win`): whisper-cpp, llama-server, sherpa-onnx,
  qdrant, embedding-model, etc. Binary maps exist for `darwin-x64`, `darwin-arm64`, `win32-x64` — Intel covered.
- **CI to change for our matrix:** split mac legs to `macos-13` (x64) + `macos-14` (arm64); wire unsigned
  configs; add `actions/upload-artifact@v4` for `dist/*.dmg` + `dist/*.exe` (current CI only `--publish`es to
  a GitHub draft release owned by `OpenWhispr` — change owner or use artifacts).

---

## 5. Phase 1 prerequisites (do before building)

1. `nvm install 24 && nvm use 24` (repo requires Node 24; local is 22).
2. `npm ci` in the fork.
3. First-run downloads: `predev`/`prestart` pull qdrant; embedding model auto-downloads on first launch.
4. Baseline run + dictate with an existing cloud provider on this Intel Mac (ROADMAP Phase 1 gate).

---

## 6. ElevenLabs contract — VERIFIED against live docs (2026-07-03)

Source: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime

**Confirmed matching SPEC §0.1:**
- URL `wss://api.elevenlabs.io/v1/speech-to-text/realtime`; auth `xi-api-key` header (or `token` query for
  client-side). `model_id=scribe_v2_realtime`.
- `audio_format` default `pcm_16000`; enum `pcm_8000|pcm_16000|pcm_22050|pcm_24000|pcm_44100|pcm_48000|ulaw_8000`.
- `commit_strategy` enum `manual|vad` (default `manual`; **we use `vad`**).
- Defaults: `vad_silence_threshold_secs`=1.5, `vad_threshold`=0.4, `min_speech_duration_ms`=100,
  `min_silence_duration_ms`=100, `no_verbatim`=false, `include_timestamps`=false,
  `include_language_detection`=false, `enable_logging`=true. `keyterms`=array of strings.
- Client→server: `{ message_type:"input_audio_chunk", audio_base_64, commit, sample_rate, previous_text? }`
  (`previous_text` first chunk only).
- Server→client: `session_started`, `partial_transcript`(`text`), `committed_transcript`(`text`),
  `committed_transcript_with_timestamps`(`text`,`language_code`,`words`).

**⚠️ CORRECTION vs SPEC §6.3/§6.4 — error event names (must fix in Phase 2):**
Live docs list error `message_type` values **without** a `scribe_` prefix, and **several do NOT end in
`_error`**:
`error, auth_error, quota_exceeded, commit_throttled, unaccepted_terms, rate_limited, queue_overflow,
resource_exhausted, session_time_limit_exceeded, input_error, chunk_size_exceeded,
insufficient_audio_activity, transcriber_error`.
→ SPEC §6.3's `msg.message_type?.endsWith('_error')` dispatch would **miss** `quota_exceeded`,
`commit_throttled`, `unaccepted_terms`, `rate_limited`, `queue_overflow`, `resource_exhausted`,
`session_time_limit_exceeded`, `insufficient_audio_activity`, `chunk_size_exceeded`. **Use an explicit
error-type Set** (built from the list above) for dispatch, not a suffix test. Re-confirm exact values from a
live `session_started`/error frame in the Phase 2 CLI harness (a summarized doc fetch may have normalized
names). Keep the §6.4 user-message mapping but re-key it to these verified type strings.
