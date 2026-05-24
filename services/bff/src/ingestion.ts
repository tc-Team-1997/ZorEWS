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
  /** Module 1.1 — username of the connector owner; null when unassigned.
   *  Optional in the type for backward compat with existing test fixtures
   *  that build Connector literals; composeConnector always populates it. */
  owner_user_id?: string | null;
  /** True when this connector was created via POST /connectors (vs seed). */
  is_custom?: boolean;
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

export interface ConnectorCreateInput {
  /** Required client-supplied id (`^[a-z][a-z0-9_]{2,63}$`). */
  id: string;
  name: string;
  source_system: string;
  type: ConnectorType;
  schedule: string;
  description?: string;
  /** Initial status. Defaults to 'healthy'. */
  default_status?: ConnectorStatus;
  /** Optional owner username (Module 1.1 spec). */
  owner_user_id?: string | null;
}

export interface ConnectorUpdateInput {
  name?: string;
  source_system?: string;
  type?: ConnectorType;
  schedule?: string;
  description?: string;
  default_status?: ConnectorStatus;
  owner_user_id?: string | null;
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
  /** Module 1.1 — Add a new per-tenant custom connector (admin Source Editor).
   *  Throws IngestionError(invalid_id | id_in_use | invalid_input). */
  create?(tenant_id: string, input: ConnectorCreateInput, now: Date): Connector;
  /** Edit a connector's mutable metadata. Platform seed connectors are
   *  editable via overlay (effective view merges); custom connectors
   *  are edited in place. Throws unknown_connector | invalid_input. */
  update?(tenant_id: string, connector_id: string, patch: ConnectorUpdateInput, now: Date): Connector;
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
  // ─── M3.4 — Additional BIL connectors ────────────────────────────────
  {
    id: 'branch_transactions',
    name: 'Branch Transactions Stream',
    source_system: 'BRANCH',
    type: 'kafka_stream',
    schedule: 'continuous',
    default_status: 'healthy',
    description: 'Branch-level transaction events (cash deposit, withdrawal, transfer)',
  },
  {
    id: 'collections_outbox',
    name: 'Collections Outbox',
    source_system: 'COLLECTION',
    type: 'rest_api',
    schedule: 'every 15 min',
    default_status: 'healthy',
    description: 'Collection-action outbox feed (call attempts, recovery actions)',
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
  /** Module 1.1 — per-tenant custom connectors (Source Editor "Add new source"). */
  customs: Map<string, ConnectorDef & { owner_user_id: string | null }>;
  /** Module 1.1 — per-connector metadata overlay (Source Editor "Edit"). Applies to seed + custom. */
  meta_overrides: Map<string, Partial<ConnectorDef> & { owner_user_id?: string | null }>;
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
    const now = new Date();
    const ts = this.state.get(tenant_id);
    const seedRows = SEED_CONNECTORS.map((def) => this.composeConnector(tenant_id, def, now));
    const customRows = ts
      ? [...ts.customs.values()].map((def) => this.composeConnector(tenant_id, def, now))
      : [];
    // Custom first so newly-added sources surface at the top.
    return [...customRows, ...seedRows];
  }

  get(tenant_id: string, connector_id: string): Connector | null {
    const def = this.resolveDef(tenant_id, connector_id);
    if (!def) return null;
    return this.composeConnector(tenant_id, def, new Date());
  }

  runNow(
    tenant_id: string,
    connector_id: string,
    triggered_by: string,
    now: Date,
  ): ConnectorRun {
    const def = this.resolveDef(tenant_id, connector_id);
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
    if (!this.resolveDef(tenant_id, connector_id)) {
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
    const def = this.resolveDef(tenant_id, connector_id);
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
      ts = {
        overrides: new Map(),
        customs: new Map(),
        meta_overrides: new Map(),
        runs: new Map(),
      };
      this.state.set(tenant_id, ts);
    }
    return ts;
  }

  /** Locate the connector def for an id — seed catalog OR per-tenant custom. */
  private resolveDef(tenant_id: string, connector_id: string):
    | (ConnectorDef & { is_custom: boolean; owner_user_id: string | null })
    | null {
    const ts = this.state.get(tenant_id);
    const custom = ts?.customs.get(connector_id);
    if (custom) {
      return { ...custom, is_custom: true, owner_user_id: custom.owner_user_id ?? null };
    }
    const seed = SEED_BY_ID.get(connector_id);
    if (seed) {
      return { ...seed, is_custom: false, owner_user_id: null };
    }
    return null;
  }

