import { codexBaseURL, userAgent, type AppEnv } from "./env.js";
import type { SelectedCredential } from "./types.js";

export type CodexJsonEndpointPath =
  | "alpha/search"
  | "images/edits"
  | "images/generations"
  | "memories/trace_summarize"
  | "models"
  | "responses/compact";

const CODEX_JSON_POST_ROUTES = new Map<string, CodexJsonEndpointPath>([
  ["/v1/alpha/search", "alpha/search"],
  ["/v1/images/edits", "images/edits"],
  ["/v1/images/generations", "images/generations"],
  ["/v1/memories/trace_summarize", "memories/trace_summarize"],
  ["/v1/responses/compact", "responses/compact"],
]);

export function resolveCodexJsonPostEndpoint(pathname: string, method: string): CodexJsonEndpointPath | undefined {
  return method === "POST" ? CODEX_JSON_POST_ROUTES.get(pathname) : undefined;
}

// Codex sends x-codex-routing-hint on /responses and /responses/compact so the
// backend can route by model and service tier before parsing the body.
export function buildCodexRoutingHint(model: string | undefined, serviceTier: string | undefined): string | undefined {
  if (model === undefined) {
    return undefined;
  }
  return serviceTier === undefined ? `model=${model}` : `model=${model};tier=${serviceTier}`;
}

export function buildCodexEndpointUrl(path: CodexJsonEndpointPath, query?: URLSearchParams): URL {
  const url = new URL(`${codexBaseURL()}/${path}`);
  query?.forEach((value, name) => url.searchParams.append(name, value));
  return url;
}

export function buildCodexRequestHeaders(
  request: Request,
  env: AppEnv,
  credential: SelectedCredential,
  accept: string,
  hasJsonBody: boolean,
): Headers {
  const headers = new Headers();
  if (hasJsonBody) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", accept);
  headers.set("Authorization", `Bearer ${credential.token}`);
  headers.set("User-Agent", userAgent(env, request.headers));
  headers.set("Connection", "Keep-Alive");
  // Current Codex clients no longer send a Version header: the client version
  // travels in User-Agent and in the /models client_version query. Forward it
  // only when an older client still sets it.
  copyHeader(request.headers, headers, "Version");
  copyHeader(request.headers, headers, "If-None-Match");
  copyHeader(request.headers, headers, "X-OAI-Attestation");
  copyHeader(request.headers, headers, "X-OpenAI-Memgen-Request");
  copyHeader(request.headers, headers, "X-OpenAI-Subagent");
  copyHeader(request.headers, headers, "X-OpenAI-Internal-Codex-Responses-Lite");
  copyHeader(request.headers, headers, "X-Codex-Turn-Metadata");
  copyHeader(request.headers, headers, "X-Codex-Turn-State");
  copyHeader(request.headers, headers, "X-Codex-Window-Id");
  copyHeader(request.headers, headers, "X-Codex-Parent-Thread-Id");
  copyHeader(request.headers, headers, "X-Codex-Installation-Id");
  copyHeader(request.headers, headers, "X-Codex-Beta-Features");
  copyHeader(request.headers, headers, "X-Codex-Routing-Hint");
  copyHeader(request.headers, headers, "X-Client-Request-Id");
  copyHeader(request.headers, headers, "originator");
  copyHeader(request.headers, headers, "session-id");
  copyHeader(request.headers, headers, "thread-id");
  if (credential.accountId) {
    headers.set("ChatGPT-Account-Id", credential.accountId);
  }
  if (credential.fedramp) {
    headers.set("X-OpenAI-Fedramp", "true");
  }
  return headers;
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value) {
    to.set(name, value);
  }
}
