import { codexBaseURL, userAgent, type AppEnv } from "./env.js";
import type { RateLimitSnapshot, RateLimitWindowSnapshot, SelectedCredential } from "./types.js";
import { booleanValue, isRecord, normalizeErrorMessage, numberValue, stringValue } from "./utils.js";

const USAGE_LIMIT_REACHED_MESSAGE = "the usage limit has been reached";

export function isUsageLimitReachedMessage(message: string | undefined): boolean {
  return message?.toLowerCase().includes(USAGE_LIMIT_REACHED_MESSAGE) === true;
}

export async function fetchCredentialRateLimits(
  env: AppEnv,
  credential: SelectedCredential,
): Promise<RateLimitSnapshot[]> {
  const url = rateLimitUsageUrl(env);
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${credential.token}`);
  headers.set("User-Agent", userAgent(env));
  if (credential.accountId) {
    headers.set("ChatGPT-Account-Id", credential.accountId);
  }
  const response = await fetch(url, { method: "GET", headers });
  const headerSnapshots = parseRateLimitHeaders(response.headers);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`rate limit fetch failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  let payloadSnapshots: RateLimitSnapshot[] = [];
  if (body.trim() !== "") {
    try {
      payloadSnapshots = parseRateLimitPayload(JSON.parse(body));
    } catch (error) {
      if (headerSnapshots.length === 0) {
        throw new Error(`rate limit response was not valid JSON: ${normalizeErrorMessage(error)}`);
      }
    }
  }

  const merged = mergeRateLimitSnapshots(payloadSnapshots, headerSnapshots);
  if (merged.length === 0) {
    throw new Error("rate limit response did not include usable limit data");
  }
  return merged;
}

