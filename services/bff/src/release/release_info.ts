// services/bff/src/release/release_info.ts
//
// PHASE E.2 — Version & Release Management surface (PDF §A10
// Configuration Control). Closes the "no read-only release/version
// SPA" gap from the gap analysis.
//
// Two surfaces:
//   1. resolveReleaseInfo() — pure resolver that reads release
//      metadata from env vars (set at container-build time by CI)
//      and falls back to safe defaults. Exposes git SHA, build
//      timestamp, version label, environment, and the deploy
//      cadence target from BOOTSTRAP.md.
//   2. PER-TENANT release-history ledger — admins record each tenant
//      promotion (which version landed, when, by whom, with what
//      release notes). Drives the SPA's "Release history" page +
//      surfaces the regulator-friendly trace of when each tenant
//      moved between versions.
//
// Architecture choices (per execution rules):
//   - Additive only — no impact on any existing runtime module.
//   - Pure-data resolver + in-memory ledger; pg-backed swap is a
//     future ticket via the IReleaseHistoryStore interface.
//   - Closed enum of environments + release statuses for stable SPA
//     filtering.
//   - Per-tenant rows carry full audit fields + soft-delete.
//   - RBAC: audit:read admin-only.

export const ALL_RELEASE_ENVIRONMENTS = [
  'development',
  'sandbox',
  'staging',
  'production',
] as const;
export type ReleaseEnvironment = (typeof ALL_RELEASE_ENVIRONMENTS)[number];

export function isReleaseEnvironment(v: unknown): v is ReleaseEnvironment {
  return (
    typeof v === 'string' &&
    (ALL_RELEASE_ENVIRONMENTS as readonly string[]).includes(v)
  );
}

export const ALL_RELEASE_STATUSES = [
  /** Tracked in the source repo; not yet built. */
  'planned',
  /** Image built + ready for promotion. */
  'built',
  /** Deployed to the target environment. */
  'deployed',
  /** Rolled back after deploy. */
  'rolled_back',
] as const;
export type ReleaseStatus = (typeof ALL_RELEASE_STATUSES)[number];

export function isReleaseStatus(v: unknown): v is ReleaseStatus {
  return (
    typeof v === 'string' &&
    (ALL_RELEASE_STATUSES as readonly string[]).includes(v)
  );
}

/** Current release info — what's running right now. */
export interface ReleaseInfo {
  /** Semantic version label — e.g. "1.4.0" or "1.4.0-rc.2". */
  version: string;
  /** Short git SHA (8-12 chars typical) at build time. */
  git_sha: string;
  /** Full git SHA when the build set it; otherwise same as git_sha. */
  git_sha_full: string;
  /** Active git branch at build time (typically `main`). */
  git_branch: string;
  /** ISO timestamp of the container build. */
  built_at: string;
  /** Active environment string — drives the SPA badge colour. */
  environment: ReleaseEnvironment;
  /** Service name (BFF / auth-svc / cases-svc etc.). */
  service_name: string;
  /** Node.js + library versions for diagnostics. */
  runtime: {
    node_version: string;
    platform: NodeJS.Platform;
  };
}

const DEFAULT_VERSION = '0.0.0-dev';
const DEFAULT_SHA = 'unknown';

/** Pure resolver. Reads release metadata from process.env; injects
 *  a lazy `now` for deterministic tests. */
export function resolveReleaseInfo(
  envSource: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): ReleaseInfo {
  const version = (envSource.APEX_VERSION ?? DEFAULT_VERSION).trim();
  const fullSha = (envSource.APEX_GIT_SHA ?? DEFAULT_SHA).trim();
  const branch = (envSource.APEX_GIT_BRANCH ?? 'main').trim();
  const builtRaw = envSource.APEX_BUILT_AT;
  // CI is responsible for setting APEX_BUILT_AT; if missing fall back
  // to `now()` so the SPA at least shows a coherent timestamp.
  const built_at = builtRaw && builtRaw.trim().length > 0 ? builtRaw : now().toISOString();
  const env = envSource.APEX_ENVIRONMENT;
  const environment: ReleaseEnvironment = isReleaseEnvironment(env) ? env : 'development';
  const service_name = (envSource.APEX_SERVICE_NAME ?? 'bff').trim();
  return {
    version,
    git_sha: fullSha.length > 12 ? fullSha.slice(0, 12) : fullSha,
    git_sha_full: fullSha,
    git_branch: branch,
    built_at,
    environment,
    service_name,
    runtime: {
      node_version: process.version,
      platform: process.platform,
    },
  };
}

// ── Per-tenant release-history ledger ─────────────────────────────────

