// investigation_outcome_verdict_distribution.ts
//
// T6 M9.20 — Investigation outcome verdict distribution.
// 1D pivot of closed investigations by their decision verdict.
// Mirror of M5.16 (template severity distribution) + M7.12 pivot pattern.

import type { CaseInvestigation } from './case_investigation';

// ─── Types ──────────────────────────────────────────────────────────────────

export type InvestigationVerdict =
  | 'fraud_confirmed'
  | 'fraud_unsubstantiated'
  | 'partial_fraud'
  | 'data_quality'
  | 'no_decision';  // closed without decision or still open

export const ALL_VERDICTS: readonly InvestigationVerdict[] = [
  'fraud_confirmed', 'fraud_unsubstantiated', 'partial_fraud', 'data_quality', 'no_decision',
];

export const VERDICT_LABELS: Record<InvestigationVerdict, string> = {
  fraud_confirmed:      'Fraud Confirmed',
  fraud_unsubstantiated: 'Fraud Unsubstantiated',
  partial_fraud:        'Partial Fraud',
  data_quality:         'Data Quality Issue',
  no_decision:          'No Decision / Open',
};

export interface VerdictRow {
  verdict:               InvestigationVerdict;
  label:                 string;
  count:                 number;
  pct:                   number;  // 0-1 of total
  pct_of_closed:         number | null;  // 0-1 of closed investigations only
  avg_days_to_close:     number | null;
  sample_investigation_ids: string[];  // cap 3 sorted asc
}

export interface InvestigationVerdictDistribution {
  tenant_id:          string;
  generated_at:       string;
  total_investigations: number;
  total_closed:       number;
  total_open:         number;
  confirmation_rate:  number | null;  // (fraud_confirmed + partial_fraud) / closed_with_decision
  verdicts:           VerdictRow[];   // 5 in ALL_VERDICTS canonical order
  most_common_verdict: InvestigationVerdict | null;
  most_common_verdict_count: number;
  fraud_detection_rate: number | null;  // confirmed / total_closed_with_decision
}

// ─── Verdict classifier ──────────────────────────────────────────────────────

export function classifyVerdict(inv: CaseInvestigation): InvestigationVerdict {
  if (inv.status !== 'closed') return 'no_decision';
  const d = inv.decision as string | undefined;
  if (d === 'fraud_confirmed')      return 'fraud_confirmed';
  if (d === 'fraud_unsubstantiated') return 'fraud_unsubstantiated';
  if (d === 'partial_fraud')         return 'partial_fraud';
  if (d === 'data_quality')          return 'data_quality';
  return 'no_decision';  // closed without documented decision
}

// ─── Main function ───────────────────────────────────────────────────────────

export function buildInvestigationVerdictDistribution(
  tenant_id: string,
  investigations: CaseInvestigation[],
  now: Date,
): InvestigationVerdictDistribution {
  const generated_at = now.toISOString();
  const SAMPLE_CAP = 3;

  const counts: Record<InvestigationVerdict, number> = {
    fraud_confirmed: 0, fraud_unsubstantiated: 0, partial_fraud: 0,
    data_quality: 0, no_decision: 0,
  };
  const samples: Record<InvestigationVerdict, string[]> = {
    fraud_confirmed: [], fraud_unsubstantiated: [], partial_fraud: [],
    data_quality: [], no_decision: [],
  };
  const daysToCLose: Record<InvestigationVerdict, number[]> = {
    fraud_confirmed: [], fraud_unsubstantiated: [], partial_fraud: [],
    data_quality: [], no_decision: [],
  };

  let totalClosed = 0;
  let closedWithDecision = 0;

  for (const inv of investigations) {
    const v = classifyVerdict(inv);
    counts[v]++;
    if (samples[v].length < SAMPLE_CAP) samples[v].push(inv.investigation_id);

    if (inv.status === 'closed') {
      totalClosed++;
      if (v !== 'no_decision') closedWithDecision++;
      // Compute days to close
      if (inv.opened_at) {
        const opened = new Date(inv.opened_at).getTime();
        const closed = now.getTime();
        const days = Math.round((closed - opened) / 86_400_000 * 100) / 100;
        daysToCLose[v].push(days);
      }
    }
  }

  const total = investigations.length;

  const verdicts: VerdictRow[] = ALL_VERDICTS.map(v => {
    const count = counts[v];
    const days = daysToCLose[v];
    const avgDays = days.length > 0
      ? Math.round(days.reduce((s, d) => s + d, 0) / days.length * 100) / 100
      : null;
    return {
      verdict:     v,
      label:       VERDICT_LABELS[v],
      count,
      pct:         total > 0 ? Math.round((count / total) * 1000) / 1000 : 0,
      pct_of_closed: totalClosed > 0 ? Math.round((count / totalClosed) * 1000) / 1000 : null,
      avg_days_to_close: avgDays,
      sample_investigation_ids: [...samples[v]].sort(),
    };
  });

  // Most common verdict (canonical order tie-break via strict >)
  let mostCommon: InvestigationVerdict | null = null;
  let mostCommonCount = 0;
  for (const v of ALL_VERDICTS) {
    if (counts[v] > mostCommonCount) { mostCommon = v; mostCommonCount = counts[v]; }
  }

  // Confirmation rate: (confirmed + partial) / closed_with_decision
  const confirmedCount = counts.fraud_confirmed + counts.partial_fraud;
  const confirmationRate = closedWithDecision > 0
    ? Math.round((confirmedCount / closedWithDecision) * 1000) / 1000
    : null;

  const fraudDetectionRate = closedWithDecision > 0
    ? Math.round((counts.fraud_confirmed / closedWithDecision) * 1000) / 1000
    : null;

  return {
    tenant_id,
    generated_at,
    total_investigations:  total,
    total_closed:          totalClosed,
    total_open:            total - totalClosed,
    confirmation_rate:     confirmationRate,
    verdicts,
    most_common_verdict:       mostCommon,
    most_common_verdict_count: mostCommonCount,
    fraud_detection_rate:  fraudDetectionRate,
  };
}
