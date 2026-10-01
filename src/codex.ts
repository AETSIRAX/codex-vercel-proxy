import {
  credentialManager,
  scheduleCredentialRateLimitUpdate,
  scheduleCredentialSuccessUpdate,
  type CredentialManager,
} from "./credential-manager.js";
import { resolveCodexCredentialAffinityKey } from "./codex-affinity.js";
import {
  buildCodexEndpointUrl,
  buildCodexRequestHeaders,
  buildCodexRoutingHint,
  isGuardianReviewerRequest,
  type CodexJsonEndpointPath,
} from "./codex-endpoint.js";
import { codexBaseURL, upstreamRequestCompression } from "./env.js";
import type { AppEnv } from "./env.js";
import {
  FLEX_UNAVAILABLE_CODE,
  isResponseCompletionEvent,
  responseMetadataHeaders,
  responseStreamError,
  type ResponseStreamError,
} from "./codex-errors.js";
import { isResponsesLiteModel, prepareCodexPayload } from "./codex-payload.js";
import { isUsageLimitErrorType, parseRateLimitHeaders } from "./rate-limits.js";
import { settingsStore } from "./settings.js";
import { readSseData, readSseDataFromReader, encodeSseData, parseSseJson } from "./sse.js";
import type { JsonObject, JsonValue, SelectedCredential } from "./types.js";
import { createUsageContext, scheduleUsageRecord, type UsageContext } from "./usage.js";
import {
  contentStringValue,
  encodeJsonRequestBody,
  type EncodedJsonBody,
  errorResponse,
  isRecord,
  jsonResponse,
  normalizeErrorMessage,
  numberValue,
  requestAuthIdentity,
  stringValue,
  uuidV5,
} from "./utils.js";

export interface OutputItem {
  index?: number;
  item: unknown;
}

export {
  isResponseCompletionEvent,
  responseMetadataHeaders,
  responseStreamError,
  type ResponseStreamError,
} from "./codex-errors.js";

interface UpstreamResult {
  response: Response;
  credential: SelectedCredential;
}

export interface RequestIdentity {
  sessionId: string;
  threadId: string;
  promptCacheKey: string;
}

interface UpstreamErrorSummary {
  code?: string;
  errorType?: string;
  message: string;
}

const PROMPT_CACHE_NAME_PREFIX = "codex-vercel-proxy:codex:prompt-cache:";
const MAX_CREDENTIAL_ATTEMPTS = 8;

export async function proxyResponses(request: Request, env: AppEnv, input: JsonObject): Promise<Response> {
  const wantsStream = input.stream === true;
  const settings = await settingsStore(env).getSettings();
  const identity = await resolveRequestIdentity(request, input);
  const payload = await prepareCodexPayload(input, true, settings, identity, {
    guardianReviewer: isGuardianReviewerRequest(request),
  });
  const usageContext = createUsageContext(request, {
    endpoint: "/v1/responses",
    model: stringValue(payload.model),
    stream: wantsStream,
  });
  const upstream = await fetchCodexWithRotation(request, env, payload, true, identity);
  if (upstream instanceof Response) {
    scheduleUsageRecord(env, usageContext, {
      statusCode: upstream.status,
      errorCode: upstreamErrorCode(upstream.status),
    });
    return upstream;
  }
  if (wantsStream) {
    return streamResponses(upstream.response, upstream.credential, env, usageContext);
  }
  return aggregateResponses(upstream.response, upstream.credential, env, usageContext);
}

