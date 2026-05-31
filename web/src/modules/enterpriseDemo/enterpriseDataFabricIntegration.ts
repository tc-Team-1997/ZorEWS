/**
 * Enterprise Demo Foundation — Data Fabric Integration overlay (slice 15).
 *
 * Additive: registers enterprise demo entities as virtual sources/pipelines/lineage
 * without mutating the existing Data Fabric module. Pure + deterministic.
 */

// ---------------------------------------------------------------------------
// Local time helper (rule 5: only place that calls the no-arg Date constructor)
// ---------------------------------------------------------------------------

/** Local current-time helper; the only call site for the no-arg Date constructor. */
function currentTime(): Date {
  return new Date();
}

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

export const DEMO_SOURCE_KINDS = [
  'banking_core',
  'banking_collections',
  'insurance_core',
  'insurance_claims',
  'insurance_agents',
  'cross_domain',
] as const;
export type DemoSourceKind = (typeof DEMO_SOURCE_KINDS)[number];

export const DEMO_PIPELINE_KINDS = [
  'etl_daily',
  'etl_streaming',
  'feature_build',
  'quality_scan',
  'reconciliation',
] as const;
export type DemoPipelineKind = (typeof DEMO_PIPELINE_KINDS)[number];

export const QUALITY_GRADES = ['A', 'B', 'C', 'D'] as const;
export type QualityGrade = (typeof QUALITY_GRADES)[number];

export type QualityDimension =
  | 'completeness'
  | 'accuracy'
  | 'consistency'
  | 'validity'
  | 'timeliness'
  | 'uniqueness';

const QUALITY_DIMENSIONS: QualityDimension[] = [
  'completeness',
  'accuracy',
  'consistency',
  'validity',
  'timeliness',
  'uniqueness',
];

export type AiWorkload =
  | 'risk_scoring'
  | 'fraud_detection'
  | 'churn_prediction'
  | 'lapse_prediction'
  | 'recovery_forecast';

const AI_WORKLOADS: AiWorkload[] = [
  'risk_scoring',
  'fraud_detection',
  'churn_prediction',
  'lapse_prediction',
  'recovery_forecast',
];

// ---------------------------------------------------------------------------
// Reference catalogs (sparse, declared locally)
// ---------------------------------------------------------------------------

const BANKS = ['HDFC Bank', 'ICICI Bank', 'SBI', 'Axis Bank', 'Kotak Mahindra'];
const INSURERS = ['ICICI Lombard', 'HDFC Ergo', 'SBI General'];

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface DemoSourceSystem {
  source_id: string;
  tenant_id: string;
  name: string;
  kind: DemoSourceKind;
  owner: string;
  refresh_frequency: 'realtime' | 'hourly' | 'daily' | 'weekly';
  record_count_estimate: number;
  status: 'live' | 'lagging' | 'failed';
}

export interface DemoPipeline {
  pipeline_id: string;
  tenant_id: string;
  name: string;
  kind: DemoPipelineKind;
  source_ids: string[];
  target_layer: 'raw' | 'staging' | 'mart' | 'feature_store';
  last_run_at: string;
  status: 'idle' | 'running' | 'success' | 'failure';
  records_processed_24h: number;
}

export interface DemoQualityScore {
  score_id: string;
  tenant_id: string;
  source_id: string;
  dimension: QualityDimension;
  score: number;
  grade: QualityGrade;
  sampled_at: string;
}

export interface DemoLineageEdge {
  edge_id: string;
  tenant_id: string;
  from_node: string;
  to_node: string;
  from_kind: string;
  to_kind: string;
  transformation: string;
}

export interface DemoReadinessScore {
  readiness_id: string;
  tenant_id: string;
  dataset_name: string;
  ai_workload: AiWorkload;
  readiness_pct: number;
  grade: 'production_ready' | 'training_only' | 'needs_work';
  missing_signals: string[];
}

