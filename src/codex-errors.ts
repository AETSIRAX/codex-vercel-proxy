import { isUsageLimitErrorType } from "./rate-limits.js";
import type { JsonObject } from "./types.js";
import { isRecord, stringValue } from "./utils.js";

export interface ResponseStreamError {
  code: string;
  errorType?: string;
  message: string;
  status: number;
  retryAfterSeconds?: number;
}

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

export function responseStreamError(event: JsonObject): ResponseStreamError | undefined {
  if (event.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    const error = isRecord(response?.error) ? response.error : undefined;
    const code = stringValue(error?.code) ?? "response_failed";
    const errorType = stringValue(error?.type);
    const message = stringValue(error?.message) ?? "response.failed event received";
    return {
      code,
      errorType,
      message,
      status: responseErrorStatus(code, errorType),
      retryAfterSeconds: RATE_LIMIT_ERROR_CODES.has(code) ? parseRetryAfterFromMessage(message) : undefined,
    };
  }
  if (event.type === "response.incomplete") {
    const response = isRecord(event.response) ? event.response : undefined;
    const details = isRecord(response?.incomplete_details) ? response.incomplete_details : undefined;
    const reason = stringValue(details?.reason) ?? "unknown";
    return {
      code: "response_incomplete",
      message: `Incomplete response returned, reason: ${reason}`,
      status: 502,
    };
  }
  return undefined;
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
