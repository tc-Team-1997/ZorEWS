// services/bff/src/ingestion.ts
//
// T6 M3.1 — BIL Data Ingestion connector registry.
//
// Module 3 (Data Ingestion & ETL) was empty in T6 until now. This
// module ships the first slice — a registry of declared upstream
// connectors with status + run-history tracking. The 8 seed connectors
// match the BIL pitch upstream list (CBS, Core Insurance, Policy
// Master, Claims, Agent Productivity, AML, Bureau, IFRS9).
//
// Why a registry vs. real ETL: the prototype doesn't run actual
// pipelines. The registry is the *contract* the ops team needs —
// "which connectors exist, what is each one's status, when did they
// last run, were there failures". Production wires this to the actual
// scheduler (Airflow, etc.) implementing the same IngestionRegistry
// interface; the SPA UX stays unchanged.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type ConnectorType =
  | 'kafka_stream'
  | 'batch_csv'
  | 'rest_api'
  | 'soap_api'
  | 'sftp_drop';

export type ConnectorStatus = 'healthy' | 'degraded' | 'failing' | 'paused';

export type RunStatus = 'success' | 'failure' | 'partial' | 'running';

export interface ConnectorDef {
  /** Stable id, namespace-prefixed. */
  id: string;
  name: string;
  source_system: string;
  type: ConnectorType;
  /** Human-readable schedule. The stub does not parse cron. */
  schedule: string;
  /** Default status seeded into the registry — runtime can override. */
  default_status: ConnectorStatus;
  description: string;
}

export interface Connector extends ConnectorDef {
  /** Effective status — possibly mutated from default_status by recent runs. */
  status: ConnectorStatus;
  last_run_at: string | null;
  last_run_status: RunStatus | null;
  /** Records processed in the last successful run. */
  last_run_records: number;
  /** Average lag (seconds) between source-system event time and ingest. */
  average_lag_seconds: number;
  /** ISO timestamp when the connector was last paused — null if active. */
  paused_at: string | null;
}

export interface ConnectorRun {
  run_id: string;
  connector_id: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  records_processed: number;
  records_failed: number;
  /** Set on failure / partial. null otherwise. */
  error_message: string | null;
  /** Was this triggered by /run-now (vs the schedule)? */
  triggered_manually: boolean;
}

export interface IngestionHealth {
  total_connectors: number;
  by_status: Record<ConnectorStatus, number>;
  /** Connectors with status !== 'healthy', newest-failing-first. */
  attention_required: Connector[];
  /** Total records processed in the last run across the fleet. */
  fleet_records_last_run: number;
}

export interface IngestionRegistry {
  list(tenant_id: string): Connector[];
  get(tenant_id: string, connector_id: string): Connector | null;
  /** Trigger an ad-hoc run. Returns the resulting ConnectorRun. Throws
   *  IngestionError(unknown_connector / paused). */
  runNow(tenant_id: string, connector_id: string, triggered_by: string, now: Date): ConnectorRun;
  /** Recent runs newest-first. limit clamped to [1, 200]. */
  listRuns(tenant_id: string, connector_id: string, limit?: number): ConnectorRun[];
  /** Aggregate fleet health. */
  health(tenant_id: string): IngestionHealth;
  /** Pause / resume a connector. Throws unknown_connector. */
  setPaused(tenant_id: string, connector_id: string, paused: boolean, now: Date): Connector;
}

export class IngestionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IngestionError';
  }
}

// ─── Seed catalogue ────────────────────────────────────────────────────
//
// 8 BIL upstream connectors per DataNetworks-EWS-Ver1.pdf §15. Each
// tenant gets a fresh copy lazily — overrides (status, paused) are
// per-tenant; the seed schema is platform-wide.

