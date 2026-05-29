// services/bff/src/insurance_siu.ts
//
// Insurance EWS — Module 8: Claim Investigation Panel (SIU workspace).
//
// A Special Investigation Unit (SIU) workspace that makes the read-only
// suspicious-claims queue (surfaced on the Claims Anomaly page) ACTIONABLE:
// open an investigation from a flagged claim, work a 6-state lifecycle, attach
// evidence/notes, link alerts, escalate, and record a fraud decision. This is
// the insurance analog of the banking CMS case investigation (M9.1) — same
// state-machine + stateful-store shape, SIU-flavoured.
//
// Surfaces (routes in server.ts):
//   GET  /v1/insurance/siu/queue                          — suspicious claims (worst-first)
//   POST /v1/insurance/siu/investigations                 — open from a claim
//   GET  /v1/insurance/siu/investigations?status=&page=   — list
//   GET  /v1/insurance/siu/investigations/:id             — single (notes + evidence + alerts)
//   PATCH /v1/insurance/siu/investigations/:id/status     — transition (+ decision on close)
//   POST /v1/insurance/siu/investigations/:id/notes       — add note
//   POST /v1/insurance/siu/investigations/:id/evidence    — add evidence / attachment ref
//   POST /v1/insurance/siu/investigations/:id/escalate    — escalate to SIU lead
//   POST /v1/insurance/siu/investigations/:id/link-alert  — link an EWS alert
//
// The queue is deterministic (FNV-1a + Mulberry32 per (tenant, day)); the
// investigation store is in-memory (swaps to app_insurance.claim_investigations
// when the insurer's feeds land). Mutations are tenant-scoped.

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

// ── State machine ─────────────────────────────────────────────────────────

export type SiuStatus =
  | 'triage'
  | 'evidence_gathering'
  | 'awaiting_response'
  | 'review'
  | 'decision'
  | 'closed';
export const ALL_SIU_STATUSES: readonly SiuStatus[] = [
  'triage',
  'evidence_gathering',
  'awaiting_response',
  'review',
  'decision',
  'closed',
];

export type SiuDecision = 'fraud_confirmed' | 'fraud_unsubstantiated' | 'partial_fraud' | 'data_quality';
export const ALL_SIU_DECISIONS: readonly SiuDecision[] = [
  'fraud_confirmed',
  'fraud_unsubstantiated',
  'partial_fraud',
  'data_quality',
];

const TRANSITIONS: Record<SiuStatus, SiuStatus[]> = {
  triage: ['evidence_gathering', 'closed'],
  evidence_gathering: ['awaiting_response', 'review', 'closed'],
  awaiting_response: ['evidence_gathering', 'review', 'closed'],
  review: ['decision', 'evidence_gathering', 'closed'],
  decision: ['closed', 'review'],
  closed: ['evidence_gathering'], // re-open
};

export function canTransition(from: SiuStatus, to: SiuStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type EvidenceType = 'document' | 'photo' | 'statement' | 'system_record' | 'external_report';
export const ALL_EVIDENCE_TYPES: readonly EvidenceType[] = [
  'document',
  'photo',
  'statement',
  'system_record',
  'external_report',
];

export type SuspicionReason =
  | 'amount_spike'
  | 'high_frequency'
  | 'early_claim'
  | 'document_mismatch'
  | 'provider_collusion'
  | 'duplicate_claim'
  | 'identity_mismatch';

export interface SiuEvidence {
  evidence_id: string;
  type: EvidenceType;
  title: string;
  description: string;
  attachment_ref: string | null; // URI / DMS ref; metadata only (no binary)
  added_at: string;
  added_by: string;
}

export interface SiuNote {
  note_id: string;
  ts: string;
  author: string;
  body: string;
}

export interface SiuInvestigation {
  investigation_id: string;
  tenant_id: string;
  claim_id: string;
  policy_id: string;
  claimant_name: string;
  product: string;
  claim_amount_kes: number;
  anomaly_score: number; // 0..1
  suspicion_reasons: SuspicionReason[];
  status: SiuStatus;
  decision: SiuDecision | null;
  escalated: boolean;
  opened_at: string;
  opened_by: string;
  last_updated_at: string;
  last_updated_by: string;
  closed_at: string | null;
  notes: SiuNote[];
  evidence: SiuEvidence[];
  linked_alerts: string[];
}

export class SiuError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SiuError';
  }
}

// ── Suspicious-claims queue (deterministic candidate generation) ────────────