export interface ReleaseHistoryEntry {
  release_id: string;
  tenant_id: string;
  version: string;
  git_sha: string;
  environment: ReleaseEnvironment;
  status: ReleaseStatus;
  released_at: string;
  released_by: string;
  release_notes: string | null;
  rollback_of: string | null;
  jira_keys: string[];
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface ReleaseHistoryCreateInput {
  release_id: string;
  version: string;
  git_sha: string;
  environment: ReleaseEnvironment;
  status: ReleaseStatus;
  released_at: string;
  released_by: string;
  release_notes?: string | null;
  rollback_of?: string | null;
  jira_keys?: string[];
}

export interface ReleaseHistoryUpdateInput {
  version?: string;
  git_sha?: string;
  environment?: ReleaseEnvironment;
  status?: ReleaseStatus;
  released_at?: string;
  released_by?: string;
  release_notes?: string | null;
  rollback_of?: string | null;
  jira_keys?: string[];
}

export class ReleaseHistoryError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_release_id'
      | 'invalid_version'
      | 'invalid_git_sha'
      | 'invalid_environment'
      | 'invalid_status'
      | 'invalid_released_at'
      | 'invalid_released_by'
      | 'invalid_notes'
      | 'invalid_rollback_ref'
      | 'invalid_jira_keys'
      | 'unknown_release'
      | 'duplicate_release_id'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ReleaseHistoryError';
  }
}

export const RELEASE_HISTORY_CAP_PER_TENANT = 500;
const RELEASE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const VERSION_RE = /^[\w.+-]{1,40}$/;
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

function validateJiraKeys(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new ReleaseHistoryError('invalid_jira_keys', 'jira_keys must be an array');
  }
  if (v.length > 50) {
    throw new ReleaseHistoryError(
      'invalid_jira_keys',
      'jira_keys can contain at most 50 entries',
    );
  }
  const out: string[] = [];
  for (const k of v) {
    if (typeof k !== 'string' || !JIRA_KEY_RE.test(k)) {
      throw new ReleaseHistoryError(
        'invalid_jira_keys',
        'each jira_key must match ^[A-Z][A-Z0-9]*-\\d+$',
      );
    }
    out.push(k);
  }
  return out;
}

function validateCreate(input: ReleaseHistoryCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new ReleaseHistoryError('invalid_input', 'request body must be an object');
  }
  if (typeof input.release_id !== 'string' || !RELEASE_ID_RE.test(input.release_id)) {
    throw new ReleaseHistoryError(
      'invalid_release_id',
      'release_id must match ^[a-z][a-z0-9_-]{1,63}$',
    );
  }
  if (typeof input.version !== 'string' || !VERSION_RE.test(input.version)) {
    throw new ReleaseHistoryError(
      'invalid_version',
      'version must be 1..40 chars matching ^[\\w.+-]+$',
    );
  }
  if (typeof input.git_sha !== 'string' || !GIT_SHA_RE.test(input.git_sha)) {
    throw new ReleaseHistoryError(
      'invalid_git_sha',
      'git_sha must be a 7..40-char hex string',
    );
  }
  if (!isReleaseEnvironment(input.environment)) {
    throw new ReleaseHistoryError(
      'invalid_environment',
      `environment must be one of: ${ALL_RELEASE_ENVIRONMENTS.join(', ')}`,
    );
  }
  if (!isReleaseStatus(input.status)) {
    throw new ReleaseHistoryError(
      'invalid_status',
      `status must be one of: ${ALL_RELEASE_STATUSES.join(', ')}`,
    );
  }
  if (typeof input.released_at !== 'string' || !ISO_DT_RE.test(input.released_at)) {
    throw new ReleaseHistoryError(
      'invalid_released_at',
      'released_at must be an ISO-8601 datetime',
    );
  }
  if (
    typeof input.released_by !== 'string' ||
    input.released_by.trim().length === 0 ||
    input.released_by.length > 120
  ) {
    throw new ReleaseHistoryError(
      'invalid_released_by',
      'released_by must be 1..120 chars after trim',
    );
  }
  if (input.release_notes !== undefined && input.release_notes !== null) {
    if (typeof input.release_notes !== 'string' || input.release_notes.length > 8000) {
      throw new ReleaseHistoryError(
        'invalid_notes',
        'release_notes must be a string ≤ 8000 chars (or null)',
      );
    }
  }
  if (input.rollback_of !== undefined && input.rollback_of !== null) {
    if (typeof input.rollback_of !== 'string' || !RELEASE_ID_RE.test(input.rollback_of)) {
      throw new ReleaseHistoryError(
        'invalid_rollback_ref',
        'rollback_of must reference a release_id matching the same format (or null)',
      );
    }
    // status === 'rolled_back' MUST have a rollback_of reference;
    // other statuses MUST NOT.
    if (input.status !== 'rolled_back') {
      throw new ReleaseHistoryError(
        'invalid_rollback_ref',
        'rollback_of must only be set when status=rolled_back',
      );
    }
  } else if (input.status === 'rolled_back') {
    throw new ReleaseHistoryError(
      'invalid_rollback_ref',
      'status=rolled_back requires a rollback_of reference',
    );
  }
  if (input.jira_keys !== undefined) validateJiraKeys(input.jira_keys);
}

