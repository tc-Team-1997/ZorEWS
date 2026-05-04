// services/bff/src/integrations/aml.ts
//
// T6 M14.3 — AML Watchlist adapter (3rd adapter in Module 14).
//
// AML (Anti-Money Laundering) screening checks customers against four
// categories of watchlist:
//   sanctions          — OFAC, UN, EU, RBI sanctions lists
//   pep                — Politically Exposed Persons
//   adverse_media      — negative news / litigation
//   internal_watchlist — bank/insurer internal flags
//
// The BIL pitch deck lists AML as one of the 11 regulatory upstreams
// (alongside CBS, IFRS9, etc). M14.3 surfaces per-customer screening
// results so the SPA can render the AML match panel and the case-
// management workflow can pivot from a hit to an investigation.
//
// Same adapter pattern as M14.1 (insurance) + M14.2 (ifrs9). Stub uses
// deterministic synthetic data; production swap = HTTP/SOAP gateway
// satisfying the AmlAdapter interface.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type AmlMatchType = 'sanctions' | 'pep' | 'adverse_media' | 'internal_watchlist';
export type AmlMatchSeverity = 'high' | 'medium' | 'low';
export type AmlMatchStatus = 'open' | 'cleared' | 'escalated' | 'false_positive';

export interface AmlMatch {
  match_id: string;
  customer_id: string;
  match_type: AmlMatchType;
  severity: AmlMatchSeverity;
  /** Watchlist source name, e.g. 'OFAC SDN', 'EU Consolidated', 'BIL Internal'. */
  list_name: string;
  /** Entry id within that list. */
  list_entry_id: string;
  /** Fuzzy-match score 0..1 (1 = exact). */
  match_score: number;
  /** Human-readable description for the SPA card. */
  description: string;
  matched_at: string;
  status: AmlMatchStatus;
  /** ISO timestamp of the most-recent status change. null when status='open'. */
  status_changed_at: string | null;
  /** Username that made the most-recent status change. null when status='open'. */
  status_changed_by: string | null;
}

export interface AmlScreeningResult {
  customer_id: string;
  screened_at: string;
  matches: AmlMatch[];
  total_matches: number;
  /** Highest severity across the matches; null when no matches. */
  highest_severity: AmlMatchSeverity | null;
  /** Whether ops should review (any high-severity OR ≥3 medium-severity). */
  requires_review: boolean;
}

export interface AmlAdapter {
  /** Screen a customer. Returns an idempotent result per (tenant,
   *  customer, day) — repeated calls within a day yield the same
   *  matches. Persists synthesised matches to the per-tenant ledger
   *  on first call so subsequent listMatches sees them. */
  screenCustomer(tenant_id: string, customer_id: string, asOf: Date): Promise<AmlScreeningResult>;
  /** All matches recorded for a customer (open + closed). */
  listMatches(tenant_id: string, customer_id: string): Promise<AmlMatch[]>;
  /** Single match by id. Tenant-scoped — null on cross-tenant lookup. */
  getMatch(tenant_id: string, match_id: string): Promise<AmlMatch | null>;
  /** Update match status with audit trail. Throws on unknown id. */
  updateMatchStatus(
    tenant_id: string,
    match_id: string,
    status: AmlMatchStatus,
    changed_by: string,
    now: Date,
  ): Promise<AmlMatch>;
}

export class AmlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AmlError';
  }
}

const VALID_STATUSES: AmlMatchStatus[] = ['open', 'cleared', 'escalated', 'false_positive'];

export function isAmlMatchStatus(s: unknown): s is AmlMatchStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as AmlMatchStatus);
}

// ─── Deterministic PRNG ────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
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
function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}
function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysBefore(d: Date, n: number): string {
  return new Date(d.getTime() - n * 86_400_000).toISOString();
}

// ─── Stub data ─────────────────────────────────────────────────────────

