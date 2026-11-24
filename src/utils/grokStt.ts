/**
 * The renderer's side of "always the latest Grok STT" (the main process does the live lookup:
 * src/helpers/grokStt.js). Here we only make sure a saved older Grok STT choice moves forward.
 */
export const GROK_STT_DEFAULT_MODEL = "x-ai/grok-stt-2.0";

const GROK_STT_ID = /^x-ai\/grok-stt-(\d+)(?:\.(\d+))?$/;

function version(id: string): [number, number] | null {
  const m = GROK_STT_ID.exec(id.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** A saved Grok STT id older than the default becomes the default; everything else is unchanged. */
export function upgradeGrokSttModel(saved: string): string {
  const v = version(saved);
  const base = version(GROK_STT_DEFAULT_MODEL);
  if (!v || !base) return saved;
  return v[0] < base[0] || (v[0] === base[0] && v[1] < base[1]) ? GROK_STT_DEFAULT_MODEL : saved;
}
