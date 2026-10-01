import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchWithTransientRetry,
  retryAfterDelayMs,
  transientBackoffMs,
  UpstreamTransportError,
} from "../src/codex-retry.js";

function scripted(steps: Array<number | Error>, headers: Record<string, string> = {}) {
  let calls = 0;
  const send = async (): Promise<Response> => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (step instanceof Error) {
      throw step;
    }
    return new Response(`status ${step}`, { status: step, headers });
  };
  return { send, calls: () => calls };
}

function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

test("backoff doubles from 200ms with ±10% jitter, like codex", () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((retry) => transientBackoffMs(retry, () => 0.5)),
    [200, 400, 800, 1600],
  );
  assert.equal(transientBackoffMs(1, () => 0), 180);
  assert.equal(transientBackoffMs(1, () => 1), 220);
});

test("retry-after accepts seconds and HTTP dates", () => {
  assert.equal(retryAfterDelayMs("1.5"), 1500);
  assert.equal(retryAfterDelayMs(null), undefined);
  assert.equal(retryAfterDelayMs("soon"), undefined);
  const delay = retryAfterDelayMs(new Date(Date.now() + 3000).toUTCString());
  assert.ok(delay !== undefined && delay > 1000 && delay <= 3000);
});

test("5xx replies are retried on the same account until one succeeds", async () => {
  const upstream = scripted([502, 503, 200]);
  const { delays, sleep } = recordingSleep();
  const response = await fetchWithTransientRetry(upstream.send, { sleep, random: () => 0.5 });
  assert.equal(response.status, 200);
  assert.equal(upstream.calls(), 3);
  assert.deepEqual(delays, [200, 400]);
});

test("5xx replies give up after 4 retries and return the last reply", async () => {
  const upstream = scripted([500]);
  const { delays, sleep } = recordingSleep();
  const response = await fetchWithTransientRetry(upstream.send, { sleep, random: () => 0.5 });
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "status 500");
  assert.equal(upstream.calls(), 5);
  assert.deepEqual(delays, [200, 400, 800, 1600]);
});

test("4xx and 429 replies are not retried", async () => {
  for (const status of [400, 401, 403, 404, 429]) {
    const upstream = scripted([status, 200]);
    const { delays, sleep } = recordingSleep();
    const response = await fetchWithTransientRetry(upstream.send, { sleep });
    assert.equal(response.status, status);
    assert.equal(upstream.calls(), 1);
    assert.deepEqual(delays, []);
  }
});

test("a short Retry-After replaces the backoff; a long one hands off to rotation", async () => {
  const short = scripted([503, 200], { "retry-after": "1" });
  const shortSleep = recordingSleep();
  assert.equal((await fetchWithTransientRetry(short.send, { sleep: shortSleep.sleep })).status, 200);
  assert.deepEqual(shortSleep.delays, [1000]);

  const long = scripted([503, 200], { "retry-after": "30" });
  const longSleep = recordingSleep();
  assert.equal((await fetchWithTransientRetry(long.send, { sleep: longSleep.sleep })).status, 503);
  assert.equal(long.calls(), 1);
  assert.deepEqual(longSleep.delays, []);
});

test("transport errors are retried, then surface as UpstreamTransportError", async () => {
  const recovered = scripted([new TypeError("fetch failed"), 200]);
  const { sleep } = recordingSleep();
  assert.equal((await fetchWithTransientRetry(recovered.send, { sleep })).status, 200);
  assert.equal(recovered.calls(), 2);

  const down = scripted([new TypeError("fetch failed")]);
  await assert.rejects(fetchWithTransientRetry(down.send, { sleep }), (error: unknown) => {
    assert.ok(error instanceof UpstreamTransportError);
    assert.equal(error.attempts, 5);
    assert.match(error.message, /fetch failed/);
    return true;
  });
  assert.equal(down.calls(), 5);
});
