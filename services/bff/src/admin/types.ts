// services/bff/src/admin/types.ts
//
// Domain types for the User Access Override feature
// (BAC §3.1.6 + §3.1.7). Pure types — no IO. The store + routes
// + resolver all import from this file so Jest tests can run
// without bringing up Postgres.

export type OverrideType = 'GRANT' | 'REVOKE';
export type PermissionType = 'VIEW' | 'EDIT' | 'APPROVE' | 'FULL';
export type OverrideStatus =
  | 'PENDING_APPROVAL'
  | 'ACTIVE'
  | 'REJECTED'
  | 'REVOKED'
  | 'EXPIRED';

/**
 * Server-side allowlist of module paths a user may have an override on.
 * Mirrors the SPA's route table; deliberately conservative — adding a
 * new module here is a one-line change but blocks accidental typos
 * and silly XSS attempts in the path field.
 */
export const MODULE_PATH_ALLOWLIST = [
  'dashboard',
  'alerts',
  'alerts.detail',
  'customers',
  'customers.detail',
  'rules',
  'rules.detail',
  'rules.builder',
  'rules.ews',
  'cases',
  'cases.detail',
  'cases.cms',
  'cases.cms.detail',
  'scenarios',
  'scenarios.detail',
  'reports',
  'reports.snapshot',
  'reports.alerts',
  'reports.cases',
  'reports.rbi',
  'integrations.health',
  'admin.users',
  'admin.audit-log',
  'admin.integrations',
  'admin.webhooks',
  'admin.tenants',
  'admin.user-access-override',
  'profile.sessions',
  'profile.activity',
] as const;

export type ModulePath = (typeof MODULE_PATH_ALLOWLIST)[number];

const MODULE_PATH_SET = new Set<string>(MODULE_PATH_ALLOWLIST);

export function isModulePath(s: unknown): s is ModulePath {
  return typeof s === 'string' && MODULE_PATH_SET.has(s);
}

export function isPermissionType(s: unknown): s is PermissionType {
  return s === 'VIEW' || s === 'EDIT' || s === 'APPROVE' || s === 'FULL';
}

export function isOverrideType(s: unknown): s is OverrideType {
  return s === 'GRANT' || s === 'REVOKE';
}

export function isOverrideStatus(s: unknown): s is OverrideStatus {
  return (
    s === 'PENDING_APPROVAL' ||
    s === 'ACTIVE' ||
    s === 'REJECTED' ||
    s === 'REVOKED' ||
    s === 'EXPIRED'
  );
}

/**
 * Wire shape of one override row — mirrors the
 * app_admin.user_access_override table 1:1.
 */
export interface UserAccessOverride {
  override_id: string;
  tenant_id: string;
  user_id: string;
  module_path: ModulePath;
  override_type: OverrideType;
  permission_type: PermissionType;
  effective_from: string; // ISO 8601
  effective_till: string | null;
  reason: string;
  requires_approval: boolean;
  status: OverrideStatus;
  created_by: string;
  approved_by: string | null;
  rejected_by: string | null;
  revoked_by: string | null;
  rejection_reason: string | null;
  revocation_reason: string | null;
  approval_note: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  revoked_at: string | null;
}

/**
 * Input for POST /v1/admin/user-access-overrides — accepts a list of
 * module_paths so the SPA's multi-select tree maps to one POST.
 * The store fans this out to N rows (one per path).
 */
export interface CreateOverrideInput {
  user_id: string;
  module_paths: ModulePath[];
  override_type: OverrideType;
  permission_type: PermissionType;
  effective_from: string;
  effective_till: string | null;
  reason: string;
  requires_approval: boolean;
}

/** Patch payload for PUT — only PENDING_APPROVAL rows are mutable. */
export interface UpdateOverrideInput {
  module_paths?: ModulePath[];
  override_type?: OverrideType;
  permission_type?: PermissionType;
  effective_from?: string;
  effective_till?: string | null;
  reason?: string;
}

/** Effective access for one user — returned by the resolver. */
export interface EffectiveAccessRow {
  module_path: ModulePath;
  permissions: PermissionType[];
  /** 'role' | 'override:<id>' — the audit chain for who/what granted it. */
  source: string;
}

export interface EffectiveAccess {
  user_id: string;
  computed_at: string;
  role_access: { roles: string[]; modules: EffectiveAccessRow[] };
  overrides_applied: UserAccessOverride[];
  effective: EffectiveAccessRow[];
}