export async function proxyCodexJsonEndpoint(
  request: Request,
  env: AppEnv,
  path: CodexJsonEndpointPath,
  input?: JsonObject,
  query?: URLSearchParams,
): Promise<Response> {
  const manager = credentialManager(env);
  const excluded: string[] = [];
  let lastError: Response | undefined;
  const affinityKey = resolveCodexCredentialAffinityKey(request);

  for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
    let selected: SelectedCredential | null;
    try {
      selected = await manager.selectCredential({ excludedIds: excluded, affinityKey });
    } catch (error) {
      return errorResponse(503, normalizeErrorMessage(error), "credential_unavailable");
    }
    if (selected === null) {
      return lastError ?? errorResponse(503, "no available codex credential", "credential_unavailable");
    }

    const { response: upstream, credential } = await fetchWithUnauthorizedRecovery(manager, selected, (candidate) =>
      fetchCodexJsonEndpointOnce(request, env, candidate, path, input, query),
    );
    if (upstream.ok || upstream.status === 304) {
      scheduleCredentialSuccessUpdate(env, credential.id, upstream.status);
      scheduleCredentialRateLimitUpdate(env, credential);
      return passThroughCodexResponse(upstream);
    }

    const body = await upstream.text();
    // Extension endpoints answer 403 when the account lacks the feature gate
    // (models catalog, memories, search); that is not a credential failure, so
    // surface it without cooling the credential down or rotating.
    if (upstream.status === 403) {
      return responseFromConsumedUpstream(upstream, body);
    }
    const retryAfter = retryAfterSeconds(upstream.headers.get("retry-after"));
    const error = summarizeErrorBody(body);
    if (isFlexUnavailableReply(upstream.status, error)) {
      return responseFromConsumedUpstream(upstream, body);
    }
    const usageErrorType = usageLimitErrorType(error.errorType, error.code);
    let rateLimits = parseRateLimitHeaders(upstream.headers);
    if (upstream.status === 429 && usageErrorType !== undefined) {
      try {
        rateLimits = await manager.refreshRateLimits(credential);
      } catch (refreshError) {
        console.error(`rate limit refresh failed: ${normalizeErrorMessage(refreshError)}`);
      }
    }
    await manager.reportResult(credential.id, {
      ok: false,
      status: upstream.status,
      retryAfterSeconds: retryAfter,
      errorType: usageErrorType ?? error.errorType ?? error.code,
      message: error.message,
      rateLimits: rateLimits.length > 0 ? rateLimits : undefined,
    });
    lastError = responseFromConsumedUpstream(upstream, body);
    excluded.push(credential.id);
    if (!isRotatableStatus(upstream.status)) {
      return lastError;
    }
  }

  return lastError ?? errorResponse(503, "no available codex credential", "credential_unavailable");
}

export async function fetchCodexWithRotation(
  request: Request,
  env: AppEnv,
  payload: JsonObject,
  stream: boolean,
  identity: RequestIdentity,
): Promise<UpstreamResult | Response> {
  const manager = credentialManager(env);
  const excluded: string[] = [];
  let lastError: Response | undefined;
  const affinityKey = resolveCodexCredentialAffinityKey(request);
  // Encode once: every rotation attempt resends the same payload.
  const requestBody = encodeJsonRequestBody(payload, upstreamRequestCompression(env));

  for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
    let selected: SelectedCredential | null;
    try {
      selected = await manager.selectCredential({ excludedIds: excluded, affinityKey });
    } catch (error) {
      return errorResponse(503, normalizeErrorMessage(error), "credential_unavailable");
    }
    if (selected === null) {
      return lastError ?? errorResponse(503, "no available codex credential", "credential_unavailable");
    }

    const { response: upstream, credential } = await fetchWithUnauthorizedRecovery(manager, selected, (candidate) =>
      fetchCodexOnce(request, env, candidate, payload, requestBody, stream, identity),
    );
    if (upstream.ok) {
      // Success is recorded by the stream consumers once response.completed
      // arrives; an HTTP 200 alone can still end in a truncated stream.
      return { response: upstream, credential };
    }

    const body = await upstream.text();
    const retryAfter = retryAfterSeconds(upstream.headers.get("retry-after"));
    const error = summarizeErrorBody(body);
    if (isFlexUnavailableReply(upstream.status, error)) {
      return responseFromConsumedUpstream(upstream, body);
    }
    const usageErrorType = usageLimitErrorType(error.errorType, error.code);
    let rateLimits = parseRateLimitHeaders(upstream.headers);
    if (upstream.status === 429 && usageErrorType !== undefined) {
      try {
        rateLimits = await manager.refreshRateLimits(credential);
      } catch (error) {
        console.error(`rate limit refresh failed: ${normalizeErrorMessage(error)}`);
      }
    }
    await manager.reportResult(credential.id, {
      ok: false,
      status: upstream.status,
      retryAfterSeconds: retryAfter,
      errorType: usageErrorType ?? error.errorType ?? error.code,
      message: error.message,
      rateLimits: rateLimits.length > 0 ? rateLimits : undefined,
    });
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    lastError = new Response(body, { status: upstream.status, headers });
    excluded.push(credential.id);
    if (!isRotatableStatus(upstream.status)) {
      return lastError;
    }
  }

  return lastError ?? errorResponse(503, "no available codex credential", "credential_unavailable");
}

