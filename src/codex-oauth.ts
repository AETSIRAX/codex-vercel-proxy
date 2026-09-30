import { parseJwtIdentity } from "./jwt.js";
import { base64UrlEncode, isRecord, numberValue, stringValue, textToBytes } from "./utils.js";

// Codex CLI OAuth client. The same public client id is used for token refresh in
// credential-manager.ts. OpenAI only accepts the fixed loopback redirect that the
// Codex CLI registered, so the web console reuses it and asks the operator to paste
// the resulting callback URL back instead of running a local listener on port 1455.
const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
// Codex CLI (codex-rs/login/src/server.rs) requests the connector scopes as well.
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_ORIGINATOR = "codex_cli_rs";
const PKCE_VERIFIER_BYTES = 96;
const STATE_BYTES = 32;

export interface CodexOAuthStart {
  authUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface CodexOAuthCompleteInput {
  code?: string;
  redirectUrl?: string;
  codeVerifier: string;
  expectedState?: string;
}

export interface CodexCredentialImport {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
  email?: string;
  expired?: string;
  last_refresh: string;
  type: "codex";
}

export interface CodexOAuthResult {
  credential: CodexCredentialImport;
  accountId?: string;
  email?: string;
  expiresAt?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(PKCE_VERIFIER_BYTES)));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textToBytes(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(STATE_BYTES)));
}

export function buildAuthUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Codex CLI does not force a fresh login; the console keeps `prompt=login`
    // so operators can import several accounts from one browser session.
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: CODEX_ORIGINATOR,
  });
  return `${OPENAI_AUTHORIZE_URL}?${params.toString()}`;
}

export async function startCodexOAuth(): Promise<CodexOAuthStart> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();
  return {
    authUrl: buildAuthUrl(state, codeChallenge),
    state,
    codeVerifier,
    redirectUri: CODEX_REDIRECT_URI,
  };
}

export interface CallbackParams {
  code: string;
  state?: string;
}

// Accepts either the raw authorization code or the full callback URL the operator
// copies out of the browser address bar (e.g. http://127.0.0.1:1455/auth/callback?code=...&state=...).
export function parseCallbackInput(raw: string): CallbackParams {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("authorization code or callback URL is required");
  }
  const query = extractQueryString(trimmed);
  if (query !== undefined) {
    const params = new URLSearchParams(query);
    const error = stringValue(params.get("error"));
    if (error) {
      const description = stringValue(params.get("error_description"));
      throw new Error(description ? `${error}: ${description}` : `authorization failed: ${error}`);
    }
    const code = stringValue(params.get("code"));
    if (code) {
      return { code, state: stringValue(params.get("state")) };
    }
  }
  if (trimmed.includes("://") || trimmed.includes("?") || trimmed.includes("&")) {
    throw new Error("callback URL did not include an authorization code");
  }
  return { code: trimmed };
}

function extractQueryString(value: string): string | undefined {
  const queryIndex = value.indexOf("?");
  if (queryIndex >= 0) {
    const fragmentIndex = value.indexOf("#", queryIndex);
    return fragmentIndex >= 0 ? value.slice(queryIndex + 1, fragmentIndex) : value.slice(queryIndex + 1);
  }
  return undefined;
}

export async function completeCodexOAuth(input: CodexOAuthCompleteInput): Promise<CodexOAuthResult> {
  const verifier = stringValue(input.codeVerifier);
  if (!verifier) {
    throw new Error("code_verifier is required; restart the OAuth login");
  }
  const callbackSource = stringValue(input.code) ?? stringValue(input.redirectUrl);
  if (!callbackSource) {
    throw new Error("authorization code or callback URL is required");
  }
  const callback = parseCallbackInput(callbackSource);
  const expectedState = stringValue(input.expectedState);
  if (expectedState && callback.state && callback.state !== expectedState) {
    throw new Error("OAuth state mismatch; restart the OAuth login");
  }
  const token = await exchangeCode(callback.code, verifier);
  return toResult(token);
}

async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      redirect_uri: CODEX_REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`token exchange failed with HTTP ${response.status}: ${truncate(body)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("token exchange response was not valid JSON");
  }
  if (!isRecord(value) || typeof value.access_token !== "string") {
    throw new Error("token exchange response did not include access_token");
  }
  const refreshToken = stringValue(value.refresh_token);
  if (!refreshToken) {
    throw new Error("token exchange response did not include refresh_token");
  }
  return {
    access_token: value.access_token,
    refresh_token: refreshToken,
    id_token: stringValue(value.id_token),
    token_type: stringValue(value.token_type),
    expires_in: numberValue(value.expires_in),
  };
}

function toResult(token: TokenResponse): CodexOAuthResult {
  const identity = parseJwtIdentity(token.id_token);
  const now = Date.now();
  const expiresAt =
    token.expires_in !== undefined
      ? new Date(now + token.expires_in * 1000).toISOString()
      : identity.expiresAt;
  return {
    credential: {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      id_token: token.id_token,
      account_id: identity.accountId,
      email: identity.email,
      expired: expiresAt,
      last_refresh: new Date(now).toISOString(),
      type: "codex",
    },
    accountId: identity.accountId,
    email: identity.email,
    expiresAt,
  };
}

function truncate(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact;
}
