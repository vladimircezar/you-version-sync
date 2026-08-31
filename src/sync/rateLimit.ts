/**
 * Rate limiting and retry policy.
 *
 * YouVersion does not publish a numeric rate limit, so the defaults here are
 * deliberately conservative: a minimum gap between requests plus full-jitter
 * exponential backoff, and unconditional obedience to `Retry-After` on 429.
 * See docs/api-research.md ("Rate limits").
 */

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Minimum spacing between two outbound requests. */
  minIntervalMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  minIntervalMs: 120,
};

/** Full-jitter backoff (AWS "Exponential Backoff and Jitter"): random in [0, exp]. */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(random() * exponential);
}

/**
 * Parse `Retry-After`, which may be delta-seconds or an HTTP-date.
 * Returns milliseconds, or `null` when absent/unparseable.
 */
export function parseRetryAfter(
  value: string | undefined | null,
  now: number = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Retry only what can plausibly succeed on a second attempt. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 425 || (status >= 500 && status < 600);
}

/** Serialises requests so no two are issued closer than `minIntervalMs` apart. */
export class Throttle {
  private next = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(): Promise<void> {
    const current = this.now();
    const waitFor = Math.max(0, this.next - current);
    this.next = Math.max(current, this.next) + this.minIntervalMs;
    if (waitFor > 0) await this.sleep(waitFor);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Thrown when the user cancels a sync. Callers treat this as "stop cleanly". */
export class CancelledError extends Error {
  constructor() {
    super("Sync cancelled.");
    this.name = "CancelledError";
  }
}
