// Enterprise Data Fabric Center — pure resolver. 14th IA overlay (additive).
//
// pipelineOrchestrator.ts — Pipeline Orchestrator module
//
// Pure module: no I/O, no React, no async, deterministic.
// Production swap will replace resolver bodies with HTTP/pg calls;
// surface contract stays stable.

import {
  DataDomain,
  PipelineStatus,
  PipelineAction,
  ExecutionStatus,
  DATA_DOMAINS,
} from './dataFabricEngine';

// ---------------------------------------------------------------------------
// Deterministic synthesis helpers (FNV-1a + Mulberry32)
// ---------------------------------------------------------------------------

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayIndex(asOf: Date): number {
  return Math.floor(asOf.getTime() / 86_400_000);
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

function isoFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1, 2);
  const da = pad(d.getUTCDate(), 2);
  const h = pad(d.getUTCHours(), 2);
  const mi = pad(d.getUTCMinutes(), 2);
  const se = pad(d.getUTCSeconds(), 2);
  return `${y}-${mo}-${da}T${h}:${mi}:${se}.000Z`;
}

function isoDateOnlyFromDate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1, 2);
  const da = pad(d.getUTCDate(), 2);
  return `${y}-${mo}-${da}`;
}

function pickOne<T>(rng: () => number, list: readonly T[]): T {
  const idx = Math.floor(rng() * list.length);
  return list[Math.min(idx, list.length - 1)];
}

function pickMany<T>(rng: () => number, list: readonly T[], min: number, max: number): T[] {
  const count = min + Math.floor(rng() * (max - min + 1));
  const pool = list.slice();
  const out: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PIPELINE_COUNT_PER_TENANT = 24;
const RUN_COUNT_PER_TENANT = 60;
const DEFAULT_RUN_LIMIT = 50;

const PIPELINE_STATUS_PRIORITY: Record<PipelineStatus, number> = {
  failed: 0,
  running: 1,
  scheduled: 2,
  paused: 3,
  idle: 4,
  success: 5,
};

const PIPELINE_NAME_PREFIXES: readonly string[] = [
  'CBS Loan Sync',
  'Policy Admin ETL',
  'Claims Ingest',
  'KYC Refresh',
  'AML Watchlist Pull',
  'Bureau Score Load',
  'Customer 360 Build',
  'Risk Indicator Refresh',
  'Treasury Position Sync',
  'Agency Productivity',
  'Underwriting Feed',
  'Billing Reconciliation',
  'Fraud Signal Stream',
  'Payments Settlement',
  'Collections Snapshot',
  'CRM Sync',
  'Audit Trail Export',
  'Regulatory Report Build',
  'Mart Aggregation',
  'Feature Store Refresh',
  'IFRS9 Stage Computation',
  'Solvency Calc',
  'Persistency Rollup',
  'Loss Ratio Compute',
];

const CRON_SCHEDULES: readonly string[] = [
  '0 */6 * * *',
  '*/15 * * * *',
  '0 2 * * *',
  '0 */1 * * *',
  '0 0 * * 0',
  'manual',
  '*/30 * * * *',
  '0 4 * * *',
];

const OWNER_POOL: readonly string[] = [
  'alice.kim',
  'rahul.sharma',
  'samira.kone',
  'david.chen',
  'priya.nair',
  'felix.mwangi',
  'ananya.iyer',
  'marcus.obrien',
];

const TAG_POOL: readonly string[] = [
  'production',
  'regulatory',
  'high-priority',
  'batch',
  'streaming',
  'critical-path',
  'experimental',
  'compliance',
  'analytics',
  'mart',
];

const ERROR_SUMMARIES: readonly string[] = [
  'Connection timeout to upstream source',
  'Schema validation failed for record batch',
  'Duplicate primary key detected',
  'Authentication token expired',
  'Target table lock timeout',
  'Memory limit exceeded during transformation',
  'Network partition during streaming',
  'Quota exceeded on downstream API',
];

const HISTORY_NOTES: readonly string[] = [
  'Routine schedule activation',
  'Manual execution by operator',
  'Auto-retry after transient failure',
  'Paused for maintenance window',
  'Resumed post-incident',
  'Schedule re-armed after pause',
  'Triggered by upstream completion',
  'Resume after dependency repair',
  null as unknown as string,
];

const PIPELINE_ACTIONS_HISTORY: readonly PipelineAction[] = [
  'create',
  'schedule',
  'execute',
  'pause',
  'resume',
  'retry',
];

const PIPELINE_STATUSES_FOR_HISTORY: readonly PipelineStatus[] = [
  'idle',
  'scheduled',
  'running',
  'paused',
  'failed',
  'success',
];

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface DataPipeline {
  pipeline_id: string;
  tenant_id: string;
  name: string;
  domain: DataDomain;
  description: string;
  status: PipelineStatus;
  schedule_cron: string;
  source_ids: string[];
  target_ids: string[];
  owner: string;
  sla_minutes: number;
  last_run_at: string | null;
  next_run_at: string | null;
  success_rate_30d: number;
  created_at: string;
  tags: string[];
}

export interface PipelineRun {
  run_id: string;
  pipeline_id: string;
  tenant_id: string;
  status: ExecutionStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  records_in: number;
  records_out: number;
  records_failed: number;
  sla_met: boolean;
  trigger: 'manual' | 'scheduled' | 'retry';
  error_summary: string | null;
}

export interface PipelineHistoryEntry {
  ts: string;
  actor: string;
  action: PipelineAction;
  from_status: PipelineStatus;
  to_status: PipelineStatus;
  note: string | null;
}

export interface PipelineOrchestratorSummary {
  tenant_id: string;
  generated_at: string;
  total_pipelines: number;
  scheduled_count: number;
  running_count: number;
  paused_count: number;
  failed_count: number;
  sla_compliance_30d: number;
  avg_runtime_seconds: number;
  pipeline_availability_pct: number;
  throughput_records_24h: number;
  by_status: Record<PipelineStatus, number>;
  by_domain: Record<DataDomain, number>;
}

// ---------------------------------------------------------------------------
// Pipeline status / domain selection
// ---------------------------------------------------------------------------

function pickPipelineStatus(rng: () => number): PipelineStatus {
  const r = rng();
  // ~50% idle, 15% scheduled, 10% running, 10% paused, 8% failed, 7% success
  if (r < 0.5) return 'idle';
  if (r < 0.65) return 'scheduled';
  if (r < 0.75) return 'running';
  if (r < 0.85) return 'paused';
  if (r < 0.93) return 'failed';
  return 'success';
}

function pickDomain(rng: () => number): DataDomain {
  return pickOne(rng, DATA_DOMAINS);
}

function buildSourceIds(rng: () => number, _domain: DataDomain): string[] {
  const count = 1 + Math.floor(rng() * 3);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = 1 + Math.floor(rng() * 200);
    out.push(`SRC-${pad(id, 5)}`);
  }
  return Array.from(new Set(out));
}