export interface DataFabricDemoIntegrationSummary {
  total_sources: number;
  total_pipelines: number;
  total_quality_scores: number;
  total_lineage_edges: number;
  by_source_kind: Record<DemoSourceKind, number>;
  by_pipeline_kind: Record<DemoPipelineKind, number>;
  avg_quality_score: number;
  readiness_health_pct: number;
  top_quality_gaps: {
    source_id: string;
    source_name: string;
    dimension: QualityDimension;
    score: number;
  }[];
  ai_readiness_summary: { workload: AiWorkload; readiness_pct: number }[];
}

// ---------------------------------------------------------------------------
// Deterministic synthesis: FNV-1a + Mulberry32
// ---------------------------------------------------------------------------

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(asOf: Date): string {
  const y = asOf.getUTCFullYear();
  const m = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const d = String(asOf.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function makeRng(tenant_id: string, asOf: Date, axis: string): () => number {
  return mulberry32(fnv1a(`${tenant_id}|${dayKey(asOf)}|${axis}`));
}

function jitter(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function gradeFor(score: number): QualityGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  return 'D';
}

function readinessGrade(pct: number): DemoReadinessScore['grade'] {
  if (pct >= 85) return 'production_ready';
  if (pct >= 70) return 'training_only';
  return 'needs_work';
}

// ---------------------------------------------------------------------------
// Source catalog: 12 sources (2 per kind)
// ---------------------------------------------------------------------------

interface SourceTemplate {
  slug: string;
  name: string;
  kind: DemoSourceKind;
  owner_hint: string;
  refresh: DemoSourceSystem['refresh_frequency'];
  base_records: number;
}

const SOURCE_TEMPLATES: SourceTemplate[] = [
  { slug: 'bcore_hdfc', name: `${BANKS[0]} Core Banking Ledger`, kind: 'banking_core', owner_hint: 'Banking Tech', refresh: 'hourly', base_records: 850000 },
  { slug: 'bcore_icici', name: `${BANKS[1]} Core Banking Ledger`, kind: 'banking_core', owner_hint: 'Banking Tech', refresh: 'hourly', base_records: 720000 },
  { slug: 'bcoll_sbi', name: `${BANKS[2]} Collections Workbench`, kind: 'banking_collections', owner_hint: 'Recovery Ops', refresh: 'daily', base_records: 65000 },
  { slug: 'bcoll_axis', name: `${BANKS[3]} Collections Workbench`, kind: 'banking_collections', owner_hint: 'Recovery Ops', refresh: 'daily', base_records: 48000 },
  { slug: 'icore_lombard', name: `${INSURERS[0]} Policy Admin`, kind: 'insurance_core', owner_hint: 'Insurance IT', refresh: 'daily', base_records: 320000 },
  { slug: 'icore_ergo', name: `${INSURERS[1]} Policy Admin`, kind: 'insurance_core', owner_hint: 'Insurance IT', refresh: 'daily', base_records: 280000 },
  { slug: 'iclm_lombard', name: `${INSURERS[0]} Claims Hub`, kind: 'insurance_claims', owner_hint: 'Claims Ops', refresh: 'hourly', base_records: 95000 },
  { slug: 'iclm_sbi_gen', name: `${INSURERS[2]} Claims Hub`, kind: 'insurance_claims', owner_hint: 'Claims Ops', refresh: 'hourly', base_records: 72000 },
  { slug: 'iagt_lombard', name: `${INSURERS[0]} Agent Productivity`, kind: 'insurance_agents', owner_hint: 'Agency Channel', refresh: 'daily', base_records: 18000 },
  { slug: 'iagt_ergo', name: `${INSURERS[1]} Agent Productivity`, kind: 'insurance_agents', owner_hint: 'Agency Channel', refresh: 'daily', base_records: 22000 },
  { slug: 'xd_customer_master', name: 'Customer Master (Cross-Domain)', kind: 'cross_domain', owner_hint: 'Data Platform', refresh: 'realtime', base_records: 1100000 },
  { slug: 'xd_address_master', name: 'Address Master (PIN/Geo)', kind: 'cross_domain', owner_hint: 'Data Platform', refresh: 'weekly', base_records: 980000 },
];

// ---------------------------------------------------------------------------
// Pipeline catalog: 15 pipelines (3 per kind)
// ---------------------------------------------------------------------------

interface PipelineTemplate {
  slug: string;
  name: string;
  kind: DemoPipelineKind;
  source_slugs: string[];
  target_layer: DemoPipeline['target_layer'];
}

const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  { slug: 'etl_banking_daily', name: 'Banking Core Daily Load', kind: 'etl_daily', source_slugs: ['bcore_hdfc', 'bcore_icici'], target_layer: 'raw' },
  { slug: 'etl_collections_daily', name: 'Collections Daily Load', kind: 'etl_daily', source_slugs: ['bcoll_sbi', 'bcoll_axis'], target_layer: 'raw' },
  { slug: 'etl_insurance_daily', name: 'Insurance Policy Daily Load', kind: 'etl_daily', source_slugs: ['icore_lombard', 'icore_ergo'], target_layer: 'raw' },
  { slug: 'etl_claims_stream', name: 'Claims Event Stream', kind: 'etl_streaming', source_slugs: ['iclm_lombard', 'iclm_sbi_gen'], target_layer: 'staging' },
  { slug: 'etl_customer_cdc', name: 'Customer Master CDC', kind: 'etl_streaming', source_slugs: ['xd_customer_master'], target_layer: 'staging' },
  { slug: 'etl_address_stream', name: 'Address Master Sync', kind: 'etl_streaming', source_slugs: ['xd_address_master'], target_layer: 'staging' },
  { slug: 'feat_risk_features', name: 'Credit Risk Feature Build', kind: 'feature_build', source_slugs: ['bcore_hdfc', 'bcore_icici', 'bcoll_sbi'], target_layer: 'feature_store' },
  { slug: 'feat_fraud_features', name: 'Fraud Detection Features', kind: 'feature_build', source_slugs: ['iclm_lombard', 'xd_customer_master'], target_layer: 'feature_store' },
  { slug: 'feat_agent_features', name: 'Agent Performance Features', kind: 'feature_build', source_slugs: ['iagt_lombard', 'iagt_ergo'], target_layer: 'feature_store' },
  { slug: 'qs_banking_quality', name: 'Banking Data Quality Scan', kind: 'quality_scan', source_slugs: ['bcore_hdfc', 'bcore_icici', 'bcoll_sbi', 'bcoll_axis'], target_layer: 'mart' },
  { slug: 'qs_insurance_quality', name: 'Insurance Data Quality Scan', kind: 'quality_scan', source_slugs: ['icore_lombard', 'icore_ergo', 'iclm_lombard'], target_layer: 'mart' },
  { slug: 'qs_cross_quality', name: 'Cross-Domain Quality Scan', kind: 'quality_scan', source_slugs: ['xd_customer_master', 'xd_address_master'], target_layer: 'mart' },
  { slug: 'recon_customer_match', name: 'Customer 360 Reconciliation', kind: 'reconciliation', source_slugs: ['bcore_hdfc', 'icore_lombard', 'xd_customer_master'], target_layer: 'mart' },
  { slug: 'recon_address_match', name: 'Address Normalisation Recon', kind: 'reconciliation', source_slugs: ['xd_address_master', 'bcore_icici'], target_layer: 'mart' },
  { slug: 'recon_agent_match', name: 'Agent-Branch Reconciliation', kind: 'reconciliation', source_slugs: ['iagt_lombard', 'iagt_ergo', 'xd_customer_master'], target_layer: 'mart' },
];

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/** List the 12 demo source systems (2 per source kind), deterministic per tenant/day. */
export function listDemoSources(
  tenant_id: string,
  asOf: Date = currentTime(),
): DemoSourceSystem[] {
  const rng = makeRng(tenant_id, asOf, 'sources');
  return SOURCE_TEMPLATES.map((tpl) => {
    const status_roll = rng();
    const status: DemoSourceSystem['status'] =
      status_roll < 0.82 ? 'live' : status_roll < 0.96 ? 'lagging' : 'failed';
    const variance = 0.85 + rng() * 0.3;
    return {
      source_id: `src_${tpl.slug}`,
      tenant_id,
      name: tpl.name,
      kind: tpl.kind,
      owner: tpl.owner_hint,
      refresh_frequency: tpl.refresh,
      record_count_estimate: Math.round(tpl.base_records * variance),
      status,
    };
  });
}

/** List the 15 demo pipelines (3 per kind), deterministic per tenant/day. */
export function listDemoPipelines(
  tenant_id: string,
  asOf: Date = currentTime(),
): DemoPipeline[] {
  const rng = makeRng(tenant_id, asOf, 'pipelines');
  const dayMs = asOf.getTime();
  return PIPELINE_TEMPLATES.map((tpl) => {
    const status_roll = rng();
    const status: DemoPipeline['status'] =
      status_roll < 0.7
        ? 'success'
        : status_roll < 0.85
          ? 'running'
          : status_roll < 0.95
            ? 'idle'
            : 'failure';
    const minutesAgo = Math.floor(jitter(rng, 5, 720));
    const lastRun = new Date(dayMs - minutesAgo * 60000);
    const recordsBase = tpl.source_slugs.length * 120000;
    return {
      pipeline_id: `pipe_${tpl.slug}`,
      tenant_id,
      name: tpl.name,
      kind: tpl.kind,
      source_ids: tpl.source_slugs.map((s) => `src_${s}`),
      target_layer: tpl.target_layer,
      last_run_at: lastRun.toISOString(),
      status,
      records_processed_24h: Math.round(recordsBase * jitter(rng, 0.6, 1.4)),
    };
  });
}

/** List 72 quality scores: 12 sources × 6 dimensions, scores 75..95 with jitter. */
export function listDemoQualityScores(
  tenant_id: string,
  asOf: Date = currentTime(),
): DemoQualityScore[] {
  const sampled_at = asOf.toISOString();
  const out: DemoQualityScore[] = [];
  for (const tpl of SOURCE_TEMPLATES) {
    for (const dim of QUALITY_DIMENSIONS) {
      const rng = makeRng(tenant_id, asOf, `quality|${tpl.slug}|${dim}`);
      const raw = jitter(rng, 75, 95);
      const score = Math.round(raw * 10) / 10;
      out.push({
        score_id: `qs_${tpl.slug}_${dim}`,
        tenant_id,
        source_id: `src_${tpl.slug}`,
        dimension: dim,
        score,
        grade: gradeFor(score),
        sampled_at,
      });
    }
  }
  return out;
}

/** List ~30 lineage edges connecting sources → pipelines → target layers. */
export function listDemoLineage(
  tenant_id: string,
  asOf: Date = currentTime(),
): DemoLineageEdge[] {
  const _rng = makeRng(tenant_id, asOf, 'lineage');
  void _rng;
  const edges: DemoLineageEdge[] = [];
  let seq = 0;
  for (const tpl of PIPELINE_TEMPLATES) {
    for (const src of tpl.source_slugs) {
      seq += 1;
      edges.push({
        edge_id: `edge_${seq}`,
        tenant_id,
        from_node: `src_${src}`,
        to_node: `pipe_${tpl.slug}`,
        from_kind: 'source_system',
        to_kind: 'pipeline',
        transformation: `${tpl.kind}_ingest`,
      });
    }
    seq += 1;
    edges.push({
      edge_id: `edge_${seq}`,
      tenant_id,
      from_node: `pipe_${tpl.slug}`,
      to_node: `layer_${tpl.target_layer}`,
      from_kind: 'pipeline',
      to_kind: 'data_layer',
      transformation: `materialize_to_${tpl.target_layer}`,
    });
  }
  return edges;
}

/** List 5 AI-workload readiness scores (one per workload). */
export function listDemoReadinessScores(
  tenant_id: string,
  asOf: Date = currentTime(),
): DemoReadinessScore[] {
  const datasetNames: Record<AiWorkload, string> = {
    risk_scoring: 'Credit Risk 360 Dataset',
    fraud_detection: 'Transaction Fraud Signals Dataset',
    churn_prediction: 'Customer Churn Indicators Dataset',
    lapse_prediction: 'Policy Lapse Predictors Dataset',
    recovery_forecast: 'Collections Recovery Forecast Dataset',
  };
  const missingPool: Record<AiWorkload, string[]> = {
    risk_scoring: ['bureau_score_refresh', 'gst_filing_history', 'utility_bill_signals'],
    fraud_detection: ['device_fingerprint', 'merchant_category_risk', 'velocity_features'],
    churn_prediction: ['nps_feedback', 'service_ticket_history', 'engagement_score'],
    lapse_prediction: ['premium_payment_mode', 'agent_contact_history', 'renewal_reminder_logs'],
    recovery_forecast: ['employer_verification', 'field_visit_outcomes', 'promise_to_pay_logs'],
  };
  return AI_WORKLOADS.map((workload) => {
    const rng = makeRng(tenant_id, asOf, `readiness|${workload}`);
    const pct = Math.round(jitter(rng, 62, 94) * 10) / 10;
    const pool = missingPool[workload];
    const missingCount = pct >= 85 ? 0 : pct >= 70 ? 1 : 2;
    const missing_signals: string[] = [];
    for (let i = 0; i < missingCount; i++) {
      const candidate = pool[Math.floor(rng() * pool.length)];
      if (!missing_signals.includes(candidate)) missing_signals.push(candidate);
    }
    return {
      readiness_id: `rdy_${workload}`,
      tenant_id,
      dataset_name: datasetNames[workload],
      ai_workload: workload,
      readiness_pct: pct,
      grade: readinessGrade(pct),
      missing_signals,
    };
  });
}

/** Aggregate summary of the demo Data Fabric integration footprint. */
export function summarizeDataFabricDemoIntegration(
  tenant_id: string,
  asOf: Date = currentTime(),
): DataFabricDemoIntegrationSummary {
  const sources = listDemoSources(tenant_id, asOf);
  const pipelines = listDemoPipelines(tenant_id, asOf);
  const quality = listDemoQualityScores(tenant_id, asOf);
  const lineage = listDemoLineage(tenant_id, asOf);
  const readiness = listDemoReadinessScores(tenant_id, asOf);

  const by_source_kind = DEMO_SOURCE_KINDS.reduce(
    (acc, k) => {
      acc[k] = 0;
      return acc;
    },
    {} as Record<DemoSourceKind, number>,
  );
  for (const s of sources) by_source_kind[s.kind] += 1;

  const by_pipeline_kind = DEMO_PIPELINE_KINDS.reduce(
    (acc, k) => {
      acc[k] = 0;
      return acc;
    },
    {} as Record<DemoPipelineKind, number>,
  );
  for (const p of pipelines) by_pipeline_kind[p.kind] += 1;

  const avg_quality_score =
    quality.length === 0
      ? 0
      : Math.round(
          (quality.reduce((sum, q) => sum + q.score, 0) / quality.length) * 10,
        ) / 10;

  const readiness_health_pct =
    readiness.length === 0
      ? 0
      : Math.round(
          (readiness.reduce((sum, r) => sum + r.readiness_pct, 0) / readiness.length) * 10,
        ) / 10;

  const sourceNameById = new Map(sources.map((s) => [s.source_id, s.name]));
  const top_quality_gaps = [...quality]
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((q) => ({
      source_id: q.source_id,
      source_name: sourceNameById.get(q.source_id) ?? q.source_id,
      dimension: q.dimension,
      score: q.score,
    }));

  const ai_readiness_summary = readiness.map((r) => ({
    workload: r.ai_workload,
    readiness_pct: r.readiness_pct,
  }));

  return {
    total_sources: sources.length,
    total_pipelines: pipelines.length,
    total_quality_scores: quality.length,
    total_lineage_edges: lineage.length,
    by_source_kind,
    by_pipeline_kind,
    avg_quality_score,
    readiness_health_pct,
    top_quality_gaps,
    ai_readiness_summary,
  };
}
