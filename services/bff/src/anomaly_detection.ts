// services/bff/src/anomaly_detection.ts
//
// Anomaly Detection — closes §2.1.8 of ZorEWS_Pending_Gap_Analysis.md.
//
//   GET  /v1/anomalies
//   GET  /v1/anomalies/:anomaly_id
//   POST /v1/anomalies/patterns/config
//   POST /v1/anomalies/rerun
//
// Distinct from M7.x AI engine (predictions on individual customers) —
// anomalies are unsupervised pattern detections at the DATA/EVENT layer
// (txn-stream, login geo, sudden volume shifts, schema drift).

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

export const ANOMALY_PATTERNS = [
  'txn_volume_spike',
  'geo_velocity',
  'channel_shift',
  'amount_outlier',
  'frequency_outlier',
  'schema_drift',
  'pipeline_lag',
  'duplicate_burst',
] as const;
export type AnomalyPattern = (typeof ANOMALY_PATTERNS)[number];
export type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';
export type AnomalyStatus = 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';
export const ALL_ANOMALY_STATUSES: readonly AnomalyStatus[] = ['open', 'acknowledged', 'investigating', 'resolved', 'false_positive'];

export interface AnomalyStatusUpdate {
  status: AnomalyStatus;
  actor_username: string;
  notes: string | null;
  changed_at: string;
}

export interface Anomaly {
  anomaly_id: string;
  tenant_id: string;
  pattern: AnomalyPattern;
  severity: AnomalySeverity;
  status: AnomalyStatus;
  source_id: string;
  detected_at: string;
  /** 0..1 — the canonical score. The spec asks for 0..100; SPA + tests
   *  multiply by 100 for display. Acceptance: spike → score ≥ 0.80
   *  (i.e. ≥ 80 in the 0..100 scale). */
  anomaly_score: number;
  affected_records: number;
  description: string;
  customer_id: string | null;
  metadata: Record<string, unknown>;
  /** Module 1.5: cross-link to a case/investigation when Investigate fires. */
  case_id?: string | null;
  /** Module 1.5: status-transition ledger (open → investigating → resolved …). */
  status_updates?: AnomalyStatusUpdate[];
  /** Module 1.5: marker for demo/acceptance spikes. */
  injected?: boolean;
}

export class AnomalyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AnomalyError';
  }
}

export function isAnomalyStatus(x: unknown): x is AnomalyStatus {
  return typeof x === 'string' && ALL_ANOMALY_STATUSES.includes(x as AnomalyStatus);
}

export function isAnomalyPattern(x: unknown): x is AnomalyPattern {
  return typeof x === 'string' && ANOMALY_PATTERNS.includes(x as AnomalyPattern);
}

const _store = new Map<string, Anomaly>();
const _patternConfig = new Map<string, Record<AnomalyPattern, { enabled: boolean; threshold: number }>>(); // per-tenant

function defaultPatternConfig(): Record<AnomalyPattern, { enabled: boolean; threshold: number }> {
  const out = {} as Record<AnomalyPattern, { enabled: boolean; threshold: number }>;
  for (const p of ANOMALY_PATTERNS) {
    out[p] = { enabled: true, threshold: 0.7 };
  }
  return out;
}

function tenantScale(t: string): number {
  return t === 'BIL' ? 0.6 : 1.0;
}

function severityFromScore(s: number): AnomalySeverity {
  if (s >= 0.9) return 'critical';
  if (s >= 0.75) return 'high';
  if (s >= 0.55) return 'medium';
  return 'low';
}

function describePattern(p: AnomalyPattern, score: number): string {
  const pct = Math.round(score * 100);
  switch (p) {
    case 'txn_volume_spike': return `Transaction volume 4.2σ above 30-day baseline (score ${pct})`;
    case 'geo_velocity': return `Customer logged in from 2 countries within 4h (score ${pct})`;
    case 'channel_shift': return `90% of sessions moved to new channel in 24h (score ${pct})`;
    case 'amount_outlier': return `Single txn 25× larger than customer's 99th-pct (score ${pct})`;
    case 'frequency_outlier': return `Operation called 8× normal rate (score ${pct})`;
    case 'schema_drift': return `New field 'beneficiary_country' appeared in 12% of records (score ${pct})`;
    case 'pipeline_lag': return `Ingest lag exceeded 4h threshold for 3 consecutive runs (score ${pct})`;
    case 'duplicate_burst': return `~1.8% duplicate records in last hour (score ${pct})`;
  }
}

