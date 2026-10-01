import { isUsageLimitErrorType } from "./rate-limits.js";
import type { JsonObject } from "./types.js";
import { isRecord, stringValue } from "./utils.js";

export interface ResponseStreamError {
  code: string;
  errorType?: string;
  message: string;
  status: number;
  retryAfterSeconds?: number;
  // False when the failure says nothing about the account (Flex capacity,
  // incomplete responses), so the credential must not be cooled down for it.
  credentialFailure: boolean;
}

export const FLEX_UNAVAILABLE_CODE = "flex_unavailable";
const FLEX_UNAVAILABLE_MESSAGE = "Flex capacity unavailable.";
// Codex ends a turn on a response.incomplete with this reason as if it had
// completed (the upstream preempted it); every other reason is an error.
const INTERRUPTED_INCOMPLETE_REASON = "interrupted";

// Error codes Codex maps in codex-api/src/sse/responses.rs and api_bridge.rs.
const INVALID_REQUEST_ERROR_CODES = new Set([
  "context_length_exceeded",
  "invalid_prompt",
  "bio_policy",
  "cyber_policy",
  "misalignment_policy_violation",
]);
// Quota exhaustion codex maps to QuotaExceeded (api_bridge.rs, sse/responses.rs).
const QUOTA_EXCEEDED_ERROR_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);
// slow_down is a retryable rate limit, not an overload (openai/codex#45602).
const RATE_LIMIT_ERROR_CODES = new Set(["rate_limit_exceeded", "slow_down"]);
const SERVER_OVERLOADED_ERROR_CODES = new Set(["server_is_overloaded", "server_overloaded"]);
const RATE_LIMIT_RETRY_AFTER_PATTERN = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i;
// Response headers Codex reads off the /responses reply; surfaced on aggregated
// (non-stream) replies since stream replies already carry the upstream headers.
const RESPONSE_METADATA_HEADERS = [
  "x-codex-turn-state",
  "openai-model",
  "x-reasoning-included",
  "x-models-etag",
  "x-request-id",
  "x-codex-promo-message",
  "x-codex-active-limit",
  "x-codex-rate-limit-reached-type",
];

// Codex treats flex_unavailable as a terminal error on HTTP 429 replies, stream
// `error` events and response.failed (openai/codex#47967).
export function isFlexUnavailableError(error: unknown): boolean {
  return isRecord(error) && error.code === FLEX_UNAVAILABLE_CODE;
}

export function incompleteResponseReason(event: JsonObject): string | undefined {
  if (event.type !== "response.incomplete") {
    return undefined;
  }
  const response = isRecord(event.response) ? event.response : undefined;
  const details = isRecord(response?.incomplete_details) ? response.incomplete_details : undefined;
  return stringValue(details?.reason) ?? "unknown";
}

// response.completed, or a response.incomplete the upstream interrupted.
export function isResponseCompletionEvent(event: JsonObject): boolean {
  return event.type === "response.completed" || incompleteResponseReason(event) === INTERRUPTED_INCOMPLETE_REASON;
}

export function responseStreamError(event: JsonObject): ResponseStreamError | undefined {
  if (event.type === "error") {
    return isFlexUnavailableError(event.error) ? flexUnavailableError(event.error) : undefined;
  }
  if (event.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    if (isFlexUnavailableError(response?.error)) {
      return flexUnavailableError(response?.error);
    }
    const error = isRecord(response?.error) ? response.error : undefined;
    const code = stringValue(error?.code) ?? "response_failed";
    const errorType = stringValue(error?.type);
    const message = stringValue(error?.message) ?? "response.failed event received";
    const status = responseErrorStatus(code, errorType);
    return {
      code,
      errorType,
      message,
      status,
      retryAfterSeconds: RATE_LIMIT_ERROR_CODES.has(code) ? parseRetryAfterFromMessage(message) : undefined,
      // Invalid-request failures (context_length_exceeded, invalid_prompt, the
      // policy codes) are about the prompt, not the account
      // (codex-api/src/sse/responses_error.rs), so they leave the credential be.
      credentialFailure: status !== 400,
    };
  }
  const reason = incompleteResponseReason(event);
  if (reason !== undefined && reason !== INTERRUPTED_INCOMPLETE_REASON) {
    return {
      code: "response_incomplete",
      message: `Incomplete response returned, reason: ${reason}`,
      status: 502,
      credentialFailure: false,
    };
  }
  return undefined;
}

function flexUnavailableError(error: unknown): ResponseStreamError {
  const message = isRecord(error) ? stringValue(error.message) : undefined;
  return {
    code: FLEX_UNAVAILABLE_CODE,
    message: message ?? FLEX_UNAVAILABLE_MESSAGE,
    status: 429,
    credentialFailure: false,
  };
}

export function responseErrorStatus(code: string, errorType: string | undefined): number {
  if (
    isUsageLimitErrorType(errorType) ||
    isUsageLimitErrorType(code) ||
    errorType === "insufficient_quota" ||
    QUOTA_EXCEEDED_ERROR_CODES.has(code) ||
    RATE_LIMIT_ERROR_CODES.has(code)
  ) {
    return 429;
  }
  if (INVALID_REQUEST_ERROR_CODES.has(code)) {
    return 400;
  }
  if (SERVER_OVERLOADED_ERROR_CODES.has(code)) {
    return 503;
  }
  return 502;
}

// codex-api parses "try again in 1.5s" / "try again in 250ms" out of
// rate_limit_exceeded and slow_down messages to schedule the retry.
export function parseRetryAfterFromMessage(message: string): number | undefined {
  const match = RATE_LIMIT_RETRY_AFTER_PATTERN.exec(message);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const unit = match[2].toLowerCase();
  return unit === "ms" ? value / 1000 : value;
}

export function responseMetadataHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_METADATA_HEADERS) {
    const value = response.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}
