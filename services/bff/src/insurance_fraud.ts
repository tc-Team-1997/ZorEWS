// services/bff/src/insurance_fraud.ts
//
// Insurance EWS — Module 3: Fraud Detection (network / ring).
//
// Detects organised fraud — staged accidents, provider collusion, identity
// fraud, claim padding, and fraud rings — via a relationship graph over
// entities (customers, providers, garages, hospitals, agents, bank
// accounts) and the links between them. Pure-function builders over
// deterministic synthesis (FNV-1a seed + Mulberry32), same template as
// Modules 1 & 2. A given (tenant, day) yields a stable graph today; swap
// builder bodies to app_insurance.{fraud_entities,provider_links,
// fraud_networks,fraud_cases} when real data lands. Shapes stay frozen.
//
// Surfaces:
//   buildFraudDashboard(tenant, now)        → FraudDashboard (4 widgets)
//   listHighRiskEntities(tenant, now, opts) → HighRiskEntityList
//   analyzeFraud(input, now)                → FraudAnalysisResult (ad-hoc)

// ─── deterministic synthesis helpers ───────────────────────────────────

function seedFrom(...parts: string[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── domain enums ───────────────────────────────────────────────────────

export const FRAUD_ENTITY_TYPES = [
  'customer',
  'provider',
  'agent',
  'garage',
  'hospital',
  'bank_account',
] as const;
export type FraudEntityType = (typeof FRAUD_ENTITY_TYPES)[number];

export const FRAUD_LINK_TYPES = [
  'shared_account',
  'co_claim',
  'referral',
  'address',
  'phone',
] as const;
export type FraudLinkType = (typeof FRAUD_LINK_TYPES)[number];

export const FRAUD_TYPES = [
  'staged_accident',
  'provider_collusion',
  'identity',
  'claim_padding',
  'ring',
] as const;
export type FraudType = (typeof FRAUD_TYPES)[number];

export const FRAUD_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type FraudSeverity = (typeof FRAUD_SEVERITIES)[number];

export function severityFor(score: number): FraudSeverity {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}

export class FraudError extends Error {
  constructor(
    public code: 'invalid_input' | 'invalid_entity_type' | 'invalid_signal',
    message: string,
  ) {
    super(message);
    this.name = 'FraudError';
  }
}

// ─── shapes ─────────────────────────────────────────────────────────────

export interface FraudGraphNode {
  entity_id: string;
  entity_type: FraudEntityType;
  display_name: string;
  risk_score: number; // 0..1
  flagged: boolean;
}
export interface FraudGraphEdge {
  source_entity_id: string;
  target_entity_id: string;
  link_type: FraudLinkType;
  weight: number; // edge strength 0..1
  shared_claim_count: number;
}
export interface FraudNetworkGraph {
  network_id: string;
  label: string;
  nodes: FraudGraphNode[];
  edges: FraudGraphEdge[];
}

export interface FraudRing {
  network_id: string;
  label: string;
  entity_count: number;
  edge_count: number;
  ring_risk_score: number;
  estimated_exposure_kes: number;
  detection_method: string;
  status: 'detected' | 'investigating' | 'confirmed' | 'dismissed';
  detected_at: string;
}

export interface HighRiskProvider {
  entity_id: string;
  display_name: string;
  entity_type: FraudEntityType; // provider | hospital | garage
  risk_score: number;
  linked_claims: number;
  linked_entities: number;
  estimated_exposure_kes: number;
  rank: number;
}

export interface IdentityRiskRow {
  customer_id: string;
  customer_name: string;
  identity_risk_score: number; // 0..1
  signals: string[]; // shared_pan, duplicate_kyc, synthetic_identity, address_cluster
  shared_accounts: number;
  severity: FraudSeverity;
}

export interface FraudDashboard {
  tenant_id: string;
  generated_at: string;
  totals: {
    entities_tracked: number;
    flagged_entities: number;
    fraud_rings: number;
    open_fraud_cases: number;
    estimated_exposure_kes: number;
    high_risk_providers: number;
  };
  fraud_network_graph: FraudNetworkGraph; // the highest-risk ring, expanded
  high_risk_providers: HighRiskProvider[]; // top 10
  fraud_ring_detection: FraudRing[]; // all detected rings, worst-first
  identity_risk_analysis: IdentityRiskRow[]; // top 10 identity-risk customers
  model_version: string;
}

export interface HighRiskEntityList {
  tenant_id: string;
  generated_at: string;
  entity_type_filter: FraudEntityType | 'all';
  total: number;
  entities: HighRiskProvider[];
}

export interface AnalyzeFraudInput {
  entity_id?: string;
  customer_id: string;
  entity_type?: string;
  // Network signals
  shared_bank_accounts?: number;
  co_claim_count?: number;
  address_matches?: number;
  phone_matches?: number;
  provider_referral_count?: number;
  identity_mismatch_score?: number; // 0..1
  prior_confirmed_fraud?: boolean;
}

export interface FraudAnalysisResult {
  entity_id: string;
  customer_id: string;
  fraud_probability: number;
  severity: FraudSeverity;
  likely_fraud_type: FraudType;
  ring_membership_likelihood: number; // 0..1
  signals: { signal: string; contribution: number }[];
  recommended_action: string;
  model_version: string;
  scored_at: string;
}

const MODEL_VERSION = 'fraud-stub-v1';

function tenantScale(tenant_id: string): number {
  return tenant_id === 'BANK_DEMO' ? 1.0 : 0.6;
}

const PROVIDER_NAMES = [
  'Apex Hospital', 'Meridian Clinic', 'Sunrise Diagnostics', 'CareFirst Medical',
  'Highway Garage', 'Prime Auto Works', 'Metro Trauma Centre', 'Unity Health',
  'Crescent Care', 'Pioneer Motors', 'Galaxy Hospital', 'Summit Medicare',
];
const FIRST_NAMES = ['Aarav', 'Diya', 'Kabir', 'Ananya', 'Vivaan', 'Ishika', 'Reyansh', 'Myra', 'Arjun', 'Saanvi'];
const LAST_NAMES = ['Sharma', 'Patel', 'Reddy', 'Iyer', 'Khan', 'Nair', 'Mehta', 'Das', 'Gupta', 'Bose'];
const ID_SIGNALS = ['shared_pan', 'duplicate_kyc', 'synthetic_identity', 'address_cluster', 'reused_phone'];

function synthName(r: () => number): string {
  return `${FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]}`;
}

function fraudAction(severity: FraudSeverity, type: FraudType): string {
  if (severity === 'critical') {
    return type === 'ring'
      ? 'Open organised-fraud case — freeze all linked payouts + notify SIU lead'
      : 'Freeze payout + escalate to SIU for full investigation';
  }
  if (severity === 'high') return 'Queue to SIU — pull linked claims + provider history';
  if (severity === 'medium') return 'Flag for analyst review before settlement';
  return 'Monitor — within normal network parameters';
}

/** Synthesise the entity graph for a tenant on a given day. */
function synthEntities(tenant_id: string, now: Date): FraudGraphNode[] {
  const day = utcDay(now);
  const scale = tenantScale(tenant_id);
  const count = Math.max(30, Math.round(90 * scale));
  const out: FraudGraphNode[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng(seedFrom(tenant_id, day, 'entity', String(i)));
    const entity_type = FRAUD_ENTITY_TYPES[Math.floor(r() * FRAUD_ENTITY_TYPES.length)];
    const risk = round4(Math.min(1, r() ** 1.4));
    out.push({
      entity_id: `ENT-${tenant_id}-${String(500000 + i)}`,
      entity_type,
      display_name:
        entity_type === 'provider' || entity_type === 'hospital' || entity_type === 'garage'
          ? PROVIDER_NAMES[i % PROVIDER_NAMES.length]
          : entity_type === 'customer'
            ? synthName(r)
            : `${entity_type}-${500000 + i}`,
      risk_score: risk,
      flagged: risk >= 0.5,
    });
  }
  return out;
}

/** Synthesise fraud rings (communities) over the high-risk entities. */
function synthRings(tenant_id: string, now: Date, entities: FraudGraphNode[]): FraudRing[] {
  const day = utcDay(now);
  const flagged = entities.filter((e) => e.flagged);
  const ringCount = Math.max(2, Math.round(flagged.length / 8));
  const rings: FraudRing[] = [];
  for (let i = 0; i < ringCount; i++) {
    const r = rng(seedFrom(tenant_id, day, 'ring', String(i)));
    const entity_count = 4 + Math.floor(r() * 9);
    const edge_count = entity_count + Math.floor(r() * entity_count);
    const ring_risk = round4(0.55 + r() * 0.45);
    const states: FraudRing['status'][] = ['detected', 'investigating', 'confirmed', 'dismissed'];
    rings.push({
      network_id: `NET-${tenant_id}-${String(600000 + i)}`,
      label: `Ring #${i + 1} — ${['staged-accident', 'provider-collusion', 'identity', 'claim-padding'][i % 4]} cluster`,
      entity_count,
      edge_count,
      ring_risk_score: ring_risk,
      estimated_exposure_kes: round2((500000 + r() * 4500000) * (1 + ring_risk)),
      detection_method: r() > 0.5 ? 'community_detection' : 'shared_attribute_clustering',
      status: states[Math.floor(r() * (r() > 0.7 ? 4 : 2))], // bias toward detected/investigating
      detected_at: new Date(now.getTime() - Math.floor(r() * 21) * 86400000).toISOString(),
    });
  }
  return rings.sort((a, b) => b.ring_risk_score - a.ring_risk_score || a.network_id.localeCompare(b.network_id));
}

/** Expand the highest-risk ring into a node/edge graph for the SPA. */
function expandTopRing(tenant_id: string, now: Date, ring: FraudRing, entities: FraudGraphNode[]): FraudNetworkGraph {
  const r = rng(seedFrom(tenant_id, utcDay(now), 'graph', ring.network_id));
  const flagged = entities.filter((e) => e.flagged);
  const pool = flagged.length >= ring.entity_count ? flagged : entities;
  const nodes: FraudGraphNode[] = [];
  const used = new Set<number>();
  for (let i = 0; i < ring.entity_count && pool.length > 0; i++) {
    let idx = Math.floor(r() * pool.length);
    let guard = 0;
    while (used.has(idx) && guard++ < pool.length) idx = (idx + 1) % pool.length;
    used.add(idx);
    nodes.push(pool[idx]);
  }
  const edges: FraudGraphEdge[] = [];
  for (let e = 0; e < ring.edge_count && nodes.length >= 2; e++) {
    const a = nodes[Math.floor(r() * nodes.length)];
    let b = nodes[Math.floor(r() * nodes.length)];
    let guard = 0;
    while (b.entity_id === a.entity_id && guard++ < nodes.length) {
      b = nodes[Math.floor(r() * nodes.length)];
    }
    if (b.entity_id === a.entity_id) continue;
    edges.push({
      source_entity_id: a.entity_id,
      target_entity_id: b.entity_id,
      link_type: FRAUD_LINK_TYPES[Math.floor(r() * FRAUD_LINK_TYPES.length)],
      weight: round4(0.3 + r() * 0.7),
      shared_claim_count: 1 + Math.floor(r() * 6),
    });
  }
  return { network_id: ring.network_id, label: ring.label, nodes, edges };
}

// ─── builders ─────────────────────────────────────────────────────────────

export function buildFraudDashboard(tenant_id: string, now: Date): FraudDashboard {
  if (!tenant_id) throw new FraudError('invalid_input', 'tenant_id required');
  const entities = synthEntities(tenant_id, now);
  const flagged = entities.filter((e) => e.flagged);
  const rings = synthRings(tenant_id, now, entities);
  const openRings = rings.filter((r) => r.status === 'detected' || r.status === 'investigating');

  // High-risk providers — provider/hospital/garage nodes, top 10 by risk.
  const providerPool = entities.filter(
    (e) => e.entity_type === 'provider' || e.entity_type === 'hospital' || e.entity_type === 'garage',
  );
  const high_risk_providers: HighRiskProvider[] = [...providerPool]
    .sort((a, b) => b.risk_score - a.risk_score || a.entity_id.localeCompare(b.entity_id))
    .slice(0, 10)
    .map((e, i) => {
      const r = rng(seedFrom(tenant_id, utcDay(now), 'prov', e.entity_id));
      return {
        entity_id: e.entity_id,
        display_name: e.display_name,
        entity_type: e.entity_type,
        risk_score: e.risk_score,
        linked_claims: 3 + Math.floor(r() * 40),
        linked_entities: 2 + Math.floor(r() * 15),
        estimated_exposure_kes: round2((200000 + r() * 3000000) * (1 + e.risk_score)),
        rank: i + 1,
      };
    });

  // Identity risk analysis — top 10 customers by synthetic identity-risk.
  const customerPool = entities.filter((e) => e.entity_type === 'customer');
  const identity_risk_analysis: IdentityRiskRow[] = [...customerPool]
    .map((e) => {
      const r = rng(seedFrom(tenant_id, utcDay(now), 'idr', e.entity_id));
      const idScore = round4(Math.min(1, e.risk_score * 0.7 + r() * 0.3));
      const nSig = idScore >= 0.75 ? 3 : idScore >= 0.5 ? 2 : idScore >= 0.25 ? 1 : 0;
      const sigs = [...ID_SIGNALS];
      const chosen: string[] = [];
      for (let k = 0; k < nSig; k++) chosen.push(sigs.splice(Math.floor(r() * sigs.length), 1)[0]);
      return {
        customer_id: e.entity_id,
        customer_name: e.display_name,
        identity_risk_score: idScore,
        signals: chosen,
        shared_accounts: Math.floor(r() * 5),
        severity: severityFor(idScore),
      };
    })
    .sort((a, b) => b.identity_risk_score - a.identity_risk_score || a.customer_id.localeCompare(b.customer_id))
    .slice(0, 10);

  const fraud_network_graph = rings.length
    ? expandTopRing(tenant_id, now, rings[0], entities)
    : { network_id: 'NONE', label: 'No ring detected', nodes: [], edges: [] };

  return {
    tenant_id,
    generated_at: now.toISOString(),
    totals: {
      entities_tracked: entities.length,
      flagged_entities: flagged.length,
      fraud_rings: rings.length,
      open_fraud_cases: openRings.length,
      estimated_exposure_kes: round2(rings.reduce((a, r) => a + r.estimated_exposure_kes, 0)),
      high_risk_providers: high_risk_providers.length,
    },
    fraud_network_graph,
    high_risk_providers,
    fraud_ring_detection: rings,
    identity_risk_analysis,
    model_version: MODEL_VERSION,
  };
}

export interface HighRiskOpts {
  entity_type?: string;
  limit?: number;
}

export function listHighRiskEntities(
  tenant_id: string,
  now: Date,
  opts: HighRiskOpts = {},
): HighRiskEntityList {
  if (!tenant_id) throw new FraudError('invalid_input', 'tenant_id required');

  let entity_type: FraudEntityType | 'all' = 'all';
  if (opts.entity_type !== undefined && opts.entity_type !== 'all') {
    if (!FRAUD_ENTITY_TYPES.includes(opts.entity_type as FraudEntityType)) {
      throw new FraudError('invalid_entity_type', `entity_type must be one of ${FRAUD_ENTITY_TYPES.join(', ')} or 'all'`);
    }
    entity_type = opts.entity_type as FraudEntityType;
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  const entities = synthEntities(tenant_id, now).filter((e) => e.flagged);
  let pool = entity_type === 'all' ? entities : entities.filter((e) => e.entity_type === entity_type);
  pool.sort((a, b) => b.risk_score - a.risk_score || a.entity_id.localeCompare(b.entity_id));

  const rows: HighRiskProvider[] = pool.slice(0, limit).map((e, i) => {
    const r = rng(seedFrom(tenant_id, utcDay(now), 'hre', e.entity_id));
    return {
      entity_id: e.entity_id,
      display_name: e.display_name,
      entity_type: e.entity_type,
      risk_score: e.risk_score,
      linked_claims: 1 + Math.floor(r() * 40),
      linked_entities: 1 + Math.floor(r() * 15),
      estimated_exposure_kes: round2((100000 + r() * 3000000) * (1 + e.risk_score)),
      rank: i + 1,
    };
  });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    entity_type_filter: entity_type,
    total: pool.length,
    entities: rows,
  };
}

/**
 * Ad-hoc fraud scoring from explicit network signals. Deterministic weighted
 * blend clamped to [0,1], with a fraud-type classification + ring-membership
 * likelihood. Same inputs → same score.
 */
export function analyzeFraud(input: AnalyzeFraudInput, now: Date): FraudAnalysisResult {
  if (!input || typeof input !== 'object') throw new FraudError('invalid_input', 'request body required');
  if (!input.customer_id || typeof input.customer_id !== 'string') {
    throw new FraudError('invalid_input', 'customer_id required');
  }

  const sharedAcc = numOr(input.shared_bank_accounts, 0);
  const coClaim = numOr(input.co_claim_count, 0);
  const addr = numOr(input.address_matches, 0);
  const phone = numOr(input.phone_matches, 0);
  const referral = numOr(input.provider_referral_count, 0);
  const idMismatch = clamp01OrThrow(input.identity_mismatch_score, 0);
  const priorFraud = input.prior_confirmed_fraud === true;
  if (sharedAcc < 0 || coClaim < 0 || addr < 0 || phone < 0 || referral < 0) {
    throw new FraudError('invalid_signal', 'signals must be non-negative');
  }

  const dShared = Math.min(0.25, sharedAcc * 0.08);
  const dCoClaim = Math.min(0.25, coClaim * 0.05);
  const dAddr = Math.min(0.15, addr * 0.05);
  const dPhone = Math.min(0.12, phone * 0.04);
  const dReferral = Math.min(0.2, referral * 0.03);
  const dIdentity = idMismatch * 0.3;
  const dPrior = priorFraud ? 0.25 : 0;

  const raw = 0.05 + dShared + dCoClaim + dAddr + dPhone + dReferral + dIdentity + dPrior;
  const fraud = round4(Math.max(0, Math.min(1, raw)));
  const severity = severityFor(fraud);

  // Ring membership likelihood — driven by the relationship signals.
  const ring = round4(Math.max(0, Math.min(1, (dShared + dCoClaim + dAddr + dPhone + dReferral) / 0.97)));

  // Fraud-type classification — pick the dominant signal cluster.
  let likely_fraud_type: FraudType = 'claim_padding';
  if (dIdentity >= 0.18) likely_fraud_type = 'identity';
  else if (dReferral >= 0.12) likely_fraud_type = 'provider_collusion';
  else if (dCoClaim + dAddr + dPhone >= 0.25) likely_fraud_type = 'staged_accident';
  if (ring >= 0.6) likely_fraud_type = 'ring';

  const signals = [
    { signal: 'shared_bank_accounts', contribution: round4(dShared) },
    { signal: 'co_claim_count', contribution: round4(dCoClaim) },
    { signal: 'address_matches', contribution: round4(dAddr) },
    { signal: 'phone_matches', contribution: round4(dPhone) },
    { signal: 'provider_referral_count', contribution: round4(dReferral) },
    { signal: 'identity_mismatch', contribution: round4(dIdentity) },
    { signal: 'prior_confirmed_fraud', contribution: round4(dPrior) },
  ]
    .filter((d) => d.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution);

  return {
    entity_id: input.entity_id ?? `ENT-${input.customer_id}`,
    customer_id: input.customer_id,
    fraud_probability: fraud,
    severity,
    likely_fraud_type,
    ring_membership_likelihood: ring,
    signals,
    recommended_action: fraudAction(severity, likely_fraud_type),
    model_version: MODEL_VERSION,
    scored_at: now.toISOString(),
  };
}

function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new FraudError('invalid_signal', 'numeric signal must be finite');
  return n;
}
function clamp01OrThrow(v: unknown, fallback: number): number {
  const n = numOr(v, fallback);
  if (n < 0 || n > 1) throw new FraudError('invalid_signal', 'identity_mismatch_score must be in [0,1]');
  return n;
}
