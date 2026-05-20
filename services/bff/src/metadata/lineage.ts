// services/bff/src/metadata/lineage.ts
//
// PHASE D.4 — Metadata / Data Lineage interactive surface (PDF §X.2).
//
// Typed lineage catalog + traversal helpers. The catalog is a
// hand-curated mirror of `docs/data-lineage.md` — kept here so the
// SPA can render an INTERACTIVE lineage graph (vs the markdown doc
// which is regulator-audit-ready but not SPA-friendly).
//
// Distinct from prior surfaces:
//   - docs/data-lineage.md — human-readable provenance map (regulator
//     evidence).
//   - docs/database-schema.md — column-level reference for the 9
//     schemas / 26 tables.
//   - This module — programmatic catalog with upstream/downstream
//     traversal + impact-analysis helpers.
//
// Architecture choices (per execution rules):
//   - Additive only — no impact on any runtime module.
//   - Pure-data + pure-function — no store, no AppDeps slot. The
//     catalog is platform-static (same across tenants).
//   - Closed enum of layers + dataset kinds for stable SPA grouping.
//   - RBAC: audit:read admin-only.

/** Closed enum of layers — surfaces the position of a dataset in the
 *  bronze/silver/gold layering. Matches docs/data-lineage.md ordering. */
export const ALL_LINEAGE_LAYERS = [
  'external_source',
  'raw',
  'staging',
  'mart',
  'app',
  'kafka_topic',
  's3',
  'downstream',
] as const;
export type LineageLayer = (typeof ALL_LINEAGE_LAYERS)[number];

export function isLineageLayer(v: unknown): v is LineageLayer {
  return (
    typeof v === 'string' &&
    (ALL_LINEAGE_LAYERS as readonly string[]).includes(v)
  );
}

/** Closed enum of dataset kinds. Drives the SPA's node-icon mapping. */
export const ALL_DATASET_KINDS = [
  'external_api',
  'table',
  'view',
  'stream',
  'object_store',
  'wire_topic',
] as const;
export type DatasetKind = (typeof ALL_DATASET_KINDS)[number];

export interface LineageDataset {
  /** Stable id — used as the graph node key. */
  dataset_id: string;
  /** Human-readable name for the SPA tile header. */
  name: string;
  layer: LineageLayer;
  kind: DatasetKind;
  /** Service or external system that produces/owns this dataset. */
  owner: string;
  /** Short description for the SPA tooltip. */
  description: string;
  /** True iff this dataset contains PII subject to DPA 2019 Art. 22
   *  minimisation. Drives the SPA's PII-warning badge. */
  pii: boolean;
  /** Tenant-scoped? false for platform-static reference data. */
  tenant_scoped: boolean;
  /** Approximate row count from the 2026-05-03 fill-out — informational
   *  only; null for streams + topics. */
  row_count: number | null;
  /** Retention guideline for SPA rendering — free text, mirrors the
   *  doc's retention column. */
  retention: string;
}

export interface LineageEdge {
  /** Source dataset_id. */
  from: string;
  /** Destination dataset_id. */
  to: string;
  /** Free text — "dbt seed", "MWAA DAG", "BFF write-through", etc. */
  transform: string;
}

/** The lineage catalog. Tightly mirrors docs/data-lineage.md §1
 *  graph. */
