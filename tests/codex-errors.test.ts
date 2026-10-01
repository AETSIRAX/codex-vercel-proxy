import assert from "node:assert/strict";
import test from "node:test";

import {
  isResponseCompletionEvent,
  parseRetryAfterFromMessage,
  responseErrorStatus,
  responseMetadataHeaders,
  responseStreamError,
} from "../src/codex-errors.js";

test("response.failed codes map to the statuses codex uses", () => {
  assert.equal(responseErrorStatus("usage_limit_reached", undefined), 429);
  assert.equal(responseErrorStatus("insufficient_quota", undefined), 429);
  assert.equal(responseErrorStatus("other", "insufficient_quota"), 429);
  assert.equal(responseErrorStatus("credit_balance_exhausted", undefined), 429);
  assert.equal(responseErrorStatus("organization_spend_limit_exceeded", undefined), 429);
  assert.equal(responseErrorStatus("project_spend_limit_exceeded", undefined), 429);
  assert.equal(responseErrorStatus("organization_usage_limit_exceeded", undefined), 429);
  assert.equal(responseErrorStatus("rate_limit_exceeded", undefined), 429);
  assert.equal(responseErrorStatus("slow_down", undefined), 429);
  assert.equal(responseErrorStatus("other", "usage_not_included"), 429);
  assert.equal(responseErrorStatus("context_length_exceeded", undefined), 400);
  assert.equal(responseErrorStatus("invalid_prompt", undefined), 400);
  assert.equal(responseErrorStatus("bio_policy", undefined), 400);
  assert.equal(responseErrorStatus("cyber_policy", undefined), 400);
  assert.equal(responseErrorStatus("misalignment_policy_violation", undefined), 400);
  assert.equal(responseErrorStatus("server_is_overloaded", undefined), 503);
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

  const slowDown = responseStreamError({
    type: "response.failed",
    response: { error: { code: "slow_down", message: "Slow down. Try again in 2s." } },
  });
  assert.equal(slowDown?.status, 429);
  assert.equal(slowDown?.retryAfterSeconds, 2);

  const overloaded = responseStreamError({
    type: "response.failed",
    response: { error: { code: "server_is_overloaded", message: "busy" } },
  });
  assert.equal(overloaded?.status, 503);
  assert.equal(overloaded?.retryAfterSeconds, undefined);
});

test("flex_unavailable is a terminal 429 that does not count against the credential", () => {
  const fromErrorEvent = responseStreamError({
    type: "error",
    error: { code: "flex_unavailable", message: "Flex capacity is unavailable right now." },
  });
  assert.equal(fromErrorEvent?.status, 429);
  assert.equal(fromErrorEvent?.code, "flex_unavailable");
  assert.equal(fromErrorEvent?.message, "Flex capacity is unavailable right now.");
  assert.equal(fromErrorEvent?.credentialFailure, false);

  const fromFailed = responseStreamError({
    type: "response.failed",
    response: { error: { code: "flex_unavailable" } },
  });
  assert.equal(fromFailed?.status, 429);
  assert.equal(fromFailed?.message, "Flex capacity unavailable.");
  assert.equal(fromFailed?.credentialFailure, false);

  // Other stream error events are left to the stream consumers, like codex.
  assert.equal(responseStreamError({ type: "error", error: { code: "other" } }), undefined);
});

test("invalid-request response.failed codes do not count against the credential", () => {
  for (const code of ["context_length_exceeded", "invalid_prompt", "cyber_policy"]) {
    const error = responseStreamError({ type: "response.failed", response: { error: { code, message: "bad" } } });
    assert.equal(error?.status, 400);
    assert.equal(error?.credentialFailure, false);
  }
  for (const code of ["usage_limit_reached", "rate_limit_exceeded", "something_else"]) {
    const error = responseStreamError({ type: "response.failed", response: { error: { code } } });
    assert.equal(error?.credentialFailure, true);
  }
});

test("interrupted incomplete responses complete the turn; other reasons are errors", () => {
  const interrupted = {
    type: "response.incomplete",
    response: { status: "incomplete", incomplete_details: { reason: "interrupted" } },
  };
  const truncated = {
    type: "response.incomplete",
    response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
  };

  assert.equal(responseStreamError(interrupted), undefined);
  assert.equal(isResponseCompletionEvent(interrupted), true);
  assert.equal(isResponseCompletionEvent({ type: "response.completed", response: {} }), true);
  assert.equal(isResponseCompletionEvent(truncated), false);

  const error = responseStreamError(truncated);
  assert.equal(error?.status, 502);
  assert.equal(error?.message, "Incomplete response returned, reason: max_output_tokens");
  // An incomplete response is not an account problem, so no cooldown.
  assert.equal(error?.credentialFailure, false);
  assert.equal(
    responseStreamError({ type: "response.failed", response: { error: { code: "server_is_overloaded" } } })
      ?.credentialFailure,
    true,
  );
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