export const SEED_CONNECTORS: readonly ConnectorDef[] = [
  {
    id: 'cbs_loan_book',
    name: 'Core Banking Loan Book',
    source_system: 'CBS',
    type: 'kafka_stream',
    schedule: 'continuous',
    default_status: 'healthy',
    description: 'Streams loan + repayment events from the core banking system',
  },
  {
    id: 'core_insurance_policies',
    name: 'Core Insurance — Policies',
    source_system: 'CORE_INSURANCE',
    type: 'sftp_drop',
    schedule: 'daily 02:00',
    default_status: 'healthy',
    description: 'Nightly policy master export from the insurance core',
  },
  {
    id: 'policy_master_increment',
    name: 'Policy Master — Increments',
    source_system: 'POLICY_MASTER',
    type: 'kafka_stream',
    schedule: 'every 5 min',
    default_status: 'healthy',
    description: 'Near-real-time policy delta stream from Policy Master',
  },
  {
    id: 'claims_feed',
    name: 'Claims Feed',
    source_system: 'CLAIMS',
    type: 'kafka_stream',
    schedule: 'every 1 min',
    default_status: 'healthy',
    description: 'Claim filing + status-change events',
  },
  {
    id: 'agent_productivity',
    name: 'Agent Productivity',
    source_system: 'AGENT',
    type: 'batch_csv',
    schedule: 'daily 03:00',
    default_status: 'degraded',
    description: 'Daily agent KPI rollup (sales, persistency, churn)',
  },
  {
    id: 'aml_watchlist',
    name: 'AML Watchlist Sync',
    source_system: 'AML',
    type: 'rest_api',
    schedule: 'hourly',
    default_status: 'healthy',
    description: 'Pulls sanctions + PEP updates from the AML hub',
  },
  {
    id: 'bureau_pull',
    name: 'Credit Bureau Pull',
    source_system: 'BUREAU',
    type: 'rest_api',
    schedule: 'weekly',
    default_status: 'healthy',
    description: 'Weekly bulk credit-bureau refresh for the loan book',
  },
  {
    id: 'ifrs9_stage_feed',
    name: 'IFRS9 Stage Feed',
    source_system: 'IFRS9',
    type: 'rest_api',
    schedule: 'daily 04:00',
    default_status: 'healthy',
    description: 'Daily stage 1/2/3 classification snapshot from IFRS 9 engine',
  },
];

const SEED_BY_ID = new Map<string, ConnectorDef>(SEED_CONNECTORS.map((c) => [c.id, c]));

// ─── Deterministic per-tenant per-day stats ────────────────────────────
// Uses the same FNV-1a + Mulberry32 scheme as the other BIL stubs so
// the registry's "last_run_records" + "average_lag_seconds" stay
// stable within a day for a given (tenant, connector).

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dailyStats(tenant_id: string, connector_id: string, now: Date): {
  last_run_records: number;
  average_lag_seconds: number;
} {
  const day = now.toISOString().slice(0, 10);
  const r = rng(fnv1a(`stats|${tenant_id}|${connector_id}|${day}`));
  // Records range varies by source — kafka streams + sftp drops are
  // higher volume than weekly bureau pulls.
  const def = SEED_BY_ID.get(connector_id);
  let baseRecords = 1000;
  if (def) {
    if (def.type === 'kafka_stream') baseRecords = 50_000;
    else if (def.type === 'sftp_drop') baseRecords = 25_000;
    else if (def.type === 'batch_csv') baseRecords = 5_000;
    else if (def.type === 'rest_api') baseRecords = def.schedule.includes('weekly') ? 100_000 : 500;
  }
  return {
    last_run_records: Math.floor(baseRecords * (0.7 + r() * 0.6)),
    average_lag_seconds: Math.floor(2 + r() * 60),
  };
}

// ─── In-memory registry ────────────────────────────────────────────────

interface TenantState {
  /** Connector overrides (status, paused_at, last_run_*). */
  overrides: Map<string, {
    status?: ConnectorStatus;
    last_run_at?: string;
    last_run_status?: RunStatus;
    paused_at?: string | null;
  }>;
  /** Per-connector run history, newest-last. */
  runs: Map<string, ConnectorRun[]>;
}

export class InMemoryIngestionRegistry implements IngestionRegistry {
  private readonly state = new Map<string, TenantState>();
  private readonly cap: number;

  constructor(opts: { runHistoryCap?: number } = {}) {
    this.cap = opts.runHistoryCap ?? 100;
  }

  list(tenant_id: string): Connector[] {
    return SEED_CONNECTORS.map((def) => this.composeConnector(tenant_id, def, new Date()));
  }

  get(tenant_id: string, connector_id: string): Connector | null {
    const def = SEED_BY_ID.get(connector_id);
    if (!def) return null;
    return this.composeConnector(tenant_id, def, new Date());
  }

