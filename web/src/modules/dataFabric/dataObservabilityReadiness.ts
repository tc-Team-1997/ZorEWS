// Enterprise Data Fabric Center — pure resolver. 14th IA overlay (additive).
// dataObservabilityReadiness.ts

import {
  ObservabilityEventKind,
  ObservabilitySeverity,
  ReadinessState,
  OBSERVABILITY_EVENT_KINDS,
  listDataSources,
} from './dataFabricEngine';

// ============================================================================
// FNV-1a + Mulberry32 deterministic synthesis
// ============================================================================

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

function isoOf(asOf: Date): string {
  const y = asOf.getUTCFullYear();
  const mo = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const d = String(asOf.getUTCDate()).padStart(2, '0');
  const h = String(asOf.getUTCHours()).padStart(2, '0');
  const mi = String(asOf.getUTCMinutes()).padStart(2, '0');
  const s = String(asOf.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

function isoMinusMinutes(asOf: Date, minutes: number): string {
  const ms = asOf.getTime() - minutes * 60_000;
  return isoOf(new Date(ms));
}

function isoMinusHours(asOf: Date, hours: number): string {
  return isoMinusMinutes(asOf, hours * 60);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundInt(n: number): number {
  return Math.round(n);
}

// ============================================================================
// A. Data Observability
// ============================================================================

export interface ObservabilityEvent {
  event_id: string;
  tenant_id: string;
  source_id: string;
  kind: ObservabilityEventKind;
  severity: ObservabilitySeverity;
  title: string;
  description: string;
  metric_value: number | null;
  threshold: number | null;
  detected_at: string;
  resolved_at: string | null;
  owner: string;
}

const EVENT_OWNERS = [
  'data.steward',
  'platform.ops',
  'quality.lead',
  'integration.team',
  'observability.bot',
  'pipeline.admin',
];

const EVENT_TITLES: Record<ObservabilityEventKind, string> = {
  freshness_lag: 'Data freshness lag detected',
  volume_anomaly: 'Volume anomaly detected',
  schema_change: 'Schema change observed',
  failed_load: 'Failed load batch',
  pipeline_latency_spike: 'Pipeline latency spike',
  data_drift: 'Data drift detected',
  quality_degradation: 'Quality degradation observed',
};

const EVENT_DESCRIPTIONS: Record<ObservabilityEventKind, string> = {
  freshness_lag: 'Source has not synced within expected SLA window',
  volume_anomaly: 'Inbound record count deviates from baseline',
  schema_change: 'Upstream column or type change detected; validation pending',
  failed_load: 'Load batch failed and entered DLQ retry path',
  pipeline_latency_spike: 'Pipeline runtime exceeded p95 baseline',
  data_drift: 'Statistical distribution drift observed against baseline window',
  quality_degradation: 'One or more quality dimensions dropped below threshold',
};

function pickKind(rng: () => number): ObservabilityEventKind {
  const idx = Math.floor(rng() * OBSERVABILITY_EVENT_KINDS.length);
  return OBSERVABILITY_EVENT_KINDS[idx];
}

function pickSeverity(rng: () => number): ObservabilitySeverity {
  const r = rng();
  if (r < 0.5) return 'info';
  if (r < 0.85) return 'warning';
  return 'critical';
}

function buildEventList(
  tenant_id: string,
  asOf: Date,
): ObservabilityEvent[] {
  const sources = listDataSources(tenant_id, asOf);
  if (sources.length === 0) return [];

  const day = dayIndex(asOf);
  const seed = fnv1a(`obs|events|${tenant_id}|${day}`);
  const rng = mulberry32(seed);

  const events: ObservabilityEvent[] = [];
  const TOTAL = 40;

  for (let i = 0; i < TOTAL; i++) {
    const srcIdx = Math.floor(rng() * sources.length);
    const source = sources[srcIdx];
    const kind = pickKind(rng);
    const severity = pickSeverity(rng);
    const isOpen = rng() < 0.6;
    const detectedMinutesAgo = Math.floor(rng() * 24 * 60); // last 24h
    const detected_at = isoMinusMinutes(asOf, detectedMinutesAgo);
    const resolved_at = isOpen
      ? null
      : isoMinusMinutes(asOf, Math.floor(detectedMinutesAgo * rng()));

    let metric_value: number | null = null;
    let threshold: number | null = null;
    switch (kind) {
      case 'freshness_lag':
        metric_value = roundInt(30 + rng() * 240);
        threshold = 60;
        break;
      case 'volume_anomaly':
        metric_value = round2((rng() * 2 - 1) * 0.6);
        threshold = 0.3;
        break;
      case 'schema_change':
        metric_value = roundInt(1 + rng() * 3);
        threshold = 1;
        break;
      case 'failed_load':
        metric_value = roundInt(1 + rng() * 12);
        threshold = 1;
        break;
      case 'pipeline_latency_spike':
        metric_value = roundInt(800 + rng() * 6000);
        threshold = 1500;
        break;
      case 'data_drift':
        metric_value = round2(rng());
        threshold = 0.4;
        break;
      case 'quality_degradation':
        metric_value = roundInt(40 + rng() * 50);
        threshold = 80;
        break;
    }

    const owner = EVENT_OWNERS[Math.floor(rng() * EVENT_OWNERS.length)];

    events.push({
      event_id: `obs-${tenant_id}-${day}-${String(i).padStart(4, '0')}`,
      tenant_id,
      source_id: source.source_id,
      kind,
      severity,
      title: EVENT_TITLES[kind],
      description: EVENT_DESCRIPTIONS[kind],
      metric_value,
      threshold,
      detected_at,
      resolved_at,
      owner,
    });
  }

  // Sort newest first by detected_at
  events.sort((a, b) => (a.detected_at < b.detected_at ? 1 : a.detected_at > b.detected_at ? -1 : 0));
  return events;
}

export function listObservabilityEvents(
  tenant_id: string,
  asOf: Date = new Date(),
  filters?: {
    kind?: ObservabilityEventKind;
    severity?: ObservabilitySeverity;
    source_id?: string;
  },
  limit?: number,
): ObservabilityEvent[] {
  const all = buildEventList(tenant_id, asOf);
  let filtered = all;
  if (filters?.kind) {
    filtered = filtered.filter((e) => e.kind === filters.kind);
  }
  if (filters?.severity) {
    filtered = filtered.filter((e) => e.severity === filters.severity);
  }
  if (filters?.source_id) {
    filtered = filtered.filter((e) => e.source_id === filters.source_id);
  }
  const cap = typeof limit === 'number' && limit > 0 ? limit : 50;
  return filtered.slice(0, cap);
}

export interface SourceHealthRow {
  source_id: string;
  source_name: string;
  freshness_lag_minutes: number;
  volume_change_pct: number;
  schema_changes_7d: number;
  failed_loads_24h: number;
  avg_latency_ms: number;
  drift_score: number;
  quality_degradation: boolean;
  overall_health: 'healthy' | 'degraded' | 'incident';
}

function classifyHealth(row: Omit<SourceHealthRow, 'overall_health'>): 'healthy' | 'degraded' | 'incident' {
  // Critical thresholds → incident
  if (row.freshness_lag_minutes > 240) return 'incident';
  if (Math.abs(row.volume_change_pct) > 0.5) return 'incident';
  if (row.failed_loads_24h > 8) return 'incident';
  if (row.drift_score > 0.7) return 'incident';
  if (row.avg_latency_ms > 5000) return 'incident';

  // Warning thresholds → degraded
  if (row.freshness_lag_minutes > 60) return 'degraded';
  if (Math.abs(row.volume_change_pct) > 0.25) return 'degraded';
  if (row.failed_loads_24h > 2) return 'degraded';
  if (row.drift_score > 0.4) return 'degraded';
  if (row.avg_latency_ms > 1500) return 'degraded';
  if (row.schema_changes_7d > 1) return 'degraded';
  if (row.quality_degradation) return 'degraded';

  return 'healthy';
}

export function buildSourceHealth(
  tenant_id: string,
  asOf: Date = new Date(),
): SourceHealthRow[] {
  const sources = listDataSources(tenant_id, asOf);
  const day = dayIndex(asOf);
  const rows: SourceHealthRow[] = [];

  for (const src of sources) {
    const seed = fnv1a(`obs|health|${tenant_id}|${src.source_id}|${day}`);
    const rng = mulberry32(seed);

    const freshness_lag_minutes = roundInt(rng() * 360);
    const volume_change_pct = round2((rng() * 2 - 1) * 0.7);
    const schema_changes_7d = roundInt(rng() * 4);
    const failed_loads_24h = roundInt(rng() * 12);
    const avg_latency_ms = roundInt(200 + rng() * 5500);
    const drift_score = round2(rng() * 0.9);
    const quality_degradation = rng() < 0.18;

    const base: Omit<SourceHealthRow, 'overall_health'> = {
      source_id: src.source_id,
      source_name: src.name,
      freshness_lag_minutes,
      volume_change_pct,
      schema_changes_7d,
      failed_loads_24h,
      avg_latency_ms,
      drift_score,
      quality_degradation,
    };

    rows.push({ ...base, overall_health: classifyHealth(base) });
  }

  return rows;
}

export interface DataObservabilitySummary {
  tenant_id: string;
  generated_at: string;
  total_events_24h: number;
  open_events: number;
  critical_events: number;
  warning_events: number;
  total_sources: number;
  healthy_sources: number;
  degraded_sources: number;
  incident_sources: number;
  avg_freshness_lag_minutes: number;
  schema_changes_7d_total: number;
  by_kind: Record<ObservabilityEventKind, number>;
  by_severity: Record<ObservabilitySeverity, number>;
}

export function buildDataObservabilitySummary(
  tenant_id: string,
  asOf: Date = new Date(),
): DataObservabilitySummary {
  const events = buildEventList(tenant_id, asOf);
  const health = buildSourceHealth(tenant_id, asOf);

  const by_kind: Record<ObservabilityEventKind, number> = {
    freshness_lag: 0,
    volume_anomaly: 0,
    schema_change: 0,
    failed_load: 0,
    pipeline_latency_spike: 0,
    data_drift: 0,
    quality_degradation: 0,
  };
  const by_severity: Record<ObservabilitySeverity, number> = {
    info: 0,
    warning: 0,
    critical: 0,
  };

  let open_events = 0;
  let critical_events = 0;
  let warning_events = 0;
  for (const e of events) {
    by_kind[e.kind] += 1;
    by_severity[e.severity] += 1;
    if (e.resolved_at === null) open_events += 1;
    if (e.severity === 'critical') critical_events += 1;
    if (e.severity === 'warning') warning_events += 1;
  }

  let healthy_sources = 0;
  let degraded_sources = 0;
  let incident_sources = 0;
  let lagSum = 0;
  let schemaSum = 0;
  for (const h of health) {
    if (h.overall_health === 'healthy') healthy_sources += 1;
    else if (h.overall_health === 'degraded') degraded_sources += 1;
    else incident_sources += 1;
    lagSum += h.freshness_lag_minutes;
    schemaSum += h.schema_changes_7d;
  }

  const total_sources = health.length;
  const avg_freshness_lag_minutes = total_sources > 0 ? round2(lagSum / total_sources) : 0;

  return {
    tenant_id,
    generated_at: isoOf(asOf),
    total_events_24h: events.length,
    open_events,
    critical_events,
    warning_events,
    total_sources,
    healthy_sources,
    degraded_sources,
    incident_sources,
    avg_freshness_lag_minutes,
    schema_changes_7d_total: schemaSum,
    by_kind,
    by_severity,
  };
}

// ============================================================================
// B. AI Data Readiness
// ============================================================================

export interface AIDatasetReadiness {
  dataset_id: string;
  dataset_name: string;
  purpose: 'training' | 'inference' | 'validation';
  model_id: string;
  model_label: string;
  features_available: number;
  features_required: number;
  features_fresh: number;
  feature_availability_pct: number;
  feature_freshness_pct: number;
  quality_score: number;
  input_validation_pass_rate: number;
  readiness_state: ReadinessState;
  last_evaluated_at: string;
}

const PURPOSES: Array<'training' | 'inference' | 'validation'> = [
  'training',
  'inference',
  'validation',
];

const MODEL_SEEDS = [
  { id: 'mdl-pd-banking', label: 'PD Banking XGBoost' },
  { id: 'mdl-fraud-card', label: 'Card Fraud Anomaly' },
  { id: 'mdl-churn-insurance', label: 'Insurance Churn LGBM' },
  { id: 'mdl-claims-severity', label: 'Claims Severity Regressor' },
  { id: 'mdl-aml-screening', label: 'AML Screening Ensemble' },
  { id: 'mdl-collections-priority', label: 'Collections Priority' },
  { id: 'mdl-underwriting-risk', label: 'Underwriting Risk Scorer' },
  { id: 'mdl-policy-lapse', label: 'Policy Lapse Predictor' },
  { id: 'mdl-cross-sell', label: 'Cross-Sell Propensity' },
  { id: 'mdl-credit-limit', label: 'Credit Limit Optimizer' },
  { id: 'mdl-claim-fraud', label: 'Claim Fraud Detector' },
  { id: 'mdl-customer-360', label: 'Customer 360 Embedding' },
];

function classifyReadiness(
  availability_pct: number,
  freshness_pct: number,
  quality_score: number,
  validation_pass_rate: number,
): ReadinessState {
  if (
    availability_pct < 70 ||
    freshness_pct < 60 ||
    quality_score < 50 ||
    validation_pass_rate < 0.7
  ) {
    return 'unavailable';
  }
  if (
    availability_pct < 90 ||
    freshness_pct < 80 ||
    quality_score < 75 ||
    validation_pass_rate < 0.9
  ) {
    return 'degraded';
  }
  return 'ready';
}

function buildDatasetList(
  tenant_id: string,
  asOf: Date,
): AIDatasetReadiness[] {
  const day = dayIndex(asOf);
  const datasets: AIDatasetReadiness[] = [];

  // 4 training + 4 inference + 4 validation = 12 datasets
  for (let p = 0; p < PURPOSES.length; p++) {
    const purpose = PURPOSES[p];
    for (let i = 0; i < 4; i++) {
      const modelIdx = (p * 4 + i) % MODEL_SEEDS.length;
      const model = MODEL_SEEDS[modelIdx];
      const dataset_id = `ds-${tenant_id}-${purpose}-${String(i).padStart(2, '0')}`;
      const seed = fnv1a(`ai|readiness|${tenant_id}|${dataset_id}|${day}`);
      const rng = mulberry32(seed);

      const features_required = roundInt(20 + rng() * 80);
      const features_available = roundInt(features_required * (0.6 + rng() * 0.4));
      const features_fresh = roundInt(features_available * (0.5 + rng() * 0.5));
      const feature_availability_pct = round2(
        clamp((features_available / features_required) * 100, 0, 100),
      );
      const feature_freshness_pct = round2(
        clamp((features_fresh / features_required) * 100, 0, 100),
      );
      const quality_score = round2(40 + rng() * 60);
      const input_validation_pass_rate = round2(0.65 + rng() * 0.35);
      const readiness_state = classifyReadiness(
        feature_availability_pct,
        feature_freshness_pct,
        quality_score,
        input_validation_pass_rate,
      );

      const evaluatedHoursAgo = Math.floor(rng() * 24);
      datasets.push({
        dataset_id,
        dataset_name: `${model.label} ${purpose} dataset ${i + 1}`,
        purpose,
        model_id: model.id,
        model_label: model.label,
        features_available,
        features_required,
        features_fresh,
        feature_availability_pct,
        feature_freshness_pct,
        quality_score,
        input_validation_pass_rate,
        readiness_state,
        last_evaluated_at: isoMinusHours(asOf, evaluatedHoursAgo),
      });
    }
  }

  return datasets;
}

export function listAIDatasetReadiness(
  tenant_id: string,
  asOf: Date = new Date(),
  filters?: {
    readiness_state?: ReadinessState;
    purpose?: 'training' | 'inference' | 'validation';
  },
): AIDatasetReadiness[] {
  const all = buildDatasetList(tenant_id, asOf);
  let filtered = all;
  if (filters?.readiness_state) {
    filtered = filtered.filter((d) => d.readiness_state === filters.readiness_state);
  }
  if (filters?.purpose) {
    filtered = filtered.filter((d) => d.purpose === filters.purpose);
  }
  return filtered;
}

export interface AIDataReadinessSummary {
  tenant_id: string;
  generated_at: string;
  total_datasets: number;
  ready_count: number;
  degraded_count: number;
  unavailable_count: number;
  avg_feature_availability_pct: number;
  avg_feature_freshness_pct: number;
  avg_quality_score: number;
  avg_validation_pass_rate: number;
  by_purpose: Record<'training' | 'inference' | 'validation', number>;
  by_state: Record<ReadinessState, number>;
}

export function buildAIDataReadinessSummary(
  tenant_id: string,
  asOf: Date = new Date(),
): AIDataReadinessSummary {
  const datasets = buildDatasetList(tenant_id, asOf);

  const by_purpose: Record<'training' | 'inference' | 'validation', number> = {
    training: 0,
    inference: 0,
    validation: 0,
  };
  const by_state: Record<ReadinessState, number> = {
    ready: 0,
    degraded: 0,
    unavailable: 0,
  };

  let availabilitySum = 0;
  let freshnessSum = 0;
  let qualitySum = 0;
  let validationSum = 0;
  let ready_count = 0;
  let degraded_count = 0;
  let unavailable_count = 0;

  for (const d of datasets) {
    by_purpose[d.purpose] += 1;
    by_state[d.readiness_state] += 1;
    availabilitySum += d.feature_availability_pct;
    freshnessSum += d.feature_freshness_pct;
    qualitySum += d.quality_score;
    validationSum += d.input_validation_pass_rate;
    if (d.readiness_state === 'ready') ready_count += 1;
    else if (d.readiness_state === 'degraded') degraded_count += 1;
    else unavailable_count += 1;
  }

  const total_datasets = datasets.length;
  const denom = total_datasets > 0 ? total_datasets : 1;

  return {
    tenant_id,
    generated_at: isoOf(asOf),
    total_datasets,
    ready_count,
    degraded_count,
    unavailable_count,
    avg_feature_availability_pct: total_datasets > 0 ? round2(availabilitySum / denom) : 0,
    avg_feature_freshness_pct: total_datasets > 0 ? round2(freshnessSum / denom) : 0,
    avg_quality_score: total_datasets > 0 ? round2(qualitySum / denom) : 0,
    avg_validation_pass_rate: total_datasets > 0 ? round2(validationSum / denom) : 0,
    by_purpose,
    by_state,
  };
}

// ============================================================================
// C. Executive Data Health Dashboard
// ============================================================================

export interface ExecutiveDataHealthDashboard {
  tenant_id: string;
  generated_at: string;
  overall_data_health_score: number;
  integration_success_rate: number;
  pipeline_availability_pct: number;
  data_quality_score: number;
  freshness_score: number;
  governance_compliance_score: number;
  ai_readiness_score: number;
  trend_30d: Array<{
    day_offset: number;
    health_score: number;
    integration_success_rate: number;
    quality_score: number;
    freshness_score: number;
  }>;
  top_incidents: Array<{
    event_id: string;
    source_id: string;
    kind: ObservabilityEventKind;
    severity: ObservabilitySeverity;
    detected_at: string;
  }>;
}

export function buildExecutiveDataHealthDashboard(
  tenant_id: string,
  asOf: Date = new Date(),
): ExecutiveDataHealthDashboard {
  const day = dayIndex(asOf);
  const seed = fnv1a(`exec|datahealth|${tenant_id}|${day}`);
  const rng = mulberry32(seed);

  const integration_success_rate = round2(clamp(0.82 + rng() * 0.17, 0, 1));
  const pipeline_availability_pct = round2(clamp(88 + rng() * 11, 0, 100));
  const data_quality_score = round2(clamp(72 + rng() * 25, 0, 100));
  const freshness_score = round2(clamp(70 + rng() * 27, 0, 100));
  const governance_compliance_score = round2(clamp(78 + rng() * 20, 0, 100));

  // ai_readiness_score derived from the actual dataset summary
  const aiSummary = buildAIDataReadinessSummary(tenant_id, asOf);
  const ai_readiness_score = aiSummary.total_datasets > 0
    ? round2(
        clamp(
          (aiSummary.avg_feature_availability_pct * 0.3 +
            aiSummary.avg_feature_freshness_pct * 0.25 +
            aiSummary.avg_quality_score * 0.25 +
            aiSummary.avg_validation_pass_rate * 100 * 0.2),
          0,
          100,
        ),
      )
    : 0;

  const overall_data_health_score = round2(
    clamp(
      integration_success_rate * 100 * 0.18 +
        pipeline_availability_pct * 0.18 +
        data_quality_score * 0.2 +
        freshness_score * 0.16 +
        governance_compliance_score * 0.14 +
        ai_readiness_score * 0.14,
      0,
      100,
    ),
  );

  // 30-day trend (oldest first; day_offset -29 .. 0 where 0 = today)
  const trend_30d: ExecutiveDataHealthDashboard['trend_30d'] = [];
  for (let i = 0; i < 30; i++) {
    const offset = -29 + i;
    const tSeed = fnv1a(`exec|trend|${tenant_id}|${day + offset}`);
    const tRng = mulberry32(tSeed);
    const drift = (tRng() - 0.5) * 8; // ±4 point drift around today
    trend_30d.push({
      day_offset: offset,
      health_score: round2(clamp(overall_data_health_score + drift, 0, 100)),
      integration_success_rate: round2(clamp(integration_success_rate + (tRng() - 0.5) * 0.08, 0, 1)),
      quality_score: round2(clamp(data_quality_score + (tRng() - 0.5) * 6, 0, 100)),
      freshness_score: round2(clamp(freshness_score + (tRng() - 0.5) * 6, 0, 100)),
    });
  }

  // top_incidents: 5 newest critical or warning events
  const events = buildEventList(tenant_id, asOf);
  const incidents = events
    .filter((e) => e.severity === 'critical' || e.severity === 'warning')
    .slice(0, 5)
    .map((e) => ({
      event_id: e.event_id,
      source_id: e.source_id,
      kind: e.kind,
      severity: e.severity,
      detected_at: e.detected_at,
    }));

  // Ensure exactly 5 incidents by padding from any events if needed
  if (incidents.length < 5) {
    for (const e of events) {
      if (incidents.length >= 5) break;
      if (!incidents.find((i) => i.event_id === e.event_id)) {
        incidents.push({
          event_id: e.event_id,
          source_id: e.source_id,
          kind: e.kind,
          severity: e.severity,
          detected_at: e.detected_at,
        });
      }
    }
  }

  return {
    tenant_id,
    generated_at: isoOf(asOf),
    overall_data_health_score,
    integration_success_rate,
    pipeline_availability_pct,
    data_quality_score,
    freshness_score,
    governance_compliance_score,
    ai_readiness_score,
    trend_30d,
    top_incidents: incidents.slice(0, 5),
  };
}
