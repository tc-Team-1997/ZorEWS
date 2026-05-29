// services/bff/src/alert_classification_config.ts
//
// Master Setup — Alert Classification Setup (MASTER SETUP spec screen #12).
//
// Operator-editable RAG (Red / Amber / Green) score-band configuration.
// The spec's worked example:
//   Red   → >100      → Immediate action
//   Amber → 60–100    → Review
//   Green → <60       → No action
//
// Modelled as TWO editable boundaries (amber_min, red_min) that DERIVE a
// contiguous, non-overlapping 3-band partition by construction:
//   green [score_floor, amber_min)
//   amber [amber_min,  red_min)
//   red   [red_min,    ∞)   — open-ended top band
// This makes gaps/overlaps structurally impossible — there's no way to save
// a partition with a hole. Per-band `action_required` text is independently
// editable. `classifyScore` is the pure helper the runtime classifier (and
// the SPA "test a score" affordance) calls.
//
// Distinct from /v1/alerts/classification/spec (M8.1) — that maps a fixed
// WireSeverity → BIL colour with HARDCODED bands. This is the tenant-editable
// SCORE-band setup the runtime would consume. In-memory + deterministic seed;
// env-gated pg swap target (data/schema/046_alert_classification_config.sql).
// No existing route/table touched.

// ─── Enums ───────────────────────────────────────────────────────────

// Canonical low → high severity order.
export const ALL_RAG_BANDS = ['green', 'amber', 'red'] as const;
export type RagBand = (typeof ALL_RAG_BANDS)[number];
export function isRagBand(v: unknown): v is RagBand {
  return typeof v === 'string' && (ALL_RAG_BANDS as readonly string[]).includes(v);
}

const BAND_LABEL: Record<RagBand, string> = { green: 'Green', amber: 'Amber', red: 'Red' };
const BAND_COLOR: Record<RagBand, string> = { green: '#16a34a', amber: '#d97706', red: '#dc2626' };
const BAND_RANK: Record<RagBand, number> = { green: 0, amber: 1, red: 2 };

// ─── Limits ──────────────────────────────────────────────────────────

export const SCORE_FLOOR = 0;
export const SCORE_CEILING = 1000; // boundaries must sit in (floor, ceiling]
export const ACTION_MAX = 200;

// Default boundaries + actions mirror the MASTER SETUP worked example.
const DEFAULT_AMBER_MIN = 60;
const DEFAULT_RED_MIN = 100;
const DEFAULT_ACTIONS: Record<RagBand, string> = {
  green: 'No action — monitor',
  amber: 'Review within SLA',
  red: 'Immediate action — escalate',
};

// ─── Shapes ──────────────────────────────────────────────────────────

export interface RagClassificationBand {
  band: RagBand;
  label: string;
  color_hex: string;
  severity_rank: number;
  min_score: number; // inclusive
  max_score: number | null; // exclusive; null = open-ended (red)
  action_required: string;
  range_label: string; // human "< 60" / "60–100" / "≥ 100"
}

export interface AlertClassificationConfig {
  tenant_id: string;
  score_floor: number;
  amber_min: number;
  red_min: number;
  bands: RagClassificationBand[]; // [green, amber, red]
  updated_at: string;
  updated_by: string;
}

export interface ScoreClassification {
  score: number;
  band: RagBand;
  label: string;
  color_hex: string;
  action_required: string;
}

// ─── Error ───────────────────────────────────────────────────────────

export type AlertClassificationConfigErrorCode = 'invalid_input' | 'invalid_boundaries' | 'invalid_band';
export class AlertClassificationConfigError extends Error {
  constructor(public code: AlertClassificationConfigErrorCode, message: string) {
    super(message);
    this.name = 'AlertClassificationConfigError';
  }
}

// ─── Internal record ─────────────────────────────────────────────────

