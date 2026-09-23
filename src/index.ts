import { requireAdminAuth, requireCronAuth, requireProxyAuth } from "./auth.js";
import { proxyChatCompletions } from "./chat.js";
import { proxyCodexJsonEndpoint, proxyResponses } from "./codex.js";
import { resolveCodexJsonPostEndpoint } from "./codex-endpoint.js";
import { completeCodexOAuth, startCodexOAuth } from "./codex-oauth.js";
import { credentialManager } from "./credential-manager.js";
import { database } from "./db.js";
import { configuredModels, envString, type AppEnv } from "./env.js";
import { settingsStore } from "./settings.js";
import { usageReporter } from "./usage.js";
import {
  booleanValue,
  errorResponse,
  isRecord,
  jsonResponse,
  normalizeErrorMessage,
  readJsonObject,
  RequestBodyError,
  stringValue,
} from "./utils.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,content-type,if-none-match,x-api-key,x-client-request-id,x-oai-attestation,x-openai-memgen-request,x-openai-subagent,session-id,thread-id,x-codex-turn-state,x-codex-turn-metadata,x-codex-window-id,x-codex-parent-thread-id,x-codex-installation-id,x-codex-beta-features,x-codex-routing-hint,x-codex-guardian,x-openai-internal-codex-responses-lite,originator,version",
  "Access-Control-Expose-Headers":
    "etag,x-codex-turn-state,openai-model,x-reasoning-included,x-models-etag,x-request-id,x-codex-promo-message,x-codex-active-limit,x-codex-rate-limit-reached-type",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,HEAD,OPTIONS",
};
const DEFAULT_USAGE_RANGE_MS = 24 * 60 * 60 * 1000;
const MAX_USAGE_EVENT_LIMIT = 500;

export async function handleRequest(request: Request, env: AppEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }
  const url = new URL(request.url);
  const routedPath = url.searchParams.get("__path");
  if (routedPath) {
    url.pathname = routedPath.startsWith("/") ? routedPath : `/${routedPath}`;
    url.searchParams.delete("__path");
  }
  if (url.pathname === "/healthz") {
    return withCors(await handleHealthz(env));
  }
  try {
    const response = url.pathname.startsWith("/admin/")
      ? await handleAdmin(request, env, url)
      : url.pathname === "/cron/refresh"
        ? await handleCronRefresh(request, env)
        : url.pathname === "/cron/cleanup"
          ? await handleCronCleanup(request, env)
          : await handleOpenAI(request, env, url);
    return withCors(response);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return withCors(errorResponse(error.status, error.message, error.code));
    }
    return withCors(errorResponse(500, normalizeErrorMessage(error), "internal_error"));
  }
}

async function handleHealthz(env: AppEnv): Promise<Response> {
  const required = ["DATABASE_URL", "CRON_SECRET", "CRED_ENCRYPTION_KEY"];
  if (!required.every((name) => envString(env, name) !== undefined)) {
    return new Response(null, { status: 503 });
  }
  try {
    await database(env)`SELECT 1`;
    const settings = await settingsStore(env).getAuthSettings();
    if (settings.proxyApiKeyHashes.length === 0 || !settings.adminTokenHash) {
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 200 });
  } catch {
    return new Response(null, { status: 503 });
  }
}

async function handleOpenAI(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const authError = await requireProxyAuth(request, env);
  if (authError) {
    return authError;
  }
  if (url.pathname === "/v1/models" && request.method === "GET") {
    if (url.searchParams.has("client_version")) {
      const clientVersion = stringValue(url.searchParams.get("client_version"));
      if (clientVersion === undefined) {
        return errorResponse(400, "client_version must not be empty", "invalid_request");
      }
      return proxyCodexJsonEndpoint(
        request,
        env,
        "models",
        undefined,
        new URLSearchParams({ client_version: clientVersion }),
      );
    }
    return jsonResponse({
      object: "list",
      data: configuredModels(env).map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "codex",
      })),
    });
  }
  if (url.pathname === "/v1/responses" && request.method === "POST") {
    return proxyResponses(request, env, await readJsonObject(request));
  }
  if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
    return proxyChatCompletions(request, env, await readJsonObject(request));
  }
  const codexEndpoint = resolveCodexJsonPostEndpoint(url.pathname, request.method);
  if (codexEndpoint !== undefined) {
    return proxyCodexJsonEndpoint(request, env, codexEndpoint, await readJsonObject(request));
  }
  return errorResponse(404, "route not found", "not_found");
}

