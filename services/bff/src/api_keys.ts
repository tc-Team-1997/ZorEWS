// services/bff/src/api_keys.ts
//
// T6 M1.2 — Service-account API keys.
//
// Module 1 ships M1.1 (TOTP 2FA) for human auth. M1.2 ships the
// machine identity primitive: scoped API keys for BIL compliance
// integrations + production callers (claims-svc → BFF, audit
// extractor cron, etc.) that don't have a human in the loop.
//
// Scope of THIS slice:
//  - Provision a key with a scope set (1-N from a fixed catalogue).
//  - Store only the SHA-256 hash + a 12-char prefix; return the full
//    key value ONCE on creation (the SPA must capture it then).
//  - List / get redacted view (prefix only, no secret).
//  - Revoke (irreversible status flip — key value stays hashed).
//  - Optional expires_at (must be future ISO datetime).
//  - Per-tenant cap on ACTIVE keys (default 20).
//  - Touch helper (last_used_at bump) — useful for the future
//    middleware in M1.3 and for testing.
//
// Out of scope (deferred):
//  - Authentication MIDDLEWARE that actually accepts a key in
//    `Authorization: Bearer apex_<prefix>.<secret>` and resolves
//    the caller's scopes. M1.3 will wire that.
//  - Per-key rate limiting / throttling.
//
// Design notes:
//  - Key format: `apex_<prefix>.<secret>` where prefix = 12 chars
//    (4 of which is a random suffix, leading 8 are tenant-prefix
//    so "BILapex_…" is human-distinguishable from "BANK_DEMOapex_…").
//    Actually — for prototype simplicity, prefix is just 12 random
//    alphanumeric chars. Tenant scoping is enforced server-side
//    via the tenant_id field, not the key itself.
//  - Hash = SHA-256 of the FULL key (prefix + '.' + secret), hex
//    encoded.
//  - Constant-time comparison: NodeJS's crypto.timingSafeEqual.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type ApiKeyScope =
  | 'alerts:read'
  | 'cases:read'
  | 'audit:read'
  | 'reports:read'
  | 'notifications:send'
  | 'webhooks:dispatch'
  | 'integrations:read';

export const VALID_SCOPES: readonly ApiKeyScope[] = [
  'alerts:read',
  'cases:read',
  'audit:read',
  'reports:read',
  'notifications:send',
  'webhooks:dispatch',
  'integrations:read',
] as const;

export type ApiKeyStatus = 'active' | 'revoked';

export interface ApiKeyInput {
  name: string;
  scopes: ApiKeyScope[];
  /** Optional ISO-8601 expiry — must be strictly in the future. */
  expires_at?: string;
}

