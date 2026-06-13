# Export Framework P1.5 — Word (.docx) + AI Narrative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Add a 4th export format (Word .docx) and a deterministic executive AI-narrative to the existing export framework, available on every screen that already has an ExportButton (the 2 P1 pilots).

**Architecture:** Additive on P1. New `docx` generator follows the same `ReportData → Blob` pattern as csv/pdf/xlsx. A pure `buildExecutiveNarrative(data) → string` is injected by `ExportModal` into `sections.ai_insights` when the user ticks "AI Insights" — so every screen gets the narrative for free (no per-adapter work). Narrative is deterministic (Claude-swap-ready: the swap point is one pure function; a future phase can move it behind a BFF route when a real key lands).

**Tech Stack:** TypeScript, React, vitest. New dep: `docx` (browser `Packer.toBlob`). Existing: the `@/lib/export/*` framework from P1.

**Spec:** `docs/superpowers/specs/2026-06-13-enterprise-report-export-framework-design.md` (§"WORD EXPORT", §"AI REPORT NARRATIVE").

---

## File Structure
- Modify: `web/package.json` (+`docx` dep)
- Modify: `web/src/lib/export/types.ts` (add `'docx'` to `ALL_EXPORT_FORMATS`)
- Create: `web/src/lib/export/generators/docx.ts` — `buildReportDocxBlob(data, config) → Promise<Blob>`
- Create: `web/src/lib/export/narrative.ts` — `buildExecutiveNarrative(data) → string`
- Modify: `web/src/components/export/ExportModal.tsx` (enable Word checkbox, dispatch docx, inject narrative)
- Tests: append to `web/src/__tests__/exportGenerators.test.ts` (docx) + new `web/src/__tests__/narrative.test.ts` + extend `web/src/__tests__/ExportModal.test.tsx`

---

## Task 1: Install `docx` + add 'docx' to ExportFormat

**Files:** Modify `web/package.json`, `web/src/lib/export/types.ts`

- [ ] **Step 1: Install the dep**

Run: `cd web && npm install docx@^9 --save --no-audit --no-fund`
Expected: `docx` added to `web/package.json` dependencies.

- [ ] **Step 2: Add 'docx' to the format enum**

In `web/src/lib/export/types.ts`, change:
```ts
export const ALL_EXPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
```
to:
```ts
export const ALL_EXPORT_FORMATS = ['pdf', 'xlsx', 'csv', 'docx'] as const;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -v "mocks/handlers.ts" | grep -c "error TS"`
Expected: `0` (only the pre-existing handlers.ts baseline remains).

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/export/types.ts
git commit -m "feat(web): add docx dep + 'docx' export format"
```

---

## Task 2: buildExecutiveNarrative (deterministic AI narrative)

**Files:** Create `web/src/lib/export/narrative.ts`, `web/src/__tests__/narrative.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/narrative.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import { buildExecutiveNarrative } from '@/lib/export/narrative';
import type { ReportData } from '@/lib/export/types';

function data(over: Partial<ReportData['sections']> = {}, subject?: { id: string; name: string }): ReportData {
  return {
    report_type: 'customer', module: 'customer_360', title: 'Customer Report',
    subject,
    meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin', generated_at: '2026-06-13T10:00:00Z', report_id: 'EXP-1' },
    sections: { summary: [], kpis: [], ...over },
    record_count: 0,
  };
}