async function handleAdmin(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const authError = await requireAdminAuth(request, env);
  if (authError) {
    return authError;
  }

  if (url.pathname === "/admin/usage/summary" && request.method === "GET") {
    try {
      return jsonResponse(await usageReporter(env).summary(parseUsageRange(url)));
    } catch (error) {
      return errorResponse(400, normalizeErrorMessage(error), "invalid_request");
    }
  }

  if (url.pathname === "/admin/usage/events" && request.method === "GET") {
    try {
      return jsonResponse(
        await usageReporter(env).events({
          ...parseUsageRange(url),
          limit: parseUsageLimit(url.searchParams.get("limit")),
        }),
      );
    } catch (error) {
      return errorResponse(400, normalizeErrorMessage(error), "invalid_request");
    }
  }

  if (url.pathname === "/admin/settings" && request.method === "GET") {
    return jsonResponse(await settingsStore(env).getSettings());
  }

  if (url.pathname === "/admin/settings" && request.method === "POST") {
    try {
      return jsonResponse(await settingsStore(env).updateSettings(await readJsonObject(request)));
    } catch (error) {
      return errorResponse(400, normalizeErrorMessage(error), "invalid_request");
    }
  }

  const manager = credentialManager(env);

  if (url.pathname === "/admin/oauth/codex/start" && request.method === "POST") {
    const { authUrl, state, codeVerifier, redirectUri } = await startCodexOAuth();
    return jsonResponse({
      auth_url: authUrl,
      state,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
  }

  if (url.pathname === "/admin/oauth/codex/complete" && request.method === "POST") {
    try {
      const body = await readJsonObject(request);
      const result = await completeCodexOAuth({
        code: stringValue(body.code),
        redirectUrl: stringValue(body.redirect_url),
        codeVerifier: stringValue(body.code_verifier) ?? "",
        expectedState: stringValue(body.state),
      });
      const credential: Record<string, unknown> = { ...result.credential };
      const disabled = booleanValue(body.disabled);
      if (disabled !== undefined) {
        credential.disabled = disabled;
      }
      const imported = await manager.importCredential(credential);
      return jsonResponse({
        ...imported,
        account_id: result.accountId,
        email: result.email,
        expired: result.expiresAt,
      });
    } catch (error) {
      return errorResponse(400, normalizeErrorMessage(error), "invalid_request");
    }
  }

  if (url.pathname === "/admin/health" && request.method === "GET") {
    const credentials = await manager.listCredentials();
    return jsonResponse({
      ok: true,
      credential_count: credentials.length,
      available_count: credentials.filter((item) => item.enabled && item.status !== "cooldown" && item.status !== "invalid")
        .length,
      credentials,
    });
  }

  if (url.pathname === "/admin/credentials" && request.method === "GET") {
    return jsonResponse({ data: await manager.listCredentials() });
  }

  if (url.pathname === "/admin/credentials/import" && request.method === "POST") {
    const body = await request.json();
    if (Array.isArray(body)) {
      const imported = [];
      for (const item of body) {
        imported.push(await manager.importCredential(item));
      }
      return jsonResponse({ data: imported });
    }
    if (!isRecord(body)) {
      return errorResponse(400, "credential import payload must be an object or array", "invalid_request");
    }
    return jsonResponse(await manager.importCredential(body));
  }

  if (url.pathname === "/admin/credentials/refresh" && request.method === "POST") {
    return jsonResponse(await manager.refreshCredentials());
  }

  const credentialAction = /^\/admin\/credentials\/([^/]+)\/(enable|disable|refresh)$/.exec(url.pathname);
  if (credentialAction && request.method === "POST") {
    const id = decodeURIComponent(credentialAction[1]);
    const action = credentialAction[2];
    if (action === "enable") {
      return jsonResponse(await manager.setEnabled(id, true));
    }
    if (action === "disable") {
      return jsonResponse(await manager.setEnabled(id, false));
    }
    return jsonResponse(await manager.refreshCredential(id));
  }

  const credentialDelete = /^\/admin\/credentials\/([^/]+)$/.exec(url.pathname);
  if (credentialDelete && request.method === "DELETE") {
    return jsonResponse(await manager.deleteCredential(decodeURIComponent(credentialDelete[1])));
  }

  return errorResponse(404, "admin route not found", "not_found");
}

async function handleCronRefresh(request: Request, env: AppEnv): Promise<Response> {
  const authError = await requireCronAuth(request, env);
  if (authError) {
    return authError;
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return errorResponse(405, "method not allowed", "method_not_allowed");
  }
  return jsonResponse(await credentialManager(env).refreshDue());
}

const USAGE_EVENTS_RETAIN_MS = 90 * 24 * 60 * 60 * 1000;

async function handleCronCleanup(request: Request, env: AppEnv): Promise<Response> {
  const authError = await requireCronAuth(request, env);
  if (authError) {
    return authError;
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return errorResponse(405, "method not allowed", "method_not_allowed");
  }
  return jsonResponse(await usageReporter(env).cleanup(USAGE_EVENTS_RETAIN_MS));
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function parseUsageRange(url: URL): { from: number; to: number } {
  const now = Date.now();
  const from = parseOptionalTime(url.searchParams.get("from"), "from") ?? now - DEFAULT_USAGE_RANGE_MS;
  const to = parseOptionalTime(url.searchParams.get("to"), "to") ?? now;
  if (from >= to) {
    throw new Error("from must be earlier than to");
  }
  return { from, to };
}

function parseOptionalTime(value: string | null, name: string): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }
  throw new Error(`${name} must be an ISO time or millisecond timestamp`);
}

function parseUsageLimit(value: string | null): number {
  if (value === null || value.trim() === "") {
    return 100;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_USAGE_EVENT_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_USAGE_EVENT_LIMIT}`);
  }
  return parsed;
}
