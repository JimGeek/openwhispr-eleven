const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GROK_STT_DEFAULT_MODEL,
  GrokSttResolver,
  isGrokSttId,
  parseGrokSttVersion,
  shouldTryNextModel,
  sortGrokSttModels,
  transcribeWithFallback,
} = require("../../src/helpers/grokStt.js");

const listOf = (...ids) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: ids.map((id) => ({ id })) }),
});

function resolverWith(fetchFn, clock = { t: 0 }) {
  return Object.assign(new GrokSttResolver({ fetchFn, now: () => clock.t }), { clock });
}

test("parses Grok STT versions and ignores other models", () => {
  assert.deepEqual(parseGrokSttVersion("x-ai/grok-stt-2.0"), [2, 0]);
  assert.deepEqual(parseGrokSttVersion("x-ai/grok-stt-3"), [3, 0]);
  assert.deepEqual(parseGrokSttVersion("x-ai/grok-stt-2.10"), [2, 10]);
  assert.equal(parseGrokSttVersion("openai/whisper-1"), null);
  assert.equal(parseGrokSttVersion("x-ai/grok-4"), null);
  assert.equal(isGrokSttId("x-ai/grok-stt-1.0"), true);
  assert.equal(isGrokSttId(""), false);
});

test("sorts newest first by number, not by text (2.10 beats 2.9)", () => {
  assert.deepEqual(
    sortGrokSttModels([
      "x-ai/grok-stt-1.0",
      "x-ai/grok-stt-2.9",
      "x-ai/grok-stt-2.10",
      "openai/whisper-1",
      "x-ai/grok-stt-2.9",
    ]),
    ["x-ai/grok-stt-2.10", "x-ai/grok-stt-2.9", "x-ai/grok-stt-1.0"]
  );
});

test("a newer Grok STT is picked up automatically", async () => {
  const r = resolverWith(async () =>
    listOf("openai/whisper-1", "x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0")
  );
  assert.deepEqual(await r.candidates("x-ai/grok-stt-1.0"), [
    "x-ai/grok-stt-3.0",
    "x-ai/grok-stt-2.0",
  ]);
  assert.deepEqual(await r.candidates(""), ["x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0"]);
});

test("another OpenRouter model chosen by the user is respected", async () => {
  let calls = 0;
  const r = resolverWith(async () => (calls++, listOf("x-ai/grok-stt-2.0")));
  assert.deepEqual(await r.candidates("openai/whisper-1"), ["openai/whisper-1"]);
  assert.equal(calls, 0);
});

test("the list is cached, then refreshed after its time is up", async () => {
  let calls = 0;
  const r = resolverWith(async () => (calls++, listOf("x-ai/grok-stt-2.0")));
  await r.candidates("");
  await r.candidates("");
  assert.equal(calls, 1);
  r.clock.t = 7 * 60 * 60 * 1000;
  await r.candidates("");
  assert.equal(calls, 2);
});

test("offline: uses the last good list, and the built-in default if there never was one", async () => {
  const never = resolverWith(async () => {
    throw new Error("offline");
  });
  assert.deepEqual(await never.candidates(""), [GROK_STT_DEFAULT_MODEL]);

  let up = true;
  const r = resolverWith(async () => {
    if (!up) throw new Error("offline");
    return listOf("x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0");
  });
  await r.candidates("");
  up = false;
  r.clock.t = 7 * 60 * 60 * 1000;
  assert.deepEqual(await r.candidates(""), ["x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0"]);
});

test("an error or empty answer from the list uses the default", async () => {
  assert.deepEqual(await resolverWith(async () => ({ ok: false, status: 500 })).candidates(""), [
    GROK_STT_DEFAULT_MODEL,
  ]);
  assert.deepEqual(await resolverWith(async () => listOf("openai/whisper-1")).candidates(""), [
    GROK_STT_DEFAULT_MODEL,
  ]);
});

test("which failures move on to the next model", () => {
  for (const s of [400, 404, 410, 422, 500, 502, 503])
    assert.equal(shouldTryNextModel(s), true, String(s));
  for (const s of [401, 402, 403, 429]) assert.equal(shouldTryNextModel(s), false, String(s));
});

test("if the newest model is gone, the next one is used and the gone one is skipped for a while", async () => {
  const r = resolverWith(async () => listOf("x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0"));
  const tried = [];
  const send = async (model) => {
    tried.push(model);
    return model === "x-ai/grok-stt-3.0"
      ? { ok: false, status: 404, text: "no such model" }
      : { ok: true, status: 200, json: { text: "hi" } };
  };
  const out = await transcribeWithFallback({ resolver: r, requested: "x-ai/grok-stt-2.0", send });
  assert.deepEqual(out, { json: { text: "hi" }, model: "x-ai/grok-stt-2.0" });
  assert.deepEqual(tried, ["x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0"]);

  tried.length = 0;
  await transcribeWithFallback({ resolver: r, requested: "", send });
  assert.deepEqual(tried, ["x-ai/grok-stt-2.0"]); // 3.0 is skipped now

  r.clock.t = 2 * 60 * 60 * 1000; // an hour later it is tried again
  tried.length = 0;
  await transcribeWithFallback({ resolver: r, requested: "", send });
  assert.deepEqual(tried, ["x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0"]);
});

test("a bad key or rate limit stops straight away without trying other models", async () => {
  const r = resolverWith(async () => listOf("x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0"));
  const tried = [];
  const send = async (model) => (tried.push(model), { ok: false, status: 401, text: "bad key" });
  await assert.rejects(transcribeWithFallback({ resolver: r, requested: "", send }), /401 bad key/);
  assert.deepEqual(tried, ["x-ai/grok-stt-3.0"]);
});

test("a network error tries the next model, then reports the error", async () => {
  const r = resolverWith(async () => listOf("x-ai/grok-stt-3.0", "x-ai/grok-stt-2.0"));
  let n = 0;
  const flaky = async () => {
    if (n++ === 0) throw new Error("socket hang up");
    return { ok: true, status: 200, json: { text: "ok" } };
  };
  assert.equal(
    (await transcribeWithFallback({ resolver: r, requested: "", send: flaky })).model,
    "x-ai/grok-stt-2.0"
  );
  const dead = async () => {
    throw new Error("offline");
  };
  await assert.rejects(
    transcribeWithFallback({
      resolver: resolverWith(async () => listOf("x-ai/grok-stt-2.0")),
      requested: "",
      send: dead,
    }),
    /offline/
  );
});

test("a saved model that is not Grok is passed through untouched", async () => {
  const r = resolverWith(async () => listOf("x-ai/grok-stt-2.0"));
  const out = await transcribeWithFallback({
    resolver: r,
    requested: "openai/whisper-1",
    send: async (m) => ({ ok: true, status: 200, json: { m } }),
  });
  assert.equal(out.model, "openai/whisper-1");
});
