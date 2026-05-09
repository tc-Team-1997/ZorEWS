// services/bff/src/reports/pdf.ts
//
// Renders a ReportPayload to a PDF buffer using pdfkit. The four report
// types each get their own renderer to keep layout decisions local. Output
// is a single landscape A4 page per section, with bank header + report
// title + generated-by metadata.
//
// Why pdfkit instead of HTML-to-PDF: pdfkit produces deterministic byte
// output, no headless browser, no fonts to manage, no networking. Trade-off
// is more layout code but for tabular reports the extra control is welcome.

import PDFDocument from 'pdfkit';
import type {
  AlertActivityReport,
  CaseOutcomesReport,
  PortfolioSnapshot,
  RbiSummaryReport,
  ReportPayload,
} from './types';

interface PdfMeta {
  /** Username of the operator who triggered the download — embedded in the
   *  footer for leak traceability (FR-OBS-3 in the spec). */
  generated_by: string;
  /** Optional bank tenant label — production would pull from the JWT
   *  org claim. */
  tenant?: string;
}

const HEADER_FONT_SIZE = 18;
const SECTION_FONT_SIZE = 11;
const BODY_FONT_SIZE = 9;
const FOOTER_FONT_SIZE = 8;
const TABLE_ROW_HEIGHT = 18;

