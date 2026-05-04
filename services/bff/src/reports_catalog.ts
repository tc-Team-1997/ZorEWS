// services/bff/src/reports_catalog.ts
//
// T6 M12.1 — BIL reports catalog + async job tracker.
//
// Module 12 (Reports & Export) had shipped surface from T4 — synchronous
// /v1/reports/:type for snapshot/alerts/cases/rbi. What was missing for
// the BIL pitch:
//   1. A *catalog* of available reports the SPA can render as a picker
//      (regulatory vs operational vs business categories, formats,
//      schedule, regulator tag).
//   2. An *async job tracker* — submit a job, poll for completion, hold
//      the metadata in a per-tenant ledger so ops can see "who exported
//      what when".
//
// This module is purely additive on top of the existing reports/. The
// jobs API uses synthetic completion (immediate, since the underlying
// report computers are synchronous in the prototype) but the SHAPE
// matches a future async pipeline — production swaps the in-memory
// store for a queue-backed one.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type ReportFormat = 'json' | 'csv' | 'pdf' | 'xlsx';

export type ReportCategory = 'operational' | 'regulatory' | 'audit' | 'business';

export type ReportSchedule = 'manual' | 'daily' | 'weekly' | 'monthly' | 'quarterly';

export type ReportRegulator = 'RBI' | 'IRDAI' | 'INTERNAL';

export interface ReportDef {
  id: string;
  name: string;
  category: ReportCategory;
  /** When the production scheduler runs this report; 'manual' = on-demand only. */
  schedule: ReportSchedule;
  /** Required formats. Catalog expects all listed formats to be exportable. */
  supported_formats: ReportFormat[];
  /** Regulator tag when applicable — drives BIL compliance views. */
  regulator: ReportRegulator;
  description: string;
  /** Optional pointer to the underlying T4 report type when this report
   *  is a regulator-flavoured wrapper. Null when the report is
   *  catalog-defined-only (the production runner generates from raw
   *  data). */
  legacy_type: 'snapshot' | 'alerts' | 'cases' | 'rbi' | null;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ReportJobInput {
  report_id: string;
  format: ReportFormat;
  /** Optional report-specific parameters (e.g. period, customer filter). */
  parameters?: Record<string, unknown>;
}

export interface ReportJob {
  job_id: string;
  tenant_id: string;
  report_id: string;
  format: ReportFormat;
  status: JobStatus;
  requested_at: string;
  completed_at: string | null;
  requested_by: string;
  parameters: Record<string, unknown>;
  /** Download URL relative to the BFF when status === 'completed'. */
  download_url: string | null;
  /** Error message when status === 'failed'. */
  error_message: string | null;
}

export interface ReportJobFilters {
  status?: JobStatus;
  report_id?: string;
  requested_by?: string;
  page?: number;
  page_size?: number;
}

export interface ReportJobPage {
  items: ReportJob[];
  page: number;
  page_size: number;
  total: number;
}

export class ReportsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ReportsError';
  }
}

// ─── Catalog ───────────────────────────────────────────────────────────
//
// 9 BIL reports — 4 operational, 3 regulatory, 1 audit, 1 business.
// Drawn from DataNetworks-EWS-Ver1.pdf §16 (reports + exports). The
// `legacy_type` mapping reuses T4-shipped synchronous computers where
// the data shape matches; new reports declared here will get their own
// computer in M12.2+.