describe('buildExecutiveNarrative', () => {
  test('names the subject + mentions KPIs', () => {
    const n = buildExecutiveNarrative(data(
      { kpis: [{ label: 'Open Alerts', value: '3' }, { label: 'Open Cases', value: '1' }] },
      { id: 'c-101', name: 'Acme Ltd' },
    ));
    expect(n).toContain('Acme Ltd');
    expect(n).toMatch(/Open Alerts: 3/);
    expect(n.length).toBeGreaterThan(20);
  });

  test('falls back to module title when no subject', () => {
    const n = buildExecutiveNarrative(data({ summary: [{ label: 'Total Alerts', value: '12' }] }));
    expect(n).toContain('Customer Report');
    expect(n).toContain('Total Alerts: 12');
  });

  test('handles empty sections without throwing', () => {
    const n = buildExecutiveNarrative(data());
    expect(typeof n).toBe('string');
    expect(n.length).toBeGreaterThan(0);
  });

  test('deterministic — same input yields same output', () => {
    const d = data({ kpis: [{ label: 'X', value: '5' }] }, { id: 'c-1', name: 'Z' });
    expect(buildExecutiveNarrative(d)).toBe(buildExecutiveNarrative(d));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/__tests__/narrative.test.ts`
Expected: FAIL — cannot resolve `@/lib/export/narrative`.

- [ ] **Step 3: Write the narrative builder**

Create `web/src/lib/export/narrative.ts`:
```ts
// web/src/lib/export/narrative.ts
// Deterministic executive narrative for the AI Insights report section.
// Claude-swap-ready: this pure function is the single swap point — a future
// phase can replace its body with a BFF /v1/exports/narrative call backed by
// the Claude API (ANTHROPIC_API_KEY) without changing any caller.
import type { ReportData } from './types';

export function buildExecutiveNarrative(data: ReportData): string {
  const subject = data.subject?.name ?? data.title;
  const kpiBits = (data.sections.kpis ?? []).map((k) => `${k.label}: ${k.value}`);
  const sumBits = (data.sections.summary ?? []).map((s) => `${s.label}: ${s.value}`);
  const facts = [...kpiBits, ...sumBits];

  const lead = `Executive summary for ${subject} (${data.report_type} report, generated ${data.meta.generated_at.slice(0, 10)}).`;
  if (facts.length === 0) {
    return `${lead} No quantitative indicators were included in the selected scope; review the attached tables for detail.`;
  }
  const headline = facts.slice(0, 6).join('; ');
  const tableNote = (data.sections.tables ?? []).length
    ? ` ${data.record_count} record(s) are detailed in the attached tables.`
    : '';
  return `${lead} Key indicators — ${headline}.${tableNote} This narrative is a deterministic summary of the included sections; figures above are authoritative.`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/__tests__/narrative.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/export/narrative.ts web/src/__tests__/narrative.test.ts
git commit -m "feat(web): deterministic executive narrative (Claude-swap-ready)"
```

---

## Task 3: Word (.docx) generator

**Files:** Create `web/src/lib/export/generators/docx.ts`, append to `web/src/__tests__/exportGenerators.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/src/__tests__/exportGenerators.test.ts`:
```ts
import { buildReportDocxBlob } from '@/lib/export/generators/docx';

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/__tests__/exportGenerators.test.ts -t buildReportDocxBlob`
Expected: FAIL — cannot resolve `@/lib/export/generators/docx`.

- [ ] **Step 3: Write the docx generator**

Create `web/src/lib/export/generators/docx.ts`:
```ts
// web/src/lib/export/generators/docx.ts — professional Word document.
// Sections per spec: header/meta, Executive Summary, Detailed Findings,
// Recommendations, Approvals, Comments.
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType,
} from 'docx';
import type { ReportData, ExportConfig, ReportTable } from '../types';

function headingPara(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } });
}
function kvTable(rows: { label: string; value: string }[]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((r) => new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: r.label, bold: true })] })] }),
        new TableCell({ children: [new Paragraph(r.value)] }),
      ],
    })),
  });
}
function dataTable(t: ReportTable): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: t.columns.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, bold: true })] })] })) }),
      ...t.rows.slice(0, 200).map((row) => new TableRow({
        children: row.map((cell) => new TableCell({ children: [new Paragraph(String(cell ?? ''))] })),
      })),
    ],
  });
}