export const LINEAGE_DATASETS: ReadonlyArray<LineageDataset> = [
  // ── External sources ────────────────────────────────────────────────
  {
    dataset_id: 'ext.cbs',
    name: 'Core Banking System',
    layer: 'external_source',
    kind: 'external_api',
    owner: 'agent-integration',
    description: 'Bank CBS loans + repayments + transactions (Phase 0 mock).',
    pii: true,
    tenant_scoped: true,
    row_count: null,
    retention: 'CBS-owned; bank retention policy applies',
  },
  {
    dataset_id: 'ext.bureau',
    name: 'Credit Bureau',
    layer: 'external_source',
    kind: 'external_api',
    owner: 'agent-integration',
    description: 'CIBIL / CRIF / EXPERIAN / EQUIFAX scores.',
    pii: true,
    tenant_scoped: true,
    row_count: null,
    retention: 'Bureau-owned; per-call cache 90 days',
  },
  {
    dataset_id: 'ext.ifrs9',
    name: 'IFRS9 Engine',
    layer: 'external_source',
    kind: 'external_api',
    owner: 'agent-integration',
    description: 'IFRS9 stage + ECL feed.',
    pii: false,
    tenant_scoped: true,
    row_count: null,
    retention: 'IFRS9-engine-owned',
  },
  {
    dataset_id: 'ext.aml',
    name: 'AML Hub',
    layer: 'external_source',
    kind: 'external_api',
    owner: 'agent-integration',
    description: 'Watchlist matches (sanctions / PEP / adverse media).',
    pii: true,
    tenant_scoped: true,
    row_count: null,
    retention: 'AML-vendor-owned',
  },
  {
    dataset_id: 'ext.insurance',
    name: 'Core Insurance',
    layer: 'external_source',
    kind: 'external_api',
    owner: 'agent-integration',
    description: 'Policy Master + Claims feeds.',
    pii: true,
    tenant_scoped: true,
    row_count: null,
    retention: 'Insurer-owned',
  },
  // ── raw.* ───────────────────────────────────────────────────────────
  {
    dataset_id: 'raw.seed_customer',
    name: 'raw.seed_customer',
    layer: 'raw',
    kind: 'table',
    owner: 'agent-data',
    description: 'Customer master snapshot from CBS (dbt seed).',
    pii: true,
    tenant_scoped: true,
    row_count: 10000,
    retention: 'indefinite (dbt seed; replaced on full-refresh)',
  },
  {
    dataset_id: 'raw.seed_loans',
    name: 'raw.seed_loans',
    layer: 'raw',
    kind: 'table',
    owner: 'agent-data',
    description: 'Loan master snapshot from CBS.',
    pii: false,
    tenant_scoped: true,
    row_count: 24000,
    retention: 'indefinite (dbt seed)',
  },
  {
    dataset_id: 'raw.seed_repayments',
    name: 'raw.seed_repayments',
    layer: 'raw',
    kind: 'table',
    owner: 'agent-data',
    description: 'Daily repayment events from CBS.',
    pii: false,
    tenant_scoped: true,
    row_count: 247550,
    retention: 'indefinite (dbt seed)',
  },
  {
    dataset_id: 'raw.seed_txns',
    name: 'raw.seed_txns',
    layer: 'raw',
    kind: 'table',
    owner: 'agent-data',
    description: 'Account transaction events from CBS.',
    pii: false,
    tenant_scoped: true,
    row_count: 289819,
    retention: 'indefinite (dbt seed)',
  },
  {
    dataset_id: 'raw.seed_bureau_score',
    name: 'raw.seed_bureau_score',
    layer: 'raw',
    kind: 'table',
    owner: 'agent-data',
    description: 'Bureau score snapshot.',
    pii: false,
    tenant_scoped: true,
    row_count: 10000,
    retention: 'indefinite (dbt seed)',
  },
  // ── staging.* ────────────────────────────────────────────────────────
  {
    dataset_id: 'staging.stg_customer',
    name: 'staging.stg_customer',
    layer: 'staging',
    kind: 'view',
    owner: 'agent-data',
    description: 'Cleaned customer view; carries tenant_id literal.',
    pii: true,
    tenant_scoped: true,
    row_count: 10000,
    retention: 'auto-drop on rebuild',
  },
  {
    dataset_id: 'staging.stg_loans',
    name: 'staging.stg_loans',
    layer: 'staging',
    kind: 'view',
    owner: 'agent-data',
    description: 'Cleaned loan view; carries tenant_id literal.',
    pii: false,
    tenant_scoped: true,
    row_count: 24000,
    retention: 'auto-drop on rebuild',
  },
  {
    dataset_id: 'staging.stg_repayments',
    name: 'staging.stg_repayments',
    layer: 'staging',
    kind: 'view',
    owner: 'agent-data',
    description: 'Repayment events deduped + cleaned.',
    pii: false,
    tenant_scoped: true,
    row_count: 247550,
    retention: 'auto-drop on rebuild',
  },
  {
    dataset_id: 'staging.stg_txns',
    name: 'staging.stg_txns',
    layer: 'staging',
    kind: 'view',
    owner: 'agent-data',
    description: 'Transaction events cleaned.',
    pii: false,
    tenant_scoped: true,
    row_count: 289819,
    retention: 'auto-drop on rebuild',
  },
  {
    dataset_id: 'staging.stg_bureau_score',
    name: 'staging.stg_bureau_score',
    layer: 'staging',
    kind: 'view',
    owner: 'agent-data',
    description: 'Bureau scores cleaned + banded.',
    pii: false,
    tenant_scoped: true,
    row_count: 10000,
    retention: 'auto-drop on rebuild',
  },
  // ── mart.* ───────────────────────────────────────────────────────────
  {
    dataset_id: 'mart.customer_360',
    name: 'mart.customer_360',
    layer: 'mart',
    kind: 'table',
    owner: 'agent-data',
    description: 'Customer 360-degree profile — used by every analytics surface.',
    pii: true,
    tenant_scoped: true,
    row_count: 10000,
    retention: '60-month snapshot',
  },
  {
    dataset_id: 'mart.loan_360',
    name: 'mart.loan_360',
    layer: 'mart',
    kind: 'table',
    owner: 'agent-data',
    description: 'Loan 360 profile with NPA flag.',
    pii: false,
    tenant_scoped: true,
    row_count: 24000,
    retention: '60-month snapshot',
  },
  {
    dataset_id: 'mart.txn_features',
    name: 'mart.txn_features',
    layer: 'mart',
    kind: 'table',
    owner: 'agent-data',
    description: 'Transaction feature aggregates per customer.',
    pii: false,
    tenant_scoped: true,
    row_count: 10000,
    retention: '60-month snapshot',
  },
  {
    dataset_id: 'mart.indicator_values',
    name: 'mart.indicator_values',
    layer: 'mart',
    kind: 'table',
    owner: 'agent-indicator',
    description: 'Materialised indicator values (8 of 30 indicators in dbt; rest computed at runtime).',
    pii: false,
    tenant_scoped: true,
    row_count: 80000,
    retention: '60-month snapshot',
  },
  // ── app_* (operational stores) ───────────────────────────────────────
  {
    dataset_id: 'app_alerts.alerts',
    name: 'app_alerts.alerts',
    layer: 'app',
    kind: 'table',
    owner: 'agent-alert',
    description: 'Alert ledger (criticality + assignee + status).',
    pii: false,
    tenant_scoped: true,
    row_count: 2527,
    retention: '90 days post-close',
  },
  {
    dataset_id: 'app_cases.cases',
    name: 'app_cases.cases',
    layer: 'app',
    kind: 'table',
    owner: 'agent-case',
    description: 'Case lifecycle (open → assigned → in_action → monitored → closed).',
    pii: false,
    tenant_scoped: true,
    row_count: 528,
    retention: '7 years',
  },
  {
    dataset_id: 'app_iam.users',
    name: 'app_iam.users',
    layer: 'app',
    kind: 'table',
    owner: 'auth-svc',
    description: 'User roster + roles + tenant binding.',
    pii: true,
    tenant_scoped: true,
    row_count: 505,
    retention: 'indefinite',
  },
  {
    dataset_id: 'audit.event_log',
    name: 'audit.event_log',
    layer: 'app',
    kind: 'table',
    owner: 'audit-svc',
    description: 'Hash-chained WORM audit trail.',
    pii: false,
    tenant_scoped: true,
    row_count: 4,
    retention: '≥7 years per RBI Cyber Resilience §4.1',
  },
  // ── Kafka topics ────────────────────────────────────────────────────
  {
    dataset_id: 'kafka.cbs_events',
    name: 'apex.cbs.events',
    layer: 'kafka_topic',
    kind: 'wire_topic',
    owner: 'agent-integration',
    description: 'Streaming CBS events (BACKWARD compat via Glue Schema Registry).',
    pii: false,
    tenant_scoped: true,
    row_count: null,
    retention: '7 days',
  },
  {
    dataset_id: 'kafka.regulatory_events',
    name: 'apex.regulatory.events',
    layer: 'kafka_topic',
    kind: 'wire_topic',
    owner: 'agent-alert',
    description: 'Outbound alert events for downstream consumers.',
    pii: false,
    tenant_scoped: true,
    row_count: null,
    retention: '7 days',
  },
  // ── S3 layer ────────────────────────────────────────────────────────
  {
    dataset_id: 's3.audit_lock',
    name: 'S3 audit (Object Lock COMPLIANCE)',
    layer: 's3',
    kind: 'object_store',
    owner: 'audit-svc',
    description: 'Long-term WORM storage for the audit chain.',
    pii: false,
    tenant_scoped: true,
    row_count: null,
    retention: '7 years (Object Lock COMPLIANCE mode)',
  },
  // ── Downstream consumers ─────────────────────────────────────────────
  {
    dataset_id: 'spa',
    name: 'SPA (web)',
    layer: 'downstream',
    kind: 'external_api',
    owner: 'agent-ui',
    description: 'React SPA consumes /v1/* envelope endpoints.',
    pii: false,
    tenant_scoped: true,
    row_count: null,
    retention: 'n/a (client-side cache only)',
  },
  {
    dataset_id: 'webhooks',
    name: 'External webhook subscribers',
    layer: 'downstream',
    kind: 'external_api',
    owner: 'agent-integration',
    description: 'Outbound HMAC-signed delivery to partner systems.',
    pii: false,
    tenant_scoped: true,
    row_count: null,
    retention: 'partner-owned',
  },
];