export const REPORTS_CATALOG: readonly ReportDef[] = [
  // operational
  {
    id: 'portfolio_snapshot_daily',
    name: 'Portfolio Snapshot — Daily',
    category: 'operational',
    schedule: 'daily',
    supported_formats: ['json', 'csv', 'pdf', 'xlsx'],
    regulator: 'INTERNAL',
    description: 'End-of-day portfolio snapshot with risk band + ECL totals',
    legacy_type: 'snapshot',
  },
  {
    id: 'alerts_activity_weekly',
    name: 'Alerts Activity — Weekly',
    category: 'operational',
    schedule: 'weekly',
    supported_formats: ['json', 'csv', 'xlsx'],
    regulator: 'INTERNAL',
    description: 'Alerts raised + closed in the week, broken down by severity',
    legacy_type: 'alerts',
  },
  {
    id: 'case_outcomes_monthly',
    name: 'Case Outcomes — Monthly',
    category: 'operational',
    schedule: 'monthly',
    supported_formats: ['json', 'csv', 'pdf', 'xlsx'],
    regulator: 'INTERNAL',
    description: 'Case lifecycle outcomes (cured / cured_temp / defaulted) by officer',
    legacy_type: 'cases',
  },
  {
    id: 'sla_breach_digest',
    name: 'SLA Breach Digest',
    category: 'operational',
    schedule: 'daily',
    supported_formats: ['json', 'csv'],
    regulator: 'INTERNAL',
    description: 'Cases that breached SLA in the last 24h with assigned officer',
    legacy_type: null,
  },

  // regulatory
  {
    id: 'rbi_quarterly_summary',
    name: 'RBI Quarterly Summary',
    category: 'regulatory',
    schedule: 'quarterly',
    supported_formats: ['json', 'csv', 'pdf', 'xlsx'],
    regulator: 'RBI',
    description: 'RBI-style sector exposure + risk-band + ECL summary for the quarter',
    legacy_type: 'rbi',
  },
  {
    id: 'irdai_claims_quarterly',
    name: 'IRDAI Claims — Quarterly',
    category: 'regulatory',
    schedule: 'quarterly',
    supported_formats: ['json', 'csv', 'pdf', 'xlsx'],
    regulator: 'IRDAI',
    description: 'BIL claims volume, settlement TAT, repudiation rates per IRDAI template',
    legacy_type: null,
  },
  {
    id: 'irdai_solvency_monthly',
    name: 'IRDAI Solvency — Monthly',
    category: 'regulatory',
    schedule: 'monthly',
    supported_formats: ['json', 'pdf', 'xlsx'],
    regulator: 'IRDAI',
    description: 'BIL solvency margin + reserve position, IRDAI Form-K aligned',
    legacy_type: null,
  },

  // audit
  {
    id: 'audit_compliance_dump',
    name: 'Audit & Compliance Dump',
    category: 'audit',
    schedule: 'manual',
    supported_formats: ['json', 'csv'],
    regulator: 'INTERNAL',
    description: 'On-demand audit-trail extract for a date range — RBI/IRDAI evidence',
    legacy_type: null,
  },

  // business
  {
    id: 'agent_productivity_monthly',
    name: 'Agent Productivity — Monthly',
    category: 'business',
    schedule: 'monthly',
    supported_formats: ['json', 'csv', 'xlsx'],
    regulator: 'INTERNAL',
    description: 'BIL agent league-table: premium, persistency, cancellation, lapse',
    legacy_type: null,
  },
];

const CATALOG_BY_ID = new Map<string, ReportDef>(REPORTS_CATALOG.map((d) => [d.id, d]));

export function listReportDefs(filter?: { category?: ReportCategory; regulator?: ReportRegulator }): ReportDef[] {
  let arr = [...REPORTS_CATALOG];
  if (filter?.category) arr = arr.filter((d) => d.category === filter.category);
  if (filter?.regulator) arr = arr.filter((d) => d.regulator === filter.regulator);
  return arr;
}

export function getReportDef(id: string): ReportDef | null {
  return CATALOG_BY_ID.get(id) ?? null;
}

const VALID_FORMATS: ReportFormat[] = ['json', 'csv', 'pdf', 'xlsx'];
const VALID_CATEGORIES: ReportCategory[] = ['operational', 'regulatory', 'audit', 'business'];
const VALID_REGULATORS: ReportRegulator[] = ['RBI', 'IRDAI', 'INTERNAL'];
const VALID_STATUSES: JobStatus[] = ['queued', 'running', 'completed', 'failed'];

export function isReportFormat(s: unknown): s is ReportFormat {
  return typeof s === 'string' && VALID_FORMATS.includes(s as ReportFormat);
}
export function isReportCategory(s: unknown): s is ReportCategory {
  return typeof s === 'string' && VALID_CATEGORIES.includes(s as ReportCategory);
}
export function isReportRegulator(s: unknown): s is ReportRegulator {
  return typeof s === 'string' && VALID_REGULATORS.includes(s as ReportRegulator);
}
export function isJobStatus(s: unknown): s is JobStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as JobStatus);
}