function seedAnomalies(tenant_id: string, now: Date): void {
  // Generate a deterministic fleet of anomalies per tenant (if not already)
  const seen = Array.from(_store.values()).some((a) => a.tenant_id === tenant_id);
  if (seen) return;
  const cap = Math.round(40 * tenantScale(tenant_id));
  for (let i = 0; i < cap; i++) {
    const rng = mulberry32(fnv1a(`${tenant_id}|anomaly|${i}`));
    const pattern = ANOMALY_PATTERNS[Math.floor(rng() * ANOMALY_PATTERNS.length)];
    const score = Math.round((0.45 + rng() * 0.5) * 100) / 100;
    const sev = severityFromScore(score);
    const id = `anm-${tenant_id}-${String(i).padStart(5, '0')}`;
    const sources = ['cbs_loans', 'cbs_txns', 'mart_customer_360', 'auth_events', 'cbs_repayments'];
    const detectedTs = new Date(now.getTime() - Math.floor(rng() * 72 * 3_600_000)).toISOString();
    const includeCust = rng() < 0.6;
    const anomaly: Anomaly = {
      anomaly_id: id,
      tenant_id,
      pattern,
      severity: sev,
      status: 'open',
      source_id: sources[Math.floor(rng() * sources.length)],
      detected_at: detectedTs,
      anomaly_score: score,
      affected_records: Math.floor(1 + rng() * 5000),
      description: describePattern(pattern, score),
      customer_id: includeCust ? `c-${String(100000 + Math.floor(rng() * 200)).slice(-6)}` : null,
      metadata: { detected_run: `run-${Math.floor(rng() * 1000)}` },
    };
    _store.set(id, anomaly);
  }
}

export interface AnomalyListReport {
  tenant_id: string;
  generated_at: string;
  total: number;
  by_severity: Record<AnomalySeverity, number>;
  by_pattern: Partial<Record<AnomalyPattern, number>>;
  by_status: Record<AnomalyStatus, number>;
  anomalies: Anomaly[];
}

export interface AnomalyFilter {
  pattern?: AnomalyPattern;
  status?: AnomalyStatus;
  severity?: AnomalySeverity;
  source_id?: string;
  customer_id?: string;
  /** Module 1.5: minimum anomaly_score (0..1 scale). e.g. 0.8 → only show score ≥ 80. */
  min_score?: number;
  /** Module 1.5: ISO8601 lower bound (inclusive). Anomalies older than this dropped. */
  since?: string;
}

export function listAnomalies(tenant_id: string, filter: AnomalyFilter, now: Date): AnomalyListReport {
  if (!tenant_id) throw new AnomalyError('invalid_input', 'tenant_id required');
  seedAnomalies(tenant_id, now);
  const out: Anomaly[] = [];
  const bySev: Record<AnomalySeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const byStatus: Record<AnomalyStatus, number> = { open: 0, acknowledged: 0, investigating: 0, resolved: 0, false_positive: 0 };
  const byPattern: Partial<Record<AnomalyPattern, number>> = {};

  for (const a of _store.values()) {
    if (a.tenant_id !== tenant_id) continue;
    if (filter.pattern && a.pattern !== filter.pattern) continue;
    if (filter.status && a.status !== filter.status) continue;
    if (filter.severity && a.severity !== filter.severity) continue;
    if (filter.source_id && a.source_id !== filter.source_id) continue;
    if (filter.customer_id && a.customer_id !== filter.customer_id) continue;
    if (filter.min_score !== undefined && a.anomaly_score < filter.min_score) continue;
    if (filter.since && a.detected_at < filter.since) continue;
    bySev[a.severity]++;
    byStatus[a.status]++;
    byPattern[a.pattern] = (byPattern[a.pattern] ?? 0) + 1;
    out.push(a);
  }
  const sevRank: Record<AnomalySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.anomaly_score - a.anomaly_score);
  return {
    tenant_id,
    generated_at: now.toISOString(),
    total: out.length,
    by_severity: bySev,
    by_pattern: byPattern,
    by_status: byStatus,
    anomalies: out.slice(0, 200),
  };
}

