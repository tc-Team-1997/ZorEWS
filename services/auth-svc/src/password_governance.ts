// services/auth-svc/src/password_governance.ts
//
// Enterprise IAM — Feature 2: Password Governance.
//
// Per-tenant password policy + per-user expiry / force-reset / reminder
// metadata. Additive over the existing IUserStore.setPassword path; this
// store records the LIFECYCLE metadata (when did it last change, when does
// it expire, has the reminder been sent, who forced a reset), the credential
// material itself stays in app_iam.users.passwordHash via IUserStore.

export interface PasswordPolicy {
  tenant_id: string;
  min_len: number;
  require_upper: boolean;
  require_lower: boolean;
  require_digit: boolean;
  require_symbol: boolean;
  expiry_days: number;
  history_count: number;
  lockout_threshold: number;
  lockout_window_min: number;
  reminder_days_before_expiry: number;
  updated_at: string;
  updated_by: string | null;
}

export const DEFAULT_PASSWORD_POLICY: Omit<PasswordPolicy, 'tenant_id' | 'updated_at' | 'updated_by'> = {
  min_len: 12,
  require_upper: true,
  require_lower: true,
  require_digit: true,
  require_symbol: true,
  expiry_days: 90,
  history_count: 5,
  lockout_threshold: 5,
  lockout_window_min: 15,
  reminder_days_before_expiry: 7,
};

export interface UserPasswordMetadata {
  user_id: string;
  last_changed_at: string;
  expires_at: string | null;
  must_reset: boolean;
  reminder_sent_at: string | null;
  force_reset_at: string | null;
  force_reset_by: string | null;
  force_reset_reason: string | null;
  updated_at: string;
}

export interface ExpiringUser {
  user_id: string;
  expires_at: string;
  days_remaining: number;
}

export class PasswordGovernanceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'PasswordGovernanceError';
  }
}

export interface IPasswordGovernanceStore {
  getPolicy(tenant_id: string): PasswordPolicy;
  setPolicy(tenant_id: string, patch: Partial<PasswordPolicy>, actor: string, now?: Date): PasswordPolicy;
  recordPasswordChange(user_id: string, tenant_id: string, now?: Date): UserPasswordMetadata;
  forceReset(user_id: string, force_reset_by: string, reason: string | null, now?: Date): UserPasswordMetadata;
  markReminderSent(user_id: string, now?: Date): UserPasswordMetadata;
  getMetadata(user_id: string): UserPasswordMetadata | null;
  listExpiring(tenant_id: string, withinDays: number, userIdsInTenant: readonly string[], now?: Date): ExpiringUser[];
}

function validatePolicyPatch(p: Partial<PasswordPolicy>): void {
  if (p.min_len !== undefined && (p.min_len < 8 || p.min_len > 128)) {
    throw new PasswordGovernanceError('invalid_input', 'min_len must be 8..128');
  }
  if (p.expiry_days !== undefined && (p.expiry_days < 0 || p.expiry_days > 730)) {
    throw new PasswordGovernanceError('invalid_input', 'expiry_days must be 0..730');
  }
  if (p.history_count !== undefined && (p.history_count < 0 || p.history_count > 50)) {
    throw new PasswordGovernanceError('invalid_input', 'history_count must be 0..50');
  }
  if (p.lockout_threshold !== undefined && (p.lockout_threshold < 3 || p.lockout_threshold > 20)) {
    throw new PasswordGovernanceError('invalid_input', 'lockout_threshold must be 3..20');
  }
  if (p.lockout_window_min !== undefined && (p.lockout_window_min < 1 || p.lockout_window_min > 1440)) {
    throw new PasswordGovernanceError('invalid_input', 'lockout_window_min must be 1..1440');
  }
  if (p.reminder_days_before_expiry !== undefined && (p.reminder_days_before_expiry < 0 || p.reminder_days_before_expiry > 60)) {
    throw new PasswordGovernanceError('invalid_input', 'reminder_days_before_expiry must be 0..60');
  }
}

export class InMemoryPasswordGovernanceStore implements IPasswordGovernanceStore {
  private policies = new Map<string, PasswordPolicy>();
  private meta = new Map<string, UserPasswordMetadata>();