const FIRST = ['Asha', 'Ravi', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya', 'Sunil', 'Deepa'];
const LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Bose'];
const PRODUCTS = ['Term Life', 'Endowment', 'ULIP', 'Health Indemnity', 'Critical Illness', 'Money-Back'];
const REASONS: SuspicionReason[] = [
  'amount_spike',
  'high_frequency',
  'early_claim',
  'document_mismatch',
  'provider_collusion',
  'duplicate_claim',
  'identity_mismatch',
];

export interface SiuQueueRow {
  claim_id: string;
  policy_id: string;
  claimant_name: string;
  product: string;
  claim_amount_kes: number;
  anomaly_score: number;
  suspicion_reasons: SuspicionReason[];
  filed_at: string;
  has_open_investigation: boolean;
}

const QUEUE_SIZE = 24;

function tenantScale(t: string): number {
  return t === 'BIL' ? 0.6 : 1.0;
}

function suspiciousClaim(tenant_id: string, idx: number, now: Date): SiuQueueRow {
  const day = now.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(`${tenant_id}|siu|${idx}|${day}`));
  const scale = tenantScale(tenant_id);
  const score = Math.round((0.5 + rng() * 0.5) * 100) / 100; // 0.50-1.00 (all suspicious)
  const nReasons = 1 + Math.floor(rng() * 3);
  const reasons: SuspicionReason[] = [];
  for (let i = 0; i < nReasons; i++) {
    const r = REASONS[Math.floor(rng() * REASONS.length)];
    if (!reasons.includes(r)) reasons.push(r);
  }
  const filed = new Date(now);
  filed.setUTCDate(filed.getUTCDate() - Math.floor(rng() * 45));
  return {
    claim_id: `CLM-${tenant_id === 'BIL' ? 'BIL' : 'BD'}-${String(800000 + idx)}`,
    policy_id: `POL-${tenant_id}-${String(100000 + idx)}`,
    claimant_name: `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`,
    product: PRODUCTS[Math.floor(rng() * PRODUCTS.length)],
    claim_amount_kes: Math.round((100_000 + rng() * 4_000_000) * scale),
    anomaly_score: score,
    suspicion_reasons: reasons,
    filed_at: filed.toISOString(),
    has_open_investigation: false, // decorated by the store
  };
}

// ── In-memory investigation store ───────────────────────────────────────────

export interface SiuStore {
  listQueue(tenant_id: string, now: Date, opts?: { min_score?: number; limit?: number }): SiuQueueRow[];
  open(tenant_id: string, input: OpenSiuInput, now: Date): SiuInvestigation;
  list(tenant_id: string, opts?: { status?: SiuStatus; page?: number; page_size?: number }): { total: number; items: SiuInvestigation[] };
  get(tenant_id: string, investigation_id: string): SiuInvestigation | null;
  updateStatus(tenant_id: string, investigation_id: string, to: SiuStatus, actor: string, now: Date, decision?: SiuDecision | null): SiuInvestigation;
  addNote(tenant_id: string, investigation_id: string, body: string, author: string, now: Date): SiuInvestigation;
  addEvidence(tenant_id: string, investigation_id: string, input: AddEvidenceInput, actor: string, now: Date): SiuInvestigation;
  escalate(tenant_id: string, investigation_id: string, actor: string, now: Date): SiuInvestigation;
  linkAlert(tenant_id: string, investigation_id: string, alert_id: string, actor: string, now: Date): SiuInvestigation;
}

export interface OpenSiuInput {
  claim_id: string;
  policy_id?: string;
  claimant_name?: string;
  product?: string;
  claim_amount_kes?: number;
  anomaly_score?: number;
  suspicion_reasons?: SuspicionReason[];
  opened_by: string;
}

export interface AddEvidenceInput {
  type: EvidenceType;
  title: string;
  description?: string;
  attachment_ref?: string;
}

const MAX_TEXT = 4000;

export class InMemorySiuStore implements SiuStore {
  private byTenant = new Map<string, Map<string, SiuInvestigation>>(); // tenant → id → inv
  private seq = 0;

  private tenantMap(tenant_id: string): Map<string, SiuInvestigation> {
    if (!this.byTenant.has(tenant_id)) this.byTenant.set(tenant_id, new Map());
    return this.byTenant.get(tenant_id)!;
  }

  private openClaimIds(tenant_id: string): Set<string> {
    const out = new Set<string>();
    for (const inv of this.tenantMap(tenant_id).values()) {
      if (inv.status !== 'closed') out.add(inv.claim_id);
    }
    return out;
  }

