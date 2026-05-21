// services/bff/src/aml/correlation.ts
//
// PHASE T3.3 — AML Bidirectional Alert Correlation Engine.
//
// Cross-module linker that connects:
//   - AML matches (M14.3 AmlAdapter)
//   - EWS alerts (M8.x alert evaluator)
//   - Cases + investigations (M9.x case + investigation stores)
//   - STR reports (C.1 STR reporting workflow)
//
// Architecture:
//   - Bidirectional relationship table (correlation_links) keyed by
//     (tenant, source_kind, source_id, target_kind, target_id).
//     Symmetric — a link from AML→EWS is also queryable from EWS→AML.
//   - Per-customer UNIFIED TIMELINE — collates events across the
//     4 modules into a single newest-first feed (drives the SPA's
//     360-degree timeline view).
//   - Correlation graph traversal — for any source, return all
//     transitively-linked entities (e.g. "give me everything connected
//     to STR-2026-001": its case + the originating alert + the AML
//     match that fired it).
//
// Architecture choices (per execution rules):
//   - Additive only — no changes to M14.3 / M8.x / M9.x / C.1.
//   - Pure-data + in-memory ledger; pg-backed swap via the
//     IAmlCorrelationStore interface is a future ticket.
//   - Closed enum of entity kinds for stable SPA filtering.
//   - Audit fields + soft-delete + Recovery Center adapter.
//   - RBAC: audit:read admin-only (cross-module visibility is
//     compliance-sensitive).

/** Closed enum — the 4 entity kinds we correlate. */
export const ALL_AML_ENTITY_KINDS = [
  'aml_match',
  'ews_alert',
  'case',
  'investigation',
  'str_report',
] as const;
export type AmlEntityKind = (typeof ALL_AML_ENTITY_KINDS)[number];

export function isAmlEntityKind(v: unknown): v is AmlEntityKind {
  return (
    typeof v === 'string' &&
    (ALL_AML_ENTITY_KINDS as readonly string[]).includes(v)
  );
}

/** Closed enum — relationship type. Captures WHY two entities are
 *  linked so the SPA can render the right arrow/label. */
export const ALL_AML_LINK_RELATIONS = [
  /** AML match triggered an EWS alert (M14.3 → M8.x). */
  'triggered_alert',
  /** EWS alert escalated to a case (M8.x → M9.x). */
  'escalated_to_case',
  /** Case spawned a fraud-investigation (M9.x case → M9.1 investigation). */
  'opened_investigation',
  /** Investigation produced an STR report (M9.1 → C.1). */
  'reported_to_fiu',
  /** Two entities reference the same customer (weakest link kind — used
   *  for cross-module "related events for this customer" surfacing). */
  'same_customer',
  /** Operator-asserted relationship — captures "yes these are linked,
   *  see notes" outside the automatic relations. */
  'manual_link',
] as const;
export type AmlLinkRelation = (typeof ALL_AML_LINK_RELATIONS)[number];

export function isAmlLinkRelation(v: unknown): v is AmlLinkRelation {
  return (
    typeof v === 'string' &&
    (ALL_AML_LINK_RELATIONS as readonly string[]).includes(v)
  );
}

/** Closed enum — timeline event severity (drives the SPA badge colour). */
export const ALL_AML_TIMELINE_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;
export type AmlTimelineSeverity = (typeof ALL_AML_TIMELINE_SEVERITIES)[number];

/** A directed link between two entities. The same logical relationship
 *  is stored once — symmetric lookup is handled at query time via
 *  list-by-source AND list-by-target. */