async function fetchCodexOnce(
  request: Request,
  env: AppEnv,
  credential: SelectedCredential,
  payload: JsonObject,
  body: EncodedJsonBody,
  stream: boolean,
  identity: RequestIdentity,
): Promise<Response> {
  const baseURL = codexBaseURL();
  const headers = buildCodexRequestHeaders(
    request,
    env,
    credential,
    stream ? "text/event-stream" : "application/json",
    true,
  );
  if (isResponsesLiteModel(stringValue(payload.model))) {
    headers.set("X-OpenAI-Internal-Codex-Responses-Lite", "true");
  }
  if (!isGuardianReviewerRequest(request)) {
    applyRoutingHint(headers, payload);
  }
  headers.set("X-Client-Request-Id", request.headers.get("x-client-request-id")?.trim() || identity.threadId);
  headers.set("originator", request.headers.get("originator")?.trim() || "codex_cli_rs");
  headers.set("session-id", identity.sessionId);
  headers.set("thread-id", identity.threadId);
  if (body.contentEncoding !== undefined) {
    headers.set("Content-Encoding", body.contentEncoding);
  }
  return fetch(`${baseURL}/responses`, {
    method: "POST",
    headers,
    body: body.body,
  });
}

async function fetchCodexJsonEndpointOnce(
  request: Request,
  env: AppEnv,
  credential: SelectedCredential,
  path: CodexJsonEndpointPath,
  input?: JsonObject,
  query?: URLSearchParams,
): Promise<Response> {
  const url = buildCodexEndpointUrl(path, query);
  const headers = buildCodexRequestHeaders(request, env, credential, "application/json", input !== undefined);
  if (path === "responses/compact" && input !== undefined) {
    applyRoutingHint(headers, input);
  }
  return fetch(url, {
    method: request.method,
    headers,
    body: input === undefined ? undefined : JSON.stringify(input),
  });
}

function applyRoutingHint(headers: Headers, payload: JsonObject): void {
  if (headers.has("X-Codex-Routing-Hint")) {
    return;
  }
  const hint = buildCodexRoutingHint(stringValue(payload.model), stringValue(payload.service_tier));
  if (hint !== undefined) {
    headers.set("X-Codex-Routing-Hint", hint);
  }
}

// Codex recovers from an upstream 401 by refreshing the token and replaying the
// request on the same account before treating the account as failed. Only when
// that recovery fails does the proxy fall through to cooldown and rotation.
async function fetchWithUnauthorizedRecovery(
  manager: CredentialManager,
  credential: SelectedCredential,
  send: (credential: SelectedCredential) => Promise<Response>,
): Promise<{ response: Response; credential: SelectedCredential }> {
  const response = await send(credential);
  if (response.status !== 401) {
    return { response, credential };
  }
  const recovered = await manager.recoverUnauthorized(credential);
  if (recovered === undefined) {
    return { response, credential };
  }
  await response.body?.cancel().catch(() => undefined);
  return { response: await send(recovered), credential: recovered };
}

function passThroughCodexResponse(response: Response): Response {
  const headers = normalizedUpstreamHeaders(response.headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function responseFromConsumedUpstream(response: Response, body: string): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: normalizedUpstreamHeaders(response.headers),
  });
}

function normalizedUpstreamHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return headers;
}

