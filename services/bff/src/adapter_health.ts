// services/bff/src/adapter_health.ts
//
// T6 M14.9 — Adapter fleet health roll-up.
//
// M14.1–M14.8 ship the BIL adapter family (Insurance / IFRS9 /
// AML / DMS / Bureau / Agent / Finance / HR). M14.9 ships a single
// cross-module endpoint that probes all 8 in parallel and returns
// a unified fleet-health view — driven from ops dashboards so a
// human can see at-a-glance which adapters are responding.
//
// Note: this is a *smoke probe*, not a deep health check. Each
// adapter is invoked with a representative read using the same
// (tenant, asOf) inputs. The stubs return data instantly so
// healthy latency_ms is ~0; production swap-in will surface real
// upstream health.
//
// Design:
//  - Pure-function `runFleetHealth(tenant, asOf, adapters)` —
//    Promise.all probes wrapped in try/catch. Returns per-adapter
//    {status, latency_ms, sample_count, error?} + aggregate counts.
//  - Adapters are passed in by the caller (no module-level singleton
//    coupling — fits the existing AppDeps test override pattern).
//  - Probe choice per adapter: a representative read that's cheap
//    + tenant-scoped + doesn't mutate state. None of the 8 adapter
//    interfaces support a `.health()` method directly (it'd be a
//    breaking change to add) so we exercise their existing
//    list/get methods instead.

import { type AgentAdapter } from './integrations/agent';
import { type AmlAdapter } from './integrations/aml';
import { type BureauAdapter } from './integrations/bureau';
import { type DmsAdapter } from './integrations/dms';
import { type FinanceAdapter } from './integrations/finance';
import { type HrAdapter } from './integrations/hr';
import { type Ifrs9Adapter } from './integrations/ifrs9';
import { type InsuranceAdapter } from './integrations/insurance';

// ─── Public types ─────────────────────────────────────────────────────

export type AdapterId =
  | 'insurance'
  | 'ifrs9'
  | 'aml'
  | 'dms'
  | 'bureau'
  | 'agent'
  | 'finance'
  | 'hr';

export type AdapterStatus = 'up' | 'degraded';

export interface AdapterProbe {
  adapter_id: AdapterId;
  label: string;
  /** Module pointer for SPA back-link — same prefix the routes use. */
  base_path: string;
  status: AdapterStatus;
  /** Wall-clock probe latency in ms. */
  latency_ms: number;
  /** Number of records the probe returned (0 for stubs that legitimately
   *  yield empty data — degraded would be reflected in `error`, not
   *  here). null when the probe doesn't naturally return a count. */
  sample_count: number | null;
  /** Populated only on degraded probes. */
  error?: string;
}

export interface FleetHealthReport {
  tenant_id: string;
  generated_at: string;
  /** Total wall-clock for the parallel probe set. */
  total_latency_ms: number;
  /** Aggregate counters. */
  total: number;
  up_count: number;
  degraded_count: number;
  adapters: AdapterProbe[];
}

export interface AdapterFleet {
  insurance: InsuranceAdapter;
  ifrs9: Ifrs9Adapter;
  aml: AmlAdapter;
  dms: DmsAdapter;
  bureau: BureauAdapter;
  agent: AgentAdapter;
  finance: FinanceAdapter;
  hr: HrAdapter;
}

// ─── Per-adapter probes ───────────────────────────────────────────────

/** A representative customer id that exists in every M14 stub's
 *  deterministic synthesis. The stubs derive the customer set
 *  from (tenant, day) so this id is universally probeable. */
const PROBE_CUSTOMER = 'CUST-100001';

interface ProbeMeta {
  id: AdapterId;
  label: string;
  base_path: string;
  fn: (fleet: AdapterFleet, tenant_id: string, asOf: Date) => Promise<{ sample_count: number | null }>;
}