// ─── Job store ─────────────────────────────────────────────────────────

export interface ReportJobStore {
  /** Submit a new job. Validates report_id + format. Throws ReportsError. */
  submit(tenant_id: string, input: ReportJobInput, requested_by: string, now: Date): ReportJob;
  /** Single job. Returns null when not found / wrong tenant. */
  get(tenant_id: string, job_id: string): ReportJob | null;
  /** Paginated list with filters. Newest-first. */
  list(tenant_id: string, filters: ReportJobFilters): ReportJobPage;
  /** Test/admin helper — mark a queued/running job as failed. */
  markFailed(tenant_id: string, job_id: string, error_message: string): ReportJob;
}

export class InMemoryReportJobStore implements ReportJobStore {
  private readonly jobs = new Map<string, ReportJob[]>();
  private readonly cap: number;

  constructor(opts: { cap?: number } = {}) {
    this.cap = opts.cap ?? 500;
  }

  submit(
    tenant_id: string,
    input: ReportJobInput,
    requested_by: string,
    now: Date,
  ): ReportJob {
    if (!input || typeof input !== 'object') {
      throw new ReportsError('invalid_input', 'request body required');
    }
    const def = getReportDef(input.report_id);
    if (!def) {
      throw new ReportsError('unknown_report', `unknown report_id: ${input.report_id}`);
    }
    if (!isReportFormat(input.format)) {
      throw new ReportsError(
        'invalid_format',
        `format must be one of ${VALID_FORMATS.join(',')}`,
      );
    }
    if (!def.supported_formats.includes(input.format)) {
      throw new ReportsError(
        'unsupported_format',
        `${input.report_id} does not support format ${input.format}`,
      );
    }

    const job_id = `rj-${randomUUID()}`;
    const ts = now.toISOString();
    const job: ReportJob = {
      job_id,
      tenant_id,
      report_id: input.report_id,
      format: input.format,
      // The prototype generator is synchronous, so we mark complete
      // immediately. Production: 'queued', then a worker flips to
      // 'running' and 'completed'.
      status: 'completed',
      requested_at: ts,
      completed_at: ts,
      requested_by,
      parameters: input.parameters ?? {},
      download_url: `/v1/reports/jobs/${job_id}/download`,
      error_message: null,
    };
    let arr = this.jobs.get(tenant_id);
    if (!arr) {
      arr = [];
      this.jobs.set(tenant_id, arr);
    }
    arr.push(job);
    if (arr.length > this.cap) {
      arr.splice(0, arr.length - this.cap);
    }
    return job;
  }

  get(tenant_id: string, job_id: string): ReportJob | null {
    const arr = this.jobs.get(tenant_id) ?? [];
    return arr.find((j) => j.job_id === job_id) ?? null;
  }

  list(tenant_id: string, filters: ReportJobFilters): ReportJobPage {
    const arr = this.jobs.get(tenant_id) ?? [];
    const filtered = arr.filter((j) => {
      if (filters.status !== undefined && j.status !== filters.status) return false;
      if (filters.report_id !== undefined && j.report_id !== filters.report_id) return false;
      if (filters.requested_by !== undefined && j.requested_by !== filters.requested_by) return false;
      return true;
    });
    const page = Math.max(1, filters.page ?? 1);
    const page_size = Math.max(1, Math.min(200, filters.page_size ?? 50));
    const sorted = [...filtered].reverse();
    const start = (page - 1) * page_size;
    return {
      items: sorted.slice(start, start + page_size),
      page,
      page_size,
      total: filtered.length,
    };
  }

  markFailed(tenant_id: string, job_id: string, error_message: string): ReportJob {
    const arr = this.jobs.get(tenant_id) ?? [];
    const idx = arr.findIndex((j) => j.job_id === job_id);
    if (idx === -1) {
      throw new ReportsError('unknown_job', `unknown job_id: ${job_id}`);
    }
    const updated: ReportJob = {
      ...arr[idx]!,
      status: 'failed',
      download_url: null,
      error_message,
    };
    arr[idx] = updated;
    return updated;
  }

  /** Test helper. */
  reset(): void {
    this.jobs.clear();
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultReportJobStore: ReportJobStore = new InMemoryReportJobStore();