// Session and thread ids follow the Codex client's own headers when present;
// other clients get a stable prompt cache key derived from their auth identity
// that doubles as both ids, so prompt caching and lite prefix ids stay stable
// across turns.
export async function resolveRequestIdentity(request: Request, input: JsonObject): Promise<RequestIdentity> {
  const promptCacheKey = await resolvePromptCacheKey(request, input);
  return {
    sessionId: request.headers.get("session-id")?.trim() || promptCacheKey,
    threadId: request.headers.get("thread-id")?.trim() || promptCacheKey,
    promptCacheKey,
  };
}

async function resolvePromptCacheKey(request: Request, input: JsonObject): Promise<string> {
  const explicit = stringValue(input.prompt_cache_key)?.trim();
  if (explicit) {
    return explicit;
  }
  const identity = requestAuthIdentity(request);
  if (identity === undefined) {
    throw new Error("request auth identity is required");
  }
  return uuidV5(`${PROMPT_CACHE_NAME_PREFIX}${identity}`);
}

export async function reportResponseStreamError(
  env: AppEnv,
  credential: SelectedCredential,
  response: Response,
  error: ResponseStreamError,
): Promise<void> {
  if (!error.credentialFailure) {
    return;
  }
  const manager = credentialManager(env);
  const usageErrorType = usageLimitErrorType(error.errorType, error.code);
  let rateLimits = parseRateLimitHeaders(response.headers);
  if (error.status === 429 && usageErrorType !== undefined) {
    try {
      rateLimits = await manager.refreshRateLimits(credential);
    } catch (refreshError) {
      console.error(`rate limit refresh failed: ${normalizeErrorMessage(refreshError)}`);
    }
  }
  await manager.reportResult(credential.id, {
    ok: false,
    status: error.status,
    retryAfterSeconds: error.retryAfterSeconds,
    errorType: usageErrorType ?? error.errorType ?? error.code,
    message: error.message,
    rateLimits: rateLimits.length > 0 ? rateLimits : undefined,
  });
}

function usageLimitErrorType(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => isUsageLimitErrorType(value));
}

async function aggregateResponses(
  response: Response,
  credential: SelectedCredential,
  env: AppEnv,
  usageContext: UsageContext,
): Promise<Response> {
  const manager = credentialManager(env);
  if (!response.body) {
    await manager.reportResult(credential.id, {
      ok: false,
      status: 502,
      message: "upstream response body is empty",
    });
    scheduleUsageRecord(env, usageContext, {
      credential,
      statusCode: 502,
      errorCode: "bad_upstream_response",
    });
    return errorResponse(502, "upstream response body is empty", "bad_upstream_response");
  }

  const outputItems: OutputItem[] = [];
  let completed: JsonObject | undefined;
  try {
    for await (const event of readSseData(response.body)) {
      const parsed = parseSseJson(event.data);
      if (!parsed) {
        continue;
      }
      collectOutputItem(parsed, outputItems);
      const streamError = responseStreamError(parsed);
      if (streamError) {
        await reportResponseStreamError(env, credential, response, streamError);
        scheduleUsageRecord(env, usageContext, {
          credential,
          statusCode: streamError.status,
          errorCode: streamError.code,
        });
        return errorResponse(streamError.status, streamError.message, streamError.code);
      }
      if (isResponseCompletionEvent(parsed)) {
        completed = patchCompletedOutput(parsed, outputItems);
        break;
      }
    }
  } catch (error) {
    await manager.reportResult(credential.id, {
      ok: false,
      status: 502,
      message: normalizeErrorMessage(error),
    });
    scheduleUsageRecord(env, usageContext, {
      credential,
      statusCode: 502,
      errorCode: "bad_upstream_response",
    });
    return errorResponse(502, normalizeErrorMessage(error), "bad_upstream_response");
  }
  if (!completed) {
    await manager.reportResult(credential.id, {
      ok: false,
      status: 502,
      message: "upstream stream ended before response.completed",
    });
    scheduleUsageRecord(env, usageContext, {
      credential,
      statusCode: 502,
      errorCode: "bad_upstream_response",
    });
    return errorResponse(502, "upstream stream ended before response.completed", "bad_upstream_response");
  }
  const responseValue = responseObject(completed);
  scheduleCredentialSuccessUpdate(env, credential.id, response.status);
  scheduleUsageRecord(env, usageContext, {
    credential,
    response: responseValue,
    statusCode: response.status,
  });
  scheduleCredentialRateLimitUpdate(env, credential);
  return jsonResponse(responseValue, { headers: responseMetadataHeaders(response) });
}

