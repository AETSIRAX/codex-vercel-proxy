// Same-account retry for transient upstream failures, mirroring Codex's request
// retry policy (model-provider-info/src/lib.rs, codex-client/src/retry.rs):
// HTTP 5xx replies and transport errors are retried up to 4 times on the same
// account with 200ms exponential backoff (±10% jitter), honoring Retry-After.
// Only once those retries are spent does the caller cool the credential down
// and rotate, so a brief upstream blip neither cools healthy accounts nor drops
// prompt cache affinity.

export const TRANSIENT_MAX_RETRIES = 4;
const TRANSIENT_BASE_DELAY_MS = 200;
// Retry-After is honored, but capped so a long hint cannot stall the function
// past its time limit; past the cap the caller falls back to rotation.
const TRANSIENT_MAX_RETRY_AFTER_MS = 5_000;

export interface TransientRetryOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Thrown when every attempt failed before any HTTP reply arrived (DNS,
// connection reset, TLS). The account is not at fault, so callers surface it
// as a 502 without cooling the credential down.
export class UpstreamTransportError extends Error {
  readonly attempts: number;

  constructor(cause: unknown, attempts: number) {
    super(`upstream request failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "UpstreamTransportError";
    this.attempts = attempts;
  }
}

export function isTransientStatus(status: number): boolean {
  return status >= 500;
}

export function transientBackoffMs(retry: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, retry - 1);
  const jitter = 0.9 + random() * 0.2;
  return Math.round(TRANSIENT_BASE_DELAY_MS * 2 ** exponent * jitter);
}

export function retryAfterDelayMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

export async function fetchWithTransientRetry(
  send: () => Promise<Response>,
  options: TransientRetryOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? TRANSIENT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let retry = 0; ; retry += 1) {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (retry >= maxRetries) {
        throw new UpstreamTransportError(error, retry + 1);
      }
      await sleep(transientBackoffMs(retry + 1, random));
      continue;
    }
    if (!isTransientStatus(response.status) || retry >= maxRetries) {
      return response;
    }
    const retryAfter = retryAfterDelayMs(response.headers.get("retry-after"));
    if (retryAfter !== undefined && retryAfter > TRANSIENT_MAX_RETRY_AFTER_MS) {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    await sleep(retryAfter ?? transientBackoffMs(retry + 1, random));
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