export const LINEAGE_EDGES: ReadonlyArray<LineageEdge> = [
  // External -> raw
  { from: 'ext.cbs', to: 'raw.seed_customer', transform: 'MWAA cbs_ingestion DAG (Phase 0 mock; dbt seed)' },
  { from: 'ext.cbs', to: 'raw.seed_loans', transform: 'MWAA cbs_ingestion DAG' },
  { from: 'ext.cbs', to: 'raw.seed_repayments', transform: 'MWAA cbs_ingestion DAG' },
  { from: 'ext.cbs', to: 'raw.seed_txns', transform: 'MWAA cbs_ingestion DAG' },
  { from: 'ext.bureau', to: 'raw.seed_bureau_score', transform: 'MWAA bureau_sync DAG' },
  // raw -> staging
  { from: 'raw.seed_customer', to: 'staging.stg_customer', transform: 'dbt staging model (literal tenant_id)' },
  { from: 'raw.seed_loans', to: 'staging.stg_loans', transform: 'dbt staging model' },
  { from: 'raw.seed_repayments', to: 'staging.stg_repayments', transform: 'dbt staging model' },
  { from: 'raw.seed_txns', to: 'staging.stg_txns', transform: 'dbt staging model' },
  { from: 'raw.seed_bureau_score', to: 'staging.stg_bureau_score', transform: 'dbt staging model' },
  // staging -> mart
  { from: 'staging.stg_customer', to: 'mart.customer_360', transform: 'dbt mart model' },
  { from: 'staging.stg_bureau_score', to: 'mart.customer_360', transform: 'dbt mart model (joined)' },
  { from: 'staging.stg_loans', to: 'mart.loan_360', transform: 'dbt mart model' },
  { from: 'staging.stg_repayments', to: 'mart.loan_360', transform: 'dbt mart model (joined for DPD)' },
  { from: 'staging.stg_txns', to: 'mart.txn_features', transform: 'dbt mart model (aggregates)' },
  { from: 'mart.customer_360', to: 'mart.indicator_values', transform: 'dbt indicator model' },
  { from: 'mart.loan_360', to: 'mart.indicator_values', transform: 'dbt indicator model' },
  { from: 'mart.txn_features', to: 'mart.indicator_values', transform: 'dbt indicator model' },
  // mart -> app_*
  { from: 'mart.indicator_values', to: 'app_alerts.alerts', transform: 'Rule evaluator + scoring engine' },
  { from: 'app_alerts.alerts', to: 'app_cases.cases', transform: 'Alert → Case creation (T3.5)' },
  // app_* -> audit + Kafka
  { from: 'app_alerts.alerts', to: 'audit.event_log', transform: 'Audit fan-out (M15.1)' },
  { from: 'app_cases.cases', to: 'audit.event_log', transform: 'Audit fan-out (M15.1)' },
  { from: 'app_iam.users', to: 'audit.event_log', transform: 'Audit fan-out (M15.1)' },
  { from: 'app_alerts.alerts', to: 'kafka.regulatory_events', transform: 'Outbound producer' },
  { from: 'ext.cbs', to: 'kafka.cbs_events', transform: 'Real-time stream (Year-2)' },
  // audit -> S3
  { from: 'audit.event_log', to: 's3.audit_lock', transform: 'Daily snapshot to Object Lock' },
  // Downstream consumers
  { from: 'app_alerts.alerts', to: 'spa', transform: 'BFF /v1/alerts envelope' },
  { from: 'app_cases.cases', to: 'spa', transform: 'BFF /v1/cms/cases envelope' },
  { from: 'mart.customer_360', to: 'spa', transform: 'BFF /v1/customers/:id/360 (M11.6)' },
  { from: 'app_alerts.alerts', to: 'webhooks', transform: 'Outbound HMAC delivery (T4.12)' },
];