function buildTargetIds(rng: () => number): string[] {
  const count = 1 + Math.floor(rng() * 2);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = 1 + Math.floor(rng() * 50);
    out.push(`TGT-${pad(id, 5)}`);
  }
  return Array.from(new Set(out));
}

// ---------------------------------------------------------------------------
// listPipelines
// ---------------------------------------------------------------------------

function generatePipeline(
  tenant_id: string,
  index: number,
  asOf: Date,
): DataPipeline {
  const day = dayIndex(asOf);
  const seed = fnv1a(`${tenant_id}|pipeline|${index}|${day}`);
  const rng = mulberry32(seed);

  const domain = pickDomain(rng);
  const baseName = pickOne(rng, PIPELINE_NAME_PREFIXES);
  const name = `${baseName} #${pad(index + 1, 3)}`;
  const status = pickPipelineStatus(rng);
  const schedule_cron = pickOne(rng, CRON_SCHEDULES);
  const owner = pickOne(rng, OWNER_POOL);
  const sla_minutes = [15, 30, 60, 120, 240][Math.floor(rng() * 5)];
  const success_rate_30d = Math.round((0.75 + rng() * 0.24) * 10000) / 10000;

  // last_run_at: hours ago in [1, 72]
  const lastRunOffsetMs =
    (1 + Math.floor(rng() * 72)) * 3_600_000;
  const lastRunDate = new Date(asOf.getTime() - lastRunOffsetMs);
  const last_run_at = isoFromDate(lastRunDate);

  // next_run_at: null when paused or manual; else future
  let next_run_at: string | null = null;
  if (status !== 'paused' && schedule_cron !== 'manual') {
    const nextOffsetMs = (1 + Math.floor(rng() * 12)) * 3_600_000;
    const nextDate = new Date(asOf.getTime() + nextOffsetMs);
    next_run_at = isoFromDate(nextDate);
  }

  // created_at: days ago in [10, 365]
  const createdOffsetDays = 10 + Math.floor(rng() * 356);
  const createdDate = new Date(
    asOf.getTime() - createdOffsetDays * 86_400_000,
  );
  const created_at = isoDateOnlyFromDate(createdDate);

  const tags = pickMany(rng, TAG_POOL, 1, 3);
  const source_ids = buildSourceIds(rng, domain);
  const target_ids = buildTargetIds(rng);

  const description = `${baseName} pipeline serving ${domain} domain workloads via ${schedule_cron} schedule.`;

  return {
    pipeline_id: `PIPE-${pad(index + 1, 5)}`,
    tenant_id,
    name,
    domain,
    description,
    status,
    schedule_cron,
    source_ids,
    target_ids,
    owner,
    sla_minutes,
    last_run_at,
    next_run_at,
    success_rate_30d,
    created_at,
    tags,
  };
}

