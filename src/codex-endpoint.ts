import { codexBaseURL, codexClientVersion, userAgent, type AppEnv } from "./env.js";
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
  headers.set("Version", codexClientVersion(env, request.headers));
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
  copyHeader(request.headers, headers, "X-Client-Request-Id");
  copyHeader(request.headers, headers, "originator");
  copyHeader(request.headers, headers, "session-id");
  copyHeader(request.headers, headers, "thread-id");
  if (credential.accountId) {
    headers.set("ChatGPT-Account-Id", credential.accountId);
  }
  return headers;
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value) {
    to.set(name, value);
  }
}
