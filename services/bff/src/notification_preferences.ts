// services/bff/src/notification_preferences.ts
//
// T6 M10.5 — Channel preference per-user.
//
// M10.1-M10.4 ship the email / SMS / push / webhook channels.
// M10.5 ships per-(tenant, user) opt-in/out toggles for each of
// the 4 channels. Drives the SPA's "Notification settings"
// page — users control which channels reach them; tenant admins
// may also force a default for the tenant later (M10.6 will add
// admin override + tenant-default).
//
// Default policy: all 4 channels enabled. Stored only when the
// user has changed at least one toggle from the default.

export type Channel = 'email' | 'sms' | 'push' | 'webhook';

export const VALID_CHANNELS: readonly Channel[] = [
  'email',
  'sms',
  'push',
  'webhook',
] as const;

/** T6 M10.7 — quiet hours window. Hours are UTC 0-23.
 *  start === end means a 1-hour window starting at start_hour. */
export interface QuietHours {
  start_hour: number;
  end_hour: number;
}

export interface ChannelPreference {
  tenant_id: string;
  username: string;
  email: boolean;
  sms: boolean;
  push: boolean;
  webhook: boolean;
  /** ISO timestamp of last update — null when defaults still apply. */
  updated_at: string | null;
  /** Per-user mute window. Null = no quiet hours. Webhook bypasses
   *  (transactional/system channels). */
  quiet_hours: QuietHours | null;
}

export class PreferenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PreferenceError';
  }
}

function defaultPref(tenant_id: string, username: string): ChannelPreference {
  return {
    tenant_id,
    username,
    email: true,
    sms: true,
    push: true,
    webhook: true,
    updated_at: null,
    quiet_hours: null,
  };
}

/** Returns true iff `asOf.getUTCHours()` falls inside the quiet
 *  window. Handles wrap-around (e.g. 22→07 spans midnight). */
export function isInQuietHours(qh: QuietHours, asOf: Date): boolean {
  const h = asOf.getUTCHours();
  const { start_hour: s, end_hour: e } = qh;
  if (s === e) return h === s;
  if (s < e) return h >= s && h < e;
  // Wrap (e.g. start=22, end=7 → 22,23,0,1,…,6 are quiet)
  return h >= s || h < e;
}

function validateQuietHoursPatch(input: unknown): QuietHours | null {
  if (input === null) return null;
  if (!input || typeof input !== 'object') {
    throw new PreferenceError('invalid_input', 'quiet_hours must be an object or null');
  }
  const i = input as Record<string, unknown>;
  for (const k of ['start_hour', 'end_hour'] as const) {
    if (
      typeof i[k] !== 'number' ||
      !Number.isInteger(i[k]) ||
      (i[k] as number) < 0 ||
      (i[k] as number) > 23
    ) {
      throw new PreferenceError('invalid_input', `${k} must be an integer 0-23`);
    }
  }
  return {
    start_hour: i.start_hour as number,
    end_hour: i.end_hour as number,
  };
}