export class LineageError extends Error {
  constructor(
    public readonly code: 'unknown_dataset' | 'invalid_input',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'LineageError';
  }
}

// ── Pure-function traversal helpers ───────────────────────────────────

/** Look up a dataset by id. Returns null on miss. */
export function getDataset(dataset_id: string): LineageDataset | null {
  return LINEAGE_DATASETS.find((d) => d.dataset_id === dataset_id) ?? null;
}

/** All datasets feeding INTO the given id (immediate parents). */
export function immediateUpstream(dataset_id: string): LineageEdge[] {
  return LINEAGE_EDGES.filter((e) => e.to === dataset_id);
}

/** All datasets FED FROM the given id (immediate children). */
export function immediateDownstream(dataset_id: string): LineageEdge[] {
  return LINEAGE_EDGES.filter((e) => e.from === dataset_id);
}

/** BFS traversal: collect every ancestor up to `depth` levels. depth ≤
 *  0 returns nothing; depth = Infinity means full ancestry. */
export function traverseUpstream(
  dataset_id: string,
  depth: number,
): { datasets: LineageDataset[]; edges: LineageEdge[] } {
  if (!getDataset(dataset_id)) {
    throw new LineageError('unknown_dataset', `unknown dataset_id: ${dataset_id}`);
  }
  if (!Number.isFinite(depth) && depth !== Infinity) {
    throw new LineageError('invalid_input', 'depth must be a number or Infinity');
  }
  if (typeof depth !== 'number' || depth < 0) {
    throw new LineageError('invalid_input', 'depth must be ≥ 0');
  }
  const seenDs = new Set<string>();
  const collectedEdges: LineageEdge[] = [];
  let frontier = new Set<string>([dataset_id]);
  for (let level = 0; level < depth; level++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const e of immediateUpstream(id)) {
        collectedEdges.push(e);
        if (!seenDs.has(e.from)) {
          seenDs.add(e.from);
          next.add(e.from);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  const datasets: LineageDataset[] = [];
  for (const id of seenDs) {
    const d = getDataset(id);
    if (d) datasets.push(d);
  }
  return { datasets, edges: collectedEdges };
}

/** BFS traversal: every descendant up to `depth` levels.
 *  Same depth rules as traverseUpstream. */
export function traverseDownstream(
  dataset_id: string,
  depth: number,
): { datasets: LineageDataset[]; edges: LineageEdge[] } {
  if (!getDataset(dataset_id)) {
    throw new LineageError('unknown_dataset', `unknown dataset_id: ${dataset_id}`);
  }
  if (typeof depth !== 'number' || depth < 0) {
    throw new LineageError('invalid_input', 'depth must be ≥ 0');
  }
  const seenDs = new Set<string>();
  const collectedEdges: LineageEdge[] = [];
  let frontier = new Set<string>([dataset_id]);
  for (let level = 0; level < depth; level++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const e of immediateDownstream(id)) {
        collectedEdges.push(e);
        if (!seenDs.has(e.to)) {
          seenDs.add(e.to);
          next.add(e.to);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  const datasets: LineageDataset[] = [];
  for (const id of seenDs) {
    const d = getDataset(id);
    if (d) datasets.push(d);
  }
  return { datasets, edges: collectedEdges };
}

/** Impact analysis: "what's affected if X changes?" Combines downstream
 *  closure + a PII propagation summary. Useful for the SPA's "If you
 *  change this column, here's everyone who reads from it" panel. */
export function impactAnalysis(dataset_id: string): {
  origin: LineageDataset;
  affected_datasets: LineageDataset[];
  affected_edges: LineageEdge[];
  affected_pii_count: number;
  /** Depth of the deepest affected dataset from the origin (informational). */
  max_depth: number;
} {
  const origin = getDataset(dataset_id);
  if (!origin) {
    throw new LineageError('unknown_dataset', `unknown dataset_id: ${dataset_id}`);
  }
  // BFS with explicit depth tracking.
  const seen = new Map<string, number>(); // id → depth
  const edges: LineageEdge[] = [];
  let frontier: Array<{ id: string; depth: number }> = [{ id: dataset_id, depth: 0 }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { id, depth } of frontier) {
      for (const e of immediateDownstream(id)) {
        edges.push(e);
        if (!seen.has(e.to)) {
          seen.set(e.to, depth + 1);
          next.push({ id: e.to, depth: depth + 1 });
        }
      }
    }
    frontier = next;
  }
  const datasets: LineageDataset[] = [];
  let max_depth = 0;
  for (const [id, d] of seen) {
    const ds = getDataset(id);
    if (ds) datasets.push(ds);
    if (d > max_depth) max_depth = d;
  }
  const affected_pii_count = datasets.filter((d) => d.pii).length;
  return {
    origin,
    affected_datasets: datasets,
    affected_edges: edges,
    affected_pii_count,
    max_depth,
  };
}

/** SPA-friendly catalog summary — counts per layer. */
export function summariseCatalog(): {
  total_datasets: number;
  total_edges: number;
  by_layer: Record<LineageLayer, number>;
  total_pii: number;
} {
  const by_layer = Object.fromEntries(
    ALL_LINEAGE_LAYERS.map((l) => [l, 0]),
  ) as Record<LineageLayer, number>;
  for (const d of LINEAGE_DATASETS) {
    by_layer[d.layer]++;
  }
  const total_pii = LINEAGE_DATASETS.filter((d) => d.pii).length;
  return {
    total_datasets: LINEAGE_DATASETS.length,
    total_edges: LINEAGE_EDGES.length,
    by_layer,
    total_pii,
  };
}
