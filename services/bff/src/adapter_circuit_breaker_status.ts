// services/bff/src/adapter_circuit_breaker_status.ts
//
// T6 M14.36 — Adapter circuit breaker status.
//
// For each adapter from listFleetAdapters(), synthesize a circuit breaker
// state using deterministic PRNG seeded by (tenant, adapter_id, day):
//   state: 'closed' (80%) | 'half_open' (15%) | 'open' (5%)
//   failure_count: 0-10 (closed), 5-15 (half_open), 10-20 (open)
//   last_failure_at: recent ISO timestamp or null for closed
//   recovery_timeout_seconds: 30 (half_open), 60 (open), null (closed)
//
// Sort: open first, half_open second, closed last.
//
// Route: GET /v1/integrations/adapters/circuit-breaker-status
//   RBAC: audit:read (admin)

import { listFleetAdapters } from './adapter_health';

// ─── FNV-1a + mulberry32 ──────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Public types ─────────────────────────────────────────────────────

export type CircuitBreakerState = 'closed' | 'half_open' | 'open';

export interface AdapterCircuitBreakerEntry {
  adapter_id: string;
  label: string;
  base_path: string;
  state: CircuitBreakerState;
  failure_count: number;
  last_failure_at: string | null;
  recovery_timeout_seconds: number | null;
}

export interface AdapterCircuitBreakerReport {
  tenant_id: string;
  generated_at: string;
  adapters: AdapterCircuitBreakerEntry[];
  open_count: number;
  half_open_count: number;
  closed_count: number;
  all_healthy: boolean;
}

const STATE_ORDER: CircuitBreakerState[] = ['open', 'half_open', 'closed'];

function stateIndex(s: CircuitBreakerState): number {
  return STATE_ORDER.indexOf(s);
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAdapterCircuitBreakerStatus(
  tenant_id: string,
  now: Date,
): AdapterCircuitBreakerReport {
  if (!tenant_id) throw new Error('tenant_id is required');

  const fleetAdapters = listFleetAdapters();
  const day = now.toISOString().slice(0, 10);
  const entries: AdapterCircuitBreakerEntry[] = [];

  for (const adapter of fleetAdapters) {
    const rng = mulberry32(fnv1a(`${tenant_id}::${adapter.adapter_id}::${day}::cb`));
    const roll = rng();

    let state: CircuitBreakerState;
    if (roll < 0.05) state = 'open';
    else if (roll < 0.20) state = 'half_open';
    else state = 'closed';

    const rng2 = rng;
    let failure_count: number;
    let last_failure_at: string | null;
    let recovery_timeout_seconds: number | null;

    if (state === 'closed') {
      failure_count = Math.floor(rng2() * 11); // 0-10
      last_failure_at = null;
      recovery_timeout_seconds = null;
    } else if (state === 'half_open') {
      failure_count = 5 + Math.floor(rng2() * 11); // 5-15
      const msAgo = Math.floor(rng2() * 60 * 60 * 1000); // 0-1h ago
      last_failure_at = new Date(now.getTime() - msAgo).toISOString();
      recovery_timeout_seconds = 30;
    } else {
      // open
      failure_count = 10 + Math.floor(rng2() * 11); // 10-20
      const msAgo = Math.floor(rng2() * 30 * 60 * 1000); // 0-30min ago
      last_failure_at = new Date(now.getTime() - msAgo).toISOString();
      recovery_timeout_seconds = 60;
    }

    entries.push({
      adapter_id: adapter.adapter_id,
      label: adapter.label,
      base_path: adapter.base_path,
      state,
      failure_count,
      last_failure_at,
      recovery_timeout_seconds,
    });
  }

  // Sort: open first, half_open second, closed last
  entries.sort((a, b) => stateIndex(a.state) - stateIndex(b.state));

  const open_count = entries.filter((e) => e.state === 'open').length;
  const half_open_count = entries.filter((e) => e.state === 'half_open').length;
  const closed_count = entries.filter((e) => e.state === 'closed').length;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    adapters: entries,
    open_count,
    half_open_count,
    closed_count,
    all_healthy: open_count === 0,
  };
}