export function listPipelines(
  tenant_id: string,
  asOf?: Date,
  filters?: { status?: PipelineStatus; domain?: DataDomain },
): DataPipeline[] {
  const when = asOf ?? new Date();
  const out: DataPipeline[] = [];
  for (let i = 0; i < PIPELINE_COUNT_PER_TENANT; i++) {
    out.push(generatePipeline(tenant_id, i, when));
  }

  let filtered = out;
  if (filters) {
    filtered = out.filter((p) => {
      if (filters.status && p.status !== filters.status) return false;
      if (filters.domain && p.domain !== filters.domain) return false;
      return true;
    });
  }

  filtered.sort((a, b) => {
    const pa = PIPELINE_STATUS_PRIORITY[a.status];
    const pb = PIPELINE_STATUS_PRIORITY[b.status];
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  return filtered;
}

// ---------------------------------------------------------------------------
// getPipeline
// ---------------------------------------------------------------------------

export function getPipeline(
  pipeline_id: string,
  tenant_id: string,
  asOf?: Date,
): DataPipeline | null {
  const all = listPipelines(tenant_id, asOf);
  return all.find((p) => p.pipeline_id === pipeline_id) ?? null;
}

// ---------------------------------------------------------------------------
// listPipelineRuns
// ---------------------------------------------------------------------------

function pickExecutionStatus(rng: () => number): ExecutionStatus {
  const r = rng();
  // ~60% success, 15% failure, 10% partial, 10% running, 5% queued
  if (r < 0.6) return 'success';
  if (r < 0.75) return 'failure';
  if (r < 0.85) return 'partial';
  if (r < 0.95) return 'running';
  return 'queued';
}

function pickTrigger(rng: () => number): 'manual' | 'scheduled' | 'retry' {
  const r = rng();
  if (r < 0.7) return 'scheduled';
  if (r < 0.9) return 'manual';
  return 'retry';
}

function generateRun(
  tenant_id: string,
  index: number,
  asOf: Date,
): PipelineRun {
  const day = dayIndex(asOf);
  const seed = fnv1a(`${tenant_id}|run|${index}|${day}`);
  const rng = mulberry32(seed);

  // pick a pipeline_id from the tenant's pipeline pool
  const pipelineIdx = Math.floor(rng() * PIPELINE_COUNT_PER_TENANT);
  const pipeline_id = `PIPE-${pad(pipelineIdx + 1, 5)}`;

  const status = pickExecutionStatus(rng);
  const trigger = pickTrigger(rng);

  // started_at: offset back in time deterministically by index
  const startOffsetMs =
    index * 1_500_000 + Math.floor(rng() * 600_000); // ~25min per index + jitter
  const startedDate = new Date(asOf.getTime() - startOffsetMs);
  const started_at = isoFromDate(startedDate);

  // duration_ms: 1s..30min
  const duration_ms =
    1_000 + Math.floor(rng() * (30 * 60_000 - 1_000));

  let finished_at: string | null = null;
  if (status !== 'running' && status !== 'queued') {
    finished_at = isoFromDate(
      new Date(startedDate.getTime() + duration_ms),
    );
  }

  // sla_minutes is per-pipeline; we approximate via a deterministic per-run
  // SLA pool drawn from common values; sla_met is computed against it
  const slaCandidates = [15, 30, 60, 120, 240];
  const sla_minutes_for_run =
    slaCandidates[Math.floor(rng() * slaCandidates.length)];
  const sla_met =
    status !== 'running' &&
    status !== 'queued' &&
    duration_ms <= sla_minutes_for_run * 60_000;

  // records: scale by status
  let records_in = 100 + Math.floor(rng() * 100_000);
  let records_failed = 0;
  let records_out = records_in;
  if (status === 'failure') {
    records_failed = Math.floor(records_in * (0.5 + rng() * 0.5));
    records_out = records_in - records_failed;
  } else if (status === 'partial') {
    records_failed = Math.floor(records_in * (0.05 + rng() * 0.2));
    records_out = records_in - records_failed;
  } else if (status === 'success') {
    records_failed = 0;
    records_out = records_in;
  } else {
    // running / queued
    records_in = 0;
    records_out = 0;
    records_failed = 0;
  }

  const error_summary =
    status === 'failure' || status === 'partial'
      ? pickOne(rng, ERROR_SUMMARIES)
      : null;

  return {
    run_id: `RUN-${pad(index + 1, 5)}`,
    pipeline_id,
    tenant_id,
    status,
    started_at,
    finished_at,
    duration_ms,
    records_in,
    records_out,
    records_failed,
    sla_met,
    trigger,
    error_summary,
  };
}

export function listPipelineRuns(
  tenant_id: string,
  asOf?: Date,
  filters?: { pipeline_id?: string; status?: ExecutionStatus },
  limit?: number,
): PipelineRun[] {
  const when = asOf ?? new Date();
  const out: PipelineRun[] = [];
  for (let i = 0; i < RUN_COUNT_PER_TENANT; i++) {
    out.push(generateRun(tenant_id, i, when));
  }

  let filtered = out;
  if (filters) {
    filtered = out.filter((r) => {
      if (filters.pipeline_id && r.pipeline_id !== filters.pipeline_id)
        return false;
      if (filters.status && r.status !== filters.status) return false;
      return true;
    });
  }

  // newest first by started_at
  filtered.sort((a, b) => {
    if (a.started_at > b.started_at) return -1;
    if (a.started_at < b.started_at) return 1;
    return a.run_id.localeCompare(b.run_id);
  });

  const cap = typeof limit === 'number' && limit > 0 ? limit : DEFAULT_RUN_LIMIT;
  return filtered.slice(0, cap);
}

// ---------------------------------------------------------------------------
// applyPipelineAction
// ---------------------------------------------------------------------------

export function applyPipelineAction(
  pipeline: DataPipeline,
  action: PipelineAction,
  actor: string,
): DataPipeline {
  void actor; // actor is captured by callers for history; not used in pure transition

  const current = pipeline.status;

  switch (action) {
    case 'create':
      // No-op state-wise; intended for new-pipeline flow.
      return { ...pipeline };

    case 'schedule': {
      if (current !== 'idle' && current !== 'paused') {
        throw new Error('invalid_transition');
      }
      return { ...pipeline, status: 'scheduled' };
    }

    case 'execute': {
      if (
        current !== 'idle' &&
        current !== 'scheduled' &&
        current !== 'paused'
      ) {
        throw new Error('invalid_transition');
      }
      return { ...pipeline, status: 'running' };
    }

    case 'pause': {
      if (
        current !== 'idle' &&
        current !== 'scheduled' &&
        current !== 'running' &&
        current !== 'failed'
      ) {
        throw new Error('invalid_transition');
      }
      return { ...pipeline, status: 'paused' };
    }

    case 'resume': {
      if (current !== 'paused') {
        throw new Error('invalid_transition');
      }
      return { ...pipeline, status: 'idle' };
    }

    case 'retry': {
      if (current !== 'failed') {
        throw new Error('invalid_transition');
      }
      return { ...pipeline, status: 'running' };
    }

    default:
      throw new Error('invalid_transition');
  }
}

// ---------------------------------------------------------------------------
// listPipelineHistory
// ---------------------------------------------------------------------------

export function listPipelineHistory(
  pipeline_id: string,
  tenant_id: string,
  asOf?: Date,
  limit?: number,
): PipelineHistoryEntry[] {
  const when = asOf ?? new Date();
  const day = dayIndex(when);
  const seed = fnv1a(`${tenant_id}|pipeline-history|${pipeline_id}|${day}`);
  const rng = mulberry32(seed);

  const count = 4 + Math.floor(rng() * 9); // 4..12
  const entries: PipelineHistoryEntry[] = [];

  for (let i = 0; i < count; i++) {
    const action = pickOne(rng, PIPELINE_ACTIONS_HISTORY);
    const from_status = pickOne(rng, PIPELINE_STATUSES_FOR_HISTORY);
    const to_status = pickOne(rng, PIPELINE_STATUSES_FOR_HISTORY);
    const actor = pickOne(rng, OWNER_POOL);
    const note = pickOne(rng, HISTORY_NOTES) ?? null;

    // ts: progressively older as i grows
    const offsetMs =
      i * 3_600_000 + Math.floor(rng() * 1_800_000);
    const ts = isoFromDate(new Date(when.getTime() - offsetMs));

    entries.push({
      ts,
      actor,
      action,
      from_status,
      to_status,
      note,
    });
  }

  // newest first
  entries.sort((a, b) => {
    if (a.ts > b.ts) return -1;
    if (a.ts < b.ts) return 1;
    return 0;
  });

  if (typeof limit === 'number' && limit > 0) {
    return entries.slice(0, limit);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// buildPipelineOrchestratorSummary
// ---------------------------------------------------------------------------

export function buildPipelineOrchestratorSummary(
  tenant_id: string,
  asOf?: Date,
): PipelineOrchestratorSummary {
  const when = asOf ?? new Date();
  const pipelines = listPipelines(tenant_id, when);
  const runs = listPipelineRuns(tenant_id, when, undefined, RUN_COUNT_PER_TENANT);

  // status counts
  const by_status: Record<PipelineStatus, number> = {
    idle: 0,
    scheduled: 0,
    running: 0,
    paused: 0,
    failed: 0,
    success: 0,
  };
  const by_domain: Record<DataDomain, number> = {
    banking: 0,
    insurance: 0,
    common: 0,
  };

  for (const p of pipelines) {
    by_status[p.status] = (by_status[p.status] ?? 0) + 1;
    by_domain[p.domain] = (by_domain[p.domain] ?? 0) + 1;
  }

  const total_pipelines = pipelines.length;
  const scheduled_count = by_status.scheduled;
  const running_count = by_status.running;
  const paused_count = by_status.paused;
  const failed_count = by_status.failed;

  // sla_compliance_30d across runs that have a defined sla_met (i.e. not running/queued)
  const closedRuns = runs.filter(
    (r) => r.status !== 'running' && r.status !== 'queued',
  );
  const slaMetCount = closedRuns.filter((r) => r.sla_met).length;
  const sla_compliance_30d =
    closedRuns.length > 0
      ? Math.round((slaMetCount / closedRuns.length) * 10000) / 10000
      : 0;

  // avg_runtime_seconds across successful runs
  const successfulRuns = runs.filter((r) => r.status === 'success');
  let avg_runtime_seconds = 0;
  if (successfulRuns.length > 0) {
    const sumMs = successfulRuns.reduce((acc, r) => acc + r.duration_ms, 0);
    avg_runtime_seconds = Math.round(sumMs / successfulRuns.length / 1000);
  }

  // pipeline_availability_pct: pipelines not paused/failed
  const availableCount = total_pipelines - paused_count - failed_count;
  const pipeline_availability_pct =
    total_pipelines > 0
      ? Math.round((availableCount / total_pipelines) * 10000) / 100
      : 0;

  // throughput_records_24h: Σ records_out across runs in last 24h
  const cutoffMs = when.getTime() - 24 * 3_600_000;
  let throughput_records_24h = 0;
  for (const r of runs) {
    const startedMs = new Date(r.started_at).getTime();
    if (startedMs >= cutoffMs) {
      throughput_records_24h += r.records_out;
    }
  }

  return {
    tenant_id,
    generated_at: isoFromDate(when),
    total_pipelines,
    scheduled_count,
    running_count,
    paused_count,
    failed_count,
    sla_compliance_30d,
    avg_runtime_seconds,
    pipeline_availability_pct,
    throughput_records_24h,
    by_status,
    by_domain,
  };
}