/** Internal record — never returned to API callers. Holds the hash. */
interface ApiKeyRecord {
  key_id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: ApiKeyScope[];
  status: ApiKeyStatus;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** Redacted view returned from list/get — no hash, no secret. */
export interface ApiKeyEntry {
  key_id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  status: ApiKeyStatus;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** Returned ONLY from create — carries the full secret value once. */
export interface ApiKeyCreated extends ApiKeyEntry {
  /** Full key value: `apex_<prefix>.<secret>`. Show this to the
   *  operator ONCE; subsequent lookups will not return it. */
  key: string;
}

export interface ApiKeyPage {
  items: ApiKeyEntry[];
  total: number;
  page: number;
  page_size: number;
}

export class ApiKeyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

// ─── Hashing + key generation ─────────────────────────────────────────

const PREFIX_LEN = 12;
const SECRET_BYTES = 24; // 192 bits → 32 chars hex

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomPrefix(): string {
  // 12 chars from a 36-char alphabet — plenty for visual disambiguation.
  const bytes = randomBytes(PREFIX_LEN);
  let out = '';
  for (let i = 0; i < PREFIX_LEN; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

function hashKey(fullKey: string): string {
  return createHash('sha256').update(fullKey).digest('hex');
}

/** Constant-time compare wrapped against length mismatches. */
export function compareKey(presented: string, stored_hash: string): boolean {
  const presentedHash = hashKey(presented);
  const a = Buffer.from(presentedHash, 'hex');
  const b = Buffer.from(stored_hash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Validation ────────────────────────────────────────────────────────

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function isApiKeyScope(s: unknown): s is ApiKeyScope {
  return typeof s === 'string' && VALID_SCOPES.includes(s as ApiKeyScope);
}

export function validateInput(input: unknown, now: Date): ApiKeyInput {
  if (!input || typeof input !== 'object') {
    throw new ApiKeyError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new ApiKeyError('invalid_input', 'name is required');
  }
  if (i.name.length > 80) {
    throw new ApiKeyError('invalid_input', 'name ≤ 80 chars');
  }
  if (!Array.isArray(i.scopes) || i.scopes.length === 0) {
    throw new ApiKeyError('invalid_scopes', 'scopes[] must contain at least 1');
  }
  if (i.scopes.length > VALID_SCOPES.length) {
    throw new ApiKeyError('invalid_scopes', `at most ${VALID_SCOPES.length} scopes`);
  }
  const seen = new Set<string>();
  const scopes: ApiKeyScope[] = [];
  for (const s of i.scopes) {
    if (!isApiKeyScope(s)) {
      throw new ApiKeyError('invalid_scopes', `'${String(s)}' is not a valid scope`);
    }
    if (seen.has(s)) continue; // dedupe silently
    seen.add(s);
    scopes.push(s);
  }
  let expires_at: string | undefined;
  if (i.expires_at !== undefined && i.expires_at !== null) {
    if (typeof i.expires_at !== 'string' || !ISO_DATETIME_RE.test(i.expires_at)) {
      throw new ApiKeyError('invalid_expires_at', 'expires_at must be ISO-8601 datetime');
    }
    const d = new Date(i.expires_at);
    if (Number.isNaN(d.getTime())) {
      throw new ApiKeyError('invalid_expires_at', 'expires_at could not be parsed');
    }
    if (d.getTime() <= now.getTime()) {
      throw new ApiKeyError('invalid_expires_at', 'expires_at must be in the future');
    }
    expires_at = i.expires_at;
  }
  return { name: i.name.trim(), scopes, expires_at };
}

// ─── Store ─────────────────────────────────────────────────────────────

export interface ApiKeyStore {
  create(
    tenant_id: string,
    input: ApiKeyInput,
    created_by: string,
    now: Date,
  ): ApiKeyCreated;
  list(tenant_id: string, page: number, page_size: number): ApiKeyPage;
  get(tenant_id: string, key_id: string): ApiKeyEntry | null;
  revoke(
    tenant_id: string,
    key_id: string,
    revoked_by: string,
    now: Date,
  ): ApiKeyEntry;
  delete(tenant_id: string, key_id: string): boolean;
  /** Bump last_used_at. Returns null if key isn't found or is revoked/expired. */
  touch(tenant_id: string, key_id: string, now: Date): ApiKeyEntry | null;
  /** Verify a presented key against the store. Pure read; no mutation.
   *  Returns the matching ACTIVE non-expired record, else null. */
  verify(presented: string, now: Date): { tenant_id: string; entry: ApiKeyEntry } | null;
}

function redact(rec: ApiKeyRecord): ApiKeyEntry {
  const { hash: _h, ...rest } = rec;
  return { ...rest, scopes: [...rest.scopes] };
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  /** tenant_id → key_id → record. */
  private readonly perTenant = new Map<string, Map<string, ApiKeyRecord>>();
  /** prefix → tenant_id (for quick verify lookup). */
  private readonly byPrefix = new Map<string, string>();
  private readonly cap: number;

  constructor(opts: { cap?: number } = {}) {
    this.cap = opts.cap ?? 20;
  }

  private bucket(tenant_id: string): Map<string, ApiKeyRecord> {
    let m = this.perTenant.get(tenant_id);
    if (!m) {
      m = new Map();
      this.perTenant.set(tenant_id, m);
    }
    return m;
  }

  private countActive(tenant_id: string): number {
    const bucket = this.perTenant.get(tenant_id);
    if (!bucket) return 0;
    let n = 0;
    for (const r of bucket.values()) {
      if (r.status === 'active') n++;
    }
    return n;
  }

  create(
    tenant_id: string,
    input: ApiKeyInput,
    created_by: string,
    now: Date,
  ): ApiKeyCreated {
    if (!created_by || typeof created_by !== 'string' || !created_by.trim()) {
      throw new ApiKeyError('invalid_input', 'created_by required');
    }
    if (this.countActive(tenant_id) >= this.cap) {
      throw new ApiKeyError(
        'cap_reached',
        `tenant ${tenant_id} already has ${this.cap} active API keys — revoke or delete one first`,
      );
    }
    const prefix = randomPrefix();
    const secret = randomBytes(SECRET_BYTES).toString('hex');
    const fullKey = `apex_${prefix}.${secret}`;
    const hash = hashKey(fullKey);
    const rec: ApiKeyRecord = {
      key_id: `key-${randomBytes(8).toString('hex')}`,
      tenant_id,
      name: input.name,
      prefix,
      hash,
      scopes: [...input.scopes],
      status: 'active',
      created_by: created_by.trim(),
      created_at: now.toISOString(),
      expires_at: input.expires_at ?? null,
      last_used_at: null,
      revoked_at: null,
      revoked_by: null,
    };
    this.bucket(tenant_id).set(rec.key_id, rec);
    this.byPrefix.set(prefix, tenant_id);
    return { ...redact(rec), key: fullKey };
  }

  list(tenant_id: string, page: number, page_size: number): ApiKeyPage {
    const bucket = this.perTenant.get(tenant_id) ?? new Map<string, ApiKeyRecord>();
    const arr = [...bucket.values()].sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
    const p = Math.max(1, page);
    const ps = Math.max(1, Math.min(100, page_size));
    const start = (p - 1) * ps;
    const items = arr.slice(start, start + ps).map(redact);
    return { items, total: arr.length, page: p, page_size: ps };
  }

  get(tenant_id: string, key_id: string): ApiKeyEntry | null {
    const r = this.perTenant.get(tenant_id)?.get(key_id);
    return r ? redact(r) : null;
  }

  revoke(
    tenant_id: string,
    key_id: string,
    revoked_by: string,
    now: Date,
  ): ApiKeyEntry {
    if (!revoked_by || typeof revoked_by !== 'string' || !revoked_by.trim()) {
      throw new ApiKeyError('invalid_input', 'revoked_by required');
    }
    const bucket = this.bucket(tenant_id);
    const cur = bucket.get(key_id);
    if (!cur) {
      throw new ApiKeyError('unknown_key', `api key ${key_id} not found`);
    }
    if (cur.status === 'revoked') {
      throw new ApiKeyError('already_revoked', `api key ${key_id} is already revoked`);
    }
    const next: ApiKeyRecord = {
      ...cur,
      status: 'revoked',
      revoked_at: now.toISOString(),
      revoked_by: revoked_by.trim(),
    };
    bucket.set(key_id, next);
    return redact(next);
  }

  delete(tenant_id: string, key_id: string): boolean {
    const bucket = this.perTenant.get(tenant_id);
    if (!bucket) return false;
    const cur = bucket.get(key_id);
    if (!cur) return false;
    bucket.delete(key_id);
    if (this.byPrefix.get(cur.prefix) === tenant_id) {
      this.byPrefix.delete(cur.prefix);
    }
    return true;
  }

  touch(tenant_id: string, key_id: string, now: Date): ApiKeyEntry | null {
    const bucket = this.bucket(tenant_id);
    const cur = bucket.get(key_id);
    if (!cur) return null;
    if (cur.status !== 'active') return null;
    if (cur.expires_at && cur.expires_at <= now.toISOString()) return null;
    const next = { ...cur, last_used_at: now.toISOString() };
    bucket.set(key_id, next);
    return redact(next);
  }

  verify(presented: string, now: Date): { tenant_id: string; entry: ApiKeyEntry } | null {
    if (typeof presented !== 'string' || !presented.startsWith('apex_')) return null;
    const dot = presented.indexOf('.');
    if (dot < 0) return null;
    const prefix = presented.slice('apex_'.length, dot);
    const tenant_id = this.byPrefix.get(prefix);
    if (!tenant_id) return null;
    const bucket = this.perTenant.get(tenant_id);
    if (!bucket) return null;
    for (const rec of bucket.values()) {
      if (rec.prefix !== prefix) continue;
      if (rec.status !== 'active') return null;
      if (rec.expires_at && rec.expires_at <= now.toISOString()) return null;
      if (compareKey(presented, rec.hash)) {
        return { tenant_id, entry: redact(rec) };
      }
      return null;
    }
    return null;
  }
}

export const defaultApiKeyStore: ApiKeyStore = new InMemoryApiKeyStore();
