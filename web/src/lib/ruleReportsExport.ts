// web/src/lib/ruleReportsExport.ts
//
// Phase 9 T10 — Rule engine report export (CSV + PDF + Excel).
//
// Sibling of auditExport.ts / adminActivityExport.ts / authAuditExport.ts.
// Same RFC 4180 / jspdf-autotable / write-excel-file pattern so the
// project's export pipeline stays consistent across every operator-facing
// report surface.

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import writeXlsxFile from 'write-excel-file/browser';
import type { RuleEngineReport, RuleEngineReportRow } from '@/lib/api';

/** RFC 4180: only quote when the cell contains comma / quote / newline. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const RULE_REPORT_CSV_HEADERS = [
  'rule_id',
  'name',
  'family',
  'state',
  'severity',
  'version',
  'applicable_products',
  'total_alerts_12mo',
  'triggers_month',
  'triggers_week',
  'triggers_today',
  'precision_pct',
  'coverage_pct',
  'false_positive_rate',
  'officer_useful_pct',
  'avg_days_to_default',
  'status',
  'last_modified_at',
] as const;

export function rulesToCsv(rows: readonly RuleEngineReportRow[]): string {
  const header = RULE_REPORT_CSV_HEADERS.join(',');
  const body = rows.map((r) =>
    RULE_REPORT_CSV_HEADERS.map((col) => {
      if (col === 'applicable_products') {
        return csvCell(r.applicable_products.join('|'));
      }
      return csvCell((r as unknown as Record<string, unknown>)[col]);
    }).join(','),
  );
  return [header, ...body].join('\r\n') + '\r\n';
}

export function downloadRulesCsv(
  rows: readonly RuleEngineReportRow[],
  filenameStem = 'rule-engine-report',
): void {
  const blob = new Blob([rulesToCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameStem}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function buildRulesPdf(report: RuleEngineReport): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  doc.setFontSize(16);
  doc.text('Rule Engine Report', 40, 40);
  doc.setFontSize(10);
  doc.text(`Tenant: ${report.tenant_id}`, 40, 58);
  doc.text(`Generated: ${report.generated_at}`, 40, 72);
  doc.text(
    `Rules: ${report.total_rules}  ·  Active: ${report.total_active_rules}  ·  Alerts 12mo: ${report.total_alerts_12mo}  ·  Triggers this month: ${report.triggers_month_total}`,
    40,
    86,
  );
  doc.text(
    `Mean precision: ${report.mean_precision_pct ?? '—'}%  ·  Mean coverage: ${report.mean_coverage_pct ?? '—'}%  ·  Mean FP rate: ${report.mean_false_positive_rate ?? '—'}%`,
    40,
    100,
  );

  // ── Cohort summary section ──────────────────────────────────────
  const cohortRows: Array<[string, string]> = [
    ['By state', Object.entries(report.by_state).map(([k, v]) => `${k}=${v}`).join('  ·  ')],
    ['By family', Object.entries(report.by_family).map(([k, v]) => `${k}=${v}`).join('  ·  ')],
    ['By severity', Object.entries(report.by_severity).map(([k, v]) => `${k}=${v}`).join('  ·  ')],
    [
      'By performance',
      Object.entries(report.by_performance_status).map(([k, v]) => `${k}=${v}`).join('  ·  '),
    ],
  ];
  autoTable(doc, {
    startY: 120,
    head: [['Cohort', 'Breakdown']],
    body: cohortRows,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [37, 99, 235] },
  });

  // ── Per-rule table ──────────────────────────────────────────────
  const tableRows = report.rows.map((r) => [
    r.rule_id,
    r.name,
    r.family,
    r.state,
    r.severity,
    String(r.total_alerts_12mo),
    String(r.triggers_month),
    String(r.precision_pct.toFixed(1)),
    String(r.coverage_pct.toFixed(1)),
    String(r.false_positive_rate.toFixed(1)),
    r.status,
  ]);
  autoTable(doc, {
    head: [
      [
        'Rule',
        'Name',
        'Family',
        'State',
        'Severity',
        'Alerts (12mo)',
        'This month',
        'Precision %',
        'Coverage %',
        'FP rate %',
        'Status',
      ],
    ],
    body: tableRows,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [37, 99, 235] },
  });
  return doc;
}

export function downloadRulesPdf(
  report: RuleEngineReport,
  filenameStem = 'rule-engine-report',
): void {
  const doc = buildRulesPdf(report);
  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`${filenameStem}-${stamp}.pdf`);
}

// ── Excel ──────────────────────────────────────────────────────────────

interface XlsxCell {
  value: string | number | null;
  fontWeight?: 'bold';
  backgroundColor?: string;
  color?: string;
}

function header(value: string): XlsxCell {
  return { value, fontWeight: 'bold', backgroundColor: '#1e40af', color: '#ffffff' };
}

export async function downloadRulesXlsx(
  report: RuleEngineReport,
  filenameStem = 'rule-engine-report',
): Promise<void> {
  // write-excel-file/browser's strict generic narrowing rejects the
  // union-typed cells we build above. Cast via unknown — same pattern as
  // auditExport.ts.
  const summarySheet: unknown[][] = [
    [header('Field'), header('Value')],
    ['Tenant', report.tenant_id],
    ['Generated', report.generated_at],
    ['Total rules', report.total_rules],
    ['Total active rules', report.total_active_rules],
    ['Total alerts 12mo', report.total_alerts_12mo],
    ['Triggers this month', report.triggers_month_total],
    ['Mean precision %', report.mean_precision_pct ?? ''],
    ['Mean coverage %', report.mean_coverage_pct ?? ''],
    ['Mean FP rate %', report.mean_false_positive_rate ?? ''],
  ];

  const rulesSheet: unknown[][] = [
    RULE_REPORT_CSV_HEADERS.map((h) => header(h)),
    ...report.rows.map((r) => [
      r.rule_id,
      r.name,
      r.family,
      r.state,
      r.severity,
      r.version,
      r.applicable_products.join('|'),
      r.total_alerts_12mo,
      r.triggers_month,
      r.triggers_week,
      r.triggers_today,
      r.precision_pct,
      r.coverage_pct,
      r.false_positive_rate,
      r.officer_useful_pct,
      r.avg_days_to_default,
      r.status,
      r.last_modified_at,
    ]),
  ];

  const monthlySheet: unknown[][] = [
    [
      header('Month'),
      header('Total alerts'),
      header('Financial'),
      header('Behavioural'),
      header('Transaction'),
      header('Credit'),
      header('Fraud'),
    ],
    ...report.monthly_volume.map((p) => [
      p.month,
      p.total_alerts,
      p.by_family.Financial ?? 0,
      p.by_family.Behavioural ?? 0,
      p.by_family.Transaction ?? 0,
      p.by_family.Credit ?? 0,
      p.by_family.Fraud ?? 0,
    ]),
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  await writeXlsxFile(
    [summarySheet, rulesSheet, monthlySheet] as unknown as Parameters<typeof writeXlsxFile>[0],
    {
      fileName: `${filenameStem}-${stamp}.xlsx`,
      sheets: ['Summary', 'Rules', 'Monthly volume'],
    } as never,
  );
}