  getPolicy(tenant_id: string): PasswordPolicy {
    const existing = this.policies.get(tenant_id);
    if (existing) return { ...existing };
    return {
      tenant_id,
      ...DEFAULT_PASSWORD_POLICY,
      updated_at: '1970-01-01T00:00:00.000Z',
      updated_by: null,
    };
  }

  setPolicy(tenant_id: string, patch: Partial<PasswordPolicy>, actor: string, now: Date = new Date()): PasswordPolicy {
    if (!tenant_id?.trim()) throw new PasswordGovernanceError('invalid_input', 'tenant_id required');
    if (!actor?.trim()) throw new PasswordGovernanceError('invalid_input', 'actor required');
    validatePolicyPatch(patch);
    const base = this.getPolicy(tenant_id);
    const next: PasswordPolicy = {
      ...base,
      ...patch,
      tenant_id,
      updated_at: now.toISOString(),
      updated_by: actor,
    };
    this.policies.set(tenant_id, next);
    return { ...next };
  }

  recordPasswordChange(user_id: string, tenant_id: string, now: Date = new Date()): UserPasswordMetadata {
    if (!user_id?.trim()) throw new PasswordGovernanceError('invalid_input', 'user_id required');
    const policy = this.getPolicy(tenant_id);
    const expires = policy.expiry_days > 0
      ? new Date(now.getTime() + policy.expiry_days * 86_400_000).toISOString()
      : null;
    const m: UserPasswordMetadata = {
      user_id,
      last_changed_at: now.toISOString(),
      expires_at: expires,
      must_reset: false,
      reminder_sent_at: null,
      force_reset_at: null,
      force_reset_by: null,
      force_reset_reason: null,
      updated_at: now.toISOString(),
    };
    this.meta.set(user_id, m);
    return { ...m };
  }

  forceReset(user_id: string, force_reset_by: string, reason: string | null, now: Date = new Date()): UserPasswordMetadata {
    if (!user_id?.trim()) throw new PasswordGovernanceError('invalid_input', 'user_id required');
    if (!force_reset_by?.trim()) throw new PasswordGovernanceError('invalid_input', 'force_reset_by required');
    if (reason && reason.length > 1000) throw new PasswordGovernanceError('invalid_input', 'reason > 1000 chars');
    const existing = this.meta.get(user_id) ?? {
      user_id,
      last_changed_at: now.toISOString(),
      expires_at: null,
      must_reset: false,
      reminder_sent_at: null,
      force_reset_at: null,
      force_reset_by: null,
      force_reset_reason: null,
      updated_at: now.toISOString(),
    };
    const next: UserPasswordMetadata = {
      ...existing,
      must_reset: true,
      force_reset_at: now.toISOString(),
      force_reset_by,
      force_reset_reason: reason ?? null,
      updated_at: now.toISOString(),
    };
    this.meta.set(user_id, next);
    return { ...next };
  }

  markReminderSent(user_id: string, now: Date = new Date()): UserPasswordMetadata {
    const m = this.meta.get(user_id);
    if (!m) throw new PasswordGovernanceError('not_found', `no metadata for user_id=${user_id}`);
    const next: UserPasswordMetadata = {
      ...m,
      reminder_sent_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.meta.set(user_id, next);
    return { ...next };
  }

  getMetadata(user_id: string): UserPasswordMetadata | null {
    const m = this.meta.get(user_id);
    return m ? { ...m } : null;
  }

  listExpiring(tenant_id: string, withinDays: number, userIdsInTenant: readonly string[], now: Date = new Date()): ExpiringUser[] {
    if (withinDays < 0 || withinDays > 365) {
      throw new PasswordGovernanceError('invalid_input', 'withinDays must be 0..365');
    }
    const horizon = now.getTime() + withinDays * 86_400_000;
    const out: ExpiringUser[] = [];
    for (const uid of userIdsInTenant) {
      const m = this.meta.get(uid);
      if (!m || !m.expires_at || m.must_reset) continue;
      const exp = new Date(m.expires_at).getTime();
      if (exp <= horizon) {
        out.push({
          user_id: uid,
          expires_at: m.expires_at,
          days_remaining: Math.max(0, Math.floor((exp - now.getTime()) / 86_400_000)),
        });
      }
    }
    return out.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  }
}
