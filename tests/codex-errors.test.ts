import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRetryAfterFromMessage,
  responseErrorStatus,
  responseMetadataHeaders,
  responseStreamError,
} from "../src/codex-errors.js";

test("response.failed codes map to the statuses codex uses", () => {
  assert.equal(responseErrorStatus("usage_limit_reached", undefined), 429);
  assert.equal(responseErrorStatus("insufficient_quota", undefined), 429);
  assert.equal(responseErrorStatus("rate_limit_exceeded", undefined), 429);
  assert.equal(responseErrorStatus("other", "usage_not_included"), 429);
  assert.equal(responseErrorStatus("context_length_exceeded", undefined), 400);
  assert.equal(responseErrorStatus("invalid_prompt", undefined), 400);
  assert.equal(responseErrorStatus("bio_policy", undefined), 400);
  assert.equal(responseErrorStatus("cyber_policy", undefined), 400);
  assert.equal(responseErrorStatus("misalignment_policy_violation", undefined), 400);
  assert.equal(responseErrorStatus("server_is_overloaded", undefined), 503);
  assert.equal(responseErrorStatus("slow_down", undefined), 503);
  assert.equal(responseErrorStatus("server_overloaded", undefined), 503);
  assert.equal(responseErrorStatus("something_else", undefined), 502);
});

test("retry-after is parsed out of rate_limit_exceeded messages", () => {
  assert.equal(parseRetryAfterFromMessage("Rate limit reached. Please try again in 1.5s."), 1.5);
  assert.equal(parseRetryAfterFromMessage("try again in 250ms"), 0.25);
  assert.equal(parseRetryAfterFromMessage("Try again in 20 seconds"), 20);
  assert.equal(parseRetryAfterFromMessage("no hint here"), undefined);
});

test("response.failed stream errors carry the parsed retry delay", () => {
  const error = responseStreamError({
    type: "response.failed",
    response: {
      error: { code: "rate_limit_exceeded", message: "Please try again in 3s." },
    },
  });
  assert.equal(error?.status, 429);
  assert.equal(error?.retryAfterSeconds, 3);

  const overloaded = responseStreamError({
    type: "response.failed",
    response: { error: { code: "server_is_overloaded", message: "busy" } },
  });
  assert.equal(overloaded?.status, 503);
  assert.equal(overloaded?.retryAfterSeconds, undefined);
});

test("aggregated replies surface the response headers codex reads", () => {
  const upstream = new Response(null, {
    headers: {
      "x-codex-turn-state": "state-1",
      "openai-model": "gpt-6-astra",
      "x-reasoning-included": "true",
      "x-request-id": "req-1",
      "content-length": "12",
    },
  });
  const headers = responseMetadataHeaders(upstream);
  assert.equal(headers.get("x-codex-turn-state"), "state-1");
  assert.equal(headers.get("openai-model"), "gpt-6-astra");
  assert.equal(headers.get("x-reasoning-included"), "true");
  assert.equal(headers.get("x-request-id"), "req-1");
  assert.equal(headers.has("content-length"), false);
});