export interface AmlCorrelationLink {
  link_id: string;
  tenant_id: string;
  source_kind: AmlEntityKind;
  source_id: string;
  target_kind: AmlEntityKind;
  target_id: string;
  relation: AmlLinkRelation;
  /** Customer this link is attributed to. Stored for fast per-customer
   *  timeline queries. May be null when the link spans entities for
   *  different customers (rare; manual_link only). */
  customer_id: string | null;
  /** Confidence in the link (0.0–1.0). 1.0 for system-generated
   *  relationships (triggered_alert, escalated_to_case, etc.); operator
   *  manual_link defaults to 0.5 unless overridden. */
  confidence: number;
  notes: string | null;
  /** Audit envelope. */
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface AmlCorrelationLinkInput {
  link_id?: string;
  source_kind: AmlEntityKind;
  source_id: string;
  target_kind: AmlEntityKind;
  target_id: string;
  relation: AmlLinkRelation;
  customer_id?: string | null;
  confidence?: number;
  notes?: string | null;
}

/** A timeline event surfaced into the unified per-customer feed. The
 *  caller (typically the BFF route) builds these from raw module
 *  sources (AML, alerts, cases, investigations, STR). */
export interface AmlTimelineEvent {
  event_id: string;
  tenant_id: string;
  customer_id: string;
  entity_kind: AmlEntityKind;
  entity_id: string;
  /** ISO timestamp of when the event occurred (vs when it was logged). */
  occurred_at: string;
  severity: AmlTimelineSeverity;
  /** Display title for the SPA tile — usually 1 sentence. */
  title: string;
  /** Free-text body — 2–3 sentences max. */
  description: string | null;
}

export class AmlCorrelationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_link_id'
      | 'invalid_entity_kind'
      | 'invalid_entity_id'
      | 'invalid_relation'
      | 'invalid_customer_id'
      | 'invalid_confidence'
      | 'invalid_notes'
      | 'invalid_traversal'
      | 'unknown_link'
      | 'duplicate_link'
      | 'self_link'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AmlCorrelationError';
  }
}

export const AML_CORRELATION_CAP_PER_TENANT = 50_000;
export const AML_CORRELATION_MAX_TRAVERSAL_DEPTH = 5;

const LINK_ID_RE = /^acl_[a-z0-9_-]{1,60}$/;
const ENTITY_ID_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const CUSTOMER_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;

function validateLinkInput(input: AmlCorrelationLinkInput): void {
  if (!input || typeof input !== 'object') {
    throw new AmlCorrelationError('invalid_input', 'request body must be an object');
  }
  if (input.link_id !== undefined && (typeof input.link_id !== 'string' || !LINK_ID_RE.test(input.link_id))) {
    throw new AmlCorrelationError(
      'invalid_link_id',
      'link_id must match ^acl_[a-z0-9_-]{1,60}$',
    );
  }
  if (!isAmlEntityKind(input.source_kind)) {
    throw new AmlCorrelationError(
      'invalid_entity_kind',
      `source_kind must be one of: ${ALL_AML_ENTITY_KINDS.join(', ')}`,
    );
  }
  if (!isAmlEntityKind(input.target_kind)) {
    throw new AmlCorrelationError(
      'invalid_entity_kind',
      `target_kind must be one of: ${ALL_AML_ENTITY_KINDS.join(', ')}`,
    );
  }
  if (typeof input.source_id !== 'string' || !ENTITY_ID_RE.test(input.source_id)) {
    throw new AmlCorrelationError(
      'invalid_entity_id',
      'source_id must match ^[A-Za-z][A-Za-z0-9_.:-]{0,127}$',
    );
  }
  if (typeof input.target_id !== 'string' || !ENTITY_ID_RE.test(input.target_id)) {
    throw new AmlCorrelationError(
      'invalid_entity_id',
      'target_id must match ^[A-Za-z][A-Za-z0-9_.:-]{0,127}$',
    );
  }
  // Self-link guard: same (kind, id) pair on both ends is meaningless.
  if (input.source_kind === input.target_kind && input.source_id === input.target_id) {
    throw new AmlCorrelationError(
      'self_link',
      'source and target cannot be the same entity',
    );
  }
  if (!isAmlLinkRelation(input.relation)) {
    throw new AmlCorrelationError(
      'invalid_relation',
      `relation must be one of: ${ALL_AML_LINK_RELATIONS.join(', ')}`,
    );
  }
  if (input.customer_id !== undefined && input.customer_id !== null) {
    if (typeof input.customer_id !== 'string' || !CUSTOMER_ID_RE.test(input.customer_id)) {
      throw new AmlCorrelationError(
        'invalid_customer_id',
        'customer_id must match ^[A-Za-z][A-Za-z0-9_-]{1,63}$',
      );
    }
  }
  if (input.confidence !== undefined) {
    if (
      typeof input.confidence !== 'number' ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      throw new AmlCorrelationError(
        'invalid_confidence',
        'confidence must be a finite number in [0, 1]',
      );
    }
  }
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string' || input.notes.length > 2000) {
      throw new AmlCorrelationError(
        'invalid_notes',
        'notes must be a string ≤ 2000 chars',
      );
    }
  }
}

/** Default confidence by relation type — system-generated relations
 *  are high-confidence; manual_link defaults to mid. */
function defaultConfidenceFor(relation: AmlLinkRelation): number {
  switch (relation) {
    case 'triggered_alert':
    case 'escalated_to_case':
    case 'opened_investigation':
    case 'reported_to_fiu':
      return 1.0;
    case 'same_customer':
      return 0.75;
    case 'manual_link':
      return 0.5;
  }
}