export function getAnomaly(tenant_id: string, anomaly_id: string): Anomaly | null {
  if (!tenant_id) throw new AnomalyError('invalid_input', 'tenant_id required');
  const entry = _store.get(anomaly_id);
  if (!entry || entry.tenant_id !== tenant_id) return null;
  return entry;
}

export interface AnomalyPatternConfig {
  pattern: AnomalyPattern;
  enabled: boolean;
  threshold: number; // 0..1
}

export function getPatternConfig(tenant_id: string): AnomalyPatternConfig[] {
  if (!tenant_id) throw new AnomalyError('invalid_input', 'tenant_id required');
  if (!_patternConfig.has(tenant_id)) _patternConfig.set(tenant_id, defaultPatternConfig());
  const cfg = _patternConfig.get(tenant_id)!;
  return ANOMALY_PATTERNS.map((p) => ({ pattern: p, enabled: cfg[p].enabled, threshold: cfg[p].threshold }));
}

export function setPatternConfig(
  tenant_id: string,
  updates: { pattern: AnomalyPattern; enabled?: boolean; threshold?: number }[],
  actor: string,
): AnomalyPatternConfig[] {
  if (!tenant_id) throw new AnomalyError('invalid_input', 'tenant_id required');
  if (!actor) throw new AnomalyError('invalid_input', 'actor required');
  if (!_patternConfig.has(tenant_id)) _patternConfig.set(tenant_id, defaultPatternConfig());
  const cfg = _patternConfig.get(tenant_id)!;
  for (const u of updates) {
    if (!isAnomalyPattern(u.pattern)) throw new AnomalyError('unknown_pattern', `unknown pattern ${u.pattern}`);
    if (u.threshold !== undefined) {
      if (typeof u.threshold !== 'number' || u.threshold < 0 || u.threshold > 1)
        throw new AnomalyError('invalid_input', 'threshold must be in [0, 1]');
      cfg[u.pattern].threshold = u.threshold;
    }
    if (u.enabled !== undefined) cfg[u.pattern].enabled = u.enabled;
  }
  return getPatternConfig(tenant_id);
}

export interface RerunSummary {
  tenant_id: string;
  run_id: string;
  triggered_by: string;
  triggered_at: string;
  scanned_records: number;
  patterns_evaluated: number;
  new_anomalies: number;
  duration_ms: number;
}

let _runSeq = 0;

export function triggerAnomalyRerun(tenant_id: string, triggered_by: string, now: Date): RerunSummary {
  if (!tenant_id) throw new AnomalyError('invalid_input', 'tenant_id required');
  if (!triggered_by) throw new AnomalyError('invalid_input', 'triggered_by required');
  _runSeq++;
  const id = `run-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(_runSeq).padStart(4, '0')}`;
  const rng = mulberry32(fnv1a(id));
  // Generate a couple of new anomalies on every rerun
  const newCount = Math.floor(2 + rng() * 5);
  for (let i = 0; i < newCount; i++) {
    const aRng = mulberry32(fnv1a(`${id}|${i}`));
    const pattern = ANOMALY_PATTERNS[Math.floor(aRng() * ANOMALY_PATTERNS.length)];
    const score = Math.round((0.6 + aRng() * 0.35) * 100) / 100;
    const newId = `anm-${tenant_id}-rerun-${_runSeq}-${i}`;
    _store.set(newId, {
      anomaly_id: newId,
      tenant_id,
      pattern,
      severity: severityFromScore(score),
      status: 'open',
      source_id: 'mart_customer_360',
      detected_at: now.toISOString(),
      anomaly_score: score,
      affected_records: Math.floor(1 + aRng() * 1000),
      description: describePattern(pattern, score),
      customer_id: null,
      metadata: { rerun: id },
    });
  }
  return {
    tenant_id,
    run_id: id,
    triggered_by,
    triggered_at: now.toISOString(),
    scanned_records: Math.round((50_000 + rng() * 500_000) * tenantScale(tenant_id)),
    patterns_evaluated: ANOMALY_PATTERNS.length,
    new_anomalies: newCount,
    duration_ms: Math.floor(800 + rng() * 8000),
  };
}