async function streamResponses(
  response: Response,
  credential: SelectedCredential,
  env: AppEnv,
  usageContext: UsageContext,
): Promise<Response> {
  const manager = credentialManager(env);
  const upstreamBody = response.body;
  if (!upstreamBody) {
    return emptyUpstreamBodyResponse(manager, credential, env, usageContext);
  }
  const headers = sseResponseHeaders(response.headers);
  const reader = upstreamBody.getReader();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (value: string | JsonObject): void => {
        if (!cancelled) {
          controller.enqueue(encodeSseData(value));
        }
      };
      // The client may cancel while a failure report is awaited; closing a
      // cancelled stream throws, so only close what is still open.
      const finish = (): void => {
        if (!cancelled) {
          controller.close();
        }
      };
      const outputItems: OutputItem[] = [];
      let completedSeen = false;
      let terminalErrorSeen = false;
      try {
        for await (const event of readSseDataFromReader(reader)) {
          if (cancelled) {
            break;
          }
          const parsed = parseSseJson(event.data);
          if (!parsed) {
            push(event.data);
            continue;
          }
          collectOutputItem(parsed, outputItems);
          const streamError = responseStreamError(parsed);
          if (streamError) {
            terminalErrorSeen = true;
            await reportResponseStreamError(env, credential, response, streamError);
            scheduleUsageRecord(env, usageContext, {
              credential,
              statusCode: streamError.status,
              errorCode: streamError.code,
            });
            push(parsed);
            break;
          }
          if (isResponseCompletionEvent(parsed)) {
            const completed = patchCompletedOutput(parsed, outputItems);
            completedSeen = true;
            scheduleCredentialSuccessUpdate(env, credential.id, response.status);
            scheduleUsageRecord(env, usageContext, {
              credential,
              response: responseObject(completed),
              statusCode: response.status,
            });
            scheduleCredentialRateLimitUpdate(env, credential);
            push(completed);
            break;
          }
          push(parsed);
        }
      } catch (error) {
        if (cancelled) {
          recordClientCancelled(env, usageContext, credential);
          return;
        }
        const message = normalizeErrorMessage(error);
        await manager.reportResult(credential.id, { ok: false, status: 502, message });
        scheduleUsageRecord(env, usageContext, {
          credential,
          statusCode: 502,
          errorCode: "bad_upstream_response",
        });
        push(responsesStreamErrorEvent("bad_upstream_response", message));
        finish();
        return;
      }
      if (cancelled) {
        recordClientCancelled(env, usageContext, credential);
        return;
      }
      if (!completedSeen && !terminalErrorSeen) {
        // Upstream hung up before the terminal event: tell the client instead
        // of ending the stream as if it had completed.
        await manager.reportResult(credential.id, {
          ok: false,
          status: 502,
          message: STREAM_TRUNCATED_MESSAGE,
        });
        scheduleUsageRecord(env, usageContext, {
          credential,
          statusCode: 502,
          errorCode: "bad_upstream_response",
        });
        push(responsesStreamErrorEvent("bad_upstream_response", STREAM_TRUNCATED_MESSAGE));
      }
      finish();
    },
    async cancel(reason) {
      // The client went away: stop pulling from upstream so the connection and
      // the credential's quota are released; this is not an upstream failure.
      cancelled = true;
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, { status: response.status, headers });
}

export const STREAM_TRUNCATED_MESSAGE = "upstream stream ended before response.completed";
const CLIENT_CANCELLED_STATUS = 499;

