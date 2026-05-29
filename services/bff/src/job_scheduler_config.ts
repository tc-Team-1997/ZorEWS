// services/bff/src/job_scheduler_config.ts
//
// Configuration — Job & Scheduler Config (MASTER SETUP spec screen #19).
//
// A single consolidated registry of every SCHEDULED JOB on the platform —
// the doc's fields: Job_Name · Frequency · Last_Run_Status. Today these jobs
// live scattered across separate surfaces:
//   - ingestion connectors (M3.1)         · feed pulls
//   - report schedules (M12.2)            · recurring reports
//   - AI retraining schedules (T5.1.1)    · model retrain cadence
//   - escalation-worker tick               · SLA escalation sweep
//   - dbt / mart refresh, DQ runs, drift   · data-plane DAGs
// This module is the unified ops view + control surface (enable/disable,
// change frequency, run-now) a real scheduler (Airflow/cron) would back.
//
// Mirrors the M3.1 ingestion-connector registry shape (status + run history +
// pause/resume/run-now) generalised to ALL platform jobs. In-memory +
// deterministic seed; env-gated pg swap target
// (data/schema/048_job_scheduler_config.sql). No existing route/table touched.

// ─── Deterministic synthesis (FNV-1a + Mulberry32) ───────────────────

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DAY_MS = 86_400_000;

// ─── Enums ───────────────────────────────────────────────────────────

export const ALL_JOB_CATEGORIES = ['ingestion', 'reporting', 'ml', 'workflow', 'data_quality', 'system'] as const;
export type JobCategory = (typeof ALL_JOB_CATEGORIES)[number];
export function isJobCategory(v: unknown): v is JobCategory {
  return typeof v === 'string' && (ALL_JOB_CATEGORIES as readonly string[]).includes(v);
}

// Cadences the platform schedules on. realtime = continuous stream.
export const ALL_JOB_FREQUENCIES = [
  'realtime',
  'every_5min',
  'every_15min',
  'hourly',
  'every_6h',
  'daily',
  'weekly',
  'monthly',
] as const;
export type JobFrequency = (typeof ALL_JOB_FREQUENCIES)[number];
export function isJobFrequency(v: unknown): v is JobFrequency {
  return typeof v === 'string' && (ALL_JOB_FREQUENCIES as readonly string[]).includes(v);
}
const FREQUENCY_MINUTES: Record<JobFrequency, number> = {
  realtime: 1,
  every_5min: 5,
  every_15min: 15,
  hourly: 60,
  every_6h: 360,
  daily: 1440,
  weekly: 10080,
  monthly: 43200,
};

export const ALL_JOB_RUN_STATUSES = ['success', 'failure', 'partial', 'running', 'never_run'] as const;
export type JobRunStatus = (typeof ALL_JOB_RUN_STATUSES)[number];
export function isJobRunStatus(v: unknown): v is JobRunStatus {
  return typeof v === 'string' && (ALL_JOB_RUN_STATUSES as readonly string[]).includes(v);
}

export type JobCategoryFilter = JobCategory | 'all';
export type JobStatusFilter = JobRunStatus | 'all';

// ─── Shapes ──────────────────────────────────────────────────────────

export interface ScheduledJob {
  job_id: string;
  tenant_id: string;
  name: string;
  category: JobCategory;
  description: string;
  owner_service: string;
  frequency: JobFrequency;
  enabled: boolean;
  last_run_status: JobRunStatus;
  last_run_at: string | null;
  last_run_duration_ms: number | null;
  consecutive_failures: number;
  next_run_at: string | null; // null when disabled
  updated_at: string;
}

export interface JobSchedulerSummary {
  tenant_id: string;
  generated_at: string;
  total_jobs: number;
  enabled_count: number;
  disabled_count: number;
  by_category: Record<JobCategory, number>;
  by_status: Record<JobRunStatus, number>;
  failing_count: number; // last_run_status === 'failure'
  overdue_count: number; // enabled + next_run_at < now
  attention_required: { job_id: string; name: string; reason: string }[];
}

export interface JobRunResult {
  job_id: string;
  status: JobRunStatus;
  ran_at: string;
  duration_ms: number;
  triggered_by: string;
}

