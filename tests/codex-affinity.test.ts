import assert from "node:assert/strict";
import test from "node:test";

import { rankCredentialIdsByAffinity, resolveCodexCredentialAffinityKey } from "../src/codex-affinity.js";

test("session-id takes precedence for credential affinity", () => {
  const request = new Request("https://proxy.test/v1/responses", {
    headers: {
      "session-id": "session-cache",
      "thread-id": "thread-cache",
    },
  });

  assert.equal(resolveCodexCredentialAffinityKey(request), "session-cache");
});

test("thread-id is used when session-id is absent", () => {
  const request = new Request("https://proxy.test/v1/responses", {
    headers: { "thread-id": "thread-cache" },
  });

  assert.equal(resolveCodexCredentialAffinityKey(request), "thread-cache");
});

test("credential affinity ignores window and turn metadata", () => {
  const request = new Request("https://proxy.test/v1/responses", {
    headers: {
      "x-codex-window-id": "window-cache:0",
      "x-codex-turn-metadata": JSON.stringify({ prompt_cache_key: "turn-cache", window_id: "turn-cache:2" }),
    },
  });

  assert.equal(resolveCodexCredentialAffinityKey(request), undefined);
});

test("credential affinity ranking is stable and supports fallback to the next ranked credential", async () => {
  const ids = ["cred-a", "cred-b", "cred-c", "cred-d"];
  const first = await rankCredentialIdsByAffinity("session-a", ids);
  const second = await rankCredentialIdsByAffinity("session-a", [...ids].reverse());

  assert.deepEqual(first, second);
  assert.deepEqual(
    await rankCredentialIdsByAffinity(
      "session-a",
      ids.filter((id) => id !== first[0]),
    ),
    first.slice(1),
  );
});

test("credential affinity ranking distributes different sessions", async () => {
  const ids = ["cred-a", "cred-b", "cred-c", "cred-d"];
  const selected = new Set<string>();
  for (let index = 0; index < 32; index += 1) {
    const ranked = await rankCredentialIdsByAffinity(`session-${index}`, ids);
    selected.add(ranked[0] ?? "");
  }

  assert.ok(selected.size > 1);
});

test("empty affinity key keeps the existing candidate order", async () => {
  const ids = ["cred-a", "cred-b", "cred-c"];

  assert.deepEqual(await rankCredentialIdsByAffinity("", ids), ids);
});
