const test = require("node:test");
const assert = require("node:assert/strict");

test("a saved older Grok STT moves to the default; newer, other and empty values are kept", async () => {
  const { upgradeGrokSttModel, GROK_STT_DEFAULT_MODEL } =
    await import("../../src/utils/grokStt.ts");
  assert.equal(GROK_STT_DEFAULT_MODEL, "x-ai/grok-stt-2.0");
  assert.equal(upgradeGrokSttModel("x-ai/grok-stt-1.0"), "x-ai/grok-stt-2.0");
  assert.equal(upgradeGrokSttModel("x-ai/grok-stt-2.0"), "x-ai/grok-stt-2.0");
  assert.equal(upgradeGrokSttModel("x-ai/grok-stt-3.0"), "x-ai/grok-stt-3.0");
  assert.equal(upgradeGrokSttModel("openai/whisper-1"), "openai/whisper-1");
  assert.equal(upgradeGrokSttModel("gpt-4o-mini-transcribe"), "gpt-4o-mini-transcribe");
  assert.equal(upgradeGrokSttModel(""), "");
});

test("the model picker lists Grok STT 2.0 and no longer 1.0", () => {
  const registry = require("../../src/models/modelRegistryData.json");
  const openrouter = registry.transcriptionProviders.find((p) => p.id === "openrouter");
  const ids = openrouter.models.map((m) => m.id);
  assert.ok(ids.includes("x-ai/grok-stt-2.0"));
  assert.ok(!ids.includes("x-ai/grok-stt-1.0"));
});
