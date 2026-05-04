// services/bff/src/reports/csv.ts
//
// Flat CSV serializer for report payloads. Each report type has its own
// flattening rule so the downloaded file matches what the SPA shows on
// screen. RFC 4180 quoting — wrap any cell that contains comma, quote or
// newline in double-quotes and escape internal quotes.

import type {
  AlertActivityReport,
  CaseOutcomesReport,
  PortfolioSnapshot,
  RbiSummaryReport,
  ReportPayload,
} from './types';

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const r of rows) lines.push(r.map(escapeCell).join(','));
  return lines.join('\n');
}

function snapshotCsv(r: PortfolioSnapshot): string {
  return rowsToCsv(
    ['metric', 'value'],
    [
      ['report_type', r.type],
      ['period', r.period],
      ['generated_at', r.generated_at],
      ['period_start', r.period_start],
      ['period_end', r.period_end],
      ['customers_monitored', r.customers_monitored],
      ['high_risk_customers', r.high_risk_customers],
      ['high_risk_pct', r.high_risk_pct],
      ['total_exposure_kes', r.total_exposure_kes],
      ['alerts_open', r.alerts_open],
      ['cases_in_progress', r.cases_in_progress],
      ['stage_1_count', r.stage_distribution.stage_1],
      ['stage_2_count', r.stage_distribution.stage_2],
      ['stage_3_count', r.stage_distribution.stage_3],
      ['expected_credit_loss_kes', r.expected_credit_loss_kes],
      ['npa_pct', r.npa_pct],
    ],
  );
}

function alertActivityCsv(r: AlertActivityReport): string {
  const summary = rowsToCsv(
    ['metric', 'value'],
    [
      ['report_type', r.type],
      ['period', r.period],
      ['generated_at', r.generated_at],
      ['period_start', r.period_start],
      ['period_end', r.period_end],
      ['raised_total', r.raised_total],
      ['closed_total', r.closed_total],
      ['raised_critical', r.raised_by_severity.critical],
      ['raised_high', r.raised_by_severity.high],
      ['raised_medium', r.raised_by_severity.medium],
      ['raised_low', r.raised_by_severity.low],
      ['avg_minutes_to_ack', r.avg_minutes_to_ack],
      ['avg_minutes_to_close', r.avg_minutes_to_close],
      ['open_at_end', r.open_at_end],
    ],
  );
  const rules = rowsToCsv(
    ['rule_id', 'rule_name', 'firings'],
    r.top_rules.map((t) => [t.rule_id, t.rule_name, t.firings]),
  );
  return `${summary}\n\n# top rules\n${rules}`;
}

function caseOutcomesCsv(r: CaseOutcomesReport): string {
  const summary = rowsToCsv(
    ['metric', 'value'],
    [
      ['report_type', r.type],
      ['period', r.period],
      ['generated_at', r.generated_at],
      ['period_start', r.period_start],
      ['period_end', r.period_end],
      ['cases_opened', r.cases_opened],
      ['cases_closed', r.cases_closed],
      ['outcome_cured', r.outcomes.cured],
      ['outcome_cured_temp', r.outcomes.cured_temp],
      ['outcome_defaulted', r.outcomes.defaulted],
      ['avg_days_to_close', r.avg_days_to_close],
    ],
  );
  const officers = rowsToCsv(
    ['officer_id', 'cases_closed'],
    r.top_officers.map((o) => [o.officer_id, o.cases_closed]),
  );
  const products = rowsToCsv(
    ['product', 'cases_closed'],
    r.product_breakdown.map((p) => [p.product, p.cases_closed]),
  );
  return `${summary}\n\n# top officers\n${officers}\n\n# product breakdown\n${products}`;
}

function rbiCsv(r: RbiSummaryReport): string {
  const summary = rowsToCsv(
    ['metric', 'value'],
    [
      ['report_type', r.type],
      ['period', r.period],
      ['generated_at', r.generated_at],
      ['period_start', r.period_start],
      ['period_end', r.period_end],
      ['ecl_kes', r.ecl_kes],
      ['ecl_qoq_delta_kes', r.ecl_qoq_delta_kes],
      ['npa_pct', r.npa_pct],
    ],
  );
  const sectors = rowsToCsv(
    ['sector', 'exposure_kes', 'share_pct'],
    r.sector_exposure.map((s) => [s.sector, s.exposure_kes, s.share_pct]),
  );
  const bands = rowsToCsv(
    ['band', 'accounts', 'share_pct'],
    r.risk_band_distribution.map((b) => [b.band, b.accounts, b.share_pct]),
  );
  const concentrations = rowsToCsv(
    ['customer_id', 'name', 'exposure_kes'],
    r.top_concentrations.map((c) => [c.customer_id, c.name, c.exposure_kes]),
  );
  return `${summary}\n\n# sector exposure\n${sectors}\n\n# risk bands\n${bands}\n\n# top concentrations\n${concentrations}`;
}

export function reportToCsv(payload: ReportPayload): string {
  switch (payload.type) {
    case 'snapshot':
      return snapshotCsv(payload);
    case 'alerts':
      return alertActivityCsv(payload);
    case 'cases':
      return caseOutcomesCsv(payload);
    case 'rbi':
      return rbiCsv(payload);
  }
}
