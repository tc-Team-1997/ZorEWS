// services/bff/src/audit_metadata_richness.ts
// T6 M15.28 — Audit event metadata richness score.

import { defaultAuditTrailStore, type AuditTrailStore, type AuditResourceType } from './audit_trail';

export type RichnessGrade = 'A' | 'B' | 'C' | 'D';

export interface ResourceTypeRichness {
  resource_type: AuditResourceType;
  avg_metadata_score: number;
  events_with_metadata: number;
  events_without_metadata: number;
  richness_grade: RichnessGrade;
}

export interface AuditMetadataRichness {
  tenant_id: string;
  generated_at: string;
  total_events: number;
  by_resource_type: ResourceTypeRichness[];
  overall_avg_metadata_score: number;
  richest_resource_type: AuditResourceType | null;
}

const ALL_RESOURCE_TYPES: AuditResourceType[] = ['user', 'session', 'config', 'case', 'alert', 'report', 'scenario', 'rule', 'integration', 'system'];

function gradeFromScore(avg: number): RichnessGrade {
  if (avg >= 4) return 'A';
  if (avg >= 2) return 'B';
  if (avg >= 1) return 'C';
  return 'D';
}

export function buildAuditMetadataRichness(
  tenant_id: string,
  store: AuditTrailStore,
  now: Date,
): AuditMetadataRichness {
  const page = store.list(tenant_id, { page_size: 10000 });
  const events = page.items;

  type Accum = { totalScore: number; withMeta: number; withoutMeta: number };
  const byType = new Map<AuditResourceType, Accum>();
  for (const rt of ALL_RESOURCE_TYPES) {
    byType.set(rt, { totalScore: 0, withMeta: 0, withoutMeta: 0 });
  }

  for (const evt of events) {
    const rt = evt.resource_type;
    if (!byType.has(rt)) continue;
    const accum = byType.get(rt)!;
    const metaCount = evt.metadata ? Object.keys(evt.metadata).length : 0;
    accum.totalScore += metaCount;
    if (metaCount > 0) accum.withMeta += 1;
    else accum.withoutMeta += 1;
  }

  const by_resource_type: ResourceTypeRichness[] = ALL_RESOURCE_TYPES.map((resource_type) => {
    const accum = byType.get(resource_type)!;
    const total = accum.withMeta + accum.withoutMeta;
    const avg_metadata_score = total > 0 ? Math.round((accum.totalScore / total) * 100) / 100 : 0;
    return { resource_type, avg_metadata_score, events_with_metadata: accum.withMeta, events_without_metadata: accum.withoutMeta, richness_grade: gradeFromScore(avg_metadata_score) };
  });

  by_resource_type.sort((a, b) => b.avg_metadata_score - a.avg_metadata_score);

  const overallTotal = events.length;
  const overallTotalScore = events.reduce((s, e) => s + (e.metadata ? Object.keys(e.metadata).length : 0), 0);
  const overall_avg_metadata_score = overallTotal > 0 ? Math.round((overallTotalScore / overallTotal) * 100) / 100 : 0;

  const richest_resource_type = by_resource_type.length > 0 && by_resource_type[0].events_with_metadata > 0 ? by_resource_type[0].resource_type : null;

  return { tenant_id, generated_at: now.toISOString(), total_events: events.length, by_resource_type, overall_avg_metadata_score, richest_resource_type };
}

export { defaultAuditTrailStore };
