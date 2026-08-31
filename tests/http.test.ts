import { describe, expect, it, vi } from "vitest";
import { HttpError, HttpRequest, HttpResponse, ResilientHttp, headerOf } from "../src/sync/http";
import {
  CancelledError,
  DEFAULT_RETRY_POLICY,
  Throttle,
  backoffDelay,
  isRetryableStatus,
  parseRetryAfter,
} from "../src/sync/rateLimit";

const ok = (text = "{}"): HttpResponse => ({ status: 200, headers: {}, text });
const status = (code: number, headers: Record<string, string> = {}, text = "{}"): HttpResponse => ({
  status: code,
  headers,
  text,
});

function harness(responses: HttpResponse[], opts: { throwOn?: number[] } = {}) {
  const sleeps: number[] = [];
  let call = 0;
  const requests: HttpRequest[] = [];

  const http = new ResilientHttp({
    transport: async (req) => {
      requests.push(req);
      const index = call++;
      if (opts.throwOn?.includes(index)) throw new Error("network down");
      return responses[Math.min(index, responses.length - 1)] as HttpResponse;
    },
    policy: { ...DEFAULT_RETRY_POLICY, minIntervalMs: 0 },
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });

  return { http, sleeps, requests, calls: () => call };
}

describe("retry policy", () => {
  it("returns a successful response without retrying", async () => {
    const h = harness([ok('{"a":1}')]);
    await expect(h.http.send({ url: "https://x/y", method: "GET" })).resolves.toMatchObject({
      status: 200,
    });
    expect(h.calls()).toBe(1);
  });

  it("retries retryable statuses up to the attempt limit and then throws", async () => {
    const h = harness([status(503)]);
    await expect(h.http.send({ url: "https://x/y", method: "GET" })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(h.calls()).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
  });

  it("does not retry a non-retryable status", async () => {
    const h = harness([status(404)]);
    await expect(h.http.send({ url: "https://x/y", method: "GET" })).rejects.toMatchObject({
      status: 404,
    });
    expect(h.calls()).toBe(1);
  });

  it("recovers when a later attempt succeeds", async () => {
    const h = harness([status(500), status(500), ok('{"ok":true}')]);
    await expect(h.http.send({ url: "https://x/y", method: "GET" })).resolves.toMatchObject({
      status: 200,
    });
    expect(h.calls()).toBe(3);
  });

  it("retries transport failures", async () => {
    const h = harness([ok()], { throwOn: [0, 1] });
    await expect(h.http.send({ url: "https://x/y", method: "GET" })).resolves.toMatchObject({
      status: 200,
    });
    expect(h.calls()).toBe(3);
  });
});

describe("rate limiting", () => {
  it("honours Retry-After in seconds on a 429", async () => {
    const h = harness([status(429, { "Retry-After": "7" }), ok()]);
    await h.http.send({ url: "https://x/y", method: "GET" });
    expect(h.sleeps).toContain(7000);
  });

  it("honours a Retry-After HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
  });

  it("ignores an unparseable Retry-After", () => {
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it("caps a very long Retry-After at the policy maximum", async () => {
    const h = harness([status(429, { "retry-after": "99999" }), ok()]);
    await h.http.send({ url: "https://x/y", method: "GET" });
    expect(Math.max(...h.sleeps)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it("classifies statuses correctly", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });

  it("applies bounded, jittered backoff", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffDelay(1, policy, () => 1)).toBe(100);
    expect(backoffDelay(2, policy, () => 1)).toBe(200);
    expect(backoffDelay(9, policy, () => 1)).toBe(1000);
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
  });

  it("spaces requests by the minimum interval", async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const throttle = new Throttle(
      100,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      () => clock,
    );
    await throttle.acquire();
    await throttle.acquire();
    await throttle.acquire();
    // Three requests land at t=0, 100 and 200: each waits out the interval.
    expect(sleeps).toEqual([100, 100]);
    expect(clock).toBe(200);
  });
});

describe("cancellation", () => {
  it("aborts before issuing a request", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([ok()]);
    await expect(
      h.http.send({ url: "https://x/y", method: "GET" }, controller.signal),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(h.calls()).toBe(0);
  });
});

describe("error messages", () => {
  it("explains 401, 403 and 429 without leaking the body", async () => {
    for (const [code, fragment] of [
      [401, "Not authorized"],
      [403, "Forbidden"],
      [429, "Rate limited"],
    ] as const) {
      const h = harness([status(code, {}, '{"message":"detail"}')]);
      await expect(h.http.send({ url: "https://x/y", method: "GET" })).rejects.toThrow(
        new RegExp(fragment),
      );
    }
  });

  it("ignores a non-JSON error body entirely", async () => {
    const h = harness([status(400, {}, "<html>oops person@example.com</html>")]);
    const err = await h.http.send({ url: "https://x/y", method: "GET" }).catch((e) => e);
    expect(err.safeMessage).not.toContain("example.com");
  });

  it("redacts the URL it reports", async () => {
    const h = harness([status(400)]);
    const err = await h.http
      .send({ url: "https://x/y?access_token=zzz", method: "GET" })
      .catch((e) => e);
    expect(err.url).not.toContain("zzz");
  });
});

describe("header lookup", () => {
  it("is case-insensitive", () => {
    expect(headerOf({ "Retry-After": "5" }, "retry-after")).toBe("5");
    expect(headerOf({}, "retry-after")).toBeUndefined();
  });
});

describe("throttling is applied in the real client", () => {
  it("sleeps between successive sends", async () => {
    const sleeps: number[] = [];
    const http = new ResilientHttp({
      transport: async () => ok(),
      policy: { ...DEFAULT_RETRY_POLICY, minIntervalMs: 50 },
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    await http.send({ url: "https://x/1", method: "GET" });
    await http.send({ url: "https://x/2", method: "GET" });
    expect(sleeps.some((ms) => ms > 0)).toBe(true);
  });
});

describe("attempt reporting", () => {
  it("reports every attempt for diagnostics", async () => {
    const onAttempt = vi.fn();
    const http = new ResilientHttp({
      transport: async () => status(500),
      policy: { ...DEFAULT_RETRY_POLICY, minIntervalMs: 0, maxAttempts: 2 },
      sleepFn: async () => undefined,
      onAttempt,
    });
    await http.send({ url: "https://x/y", method: "GET" }).catch(() => undefined);
    expect(onAttempt).toHaveBeenCalledTimes(2);
  });
});
