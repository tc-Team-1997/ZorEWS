// services/bff/src/reports/types.ts
//
// Report envelopes returned by /v1/reports/*. Each report carries a
// generated_at timestamp + the period it covers so the SPA can show
// "as-of" context. CSV download uses the same data shape — the serializer
// flattens whichever array the report exposes.

export type ReportType = 'snapshot' | 'alerts' | 'cases' | 'rbi';
export type ReportPeriod = 'week' | 'month' | 'quarter';

export interface ReportMeta {
  type: ReportType;
  period: ReportPeriod;
  /** ISO timestamp when the report was computed. */
  generated_at: string;
  /** ISO date of the period start (inclusive). */
  period_start: string;
  /** ISO date of the period end (inclusive). */
  period_end: string;
}

// ── Snapshot ──────────────────────────────────────────────────────────────

export interface PortfolioSnapshot extends ReportMeta {
  type: 'snapshot';
  customers_monitored: number;
  high_risk_customers: number;
  high_risk_pct: number;
  total_exposure_kes: number;
  alerts_open: number;
  cases_in_progress: number;
  /** IFRS 9 stage counts. Stage 1 = performing, Stage 2 = SICR, Stage 3 = NPA. */
  stage_distribution: { stage_1: number; stage_2: number; stage_3: number };
  /** Estimated 12-month expected credit loss across the book (KES). */
  expected_credit_loss_kes: number;
  /** Non-performing-asset percentage (Stage 3 share of accounts). */
  npa_pct: number;
}

// ── Alerts activity ───────────────────────────────────────────────────────

export interface AlertActivityReport extends ReportMeta {
  type: 'alerts';
  /** Counts of alerts raised in the period, by severity. */
  raised_by_severity: { critical: number; high: number; medium: number; low: number };
  raised_total: number;
  closed_total: number;
  avg_minutes_to_ack: number;
  avg_minutes_to_close: number;
  /** Top firing rules in the period. Limit 5. */
  top_rules: { rule_id: string; rule_name: string; firings: number }[];
  /** Open alerts at end of period. */
  open_at_end: number;
}

// ── Case outcomes ─────────────────────────────────────────────────────────

export interface CaseOutcomesReport extends ReportMeta {
  type: 'cases';
  cases_opened: number;
  cases_closed: number;
  /** Closed cases broken down by outcome. */
  outcomes: { cured: number; cured_temp: number; defaulted: number };
  /** Average time-to-close in days, across closed cases in the period. */
  avg_days_to_close: number;
  /** Top officers by closed-case count. Limit 5. */
  top_officers: { officer_id: string; cases_closed: number }[];
  /** Per-product breakdown of cases closed in period. */
  product_breakdown: { product: string; cases_closed: number }[];
}

// ── RBI-style summary ─────────────────────────────────────────────────────

export interface RbiSummaryReport extends ReportMeta {
  type: 'rbi';
  sector_exposure: { sector: string; exposure_kes: number; share_pct: number }[];
  risk_band_distribution: {
    band: 'low' | 'medium' | 'high';
    accounts: number;
    share_pct: number;
  }[];
  ecl_kes: number;
  ecl_qoq_delta_kes: number;
  npa_pct: number;
  /** Top 5 single-name concentrations (largest exposures). */
  top_concentrations: { customer_id: string; name: string; exposure_kes: number }[];
}

export type ReportPayload =
  | PortfolioSnapshot
  | AlertActivityReport
  | CaseOutcomesReport
  | RbiSummaryReport;
