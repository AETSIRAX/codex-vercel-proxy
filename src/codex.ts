import { credentialManager, scheduleCredentialRateLimitUpdate, scheduleCredentialSuccessUpdate } from "./credential-manager.js";
import { resolveCodexCredentialAffinityKey } from "./codex-affinity.js";
import {
  applyCodexIdentityConfuseHeaders,
  applyCodexIdentityConfusePayload,
  applyCodexIdentityExposeText,
  type CodexIdentityState,
} from "./codex-identity.js";
import { codexBaseURL, userAgent } from "./env.js";
import type { AppEnv } from "./env.js";
import { isUsageLimitErrorType, parseRateLimitHeaders } from "./rate-limits.js";
import { settingsStore, type ProxySettings } from "./settings.js";
import { readSseData, encodeSseData, parseSseJson } from "./sse.js";
import type { JsonObject, JsonValue, SelectedCredential } from "./types.js";
import { createUsageContext, scheduleUsageRecord, type UsageContext } from "./usage.js";
import {
  contentStringValue,
  errorResponse,
  isRecord,
  jsonResponse,
  normalizeErrorMessage,
  numberValue,
  requestAuthIdentity,
  stringValue,
} from "./utils.js";

export interface OutputItem {
  index?: number;
  item: unknown;
}

export interface ResponseStreamError {
  code: string;
  errorType?: string;
  message: string;
  status: number;
}

interface UpstreamResult {
  response: Response;
  credential: SelectedCredential;
  identityState: CodexIdentityState;
}

interface UpstreamFetchResult {
  response: Response;
  identityState: CodexIdentityState;
}

interface RequestIdentity {
  sessionId: string;
  threadId: string;
}

interface UpstreamErrorSummary {
  code?: string;
  errorType?: string;
  message: string;
}

const UUID_V5_NAMESPACE_OID = "6ba7b8129dad11d180b400c04fd430c8";
const PROMPT_CACHE_NAME_PREFIX = "codex-vercel-proxy:codex:prompt-cache:";
const MAX_CREDENTIAL_ATTEMPTS = 8;

export function prepareCodexPayload(input: JsonObject, forceStream: boolean, settings: ProxySettings): JsonObject {
  const payload = structuredClone(input) as JsonObject;
  if (typeof payload.input === "string") {
    payload.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: payload.input }] }];
  }
  if (forceStream) {
    payload.stream = true;
  }
  payload.store = false;
  payload.parallel_tool_calls = true;
  delete payload.previous_response_id;
  delete payload.prompt_cache_retention;
  delete payload.safety_identifier;
  delete payload.stream_options;
  delete payload.max_output_tokens;
  delete payload.max_completion_tokens;
  delete payload.max_tokens;
  delete payload.temperature;
  delete payload.top_p;
  delete payload.truncation;
  delete payload.context_management;
  delete payload.user;
  delete payload.service_tier;
  if (settings.fastMode) {
    payload.service_tier = "priority";
  }
  normalizeResponsesInputRoles(payload);
  normalizeCodexBuiltinTools(payload);
  if (!("instructions" in payload) || payload.instructions === null) {
    payload.instructions = "";
  }
  normalizeReasoningInclude(payload);
  return payload;
}

function normalizeReasoningInclude(payload: JsonObject): void {
  const include = Array.isArray(payload.include) ? payload.include : [];
  const filtered = include.filter((item) => item !== "reasoning.encrypted_content") as JsonValue[];
  if (isRecord(payload.reasoning)) {
    filtered.push("reasoning.encrypted_content");
  }
  if (filtered.length > 0) {
    payload.include = filtered;
  } else {
    delete payload.include;
  }
}

function normalizeResponsesInputRoles(payload: JsonObject): void {
  if (!Array.isArray(payload.input)) {
    return;
  }
  for (const item of payload.input) {
    if (isRecord(item) && item.role === "system") {
      item.role = "developer";
    }
  }
}

function normalizeCodexBuiltinTools(payload: JsonObject): void {
  normalizeToolArray(payload.tools);

  const toolChoice = payload.tool_choice;
  if (!isRecord(toolChoice)) {
    return;
  }
  normalizeToolObject(toolChoice);
  normalizeToolArray(toolChoice.tools);
}

function normalizeToolArray(value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (isRecord(item)) {
      normalizeToolObject(item);
    }
  }
}

function normalizeToolObject(tool: Record<string, unknown>): void {
  const type = stringValue(tool.type);
  if (type === "web_search_preview" || type === "web_search_preview_2025_03_11") {
    tool.type = "web_search";
  }
}