const PROBES: readonly ProbeMeta[] = [
  {
    id: 'insurance',
    label: 'Core Insurance',
    base_path: '/v1/integrations/insurance',
    fn: async (f, t, a) => {
      const r = await f.insurance.listPolicies(t, PROBE_CUSTOMER, a);
      return { sample_count: r.length };
    },
  },
  {
    id: 'ifrs9',
    label: 'IFRS9 Stages',
    base_path: '/v1/integrations/ifrs9',
    fn: async (f, t, a) => {
      const r = await f.ifrs9.listStages(t, { page: 1, page_size: 1 }, a);
      return { sample_count: r.items.length };
    },
  },
  {
    id: 'aml',
    label: 'AML Watchlist',
    base_path: '/v1/integrations/aml',
    fn: async (f, t, a) => {
      const r = await f.aml.screenCustomer(t, PROBE_CUSTOMER, a);
      return { sample_count: r.matches.length };
    },
  },
  {
    id: 'dms',
    label: 'Document Management',
    base_path: '/v1/integrations/dms',
    fn: async (f, t, a) => {
      const r = await f.dms.listByCustomer(t, PROBE_CUSTOMER, a);
      return { sample_count: r.length };
    },
  },
  {
    id: 'bureau',
    label: 'Credit Bureau',
    base_path: '/v1/integrations/bureau',
    fn: async (f, t, a) => {
      const r = await f.bureau.listByCustomer(t, PROBE_CUSTOMER);
      return { sample_count: r.length };
    },
  },
  {
    id: 'agent',
    label: 'Agent Productivity',
    base_path: '/v1/integrations/agent',
    fn: async (f, t, a) => {
      const r = await f.agent.list(t, { page: 1, page_size: 1 }, a);
      return { sample_count: r.items.length };
    },
  },
  {
    id: 'finance',
    label: 'Finance / Treasury',
    base_path: '/v1/integrations/finance',
    fn: async (f, t, a) => {
      const r = await f.finance.listAccountsForCustomer(t, PROBE_CUSTOMER, a);
      return { sample_count: r.length };
    },
  },
  {
    id: 'hr',
    label: 'HR',
    base_path: '/v1/integrations/hr',
    fn: async (f, t, a) => {
      const r = await f.hr.list(t, { page: 1, page_size: 1 }, a);
      return { sample_count: r.items.length };
    },
  },
] as const;

// ─── Main entry ───────────────────────────────────────────────────────

async function probeOne(
  meta: ProbeMeta,
  fleet: AdapterFleet,
  tenant_id: string,
  asOf: Date,
): Promise<AdapterProbe> {
  const start = Date.now();
  try {
    const out = await meta.fn(fleet, tenant_id, asOf);
    return {
      adapter_id: meta.id,
      label: meta.label,
      base_path: meta.base_path,
      status: 'up',
      latency_ms: Date.now() - start,
      sample_count: out.sample_count,
    };
  } catch (e) {
    return {
      adapter_id: meta.id,
      label: meta.label,
      base_path: meta.base_path,
      status: 'degraded',
      latency_ms: Date.now() - start,
      sample_count: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Fan out probes across all 8 adapters in parallel; return the
 * aggregated report. Never throws — adapter-level failures are
 * caught and surfaced as `degraded` entries so one bad upstream
 * doesn't take the whole fleet view down.
 */
export async function runFleetHealth(
  tenant_id: string,
  asOf: Date,
  fleet: AdapterFleet,
): Promise<FleetHealthReport> {
  const start = Date.now();
  const results = await Promise.all(PROBES.map((p) => probeOne(p, fleet, tenant_id, asOf)));
  const up_count = results.filter((r) => r.status === 'up').length;
  const degraded_count = results.length - up_count;
  return {
    tenant_id,
    generated_at: asOf.toISOString(),
    total_latency_ms: Date.now() - start,
    total: results.length,
    up_count,
    degraded_count,
    adapters: results,
  };
}

/** Static metadata for the SPA — doesn't probe, just lists what
 *  adapters the platform knows about. Useful for rendering the
 *  fleet-health header before the first probe completes. */
export function listFleetAdapters(): Array<{
  adapter_id: AdapterId;
  label: string;
  base_path: string;
}> {
  return PROBES.map((p) => ({ adapter_id: p.id, label: p.label, base_path: p.base_path }));
}