  private composeConnector(tenant_id: string, def: ConnectorDef, now: Date): Connector {
    const ts = this.state.get(tenant_id);
    const ov = ts?.overrides.get(def.id);
    const meta = ts?.meta_overrides.get(def.id);
    const custom = ts?.customs.get(def.id);
    const stats = dailyStats(tenant_id, def.id, now);
    const status: ConnectorStatus = ov?.paused_at
      ? 'paused'
      : ov?.status ?? def.default_status;
    const merged: ConnectorDef = {
      ...def,
      ...(meta ?? {}),
    } as ConnectorDef;
    const owner_user_id =
      meta?.owner_user_id ?? custom?.owner_user_id ?? null;
    return {
      ...merged,
      status,
      last_run_at: ov?.last_run_at ?? null,
      last_run_status: ov?.last_run_status ?? null,
      last_run_records: stats.last_run_records,
      average_lag_seconds: stats.average_lag_seconds,
      paused_at: ov?.paused_at ?? null,
      owner_user_id,
      is_custom: !!custom,
    };
  }

  // ── Module 1.1 — create + update ────────────────────────────────────
  create(tenant_id: string, input: ConnectorCreateInput, now: Date): Connector {
    const ID_RE = /^[a-z][a-z0-9_]{2,63}$/;
    if (!input || typeof input !== 'object') {
      throw new IngestionError('invalid_input', 'input required');
    }
    if (!ID_RE.test(input.id)) {
      throw new IngestionError(
        'invalid_id',
        'id must match ^[a-z][a-z0-9_]{2,63}$',
      );
    }
    if (!input.name || input.name.trim().length === 0) {
      throw new IngestionError('invalid_input', 'name required');
    }
    if (!input.source_system || input.source_system.trim().length === 0) {
      throw new IngestionError('invalid_input', 'source_system required');
    }
    if (!input.schedule || input.schedule.trim().length === 0) {
      throw new IngestionError('invalid_input', 'schedule required');
    }
    const VALID_TYPES: ConnectorType[] = [
      'kafka_stream',
      'batch_csv',
      'rest_api',
      'soap_api',
      'sftp_drop',
    ];
    if (!VALID_TYPES.includes(input.type)) {
      throw new IngestionError(
        'invalid_input',
        `type must be one of: ${VALID_TYPES.join(', ')}`,
      );
    }
    // id collision: against seed AND existing customs for the tenant
    const ts = this.tState(tenant_id);
    if (SEED_BY_ID.has(input.id) || ts.customs.has(input.id)) {
      throw new IngestionError('id_in_use', `connector id already in use: ${input.id}`);
    }
    const def: ConnectorDef & { owner_user_id: string | null } = {
      id: input.id,
      name: input.name.trim(),
      source_system: input.source_system.trim(),
      type: input.type,
      schedule: input.schedule.trim(),
      default_status: input.default_status ?? 'healthy',
      description: input.description?.trim() ?? '',
      owner_user_id: input.owner_user_id ?? null,
    };
    ts.customs.set(input.id, def);
    return this.composeConnector(tenant_id, def, now);
  }

  update(
    tenant_id: string,
    connector_id: string,
    patch: ConnectorUpdateInput,
    now: Date,
  ): Connector {
    if (!patch || typeof patch !== 'object') {
      throw new IngestionError('invalid_input', 'patch required');
    }
    const def = this.resolveDef(tenant_id, connector_id);
    if (!def) {
      throw new IngestionError('unknown_connector', `unknown connector: ${connector_id}`);
    }
    const ts = this.tState(tenant_id);
    const VALID_TYPES: ConnectorType[] = [
      'kafka_stream',
      'batch_csv',
      'rest_api',
      'soap_api',
      'sftp_drop',
    ];
    if (patch.type !== undefined && !VALID_TYPES.includes(patch.type)) {
      throw new IngestionError(
        'invalid_input',
        `type must be one of: ${VALID_TYPES.join(', ')}`,
      );
    }
    // For seed connectors, patch goes into meta_overrides (overlay).
    // For custom connectors, patch updates the custom def in place.
    if (def.is_custom) {
      const cur = ts.customs.get(connector_id)!;
      const next = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.source_system !== undefined ? { source_system: patch.source_system.trim() } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description?.trim() ?? '' } : {}),
        ...(patch.default_status !== undefined ? { default_status: patch.default_status } : {}),
        ...(patch.owner_user_id !== undefined ? { owner_user_id: patch.owner_user_id } : {}),
      };
      ts.customs.set(connector_id, next);
    } else {
      const prev = ts.meta_overrides.get(connector_id) ?? {};
      const next = {
        ...prev,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.source_system !== undefined ? { source_system: patch.source_system.trim() } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description?.trim() ?? '' } : {}),
        ...(patch.default_status !== undefined ? { default_status: patch.default_status } : {}),
        ...(patch.owner_user_id !== undefined ? { owner_user_id: patch.owner_user_id } : {}),
      };
      ts.meta_overrides.set(connector_id, next);
    }
    // Reload + compose
    const reloadedDef = this.resolveDef(tenant_id, connector_id)!;
    return this.composeConnector(tenant_id, reloadedDef, now);
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultIngestionRegistry: IngestionRegistry = new InMemoryIngestionRegistry();
