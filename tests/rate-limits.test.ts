import assert from "node:assert/strict";
import test from "node:test";

import { nextResetMillisFromRateLimits } from "../src/rate-limits.js";
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