  listQueue(tenant_id: string, now: Date, opts: { min_score?: number; limit?: number } = {}): SiuQueueRow[] {
    if (!tenant_id) throw new SiuError('invalid_input', 'tenant_id required');
    const openIds = this.openClaimIds(tenant_id);
    let rows: SiuQueueRow[] = [];
    for (let i = 0; i < QUEUE_SIZE; i++) {
      const r = suspiciousClaim(tenant_id, i, now);
      r.has_open_investigation = openIds.has(r.claim_id);
      rows.push(r);
    }
    if (opts.min_score != null) rows = rows.filter((r) => r.anomaly_score >= opts.min_score!);
    rows.sort((a, b) => b.anomaly_score - a.anomaly_score || a.claim_id.localeCompare(b.claim_id));
    const limit = opts.limit != null ? Math.max(1, Math.min(QUEUE_SIZE, Math.floor(opts.limit))) : QUEUE_SIZE;
    return rows.slice(0, limit);
  }

  open(tenant_id: string, input: OpenSiuInput, now: Date): SiuInvestigation {
    if (!tenant_id) throw new SiuError('invalid_input', 'tenant_id required');
    if (!input.claim_id) throw new SiuError('invalid_input', 'claim_id required');
    if (!input.opened_by) throw new SiuError('invalid_input', 'opened_by required');
    const map = this.tenantMap(tenant_id);
    // Refuse a 2nd open investigation for the same claim.
    for (const inv of map.values()) {
      if (inv.claim_id === input.claim_id && inv.status !== 'closed') {
        throw new SiuError('investigation_already_open', `claim ${input.claim_id} already under investigation`);
      }
    }
    // Pull canonical claim facts from the deterministic queue when present.
    const queueMatch = this.listQueue(tenant_id, now).find((r) => r.claim_id === input.claim_id);
    const ts = now.toISOString();
    const inv: SiuInvestigation = {
      investigation_id: `siu-${tenant_id}-${ts.slice(0, 10)}-${String(this.seq++).padStart(4, '0')}`,
      tenant_id,
      claim_id: input.claim_id,
      policy_id: input.policy_id ?? queueMatch?.policy_id ?? `POL-${tenant_id}-unknown`,
      claimant_name: input.claimant_name ?? queueMatch?.claimant_name ?? 'Unknown',
      product: input.product ?? queueMatch?.product ?? 'Unknown',
      claim_amount_kes: input.claim_amount_kes ?? queueMatch?.claim_amount_kes ?? 0,
      anomaly_score: input.anomaly_score ?? queueMatch?.anomaly_score ?? 0,
      suspicion_reasons: input.suspicion_reasons ?? queueMatch?.suspicion_reasons ?? [],
      status: 'triage',
      decision: null,
      escalated: false,
      opened_at: ts,
      opened_by: input.opened_by,
      last_updated_at: ts,
      last_updated_by: input.opened_by,
      closed_at: null,
      notes: [],
      evidence: [],
      linked_alerts: [],
    };
    map.set(inv.investigation_id, inv);
    return structuredClone(inv);
  }

