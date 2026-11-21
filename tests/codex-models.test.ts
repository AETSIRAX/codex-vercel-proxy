import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_MODEL_CATALOG,
  defaultServiceTier,
  isResponsesLiteModel,
  lookupCodexModel,
  reasoningEffortForRequest,
  supportedServiceTiers,
} from "../src/codex-models.js";
import { configuredModels } from "../src/env.js";

test("catalog defaults to gpt-6.2-sol and the configured list excludes hidden models", () => {
  assert.equal(CODEX_MODEL_CATALOG[0]?.slug, "gpt-6.2-sol");
  assert.deepEqual(configuredModels({}), [
    "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra",
    "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
  ]);
  assert.deepEqual(configuredModels({ MODELS: " gpt-5.5, codex-auto-review " }), ["gpt-5.5", "codex-auto-review"]);
  assert.equal(lookupCodexModel("gpt-6.1-sol")?.useResponsesLite, true);
  assert.equal(lookupCodexModel("gpt-6.1-sol")?.defaultReasoningEffort, "low");
  assert.equal(lookupCodexModel("gpt-6-astra")?.useResponsesLite, true);
  assert.equal(lookupCodexModel(" gpt-5.5 ")?.slug, "gpt-5.5");
  assert.equal(lookupCodexModel("unknown-model"), undefined);
});

test("catalog carries gpt-6-sol and gpt-6-luna as responses lite models", () => {
  assert.equal(lookupCodexModel("gpt-6-sol")?.useResponsesLite, true);
  assert.equal(lookupCodexModel("gpt-6-luna")?.useResponsesLite, true);
  assert.equal(lookupCodexModel("gpt-6-sol")?.defaultReasoningEffort, "medium");
  // Retired models were dropped from the catalog upstream.
  assert.equal(lookupCodexModel("gpt-5.4-mini"), undefined);
  assert.equal(lookupCodexModel("gpt-5.2"), undefined);
  assert.equal(lookupCodexModel("gpt-5.4"), undefined);
});

test("unknown slugs fall back to model family prefixes for lite detection", () => {
  assert.equal(isResponsesLiteModel("gpt-6-nova"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6-future"), true);
  assert.equal(isResponsesLiteModel("gpt-daybreak-green-latest"), true);
  // Point releases of a lite family (gpt-6.2-*) are lite as well.
  assert.equal(isResponsesLiteModel("gpt-6.2-nova"), true);
  assert.equal(isResponsesLiteModel("gpt-5.6.1-sol"), true);
  assert.equal(isResponsesLiteModel("gpt-5.4"), false);
  assert.equal(isResponsesLiteModel("gpt-60"), false);
  assert.equal(isResponsesLiteModel("gpt-5.7"), false);
});

test("ultra maps to the model's multi-agent effort, otherwise max", () => {
  for (const model of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra"]) {
    assert.equal(lookupCodexModel(model)?.useResponsesLite, true);
    assert.equal(reasoningEffortForRequest(model, "ultra"), "xhigh");
  }
  assert.equal(reasoningEffortForRequest("gpt-6-astra", "ultra"), "xhigh");
  assert.equal(reasoningEffortForRequest("gpt-6.1-sol", "ultra"), "xhigh");
  assert.equal(reasoningEffortForRequest("gpt-5.6-sol", "ultra"), "max");
  assert.equal(reasoningEffortForRequest("gpt-5.6-luna", "ultra"), "max");
  assert.equal(reasoningEffortForRequest("gpt-6-sol", "ultra"), "max");
  assert.equal(reasoningEffortForRequest("gpt-6-luna", "ultra"), "max");
  // gpt-5.5 tops out at xhigh, so codex sends its highest supported level.
  assert.equal(reasoningEffortForRequest("gpt-5.5", "ultra"), "xhigh");
  assert.equal(reasoningEffortForRequest("unknown-model", "ultra"), "max");
});

test("persistent is spelled disabled on the wire and other levels pass through", () => {
  assert.equal(reasoningEffortForRequest("gpt-6-astra", "persistent"), "disabled");
  assert.equal(reasoningEffortForRequest("gpt-6-astra", "high"), "high");
  assert.equal(reasoningEffortForRequest(undefined, "xhigh"), "xhigh");
});

test("service tiers come from the catalog", () => {
  assert.deepEqual(supportedServiceTiers("gpt-6.2-sol"), ["priority", "ultrafast"]);
  // ultrafast was withdrawn from gpt-5.6-sol upstream.
  assert.deepEqual(supportedServiceTiers("gpt-5.6-sol"), ["priority"]);
  assert.deepEqual(supportedServiceTiers("gpt-6-sol"), ["priority"]);
  assert.deepEqual(supportedServiceTiers("gpt-6.1-sol"), ["priority"]);
  assert.deepEqual(supportedServiceTiers("gpt-daybreak-blue-latest"), []);
  assert.equal(supportedServiceTiers("unknown-model"), undefined);
});

test("gpt-6-sol and gpt-6-luna default to the Fast tier", () => {
  assert.equal(defaultServiceTier("gpt-6-sol"), "priority");
  assert.equal(defaultServiceTier("gpt-6-luna"), "priority");
  assert.equal(defaultServiceTier("gpt-6-astra"), undefined);
  assert.equal(defaultServiceTier("gpt-6.1-sol"), undefined);
  assert.equal(defaultServiceTier("gpt-5.5"), undefined);
  assert.equal(defaultServiceTier("unknown-model"), undefined);
});