export async function proxyResponses(request: Request, env: AppEnv, input: JsonObject): Promise<Response> {
  const wantsStream = input.stream === true;
  const settings = await settingsStore(env).getSettings();
  const payload = prepareCodexPayload(input, true, settings);
  const usageContext = createUsageContext(request, {
    endpoint: "/v1/responses",
    model: stringValue(payload.model),
    stream: wantsStream,
  });
  const upstream = await fetchCodexWithRotation(request, env, payload, true, settings);
  if (upstream instanceof Response) {
    scheduleUsageRecord(env, usageContext, {
      statusCode: upstream.status,
      errorCode: upstreamErrorCode(upstream.status),
    });
    return upstream;
  }
  if (wantsStream) {
    return streamResponses(upstream.response, upstream.credential, env, usageContext, upstream.identityState);
  }
  return aggregateResponses(upstream.response, upstream.credential, env, usageContext, upstream.identityState);
}

export async function fetchCodexWithRotation(
  request: Request,
  env: AppEnv,
  payload: JsonObject,
  stream: boolean,
  settings: ProxySettings,
): Promise<UpstreamResult | Response> {
  const manager = credentialManager(env);
  const excluded: string[] = [];
  let lastError: Response | undefined;
  const affinityKey = resolveCodexCredentialAffinityKey(request);
  const identity = await ensureRequestIdentity(request, payload);

  for (let attempt = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
    let credential: SelectedCredential | null;
    try {
      credential = await manager.selectCredential({ excludedIds: excluded, affinityKey });
    } catch (error) {
      return errorResponse(503, normalizeErrorMessage(error), "credential_unavailable");
    }
    if (credential === null) {
      return errorResponse(503, "no available codex credential", "credential_unavailable");
    }

    const upstream = await fetchCodexOnce(request, env, credential, payload, stream, identity, settings);
    if (upstream.response.ok) {
      scheduleCredentialSuccessUpdate(env, credential.id, upstream.response.status);
      return { response: upstream.response, credential, identityState: upstream.identityState };
    }

    const body = applyCodexIdentityExposeText(await upstream.response.text(), upstream.identityState);
    const retryAfter = retryAfterSeconds(upstream.response.headers.get("retry-after"));
    const error = summarizeErrorBody(body);
    const usageErrorType = usageLimitErrorType(error.errorType, error.code);
    let rateLimits = parseRateLimitHeaders(upstream.response.headers);
    if (upstream.response.status === 429 && usageErrorType !== undefined) {
      try {
        rateLimits = await manager.refreshRateLimits(credential);
      } catch (error) {
        console.error(`rate limit refresh failed: ${normalizeErrorMessage(error)}`);
      }
    }
    await manager.reportResult(credential.id, {
      ok: false,
      status: upstream.response.status,
      retryAfterSeconds: retryAfter,
      errorType: usageErrorType ?? error.errorType ?? error.code,
      message: error.message,
      rateLimits: rateLimits.length > 0 ? rateLimits : undefined,
    });
    const headers = new Headers(upstream.response.headers);
    headers.delete("content-length");
    lastError = new Response(body, { status: upstream.response.status, headers });
    excluded.push(credential.id);
    if (!isRotatableStatus(upstream.response.status)) {
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
  stream: boolean,
  identity: RequestIdentity,
  settings: ProxySettings,
): Promise<UpstreamFetchResult> {
  const baseURL = codexBaseURL();
  const upstreamPayload = structuredClone(payload) as JsonObject;
  const identityState = await applyCodexIdentityConfusePayload(settings, credential, payload, upstreamPayload);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Accept", stream ? "text/event-stream" : "application/json");
  headers.set("Authorization", `Bearer ${credential.token}`);
  headers.set("User-Agent", userAgent(env));
  headers.set("Connection", "Keep-Alive");
  copyHeader(request.headers, headers, "Version");
  copyHeader(request.headers, headers, "X-Codex-Turn-Metadata");
  copyHeader(request.headers, headers, "X-Codex-Turn-State");
  copyHeader(request.headers, headers, "X-Codex-Window-Id");
  copyHeader(request.headers, headers, "X-Codex-Beta-Features");
  const sessionId = request.headers.get("session-id")?.trim() || identity.sessionId;
  const threadId = request.headers.get("thread-id")?.trim() || identity.threadId;
  headers.set("X-Client-Request-Id", request.headers.get("x-client-request-id")?.trim() || threadId);
  headers.set("originator", request.headers.get("originator")?.trim() || "codex_cli_rs");
  headers.set("session-id", sessionId);
  headers.set("thread-id", threadId);
  if (credential.accountId) {
    headers.set("ChatGPT-Account-Id", credential.accountId);
  }
  await applyCodexIdentityConfuseHeaders(headers, identityState);
  const response = await fetch(`${baseURL}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamPayload),
  });
  return { response, identityState };
}

async function ensureRequestIdentity(request: Request, payload: JsonObject): Promise<RequestIdentity> {
  const explicit = stringValue(payload.prompt_cache_key);
  const explicitTrimmed = explicit?.trim();
  if (explicitTrimmed) {
    payload.prompt_cache_key = explicitTrimmed;
    return {
      sessionId: explicitTrimmed,
      threadId: explicitTrimmed,
    };
  }
  const identity = requestAuthIdentity(request);
  if (identity === undefined) {
    throw new Error("request auth identity is required");
  }
  const cacheKey = await uuidV5(`${PROMPT_CACHE_NAME_PREFIX}${identity}`, UUID_V5_NAMESPACE_OID);
  payload.prompt_cache_key = cacheKey;
  return {
    sessionId: cacheKey,
    threadId: cacheKey,
  };
}

async function uuidV5(name: string, namespaceHex: string): Promise<string> {
  const namespace = hexToBytes(namespaceHex);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespace.length + nameBytes.length);
  input.set(namespace, 0);
  input.set(nameBytes, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function responseStreamError(event: JsonObject): ResponseStreamError | undefined {
  if (event.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    const error = isRecord(response?.error) ? response.error : undefined;
    const code = stringValue(error?.code) ?? "response_failed";
    const errorType = stringValue(error?.type);
    return {
      code,
      errorType,
      message: stringValue(error?.message) ?? "response.failed event received",
      status: responseErrorStatus(code, errorType),
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

export async function reportResponseStreamError(
  env: AppEnv,
  credential: SelectedCredential,
  response: Response,
  error: ResponseStreamError,
): Promise<void> {
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
    errorType: usageErrorType ?? error.errorType ?? error.code,
    message: error.message,
    rateLimits: rateLimits.length > 0 ? rateLimits : undefined,
  });
}

function usageLimitErrorType(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => isUsageLimitErrorType(value));
}

function responseErrorStatus(code: string, errorType: string | undefined): number {
  if (isUsageLimitErrorType(errorType) || isUsageLimitErrorType(code) || code === "insufficient_quota") {
    return 429;
  }
  if (code === "context_length_exceeded" || code === "invalid_prompt" || code === "cyber_policy") {
    return 400;
  }
  if (code === "server_overloaded") {
    return 503;
  }
  return 502;
}

function responseMetadataHeaders(response: Response): Headers {
  const headers = new Headers();
  copyHeader(response.headers, headers, "x-codex-turn-state");
  return headers;
}

async function aggregateResponses(
  response: Response,
  credential: SelectedCredential,
  env: AppEnv,
  usageContext: UsageContext,
  identityState: CodexIdentityState,
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
      const parsed = parseSseJson(applyCodexIdentityExposeText(event.data, identityState));
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
      if (parsed.type === "response.completed") {
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
  scheduleUsageRecord(env, usageContext, {
    credential,
    response: responseValue,
    statusCode: response.status,
  });
  scheduleCredentialRateLimitUpdate(env, credential);
  return jsonResponse(responseValue, { headers: responseMetadataHeaders(response) });
}

function streamResponses(
  response: Response,
  credential: SelectedCredential,
  env: AppEnv,
  usageContext: UsageContext,
  identityState: CodexIdentityState,
): Response {
  const manager = credentialManager(env);
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.delete("content-length");
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const outputItems: OutputItem[] = [];
      let completedSeen = false;
      let terminalErrorSeen = false;
      try {
        if (!response.body) {
          throw new Error("upstream response body is empty");
        }
        for await (const event of readSseData(response.body)) {
          const exposedData = applyCodexIdentityExposeText(event.data, identityState);
          const parsed = parseSseJson(exposedData);
          if (!parsed) {
            controller.enqueue(encodeSseData(exposedData));
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
            controller.enqueue(encodeSseData(parsed));
            break;
          }
          if (parsed.type === "response.completed") {
            const completed = patchCompletedOutput(parsed, outputItems);
            completedSeen = true;
            scheduleUsageRecord(env, usageContext, {
              credential,
              response: responseObject(completed),
              statusCode: response.status,
            });
            scheduleCredentialRateLimitUpdate(env, credential);
            controller.enqueue(encodeSseData(completed));
            break;
          } else {
            controller.enqueue(encodeSseData(parsed));
          }
        }
        if (!completedSeen && !terminalErrorSeen) {
          scheduleUsageRecord(env, usageContext, {
            credential,
            statusCode: 502,
            errorCode: "bad_upstream_response",
          });
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
        controller.error(error);
        return;
      }
      controller.close();
    },
  });
  return new Response(body, { status: response.status, headers });
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

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value) {
    to.set(name, value);
  }
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
