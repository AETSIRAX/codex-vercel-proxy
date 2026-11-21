import { isUsageLimitErrorType } from "./rate-limits.js";
import type { JsonObject } from "./types.js";
import { errorResponse, isRecord, stringValue } from "./utils.js";

export interface ResponseStreamError {
  code: string;
  errorType?: string;
  message: string;
  status: number;
  retryAfterSeconds?: number;
  credentialFailure: boolean;
}

const FLEX_UNAVAILABLE_CODE = "flex_unavailable";
const FLEX_UNAVAILABLE_MESSAGE = "Flex capacity unavailable.";
// Codex ends a turn on a response.incomplete with this reason as if it had
// completed (the upstream preempted it); every other reason is an error.
const INTERRUPTED_INCOMPLETE_REASON = "interrupted";

// Request rejections and capacity errors apply to the request itself. Use the
// same classification for HTTP replies and errors inside a Responses stream.
const NON_CREDENTIAL_ERROR_STATUSES = new Map([
  ["access_program_not_enabled", 403],
  ["audio_too_large", 400],
  ["audio_too_short", 400],
  ["bio_policy", 400],
  ["budget_reached", 400],
  ["content_policy_violation", 400],
  ["context_length_exceeded", 400],
  ["cyber_policy", 400],
  [FLEX_UNAVAILABLE_CODE, 429],
  ["inference_hook_denied", 403],
  ["invalid_access_program", 400],
  ["invalid_audio", 400],
  ["invalid_audio_data", 400],
  ["invalid_audio_format", 400],
  ["invalid_prompt", 400],
  ["misalignment_policy_violation", 400],
  ["missing_audio_sample_rate", 400],
  ["model_not_found", 404],
  ["policy_capacity_unavailable", 503],
  ["server_is_overloaded", 503],
  ["server_overloaded", 503],
  ["unsupported_access_program", 400],
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

export function isNonCredentialErrorCode(code: string | undefined): boolean {
  return code !== undefined && NON_CREDENTIAL_ERROR_STATUSES.has(code);
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

export function responseStreamError(event: JsonObject, headers?: Headers): ResponseStreamError | undefined {
  if (event.type === "error") {
    const error = parseStreamFailure(isRecord(event.error) ? event.error : event, headers);
    // Unrecognized generic events can still be followed by a terminal event.
    return error.status !== 502 ? error : undefined;
  }
  if (event.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    return parseStreamFailure(isRecord(response?.error) ? response.error : undefined, headers);
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

function parseStreamFailure(error: Record<string, unknown> | undefined, headers?: Headers): ResponseStreamError {
  const code = stringValue(error?.code) ?? "response_failed";
  const errorType = stringValue(error?.type);
  const fallbackMessage = code === FLEX_UNAVAILABLE_CODE ? FLEX_UNAVAILABLE_MESSAGE : code;
  const fallback = code === "response_failed" ? "response.failed event received" : fallbackMessage;
  const message = stringValue(error?.message) ?? fallback;
  return {
    code,
    errorType,
    message,
    status: responseErrorStatus(code, errorType),
    retryAfterSeconds:
      retryAfterFromEventHeaders(error?.headers) ??
      parseRetryAfterSeconds(headers?.get("retry-after")) ??
      (RATE_LIMIT_ERROR_CODES.has(code) ? parseRetryAfterFromMessage(message) : undefined),
    credentialFailure: !isNonCredentialErrorCode(code),
  };
}

export function responseErrorStatus(code: string, errorType: string | undefined): number {
  const status = NON_CREDENTIAL_ERROR_STATUSES.get(code);
  if (status !== undefined) {
    return status;
  }
  if (
    isUsageLimitErrorType(errorType) ||
    isUsageLimitErrorType(code) ||
    errorType === "insufficient_quota" ||
    QUOTA_EXCEEDED_ERROR_CODES.has(code) ||
    RATE_LIMIT_ERROR_CODES.has(code)
  ) {
    return 429;
  }
  return 502;
}

export function streamErrorResponse(error: ResponseStreamError): Response {
  const response = errorResponse(error.status, error.message, error.code);
  if (error.retryAfterSeconds !== undefined) {
    // Retry-After delay seconds must be an integer.
    response.headers.set("Retry-After", String(Math.ceil(error.retryAfterSeconds)));
  }
  return response;
}

function retryAfterFromEventHeaders(headers: unknown): number | undefined {
  if (!isRecord(headers)) {
    return undefined;
  }
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  return parseRetryAfterSeconds(typeof value === "number" ? String(value) : stringValue(value));
}

export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  const header = value?.trim();
  if (!header) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(header)) {
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
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