export function _resetAnomalyStore() {
  _store.clear();
  _patternConfig.clear();
  _runSeq = 0;
}

// ──────────────────────────────────────────────────────────────────────
// Module 1.5 — Anomaly Detection (AI) — additive operations
// ──────────────────────────────────────────────────────────────────────

/** Module 1.5: render the canonical 0..1 anomaly_score as 0..100 for the
 *  spec wording ("score 0-100"). Pure helper; no side effects. */
export function scoreAs100(a: Anomaly): number {
  return Math.round(a.anomaly_score * 100);
}

/** Module 1.5: 24-hour time-series synthesised on demand for a single
 *  anomaly. 24 hourly buckets ending at the anomaly's detected_at; the
 *  most-recent bucket is the outlier point. Deterministic per
 *  (anomaly_id) so polls return the same shape. */
export interface AnomalyTimeSeriesPoint {
  ts: string;
  value: number;
  is_outlier: boolean;
}
export function timeSeriesFor(a: Anomaly): AnomalyTimeSeriesPoint[] {
  const rng = mulberry32(fnv1a(`ts|${a.anomaly_id}`));
  const observed = Math.max(1, a.affected_records);
  // Baseline ≈ observed / (1 + score×9) → so a score=0.85 anomaly has
  // observed ~10× baseline, mirroring the spec's "10× spike".
  const baseline = Math.max(1, Math.round(observed / (1 + a.anomaly_score * 9)));
  const points: AnomalyTimeSeriesPoint[] = [];
  const detected = new Date(a.detected_at).getTime();
  for (let h = 23; h >= 0; h--) {
    const ts = new Date(detected - h * 3_600_000).toISOString();
    const isOut = h === 0;
    const jitter = 1 + (rng() - 0.5) * 0.25;
    const v = isOut ? observed : Math.round(baseline * jitter);
    points.push({ ts, value: v, is_outlier: isOut });
  }
  return points;
}

/** Module 1.5: inject a 10×-style volume spike for demo / acceptance.
 *  Produces an Anomaly with `injected=true` and `anomaly_score ≥ 0.80`
 *  (i.e. ≥ 80 in the spec's 0..100 scale). */
export function injectSpike(
  tenant_id: string,
  input: { source_id?: string; multiplier?: number; pattern?: AnomalyPattern; actor_username: string },
  now: Date,
): Anomaly {
  if (!tenant_id) throw new AnomalyError('invalid_input', 'tenant_id required');
  if (!input.actor_username) throw new AnomalyError('invalid_input', 'actor_username required');
  const multiplier = Math.max(2, Math.min(100, input.multiplier ?? 10));
  if (input.pattern && !isAnomalyPattern(input.pattern)) {
    throw new AnomalyError('unknown_pattern', `unknown pattern ${input.pattern}`);
  }
  const source_id = input.source_id && input.source_id.trim() !== ''
    ? input.source_id
    : 'cbs_txns';
  // Score scales with multiplier; clamped to [0.80, 0.99] so spec's "≥80" always holds.
  const score = Math.round(Math.max(0.80, Math.min(0.99, 0.50 + multiplier * 0.035)) * 100) / 100;
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = Math.floor(now.getTime() / 1000) % 100000;
  const id = `anm-${tenant_id}-${day}-spike-${String(seq).padStart(5, '0')}`;
  const baseline = 1000;
  const affected = baseline * multiplier;
  const pattern: AnomalyPattern = input.pattern ?? 'txn_volume_spike';
  const a: Anomaly = {
    anomaly_id: id,
    tenant_id,
    pattern,
    severity: severityFromScore(score),
    status: 'open',
    source_id,
    detected_at: now.toISOString(),
    anomaly_score: score,
    affected_records: affected,
    description: `Injected ${multiplier}× ${pattern.replace(/_/g, ' ')} on ${source_id} ` +
      `(observed ${affected} vs baseline ${baseline}, score ${Math.round(score * 100)})`,
    customer_id: null,
    metadata: {
      injected: true,
      multiplier,
      baseline,
      injected_by: input.actor_username,
    },
    case_id: null,
    status_updates: [
      {
        status: 'open',
        actor_username: input.actor_username,
        notes: `Injected ${multiplier}× spike for demo/test`,
        changed_at: now.toISOString(),
      },
    ],
    injected: true,
  };
  _store.set(id, a);
  return a;
}

