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

export interface ChannelPreference {
  tenant_id: string;
  username: string;
  email: boolean;
  sms: boolean;
  push: boolean;
  webhook: boolean;
  /** ISO timestamp of last update — null when defaults still apply. */
  updated_at: string | null;
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

export interface NotificationPreferenceStore {
  get(tenant_id: string, username: string): ChannelPreference;
  update(
    tenant_id: string,
    username: string,
    patch: unknown,
    now: Date,
  ): ChannelPreference;
  /** Pure helper for downstream dispatch logic — returns true iff the
   *  user has the channel enabled (defaults to true on never-touched). */
  isEnabled(tenant_id: string, username: string, channel: Channel): boolean;
  reset(tenant_id: string, username: string): boolean;
}

export class InMemoryNotificationPreferenceStore implements NotificationPreferenceStore {
  // (tenant, username) → preference
  private readonly map = new Map<string, ChannelPreference>();

  private k(tenant: string, user: string): string {
    return `${tenant}::${user}`;
  }

  get(tenant_id: string, username: string): ChannelPreference {
    if (!tenant_id || !username) {
      throw new PreferenceError('invalid_input', 'tenant_id and username required');
    }
    return (
      this.map.get(this.k(tenant_id, username)) ?? defaultPref(tenant_id, username)
    );
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

  isEnabled(tenant_id: string, username: string, channel: Channel): boolean {
    if (!VALID_CHANNELS.includes(channel)) return false;
    const pref = this.get(tenant_id, username);
    return pref[channel];
  }

  reset(tenant_id: string, username: string): boolean {
    return this.map.delete(this.k(tenant_id, username));
  }
}

export const defaultNotificationPreferenceStore: NotificationPreferenceStore =
  new InMemoryNotificationPreferenceStore();