const SANCTIONS_LISTS = ['OFAC SDN', 'UN Consolidated', 'EU Consolidated', 'RBI Sanctions'];
const PEP_LISTS = ['Dow Jones PEP', 'World-Check PEP', 'Internal PEP Register'];
const ADVERSE_MEDIA_SOURCES = ['Reuters Adverse', 'World-Check Adverse Media', 'Local News Index'];
const INTERNAL_LISTS = ['BIL Internal Watchlist', 'BANK_DEMO Internal Watchlist'];

function listForType(type: AmlMatchType, tenant_id: string): string {
  switch (type) {
    case 'sanctions':
      return SANCTIONS_LISTS[0]!;
    case 'pep':
      return PEP_LISTS[0]!;
    case 'adverse_media':
      return ADVERSE_MEDIA_SOURCES[0]!;
    case 'internal_watchlist':
      return tenant_id === 'BIL' ? INTERNAL_LISTS[0]! : INTERNAL_LISTS[1]!;
  }
}

function severityForType(type: AmlMatchType, score: number): AmlMatchSeverity {
  if (type === 'sanctions') return score > 0.85 ? 'high' : 'medium';
  if (type === 'pep') return score > 0.9 ? 'medium' : 'low';
  if (type === 'adverse_media') return score > 0.8 ? 'medium' : 'low';
  // internal
  return score > 0.85 ? 'medium' : 'low';
}

function descriptionFor(type: AmlMatchType, list_entry_id: string, score: number): string {
  const pct = (score * 100).toFixed(0);
  switch (type) {
    case 'sanctions':
      return `Possible sanctions match (${pct}% confidence) — entry ${list_entry_id}`;
    case 'pep':
      return `Politically-exposed person (${pct}%) — registered under ${list_entry_id}`;
    case 'adverse_media':
      return `Adverse media reference (${pct}%) — see article ${list_entry_id}`;
    case 'internal_watchlist':
      return `Internal watchlist hit (${pct}%) — file ${list_entry_id}`;
  }
}

/** How many matches a customer has, deterministically. ~85% clean,
 *  ~10% one match, ~4% two matches, ~1% three matches. */
function matchCountFor(seed: number): number {
  const r = rng(seed)();
  if (r < 0.85) return 0;
  if (r < 0.95) return 1;
  if (r < 0.99) return 2;
  return 3;
}

function buildMatch(
  tenant_id: string,
  customer_id: string,
  index: number,
  asOf: Date,
): AmlMatch {
  const seed = fnv1a(`aml|${tenant_id}|${customer_id}|${index}`);
  const r = rng(seed);
  const types: AmlMatchType[] = ['sanctions', 'pep', 'adverse_media', 'internal_watchlist'];
  const match_type = pick(r, types);
  const match_score = Math.round((0.6 + r() * 0.4) * 1000) / 1000; // 0.6-1.0
  const list_entry_id = `${match_type.toUpperCase().slice(0, 3)}-${(seed % 1_000_000).toString().padStart(6, '0')}`;
  const matchedDaysAgo = Math.floor(r() * 90);
  return {
    match_id: `aml-${tenant_id.slice(0, 3).toLowerCase()}-${(seed % 10_000_000).toString().padStart(7, '0')}`,
    customer_id,
    match_type,
    severity: severityForType(match_type, match_score),
    list_name: listForType(match_type, tenant_id),
    list_entry_id,
    match_score,
    description: descriptionFor(match_type, list_entry_id, match_score),
    matched_at: daysBefore(asOf, matchedDaysAgo),
    status: 'open',
    status_changed_at: null,
    status_changed_by: null,
  };
}

function severityRank(s: AmlMatchSeverity): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

// ─── Stub adapter ──────────────────────────────────────────────────────

export class StubAmlAdapter implements AmlAdapter {
  /** tenant_id → customer_id → match_id → AmlMatch. The two-level map
   *  lets listMatches scope to a customer without scanning the whole
   *  tenant ledger. */
  private readonly byCustomer = new Map<string, Map<string, Map<string, AmlMatch>>>();
  /** Reverse index for getMatch / updateMatchStatus. */
  private readonly byMatchId = new Map<string, Map<string, AmlMatch>>();

