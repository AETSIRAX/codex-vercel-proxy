import { parseJwtExpiration, parseJwtIdentity } from "./jwt.js";
import type { PrivateCredential, TokenRefreshResponse } from "./types.js";
import { isRecord, numberValue, parseTime, stringValue } from "./utils.js";

// Matches Codex: refresh once the access token is within 5 minutes of `exp`,
// and fall back to an 8-day cadence when the access token carries no `exp`.
export const DEFAULT_REFRESH_LEAD_SECONDS = 5 * 60;
export const REFRESH_INTERVAL_WITHOUT_EXPIRY_MS = 8 * 24 * 60 * 60 * 1000;

export interface RefreshPolicy {
  now: number;
  leadMs: number;
  // Skip a not-yet-expired token refreshed less than this long ago.
  minIntervalMs?: number;
}

// Effective expiry of the access token. The token's own `exp` wins; the stored
// value (from `expires_in` or an import) only covers opaque tokens.
export function accessTokenExpiresAt(credential: PrivateCredential): number | undefined {
  return parseTime(parseJwtExpiration(credential.accessToken)) ?? parseTime(credential.expiresAt);
}

export function shouldRefreshCredential(credential: PrivateCredential, policy: RefreshPolicy): boolean {
  if (!credential.refreshToken) {
    return false;
  }
  if (!credential.accessToken) {
    return true;
  }
  const { now } = policy;
  const lastRefresh = parseTime(credential.lastRefresh);
  const expiresAt = accessTokenExpiresAt(credential);
  if (expiresAt === undefined) {
    return lastRefresh !== undefined && now - lastRefresh >= REFRESH_INTERVAL_WITHOUT_EXPIRY_MS;
  }
  if (expiresAt <= now) {
    return true;
  }
  if (policy.minIntervalMs !== undefined && lastRefresh !== undefined && now - lastRefresh < policy.minIntervalMs) {
    return false;
  }
  return expiresAt - now <= policy.leadMs;
}

export function parseTokenRefreshResponse(body: string): TokenRefreshResponse {
  const value: unknown = JSON.parse(body);
  if (!isRecord(value) || typeof value.access_token !== "string") {
    throw new Error("token refresh response did not include access_token");
  }
  return {
    access_token: value.access_token,
    refresh_token: stringValue(value.refresh_token),
    id_token: stringValue(value.id_token),
    token_type: stringValue(value.token_type),
    expires_in: numberValue(value.expires_in),
  };
}

export function applyTokenRefresh(
  current: PrivateCredential,
  refreshed: TokenRefreshResponse,
  refreshedAt: number,
): PrivateCredential {
  const identity = parseJwtIdentity(refreshed.id_token);
  return {
    ...current,
    accessToken: refreshed.access_token,
    // Codex keeps the stored refresh token when the response omits a new one.
    refreshToken: refreshed.refresh_token ?? current.refreshToken,
    idToken: refreshed.id_token ?? current.idToken,
    tokenType: refreshed.token_type ?? current.tokenType,
    accountId: identity.accountId ?? current.accountId,
    email: identity.email ?? current.email,
    planType: identity.planType ?? current.planType,
    userId: identity.userId ?? current.userId,
    fedramp: identity.fedramp ?? current.fedramp,
    expiresAt: tokenExpiresAt(refreshed.access_token, refreshed.expires_in, refreshedAt),
    lastRefresh: new Date(refreshedAt).toISOString(),
  };
}

export function tokenExpiresAt(
  accessToken: string,
  expiresIn: number | undefined,
  issuedAt: number,
): string | undefined {
  return (
    parseJwtExpiration(accessToken) ??
    (expiresIn !== undefined ? new Date(issuedAt + expiresIn * 1000).toISOString() : undefined)
  );
}
