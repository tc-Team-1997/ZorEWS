// services/bff/src/audit_evidence.ts
//
// T6 M15.3 — Audit retention / evidence packaging.
//
// M15.1 ships the BIL audit trail. M15.2 adds the SHA-256 hash-chain
// for tamper-evidence. M15.3 ships the evidence-packaging primitive
// that BIL compliance teams use to respond to RBI / IRDAI audit
// requests:
//
//   "Show me every action by user X on case CASE-123 between
//    2026-04-01 and 2026-04-30, with chain-integrity attestation."
//
// The evidence package is a frozen, filtered snapshot of audit
// events + a hash-chain verification result. It carries enough
// information to be archived as-is (typically signed + zipped on the
// SPA side) and replayed by a regulator who has only the package.
//
// Design:
//  - Pure builder: `buildEvidencePackage(audit, tenant, filters,
//    generated_by, now, package_id)` — no I/O, deterministic given
//    the inputs.
//  - Per-tenant capped retention (`InMemoryEvidencePackageStore`)
//    so admins can list previously generated packages and re-pull.
//    Cap = 100 packages/tenant; oldest evicted on overflow.
//  - Filters extend M15.1's AuditFilters shape with a new
//    `resource_id` (e.g. case_id / claim_id / customer_id) — the
//    most common ask is "everything that touched this resource".
//    Resource_id filtering happens after the M15.1 list (M15.1
//    doesn't index by resource_id).

import {
  type AuditEvent,
  type AuditOutcome,
  type AuditResourceType,
  type AuditSeverity,
  type AuditTrailStore,
  type ChainVerification,
  isAuditOutcome,
  isAuditResourceType,
  isAuditSeverity,
} from './audit_trail';

// ─── Public types ──────────────────────────────────────────────────────

export interface EvidenceFilters {
  /** ISO timestamp inclusive lower bound. */
  since?: string;
  /** ISO timestamp inclusive upper bound. */
  until?: string;
  actor_username?: string;
  /** Single audit action verb. */
  action?: string;
  resource_type?: AuditResourceType;
  /** Resource ID — pulls events whose resource_id exactly matches.
   *  Most common axis for BIL evidence: "everything on CASE-123". */
  resource_id?: string;
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
}

export interface EvidenceIntegrity {
  /** Did the underlying tenant chain verify cleanly? */
  chain_verified: boolean;
  /** Hash of the last event in the *underlying tenant chain* (not
   *  this package). Provides the anchor point regulators use to
   *  cross-reference future packages from the same tenant. */
  chain_last_hash: string;
  /** Hashes of the first/last *event in this package*. null when
   *  the package is empty. */
  first_event_hash: string | null;
  last_event_hash: string | null;
  /** When chain_verified=false, lifted from verifyChain. */
  broken_at?: ChainVerification['broken_at'];
}

export interface EvidencePackage {
  /** Stable identifier — `EVD-{tenant}-{ts}-{seq}`. */
  package_id: string;
  tenant_id: string;
  /** When the package was built. */
  generated_at: string;
  /** Username from X-APEX-USER (default 'admin'). */
  generated_by: string;
  filters: EvidenceFilters;
  /** Number of events captured in this package. */
  event_count: number;
  /** Frozen copy of the matching events at package time. */
  events: AuditEvent[];
  integrity: EvidenceIntegrity;
  /** Bytes of the canonical JSON encoding of `events` —
   *  size-estimation hint for the SPA (e.g. "this packet is 12 KB,
   *  too small to need pagination"). */
  size_bytes: number;
}

export interface EvidencePackageList {
  items: EvidencePackage[];
  total: number;
  page: number;
  page_size: number;
}

export class EvidenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

// ─── Filter validation ────────────────────────────────────────────────

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function validateFilters(input: unknown): EvidenceFilters {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new EvidenceError('invalid_input', 'filters must be an object');
  }
  const f = input as Record<string, unknown>;
  const out: EvidenceFilters = {};
  for (const k of ['since', 'until'] as const) {
    const v = f[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !ISO_DATETIME_RE.test(v)) {
      throw new EvidenceError('invalid_input', `${k} must be ISO-8601 datetime`);
    }
    out[k] = v;
  }
  if (out.since && out.until && out.since > out.until) {
    throw new EvidenceError('invalid_input', 'since must be ≤ until');
  }
  for (const k of ['actor_username', 'action', 'resource_id'] as const) {
    const v = f[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) {
      throw new EvidenceError('invalid_input', `${k} must be a non-empty string`);
    }
    if (v.length > 200) {
      throw new EvidenceError('invalid_input', `${k} ≤ 200 chars`);
    }
    out[k] = v;
  }
  if (f.resource_type !== undefined) {
    if (!isAuditResourceType(f.resource_type)) {
      throw new EvidenceError('invalid_resource_type', `invalid resource_type: ${f.resource_type}`);
    }
    out.resource_type = f.resource_type;
  }
  if (f.outcome !== undefined) {
    if (!isAuditOutcome(f.outcome)) {
      throw new EvidenceError('invalid_outcome', `invalid outcome: ${f.outcome}`);
    }
    out.outcome = f.outcome;
  }
  if (f.severity !== undefined) {
    if (!isAuditSeverity(f.severity)) {
      throw new EvidenceError('invalid_severity', `invalid severity: ${f.severity}`);
    }
    out.severity = f.severity;
  }
  return out;
}

// ─── Builder ───────────────────────────────────────────────────────────

