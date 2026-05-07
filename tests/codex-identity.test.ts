import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCodexIdentityConfuseHeaders,
  applyCodexIdentityConfusePayload,
  applyCodexIdentityExposeHeaders,
  applyCodexIdentityExposeJson,
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
    installation_id: "install-a",
    session_id: "session-a",
    thread_id: "thread-a",
    turn_id: "turn-a",
    window_id: "thread-a:1",
    forked_from_thread_id: "thread-parent",
    parent_thread_id: "thread-parent",
  });
  const sourcePayload: JsonObject = {
    model: "gpt-5.5",
    prompt_cache_key: "client-cache",
    client_metadata: {
      "x-codex-installation-id": "install-a",
      session_id: "session-a",
      thread_id: "thread-a",
      turn_id: "turn-a",
      "x-codex-turn-metadata": sourceTurnMetadata,
      "x-codex-window-id": "thread-a:1",
      "x-codex-parent-thread-id": "thread-parent",
    },
  };
  const upstreamPayload = structuredClone(sourcePayload) as JsonObject;
  const state = await applyCodexIdentityConfusePayload(settings, credential, sourcePayload, upstreamPayload);

  assert.equal(state.enabled, true);
  assert.notEqual(upstreamPayload.prompt_cache_key, "client-cache");
  assert.equal(upstreamPayload.prompt_cache_key, state.promptCacheKey);

  const metadata = upstreamPayload.client_metadata as JsonObject;
  assert.notEqual(metadata["x-codex-installation-id"], "install-a");
  assert.notEqual(metadata.session_id, "session-a");
  assert.notEqual(metadata.thread_id, "thread-a");
  assert.notEqual(metadata.turn_id, "turn-a");
  assert.notEqual(metadata["x-codex-window-id"], "thread-a:1");
  assert.notEqual(metadata["x-codex-parent-thread-id"], "thread-parent");
  const confusedTurnMetadata = JSON.parse(String(metadata["x-codex-turn-metadata"])) as JsonObject;
  assert.equal(confusedTurnMetadata.prompt_cache_key, state.promptCacheKey);
  assert.equal(confusedTurnMetadata.installation_id, metadata["x-codex-installation-id"]);
  assert.equal(confusedTurnMetadata.session_id, metadata.session_id);
  assert.equal(confusedTurnMetadata.thread_id, metadata.thread_id);
  assert.equal(confusedTurnMetadata.turn_id, metadata.turn_id);
  assert.equal(confusedTurnMetadata.window_id, metadata["x-codex-window-id"]);
  assert.equal(confusedTurnMetadata.parent_thread_id, metadata["x-codex-parent-thread-id"]);
  assert.equal(confusedTurnMetadata.forked_from_thread_id, metadata["x-codex-parent-thread-id"]);
  assert.match(String(metadata["x-codex-window-id"]), /:1$/);

  const headers = new Headers({
    "session-id": "session-a",
    "thread-id": "thread-a",
    "x-client-request-id": "request-a",
    "x-codex-turn-metadata": sourceTurnMetadata,
    "x-codex-window-id": "thread-a:1",
    "x-codex-parent-thread-id": "thread-parent",
  });
  await applyCodexIdentityConfuseHeaders(headers, state);

  assert.notEqual(headers.get("session-id"), "session-a");
  assert.notEqual(headers.get("thread-id"), "thread-a");
  assert.notEqual(headers.get("session-id"), headers.get("thread-id"));
  assert.notEqual(headers.get("x-client-request-id"), "request-a");
  assert.equal(headers.get("session-id"), metadata.session_id);
  assert.equal(headers.get("thread-id"), metadata.thread_id);
  assert.equal(headers.get("x-codex-window-id"), metadata["x-codex-window-id"]);
  assert.equal(headers.get("x-codex-parent-thread-id"), metadata["x-codex-parent-thread-id"]);
  assert.equal(headers.get("x-codex-turn-metadata"), metadata["x-codex-turn-metadata"]);
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

test("identity confuse does not replace identifiers inside assistant content", async () => {
  const sourcePayload: JsonObject = { model: "gpt-5.5", prompt_cache_key: "client-cache" };
  const upstreamPayload = structuredClone(sourcePayload) as JsonObject;
  const state = await applyCodexIdentityConfusePayload(settings, credential, sourcePayload, upstreamPayload);
  const headers = new Headers({ "session-id": "session-a", "thread-id": "thread-a" });
  await applyCodexIdentityConfuseHeaders(headers, state);
  const confusedThreadId = headers.get("thread-id") ?? "";
  const upstreamText = JSON.stringify({
    type: "response.output_text.delta",
    delta: `literal ${confusedThreadId}`,
  });

  const exposed = applyCodexIdentityExposeText(upstreamText, state);

  assert.equal(exposed, upstreamText);
});

test("identity confuse rejects malformed turn metadata", async () => {
  const sourcePayload: JsonObject = {
    model: "gpt-5.5",
    prompt_cache_key: "client-cache",
    client_metadata: { "x-codex-turn-metadata": "not-json" },
  };
  await assert.rejects(
    applyCodexIdentityConfusePayload(settings, credential, sourcePayload, structuredClone(sourcePayload) as JsonObject),
    /x-codex-turn-metadata must be valid JSON/,
  );
});

