/**
 * The single outbound HTTP path for the plugin.
 *
 * Every request goes through `ResilientHttp`, which applies throttling, bounded
 * retries with jitter, `Retry-After` handling and cancellation. The transport
 * itself is injected so tests can drive the same logic against mocked
 * responses, and so production can use Obsidian's `requestUrl` (which is not
 * subject to the renderer's CORS rules).
 */
import {
  backoffDelay,
  CancelledError,
  DEFAULT_RETRY_POLICY,
  isRetryableStatus,
  parseRetryAfter,
  RetryPolicy,
  sleep,
  Throttle,
} from "./rateLimit";
import { redactError, redactUrl } from "../security/redact";

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** Minimal transport contract. Implemented over `requestUrl` in production. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * A non-2xx response that survived the retry policy. Carries the status so the
 * caller can branch (401 → refresh, 403 → permission not granted), and a
 * pre-redacted message safe to show or log.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly safeMessage: string,
    readonly url: string,
    /** Milliseconds the server asked us to wait, when it said so. */
    readonly retryAfterMs?: number,
  ) {
    super(safeMessage);
    this.name = "HttpError";
  }
}

export interface ResilientHttpOptions {
  transport: Transport;
  policy?: RetryPolicy;
  /** Injected for deterministic tests. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Invoked once per completed attempt, for diagnostics. Never receives bodies. */
  onAttempt?: (info: { url: string; status: number | null; attempt: number }) => void;
}

export class ResilientHttp {
  private readonly policy: RetryPolicy;
  private readonly throttle: Throttle;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: ResilientHttpOptions) {
    this.policy = options.policy ?? DEFAULT_RETRY_POLICY;
    this.sleepFn = options.sleepFn ?? sleep;
    this.random = options.random ?? Math.random;
    this.throttle = new Throttle(this.policy.minIntervalMs, (ms) => this.sleepFn(ms));
  }

  async send(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    let lastError: HttpError | null = null;

    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt++) {
      if (signal?.aborted) throw new CancelledError();
      await this.throttle.acquire();
      if (signal?.aborted) throw new CancelledError();

      let response: HttpResponse;
      try {
        response = await this.options.transport(req);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        // Transport-level failure (offline, DNS, TLS). Retryable.
        this.options.onAttempt?.({ url: redactUrl(req.url), status: null, attempt });
        lastError = new HttpError(0, redactError(err), redactUrl(req.url));
        if (attempt === this.policy.maxAttempts) break;
        await this.sleepFn(backoffDelay(attempt, this.policy, this.random), signal);
        continue;
      }

      this.options.onAttempt?.({ url: redactUrl(req.url), status: response.status, attempt });

      if (response.status >= 200 && response.status < 300) return response;

      lastError = new HttpError(
        response.status,
        describeStatus(response.status, response.text),
        redactUrl(req.url),
        parseRetryAfter(headerOf(response.headers, "retry-after")) ?? undefined,
      );

      if (!isRetryableStatus(response.status) || attempt === this.policy.maxAttempts) break;

      // Honour Retry-After when present; otherwise fall back to jittered backoff.
      const retryAfter = parseRetryAfter(headerOf(response.headers, "retry-after"));
      const delay = retryAfter ?? backoffDelay(attempt, this.policy, this.random);
      await this.sleepFn(Math.min(delay, this.policy.maxDelayMs), signal);
    }

    throw lastError ?? new HttpError(0, "Request failed.", redactUrl(req.url));
  }
}

export function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === target) return v;
  return undefined;
}

/**
 * A short, non-leaking description of a failure. The response body is *not*
 * echoed verbatim: it can contain account-identifying detail.
 */
function describeStatus(status: number, body: string): string {
  let apiMessage: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "message" in parsed) {
      const m = (parsed as { message?: unknown }).message;
      if (typeof m === "string" && m.length <= 200) apiMessage = m;
    }
  } catch {
    // Non-JSON body; ignore it entirely rather than risk echoing HTML/PII.
  }

  const base =
    status === 401
      ? "Not authorized (401). The access token is missing, expired or invalid."
      : status === 403
        ? "Forbidden (403). The required permission may not have been granted."
        : status === 429
          ? "Rate limited (429) by the YouVersion API."
          : status >= 500
            ? `YouVersion API server error (${status}).`
            : `Request failed with HTTP ${status}.`;

  return apiMessage ? `${base} ${apiMessage}` : base;
}