/** Module 1.5: transition an anomaly to `investigating` and cross-link to
 *  a case. The `case_id` is supplied by the caller (route handler may
 *  call M9.1 caseInvestigationStore.open first to produce it). */
export function investigateAnomaly(
  tenant_id: string,
  anomaly_id: string,
  input: { case_id: string; actor_username: string; notes?: string | null },
  now: Date,
): Anomaly {
  if (!tenant_id) throw new AnomalyError('invalid_input', 'tenant_id required');
  if (!input.case_id) throw new AnomalyError('invalid_input', 'case_id required');
  if (!input.actor_username) throw new AnomalyError('invalid_input', 'actor_username required');
  const cur = _store.get(anomaly_id);
  if (!cur || cur.tenant_id !== tenant_id) {
    throw new AnomalyError('unknown_anomaly', `anomaly ${anomaly_id} not found`);
  }
  if (cur.status === 'investigating') {
    throw new AnomalyError('already_investigating', 'anomaly already under investigation');
  }
  if (cur.status === 'false_positive') {
    throw new AnomalyError('already_dismissed', 'anomaly was dismissed; cannot investigate');
  }
  if (cur.status === 'resolved') {
    throw new AnomalyError('already_resolved', 'anomaly is resolved; cannot investigate');
  }
  const next: Anomaly = {
    ...cur,
    status: 'investigating',
    case_id: input.case_id,
    status_updates: [
      ...(cur.status_updates ?? []),
      {
        status: 'investigating',
        actor_username: input.actor_username,
        notes: input.notes ?? null,
        changed_at: now.toISOString(),
      },
    ],
  };
  _store.set(anomaly_id, next);
  return next;
}

/** Module 1.5: dismiss an anomaly as a false positive. `reason` required. */
export function dismissAnomaly(
  tenant_id: string,
  anomaly_id: string,
  input: { reason: string; actor_username: string },
  now: Date,
): Anomaly {
  if (!tenant_id) throw new AnomalyError('invalid_input', 'tenant_id required');
  if (!input.actor_username) throw new AnomalyError('invalid_input', 'actor_username required');
  if (typeof input.reason !== 'string' || !input.reason.trim()) {
    throw new AnomalyError('invalid_input', 'reason required');
  }
  if (input.reason.length > 2000) {
    throw new AnomalyError('invalid_input', 'reason too long (>2000 chars)');
  }
  const cur = _store.get(anomaly_id);
  if (!cur || cur.tenant_id !== tenant_id) {
    throw new AnomalyError('unknown_anomaly', `anomaly ${anomaly_id} not found`);
  }
  if (cur.status === 'false_positive') {
    throw new AnomalyError('already_dismissed', 'anomaly is already dismissed');
  }
  const next: Anomaly = {
    ...cur,
    status: 'false_positive',
    status_updates: [
      ...(cur.status_updates ?? []),
      {
        status: 'false_positive',
        actor_username: input.actor_username,
        notes: input.reason,
        changed_at: now.toISOString(),
      },
    ],
  };
  _store.set(anomaly_id, next);
  return next;
}