  runNow(
    tenant_id: string,
    connector_id: string,
    triggered_by: string,
    now: Date,
  ): ConnectorRun {
    const def = SEED_BY_ID.get(connector_id);
    if (!def) {
      throw new IngestionError('unknown_connector', `unknown connector: ${connector_id}`);
    }
    const ts = this.tState(tenant_id);
    const ov = ts.overrides.get(connector_id);
    if (ov?.paused_at) {
      throw new IngestionError(
        'paused',
        `connector ${connector_id} is paused — resume it before running`,
      );
    }

    // Synthesise a run with deterministic stats. Most runs succeed; a
    // small, deterministic fraction of "degraded" connectors produce
    // a partial run.
    const stats = dailyStats(tenant_id, connector_id, now);
    const eff = ov?.status ?? def.default_status;
    const status: RunStatus =
      eff === 'failing'
        ? 'failure'
        : eff === 'degraded'
          ? 'partial'
          : 'success';
    const records_processed = status === 'failure' ? 0 : stats.last_run_records;
    const records_failed = status === 'partial' ? Math.floor(stats.last_run_records * 0.05) : 0;
    const error_message =
      status === 'failure'
        ? `${def.source_system} unavailable — connection refused`
        : status === 'partial'
          ? `${records_failed} of ${stats.last_run_records} records rejected on validation`
          : null;

    const run: ConnectorRun = {
      run_id: `run-${randomUUID()}`,
      connector_id,
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
      status,
      records_processed,
      records_failed,
      error_message,
      triggered_manually: triggered_by !== 'scheduler',
    };

    let arr = ts.runs.get(connector_id);
    if (!arr) {
      arr = [];
      ts.runs.set(connector_id, arr);
    }
    arr.push(run);
    if (arr.length > this.cap) {
      arr.splice(0, arr.length - this.cap);
    }

    // Reflect into the connector overrides so subsequent get() calls
    // see the freshly-completed run.
    ts.overrides.set(connector_id, {
      ...ov,
      last_run_at: run.started_at,
      last_run_status: run.status,
    });

    return run;
  }

  listRuns(tenant_id: string, connector_id: string, limit = 50): ConnectorRun[] {
    if (!SEED_BY_ID.has(connector_id)) {
      throw new IngestionError('unknown_connector', `unknown connector: ${connector_id}`);
    }
    const lim = Math.max(1, Math.min(200, limit));
    const arr = this.tState(tenant_id).runs.get(connector_id) ?? [];
    return [...arr].slice(-lim).reverse();
  }

  health(tenant_id: string): IngestionHealth {
    const all = this.list(tenant_id);
    const by_status: Record<ConnectorStatus, number> = {
      healthy: 0,
      degraded: 0,
      failing: 0,
      paused: 0,
    };
    for (const c of all) by_status[c.status]++;
    const attention_required = all
      .filter((c) => c.status !== 'healthy')
      .sort((a, b) => {
        const rank = { failing: 0, degraded: 1, paused: 2, healthy: 3 };
        return rank[a.status] - rank[b.status];
      });
    const fleet_records_last_run = all.reduce((sum, c) => sum + c.last_run_records, 0);
    return {
      total_connectors: all.length,
      by_status,
      attention_required,
      fleet_records_last_run,
    };
  }

  setPaused(tenant_id: string, connector_id: string, paused: boolean, now: Date): Connector {
    const def = SEED_BY_ID.get(connector_id);
    if (!def) {
      throw new IngestionError('unknown_connector', `unknown connector: ${connector_id}`);
    }
    const ts = this.tState(tenant_id);
    const ov = ts.overrides.get(connector_id) ?? {};
    if (paused) {
      ts.overrides.set(connector_id, { ...ov, paused_at: now.toISOString() });
    } else {
      ts.overrides.set(connector_id, { ...ov, paused_at: null });
    }
    return this.composeConnector(tenant_id, def, now);
  }

  /** Test helper. */
  reset(): void {
    this.state.clear();
  }

  private tState(tenant_id: string): TenantState {
    let ts = this.state.get(tenant_id);
    if (!ts) {
      ts = { overrides: new Map(), runs: new Map() };
      this.state.set(tenant_id, ts);
    }
    return ts;
  }

  private composeConnector(tenant_id: string, def: ConnectorDef, now: Date): Connector {
    const ov = this.state.get(tenant_id)?.overrides.get(def.id);
    const stats = dailyStats(tenant_id, def.id, now);
    const status: ConnectorStatus = ov?.paused_at
      ? 'paused'
      : ov?.status ?? def.default_status;
    return {
      ...def,
      status,
      last_run_at: ov?.last_run_at ?? null,
      last_run_status: ov?.last_run_status ?? null,
      last_run_records: stats.last_run_records,
      average_lag_seconds: stats.average_lag_seconds,
      paused_at: ov?.paused_at ?? null,
    };
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultIngestionRegistry: IngestionRegistry = new InMemoryIngestionRegistry();