/**
 * Drain ALL audit events matching the M15.1-supported filter axes
 * from the store. Iterates pages until the total is reached.
 * Uses the maximum allowed page_size (500). M15.1 list returns
 * newest-first; we re-sort oldest-first below for chain alignment.
 */
function drainEvents(
  audit: AuditTrailStore,
  tenant_id: string,
  filters: EvidenceFilters,
): AuditEvent[] {
  const PAGE = 500;
  const collected: AuditEvent[] = [];
  let page = 1;
  for (;;) {
    const r = audit.list(tenant_id, {
      since: filters.since,
      until: filters.until,
      actor_username: filters.actor_username,
      action: filters.action,
      resource_type: filters.resource_type,
      outcome: filters.outcome,
      severity: filters.severity,
      page,
      page_size: PAGE,
    });
    collected.push(...r.items);
    if (collected.length >= r.total) break;
    if (r.items.length === 0) break;
    page += 1;
    if (page > 200) break; // safety — at PAGE=500 this is 100k events.
  }
  // Post-filter on resource_id (M15.1 doesn't index by it).
  const filteredByRes = filters.resource_id
    ? collected.filter((e) => e.resource_id === filters.resource_id)
    : collected;
  // Audit list is newest-first; evidence presents oldest-first to
  // match the chain order (so first_event_hash links to chain_first).
  return [...filteredByRes].reverse();
}

/**
 * Pure builder. No I/O of its own — reads via the AuditTrailStore
 * interface and assembles the package.
 *
 * `package_id_seed` lets callers inject a deterministic seq number
 * (the store uses an internal counter); pass 1+ in tests.
 */
export function buildEvidencePackage(
  audit: AuditTrailStore,
  tenant_id: string,
  filters: EvidenceFilters,
  generated_by: string,
  now: Date,
  package_id_seq: number,
): EvidencePackage {
  if (!tenant_id || typeof tenant_id !== 'string') {
    throw new EvidenceError('invalid_input', 'tenant_id required');
  }
  if (!generated_by || typeof generated_by !== 'string' || !generated_by.trim()) {
    throw new EvidenceError('invalid_input', 'generated_by required');
  }
  const events = drainEvents(audit, tenant_id, filters);

  const verification = audit.verifyChain(tenant_id, now);
  const integrity: EvidenceIntegrity = {
    chain_verified: verification.valid,
    chain_last_hash: verification.last_hash,
    first_event_hash: events.length > 0 ? events[0]!.hash : null,
    last_event_hash: events.length > 0 ? events[events.length - 1]!.hash : null,
    broken_at: verification.broken_at,
  };

  const tsCompact = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const package_id = `EVD-${tenant_id}-${tsCompact}-${String(package_id_seq).padStart(4, '0')}`;

  // Estimate canonical-encoding size — JSON serialised events.
  const size_bytes = Buffer.byteLength(JSON.stringify(events), 'utf8');

  return {
    package_id,
    tenant_id,
    generated_at: now.toISOString(),
    generated_by,
    filters,
    event_count: events.length,
    events,
    integrity,
    size_bytes,
  };
}

// ─── Retention store ───────────────────────────────────────────────────

export interface EvidencePackageStore {
  create(
    tenant_id: string,
    audit: AuditTrailStore,
    generated_by: string,
    filters: EvidenceFilters,
    now: Date,
  ): EvidencePackage;
  list(tenant_id: string, page: number, page_size: number): EvidencePackageList;
  get(tenant_id: string, package_id: string): EvidencePackage | null;
}

/**
 * In-memory per-tenant capped store. Cap = 100 packages/tenant —
 * older entries are evicted oldest-first on overflow. Production
 * swap = S3 + DynamoDB metadata.
 */
export class InMemoryEvidencePackageStore implements EvidencePackageStore {
  private readonly perTenant = new Map<string, EvidencePackage[]>();
  private readonly seqs = new Map<string, number>();
  private readonly cap: number;

  constructor(opts: { cap?: number } = {}) {
    this.cap = opts.cap ?? 100;
  }

  create(
    tenant_id: string,
    audit: AuditTrailStore,
    generated_by: string,
    filters: EvidenceFilters,
    now: Date,
  ): EvidencePackage {
    const seq = (this.seqs.get(tenant_id) ?? 0) + 1;
    this.seqs.set(tenant_id, seq);
    const pkg = buildEvidencePackage(audit, tenant_id, filters, generated_by, now, seq);
    let arr = this.perTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.perTenant.set(tenant_id, arr);
    }
    arr.push(pkg);
    if (arr.length > this.cap) {
      arr.splice(0, arr.length - this.cap);
    }
    return pkg;
  }

  list(tenant_id: string, page: number, page_size: number): EvidencePackageList {
    const arr = this.perTenant.get(tenant_id) ?? [];
    const p = Math.max(1, page);
    const ps = Math.max(1, Math.min(50, page_size));
    // newest-first
    const sorted = [...arr].reverse();
    const start = (p - 1) * ps;
    const items = sorted.slice(start, start + ps);
    return { items, total: arr.length, page: p, page_size: ps };
  }

  get(tenant_id: string, package_id: string): EvidencePackage | null {
    const arr = this.perTenant.get(tenant_id) ?? [];
    return arr.find((p) => p.package_id === package_id) ?? null;
  }
}

export const defaultEvidencePackageStore: EvidencePackageStore = new InMemoryEvidencePackageStore();
