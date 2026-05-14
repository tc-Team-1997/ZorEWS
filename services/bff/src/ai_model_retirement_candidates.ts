// services/bff/src/ai_model_retirement_candidates.ts
//
// T6 M7.9 — AI model retirement candidates.
//
// M7.1 ships the registry with 6 BIL model types. M7.2 ships the
// promotion workflow. M7.8 ships per-metric trends. M7.9 is the
// staleness detector: for each model NOT already in 'retired'
// status, compute how long it's been since deployment AND surface
// candidates whose age exceeds a configurable threshold — ops then
// reviews and decides whether to retire.
//
// Pure — no I/O. Caller passes the registry list.

import type { ModelVersion, ModelStatus } from './ai_model_registry';

// ─── Public types ─────────────────────────────────────────────────────

export type RetirementCandidacy = 'stale' | 'aging' | 'fresh' | 'never_deployed';

export interface ModelRetirementRow {
  model_id: string;
  name: string;
  type: string;
  version: string;
  status: ModelStatus;
  /** Days since `deployed_at`. null when the model was never deployed
   *  (deployed_at is null). */
  days_since_deployed: number | null;
  /** Days since `trained_at`. */
  days_since_trained: number;
  candidacy: RetirementCandidacy;
}

export interface RetirementCandidatesReport {
  generated_at: string;
  stale_days_threshold: number;
  aging_days_threshold: number;
  total_models_considered: number;
  total_candidates: number;
  /** Candidates sorted by days_since_deployed desc with model_id asc
   *  tie-break. */
  candidates: ModelRetirementRow[];
}

export class RetirementCandidatesError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RetirementCandidatesError';
  }
}

// ─── Pure analyser ───────────────────────────────────────────────────

function classify(
  days_since_deployed: number | null,
  days_since_trained: number,
  stale: number,
  aging: number,
): RetirementCandidacy {
  if (days_since_deployed === null) {
    // Never deployed — if trained > stale_days ago it's a never-deployed
    // candidate; otherwise fresh experimental.
    return days_since_trained > stale ? 'never_deployed' : 'fresh';
  }
  if (days_since_deployed > stale) return 'stale';
  if (days_since_deployed > aging) return 'aging';
  return 'fresh';
}

export function findRetirementCandidates(
  models: readonly ModelVersion[],
  now: Date,
  stale_days: number = 365,
  aging_days: number = 180,
): RetirementCandidatesReport {
  if (!Number.isFinite(stale_days) || stale_days < 0) {
    throw new RetirementCandidatesError('invalid_input', 'stale_days must be ≥ 0');
  }
  if (!Number.isFinite(aging_days) || aging_days < 0) {
    throw new RetirementCandidatesError('invalid_input', 'aging_days must be ≥ 0');
  }
  if (stale_days < aging_days) {
    throw new RetirementCandidatesError(
      'invalid_input',
      'stale_days must be ≥ aging_days',
    );
  }
  // Filter to non-retired models — retired models aren't candidates
  // for further retirement, by definition.
  const considered = models.filter((m) => m.status !== 'retired');
  const rows: ModelRetirementRow[] = considered.map((m) => {
    const trainedMs = new Date(m.trained_at).getTime();
    const deployedMs = m.deployed_at ? new Date(m.deployed_at).getTime() : null;
    const dt = Math.max(0, Math.floor((now.getTime() - trainedMs) / 86_400_000));
    const dd =
      deployedMs !== null
        ? Math.max(0, Math.floor((now.getTime() - deployedMs) / 86_400_000))
        : null;
    return {
      model_id: m.model_id,
      name: m.name,
      type: m.type,
      version: m.version,
      status: m.status,
      days_since_deployed: dd,
      days_since_trained: dt,
      candidacy: classify(dd, dt, stale_days, aging_days),
    };
  });
  // Candidates = anything not 'fresh' — i.e. stale + aging + never_deployed.
  const candidates = rows
    .filter((r) => r.candidacy !== 'fresh')
    .sort((a, b) => {
      const ad = a.days_since_deployed ?? a.days_since_trained;
      const bd = b.days_since_deployed ?? b.days_since_trained;
      if (bd !== ad) return bd - ad;
      return a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0;
    });
  return {
    generated_at: now.toISOString(),
    stale_days_threshold: stale_days,
    aging_days_threshold: aging_days,
    total_models_considered: considered.length,
    total_candidates: candidates.length,
    candidates,
  };
}
