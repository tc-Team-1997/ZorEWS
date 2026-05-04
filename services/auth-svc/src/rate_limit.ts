/**
 * In-memory sliding-window rate limiter. Prototype-scope replacement for the
 * Redis-based limiter the production deploy would use. One instance per
 * policy (login / reset-request) — keys are caller-defined strings (typically
 * `${ip}:${identifier}`), so a single instance can hold many actor buckets.
 *
 * The window is sliding, not fixed: each `take()` prunes timestamps older
 * than `windowMs` before counting. This avoids the bursty "edge of window
 * doubles your allowance" problem that fixed windows have.
 */

export interface RateLimitDecision {
  /** True when the call is under the limit and was recorded. */
  ok: boolean;
  /** Calls remaining in the current window after this one is recorded. */
  remaining: number;
  /** Seconds until the *oldest* recorded hit ages out. Always ≥ 1 when !ok. */
  retry_after_sec: number;
}

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, number[]>();
  constructor(private readonly nowFn: () => number = Date.now) {}

  /**
   * Record a hit against `key` if within `policy.limit` over `policy.windowMs`.
   * On rejection the hit is NOT recorded — repeated takes against an
   * exhausted bucket don't push the retry-after window further out.
   */
  take(key: string, policy: RateLimitPolicy): RateLimitDecision {
    const now = this.nowFn();
    const cutoff = now - policy.windowMs;
    const hits = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);

    if (hits.length >= policy.limit) {
      const oldest = hits[0]!;
      const retryMs = oldest + policy.windowMs - now;
      // Persist the pruned-but-still-full bucket so the caller's next take
      // sees the same eviction state.
      this.buckets.set(key, hits);
      return {
        ok: false,
        remaining: 0,
        retry_after_sec: Math.max(1, Math.ceil(retryMs / 1000)),
      };
    }
    hits.push(now);
    this.buckets.set(key, hits);
    return {
      ok: true,
      remaining: policy.limit - hits.length,
      retry_after_sec: 0,
    };
  }

  /** Test helper — wipes all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Standard policies for APEX auth surfaces. Centralised so the router and
 * tests reference the same numbers.
 */
export const LOGIN_POLICY: RateLimitPolicy = {
  limit: 5,
  windowMs: 15 * 60 * 1000, // 15 min
};

export const RESET_REQUEST_POLICY: RateLimitPolicy = {
  limit: 3,
  windowMs: 60 * 60 * 1000, // 1 hour
};