interface ConfigRecord {
  amber_min: number;
  red_min: number;
  actions: Record<RagBand, string>;
  updated_at: string;
  updated_by: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rangeLabel(band: RagBand, minScore: number, maxScore: number | null): string {
  if (band === 'green') return `< ${maxScore}`;
  if (band === 'red') return `≥ ${minScore}`;
  return `${minScore}–${maxScore}`;
}

function toBands(rec: ConfigRecord): RagClassificationBand[] {
  const spec: { band: RagBand; min: number; max: number | null }[] = [
    { band: 'green', min: SCORE_FLOOR, max: rec.amber_min },
    { band: 'amber', min: rec.amber_min, max: rec.red_min },
    { band: 'red', min: rec.red_min, max: null },
  ];
  return spec.map((s) => ({
    band: s.band,
    label: BAND_LABEL[s.band],
    color_hex: BAND_COLOR[s.band],
    severity_rank: BAND_RANK[s.band],
    min_score: s.min,
    max_score: s.max,
    action_required: rec.actions[s.band],
    range_label: rangeLabel(s.band, s.min, s.max),
  }));
}

function toConfig(tenant: string, rec: ConfigRecord): AlertClassificationConfig {
  return {
    tenant_id: tenant,
    score_floor: SCORE_FLOOR,
    amber_min: rec.amber_min,
    red_min: rec.red_min,
    bands: toBands(rec),
    updated_at: rec.updated_at,
    updated_by: rec.updated_by,
  };
}

// ─── Pure validators / helpers ───────────────────────────────────────

export function validateBoundaries(amberMin: unknown, redMin: unknown): { amber_min: number; red_min: number } {
  if (typeof amberMin !== 'number' || !Number.isFinite(amberMin)) {
    throw new AlertClassificationConfigError('invalid_input', 'amber_min must be a finite number');
  }
  if (typeof redMin !== 'number' || !Number.isFinite(redMin)) {
    throw new AlertClassificationConfigError('invalid_input', 'red_min must be a finite number');
  }
  const amber_min = round2(amberMin);
  const red_min = round2(redMin);
  // green [0, amber_min) must be non-empty, amber [amber_min, red_min) non-empty,
  // and both within (floor, ceiling]. Strict ordering keeps every band reachable.
  if (amber_min <= SCORE_FLOOR) {
    throw new AlertClassificationConfigError('invalid_boundaries', `amber_min must be > ${SCORE_FLOOR}`);
  }
  if (red_min <= amber_min) {
    throw new AlertClassificationConfigError('invalid_boundaries', 'red_min must be > amber_min');
  }
  if (red_min > SCORE_CEILING) {
    throw new AlertClassificationConfigError('invalid_boundaries', `red_min must be ≤ ${SCORE_CEILING}`);
  }
  return { amber_min, red_min };
}

function validateAction(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AlertClassificationConfigError('invalid_input', 'action_required is required');
  }
  const a = raw.trim();
  if (a.length > ACTION_MAX) {
    throw new AlertClassificationConfigError('invalid_input', `action_required exceeds ${ACTION_MAX} chars`);
  }
  return a;
}

// Pure: which band does `score` fall into, given a config? green is the
// bottom (< amber_min), red the open top (≥ red_min). Scores below the floor
// clamp into green; the partition has no holes by construction.
export function classifyScore(config: AlertClassificationConfig, score: number): ScoreClassification {
  const band: RagBand = score >= config.red_min ? 'red' : score >= config.amber_min ? 'amber' : 'green';
  const row = config.bands.find((b) => b.band === band)!;
  return { score, band, label: row.label, color_hex: row.color_hex, action_required: row.action_required };
}

// ─── Store ───────────────────────────────────────────────────────────

export class InMemoryAlertClassificationConfigStore {
  private byTenant = new Map<string, ConfigRecord>();

  private seeded(tenant: string): ConfigRecord {
    let rec = this.byTenant.get(tenant);
    if (rec) return rec;
    rec = {
      amber_min: DEFAULT_AMBER_MIN,
      red_min: DEFAULT_RED_MIN,
      actions: { ...DEFAULT_ACTIONS },
      updated_at: new Date(0).toISOString(),
      updated_by: 'system',
    };
    this.byTenant.set(tenant, rec);
    return rec;
  }

  get(tenant: string): AlertClassificationConfig {
    return toConfig(tenant, this.seeded(tenant));
  }

  setBoundaries(tenant: string, amberMin: unknown, redMin: unknown, actor: string, nowMs: number): AlertClassificationConfig {
    const { amber_min, red_min } = validateBoundaries(amberMin, redMin);
    const rec = this.seeded(tenant);
    rec.amber_min = amber_min;
    rec.red_min = red_min;
    rec.updated_at = new Date(nowMs).toISOString();
    rec.updated_by = actor;
    return toConfig(tenant, rec);
  }

  setAction(tenant: string, band: unknown, action: unknown, actor: string, nowMs: number): AlertClassificationConfig {
    if (!isRagBand(band)) throw new AlertClassificationConfigError('invalid_band', `unknown band '${String(band)}'`);
    const rec = this.seeded(tenant);
    rec.actions[band] = validateAction(action);
    rec.updated_at = new Date(nowMs).toISOString();
    rec.updated_by = actor;
    return toConfig(tenant, rec);
  }

  reset(tenant: string, actor: string, nowMs: number): AlertClassificationConfig {
    const rec: ConfigRecord = {
      amber_min: DEFAULT_AMBER_MIN,
      red_min: DEFAULT_RED_MIN,
      actions: { ...DEFAULT_ACTIONS },
      updated_at: new Date(nowMs).toISOString(),
      updated_by: actor,
    };
    this.byTenant.set(tenant, rec);
    return toConfig(tenant, rec);
  }
}

// ─── Singleton ───────────────────────────────────────────────────────

export const defaultAlertClassificationConfigStore = new InMemoryAlertClassificationConfigStore();
export function _resetAlertClassificationConfigStore(): void {
  const fresh = new InMemoryAlertClassificationConfigStore();
  const target = defaultAlertClassificationConfigStore as unknown as { byTenant: Map<string, unknown> };
  const src = fresh as unknown as { byTenant: Map<string, unknown> };
  target.byTenant = src.byTenant;
}