export function parseRateLimitPayload(value: unknown): RateLimitSnapshot[] {
  if (!isRecord(value)) {
    return [];
  }
  const planType = stringValue(value.plan_type);
  const rateLimitReachedType = parseRateLimitReachedType(value.rate_limit_reached_type);
  const snapshots: RateLimitSnapshot[] = [
    compactSnapshot({
      limitId: "codex",
      primary: parsePayloadWindow(isRecord(value.rate_limit) ? value.rate_limit.primary_window : undefined),
      secondary: parsePayloadWindow(isRecord(value.rate_limit) ? value.rate_limit.secondary_window : undefined),
      credits: parsePayloadCredits(value.credits),
      planType,
      rateLimitReachedType,
    }),
  ].filter((item): item is RateLimitSnapshot => item !== undefined);

  const additional = Array.isArray(value.additional_rate_limits) ? value.additional_rate_limits : [];
  for (const item of additional) {
    if (!isRecord(item)) {
      continue;
    }
    const limitId = normalizeLimitId(stringValue(item.metered_feature) ?? stringValue(item.limit_name) ?? "codex");
    const snapshot = compactSnapshot({
      limitId,
      limitName: stringValue(item.limit_name),
      primary: parsePayloadWindow(isRecord(item.rate_limit) ? item.rate_limit.primary_window : undefined),
      secondary: parsePayloadWindow(isRecord(item.rate_limit) ? item.rate_limit.secondary_window : undefined),
      planType,
    });
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot[] {
  const snapshots: RateLimitSnapshot[] = [];
  const defaultSnapshot = parseHeaderSnapshot(headers, "codex");
  if (defaultSnapshot) {
    snapshots.push(defaultSnapshot);
  }

  const limitIds = new Set<string>();
  for (const name of headers.keys()) {
    const lowerName = name.toLowerCase();
    const suffix = "-primary-used-percent";
    if (!lowerName.startsWith("x-") || !lowerName.endsWith(suffix)) {
      continue;
    }
    const limitId = normalizeLimitId(lowerName.slice(2, -suffix.length));
    if (limitId !== "codex") {
      limitIds.add(limitId);
    }
  }
  for (const limitId of [...limitIds].sort()) {
    const snapshot = parseHeaderSnapshot(headers, limitId);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

export function normalizeRateLimitSnapshots(value: unknown): RateLimitSnapshot[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const snapshots: RateLimitSnapshot[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const limitId = stringValue(item.limitId);
    if (!limitId) {
      continue;
    }
    const snapshot = compactSnapshot({
      limitId: normalizeLimitId(limitId),
      limitName: stringValue(item.limitName),
      primary: parseStoredWindow(item.primary),
      secondary: parseStoredWindow(item.secondary),
      credits: parseStoredCredits(item.credits),
      planType: stringValue(item.planType),
      rateLimitReachedType: stringValue(item.rateLimitReachedType),
    });
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots.length > 0 ? snapshots : undefined;
}

export function nextResetMillisFromRateLimits(
  snapshots: RateLimitSnapshot[] | undefined,
  nowMs = Date.now(),
): number | undefined {
  const windows = rateLimitWindows(snapshots).filter(
    (window) => window.resetAt !== undefined && window.resetAt * 1000 > nowMs,
  );
  const exhausted = windows.filter((window) => window.usedPercent >= 100);
  const candidates = exhausted.length > 0 ? exhausted : windows;
  if (candidates.length === 0) {
    return undefined;
  }
  return Math.max(...candidates.map((window) => window.resetAt ?? 0)) * 1000;
}

function rateLimitUsageUrl(env: AppEnv): string {
  const base = codexBaseURL(env);
  const url = new URL(base);
  const backendApiIndex = url.pathname.indexOf("/backend-api");
  if (backendApiIndex >= 0) {
    const prefix = url.pathname.slice(0, backendApiIndex);
    url.pathname = `${prefix}/backend-api/wham/usage`.replace(/\/{2,}/g, "/");
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return `${base.replace(/\/+$/, "")}/api/codex/usage`;
}

function parsePayloadWindow(value: unknown): RateLimitWindowSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usedPercent = numberValue(value.used_percent);
  if (usedPercent === undefined) {
    return undefined;
  }
  const limitWindowSeconds = numberValue(value.limit_window_seconds);
  const resetAt = numberValue(value.reset_at);
  return compactWindow({
    usedPercent,
    windowMinutes:
      limitWindowSeconds !== undefined && limitWindowSeconds > 0 ? Math.ceil(limitWindowSeconds / 60) : undefined,
    resetAt: resetAt !== undefined && resetAt > 0 ? Math.trunc(resetAt) : undefined,
  });
}

function parsePayloadCredits(value: unknown): RateLimitSnapshot["credits"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const hasCredits = booleanValue(value.has_credits);
  const unlimited = booleanValue(value.unlimited);
  if (hasCredits === undefined || unlimited === undefined) {
    return undefined;
  }
  return {
    hasCredits,
    unlimited,
    balance: stringValue(value.balance),
  };
}

function parseRateLimitReachedType(value: unknown): string | undefined {
  if (typeof value === "string") {
    return stringValue(value);
  }
  if (isRecord(value)) {
    return stringValue(value.type);
  }
  return undefined;
}

function parseHeaderSnapshot(headers: Headers, limitId: string): RateLimitSnapshot | undefined {
  const headerLimitId = limitId.replaceAll("_", "-");
  const prefix = `x-${headerLimitId}`;
  return compactSnapshot({
    limitId,
    limitName: stringValue(headers.get(`${prefix}-limit-name`)),
    primary: parseHeaderWindow(headers, `${prefix}-primary`),
    secondary: parseHeaderWindow(headers, `${prefix}-secondary`),
    credits: parseHeaderCredits(headers),
  });
}

function parseHeaderWindow(headers: Headers, prefix: string): RateLimitWindowSnapshot | undefined {
  const usedPercent = numberValue(headers.get(`${prefix}-used-percent`));
  if (usedPercent === undefined) {
    return undefined;
  }
  const windowMinutes = numberValue(headers.get(`${prefix}-window-minutes`));
  const resetAt = numberValue(headers.get(`${prefix}-reset-at`));
  return compactWindow({
    usedPercent,
    windowMinutes: windowMinutes !== undefined && windowMinutes > 0 ? Math.trunc(windowMinutes) : undefined,
    resetAt: resetAt !== undefined && resetAt > 0 ? Math.trunc(resetAt) : undefined,
  });
}

function parseHeaderCredits(headers: Headers): RateLimitSnapshot["credits"] {
  const hasCredits = booleanValue(headers.get("x-codex-credits-has-credits"));
  const unlimited = booleanValue(headers.get("x-codex-credits-unlimited"));
  if (hasCredits === undefined || unlimited === undefined) {
    return undefined;
  }
  return {
    hasCredits,
    unlimited,
    balance: stringValue(headers.get("x-codex-credits-balance")),
  };
}

function parseStoredWindow(value: unknown): RateLimitWindowSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usedPercent = numberValue(value.usedPercent);
  if (usedPercent === undefined) {
    return undefined;
  }
  return compactWindow({
    usedPercent,
    windowMinutes: numberValue(value.windowMinutes),
    resetAt: numberValue(value.resetAt),
  });
}

function parseStoredCredits(value: unknown): RateLimitSnapshot["credits"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const hasCredits = booleanValue(value.hasCredits);
  const unlimited = booleanValue(value.unlimited);
  if (hasCredits === undefined || unlimited === undefined) {
    return undefined;
  }
  return {
    hasCredits,
    unlimited,
    balance: stringValue(value.balance),
  };
}

function compactSnapshot(input: {
  limitId: string;
  limitName?: string;
  primary?: RateLimitWindowSnapshot;
  secondary?: RateLimitWindowSnapshot;
  credits?: RateLimitSnapshot["credits"];
  planType?: string;
  rateLimitReachedType?: string;
}): RateLimitSnapshot | undefined {
  const snapshot: RateLimitSnapshot = { limitId: normalizeLimitId(input.limitId) };
  if (input.limitName) {
    snapshot.limitName = input.limitName;
  }
  if (input.primary) {
    snapshot.primary = input.primary;
  }
  if (input.secondary) {
    snapshot.secondary = input.secondary;
  }
  if (input.credits) {
    snapshot.credits = input.credits;
  }
  if (input.planType) {
    snapshot.planType = input.planType;
  }
  if (input.rateLimitReachedType) {
    snapshot.rateLimitReachedType = input.rateLimitReachedType;
  }
  return hasRateLimitData(snapshot) ? snapshot : undefined;
}

function compactWindow(input: RateLimitWindowSnapshot): RateLimitWindowSnapshot | undefined {
  if (!Number.isFinite(input.usedPercent)) {
    return undefined;
  }
  const window: RateLimitWindowSnapshot = { usedPercent: input.usedPercent };
  if (input.windowMinutes !== undefined && Number.isFinite(input.windowMinutes) && input.windowMinutes > 0) {
    window.windowMinutes = Math.trunc(input.windowMinutes);
  }
  if (input.resetAt !== undefined && Number.isFinite(input.resetAt) && input.resetAt > 0) {
    window.resetAt = Math.trunc(input.resetAt);
  }
  return window;
}

function mergeRateLimitSnapshots(
  payloadSnapshots: RateLimitSnapshot[],
  headerSnapshots: RateLimitSnapshot[],
): RateLimitSnapshot[] {
  const byLimitId = new Map<string, RateLimitSnapshot>();
  for (const snapshot of headerSnapshots) {
    byLimitId.set(snapshot.limitId, snapshot);
  }
  for (const snapshot of payloadSnapshots) {
    const existing = byLimitId.get(snapshot.limitId);
    byLimitId.set(snapshot.limitId, {
      ...existing,
      ...snapshot,
      primary: snapshot.primary ?? existing?.primary,
      secondary: snapshot.secondary ?? existing?.secondary,
      credits: snapshot.credits ?? existing?.credits,
    });
  }
  return [...byLimitId.values()].filter(hasRateLimitData);
}

function rateLimitWindows(snapshots: RateLimitSnapshot[] | undefined): RateLimitWindowSnapshot[] {
  if (!snapshots) {
    return [];
  }
  const windows: RateLimitWindowSnapshot[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.primary) {
      windows.push(snapshot.primary);
    }
    if (snapshot.secondary) {
      windows.push(snapshot.secondary);
    }
  }
  return windows;
}

function hasRateLimitData(snapshot: RateLimitSnapshot): boolean {
  return (
    snapshot.primary !== undefined ||
    snapshot.secondary !== undefined ||
    snapshot.credits !== undefined ||
    snapshot.planType !== undefined ||
    snapshot.rateLimitReachedType !== undefined
  );
}

function normalizeLimitId(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}
