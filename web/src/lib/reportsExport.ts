// web/src/lib/reportsExport.ts
//
// Client-side PDF + XLSX builders for the four /reports types
// (snapshot / alerts / cases / rbi). The MSW handler at
// `/v1/reports/:type` only produces real bytes for CSV; PDF/Excel
// historically fell back to JSON, so dev-mode downloads were corrupt.
// This module mirrors the scenarioExport.ts pattern and produces real
// bytes from the JSON payload — works both online (real BFF) and
// offline (MSW).

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import writeXlsxFile from 'write-excel-file/browser';
import type {
  AlertActivityReport,
  CaseOutcomesReport,
  PortfolioSnapshot,
  RbiSummaryReport,
  ReportPayload,
} from './api';

// write-excel-file's Cell type is not re-exported with a stable name —
// we redeclare a slim version that matches the runtime contract used in
// scenarioExport.ts (the established pattern).
type Cell = {
  value?: string | number;
  type?: typeof String | typeof Number;
  fontWeight?: 'bold';
  backgroundColor?: string;
  color?: string;
  align?: 'left' | 'right';
  format?: string;
};

// ─── Shared helpers ───────────────────────────────────────────────────

const NAVY: [number, number, number] = [13, 43, 106];

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

const HEADER: Partial<Cell> = {
  fontWeight: 'bold',
  backgroundColor: '#0d2b6a',
  color: '#ffffff',
};

function headerRow(labels: string[]): Cell[] {
  return labels.map((l) => ({ value: l, type: String, ...HEADER }));
}

function row(cells: Array<string | number>): Cell[] {
  return cells.map((c) =>
    typeof c === 'number'
      ? { value: c, type: Number }
      : { value: c, type: String },
  );
}