  async screenCustomer(
    tenant_id: string,
    customer_id: string,
    asOf: Date,
  ): Promise<AmlScreeningResult> {
    if (!tenant_id || !customer_id) {
      return {
        customer_id,
        screened_at: asOf.toISOString(),
        matches: [],
        total_matches: 0,
        highest_severity: null,
        requires_review: false,
      };
    }
    const seed = fnv1a(`count|${tenant_id}|${customer_id}|${dayOf(asOf)}`);
    const n = matchCountFor(seed);

    // Persist deterministic synthesised matches the first time we
    // screen this customer so subsequent listMatches sees the same
    // ids. Returns existing persisted matches (whatever their current
    // status) on subsequent calls within the day.
    let custMap = this.byCustomer.get(tenant_id)?.get(customer_id);
    if (!custMap) {
      custMap = new Map();
      const built: AmlMatch[] = [];
      for (let i = 0; i < n; i++) {
        const m = buildMatch(tenant_id, customer_id, i, asOf);
        custMap.set(m.match_id, m);
        built.push(m);
      }
      let tMap = this.byCustomer.get(tenant_id);
      if (!tMap) {
        tMap = new Map();
        this.byCustomer.set(tenant_id, tMap);
      }
      tMap.set(customer_id, custMap);
      let idMap = this.byMatchId.get(tenant_id);
      if (!idMap) {
        idMap = new Map();
        this.byMatchId.set(tenant_id, idMap);
      }
      for (const m of built) idMap.set(m.match_id, m);
    }

    const matches = [...custMap.values()].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    );
    const open = matches.filter((m) => m.status === 'open');
    const highest_severity = matches.length === 0
      ? null
      : matches.reduce<AmlMatchSeverity>((acc, m) =>
          severityRank(m.severity) > severityRank(acc) ? m.severity : acc, 'low');
    const requires_review =
      open.some((m) => m.severity === 'high') ||
      open.filter((m) => m.severity === 'medium').length >= 3;

    return {
      customer_id,
      screened_at: asOf.toISOString(),
      matches,
      total_matches: matches.length,
      highest_severity,
      requires_review,
    };
  }

  async listMatches(tenant_id: string, customer_id: string): Promise<AmlMatch[]> {
    const m = this.byCustomer.get(tenant_id)?.get(customer_id);
    if (!m) return [];
    return [...m.values()].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    );
  }

  async getMatch(tenant_id: string, match_id: string): Promise<AmlMatch | null> {
    return this.byMatchId.get(tenant_id)?.get(match_id) ?? null;
  }

  async updateMatchStatus(
    tenant_id: string,
    match_id: string,
    status: AmlMatchStatus,
    changed_by: string,
    now: Date,
  ): Promise<AmlMatch> {
    if (!isAmlMatchStatus(status)) {
      throw new AmlError(
        'invalid_status',
        `status must be one of ${VALID_STATUSES.join(',')}`,
      );
    }
    const idMap = this.byMatchId.get(tenant_id);
    const existing = idMap?.get(match_id);
    if (!existing) {
      throw new AmlError('unknown_match', `unknown match_id: ${match_id}`);
    }
    const updated: AmlMatch = {
      ...existing,
      status,
      status_changed_at: now.toISOString(),
      status_changed_by: changed_by,
    };
    idMap!.set(match_id, updated);
    // Mirror into byCustomer.
    const custMap = this.byCustomer.get(tenant_id)?.get(existing.customer_id);
    custMap?.set(match_id, updated);
    return updated;
  }

  /** Test helper. */
  reset(): void {
    this.byCustomer.clear();
    this.byMatchId.clear();
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultAmlAdapter: AmlAdapter = new StubAmlAdapter();
