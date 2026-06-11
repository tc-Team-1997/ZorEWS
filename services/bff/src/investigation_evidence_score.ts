// services/bff/src/investigation_evidence_score.ts
//
// T6 M9.24 — Investigation evidence sufficiency score.
//
// For each open/active investigation, compute an "evidence sufficiency
// score" (0-100) based on checklist completion, notes count, and
// evidence links.

import type { CaseInvestigationStore } from './case_investigation';

// ─── Public types ──────────────────────────────────────────────────────

export type EvidenceGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface InvestigationEvidenceScoreEntry {
  investigation_id: string;
  case_id: string;
  customer_id: string;
  status: string;
  score: number; // 0–100
  grade: EvidenceGrade;
  checklist_contribution: number;
  notes_contribution: number;
  evidence_bonus: number;
  completed_steps: number;
  total_steps: number;
  notes_count: number;
  has_evidence: boolean;
}

export interface InvestigationEvidenceScoreResult {
  tenant_id: string;
  generated_at: string;
  total_analyzed: number;
  scores: InvestigationEvidenceScoreEntry[];
  avg_score: number;
  grade_distribution: Record<EvidenceGrade, number>;
  investigations_needing_attention: number; // score < 40
}

// ─── Helpers ──────────────────────────────────────────────────────────

function computeGrade(score: number): EvidenceGrade {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}

// ─── Main function ────────────────────────────────────────────────────

export function computeInvestigationEvidenceScores(
  tenant_id: string,
  store: CaseInvestigationStore,
  now: Date,
): InvestigationEvidenceScoreResult {
  const page = store.list(tenant_id, { page: 1, page_size: 1000 });
  const allInvestigations = page.items;

  // Only analyze non-closed investigations
  const openInvestigations = allInvestigations.filter((inv) => inv.status !== 'closed');

  const entries: InvestigationEvidenceScoreEntry[] = [];

  for (const inv of openInvestigations) {
    const steps = inv.steps ?? [];
    const total_steps = steps.length;
    const completed_steps = steps.filter((s) => s.completed).length;

    // Checklist contribution (0-40 points)
    const checklist_contribution =
      total_steps > 0 ? Math.round((completed_steps / total_steps) * 40) : 0;

    // Notes contribution
    const notes = store.listNotes(tenant_id, inv.investigation_id);
    const notes_count = notes.length;
    const notes_contribution = Math.min(notes_count, 5) * 8; // max 40 points

    // Evidence bonus: any step with evidence_link → +20
    const has_evidence = steps.some((s) => s.evidence_link !== null && s.evidence_link !== '');
    const evidence_bonus = has_evidence ? 20 : 0;

    const raw_score = checklist_contribution + notes_contribution + evidence_bonus;
    const score = Math.min(100, raw_score);
    const grade = computeGrade(score);

    entries.push({
      investigation_id: inv.investigation_id,
      case_id: inv.case_id,
      customer_id: inv.customer_id,
      status: inv.status,
      score,
      grade,
      checklist_contribution,
      notes_contribution,
      evidence_bonus,
      completed_steps,
      total_steps,
      notes_count,
      has_evidence,
    });
  }

  // Sort by score asc (most needing attention first)
  entries.sort((a, b) => a.score - b.score);

  const total_analyzed = entries.length;
  const avg_score =
    total_analyzed > 0
      ? Math.round(entries.reduce((s, e) => s + e.score, 0) / total_analyzed)
      : 0;

  const grade_distribution: Record<EvidenceGrade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const entry of entries) {
    grade_distribution[entry.grade]++;
  }

  const investigations_needing_attention = entries.filter((e) => e.score < 40).length;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_analyzed,
    scores: entries,
    avg_score,
    grade_distribution,
    investigations_needing_attention,
  };
}