/** Make the canonical key for the (source, target, relation) tuple. */
function dedupKey(input: AmlCorrelationLinkInput): string {
  return `${input.source_kind}:${input.source_id}|${input.target_kind}:${input.target_id}|${input.relation}`;
}

// ── Store ──────────────────────────────────────────────────────────────

export interface AmlCorrelationStore {
  list(
    tenant_id: string,
    opts?: {
      customer_id?: string;
      source_kind?: AmlEntityKind;
      source_id?: string;
      target_kind?: AmlEntityKind;
      target_id?: string;
      relation?: AmlLinkRelation;
      include_deleted?: boolean;
      limit?: number;
    },
  ): AmlCorrelationLink[];
  get(tenant_id: string, link_id: string): AmlCorrelationLink | null;
  /** Returns every link where the given entity is EITHER source OR
   *  target — i.e. the symmetric view. */
  listForEntity(
    tenant_id: string,
    kind: AmlEntityKind,
    id: string,
  ): AmlCorrelationLink[];
  /** BFS over the correlation graph. Returns every distinct
   *  (kind, id) reachable from `origin` within `depth` hops. */
  traverse(
    tenant_id: string,
    origin: { kind: AmlEntityKind; id: string },
    depth: number,
  ): {
    nodes: ReadonlyArray<{ kind: AmlEntityKind; id: string; reached_at_depth: number }>;
    edges: ReadonlyArray<AmlCorrelationLink>;
  };
  link(
    tenant_id: string,
    input: AmlCorrelationLinkInput,
    actor: string,
    now: Date,
  ): AmlCorrelationLink;
  softDelete(
    tenant_id: string,
    link_id: string,
    actor: string,
    now: Date,
  ): AmlCorrelationLink;
  restore(payload: AmlCorrelationLink): boolean;
  /** Summary of correlation density per relation type — drives the
   *  SPA's "AML graph health" tile. */
  summary(tenant_id: string): AmlCorrelationSummary;
}

export interface AmlCorrelationSummary {
  total_links: number;
  by_relation: Record<AmlLinkRelation, number>;
  /** Per source-target-kind pair counts — sparse map (only populated
   *  pairs surface). Key format `${source_kind}->${target_kind}`. */
  by_kind_pair: Record<string, number>;
  total_customers_with_links: number;
  /** Top 5 customers by link count for the "most-connected" tile. */
  top_customers: ReadonlyArray<{ customer_id: string; link_count: number }>;
}

export class InMemoryAmlCorrelationStore implements AmlCorrelationStore {
  private byTenant = new Map<string, Map<string, AmlCorrelationLink>>();
  /** Per-tenant index from dedup-key → link_id to enforce uniqueness. */
  private dedupByTenant = new Map<string, Map<string, string>>();
  private idCounter = 0;