function validateUpdate(patch: ReleaseHistoryUpdateInput): void {
  if (!patch || typeof patch !== 'object') {
    throw new ReleaseHistoryError('invalid_input', 'patch must be an object');
  }
  if (patch.version !== undefined && (typeof patch.version !== 'string' || !VERSION_RE.test(patch.version))) {
    throw new ReleaseHistoryError('invalid_version', 'version invalid');
  }
  if (patch.git_sha !== undefined && (typeof patch.git_sha !== 'string' || !GIT_SHA_RE.test(patch.git_sha))) {
    throw new ReleaseHistoryError('invalid_git_sha', 'git_sha invalid');
  }
  if (patch.environment !== undefined && !isReleaseEnvironment(patch.environment)) {
    throw new ReleaseHistoryError('invalid_environment', 'environment invalid');
  }
  if (patch.status !== undefined && !isReleaseStatus(patch.status)) {
    throw new ReleaseHistoryError('invalid_status', 'status invalid');
  }
  if (patch.released_at !== undefined && (typeof patch.released_at !== 'string' || !ISO_DT_RE.test(patch.released_at))) {
    throw new ReleaseHistoryError('invalid_released_at', 'released_at must be ISO-8601');
  }
  if (patch.released_by !== undefined) {
    if (
      typeof patch.released_by !== 'string' ||
      patch.released_by.trim().length === 0 ||
      patch.released_by.length > 120
    ) {
      throw new ReleaseHistoryError('invalid_released_by', 'released_by 1..120 chars');
    }
  }
  if (patch.release_notes !== undefined && patch.release_notes !== null) {
    if (typeof patch.release_notes !== 'string' || patch.release_notes.length > 8000) {
      throw new ReleaseHistoryError('invalid_notes', 'release_notes ≤ 8000 chars');
    }
  }
  if (patch.rollback_of !== undefined && patch.rollback_of !== null) {
    if (typeof patch.rollback_of !== 'string' || !RELEASE_ID_RE.test(patch.rollback_of)) {
      throw new ReleaseHistoryError('invalid_rollback_ref', 'rollback_of invalid');
    }
  }
  if (patch.jira_keys !== undefined) validateJiraKeys(patch.jira_keys);
}

export interface ReleaseHistoryStore {
  list(
    tenant_id: string,
    opts?: { environment?: ReleaseEnvironment; include_deleted?: boolean },
  ): ReleaseHistoryEntry[];
  get(tenant_id: string, release_id: string): ReleaseHistoryEntry | null;
  create(
    tenant_id: string,
    input: ReleaseHistoryCreateInput,
    actor: string,
    now: Date,
  ): ReleaseHistoryEntry;
  update(
    tenant_id: string,
    release_id: string,
    patch: ReleaseHistoryUpdateInput,
    actor: string,
    now: Date,
  ): ReleaseHistoryEntry;
  softDelete(
    tenant_id: string,
    release_id: string,
    actor: string,
    now: Date,
  ): ReleaseHistoryEntry;
  restore(payload: ReleaseHistoryEntry): boolean;
  /** Convenience lookup: the newest released_at entry with status='deployed'
   *  for the given environment. Drives the SPA's "Currently deployed"
   *  panel. */
  resolveCurrent(
    tenant_id: string,
    environment: ReleaseEnvironment,
  ): ReleaseHistoryEntry | null;
}

export class InMemoryReleaseHistoryStore implements ReleaseHistoryStore {
  private byTenant = new Map<string, Map<string, ReleaseHistoryEntry>>();

