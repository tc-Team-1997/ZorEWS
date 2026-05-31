/**
 * Enterprise Data Fabric Center — pure resolver. 14th IA overlay (additive).
 * Data Quality Center: per-source quality scores, failed records, trends, heatmap, summary.
 */

import {
  DataDomain,
  QualityDimension,
  QualityBand,
  QUALITY_DIMENSIONS,
  QUALITY_BANDS,
  DataSource,
  listDataSources,
} from './dataFabricEngine';

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayIndex(asOf: Date): number {
  return Math.floor(asOf.getTime() / 86_400_000);
}

function toIso(d: Date): string {
  const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    ':' +
    pad(d.getUTCMinutes()) +
    ':' +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function bandFor(score: number): QualityBand {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  if (score >= 40) return 'poor';
  return 'critical';
}

function targetFor(dim: QualityDimension): number {
  switch (dim) {
    case 'completeness':
      return 95;
    case 'accuracy':
      return 92;
    case 'consistency':
      return 88;
    case 'validity':
      return 90;
    case 'timeliness':
      return 85;
    case 'uniqueness':
      return 98;
  }
}

function scoreForSourceDimension(tenant_id: string, source_id: string, dim: QualityDimension, day: number): number {
  const seed = fnv1a(`${tenant_id}|dq|${source_id}|${dim}|${day}`);
  const rng = mulberry32(seed);
  const base = 50 + Math.floor(rng() * 50);
  const jitter = Math.floor(rng() * 11) - 5;
  let score = base + jitter;
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return score;
}

function buildScoresForSource(tenant_id: string, source_id: string, day: number): QualityScore[] {
  return QUALITY_DIMENSIONS.map((dim) => {
    const score = scoreForSourceDimension(tenant_id, source_id, dim, day);
    const target = targetFor(dim);
    return {
      dimension: dim,
      score,
      band: bandFor(score),
      target,
      sla_met: score >= target,
    };
  });
}

function trendFor(tenant_id: string, source_id: string, day: number): 'improving' | 'stable' | 'declining' {
  const seed = fnv1a(`${tenant_id}|dq-trend|${source_id}|${day}`);
  const rng = mulberry32(seed);
  const r = rng();
  if (r < 0.33) return 'improving';
  if (r < 0.67) return 'stable';
  return 'declining';
}

export interface QualityScore {
  dimension: QualityDimension;
  score: number;
  band: QualityBand;
  target: number;
  sla_met: boolean;
}

export interface SourceQualityRow {
  source_id: string;
  source_name: string;
  domain: DataDomain;
  overall_score: number;
  overall_band: QualityBand;
  scores: QualityScore[];
  failed_records_24h: number;
  last_profiled_at: string;
  trend_7d: 'improving' | 'stable' | 'declining';
}

export interface FailedRecordRow {
  record_id: string;
  source_id: string;
  dimension: QualityDimension;
  field_name: string;
  error_kind: string;
  value_observed: string;
  detected_at: string;
  severity: 'low' | 'moderate' | 'high';
}

export interface QualityTrendPoint {
  day_offset: number;
  overall_score: number;
  failed_records: number;
}

export interface QualityHeatmapCell {
  source_id: string;
  source_name: string;
  dimension: QualityDimension;
  score: number;
  band: QualityBand;
}

export interface DataQualityCenterSummary {
  tenant_id: string;
  generated_at: string;
  overall_data_quality_score: number;
  overall_band: QualityBand;
  sla_compliance_rate: number;
  by_dimension: Record<QualityDimension, { mean_score: number; sla_met_count: number; sla_total_count: number }>;
  by_band: Record<QualityBand, number>;
  total_failed_records_24h: number;
  worst_sources: Array<{ source_id: string; source_name: string; overall_score: number }>;
  best_sources: Array<{ source_id: string; source_name: string; overall_score: number }>;
}

export function listSourceQuality(
  tenant_id: string,
  asOf?: Date,
  filters?: { domain?: DataDomain; band?: QualityBand }
): SourceQualityRow[] {
  const now = asOf ?? new Date();
  const day = dayIndex(now);
  const sources = listDataSources(tenant_id, now);

  const rows: SourceQualityRow[] = sources.map((src: DataSource) => {
    const scores = buildScoresForSource(tenant_id, src.source_id, day);
    const overallSum = scores.reduce((a, s) => a + s.score, 0);
    const overall_score = Math.round(overallSum / scores.length);
    const overall_band = bandFor(overall_score);

    const failedSeed = fnv1a(`${tenant_id}|dq-failed|${src.source_id}|${day}`);
    const failedRng = mulberry32(failedSeed);
    const failedBase = overall_score < 50 ? 200 : overall_score < 75 ? 80 : overall_score < 90 ? 20 : 5;
    const failed_records_24h = failedBase + Math.floor(failedRng() * failedBase);

    const profSeed = fnv1a(`${tenant_id}|dq-prof|${src.source_id}|${day}`);
    const profRng = mulberry32(profSeed);
    const hoursAgo = Math.floor(profRng() * 24);
    const minsAgo = Math.floor(profRng() * 60);
    const profDate = new Date(now.getTime() - hoursAgo * 3600_000 - minsAgo * 60_000);

    return {
      source_id: src.source_id,
      source_name: src.name,
      domain: src.domain,
      overall_score,
      overall_band,
      scores,
      failed_records_24h,
      last_profiled_at: toIso(profDate),
      trend_7d: trendFor(tenant_id, src.source_id, day),
    };
  });

  let filtered = rows;
  if (filters?.domain) {
    filtered = filtered.filter((r) => r.domain === filters.domain);
  }
  if (filters?.band) {
    filtered = filtered.filter((r) => r.overall_band === filters.band);
  }

  filtered.sort((a, b) => {
    if (a.overall_score !== b.overall_score) return a.overall_score - b.overall_score;
    return a.source_id.localeCompare(b.source_id);
  });

  return filtered;
}

const ERROR_KINDS = ['null_required', 'out_of_range', 'format_mismatch', 'duplicate_pk', 'stale_timestamp'];

const FIELD_NAMES_BY_DIM: Record<QualityDimension, string[]> = {
  completeness: ['customer_id', 'account_number', 'pan_number', 'date_of_birth', 'address_line_1'],
  accuracy: ['amount', 'interest_rate', 'principal_balance', 'credit_score', 'risk_rating'],
  consistency: ['currency_code', 'status_flag', 'product_code', 'branch_code', 'channel_id'],
  validity: ['email', 'phone_number', 'ifsc_code', 'gstin', 'aadhaar_hash'],
  timeliness: ['last_updated_at', 'as_of_date', 'transaction_ts', 'effective_date', 'load_ts'],
  uniqueness: ['customer_id', 'policy_number', 'claim_id', 'transaction_id', 'application_id'],
};

const ERROR_BY_DIM: Record<QualityDimension, string> = {
  completeness: 'null_required',
  accuracy: 'out_of_range',
  consistency: 'format_mismatch',
  validity: 'format_mismatch',
  timeliness: 'stale_timestamp',
  uniqueness: 'duplicate_pk',
};

function sampleValueFor(kind: string, rng: () => number): string {
  switch (kind) {
    case 'null_required':
      return 'NULL';
    case 'out_of_range':
      return String(Math.floor(rng() * 1_000_000) - 500_000);
    case 'format_mismatch':
      return 'bad-format-' + Math.floor(rng() * 9999);
    case 'duplicate_pk':
      return 'DUP-' + Math.floor(rng() * 99999);
    case 'stale_timestamp':
      return '1999-01-' + String(1 + Math.floor(rng() * 28)).padStart(2, '0');
    default:
      return '<unknown>';
  }
}

export function listFailedRecords(
  tenant_id: string,
  asOf?: Date,
  filters?: { source_id?: string; dimension?: QualityDimension; severity?: 'low' | 'moderate' | 'high' },
  limit?: number
): FailedRecordRow[] {
  const now = asOf ?? new Date();
  const day = dayIndex(now);
  const sources = listDataSources(tenant_id, now);
  if (sources.length === 0) return [];

  const targetCount = 80;
  const out: FailedRecordRow[] = [];
  const baseSeed = fnv1a(`${tenant_id}|failed-records|${day}`);
  const rng = mulberry32(baseSeed);

  for (let i = 0; i < targetCount; i++) {
    const src = sources[Math.floor(rng() * sources.length)];
    const dim = QUALITY_DIMENSIONS[Math.floor(rng() * QUALITY_DIMENSIONS.length)];
    const error_kind = ERROR_BY_DIM[dim] ?? ERROR_KINDS[Math.floor(rng() * ERROR_KINDS.length)];
    const fields = FIELD_NAMES_BY_DIM[dim];
    const field_name = fields[Math.floor(rng() * fields.length)];
    const value_observed = sampleValueFor(error_kind, rng);

    const minsAgo = Math.floor(rng() * 1440);
    const detected = new Date(now.getTime() - minsAgo * 60_000);

    const sevRoll = rng();
    const severity: 'low' | 'moderate' | 'high' = sevRoll < 0.5 ? 'low' : sevRoll < 0.85 ? 'moderate' : 'high';

    out.push({
      record_id: 'REC-' + String(i + 1).padStart(5, '0'),
      source_id: src.source_id,
      dimension: dim,
      field_name,
      error_kind,
      value_observed,
      detected_at: toIso(detected),
      severity,
    });
  }

  let filtered = out;
  if (filters?.source_id) filtered = filtered.filter((r) => r.source_id === filters.source_id);
  if (filters?.dimension) filtered = filtered.filter((r) => r.dimension === filters.dimension);
  if (filters?.severity) filtered = filtered.filter((r) => r.severity === filters.severity);

  filtered.sort((a, b) => {
    if (a.detected_at !== b.detected_at) return a.detected_at < b.detected_at ? 1 : -1;
    return a.record_id.localeCompare(b.record_id);
  });

  const cap = typeof limit === 'number' && limit > 0 ? limit : 50;
  return filtered.slice(0, cap);
}

export function buildQualityTrend(tenant_id: string, asOf?: Date): QualityTrendPoint[] {
  const now = asOf ?? new Date();
  const todayDay = dayIndex(now);
  const points: QualityTrendPoint[] = [];

  for (let offset = -29; offset <= 0; offset++) {
    const day = todayDay + offset;
    const sources = listDataSources(tenant_id, new Date(now.getTime() + offset * 86_400_000));
    let sum = 0;
    let count = 0;
    let failedSum = 0;

    for (const src of sources) {
      const scores = buildScoresForSource(tenant_id, src.source_id, day);
      const overall = scores.reduce((a, s) => a + s.score, 0) / scores.length;
      sum += overall;
      count += 1;

      const failedSeed = fnv1a(`${tenant_id}|dq-failed|${src.source_id}|${day}`);
      const failedRng = mulberry32(failedSeed);
      const failedBase = overall < 50 ? 200 : overall < 75 ? 80 : overall < 90 ? 20 : 5;
      failedSum += failedBase + Math.floor(failedRng() * failedBase);
    }

    const overall_score = count > 0 ? Math.round(sum / count) : 0;
    points.push({
      day_offset: offset,
      overall_score,
      failed_records: failedSum,
    });
  }

  return points;
}

export function buildQualityHeatmap(tenant_id: string, asOf?: Date): QualityHeatmapCell[] {
  const now = asOf ?? new Date();
  const day = dayIndex(now);
  const sources = listDataSources(tenant_id, now);
  const cells: QualityHeatmapCell[] = [];

  for (const src of sources) {
    for (const dim of QUALITY_DIMENSIONS) {
      const score = scoreForSourceDimension(tenant_id, src.source_id, dim, day);
      cells.push({
        source_id: src.source_id,
        source_name: src.name,
        dimension: dim,
        score,
        band: bandFor(score),
      });
    }
  }

  cells.sort((a, b) => {
    if (a.source_id !== b.source_id) return a.source_id.localeCompare(b.source_id);
    return QUALITY_DIMENSIONS.indexOf(a.dimension) - QUALITY_DIMENSIONS.indexOf(b.dimension);
  });

  return cells;
}

export function buildDataQualityCenterSummary(tenant_id: string, asOf?: Date): DataQualityCenterSummary {
  const now = asOf ?? new Date();
  const rows = listSourceQuality(tenant_id, now);

  const by_dimension: Record<QualityDimension, { mean_score: number; sla_met_count: number; sla_total_count: number }> =
    {} as Record<QualityDimension, { mean_score: number; sla_met_count: number; sla_total_count: number }>;
  for (const dim of QUALITY_DIMENSIONS) {
    by_dimension[dim] = { mean_score: 0, sla_met_count: 0, sla_total_count: 0 };
  }

  const by_band: Record<QualityBand, number> = {} as Record<QualityBand, number>;
  for (const band of QUALITY_BANDS) {
    by_band[band] = 0;
  }

  let overallSum = 0;
  let total_failed_records_24h = 0;
  let sla_met_total = 0;
  let sla_total_total = 0;

  for (const row of rows) {
    overallSum += row.overall_score;
    total_failed_records_24h += row.failed_records_24h;
    by_band[row.overall_band] += 1;

    for (const s of row.scores) {
      const acc = by_dimension[s.dimension];
      acc.mean_score += s.score;
      acc.sla_total_count += 1;
      sla_total_total += 1;
      if (s.sla_met) {
        acc.sla_met_count += 1;
        sla_met_total += 1;
      }
    }
  }

  for (const dim of QUALITY_DIMENSIONS) {
    const acc = by_dimension[dim];
    acc.mean_score = acc.sla_total_count > 0 ? Math.round(acc.mean_score / acc.sla_total_count) : 0;
  }

  const overall_data_quality_score = rows.length > 0 ? Math.round(overallSum / rows.length) : 0;
  const overall_band = bandFor(overall_data_quality_score);
  const sla_compliance_rate = sla_total_total > 0 ? sla_met_total / sla_total_total : 0;

  const sortedAsc = [...rows].sort((a, b) => {
    if (a.overall_score !== b.overall_score) return a.overall_score - b.overall_score;
    return a.source_id.localeCompare(b.source_id);
  });
  const sortedDesc = [...rows].sort((a, b) => {
    if (a.overall_score !== b.overall_score) return b.overall_score - a.overall_score;
    return a.source_id.localeCompare(b.source_id);
  });

  const worst_sources = sortedAsc.slice(0, 5).map((r) => ({
    source_id: r.source_id,
    source_name: r.source_name,
    overall_score: r.overall_score,
  }));
  const best_sources = sortedDesc.slice(0, 5).map((r) => ({
    source_id: r.source_id,
    source_name: r.source_name,
    overall_score: r.overall_score,
  }));

  return {
    tenant_id,
    generated_at: toIso(now),
    overall_data_quality_score,
    overall_band,
    sla_compliance_rate,
    by_dimension,
    by_band,
    total_failed_records_24h,
    worst_sources,
    best_sources,
  };
}
