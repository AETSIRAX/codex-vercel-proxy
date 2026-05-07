import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCodexIdentityConfuseHeaders,
  applyCodexIdentityConfusePayload,
  applyCodexIdentityExposeText,
} from "../src/codex-identity.js";
import type { JsonObject, SelectedCredential } from "../src/types.js";

const settings = { identityConfuse: true };
const credential: SelectedCredential = {
  id: "cred-a",
  label: "Credential A",
  token: "token-a",
};

test("identity confuse remaps payload and headers", async () => {
  const sourceTurnMetadata = JSON.stringify({
    prompt_cache_key: "client-cache",
    turn_id: "turn-a",
    window_id: "client-cache:0",
  });
  const sourcePayload: JsonObject = {
    model: "gpt-5.5",
    prompt_cache_key: "client-cache",
    client_metadata: {
      "x-codex-installation-id": "install-a",
      "x-codex-turn-metadata": sourceTurnMetadata,
      "x-codex-window-id": "client-cache:0",
    },
  };
  const upstreamPayload = structuredClone(sourcePayload) as JsonObject;
  const state = await applyCodexIdentityConfusePayload(settings, credential, sourcePayload, upstreamPayload);

  assert.equal(state.enabled, true);
  assert.notEqual(upstreamPayload.prompt_cache_key, "client-cache");
  assert.equal(upstreamPayload.prompt_cache_key, state.promptCacheKey);

  const metadata = upstreamPayload.client_metadata as JsonObject;
  assert.notEqual(metadata["x-codex-installation-id"], "install-a");
  assert.equal(metadata["x-codex-window-id"], "client-cache:0");
  assert.equal(metadata["x-codex-turn-metadata"], sourceTurnMetadata);

  const headers = new Headers({
    "session-id": "session-a",
    "thread-id": "thread-a",
    "x-client-request-id": "request-a",
    "x-codex-turn-metadata": sourceTurnMetadata,
    "x-codex-window-id": "client-cache:0",
  });
  await applyCodexIdentityConfuseHeaders(headers, state);

  assert.notEqual(headers.get("session-id"), "session-a");
  assert.notEqual(headers.get("thread-id"), "thread-a");
  assert.notEqual(headers.get("session-id"), headers.get("thread-id"));
  assert.equal(headers.get("x-client-request-id"), "request-a");
  assert.equal(headers.get("x-codex-turn-metadata"), sourceTurnMetadata);
  assert.equal(headers.get("x-codex-window-id"), "client-cache:0");
});

test("identity confuse exposes upstream response identifiers to the client", async () => {
  const sourcePayload: JsonObject = { model: "gpt-5.5", prompt_cache_key: "client-cache" };
  const upstreamPayload = structuredClone(sourcePayload) as JsonObject;
  const state = await applyCodexIdentityConfusePayload(settings, credential, sourcePayload, upstreamPayload);
  const headers = new Headers({
    "session-id": "session-a",
    "thread-id": "thread-a",
    "x-client-request-id": "thread-a",
  });
  await applyCodexIdentityConfuseHeaders(headers, state);
  const confusedSessionId = headers.get("session-id");
  const confusedThreadId = headers.get("thread-id");
  const upstreamText = JSON.stringify({
    prompt_cache_key: state.promptCacheKey,
    session_id: confusedSessionId,
    thread_id: confusedThreadId,
  });

  const exposed = applyCodexIdentityExposeText(upstreamText, state);

  assert.match(exposed, /client-cache/);
  assert.match(exposed, /session-a/);
  assert.match(exposed, /thread-a/);
  assert.doesNotMatch(exposed, new RegExp(state.promptCacheKey ?? "missing"));
  assert.doesNotMatch(exposed, new RegExp(confusedSessionId ?? "missing"));
  assert.doesNotMatch(exposed, new RegExp(confusedThreadId ?? "missing"));
});

test("identity confuse remaps default client request id when it mirrors thread id", async () => {
  const sourcePayload: JsonObject = { model: "gpt-5.5", prompt_cache_key: "client-cache" };
  const upstreamPayload = structuredClone(sourcePayload) as JsonObject;
  const state = await applyCodexIdentityConfusePayload(settings, credential, sourcePayload, upstreamPayload);
  const headers = new Headers({
    "session-id": "session-a",
    "thread-id": "thread-a",
    "x-client-request-id": "thread-a",
  });

  await applyCodexIdentityConfuseHeaders(headers, state);

  assert.equal(headers.get("x-client-request-id"), headers.get("thread-id"));
  assert.notEqual(headers.get("x-client-request-id"), "thread-a");
});

test("identity confuse keeps credential mappings separate", async () => {
  const sourcePayload: JsonObject = { model: "gpt-5.5", prompt_cache_key: "client-cache" };
  const firstPayload = structuredClone(sourcePayload) as JsonObject;
  const secondPayload = structuredClone(sourcePayload) as JsonObject;

  const first = await applyCodexIdentityConfusePayload(settings, credential, sourcePayload, firstPayload);
  const second = await applyCodexIdentityConfusePayload(
    settings,
    { ...credential, id: "cred-b" },
    sourcePayload,
    secondPayload,
  );

  assert.notEqual(first.promptCacheKey, second.promptCacheKey);
});