function fmtKes(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `KES ${(n / 1_000_000_000).toFixed(2)} Bn`;
  if (Math.abs(n) >= 1_000_000) return `KES ${(n / 1_000_000).toFixed(2)} M`;
  return `KES ${n.toLocaleString()}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function periodLabel(p: ReportPayload): string {
  return `${p.period} (${p.period_start.slice(0, 10)} – ${p.period_end.slice(0, 10)})`;
}

// ─── PDF ──────────────────────────────────────────────────────────────

export function buildReportPdf(payload: ReportPayload): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;

  doc.setFontSize(16);
  doc.text('ZorEWS — Reports', margin, margin);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`Type: ${payload.type}`, margin, margin + 16);
  doc.text(`Period: ${periodLabel(payload)}`, margin, margin + 30);
  doc.text(`Generated: ${payload.generated_at}`, margin, margin + 44);
  doc.setTextColor(0);

  const startY = margin + 70;

  if (payload.type === 'snapshot') addSnapshotPdf(doc, payload, startY);
  else if (payload.type === 'alerts') addAlertActivityPdf(doc, payload, startY);
  else if (payload.type === 'cases') addCaseOutcomesPdf(doc, payload, startY);
  else if (payload.type === 'rbi') addRbiPdf(doc, payload, startY);

  return doc;
}

export function downloadReportPdf(payload: ReportPayload): void {
  const doc = buildReportPdf(payload);
  doc.save(`${payload.type}-${payload.period}-${dateStamp()}.pdf`);
}

function addSnapshotPdf(doc: jsPDF, p: PortfolioSnapshot, startY: number): void {
  autoTable(doc, {
    startY,
    head: [['Metric', 'Value']],
    body: [
      ['Customers monitored', p.customers_monitored.toLocaleString()],
      ['High-risk customers', `${p.high_risk_customers.toLocaleString()} (${fmtPct(p.high_risk_pct)})`],
      ['Total exposure', fmtKes(p.total_exposure_kes)],
      ['Alerts open', p.alerts_open.toLocaleString()],
      ['Cases in progress', p.cases_in_progress.toLocaleString()],
      ['Expected credit loss', fmtKes(p.expected_credit_loss_kes)],
      ['NPA %', fmtPct(p.npa_pct)],
    ],
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });
  autoTable(doc, {
    head: [['IFRS 9 stage', 'Customers']],
    body: [
      ['Stage 1 (performing)', p.stage_distribution.stage_1.toLocaleString()],
      ['Stage 2 (SICR)', p.stage_distribution.stage_2.toLocaleString()],
      ['Stage 3 (NPA)', p.stage_distribution.stage_3.toLocaleString()],
    ],
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });
}

function addAlertActivityPdf(doc: jsPDF, p: AlertActivityReport, startY: number): void {
  autoTable(doc, {
    startY,
    head: [['Metric', 'Value']],
    body: [
      ['Alerts raised', p.raised_total.toLocaleString()],
      ['Alerts closed', p.closed_total.toLocaleString()],
      ['Open at end', p.open_at_end.toLocaleString()],
      ['Avg minutes to ack', p.avg_minutes_to_ack.toFixed(1)],
      ['Avg minutes to close', p.avg_minutes_to_close.toFixed(1)],
    ],
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });
  autoTable(doc, {
    head: [['Severity', 'Count']],
    body: [
      ['Critical', p.raised_by_severity.critical.toString()],
      ['High',     p.raised_by_severity.high.toString()],
      ['Medium',   p.raised_by_severity.medium.toString()],
      ['Low',      p.raised_by_severity.low.toString()],
    ],
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });
  if (p.top_rules.length) {
    autoTable(doc, {
      head: [['Rule ID', 'Rule', 'Firings']],
      body: p.top_rules.map((r) => [r.rule_id, r.rule_name, r.firings.toString()]),
      headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      theme: 'grid',
    });
  }
}

function addCaseOutcomesPdf(doc: jsPDF, p: CaseOutcomesReport, startY: number): void {
  autoTable(doc, {
    startY,
    head: [['Metric', 'Value']],
    body: [
      ['Cases opened', p.cases_opened.toLocaleString()],
      ['Cases closed', p.cases_closed.toLocaleString()],
      ['Avg days to close', p.avg_days_to_close.toFixed(1)],
      ['Cured', p.outcomes.cured.toString()],
      ['Cured (temp)', p.outcomes.cured_temp.toString()],
      ['Defaulted', p.outcomes.defaulted.toString()],
    ],
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });
  if (p.top_officers.length) {
    autoTable(doc, {
      head: [['Officer', 'Cases closed']],
      body: p.top_officers.map((o) => [o.officer_id, o.cases_closed.toString()]),
      headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      theme: 'grid',
    });
  }
  if (p.product_breakdown.length) {
    autoTable(doc, {
      head: [['Product', 'Cases closed']],
      body: p.product_breakdown.map((x) => [x.product, x.cases_closed.toString()]),
      headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      theme: 'grid',
    });
  }
}

function addRbiPdf(doc: jsPDF, p: RbiSummaryReport, startY: number): void {
  autoTable(doc, {
    startY,
    head: [['Metric', 'Value']],
    body: [
      ['ECL (current)', fmtKes(p.ecl_kes)],
      ['ECL Q-o-Q delta', fmtKes(p.ecl_qoq_delta_kes)],
      ['NPA %', fmtPct(p.npa_pct)],
    ],
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });
  autoTable(doc, {
    head: [['Sector', 'Exposure', 'Share']],
    body: p.sector_exposure.map((s) => [s.sector, fmtKes(s.exposure_kes), fmtPct(s.share_pct)]),
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });
  autoTable(doc, {
    head: [['Risk band', 'Accounts', 'Share']],
    body: p.risk_band_distribution.map((b) => [b.band, b.accounts.toString(), fmtPct(b.share_pct)]),
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    theme: 'grid',
  });
  if (p.top_concentrations.length) {
    autoTable(doc, {
      head: [['Customer ID', 'Name', 'Exposure']],
      body: p.top_concentrations.map((c) => [c.customer_id, c.name, fmtKes(c.exposure_kes)]),
      headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      theme: 'grid',
    });
  }
}

// ─── XLSX ─────────────────────────────────────────────────────────────

export async function downloadReportXlsx(payload: ReportPayload): Promise<void> {
  const sheets: Array<{ data: Cell[][]; sheet: string }> = [];
  const meta: Cell[][] = [
    [{ value: 'ZorEWS — Reports', fontWeight: 'bold' }],
    [{ value: 'Type', fontWeight: 'bold' }, { value: payload.type, type: String }],
    [{ value: 'Period', fontWeight: 'bold' }, { value: periodLabel(payload), type: String }],
    [{ value: 'Generated', fontWeight: 'bold' }, { value: payload.generated_at, type: String }],
  ];
  sheets.push({ data: meta, sheet: 'Meta' });

  if (payload.type === 'snapshot') sheets.push(...snapshotSheets(payload));
  else if (payload.type === 'alerts') sheets.push(...alertActivitySheets(payload));
  else if (payload.type === 'cases') sheets.push(...caseOutcomesSheets(payload));
  else if (payload.type === 'rbi') sheets.push(...rbiSheets(payload));

  await writeXlsxFile(sheets).toFile(
    `${payload.type}-${payload.period}-${dateStamp()}.xlsx`,
  );
}

function snapshotSheets(p: PortfolioSnapshot): Array<{ data: Cell[][]; sheet: string }> {
  return [
    {
      sheet: 'KPIs',
      data: [
        headerRow(['Metric', 'Value']),
        row(['Customers monitored', p.customers_monitored]),
        row(['High-risk customers', p.high_risk_customers]),
        row(['High-risk %', p.high_risk_pct]),
        row(['Total exposure (KES)', p.total_exposure_kes]),
        row(['Alerts open', p.alerts_open]),
        row(['Cases in progress', p.cases_in_progress]),
        row(['ECL (KES)', p.expected_credit_loss_kes]),
        row(['NPA %', p.npa_pct]),
      ],
    },
    {
      sheet: 'IFRS 9 stages',
      data: [
        headerRow(['Stage', 'Customers']),
        row(['Stage 1 (performing)', p.stage_distribution.stage_1]),
        row(['Stage 2 (SICR)', p.stage_distribution.stage_2]),
        row(['Stage 3 (NPA)', p.stage_distribution.stage_3]),
      ],
    },
  ];
}

function alertActivitySheets(p: AlertActivityReport): Array<{ data: Cell[][]; sheet: string }> {
  return [
    {
      sheet: 'KPIs',
      data: [
        headerRow(['Metric', 'Value']),
        row(['Alerts raised', p.raised_total]),
        row(['Alerts closed', p.closed_total]),
        row(['Open at end', p.open_at_end]),
        row(['Avg minutes to ack', p.avg_minutes_to_ack]),
        row(['Avg minutes to close', p.avg_minutes_to_close]),
      ],
    },
    {
      sheet: 'By severity',
      data: [
        headerRow(['Severity', 'Count']),
        row(['critical', p.raised_by_severity.critical]),
        row(['high',     p.raised_by_severity.high]),
        row(['medium',   p.raised_by_severity.medium]),
        row(['low',      p.raised_by_severity.low]),
      ],
    },
    {
      sheet: 'Top rules',
      data: [
        headerRow(['Rule ID', 'Rule', 'Firings']),
        ...p.top_rules.map((r) => row([r.rule_id, r.rule_name, r.firings])),
      ],
    },
  ];
}

function caseOutcomesSheets(p: CaseOutcomesReport): Array<{ data: Cell[][]; sheet: string }> {
  return [
    {
      sheet: 'KPIs',
      data: [
        headerRow(['Metric', 'Value']),
        row(['Cases opened', p.cases_opened]),
        row(['Cases closed', p.cases_closed]),
        row(['Avg days to close', p.avg_days_to_close]),
        row(['Cured', p.outcomes.cured]),
        row(['Cured (temp)', p.outcomes.cured_temp]),
        row(['Defaulted', p.outcomes.defaulted]),
      ],
    },
    {
      sheet: 'Top officers',
      data: [
        headerRow(['Officer', 'Cases closed']),
        ...p.top_officers.map((o) => row([o.officer_id, o.cases_closed])),
      ],
    },
    {
      sheet: 'Product breakdown',
      data: [
        headerRow(['Product', 'Cases closed']),
        ...p.product_breakdown.map((x) => row([x.product, x.cases_closed])),
      ],
    },
  ];
}

function rbiSheets(p: RbiSummaryReport): Array<{ data: Cell[][]; sheet: string }> {
  return [
    {
      sheet: 'Summary',
      data: [
        headerRow(['Metric', 'Value']),
        row(['ECL (KES)', p.ecl_kes]),
        row(['ECL Q-o-Q delta (KES)', p.ecl_qoq_delta_kes]),
        row(['NPA %', p.npa_pct]),
      ],
    },
    {
      sheet: 'Sector exposure',
      data: [
        headerRow(['Sector', 'Exposure (KES)', 'Share %']),
        ...p.sector_exposure.map((s) => row([s.sector, s.exposure_kes, s.share_pct])),
      ],
    },
    {
      sheet: 'Risk bands',
      data: [
        headerRow(['Band', 'Accounts', 'Share %']),
        ...p.risk_band_distribution.map((b) => row([b.band, b.accounts, b.share_pct])),
      ],
    },
    {
      sheet: 'Top concentrations',
      data: [
        headerRow(['Customer ID', 'Name', 'Exposure (KES)']),
        ...p.top_concentrations.map((c) => row([c.customer_id, c.name, c.exposure_kes])),
      ],
    },
  ];
}
