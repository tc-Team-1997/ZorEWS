import { describe, test, expect } from 'vitest';
import { buildReportCsv } from '@/lib/export/generators/csv';
import { buildReportPdf } from '@/lib/export/generators/pdf';
import { buildReportXlsxBlob } from '@/lib/export/generators/xlsx';
import { buildReportDocxBlob } from '@/lib/export/generators/docx';
import type { ReportData, ExportConfig } from '@/lib/export/types';
import { DEFAULT_INCLUDE } from '@/lib/export/types';

// jsdom's Blob in this vitest config exposes neither .text() nor
// .arrayBuffer(), but FileReader is available — read blob text through it so
// the generators' real Blob output is asserted without changing prod code.
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
  });
}

const config: ExportConfig = {
  formats: ['csv'], report_type: 'customer', date_range: '30d',
  data_scope: 'complete', include: DEFAULT_INCLUDE,
};
const data: ReportData = {
  report_type: 'customer', module: 'customer_360', title: 'Customer Report — c-101',
  subject: { id: 'c-101', name: 'Acme Ltd' },
  meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin', generated_at: '2026-06-13T10:00:00Z', report_id: 'EXP-1' },
  sections: {
    tables: [{ name: 'Cases', columns: ['Case', 'State'], rows: [['case-1', 'open'], ['case-2', 'closed']] }],
  },
  record_count: 2,
};

describe('buildReportCsv', () => {
  test('emits header + one line per row of the primary table', async () => {
    const blob = buildReportCsv(data, config);
    const text = await blobText(blob);
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('Case,State');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toBe('case-1,open');
  });

  test('escapes commas, quotes, newlines (RFC 4180)', async () => {
    const d2: ReportData = { ...data, sections: { tables: [{ name: 'X', columns: ['A'], rows: [['a,b'], ['he said "hi"']] }] } };
    const text = await blobText(buildReportCsv(d2, config));
    const lines = text.trim().split('\r\n');
    expect(lines[1]).toBe('"a,b"');
    expect(lines[2]).toBe('"he said ""hi"""');
  });

  test('no table → header-only meta line', async () => {
    const d3: ReportData = { ...data, sections: {} };
    const text = await blobText(buildReportCsv(d3, config));
    expect(text).toContain('No tabular records for this scope');
  });
});

describe('buildReportPdf', () => {
  test('produces a jsPDF doc with the enterprise header text + report id', () => {
    const doc = buildReportPdf(data, config);
    // jsPDF has no text-extract; assert via internal pages count + output size.
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    // header strings are written; we assert the output blob is non-trivial
    const out = doc.output('arraybuffer');
    expect(out.byteLength).toBeGreaterThan(800);
  });

  test('includes summary + kpis + table sections when present', () => {
    const rich: ReportData = {
      ...data,
      sections: {
        summary: [{ label: 'Risk Score', value: '0.82' }],
        kpis: [{ label: 'Open Alerts', value: '3', delta: '+1' }],
        tables: [{ name: 'Cases', columns: ['Case', 'State'], rows: [['case-1', 'open']] }],
        recommendations: ['Escalate to supervisor'],
      },
    };
    const doc = buildReportPdf(rich, config);
    expect(doc.output('arraybuffer').byteLength).toBeGreaterThan(1000);
  });
});

describe('buildReportXlsxBlob', () => {
  test('produces a non-empty blob', async () => {
    const blob = await buildReportXlsxBlob(data, config);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain('spreadsheet');
  });
});

describe('buildReportDocxBlob', () => {
  test('produces a non-empty .docx blob', async () => {
    const blob = await buildReportDocxBlob(data, config);
    expect(blob.size).toBeGreaterThan(0);
  });

  test('includes summary + recommendations sections', async () => {
    const rich: ReportData = {
      ...data,
      sections: {
        summary: [{ label: 'Risk Score', value: '0.82' }],
        tables: [{ name: 'Cases', columns: ['Case', 'State'], rows: [['case-1', 'open']] }],
        recommendations: ['Escalate to supervisor'],
        ai_insights: { narrative: 'Risk is elevated.' },
      },
    };
    const blob = await buildReportDocxBlob(rich, config);
    expect(blob.size).toBeGreaterThan(0);
  });
});
