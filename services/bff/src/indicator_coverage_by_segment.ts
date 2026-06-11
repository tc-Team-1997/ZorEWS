// services/bff/src/indicator_coverage_by_segment.ts
//
// T6 M4.23 — Indicator catalog coverage by customer segment.
//
// Maps each indicator to the customer segments it applies to, then
// computes a per-segment coverage view. Segment assignments are based
// on indicator family prefixes.

import { STUB_CATALOG } from './bil_scoring_v2';

// ─── Public types ──────────────────────────────────────────────────────

export type CustomerSegment = 'retail' | 'sme' | 'corporate' | 'msme' | 'individual' | 'group';

export const ALL_CUSTOMER_SEGMENTS: CustomerSegment[] = [
  'retail',
  'sme',
  'corporate',
  'msme',
  'individual',
  'group',
];

export interface SegmentCoverage {
  segment: CustomerSegment;
  applicable_indicator_count: number;
  indicator_ids: string[];
  pct_of_catalog: number;
}

export interface IndicatorCoverageBySegment {
  generated_at: string;
  total_indicators: number;
  by_segment: SegmentCoverage[];
  best_covered_segment: CustomerSegment | null;
  least_covered_segment: CustomerSegment | null;
}

// ─── Segment mapping by family prefix ─────────────────────────────────

function segmentsForFamily(family: string): CustomerSegment[] {
  switch (family) {
    case 'FIN':
    case 'BEH':
    case 'TXN':
    case 'CRD':
      return ['retail', 'sme', 'corporate'];
    case 'FRD':
      return ['retail', 'sme', 'corporate', 'msme'];
    case 'POL':
    case 'CLM':
      return ['individual', 'group'];
    case 'CUS-INS':
    case 'CUS':
      return ['individual', 'group', 'sme'];
    case 'AGT':
      return ['group', 'sme'];
    case 'OPS':
      return ['retail', 'sme', 'corporate', 'individual', 'group', 'msme'];
    default:
      return ['retail', 'sme', 'corporate'];
  }
}

function familyOf(indicator_id: string): string {
  const m = indicator_id.match(/^(.+)-\d+$/);
  return m && m[1] ? m[1] : indicator_id;
}

// ─── Pure function ─────────────────────────────────────────────────────

export function buildIndicatorCoverageBySegment(now: Date): IndicatorCoverageBySegment {
  const generated_at = now.toISOString();

  const catalogEntries = Object.entries(STUB_CATALOG);
  const total_indicators = catalogEntries.length;

  const segmentMap = new Map<CustomerSegment, Set<string>>();
  for (const seg of ALL_CUSTOMER_SEGMENTS) {
    segmentMap.set(seg, new Set());
  }

  for (const [indicator_id] of catalogEntries) {
    const family = familyOf(indicator_id);
    const segs = segmentsForFamily(family);
    for (const s of segs) {
      segmentMap.get(s as CustomerSegment)?.add(indicator_id);
    }
  }

  const by_segment: SegmentCoverage[] = ALL_CUSTOMER_SEGMENTS.map(seg => {
    const ids = [...(segmentMap.get(seg) ?? [])].sort();
    const count = ids.length;
    return {
      segment: seg,
      applicable_indicator_count: count,
      indicator_ids: ids,
      pct_of_catalog: total_indicators > 0
        ? Math.round((count / total_indicators) * 10000) / 100
        : 0,
    };
  });

  // Sort by count desc
  by_segment.sort((a, b) => b.applicable_indicator_count - a.applicable_indicator_count);

  const best_covered_segment = by_segment[0]?.segment ?? null;
  const nonZero = by_segment.filter(s => s.applicable_indicator_count > 0);
  const least_covered_segment = nonZero.length > 0
    ? nonZero[nonZero.length - 1]!.segment
    : null;

  return {
    generated_at,
    total_indicators,
    by_segment,
    best_covered_segment,
    least_covered_segment,
  };
}