  list(tenant_id: string, opts: { status?: SiuStatus; page?: number; page_size?: number } = {}): { total: number; items: SiuInvestigation[] } {
    if (!tenant_id) throw new SiuError('invalid_input', 'tenant_id required');
    let items = Array.from(this.tenantMap(tenant_id).values());
    if (opts.status) {
      if (!ALL_SIU_STATUSES.includes(opts.status)) throw new SiuError('invalid_status', `unknown status ${opts.status}`);
      items = items.filter((i) => i.status === opts.status);
    }
    // worst-first (anomaly desc) then newest
    items.sort((a, b) => b.anomaly_score - a.anomaly_score || b.opened_at.localeCompare(a.opened_at));
    const total = items.length;
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Math.floor(opts.page_size ?? 50)));
    const start = (page - 1) * pageSize;
    return { total, items: items.slice(start, start + pageSize).map((i) => structuredClone(i)) };
  }

  get(tenant_id: string, investigation_id: string): SiuInvestigation | null {
    const inv = this.tenantMap(tenant_id).get(investigation_id);
    return inv ? structuredClone(inv) : null;
  }

  private requireLive(tenant_id: string, investigation_id: string): SiuInvestigation {
    const inv = this.tenantMap(tenant_id).get(investigation_id);
    if (!inv) throw new SiuError('unknown_investigation', `unknown investigation ${investigation_id}`);
    return inv;
  }

  updateStatus(tenant_id: string, investigation_id: string, to: SiuStatus, actor: string, now: Date, decision?: SiuDecision | null): SiuInvestigation {
    if (!actor) throw new SiuError('invalid_input', 'actor required');
    if (!ALL_SIU_STATUSES.includes(to)) throw new SiuError('invalid_status', `unknown status ${to}`);
    const inv = this.requireLive(tenant_id, investigation_id);
    if (!canTransition(inv.status, to))
      throw new SiuError('invalid_transition', `cannot move ${inv.status} → ${to}`);
    if (decision != null && !ALL_SIU_DECISIONS.includes(decision))
      throw new SiuError('invalid_decision', `unknown decision ${decision}`);
    // Closing FROM decision requires a decision.
    if (to === 'closed' && inv.status === 'decision' && decision == null && inv.decision == null)
      throw new SiuError('decision_required', 'a decision is required to close from review/decision');
    if (decision != null) inv.decision = decision;
    if (to === 'closed') inv.closed_at = now.toISOString();
    if (to !== 'closed') inv.closed_at = null; // re-open clears
    inv.status = to;
    inv.last_updated_at = now.toISOString();
    inv.last_updated_by = actor;
    return structuredClone(inv);
  }

  addNote(tenant_id: string, investigation_id: string, body: string, author: string, now: Date): SiuInvestigation {
    if (!author) throw new SiuError('invalid_input', 'author required');
    if (!body || body.trim().length === 0) throw new SiuError('invalid_input', 'note body required');
    if (body.length > MAX_TEXT) throw new SiuError('invalid_input', 'note too long');
    const inv = this.requireLive(tenant_id, investigation_id);
    inv.notes.push({ note_id: `note-${String(inv.notes.length).padStart(3, '0')}`, ts: now.toISOString(), author, body: body.trim() });
    inv.last_updated_at = now.toISOString();
    inv.last_updated_by = author;
    return structuredClone(inv);
  }

  addEvidence(tenant_id: string, investigation_id: string, input: AddEvidenceInput, actor: string, now: Date): SiuInvestigation {
    if (!actor) throw new SiuError('invalid_input', 'actor required');
    if (!ALL_EVIDENCE_TYPES.includes(input.type)) throw new SiuError('invalid_evidence_type', `unknown evidence type ${input.type}`);
    if (!input.title || input.title.trim().length === 0) throw new SiuError('invalid_input', 'evidence title required');
    if ((input.description ?? '').length > MAX_TEXT) throw new SiuError('invalid_input', 'evidence description too long');
    const inv = this.requireLive(tenant_id, investigation_id);
    inv.evidence.push({
      evidence_id: `ev-${String(inv.evidence.length).padStart(3, '0')}`,
      type: input.type,
      title: input.title.trim(),
      description: (input.description ?? '').trim(),
      attachment_ref: input.attachment_ref?.trim() || null,
      added_at: now.toISOString(),
      added_by: actor,
    });
    inv.last_updated_at = now.toISOString();
    inv.last_updated_by = actor;
    return structuredClone(inv);
  }

  escalate(tenant_id: string, investigation_id: string, actor: string, now: Date): SiuInvestigation {
    if (!actor) throw new SiuError('invalid_input', 'actor required');
    const inv = this.requireLive(tenant_id, investigation_id);
    inv.escalated = true;
    inv.last_updated_at = now.toISOString();
    inv.last_updated_by = actor;
    return structuredClone(inv);
  }

  linkAlert(tenant_id: string, investigation_id: string, alert_id: string, actor: string, now: Date): SiuInvestigation {
    if (!actor) throw new SiuError('invalid_input', 'actor required');
    if (!alert_id || alert_id.trim().length === 0) throw new SiuError('invalid_input', 'alert_id required');
    const inv = this.requireLive(tenant_id, investigation_id);
    const a = alert_id.trim();
    if (!inv.linked_alerts.includes(a)) inv.linked_alerts.push(a);
    inv.last_updated_at = now.toISOString();
    inv.last_updated_by = actor;
    return structuredClone(inv);
  }
}

let _store: InMemorySiuStore | null = null;
export function defaultSiuStore(): InMemorySiuStore {
  if (!_store) _store = new InMemorySiuStore();
  return _store;
}
export function _resetSiuStore() {
  _store = null;
}