function fmtMoney(n: number): string {
  // KES integer thousands separator — banks read whole-shilling values.
  return `KES ${Math.round(n).toLocaleString('en-KE')}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function drawHeader(doc: PDFKit.PDFDocument, title: string, meta: PdfMeta) {
  doc
    .fillColor('#0d2b6a') // brand-blue from the design tokens
    .rect(36, 36, 30, 30)
    .fill()
    .fillColor('#ffffff')
    .fontSize(14)
    .text('A', 44, 44);

  doc
    .fillColor('#0d2b6a')
    .fontSize(HEADER_FONT_SIZE)
    .text('ZorEWS', 76, 38, { lineBreak: false });

  doc
    .fillColor('#525a72')
    .fontSize(BODY_FONT_SIZE)
    .text(`${meta.tenant ?? 'apex-prototype'} · Early Warning System`, 76, 58, {
      lineBreak: false,
    });

  doc.moveTo(36, 78).lineTo(560, 78).strokeColor('#e2e7ee').stroke();

  doc
    .fillColor('#11192d')
    .fontSize(15)
    .text(title, 36, 92, { lineBreak: false });

  doc
    .fillColor('#7a8198')
    .fontSize(BODY_FONT_SIZE)
    .text(
      `Generated ${new Date().toISOString()}  ·  by ${meta.generated_by}  ·  CONFIDENTIAL`,
      36,
      112,
      { lineBreak: false },
    );

  doc.moveDown(3);
}

function drawTwoColumnTable(
  doc: PDFKit.PDFDocument,
  rows: Array<[string, string | number]>,
  startY: number,
  colWidthLabel = 220,
  colWidthValue = 180,
): number {
  let y = startY;
  for (const [label, value] of rows) {
    doc
      .fillColor('#525a72')
      .fontSize(BODY_FONT_SIZE)
      .text(label, 36, y, { width: colWidthLabel, lineBreak: false });
    doc
      .fillColor('#11192d')
      .text(String(value), 36 + colWidthLabel, y, {
        width: colWidthValue,
        lineBreak: false,
        align: 'right',
      });
    y += TABLE_ROW_HEIGHT;
  }
  return y;
}

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: Array<Array<string | number>>,
  startY: number,
): number {
  const colWidths = [180, 220, 100];
  let y = startY;
  doc.fillColor('#525a72').fontSize(BODY_FONT_SIZE);
  let x = 36;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i] ?? '', x, y, { width: colWidths[i], lineBreak: false });
    x += colWidths[i] ?? 100;
  }
  y += TABLE_ROW_HEIGHT;
  doc.moveTo(36, y - 4).lineTo(560, y - 4).strokeColor('#e2e7ee').stroke();
  doc.fillColor('#11192d');
  for (const row of rows) {
    x = 36;
    for (let i = 0; i < row.length; i++) {
      doc.text(String(row[i] ?? ''), x, y, { width: colWidths[i], lineBreak: false });
      x += colWidths[i] ?? 100;
    }
    y += TABLE_ROW_HEIGHT;
    if (y > 760) {
      doc.addPage();
      y = 60;
    }
  }
  return y;
}

function drawSection(doc: PDFKit.PDFDocument, label: string, y: number): number {
  doc
    .fillColor('#0d2b6a')
    .fontSize(SECTION_FONT_SIZE)
    .text(label, 36, y, { lineBreak: false });
  return y + 22;
}

function renderSnapshot(doc: PDFKit.PDFDocument, r: PortfolioSnapshot, meta: PdfMeta) {
  drawHeader(doc, 'Portfolio Snapshot', meta);
  let y = 160;
  y = drawSection(doc, 'Headline metrics', y);
  y = drawTwoColumnTable(
    doc,
    [
      ['Period', `${r.period} (${r.period_start} → ${r.period_end})`],
      ['Customers monitored', r.customers_monitored.toLocaleString('en-KE')],
      ['High-risk customers', `${r.high_risk_customers.toLocaleString('en-KE')} (${fmtPct(r.high_risk_pct)})`],
      ['Total exposure', fmtMoney(r.total_exposure_kes)],
      ['Alerts open', r.alerts_open.toLocaleString('en-KE')],
      ['Cases in progress', r.cases_in_progress.toLocaleString('en-KE')],
    ],
    y,
  );
  y += 12;
  y = drawSection(doc, 'IFRS-9 stage distribution', y);
  y = drawTwoColumnTable(
    doc,
    [
      ['Stage 1 — performing', r.stage_distribution.stage_1.toLocaleString('en-KE')],
      ['Stage 2 — under-performing', r.stage_distribution.stage_2.toLocaleString('en-KE')],
      ['Stage 3 — non-performing', r.stage_distribution.stage_3.toLocaleString('en-KE')],
      ['Expected credit loss', fmtMoney(r.expected_credit_loss_kes)],
      ['NPA %', fmtPct(r.npa_pct)],
    ],
    y,
  );
}

function renderAlertActivity(doc: PDFKit.PDFDocument, r: AlertActivityReport, meta: PdfMeta) {
  drawHeader(doc, 'Alert Activity', meta);
  let y = 160;
  y = drawSection(doc, 'Volume', y);
  y = drawTwoColumnTable(
    doc,
    [
      ['Period', `${r.period} (${r.period_start} → ${r.period_end})`],
      ['Raised total', r.raised_total.toLocaleString('en-KE')],
      ['Closed total', r.closed_total.toLocaleString('en-KE')],
      ['Open at end', r.open_at_end.toLocaleString('en-KE')],
      ['Avg minutes to ack', r.avg_minutes_to_ack.toFixed(1)],
      ['Avg minutes to close', r.avg_minutes_to_close.toFixed(1)],
    ],
    y,
  );
  y += 12;
  y = drawSection(doc, 'By severity (raised)', y);
  y = drawTwoColumnTable(
    doc,
    [
      ['Critical', r.raised_by_severity.critical.toLocaleString('en-KE')],
      ['High', r.raised_by_severity.high.toLocaleString('en-KE')],
      ['Medium', r.raised_by_severity.medium.toLocaleString('en-KE')],
      ['Low', r.raised_by_severity.low.toLocaleString('en-KE')],
    ],
    y,
  );
  y += 12;
  y = drawSection(doc, 'Top firing rules', y);
  y = drawTable(
    doc,
    ['Rule ID', 'Rule name', 'Firings'],
    r.top_rules.map((t) => [t.rule_id, t.rule_name, t.firings]),
    y,
  );
}

function renderCaseOutcomes(doc: PDFKit.PDFDocument, r: CaseOutcomesReport, meta: PdfMeta) {
  drawHeader(doc, 'Case Outcomes', meta);
  let y = 160;
  y = drawSection(doc, 'Volume + outcomes', y);
  y = drawTwoColumnTable(
    doc,
    [
      ['Period', `${r.period} (${r.period_start} → ${r.period_end})`],
      ['Cases opened', r.cases_opened.toLocaleString('en-KE')],
      ['Cases closed', r.cases_closed.toLocaleString('en-KE')],
      ['Cured (full recovery)', r.outcomes.cured.toLocaleString('en-KE')],
      ['Cured (temporary)', r.outcomes.cured_temp.toLocaleString('en-KE')],
      ['Defaulted', r.outcomes.defaulted.toLocaleString('en-KE')],
      ['Avg days to close', r.avg_days_to_close.toFixed(1)],
    ],
    y,
  );
  y += 12;
  y = drawSection(doc, 'Top officers', y);
  y = drawTable(
    doc,
    ['Officer ID', 'Cases closed', ''],
    r.top_officers.map((o) => [o.officer_id, o.cases_closed, '']),
    y,
  );
  y += 6;
  y = drawSection(doc, 'Product breakdown', y);
  y = drawTable(
    doc,
    ['Product', 'Cases closed', ''],
    r.product_breakdown.map((p) => [p.product, p.cases_closed, '']),
    y,
  );
}

function renderRbi(doc: PDFKit.PDFDocument, r: RbiSummaryReport, meta: PdfMeta) {
  drawHeader(doc, 'RBI Regulatory Summary', meta);
  let y = 160;
  y = drawSection(doc, 'Headline', y);
  y = drawTwoColumnTable(
    doc,
    [
      ['Period', `${r.period} (${r.period_start} → ${r.period_end})`],
      ['Expected credit loss', fmtMoney(r.ecl_kes)],
      ['ECL Δ qoq', fmtMoney(r.ecl_qoq_delta_kes)],
      ['NPA %', fmtPct(r.npa_pct)],
    ],
    y,
  );
  y += 12;
  y = drawSection(doc, 'Sector exposure', y);
  y = drawTable(
    doc,
    ['Sector', 'Exposure', 'Share'],
    r.sector_exposure.map((s) => [s.sector, fmtMoney(s.exposure_kes), fmtPct(s.share_pct)]),
    y,
  );
  y += 6;
  y = drawSection(doc, 'Risk band distribution', y);
  y = drawTable(
    doc,
    ['Band', 'Accounts', 'Share'],
    r.risk_band_distribution.map((b) => [b.band, b.accounts, fmtPct(b.share_pct)]),
    y,
  );
  y += 6;
  y = drawSection(doc, 'Top 5 concentrations', y);
  y = drawTable(
    doc,
    ['Customer ID', 'Name', 'Exposure'],
    r.top_concentrations.map((c) => [c.customer_id, c.name, fmtMoney(c.exposure_kes)]),
    y,
  );
}

function drawFooter(doc: PDFKit.PDFDocument, meta: PdfMeta) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc
      .fillColor('#9aa1b2')
      .fontSize(FOOTER_FONT_SIZE)
      .text(
        `Page ${i + 1} of ${range.count}  ·  Generated by ${meta.generated_by}  ·  Confidential`,
        36,
        780,
        { width: 524, align: 'center', lineBreak: false },
      );
  }
}

export function reportToPdf(payload: ReportPayload, meta: PdfMeta): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 36, bottom: 36, left: 36, right: 36 },
        bufferPages: true,
        info: {
          Title: `ZorEWS · ${payload.type} · ${payload.period}`,
          Author: meta.generated_by,
          Subject: 'ZorEWS report',
          Keywords: 'apex-ews,banking,ews,risk',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c as Buffer));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      switch (payload.type) {
        case 'snapshot':
          renderSnapshot(doc, payload, meta);
          break;
        case 'alerts':
          renderAlertActivity(doc, payload, meta);
          break;
        case 'cases':
          renderCaseOutcomes(doc, payload, meta);
          break;
        case 'rbi':
          renderRbi(doc, payload, meta);
          break;
      }

      drawFooter(doc, meta);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
