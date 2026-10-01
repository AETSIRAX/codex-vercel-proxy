import assert from "node:assert/strict";
import test from "node:test";

import { parseJwtExpiration } from "../src/jwt.js";
import {
  accessTokenExpiresAt,
  applyTokenRefresh,
  DEFAULT_REFRESH_LEAD_SECONDS,
  parseTokenRefreshResponse,
  shouldRefreshCredential,
} from "../src/token-refresh.js";
import type { PrivateCredential } from "../src/types.js";
import { base64UrlEncode, textToBytes } from "../src/utils.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const LEAD_MS = DEFAULT_REFRESH_LEAD_SECONDS * 1000;

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => base64UrlEncode(textToBytes(JSON.stringify(value)));
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function tokenExpiringAt(millis: number): string {
  return jwt({ exp: Math.floor(millis / 1000) });
}

function credential(overrides: PrivateCredential): PrivateCredential {
  return { refreshToken: "rt-old", ...overrides };
}

test("default refresh lead matches Codex's 5 minute window", () => {
  assert.equal(DEFAULT_REFRESH_LEAD_SECONDS, 5 * 60);
});

test("parseJwtExpiration reads exp and ignores malformed tokens", () => {
  assert.equal(parseJwtExpiration(tokenExpiringAt(NOW)), new Date(NOW).toISOString());
  assert.equal(parseJwtExpiration(jwt({})), undefined);
  assert.equal(parseJwtExpiration("opaque-token"), undefined);
  assert.equal(parseJwtExpiration(undefined), undefined);
});

test("expiry comes from the access token, not the id_token or a stale stored value", () => {
  const accessExp = NOW + 10 * DAY;
  const cred = credential({
    accessToken: tokenExpiringAt(accessExp),
    idToken: tokenExpiringAt(NOW - DAY),
    expiresAt: new Date(NOW - DAY).toISOString(),
  });
  assert.equal(accessTokenExpiresAt(cred), accessExp);
  assert.equal(shouldRefreshCredential(cred, { now: NOW, leadMs: LEAD_MS }), false);
});

test("refreshes only inside the 5 minute window before access token exp", () => {
  const policy = { now: NOW, leadMs: LEAD_MS };
  const at = (millis: number) => credential({ accessToken: tokenExpiringAt(millis) });
  assert.equal(shouldRefreshCredential(at(NOW + 6 * MINUTE), policy), false);
  assert.equal(shouldRefreshCredential(at(NOW + 4 * MINUTE), policy), true);
  assert.equal(shouldRefreshCredential(at(NOW - MINUTE), policy), true);
});

test("min interval suppresses early refresh but never an expired token", () => {
  const lastRefresh = new Date(NOW - MINUTE).toISOString();
  const policy = { now: NOW, leadMs: LEAD_MS, minIntervalMs: 5 * MINUTE };
  const nearExpiry = credential({ accessToken: tokenExpiringAt(NOW + 2 * MINUTE), lastRefresh });
  const expired = credential({ accessToken: tokenExpiringAt(NOW - MINUTE), lastRefresh });
  assert.equal(shouldRefreshCredential(nearExpiry, policy), false);
  assert.equal(shouldRefreshCredential(expired, policy), true);
});

test("without an access token exp, falls back to an 8 day cadence from last_refresh", () => {
  const policy = { now: NOW, leadMs: LEAD_MS };
  const opaque = (lastRefresh?: number) =>
    credential({
      accessToken: "opaque",
      lastRefresh: lastRefresh === undefined ? undefined : new Date(lastRefresh).toISOString(),
    });
  assert.equal(shouldRefreshCredential(opaque(NOW - 7 * DAY), policy), false);
  assert.equal(shouldRefreshCredential(opaque(NOW - 8 * DAY - MINUTE), policy), true);
  assert.equal(shouldRefreshCredential(opaque(undefined), policy), false);
});

test("stored expiresAt still applies to opaque access tokens", () => {
  const cred = credential({ accessToken: "opaque", expiresAt: new Date(NOW + 2 * MINUTE).toISOString() });
  assert.equal(shouldRefreshCredential(cred, { now: NOW, leadMs: LEAD_MS }), true);
});

test("missing access token refreshes, missing refresh token never does", () => {
  const policy = { now: NOW, leadMs: LEAD_MS };
  assert.equal(shouldRefreshCredential(credential({}), policy), true);
  assert.equal(shouldRefreshCredential({ accessToken: tokenExpiringAt(NOW - DAY) }, policy), false);
});

test("refresh response without refresh_token keeps the stored refresh token", () => {
  const accessToken = tokenExpiringAt(NOW + 10 * DAY);
  const refreshed = parseTokenRefreshResponse(JSON.stringify({ access_token: accessToken }));
  assert.equal(refreshed.refresh_token, undefined);
  const next = applyTokenRefresh(credential({ accessToken: "old", idToken: "id-old" }), refreshed, NOW);
  assert.equal(next.accessToken, accessToken);
  assert.equal(next.refreshToken, "rt-old");
  assert.equal(next.idToken, "id-old");
  assert.equal(next.expiresAt, new Date(NOW + 10 * DAY).toISOString());
  assert.equal(next.lastRefresh, new Date(NOW).toISOString());
});

test("refresh response rotates the refresh token when one is returned", () => {
  const refreshed = parseTokenRefreshResponse(
    JSON.stringify({ access_token: "opaque", refresh_token: "rt-new", expires_in: 3600 }),
  );
  const next = applyTokenRefresh(credential({}), refreshed, NOW);
  assert.equal(next.refreshToken, "rt-new");
  assert.equal(next.expiresAt, new Date(NOW + 3600 * 1000).toISOString());
});

test("refreshed expiry ignores the id_token exp", () => {
  const refreshed = parseTokenRefreshResponse(
    JSON.stringify({
      access_token: tokenExpiringAt(NOW + 10 * DAY),
      id_token: jwt({ exp: Math.floor((NOW + 3600 * 1000) / 1000), email: "a@example.com" }),
    }),
  );
  const next = applyTokenRefresh(credential({}), refreshed, NOW);
  assert.equal(next.expiresAt, new Date(NOW + 10 * DAY).toISOString());
  assert.equal(next.email, "a@example.com");
});

test("refresh response still requires access_token", () => {
  assert.throws(() => parseTokenRefreshResponse(JSON.stringify({ refresh_token: "rt" })), /access_token/);
});
