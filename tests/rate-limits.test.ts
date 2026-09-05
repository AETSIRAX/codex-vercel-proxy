import assert from "node:assert/strict";
import test from "node:test";

import { nextResetMillisFromRateLimits, parseRateLimitHeaders, parseRateLimitPayload } from "../src/rate-limits.js";
import type { RateLimitSnapshot } from "../src/types.js";

const nowMs = 1_700_000_000_000;
const futureReset = Math.floor(nowMs / 1000) + 3_600;
const laterReset = Math.floor(nowMs / 1000) + 86_400;
const pastReset = Math.floor(nowMs / 1000) - 60;

test("does not cool down at exactly 10 percent remaining", () => {
  const snapshots: RateLimitSnapshot[] = [
    {
      limitId: "codex",
      primary: {
        usedPercent: 90,
        resetAt: futureReset,
      },
    },
  ];

  assert.equal(nextResetMillisFromRateLimits(snapshots, nowMs), undefined);
});

test("cools down when remaining percent is below 10 percent", () => {
  const snapshots: RateLimitSnapshot[] = [
    {
      limitId: "codex",
      primary: {
        usedPercent: 90.1,
        resetAt: futureReset,
      },
    },
  ];

  assert.equal(nextResetMillisFromRateLimits(snapshots, nowMs), futureReset * 1000);
});

test("uses the latest reset when multiple windows are below 10 percent remaining", () => {
  const snapshots: RateLimitSnapshot[] = [
    {
      limitId: "codex",
      primary: {
        usedPercent: 91,
        resetAt: futureReset,
      },
      secondary: {
        usedPercent: 95,
        resetAt: laterReset,
      },
    },
  ];

  assert.equal(nextResetMillisFromRateLimits(snapshots, nowMs), laterReset * 1000);
});

test("considers additional rate limit snapshots", () => {
  const snapshots: RateLimitSnapshot[] = [
    {
      limitId: "codex",
      primary: {
        usedPercent: 20,
        resetAt: futureReset,
      },
    },
    {
      limitId: "codex_weekly",
      secondary: {
        usedPercent: 92,
        resetAt: laterReset,
      },
    },
  ];

  assert.equal(nextResetMillisFromRateLimits(snapshots, nowMs), laterReset * 1000);
});

test("ignores low remaining windows without a future reset", () => {
  const snapshots: RateLimitSnapshot[] = [
    {
      limitId: "missing_reset",
      primary: {
        usedPercent: 95,
      },
    },
    {
      limitId: "past_reset",
      secondary: {
        usedPercent: 95,
        resetAt: pastReset,
      },
    },
  ];

  assert.equal(nextResetMillisFromRateLimits(snapshots, nowMs), undefined);
});

test("payload parsing records spend control state", () => {
  const snapshots = parseRateLimitPayload({
    plan_type: "plus",
    rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: futureReset } },
    spend_control: { reached: true },
  });

  assert.equal(snapshots[0]?.spendControlReached, true);
  assert.equal(snapshots[0]?.planType, "plus");
  assert.equal(snapshots[0]?.primary?.windowMinutes, 300);
});

test("header parsing attaches the reached type to the active limit family", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "40",
    "x-codex-bengalfox-primary-used-percent": "100",
    "x-codex-bengalfox-primary-reset-at": String(futureReset),
    "x-codex-active-limit": "codex_bengalfox",
    "x-codex-rate-limit-reached-type": "rate_limit_reached",
  });
  const snapshots = parseRateLimitHeaders(headers);

  assert.equal(snapshots.find((item) => item.limitId === "codex")?.rateLimitReachedType, undefined);
  assert.equal(snapshots.find((item) => item.limitId === "codex_bengalfox")?.rateLimitReachedType, "rate_limit_reached");
});

test("header parsing ignores an all-zero window family", () => {
  const headers = new Headers({
    "x-codex-primary-used-percent": "0",
    "x-codex-primary-window-minutes": "0",
  });

  assert.deepEqual(parseRateLimitHeaders(headers), []);
});