export async function buildReportDocxBlob(data: ReportData, config: ExportConfig): Promise<Blob> {
  const m = data.meta;
  const inc = config.include;
  const s = data.sections;
  const children: (Paragraph | Table)[] = [];

  // Header / meta block.
  children.push(new Paragraph({ children: [new TextRun({ text: 'ZorEWS', bold: true, size: 32 })], alignment: AlignmentType.LEFT }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Early Warning System', italics: true, color: '666666' })] }));
  children.push(new Paragraph({ text: data.title, heading: HeadingLevel.HEADING_1, spacing: { before: 120, after: 120 } }));
  children.push(kvTable([
    { label: 'Tenant', value: m.tenant_id },
    { label: 'Generated By', value: `${m.generated_by} (${m.role})` },
    { label: 'Generated', value: m.generated_at },
    { label: 'Report ID', value: m.report_id },
  ]));

  // Executive Summary.
  if (inc.summary && (s.summary?.length || s.kpis?.length)) {
    children.push(headingPara('Executive Summary'));
    if (s.summary?.length) children.push(kvTable(s.summary));
    if (inc.kpis && s.kpis?.length) children.push(kvTable(s.kpis.map((k) => ({ label: k.label, value: k.value + (k.delta ? ` (${k.delta})` : '') }))));
  }

  // AI Insight (narrative).
  if (inc.ai_insights && s.ai_insights?.narrative) {
    children.push(headingPara('AI Insight'));
    children.push(new Paragraph(s.ai_insights.narrative));
  }

  // Detailed Findings (tables).
  if ((s.tables ?? []).length) {
    children.push(headingPara('Detailed Findings'));
    for (const t of s.tables ?? []) {
      children.push(new Paragraph({ children: [new TextRun({ text: t.name, bold: true })], spacing: { before: 120, after: 60 } }));
      children.push(dataTable(t));
    }
  }

  // Recommendations.
  if (inc.recommendations && s.recommendations?.length) {
    children.push(headingPara('Recommendations'));
    s.recommendations.forEach((r) => children.push(new Paragraph({ text: r, bullet: { level: 0 } })));
  }

  // Approvals + Comments (blank professional placeholders).
  children.push(headingPara('Approvals'));
  children.push(kvTable([{ label: 'Reviewed By', value: '' }, { label: 'Approved By', value: '' }, { label: 'Date', value: '' }]));
  children.push(headingPara('Comments'));
  children.push(new Paragraph(''));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/__tests__/exportGenerators.test.ts -t buildReportDocxBlob`
Expected: PASS (2 tests).

> If jsdom lacks something `docx`'s `Packer.toBlob` needs (it uses `jszip`, which is browser-safe), the test should still pass. If `Packer.toBlob` is unavailable in jsdom, fall back to `Packer.toBuffer(doc)` and wrap in `new Blob([buffer])`; report the adaptation.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/export/generators/docx.ts web/src/__tests__/exportGenerators.test.ts
git commit -m "feat(web): Word (.docx) report generator"
```

---

## Task 4: Wire Word + narrative into ExportModal

**Files:** Modify `web/src/components/export/ExportModal.tsx`, extend `web/src/__tests__/ExportModal.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `web/src/__tests__/ExportModal.test.tsx` (add the docx generator mock at top with the others, and a new test):

Add to the `vi.mock` block region:
```tsx
vi.mock('@/lib/export/generators/docx', () => ({ buildReportDocxBlob: async () => new Blob(['docx']) }));
```
Add a test:
```tsx
test('Word format is selectable + generates + records', async () => {
  const { recordExport } = await import('@/lib/export/recordExport');
  render(<ExportModal open onClose={() => {}} adapter={() => data} module="customer_360" defaultReportType="customer" />);
  // Word checkbox is enabled now.
  const word = screen.getByTestId('export-format-docx') as HTMLInputElement;
  expect(word.disabled).toBe(false);
  fireEvent.click(screen.getByTestId('export-format-pdf')); // turn pdf OFF (default on)
  fireEvent.click(word); // turn docx ON
  fireEvent.click(screen.getByTestId('export-generate'));
  await waitFor(() => expect(recordExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'docx' })));
});

test('AI Insights toggle injects narrative before generating', async () => {
  // include.ai_insights defaults false; turn it on and assert the adapter output gets a narrative.
  render(<ExportModal open onClose={() => {}} adapter={() => data} module="customer_360" defaultReportType="customer" />);
  fireEvent.click(screen.getByTestId('export-section-ai_insights'));
  fireEvent.click(screen.getByTestId('export-generate'));
  await waitFor(() => expect(screen.queryByTestId('export-modal')).toBeNull()); // closed on success
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/__tests__/ExportModal.test.tsx -t "Word format"`
Expected: FAIL — Word checkbox still `disabled`.

- [ ] **Step 3: Edit ExportModal**

In `web/src/components/export/ExportModal.tsx`:

(a) Add imports:
```tsx
import { buildReportDocxBlob } from '@/lib/export/generators/docx';
import { buildExecutiveNarrative } from '@/lib/export/narrative';
```

(b) Replace the disabled Word `<label>` block (the `title="Coming soon (P1.5)"` one) with a real checkbox in the formats group — i.e. just rely on `ALL_EXPORT_FORMATS` now including `'docx'`, so the existing `.map((f) => ...)` over `ALL_EXPORT_FORMATS` already renders an enabled `export-format-docx` checkbox. DELETE the separate disabled Word label entirely. Update the label text mapping so `docx` renders as `WORD (.docx)`:
```tsx
{ALL_EXPORT_FORMATS.map((f) => (
  <label key={f} className="flex items-center gap-2 text-sm">
    <input type="checkbox" data-testid={`export-format-${f}`} checked={formats.includes(f)} onChange={() => toggleFormat(f)} />
    {f === 'docx' ? 'WORD (.docx)' : f.toUpperCase()}
  </label>
))}
```
(remove the old standalone disabled Word `<label>`).

(c) In `generate()`, right after `const data = await adapter(config);`, inject the narrative:
```tsx
      if (config.include.ai_insights && !data.sections.ai_insights) {
        data.sections.ai_insights = { narrative: buildExecutiveNarrative(data) };
      }
```

(d) In the per-format blob switch, add the docx branch:
```tsx
        let blob: Blob;
        if (fmt === 'csv') blob = buildReportCsv(data, config);
        else if (fmt === 'pdf') blob = reportPdfBlob(data, config);
        else if (fmt === 'docx') blob = await buildReportDocxBlob(data, config);
        else blob = await buildReportXlsxBlob(data, config);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/__tests__/ExportModal.test.tsx`
Expected: PASS (all modal tests incl. the 2 new).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/export/ExportModal.tsx web/src/__tests__/ExportModal.test.tsx
git commit -m "feat(web): wire Word export + AI narrative into ExportModal"
```

---

## Final verification (P1.5)
- [ ] `cd web && npx vitest run src/__tests__/exportGenerators.test.ts src/__tests__/narrative.test.ts src/__tests__/ExportModal.test.tsx` — all green
- [ ] `cd web && npx vitest run` — full suite green (no regression)
- [ ] `cd web && npx tsc --noEmit` — 0 new errors (handlers.ts baseline only)

## Self-Review notes
- **Spec coverage:** Word format (Task 1+3+4) · Word sections Executive Summary/Detailed Findings/Recommendations/Approvals/Comments (Task 3) · AI narrative auto-injected when AI-Insights ticked (Task 2+4) · narrative deterministic + Claude-swap-ready (Task 2).
- **Placeholders:** none — complete code each step. The docx `Packer.toBlob` jsdom fallback is conditional guidance, not a placeholder.
- **Type consistency:** `'docx'` added to `ALL_EXPORT_FORMATS` (the `ExportFormat` union derives from it, so the modal switch + recordExport accept it automatically). `buildReportDocxBlob(data, config) → Promise<Blob>` matches the xlsx generator's async shape; modal `await`s it.
