import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  parseCallbackInput,
  startCodexOAuth,
} from "../src/codex-oauth.js";
import { base64UrlEncode, textToBytes } from "../src/utils.js";

test("code verifier is 128 url-safe base64 characters", () => {
  const verifier = generateCodeVerifier();
  assert.equal(verifier.length, 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test("code challenge is the url-safe base64 SHA-256 of the verifier", async () => {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const digest = await crypto.subtle.digest("SHA-256", textToBytes(verifier));
  assert.equal(challenge, base64UrlEncode(new Uint8Array(digest)));
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge.includes("="), false);
});

test("auth url carries the codex oauth parameters", () => {
  const url = new URL(buildAuthUrl("state-123", "challenge-abc"));
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  const params = url.searchParams;
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(params.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(
    params.get("scope"),
    "openid profile email offline_access api.connectors.read api.connectors.invoke",
  );
  assert.equal(params.get("state"), "state-123");
  assert.equal(params.get("code_challenge"), "challenge-abc");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("prompt"), "login");
  assert.equal(params.get("id_token_add_organizations"), "true");
  assert.equal(params.get("codex_cli_simplified_flow"), "true");
  assert.equal(params.get("originator"), "codex_cli_rs");
});

test("startCodexOAuth returns a consistent verifier/challenge pair", async () => {
  const start = await startCodexOAuth();
  assert.equal(start.redirectUri, "http://127.0.0.1:1455/auth/callback");
  const url = new URL(start.authUrl);
  assert.equal(url.searchParams.get("state"), start.state);
  assert.equal(url.searchParams.get("code_challenge"), await generateCodeChallenge(start.codeVerifier));
});

test("state values are unique and url-safe", () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("parseCallbackInput extracts code and state from a full callback URL", () => {
  const parsed = parseCallbackInput("http://127.0.0.1:1455/auth/callback?code=abc123&state=xyz");
  assert.equal(parsed.code, "abc123");
  assert.equal(parsed.state, "xyz");
});

test("parseCallbackInput accepts a bare authorization code", () => {
  const parsed = parseCallbackInput("  rawcode  ");
  assert.equal(parsed.code, "rawcode");
  assert.equal(parsed.state, undefined);
});

test("parseCallbackInput surfaces OAuth errors from the callback URL", () => {
  assert.throws(
    () => parseCallbackInput("http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=nope"),
    /access_denied: nope/,
  );
});

test("parseCallbackInput rejects a URL without a code", () => {
  assert.throws(
    () => parseCallbackInput("http://127.0.0.1:1455/auth/callback?state=only"),
    /did not include an authorization code/,
  );
});

test("parseCallbackInput rejects empty input", () => {
  assert.throws(() => parseCallbackInput("   "), /required/);
});