  private bucket(tenant_id: string): Map<string, AmlCorrelationLink> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  private dedupBucket(tenant_id: string): Map<string, string> {
    let b = this.dedupByTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.dedupByTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: {
      customer_id?: string;
      source_kind?: AmlEntityKind;
      source_id?: string;
      target_kind?: AmlEntityKind;
      target_id?: string;
      relation?: AmlLinkRelation;
      include_deleted?: boolean;
      limit?: number;
    } = {},
  ): AmlCorrelationLink[] {
    const out: AmlCorrelationLink[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const l of b.values()) {
      if (!opts.include_deleted && l.deleted_at) continue;
      if (opts.customer_id !== undefined && l.customer_id !== opts.customer_id) continue;
      if (opts.source_kind !== undefined && l.source_kind !== opts.source_kind) continue;
      if (opts.source_id !== undefined && l.source_id !== opts.source_id) continue;
      if (opts.target_kind !== undefined && l.target_kind !== opts.target_kind) continue;
      if (opts.target_id !== undefined && l.target_id !== opts.target_id) continue;
      if (opts.relation !== undefined && l.relation !== opts.relation) continue;
      out.push({ ...l });
    }
    // Newest-first by created_at; tie-break by link_id desc.
    out.sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
      return b.link_id.localeCompare(a.link_id);
    });
    const limit = opts.limit ?? 200;
    return out.slice(0, Math.min(Math.max(limit, 1), 500));
  }

  get(tenant_id: string, link_id: string): AmlCorrelationLink | null {
    const l = this.byTenant.get(tenant_id)?.get(link_id);
    if (!l || l.deleted_at) return null;
    return { ...l };
  }

  listForEntity(
    tenant_id: string,
    kind: AmlEntityKind,
    id: string,
  ): AmlCorrelationLink[] {
    const b = this.byTenant.get(tenant_id);
    if (!b) return [];
    const out: AmlCorrelationLink[] = [];
    for (const l of b.values()) {
      if (l.deleted_at) continue;
      const isSource = l.source_kind === kind && l.source_id === id;
      const isTarget = l.target_kind === kind && l.target_id === id;
      if (isSource || isTarget) out.push({ ...l });
    }
    // Newest-first.
    out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return out;
  }

  traverse(
    tenant_id: string,
    origin: { kind: AmlEntityKind; id: string },
    depth: number,
  ): {
    nodes: ReadonlyArray<{ kind: AmlEntityKind; id: string; reached_at_depth: number }>;
    edges: ReadonlyArray<AmlCorrelationLink>;
  } {
    if (
      typeof depth !== 'number' ||
      !Number.isInteger(depth) ||
      depth < 0 ||
      depth > AML_CORRELATION_MAX_TRAVERSAL_DEPTH
    ) {
      throw new AmlCorrelationError(
        'invalid_traversal',
        `depth must be an integer in [0, ${AML_CORRELATION_MAX_TRAVERSAL_DEPTH}]`,
      );
    }
    if (!isAmlEntityKind(origin.kind)) {
      throw new AmlCorrelationError('invalid_entity_kind', 'origin.kind invalid');
    }
    if (typeof origin.id !== 'string' || !ENTITY_ID_RE.test(origin.id)) {
      throw new AmlCorrelationError('invalid_entity_id', 'origin.id invalid');
    }
    const visited = new Map<string, { kind: AmlEntityKind; id: string; depth: number }>();
    const edges = new Map<string, AmlCorrelationLink>();
    const seedKey = `${origin.kind}:${origin.id}`;
    visited.set(seedKey, { kind: origin.kind, id: origin.id, depth: 0 });
    let frontier: ReadonlyArray<{ kind: AmlEntityKind; id: string }> = [origin];
    for (let d = 1; d <= depth; d++) {
      const nextFrontier: Array<{ kind: AmlEntityKind; id: string }> = [];
      for (const node of frontier) {
        const adjacent = this.listForEntity(tenant_id, node.kind, node.id);
        for (const e of adjacent) {
          edges.set(e.link_id, e);
          // The "other end" of the edge relative to `node`.
          const other = e.source_kind === node.kind && e.source_id === node.id
            ? { kind: e.target_kind, id: e.target_id }
            : { kind: e.source_kind, id: e.source_id };
          const k = `${other.kind}:${other.id}`;
          if (!visited.has(k)) {
            visited.set(k, { kind: other.kind, id: other.id, depth: d });
            nextFrontier.push(other);
          }
        }
      }
      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
    }
    const nodes = [...visited.values()].map((n) => ({
      kind: n.kind,
      id: n.id,
      reached_at_depth: n.depth,
    }));
    return {
      nodes,
      edges: [...edges.values()],
    };
  }

  link(
    tenant_id: string,
    input: AmlCorrelationLinkInput,
    actor: string,
    now: Date,
  ): AmlCorrelationLink {
    validateLinkInput(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new AmlCorrelationError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const dedup = this.dedupBucket(tenant_id);
    // Dedup by (source, target, relation) tuple.
    const key = dedupKey(input);
    const existingId = dedup.get(key);
    if (existingId) {
      const existing = b.get(existingId);
      if (existing && !existing.deleted_at) {
        throw new AmlCorrelationError(
          'duplicate_link',
          `link already exists: ${key}`,
          { existing_link_id: existingId },
        );
      }
    }
    const live = [...b.values()].filter((l) => !l.deleted_at).length;
    if (live >= AML_CORRELATION_CAP_PER_TENANT) {
      throw new AmlCorrelationError(
        'cap_reached',
        `correlation cap (${AML_CORRELATION_CAP_PER_TENANT}) reached`,
      );
    }
    let link_id = input.link_id;
    if (!link_id) {
      this.idCounter++;
      link_id = `acl_${now.getTime().toString(36)}_${this.idCounter}`;
    }
    if (b.has(link_id) && !b.get(link_id)!.deleted_at) {
      throw new AmlCorrelationError(
        'duplicate_link',
        `link_id ${link_id} already exists`,
        { link_id },
      );
    }
    const ts = now.toISOString();
    const entry: AmlCorrelationLink = {
      link_id,
      tenant_id,
      source_kind: input.source_kind,
      source_id: input.source_id,
      target_kind: input.target_kind,
      target_id: input.target_id,
      relation: input.relation,
      customer_id: input.customer_id ?? null,
      confidence:
        input.confidence !== undefined ? input.confidence : defaultConfidenceFor(input.relation),
      notes: input.notes?.trim() || null,
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.link_id, entry);
    dedup.set(key, entry.link_id);
    return { ...entry };
  }

  softDelete(
    tenant_id: string,
    link_id: string,
    actor: string,
    now: Date,
  ): AmlCorrelationLink {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new AmlCorrelationError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(link_id);
    if (!cur || cur.deleted_at) {
      throw new AmlCorrelationError('unknown_link', `link ${link_id} not found`);
    }
    const ts = now.toISOString();
    const tombstoned: AmlCorrelationLink = {
      ...cur,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(link_id, tombstoned);
    // Free the dedup slot so the same edge can be re-asserted later.
    const dedup = this.dedupBucket(tenant_id);
    const key = dedupKey(cur);
    if (dedup.get(key) === link_id) dedup.delete(key);
    return { ...tombstoned };
  }

  restore(payload: AmlCorrelationLink): boolean {
    const b = this.bucket(payload.tenant_id);
    const cur = b.get(payload.link_id);
    if (cur && !cur.deleted_at) return false;
    // Refuse restore if the tuple is already covered by a live link.
    const dedup = this.dedupBucket(payload.tenant_id);
    const key = dedupKey(payload);
    const existingId = dedup.get(key);
    if (existingId && existingId !== payload.link_id) {
      const existing = b.get(existingId);
      if (existing && !existing.deleted_at) return false;
    }
    const restored: AmlCorrelationLink = {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(restored.link_id, restored);
    dedup.set(key, restored.link_id);
    return true;
  }

  summary(tenant_id: string): AmlCorrelationSummary {
    const by_relation: Record<AmlLinkRelation, number> = {
      triggered_alert: 0,
      escalated_to_case: 0,
      opened_investigation: 0,
      reported_to_fiu: 0,
      same_customer: 0,
      manual_link: 0,
    };
    const by_kind_pair: Record<string, number> = {};
    const customerCounts = new Map<string, number>();
    let total = 0;
    const b = this.byTenant.get(tenant_id);
    if (b) {
      for (const l of b.values()) {
        if (l.deleted_at) continue;
        total++;
        by_relation[l.relation]++;
        const pair = `${l.source_kind}->${l.target_kind}`;
        by_kind_pair[pair] = (by_kind_pair[pair] ?? 0) + 1;
        if (l.customer_id) {
          customerCounts.set(l.customer_id, (customerCounts.get(l.customer_id) ?? 0) + 1);
        }
      }
    }
    const top_customers = [...customerCounts.entries()]
      .map(([customer_id, link_count]) => ({ customer_id, link_count }))
      .sort((a, b) => {
        if (a.link_count !== b.link_count) return b.link_count - a.link_count;
        return a.customer_id.localeCompare(b.customer_id);
      })
      .slice(0, 5);
    return {
      total_links: total,
      by_relation,
      by_kind_pair,
      total_customers_with_links: customerCounts.size,
      top_customers,
    };
  }
}

export const defaultAmlCorrelationStore: AmlCorrelationStore = new InMemoryAmlCorrelationStore();

// ── Timeline composer ─────────────────────────────────────────────────

/** Build a unified per-customer timeline. Pure function — caller
 *  supplies the raw event lists (typically via fan-out queries to
 *  M14.3 / M8.x / M9.x / C.1). Returns newest-first capped at `limit`. */
export function composeCustomerTimeline(
  events: readonly AmlTimelineEvent[],
  customer_id: string,
  limit: number = 50,
): AmlTimelineEvent[] {
  if (typeof customer_id !== 'string' || !CUSTOMER_ID_RE.test(customer_id)) {
    throw new AmlCorrelationError(
      'invalid_customer_id',
      'customer_id must match ^[A-Za-z][A-Za-z0-9_-]{1,63}$',
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AmlCorrelationError(
      'invalid_input',
      'limit must be an integer in [1, 500]',
    );
  }
  const filtered = events
    .filter((e) => e && e.customer_id === customer_id)
    .slice()
    .sort((a, b) => {
      if (a.occurred_at !== b.occurred_at) return b.occurred_at.localeCompare(a.occurred_at);
      return b.event_id.localeCompare(a.event_id);
    });
  return filtered.slice(0, limit);
}
