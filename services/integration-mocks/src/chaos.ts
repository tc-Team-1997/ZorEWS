// services/integration-mocks/src/chaos.ts
//
// Latency + error injection middleware. Each mock router reads its
// own profile (env-driven) so different upstreams can simulate different
// latency/error budgets — e.g. Bureau APIs are slow + flaky in real life,
// CBS reads are fast and reliable.

import type { NextFunction, Request, Response } from 'express';

export interface ChaosProfile {
  /** Min added latency in ms. */
  latencyMinMs: number;
  /** Max added latency in ms (inclusive). */
  latencyMaxMs: number;
  /** Probability (0–1) of returning a 500. */
  errorRate: number;
  /** Probability (0–1) of returning a 429 rate-limit. */
  rateLimitRate: number;
}

const DEFAULTS: Record<string, ChaosProfile> = {
  cbs: { latencyMinMs: 30, latencyMaxMs: 120, errorRate: 0, rateLimitRate: 0 },
  aml: { latencyMinMs: 80, latencyMaxMs: 300, errorRate: 0, rateLimitRate: 0 },
  ifrs9: { latencyMinMs: 200, latencyMaxMs: 800, errorRate: 0, rateLimitRate: 0 },
  collection: { latencyMinMs: 50, latencyMaxMs: 200, errorRate: 0, rateLimitRate: 0 },
};

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Read the live profile for an upstream — env vars override defaults. */
export function profileFor(upstream: string): ChaosProfile {
  const d = DEFAULTS[upstream] ?? DEFAULTS.cbs;
  const u = upstream.toUpperCase();
  return {
    latencyMinMs: envNumber(`MOCK_${u}_LATENCY_MIN_MS`, d.latencyMinMs),
    latencyMaxMs: envNumber(`MOCK_${u}_LATENCY_MAX_MS`, d.latencyMaxMs),
    errorRate: envNumber(`MOCK_${u}_ERROR_RATE`, d.errorRate),
    rateLimitRate: envNumber(`MOCK_${u}_RATELIMIT_RATE`, d.rateLimitRate),
  };
}

/** Sleep for `ms` milliseconds. Test-friendly — uses setTimeout. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Express middleware factory. Per request: rolls dice for rate-limit /
 * 500 / latency. If any chaos applies, short-circuits the response.
 *
 * Test runs set the env var `MOCK_CHAOS_DISABLED=1` to skip everything —
 * jest assertions need deterministic timing.
 */
export function chaos(upstream: string, rng: () => number = Math.random) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    if (process.env.MOCK_CHAOS_DISABLED === '1') return next();
    const p = profileFor(upstream);
    if (p.rateLimitRate > 0 && rng() < p.rateLimitRate) {
      res.setHeader('Retry-After', '1');
      return res.status(429).json({
        error: 'rate_limited',
        upstream,
        message: `Mock ${upstream} returned 429 (chaos.rateLimitRate=${p.rateLimitRate})`,
      });
    }
    if (p.errorRate > 0 && rng() < p.errorRate) {
      return res.status(500).json({
        error: 'upstream_error',
        upstream,
        message: `Mock ${upstream} returned 500 (chaos.errorRate=${p.errorRate})`,
      });
    }
    if (p.latencyMaxMs > 0) {
      const span = Math.max(0, p.latencyMaxMs - p.latencyMinMs);
      const wait = p.latencyMinMs + Math.floor(rng() * (span + 1));
      if (wait > 0) await sleep(wait);
    }
    next();
  };
}
