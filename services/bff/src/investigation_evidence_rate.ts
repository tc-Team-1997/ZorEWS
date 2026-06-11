// services/bff/src/investigation_evidence_rate.ts
// T6 M9.29 — Investigation evidence collection rate.

import {
  defaultCaseInvestigationStore,
  type CaseInvestigationStore,
  type InvestigationStatus,
} from './case_investigation';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export type CollectionHealth = 'strong' | 'fair' | 'weak';
export type EvidenceBucket = 'well_evidenced' | 'partial' | 'sparse';

export interface EvidenceAttentionRow {
  id: string;
  evidence_rate: number;
  status: InvestigationStatus;
}

export interface InvestigationEvidenceRateResult {
  tenant_id: string;
  generated_at: string;
  total_open: number;
  well_evidenced_count: number;
  partial_count: number;
  sparse_count: number;
  avg_evidence_rate: number;
  investigations_needing_attention: EvidenceAttentionRow[];
  collection_health: CollectionHealth;
}

export function buildInvestigationEvidenceRate(
  tenant_id: string,
  now: Date,
  store: CaseInvestigationStore = defaultCaseInvestigationStore,
): InvestigationEvidenceRateResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const page = store.list(tenant_id, {});
  const all = page.items;
  const open = all.filter((i) => i.status !== 'closed');

  let well_evidenced = 0;
  let partial = 0;
  let sparse = 0;
  let total_rate = 0;
  const needing_attention: EvidenceAttentionRow[] = [];

  for (const inv of open) {
    const steps = inv.steps;
    const total_steps = steps.length;
    if (total_steps === 0) {
      sparse++;
      needing_attention.push({ id: inv.investigation_id, evidence_rate: 0, status: inv.status });
      continue;
    }
    const steps_with_evidence = steps.filter((s) => s.evidence_link !== null && s.evidence_link !== '').length;
    const evidence_rate = steps_with_evidence / total_steps;
    total_rate += evidence_rate;

    if (evidence_rate >= 0.7) {
      well_evidenced++;
    } else if (evidence_rate >= 0.3) {
      partial++;
    } else {
      sparse++;
      needing_attention.push({
        id: inv.investigation_id,
        evidence_rate: Math.round(evidence_rate * 100) / 100,
        status: inv.status,
      });
    }
  }

  const avg_evidence_rate =
    open.length === 0 ? 0 : Math.round((total_rate / open.length) * 100) / 100;

  const collection_health: CollectionHealth =
    avg_evidence_rate >= 0.7 ? 'strong' : avg_evidence_rate >= 0.3 ? 'fair' : 'weak';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_open: open.length,
    well_evidenced_count: well_evidenced,
    partial_count: partial,
    sparse_count: sparse,
    avg_evidence_rate,
    investigations_needing_attention: needing_attention,
    collection_health,
  };
}