test("identity confuse rejects malformed turn metadata headers", async () => {
  const sourcePayload: JsonObject = { model: "gpt-5.5", prompt_cache_key: "client-cache" };
  const state = await applyCodexIdentityConfusePayload(
    settings,
    credential,
    sourcePayload,
    structuredClone(sourcePayload) as JsonObject,
  );
  const headers = new Headers({
    "session-id": "session-a",
    "thread-id": "thread-a",
    "x-codex-turn-metadata": "[]",
  });

  await assert.rejects(applyCodexIdentityConfuseHeaders(headers, state), /must be a JSON object/);
});

test("identity confuse keeps turn metadata headers ASCII-safe", async () => {
  const turnMetadata =
    '{"session_id":"session-a","thread_id":"thread-a","workspaces":{"/tmp/\\u4e2d\\u6587\\u9879\\u76ee":{"has_changes":true}}}';
  const sourcePayload: JsonObject = { model: "gpt-5.5", prompt_cache_key: "client-cache" };
  const state = await applyCodexIdentityConfusePayload(
    settings,
    credential,
    sourcePayload,
    structuredClone(sourcePayload) as JsonObject,
  );
  const headers = new Headers({ "x-codex-turn-metadata": turnMetadata });

  await applyCodexIdentityConfuseHeaders(headers, state);

  const confused = headers.get("x-codex-turn-metadata") ?? "";
  const parsed = JSON.parse(confused) as { workspaces: Record<string, { has_changes: boolean }> };
  assert.doesNotMatch(confused, /[^\x20-\x7e]/);
  assert.equal(parsed.workspaces["/tmp/中文项目"]?.has_changes, true);
});

test("identity expose restores structured metadata without changing ordinary strings", async () => {
  const turnMetadata = JSON.stringify({
    session_id: "session-a",
    thread_id: "thread-a",
    turn_id: "turn-a",
    window_id: "thread-a:2",
  });
  const sourcePayload: JsonObject = {
    model: "gpt-5.5",
    prompt_cache_key: "client-cache",
    client_metadata: {
      session_id: "session-a",
      thread_id: "thread-a",
      turn_id: "turn-a",
      "x-codex-window-id": "thread-a:2",
      "x-codex-turn-metadata": turnMetadata,
    },
  };
  const upstreamPayload = structuredClone(sourcePayload) as JsonObject;
  const state = await applyCodexIdentityConfusePayload(settings, credential, sourcePayload, upstreamPayload);
  const confusedMetadata = upstreamPayload.client_metadata as JsonObject;
  const confusedThreadId = String(confusedMetadata.thread_id);
  const exposed = applyCodexIdentityExposeJson(
    {
      session_id: confusedMetadata.session_id,
      thread_id: confusedMetadata.thread_id,
      turn_id: confusedMetadata.turn_id,
      window_id: confusedMetadata["x-codex-window-id"],
      "x-codex-turn-metadata": confusedMetadata["x-codex-turn-metadata"],
      delta: `literal ${confusedThreadId}`,
    },
    state,
  );

  assert.equal(exposed.session_id, "session-a");
  assert.equal(exposed.thread_id, "thread-a");
  assert.equal(exposed.turn_id, "turn-a");
  assert.equal(exposed.window_id, "thread-a:2");
  assert.equal(exposed["x-codex-turn-metadata"], turnMetadata);
  assert.equal(exposed.delta, `literal ${confusedThreadId}`);
});

test("identity expose restores response headers", async () => {
  const sourcePayload: JsonObject = { model: "gpt-5.5", prompt_cache_key: "client-cache" };
  const state = await applyCodexIdentityConfusePayload(
    settings,
    credential,
    sourcePayload,
    structuredClone(sourcePayload) as JsonObject,
  );
  const headers = new Headers({
    "session-id": "session-a",
    "thread-id": "thread-a",
    "x-codex-window-id": "thread-a:3",
  });
  await applyCodexIdentityConfuseHeaders(headers, state);

  applyCodexIdentityExposeHeaders(headers, state);

  assert.equal(headers.get("session-id"), "session-a");
  assert.equal(headers.get("thread-id"), "thread-a");
  assert.equal(headers.get("x-codex-window-id"), "thread-a:3");
});

test("identity confuse disabled leaves payload and headers unchanged", async () => {
  const sourcePayload: JsonObject = {
    model: "gpt-5.5",
    prompt_cache_key: "client-cache",
    client_metadata: { session_id: "session-a" },
  };
  const upstreamPayload = structuredClone(sourcePayload) as JsonObject;
  const state = await applyCodexIdentityConfusePayload(
    { identityConfuse: false },
    credential,
    sourcePayload,
    upstreamPayload,
  );
  const headers = new Headers({ "session-id": "session-a" });

  await applyCodexIdentityConfuseHeaders(headers, state);

  assert.deepEqual(upstreamPayload, sourcePayload);
  assert.equal(headers.get("session-id"), "session-a");
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
