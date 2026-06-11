// services/bff/src/indicator_catalog_completeness.ts
//
// T6 M4.27 — Indicator catalog completeness check.
//
// For each indicator in STUB_CATALOG, check against 4 criteria:
//   - has_weight: weight > 0
//   - has_name: non-empty name
//   - has_vertical: vertical field present
//   - has_family: indicator_id matches a known family prefix pattern
//
// completeness_score per indicator = (fields present / 4) * 100
//
// Route: GET /v1/indicators/catalog-completeness
//   RBAC: customers:read_risk_profile

import { STUB_CATALOG } from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

export interface IndicatorCompletenessRow {
  indicator_id: string;
  name: string;
  vertical: string;
  has_weight: boolean;
  has_name: boolean;
  has_vertical: boolean;
  has_family: boolean;
  completeness_score: number;
}

export interface IndicatorCatalogCompletenessReport {
  generated_at: string;
  total_indicators: number;
  avg_completeness_score: number;
  fully_complete_count: number;
  incomplete_indicators: IndicatorCompletenessRow[];
}

// Known family prefixes
const KNOWN_FAMILY_PREFIXES = [
  'FIN', 'BEH', 'TXN', 'CRD', 'FRD',
  'POL', 'CUS-INS', 'CUS', 'AGT', 'CLM', 'OPS', 'EWS',
];

function hasKnownFamily(id: string): boolean {
  // Strip trailing -NNN and check if prefix is known
  const match = id.match(/^(.+)-\d+$/);
  if (!match) return false;
  const prefix = match[1];
  return KNOWN_FAMILY_PREFIXES.some(
    (f) => prefix === f || prefix.startsWith(f + '-'),
  );
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function checkIndicatorCatalogCompleteness(
  now: Date,
): IndicatorCatalogCompletenessReport {
  const rows: IndicatorCompletenessRow[] = [];

  for (const [id, entry] of Object.entries(STUB_CATALOG)) {
    const has_weight = typeof entry.weight === 'number' && entry.weight > 0;
    const has_name = typeof entry.name === 'string' && entry.name.trim().length > 0;
    const has_vertical =
      typeof entry.vertical === 'string' &&
      (entry.vertical === 'banking' || entry.vertical === 'insurance');
    const has_family = hasKnownFamily(id);

    const fields_present =
      (has_weight ? 1 : 0) +
      (has_name ? 1 : 0) +
      (has_vertical ? 1 : 0) +
      (has_family ? 1 : 0);

    const completeness_score = Math.round((fields_present / 4) * 100);

    rows.push({
      indicator_id: id,
      name: entry.name ?? '',
      vertical: entry.vertical ?? '',
      has_weight,
      has_name,
      has_vertical,
      has_family,
      completeness_score,
    });
  }

  const total_indicators = rows.length;
  const avg_completeness_score =
    total_indicators === 0
      ? 0
      : Math.round(rows.reduce((s, r) => s + r.completeness_score, 0) / total_indicators);

  const fully_complete_count = rows.filter((r) => r.completeness_score === 100).length;
  const incomplete_indicators = rows.filter((r) => r.completeness_score < 100);

  return {
    generated_at: now.toISOString(),
    total_indicators,
    avg_completeness_score,
    fully_complete_count,
    incomplete_indicators,
  };
}