/** Filter set for GET /v1/admin/user-access-overrides. */
export interface ListOverridesFilter {
  user_id?: string;
  status?: OverrideStatus[];
  module_path?: ModulePath;
  created_from?: string;
  created_to?: string;
  page?: number;
  page_size?: number;
}

export interface ListOverridesResult {
  items: UserAccessOverride[];
  total: number;
  page: number;
  page_size: number;
}

/** Audit-log row — mirrors app_admin.admin_audit_log. */
export interface AdminAuditLogRow {
  audit_id: string;
  tenant_id: string;
  entity_type: 'user_access_override';
  entity_id: string;
  action: 'create' | 'update' | 'approve' | 'reject' | 'revoke' | 'expire';
  actor_id: string;
  actor_role: string;
  before_state: unknown | null;
  after_state: unknown | null;
  reason: string | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

// ── Validation helpers (pure, no IO) ────────────────────────────────

/**
 * Validate a CreateOverrideInput. Returns the normalised input on
 * success or throws a {status, message, code} error.
 */
export function validateCreateOverride(
  raw: unknown,
  now: Date = new Date(),
): CreateOverrideInput {
  if (!raw || typeof raw !== 'object') {
    throw httpError(400, 'EWS_400_invalid_input', 'request body is required');
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.user_id !== 'string' || !r.user_id.trim()) {
    throw httpError(400, 'EWS_400_invalid_input', 'user_id is required');
  }
  if (!Array.isArray(r.module_paths) || r.module_paths.length === 0) {
    throw httpError(400, 'EWS_400_invalid_input', 'module_paths must be a non-empty array');
  }
  for (const p of r.module_paths) {
    if (!isModulePath(p)) {
      throw httpError(
        400,
        'EWS_400_invalid_input',
        `module_path "${String(p)}" is not allowed`,
      );
    }
  }
  if (!isOverrideType(r.override_type)) {
    throw httpError(400, 'EWS_400_invalid_input', 'override_type must be GRANT or REVOKE');
  }
  if (!isPermissionType(r.permission_type)) {
    throw httpError(400, 'EWS_400_invalid_input', 'permission_type must be VIEW, EDIT, APPROVE, or FULL');
  }
  if (typeof r.effective_from !== 'string') {
    throw httpError(400, 'EWS_400_invalid_input', 'effective_from is required (ISO 8601)');
  }
  const fromMs = Date.parse(r.effective_from);
  if (!Number.isFinite(fromMs)) {
    throw httpError(400, 'EWS_400_invalid_input', 'effective_from is not a valid ISO 8601 timestamp');
  }
  // Allow up to 5 minutes of clock skew on past values.
  if (fromMs < now.getTime() - 5 * 60 * 1000) {
    throw httpError(400, 'EWS_400_invalid_input', 'effective_from cannot be more than 5 minutes in the past');
  }
  let till: string | null = null;
  if (r.effective_till !== null && r.effective_till !== undefined) {
    if (typeof r.effective_till !== 'string') {
      throw httpError(400, 'EWS_400_invalid_input', 'effective_till must be ISO 8601 string or null');
    }
    const tillMs = Date.parse(r.effective_till);
    if (!Number.isFinite(tillMs)) {
      throw httpError(400, 'EWS_400_invalid_input', 'effective_till is not a valid ISO 8601 timestamp');
    }
    if (tillMs <= fromMs) {
      throw httpError(400, 'EWS_400_invalid_input', 'effective_till must be after effective_from');
    }
    if (tillMs <= now.getTime()) {
      throw httpError(400, 'EWS_400_invalid_input', 'effective_till cannot be in the past');
    }
    till = r.effective_till;
  }
  if (typeof r.reason !== 'string' || r.reason.trim().length < 10) {
    throw httpError(400, 'EWS_400_invalid_input', 'reason is required (≥ 10 chars)');
  }
  const requiresApproval = r.requires_approval === false ? false : true; // default true

  return {
    user_id: r.user_id.trim(),
    module_paths: r.module_paths as ModulePath[],
    override_type: r.override_type,
    permission_type: r.permission_type,
    effective_from: r.effective_from,
    effective_till: till,
    reason: r.reason.trim(),
    requires_approval: requiresApproval,
  };
}

/** App-level error shape that routes wrap into the EWS envelope. */
export class OverrideError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OverrideError';
  }
}

function httpError(status: number, code: string, message: string): OverrideError {
  return new OverrideError(status, code, message);
}
