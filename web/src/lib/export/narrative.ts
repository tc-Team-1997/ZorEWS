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
