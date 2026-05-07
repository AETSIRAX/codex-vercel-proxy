export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface PrivateCredential {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  accountId?: string;
  email?: string;
  expiresAt?: string;
  lastRefresh?: string;
}

export interface CredentialImportResult {
  id: string;
  label: string;
  disabled: boolean;
}

export interface CredentialStatus {
  id: string;
  label: string;
  enabled: boolean;
  status: "available" | "disabled" | "cooldown" | "expired" | "refresh_due" | "invalid";
  accountId?: string;
  email?: string;
  expiresAt?: string;
  lastRefresh?: string;
  nextRetryAt?: string;
  lastError?: string;
  rateLimits?: RateLimitSnapshot[];
  rateLimitsUpdatedAt?: string;
  successCount: number;
  failureCount: number;
  updatedAt: string;
}

export interface SelectedCredential {
  id: string;
  label: string;
  token: string;
  accountId?: string;
}

export interface RefreshSummary {
  checked: number;
  refreshed: number;
  failed: number;
}

export interface CredentialRefreshSummary extends RefreshSummary {
  rateLimits: RefreshSummary;
}

export interface ReportResultInput {
  ok: boolean;
  status: number;
  retryAfterSeconds?: number;
  message?: string;
  rateLimits?: RateLimitSnapshot[];
}

export interface TokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
}

export interface RateLimitWindowSnapshot {
  usedPercent: number;
  windowMinutes?: number;
  resetAt?: number;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface RateLimitSnapshot {
  limitId: string;
  limitName?: string;
  primary?: RateLimitWindowSnapshot;
  secondary?: RateLimitWindowSnapshot;
  credits?: CreditsSnapshot;
  planType?: string;
  rateLimitReachedType?: string;
}
