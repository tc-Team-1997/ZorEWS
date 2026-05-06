// services/bff/src/copilot/rate_limiter.ts
//
// Copilot-1 — per-user rate limiter for the copilot.
//
// Spec: 30 queries / user / hour. Implementation: rolling 1-hour
// window keyed on (tenant_id, user_id). Counter held in memory in
// the prototype; production swaps in Redis. Pure helper
// `checkAndConsume` that operates on an explicit state map so tests
// can mint clean instances.

export interface RateLimiterState {
  /** key = `${tenant_id}::${user_id}` → array of consumption timestamps. */
  buckets: Map<string, number[]>;
}

export interface RateCheckResult {
  ok: boolean;
  remaining: number;
  /** ISO timestamp when the next slot frees up (only meaningful when ok=false). */
  reset_at: string;
}

export const COPILOT_DEFAULT_LIMIT = 30;
export const COPILOT_DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function emptyRateState(): RateLimiterState {
  return { buckets: new Map() };
}

/**
 * Pure-function rate check + consume. If the user has < `limit`
 * timestamps in the rolling window, the call is permitted and the
 * timestamp is appended (state mutates). Otherwise the call is
 * rejected — `reset_at` is the timestamp when the OLDEST entry
 * falls out of the window.
 */
export function checkAndConsume(
  state: RateLimiterState,
  tenant_id: string,
  user_id: string,
  now: Date,
  limit: number = COPILOT_DEFAULT_LIMIT,
  windowMs: number = COPILOT_DEFAULT_WINDOW_MS,
): RateCheckResult {
  const key = `${tenant_id}::${user_id}`;
  const cutoff = now.getTime() - windowMs;
  const arr = state.buckets.get(key) ?? [];
  // Drop entries that have aged out.
  const fresh = arr.filter((t) => t > cutoff);
  if (fresh.length >= limit) {
    // Refused — first fresh entry is what we wait on.
    const oldest = fresh[0]!;
    return {
      ok: false,
      remaining: 0,
      reset_at: new Date(oldest + windowMs).toISOString(),
    };
  }
  fresh.push(now.getTime());
  state.buckets.set(key, fresh);
  return {
    ok: true,
    remaining: limit - fresh.length,
    reset_at: new Date(now.getTime() + windowMs).toISOString(),
  };
}

/**
 * Returns the current window state without consuming a slot — useful
 * for the SPA's "X queries left this hour" indicator.
 */
export function inspect(
  state: RateLimiterState,
  tenant_id: string,
  user_id: string,
  now: Date,
  limit: number = COPILOT_DEFAULT_LIMIT,
  windowMs: number = COPILOT_DEFAULT_WINDOW_MS,
): { used: number; remaining: number; reset_at: string | null } {
  const key = `${tenant_id}::${user_id}`;
  const cutoff = now.getTime() - windowMs;
  const fresh = (state.buckets.get(key) ?? []).filter((t) => t > cutoff);
  const used = fresh.length;
  const remaining = Math.max(0, limit - used);
  const reset_at =
    used === 0
      ? null
      : remaining === 0
        ? new Date(fresh[0]! + windowMs).toISOString()
        : new Date(fresh[fresh.length - 1]! + windowMs).toISOString();
  return { used, remaining, reset_at };
}

/** Default singleton state — wired into the route layer in Copilot-2. */
export const defaultRateState = emptyRateState();