// ─── Run telemetry (execution log) ───────────────────────────────────

export interface JobRunLogEntry {
  run_id: string;
  job_id: string;
  status: JobRunStatus;
  triggered_by: string; // 'scheduler' for synthesised history, the actor for run-now
  ran_at: string;
  duration_ms: number;
}

export interface JobRunStats {
  job_id: string;
  total_runs: number;
  by_status: Record<JobRunStatus, number>;
  // success / (success + partial + failure) — terminal runs only; null when none
  success_rate: number | null;
  mean_duration_ms: number | null; // over terminal runs; null when none
  last_run_at: string | null;
  last_status: JobRunStatus | null;
}

export const JOB_RUN_LOG_CAP = 50;

// ─── Error ───────────────────────────────────────────────────────────

export type JobSchedulerConfigErrorCode = 'invalid_input' | 'invalid_frequency' | 'unknown_job';
export class JobSchedulerConfigError extends Error {
  constructor(public code: JobSchedulerConfigErrorCode, message: string) {
    super(message);
    this.name = 'JobSchedulerConfigError';
  }
}

// ─── Seed (the platform's real scheduled jobs) ───────────────────────

interface SeedJob {
  key: string;
  name: string;
  category: JobCategory;
  description: string;
  owner_service: string;
  frequency: JobFrequency;
  never_run?: boolean; // Year-2 DAGs not yet wired
}
const SEED: SeedJob[] = [
  { key: 'CBS_INGESTION', name: 'CBS Ingestion DAG', category: 'ingestion', description: 'Loan / repayment / account event pull from CBS', owner_service: 'pipeline-svc', frequency: 'hourly' },
  { key: 'BUREAU_SYNC', name: 'Bureau Sync DAG', category: 'ingestion', description: 'External bureau score refresh', owner_service: 'pipeline-svc', frequency: 'weekly' },
  { key: 'FEATURE_BUILD', name: 'Feature Build DAG', category: 'data_quality', description: 'dbt mart refresh + feature materialisation', owner_service: 'pipeline-svc', frequency: 'daily' },
  { key: 'FEATURE_STORE_BACKFILL', name: 'Feature Store Backfill DAG', category: 'ml', description: '24-mo feature-store backfill + S3 offline sync', owner_service: 'pipeline-svc', frequency: 'daily', never_run: true },
  { key: 'PD_RETRAINING', name: 'PD Retraining Scheduler', category: 'ml', description: 'Model retrain cadence + auto-promotion gate', owner_service: 'ai-copilot-svc', frequency: 'every_6h' },
  { key: 'DRIFT_MONITOR', name: 'Drift Monitor', category: 'ml', description: 'PSI / KS drift sweep over production models', owner_service: 'ai-copilot-svc', frequency: 'daily' },
  { key: 'REPORT_SCHEDULES', name: 'Report Scheduler Tick', category: 'reporting', description: 'Fires due recurring report jobs', owner_service: 'bff', frequency: 'every_15min' },
  { key: 'ESCALATION_WORKER', name: 'Escalation Worker Tick', category: 'workflow', description: 'SLA-breach auto-escalation sweep over open cases', owner_service: 'regulatory-svc', frequency: 'every_5min' },
  { key: 'DQ_EXECUTIONS', name: 'Data Quality Run', category: 'data_quality', description: 'Validation-rule execution + DQ score refresh', owner_service: 'pipeline-svc', frequency: 'every_6h' },
  { key: 'AUDIT_RETENTION', name: 'Audit Retention Sweep', category: 'system', description: 'WORM audit retention + S3 lifecycle enforcement', owner_service: 'audit-svc', frequency: 'daily' },
  { key: 'STREAMING_INGEST', name: 'Streaming Indicator Ingest', category: 'ingestion', description: 'Real-time indicator-event → alert path', owner_service: 'regulatory-svc', frequency: 'realtime' },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Deterministic last-run synthesis per (tenant, job, day): ~84% success,
// 8% partial, 5% failure, 3% running. Stable across reads within a day.
function synthLastRun(tenant: string, key: string, nowMs: number): { status: JobRunStatus; at: string; duration_ms: number; consecutive_failures: number } {
  const day = Math.floor(nowMs / DAY_MS);
  const rng = mulberry32(fnv1a(`${tenant}|job|${key}|${day}`));
  const roll = rng();
  const status: JobRunStatus = roll < 0.84 ? 'success' : roll < 0.92 ? 'partial' : roll < 0.97 ? 'failure' : 'running';
  // last_run_at within the trailing few hours.
  const at = new Date(nowMs - Math.floor(rng() * 6 * 3_600_000)).toISOString();
  const duration_ms = 200 + Math.floor(rng() * 9800);
  const consecutive_failures = status === 'failure' ? 1 + Math.floor(rng() * 3) : 0;
  return { status, at, duration_ms, consecutive_failures };
}

function computeNextRun(frequency: JobFrequency, fromMs: number): string {
  return new Date(fromMs + FREQUENCY_MINUTES[frequency] * 60_000).toISOString();
}

// ─── Store ───────────────────────────────────────────────────────────

export class InMemoryJobSchedulerStore {
  private byTenant = new Map<string, ScheduledJob[]>();
  private runLog = new Map<string, JobRunLogEntry[]>(); // ck → newest-first

  // Lazily synthesise a job's recent run history. The NEWEST entry mirrors the
  // job's current last_run_* (so the drill-down's top row matches the table),
  // and older entries step back by the job's frequency interval — giving the
  // SPA telemetry view a populated, internally-consistent history on first
  // open. `runNow` prepends real entries on top. never_run jobs → empty log.
  private seededRuns(tenant: string, job_id: string, nowMs: number): JobRunLogEntry[] {
    const ck = `${tenant}|${job_id}`;
    const existing = this.runLog.get(ck);
    if (existing) return existing;
    const job = this.seeded(tenant, nowMs).find((r) => r.job_id === job_id);
    const log: JobRunLogEntry[] = [];
    if (job && job.last_run_at !== null) {
      log.push({
        run_id: `${job_id}-h0`,
        job_id,
        status: job.last_run_status,
        triggered_by: 'scheduler',
        ran_at: job.last_run_at,
        duration_ms: job.last_run_duration_ms ?? 0,
      });
      const stepMs = FREQUENCY_MINUTES[job.frequency] * 60_000;
      let t = Date.parse(job.last_run_at);
      for (let i = 1; i < 8; i++) {
        t -= stepMs;
        const rng = mulberry32(fnv1a(`${ck}|hist|${i}`));
        const roll = rng();
        // historical runs are terminal (no 'running'): 84% success / 8% partial / 8% failure
        const status: JobRunStatus = roll < 0.84 ? 'success' : roll < 0.92 ? 'partial' : 'failure';
        log.push({
          run_id: `${job_id}-h${i}`,
          job_id,
          status,
          triggered_by: 'scheduler',
          ran_at: new Date(t).toISOString(),
          duration_ms: 200 + Math.floor(rng() * 9800),
        });
      }
    }
    this.runLog.set(ck, log);
    return log;
  }

  // Recent run history, newest-first. Validates the job exists. limit 1..JOB_RUN_LOG_CAP.
  listRuns(tenant: string, job_id: string, nowMs: number, limit = 20): JobRunLogEntry[] {
    const job = this.seeded(tenant, nowMs).find((r) => r.job_id === job_id);
    if (!job) throw new JobSchedulerConfigError('unknown_job', `unknown job '${job_id}'`);
    const n = Math.max(1, Math.min(JOB_RUN_LOG_CAP, Math.floor(Number.isFinite(limit) ? limit : 20)));
    return this.seededRuns(tenant, job_id, nowMs).slice(0, n).map((e) => structuredClone(e));
  }

  // Aggregate run stats over the full log. Validates the job exists.
  runStats(tenant: string, job_id: string, nowMs: number): JobRunStats {
    const job = this.seeded(tenant, nowMs).find((r) => r.job_id === job_id);
    if (!job) throw new JobSchedulerConfigError('unknown_job', `unknown job '${job_id}'`);
    const log = this.seededRuns(tenant, job_id, nowMs);
    const by_status: Record<JobRunStatus, number> = { success: 0, failure: 0, partial: 0, running: 0, never_run: 0 };
    let terminal = 0;
    let durationSum = 0;
    for (const e of log) {
      by_status[e.status]++;
      if (e.status === 'success' || e.status === 'partial' || e.status === 'failure') {
        terminal++;
        durationSum += e.duration_ms;
      }
    }
    return {
      job_id,
      total_runs: log.length,
      by_status,
      success_rate: terminal === 0 ? null : round2(by_status.success / terminal),
      mean_duration_ms: terminal === 0 ? null : Math.round(durationSum / terminal),
      last_run_at: log.length > 0 ? log[0].ran_at : null,
      last_status: log.length > 0 ? log[0].status : null,
    };
  }

  private seeded(tenant: string, nowMs: number): ScheduledJob[] {
    let rows = this.byTenant.get(tenant);
    if (rows) return rows;
    rows = SEED.map((s) => {
      const run = s.never_run ? null : synthLastRun(tenant, s.key, nowMs);
      return {
        job_id: `job-${tenant}-${s.key}`,
        tenant_id: tenant,
        name: s.name,
        category: s.category,
        description: s.description,
        owner_service: s.owner_service,
        frequency: s.frequency,
        enabled: true,
        last_run_status: run ? run.status : 'never_run',
        last_run_at: run ? run.at : null,
        last_run_duration_ms: run ? run.duration_ms : null,
        consecutive_failures: run ? run.consecutive_failures : 0,
        next_run_at: computeNextRun(s.frequency, nowMs),
        updated_at: new Date(nowMs).toISOString(),
      };
    });
    this.byTenant.set(tenant, rows);
    return rows;
  }

  list(tenant: string, nowMs: number, category: JobCategoryFilter = 'all', status: JobStatusFilter = 'all', enabledOnly = false): ScheduledJob[] {
    return this.seeded(tenant, nowMs)
      .filter(
        (j) =>
          (category === 'all' || j.category === category) &&
          (status === 'all' || j.last_run_status === status) &&
          (!enabledOnly || j.enabled),
      )
      .slice()
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
      .map((j) => structuredClone(j));
  }

  get(tenant: string, job_id: string, nowMs: number): ScheduledJob | null {
    const j = this.seeded(tenant, nowMs).find((r) => r.job_id === job_id);
    return j ? structuredClone(j) : null;
  }

  setEnabled(tenant: string, job_id: string, enabled: boolean, nowMs: number): ScheduledJob {
    if (typeof enabled !== 'boolean') throw new JobSchedulerConfigError('invalid_input', 'enabled must be boolean');
    const j = this.seeded(tenant, nowMs).find((r) => r.job_id === job_id);
    if (!j) throw new JobSchedulerConfigError('unknown_job', `unknown job '${job_id}'`);
    j.enabled = enabled;
    j.next_run_at = enabled ? computeNextRun(j.frequency, nowMs) : null;
    j.updated_at = new Date(nowMs).toISOString();
    return structuredClone(j);
  }

  setFrequency(tenant: string, job_id: string, frequency: unknown, nowMs: number): ScheduledJob {
    if (!isJobFrequency(frequency)) throw new JobSchedulerConfigError('invalid_frequency', `unknown frequency '${String(frequency)}'`);
    const j = this.seeded(tenant, nowMs).find((r) => r.job_id === job_id);
    if (!j) throw new JobSchedulerConfigError('unknown_job', `unknown job '${job_id}'`);
    j.frequency = frequency;
    if (j.enabled) j.next_run_at = computeNextRun(frequency, nowMs);
    j.updated_at = new Date(nowMs).toISOString();
    return structuredClone(j);
  }

  // Manual run-now trigger. Records a fresh run (deterministic outcome seeded
  // by run-count so repeated triggers don't all return the same status) and
  // advances next_run_at. Disabled jobs cannot be triggered.
  private runCounter = new Map<string, number>();
  runNow(tenant: string, job_id: string, triggeredBy: string, nowMs: number): JobRunResult {
    const j = this.seeded(tenant, nowMs).find((r) => r.job_id === job_id);
    if (!j) throw new JobSchedulerConfigError('unknown_job', `unknown job '${job_id}'`);
    if (!j.enabled) throw new JobSchedulerConfigError('invalid_input', 'cannot run a disabled job');
    const ck = `${tenant}|${job_id}`;
    const n = (this.runCounter.get(ck) ?? 0) + 1;
    this.runCounter.set(ck, n);
    const rng = mulberry32(fnv1a(`${ck}|run|${n}`));
    const roll = rng();
    const status: JobRunStatus = roll < 0.88 ? 'success' : roll < 0.95 ? 'partial' : 'failure';
    const duration_ms = 200 + Math.floor(rng() * 9800);
    const ran_at = new Date(nowMs).toISOString();
    j.last_run_status = status;
    j.last_run_at = ran_at;
    j.last_run_duration_ms = duration_ms;
    j.consecutive_failures = status === 'failure' ? j.consecutive_failures + 1 : 0;
    j.next_run_at = computeNextRun(j.frequency, nowMs);
    j.updated_at = ran_at;
    // Append to the execution log (newest-first, capped). Seed history first so
    // the run-now entry sits atop the synthesised past.
    const log = this.seededRuns(tenant, job_id, nowMs);
    log.unshift({ run_id: `${job_id}-r${n}`, job_id, status, triggered_by: triggeredBy, ran_at, duration_ms });
    if (log.length > JOB_RUN_LOG_CAP) log.length = JOB_RUN_LOG_CAP;
    return { job_id, status, ran_at, duration_ms: round2(duration_ms), triggered_by: triggeredBy };
  }

  summary(tenant: string, nowMs: number): JobSchedulerSummary {
    const rows = this.seeded(tenant, nowMs);
    const by_category: Record<JobCategory, number> = { ingestion: 0, reporting: 0, ml: 0, workflow: 0, data_quality: 0, system: 0 };
    const by_status: Record<JobRunStatus, number> = { success: 0, failure: 0, partial: 0, running: 0, never_run: 0 };
    const attention_required: { job_id: string; name: string; reason: string }[] = [];
    let enabled_count = 0;
    let overdue_count = 0;
    for (const j of rows) {
      by_category[j.category]++;
      by_status[j.last_run_status]++;
      if (j.enabled) enabled_count++;
      const overdue = j.enabled && j.next_run_at != null && Date.parse(j.next_run_at) < nowMs;
      if (overdue) overdue_count++;
      if (j.last_run_status === 'failure') {
        attention_required.push({ job_id: j.job_id, name: j.name, reason: `last run failed (${j.consecutive_failures} consecutive)` });
      } else if (overdue) {
        attention_required.push({ job_id: j.job_id, name: j.name, reason: 'overdue — next run is in the past' });
      }
    }
    // Worst-first: failures before overdue (failures already pushed first by loop order is not guaranteed,
    // so sort by reason kind then name).
    attention_required.sort((a, b) => {
      const af = a.reason.startsWith('last run failed') ? 0 : 1;
      const bf = b.reason.startsWith('last run failed') ? 0 : 1;
      return af - bf || a.name.localeCompare(b.name);
    });
    return {
      tenant_id: tenant,
      generated_at: new Date(nowMs).toISOString(),
      total_jobs: rows.length,
      enabled_count,
      disabled_count: rows.length - enabled_count,
      by_category,
      by_status,
      failing_count: by_status.failure,
      overdue_count,
      attention_required,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────

export const defaultJobSchedulerStore = new InMemoryJobSchedulerStore();
export function _resetJobSchedulerStore(): void {
  const fresh = new InMemoryJobSchedulerStore();
  const target = defaultJobSchedulerStore as unknown as { byTenant: Map<string, unknown>; runCounter: Map<string, unknown>; runLog: Map<string, unknown> };
  const src = fresh as unknown as { byTenant: Map<string, unknown>; runCounter: Map<string, unknown>; runLog: Map<string, unknown> };
  target.byTenant = src.byTenant;
  target.runCounter = src.runCounter;
  target.runLog = src.runLog;
}