  private bucket(tenant_id: string): Map<string, ReleaseHistoryEntry> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: { environment?: ReleaseEnvironment; include_deleted?: boolean } = {},
  ): ReleaseHistoryEntry[] {
    const out: ReleaseHistoryEntry[] = [];
    const b = this.byTenant.get(tenant_id);
    if (!b) return out;
    for (const r of b.values()) {
      if (!opts.include_deleted && r.deleted_at) continue;
      if (opts.environment !== undefined && r.environment !== opts.environment) continue;
      out.push({ ...r, jira_keys: [...r.jira_keys] });
    }
    // Newest-first by released_at, then release_id desc as a stable
    // tiebreaker.
    out.sort((a, b) => {
      if (a.released_at !== b.released_at) {
        return b.released_at.localeCompare(a.released_at);
      }
      return b.release_id.localeCompare(a.release_id);
    });
    return out;
  }

  get(tenant_id: string, release_id: string): ReleaseHistoryEntry | null {
    const r = this.byTenant.get(tenant_id)?.get(release_id);
    if (!r || r.deleted_at) return null;
    return { ...r, jira_keys: [...r.jira_keys] };
  }

  resolveCurrent(
    tenant_id: string,
    environment: ReleaseEnvironment,
  ): ReleaseHistoryEntry | null {
    const items = this.list(tenant_id, { environment }).filter(
      (r) => r.status === 'deployed',
    );
    return items[0] ?? null;
  }

  create(
    tenant_id: string,
    input: ReleaseHistoryCreateInput,
    actor: string,
    now: Date,
  ): ReleaseHistoryEntry {
    validateCreate(input);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new ReleaseHistoryError('invalid_input', 'actor (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.release_id);
    if (existing && !existing.deleted_at) {
      throw new ReleaseHistoryError(
        'duplicate_release_id',
        `release_id ${input.release_id} already exists`,
        { release_id: input.release_id },
      );
    }
    const live = [...b.values()].filter((r) => !r.deleted_at).length;
    if (live >= RELEASE_HISTORY_CAP_PER_TENANT) {
      throw new ReleaseHistoryError(
        'cap_reached',
        `release history cap (${RELEASE_HISTORY_CAP_PER_TENANT}) reached`,
      );
    }
    const ts = now.toISOString();
    const entry: ReleaseHistoryEntry = {
      release_id: input.release_id,
      tenant_id,
      version: input.version,
      git_sha: input.git_sha,
      environment: input.environment,
      status: input.status,
      released_at: input.released_at,
      released_by: input.released_by.trim(),
      release_notes: input.release_notes?.trim() || null,
      rollback_of: input.rollback_of ?? null,
      jira_keys: validateJiraKeys(input.jira_keys),
      created_at: ts,
      created_by: actor,
      updated_at: ts,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.release_id, entry);
    return { ...entry, jira_keys: [...entry.jira_keys] };
  }

  update(
    tenant_id: string,
    release_id: string,
    patch: ReleaseHistoryUpdateInput,
    actor: string,
    now: Date,
  ): ReleaseHistoryEntry {
    validateUpdate(patch);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new ReleaseHistoryError('invalid_input', 'actor (updated_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(release_id);
    if (!cur || cur.deleted_at) {
      throw new ReleaseHistoryError('unknown_release', `release ${release_id} not found`);
    }
    const merged: ReleaseHistoryEntry = {
      ...cur,
      version: patch.version ?? cur.version,
      git_sha: patch.git_sha ?? cur.git_sha,
      environment: patch.environment ?? cur.environment,
      status: patch.status ?? cur.status,
      released_at: patch.released_at ?? cur.released_at,
      released_by:
        patch.released_by !== undefined ? patch.released_by.trim() : cur.released_by,
      release_notes:
        patch.release_notes !== undefined
          ? patch.release_notes?.trim() || null
          : cur.release_notes,
      rollback_of:
        patch.rollback_of !== undefined ? patch.rollback_of : cur.rollback_of,
      jira_keys:
        patch.jira_keys !== undefined ? validateJiraKeys(patch.jira_keys) : [...cur.jira_keys],
      updated_at: now.toISOString(),
      updated_by: actor,
    };
    // Cross-field invariant on the merged result.
    if (merged.status === 'rolled_back' && !merged.rollback_of) {
      throw new ReleaseHistoryError(
        'invalid_rollback_ref',
        'status=rolled_back requires a rollback_of reference',
      );
    }
    if (merged.status !== 'rolled_back' && merged.rollback_of) {
      throw new ReleaseHistoryError(
        'invalid_rollback_ref',
        'rollback_of must only be set when status=rolled_back',
      );
    }
    b.set(release_id, merged);
    return { ...merged, jira_keys: [...merged.jira_keys] };
  }

  softDelete(
    tenant_id: string,
    release_id: string,
    actor: string,
    now: Date,
  ): ReleaseHistoryEntry {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new ReleaseHistoryError('invalid_input', 'actor (deleted_by) required');
    }
    const b = this.bucket(tenant_id);
    const cur = b.get(release_id);
    if (!cur || cur.deleted_at) {
      throw new ReleaseHistoryError('unknown_release', `release ${release_id} not found`);
    }
    const ts = now.toISOString();
    const tombstoned: ReleaseHistoryEntry = {
      ...cur,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(release_id, tombstoned);
    return { ...tombstoned, jira_keys: [...tombstoned.jira_keys] };
  }

  restore(payload: ReleaseHistoryEntry): boolean {
    const b = this.bucket(payload.tenant_id);
    const cur = b.get(payload.release_id);
    if (cur && !cur.deleted_at) return false;
    const restored: ReleaseHistoryEntry = {
      ...payload,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(restored.release_id, restored);
    return true;
  }
}

export const defaultReleaseHistoryStore: ReleaseHistoryStore =
  new InMemoryReleaseHistoryStore();
