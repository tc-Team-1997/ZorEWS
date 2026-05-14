// services/bff/src/adapter_sla_catalog.ts
//
// T6 M14.23 — Adapter expected SLA catalog.
//
// M14.9 fleet-health probes return latency_ms per adapter — but the
// SPA has no anchor to compare against ("is 250ms fast or slow?").
// M14.23 ships the missing piece: per-adapter expected SLA targets
// (typical latency p95, expected data freshness, rate limit). Lets
// the SPA render SLA badges (green/amber/red) on top of the
// fleet-health response.
//
// Pure — hand-calibrated static metadata. Same shape across tenants;
// production deployments would tune the per-tenant overrides
// separately (out of scope for M14.23).

import type { AdapterId } from './adapter_health';

// ─── Public types ─────────────────────────────────────────────────────

export interface AdapterSlaTargets {
  adapter_id: AdapterId;
  /** Display name (matches adapter_health). */
  label: string;
  /** SPA back-link base path. */
  base_path: string;
  /** Expected p95 latency in milliseconds. SPA renders amber when
   *  observed p95 exceeds this, red when 2× exceeded. */
  expected_latency_ms_p95: number;
  /** Maximum data-staleness target. SPA renders amber when last-run
   *  is older than this (data was refreshed recently enough?). */
  expected_freshness_minutes: number;
  /** Soft rate-limit ceiling the adapter is provisioned for. Calls
   *  above this should be queued / throttled by the consumer. */
  rate_limit_per_minute: number;
  /** Uptime SLA target (0..1) — what fraction of probes should
   *  succeed over a rolling window. */
  sla_target_uptime: number;
  /** Free-form description of the SLA rationale (BIL ops can read
   *  this to understand why the numbers are what they are). */
  rationale: string;
}

export interface AdapterSlaCatalog {
  total_adapters: number;
  adapters: AdapterSlaTargets[];
}

// ─── Static table ────────────────────────────────────────────────────

const SLA_TABLE: Readonly<Record<AdapterId, Omit<AdapterSlaTargets, 'adapter_id'>>> = {
  insurance: {
    label: 'Core Insurance',
    base_path: '/v1/integrations/insurance',
    expected_latency_ms_p95: 800,
    expected_freshness_minutes: 60,
    rate_limit_per_minute: 240,
    sla_target_uptime: 0.99,
    rationale: 'Customer-facing policy/claim lookups; p95 budget tuned to keep claim-submission UX under 1s end-to-end.',
  },
  ifrs9: {
    label: 'IFRS9 Stages',
    base_path: '/v1/integrations/ifrs9',
    expected_latency_ms_p95: 1200,
    expected_freshness_minutes: 1440,
    rate_limit_per_minute: 120,
    sla_target_uptime: 0.98,
    rationale: 'Risk staging refreshed daily; latency budget accommodates the heavier ECL recompute.',
  },
  aml: {
    label: 'AML Watchlist',
    base_path: '/v1/integrations/aml',
    expected_latency_ms_p95: 500,
    expected_freshness_minutes: 180,
    rate_limit_per_minute: 600,
    sla_target_uptime: 0.995,
    rationale: 'Sanctions screening runs on every alert; tight latency budget protects the alert pipeline p95.',
  },
  dms: {
    label: 'DMS Documents',
    base_path: '/v1/integrations/dms',
    expected_latency_ms_p95: 600,
    expected_freshness_minutes: 30,
    rate_limit_per_minute: 300,
    sla_target_uptime: 0.99,
    rationale: 'Document metadata lookups during case investigations — tight enough for interactive UX.',
  },
  bureau: {
    label: 'Credit Bureau',
    base_path: '/v1/integrations/bureau',
    expected_latency_ms_p95: 1500,
    expected_freshness_minutes: 10080, // 7 days
    rate_limit_per_minute: 60,
    sla_target_uptime: 0.97,
    rationale: 'External bureau APIs are slow + expensive per call. Reports cached 7 days; rate-limited at 1/sec.',
  },
  agent: {
    label: 'Agent Productivity',
    base_path: '/v1/integrations/agent',
    expected_latency_ms_p95: 700,
    expected_freshness_minutes: 240,
    rate_limit_per_minute: 180,
    sla_target_uptime: 0.98,
    rationale: 'Agent stats refresh every 4 hours; lookup latency drives manager dashboard UX.',
  },
  finance: {
    label: 'Finance / Treasury',
    base_path: '/v1/integrations/finance',
    expected_latency_ms_p95: 900,
    expected_freshness_minutes: 60,
    rate_limit_per_minute: 240,
    sla_target_uptime: 0.99,
    rationale: 'Account + ledger pulls drive risk reasoning; tighter than bureau because internal.',
  },
  hr: {
    label: 'HR / SuccessFactors',
    base_path: '/v1/integrations/hr',
    expected_latency_ms_p95: 1000,
    expected_freshness_minutes: 360,
    rate_limit_per_minute: 120,
    sla_target_uptime: 0.97,
    rationale: 'Employee + leave-balance lookups for ops routing; refreshes every 6 hours.',
  },
};

const ADAPTER_IDS: readonly AdapterId[] = [
  'insurance',
  'ifrs9',
  'aml',
  'dms',
  'bureau',
  'agent',
  'finance',
  'hr',
];

// ─── Pure accessors ──────────────────────────────────────────────────

export function getAdapterSlaTargets(adapter_id: AdapterId): AdapterSlaTargets | null {
  const entry = SLA_TABLE[adapter_id];
  if (!entry) return null;
  return { adapter_id, ...entry };
}

export function listAdapterSlaCatalog(): AdapterSlaCatalog {
  const adapters: AdapterSlaTargets[] = ADAPTER_IDS.map((id) => ({ adapter_id: id, ...SLA_TABLE[id] }));
  adapters.sort((a, b) => (a.adapter_id < b.adapter_id ? -1 : a.adapter_id > b.adapter_id ? 1 : 0));
  return {
    total_adapters: adapters.length,
    adapters,
  };
}