// Headers for a stream the proxy re-encodes itself: the upstream body was
// already decoded by fetch, so its transfer and encoding headers no longer apply.
export function sseResponseHeaders(upstream: Headers): Headers {
  const headers = normalizedUpstreamHeaders(upstream);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  return headers;
}

export function responsesStreamErrorEvent(code: string, message: string): JsonObject {
  return { type: "error", code, message, param: null };
}

export function recordClientCancelled(env: AppEnv, usageContext: UsageContext, credential: SelectedCredential): void {
  scheduleUsageRecord(env, usageContext, {
    credential,
    statusCode: CLIENT_CANCELLED_STATUS,
    errorCode: "client_cancelled",
  });
}

export async function emptyUpstreamBodyResponse(
  manager: CredentialManager,
  credential: SelectedCredential,
  env: AppEnv,
  usageContext: UsageContext,
): Promise<Response> {
  const message = "upstream response body is empty";
  await manager.reportResult(credential.id, { ok: false, status: 502, message });
  scheduleUsageRecord(env, usageContext, {
    credential,
    statusCode: 502,
    errorCode: "bad_upstream_response",
  });
  return errorResponse(502, message, "bad_upstream_response");
}

export function responseObject(event: JsonObject): JsonValue {
  const response = event.response;
  return response === undefined ? event : response;
}

export function extractResponseText(response: JsonValue): string {
  if (!isRecord(response)) {
    return "";
  }
  const output = Array.isArray(response.output) ? response.output : [];
  const parts: string[] = [];
  for (const item of output) {
    collectMessageText(item, parts);
  }
  return parts.join("");
}

function collectMessageText(value: unknown, parts: string[]): void {
  if (!isRecord(value) || value.type !== "message" || !Array.isArray(value.content)) {
    return;
  }
  for (const part of value.content) {
    if (!isRecord(part)) {
      continue;
    }
    const type = stringValue(part.type);
    const text = contentStringValue(part.text);
    if (text !== undefined && (type === "output_text" || type === "text")) {
      parts.push(text);
    }
  }
}

export function collectOutputItem(event: JsonObject, outputItems: OutputItem[]): void {
  if (event.type !== "response.output_item.done") {
    return;
  }
  if (!("item" in event)) {
    return;
  }
  const index = numberValue(event.output_index);
  outputItems.push({ index, item: event.item });
}

export function patchCompletedOutput(event: JsonObject, outputItems: OutputItem[]): JsonObject {
  const response = isRecord(event.response) ? { ...event.response } : undefined;
  if (!response) {
    return event;
  }
  const output = Array.isArray(response.output) ? response.output : undefined;
  if (output !== undefined && output.length > 0) {
    return event;
  }
  const sorted = [...outputItems].sort((left, right) => {
    if (left.index === undefined && right.index === undefined) {
      return 0;
    }
    if (left.index === undefined) {
      return 1;
    }
    if (right.index === undefined) {
      return -1;
    }
    return left.index - right.index;
  });
  response.output = sorted.map((entry) => entry.item) as JsonValue;
  return { ...event, response: response as JsonValue };
}

// Flex capacity is not tied to the account, so another credential will not
// help: surface it without cooling the credential down or rotating.
function isFlexUnavailableReply(status: number, error: UpstreamErrorSummary): boolean {
  return status === 429 && error.code === FLEX_UNAVAILABLE_CODE;
}

function isRotatableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds;
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

function summarizeErrorBody(body: string): UpstreamErrorSummary {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      return {
        code: stringValue(parsed.error.code),
        errorType: stringValue(parsed.error.type),
        message: stringValue(parsed.error.message) ?? body.slice(0, 500),
      };
    }
    if (isRecord(parsed)) {
      return {
        code: stringValue(parsed.code),
        errorType: stringValue(parsed.type),
        message: stringValue(parsed.message) ?? body.slice(0, 500),
      };
    }
  } catch {
  }
  return { message: body.slice(0, 500) };
}

function upstreamErrorCode(status: number): string {
  if (status === 503) {
    return "credential_unavailable";
  }
  return "upstream_error";
}