function validatePatch(input: unknown): Partial<Record<Channel, boolean>> {
  if (!input || typeof input !== 'object') {
    throw new PreferenceError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  // Reject unknown keys first to prevent typos silently no-op'ing.
  for (const k of Object.keys(i)) {
    if (!VALID_CHANNELS.includes(k as Channel)) {
      throw new PreferenceError('invalid_input', `unknown channel key: ${k}`);
    }
  }
  const out: Partial<Record<Channel, boolean>> = {};
  let touched = false;
  for (const ch of VALID_CHANNELS) {
    if (i[ch] === undefined) continue;
    if (typeof i[ch] !== 'boolean') {
      throw new PreferenceError('invalid_input', `${ch} must be boolean`);
    }
    out[ch] = i[ch] as boolean;
    touched = true;
  }
  if (!touched) {
    throw new PreferenceError('invalid_input', 'at least one channel must be supplied');
  }
  return out;
}

// ─── Store ────────────────────────────────────────────────────────────

/** T6 M10.6 — per-tenant default carried on the store. Admins set
 *  these via PUT /tenant-defaults; user prefs still override. */
export interface TenantPreferenceDefault {
  tenant_id: string;
  email: boolean;
  sms: boolean;
  push: boolean;
  webhook: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface NotificationPreferenceStore {
  get(tenant_id: string, username: string): ChannelPreference;
  update(
    tenant_id: string,
    username: string,
    patch: unknown,
    now: Date,
  ): ChannelPreference;
  /** Pure helper for downstream dispatch logic — returns true iff the
   *  channel is enabled. Resolution order: user override → tenant
   *  default → hardcoded true (never-touched). When `asOf` is given
   *  and the user has quiet hours that contain that hour, the channel
   *  is also muted (webhook bypasses — transactional). */
  isEnabled(
    tenant_id: string,
    username: string,
    channel: Channel,
    asOf?: Date,
  ): boolean;
  reset(tenant_id: string, username: string): boolean;
  /** T6 M10.7 — set/clear the user's quiet-hours window. */
  setQuietHours(
    tenant_id: string,
    username: string,
    qh: QuietHours | null,
    now: Date,
  ): ChannelPreference;

  // M10.6 — tenant defaults
  getTenantDefault(tenant_id: string): TenantPreferenceDefault;
  setTenantDefault(
    tenant_id: string,
    patch: unknown,
    updated_by: string,
    now: Date,
  ): TenantPreferenceDefault;

  /** T6 M10.10 — true iff the user has an explicit (override) row
   *  in the store. Used by the effective-preference resolver to
   *  distinguish "user has overridden this" from "tenant default
   *  showing through". `get()` collapses both cases into the same
   *  shape so this is the canonical way to detect overrides. */
  hasUserOverride(tenant_id: string, username: string): boolean;
}

function defaultTenantPref(tenant_id: string): TenantPreferenceDefault {
  return {
    tenant_id,
    email: true,
    sms: true,
    push: true,
    webhook: true,
    updated_at: null,
    updated_by: null,
  };
}

export class InMemoryNotificationPreferenceStore implements NotificationPreferenceStore {
  // (tenant, username) → preference
  private readonly map = new Map<string, ChannelPreference>();
  // tenant → tenant-default (M10.6)
  private readonly tenantDefaults = new Map<string, TenantPreferenceDefault>();

  private k(tenant: string, user: string): string {
    return `${tenant}::${user}`;
  }

  get(tenant_id: string, username: string): ChannelPreference {
    if (!tenant_id || !username) {
      throw new PreferenceError('invalid_input', 'tenant_id and username required');
    }
    const stored = this.map.get(this.k(tenant_id, username));
    if (stored) return stored;
    // Tenant defaults populate the never-touched user view.
    const td = this.tenantDefaults.get(tenant_id);
    if (td) {
      return {
        tenant_id,
        username,
        email: td.email,
        sms: td.sms,
        push: td.push,
        webhook: td.webhook,
        updated_at: null,
        quiet_hours: null,
      };
    }
    return defaultPref(tenant_id, username);
  }

  update(
    tenant_id: string,
    username: string,
    patch: unknown,
    now: Date,
  ): ChannelPreference {
    if (!tenant_id || !username) {
      throw new PreferenceError('invalid_input', 'tenant_id and username required');
    }
    const valid = validatePatch(patch);
    const current = this.get(tenant_id, username);
    const next: ChannelPreference = {
      ...current,
      ...valid,
      updated_at: now.toISOString(),
    };
    this.map.set(this.k(tenant_id, username), next);
    return next;
  }

  isEnabled(
    tenant_id: string,
    username: string,
    channel: Channel,
    asOf?: Date,
  ): boolean {
    if (!VALID_CHANNELS.includes(channel)) return false;
    const pref = this.get(tenant_id, username);
    if (!pref[channel]) return false;
    // M10.7 quiet-hours: webhook channels bypass (transactional/system).
    if (asOf && pref.quiet_hours && channel !== 'webhook') {
      if (isInQuietHours(pref.quiet_hours, asOf)) return false;
    }
    return true;
  }

  setQuietHours(
    tenant_id: string,
    username: string,
    qh: QuietHours | null,
    now: Date,
  ): ChannelPreference {
    if (!tenant_id || !username) {
      throw new PreferenceError('invalid_input', 'tenant_id and username required');
    }
    const current = this.get(tenant_id, username);
    const next: ChannelPreference = {
      ...current,
      quiet_hours: qh,
      updated_at: now.toISOString(),
    };
    this.map.set(this.k(tenant_id, username), next);
    return next;
  }

  reset(tenant_id: string, username: string): boolean {
    return this.map.delete(this.k(tenant_id, username));
  }

  hasUserOverride(tenant_id: string, username: string): boolean {
    if (!tenant_id || !username) return false;
    return this.map.has(this.k(tenant_id, username));
  }

  // ── M10.6 tenant defaults ────────────────────────────────────────────

  getTenantDefault(tenant_id: string): TenantPreferenceDefault {
    if (!tenant_id) {
      throw new PreferenceError('invalid_input', 'tenant_id required');
    }
    return this.tenantDefaults.get(tenant_id) ?? defaultTenantPref(tenant_id);
  }

  setTenantDefault(
    tenant_id: string,
    patch: unknown,
    updated_by: string,
    now: Date,
  ): TenantPreferenceDefault {
    if (!tenant_id) {
      throw new PreferenceError('invalid_input', 'tenant_id required');
    }
    if (!updated_by || !updated_by.trim()) {
      throw new PreferenceError('invalid_input', 'updated_by required');
    }
    const valid = validatePatch(patch);
    const current = this.getTenantDefault(tenant_id);
    const next: TenantPreferenceDefault = {
      ...current,
      ...valid,
      updated_at: now.toISOString(),
      updated_by: updated_by.trim(),
    };
    this.tenantDefaults.set(tenant_id, next);
    return next;
  }
}

export const defaultNotificationPreferenceStore: NotificationPreferenceStore =
  new InMemoryNotificationPreferenceStore();
