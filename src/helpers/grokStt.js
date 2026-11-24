/**
 * Grok STT on OpenRouter: always use the newest version, and keep working when it changes.
 *
 * OpenRouter publishes xAI's speech-to-text as "x-ai/grok-stt-<major>.<minor>" (1.0 was replaced
 * by 2.0). Instead of hardcoding a version we ask OpenRouter's public model list which Grok STT
 * models exist, use the highest, and if a request fails because a model is gone or unavailable we
 * fall back to the next one. If the list can't be fetched we use the last answer we got, then the
 * built-in default. A user who picked another OpenRouter model (say openai/whisper-1) is left alone.
 */

const GROK_STT_DEFAULT_MODEL = "x-ai/grok-stt-2.0";
const MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=transcription";
const GROK_STT_ID = /^x-ai\/grok-stt-(\d+)(?:\.(\d+))?$/;
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const BAD_MODEL_TTL_MS = 60 * 60 * 1000;
const LIST_TIMEOUT_MS = 5000;

/** [major, minor] for a Grok STT id, or null for anything else. */
function parseGrokSttVersion(id) {
  const m = GROK_STT_ID.exec(String(id || "").trim());
  return m ? [Number(m[1]), Number(m[2] || 0)] : null;
}

function isGrokSttId(id) {
  return parseGrokSttVersion(id) !== null;
}

/** Grok STT ids from a list of model ids, newest first, no duplicates. */
function sortGrokSttModels(ids) {
  return [...new Set((ids || []).filter(isGrokSttId))].sort((a, b) => {
    const [a1, a2] = parseGrokSttVersion(a);
    const [b1, b2] = parseGrokSttVersion(b);
    return b1 - a1 || b2 - a2;
  });
}

/** A failed request is worth retrying on another model when the model (not the user) is the problem. */
function shouldTryNextModel(status) {
  return [400, 404, 410, 422].includes(status) || status >= 500;
}

class GrokSttResolver {
  /**
   * @param {{ fetchFn: (url: string, init?: object) => Promise<Response>, now?: () => number }} deps
   */
  constructor({ fetchFn, now = Date.now }) {
    this.fetchFn = fetchFn;
    this.now = now;
    this.listed = null; // { at, ids } from the last successful fetch
    this.bad = new Map(); // model id -> time it was marked unusable
  }

  async fetchList() {
    const response = await this.fetchFn(MODELS_URL, {
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`model list ${response.status}`);
    const body = await response.json();
    return sortGrokSttModels((body?.data || []).map((m) => m?.id));
  }

  async listedModels() {
    const fresh = this.listed && this.now() - this.listed.at < LIST_TTL_MS;
    if (fresh) return this.listed.ids;
    try {
      const ids = await this.fetchList();
      if (ids.length > 0) this.listed = { at: this.now(), ids };
      return ids;
    } catch {
      return this.listed ? this.listed.ids : []; // keep the last good answer when offline
    }
  }

  /** Models to try, best first, for what the app asked for. */
  async candidates(requested) {
    const asked = String(requested || "").trim();
    if (asked.includes("/") && !isGrokSttId(asked)) return [asked]; // another model: respect it

    const ids = await this.listedModels();
    const usable = ids.filter((id) => {
      const at = this.bad.get(id);
      return at === undefined || this.now() - at > BAD_MODEL_TTL_MS;
    });
    const pool = usable.length > 0 ? usable : ids;
    return pool.length > 0 ? pool : [GROK_STT_DEFAULT_MODEL];
  }

  markBad(id) {
    this.bad.set(id, this.now());
    this.listed = null; // look again next time
  }
}

/**
 * Sends the request to each candidate in turn until one works.
 * `send(modelId)` returns { ok, status, json?, text? } (and may throw on network errors).
 */
async function transcribeWithFallback({ resolver, requested, send, log = () => {} }) {
  const models = await resolver.candidates(requested);
  let last = null;
  for (const model of models) {
    try {
      const result = await send(model);
      if (result.ok) return { json: result.json, model };
      last = new Error(`OpenRouter API Error: ${result.status} ${result.text || ""}`.trim());
      if (!shouldTryNextModel(result.status)) throw last;
      if ([400, 404, 410, 422].includes(result.status)) resolver.markBad(model);
      log(`Grok STT model ${model} failed (${result.status}), trying the next one`);
    } catch (error) {
      if (error === last) throw error; // not a model problem
      last = error; // network error: try the next model, then give up
    }
  }
  throw last || new Error("OpenRouter API Error: no Grok STT model available");
}

module.exports = {
  GROK_STT_DEFAULT_MODEL,
  MODELS_URL,
  GrokSttResolver,
  isGrokSttId,
  parseGrokSttVersion,
  shouldTryNextModel,
  sortGrokSttModels,
  transcribeWithFallback,
};
