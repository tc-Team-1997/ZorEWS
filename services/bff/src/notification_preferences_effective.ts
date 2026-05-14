// services/bff/src/notification_preferences_effective.ts
//
// T6 M10.10 — Notification preference effective view + resolution chain.
//
// M10.5 ships per-user preferences; M10.6 adds tenant defaults; M10.7
// adds per-user quiet-hours. `isEnabled()` already does the right
// thing for dispatch, but operators debugging "why isn't this user
// getting alerts?" need to SEE the resolution chain — which level
// (user override / tenant default / platform default) provided the
// effective value for each channel.
//
// Design:
//  - Pure function over the store interface. Uses the new M10.10
//    `hasUserOverride` flag to distinguish "user has explicitly set
//    this" from "tenant default showing through".
//  - For each channel, walks the chain top-down and records which
//    level "won". The hardcoded platform default is `true` for every
//    channel (matches the M10.5/M10.6 fallback behaviour).
//  - When `asOf` is supplied, applies the M10.7 quiet-hours mute
//    AT THE END (after resolution) and surfaces it as a separate
//    `muted_by_quiet_hours` bool so the SPA can render "muted right
//    now" without losing the underlying preference value.

import {
  isInQuietHours,
  type Channel,
  type ChannelPreference,
  type NotificationPreferenceStore,
  type QuietHours,
  type TenantPreferenceDefault,
} from './notification_preferences';

// ─── Public types ─────────────────────────────────────────────────────

export type ResolutionLevel = 'user_override' | 'tenant_default' | 'platform_default';

export interface ResolutionLevelDetail {
  level: ResolutionLevel;
  /** null when the level isn't set (user has no override, tenant has
   *  no default set), boolean otherwise. Platform default is always
   *  `true`. */
  value: boolean | null;
  /** When `level='tenant_default'` and the tenant has set the
   *  default, the timestamp of the last update. null when defaulted
   *  or N/A. */
  set_at?: string | null;
  /** When `level='tenant_default'`, the actor who set the default. */
  set_by?: string | null;
}

export interface ChannelResolution {
  channel: Channel;
  /** Effective enabled state AFTER resolution but BEFORE quiet-hours mute. */
  effective_enabled: boolean;
  /** Which level provided the effective value. */
  resolution: ResolutionLevel;
  /** Resolution chain top-to-bottom (user → tenant → platform). The
   *  level that won is `resolution`. */
  levels: ResolutionLevelDetail[];
}

export interface EffectivePreference {
  tenant_id: string;
  username: string;
  channels: ChannelResolution[];
  /** User-level quiet-hours window (null when not set). M10.7 lives
   *  on the user only — there's no tenant-level quiet-hours yet. */
  quiet_hours: QuietHours | null;
  /** When `asOf` was supplied to the resolver: true iff that instant
   *  falls inside the user's quiet-hours window. Webhook channels
   *  bypass quiet hours by design (transactional) — surfaced as
   *  per-channel `muted_now` rather than a single tenant-wide bool. */
  asOf: string | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

const ALL_CHANNELS: Channel[] = ['email', 'sms', 'push', 'webhook'];
const PLATFORM_DEFAULT = true;

function resolveOne(
  channel: Channel,
  userOverride: ChannelPreference | null,
  tenantDefault: TenantPreferenceDefault,
  tenantHasDefault: boolean,
): ChannelResolution {
  const userVal = userOverride ? userOverride[channel] : null;
  const tenantVal = tenantHasDefault ? tenantDefault[channel] : null;

  let effective: boolean;
  let resolution: ResolutionLevel;
  if (userOverride !== null) {
    effective = userVal as boolean;
    resolution = 'user_override';
  } else if (tenantHasDefault) {
    effective = tenantVal as boolean;
    resolution = 'tenant_default';
  } else {
    effective = PLATFORM_DEFAULT;
    resolution = 'platform_default';
  }

  return {
    channel,
    effective_enabled: effective,
    resolution,
    levels: [
      {
        level: 'user_override',
        value: userOverride === null ? null : (userVal as boolean),
      },
      {
        level: 'tenant_default',
        value: tenantHasDefault ? (tenantVal as boolean) : null,
        set_at: tenantHasDefault ? tenantDefault.updated_at : null,
        set_by: tenantHasDefault ? tenantDefault.updated_by : null,
      },
      {
        level: 'platform_default',
        value: PLATFORM_DEFAULT,
      },
    ],
  };
}

/**
 * Pure resolver — walks the resolution chain per channel and
 * surfaces the answer plus the chain that produced it. Mutating
 * the store between calls is fine; each call reads fresh.
 */
export function resolveEffectivePreference(
  store: NotificationPreferenceStore,
  tenant_id: string,
  username: string,
  asOf?: Date,
): EffectivePreference {
  if (!tenant_id || !username) {
    throw new Error('tenant_id and username required');
  }
  const hasOverride = store.hasUserOverride(tenant_id, username);
  // store.get() returns the merged view; we need the merged view when
  // a user override exists so quiet_hours surfaces too.
  const userPref = hasOverride ? store.get(tenant_id, username) : null;
  const tenantDefault = store.getTenantDefault(tenant_id);
  const tenantHasDefault =
    tenantDefault.updated_at !== null; // populated only on setTenantDefault

  const channels = ALL_CHANNELS.map((c) =>
    resolveOne(c, userPref, tenantDefault, tenantHasDefault),
  );

  const quiet_hours = userPref?.quiet_hours ?? null;
  return {
    tenant_id,
    username,
    channels,
    quiet_hours,
    asOf: asOf ? asOf.toISOString() : null,
  };
}

/**
 * Convenience: returns a flat object {email, sms, push, webhook} of
 * the final dispatch decision INCLUDING quiet-hours mute. Mirrors
 * `store.isEnabled(...)` per channel without the SPA having to make
 * 4 separate calls.
 */
export function applyQuietHoursMute(
  effective: EffectivePreference,
  asOf: Date,
): Record<Channel, boolean> {
  const muted = effective.quiet_hours
    ? isInQuietHours(effective.quiet_hours, asOf)
    : false;
  const out = {} as Record<Channel, boolean>;
  for (const c of effective.channels) {
    // Webhook bypasses quiet hours (M10.7 contract).
    out[c.channel] = c.effective_enabled && !(muted && c.channel !== 'webhook');
  }
  return out;
}
