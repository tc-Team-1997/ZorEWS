// services/bff/src/admin_config.ts
//
// T6 M13.1 — Admin Configuration registry.
//
// Module 13 (Admin Configuration) is the "central control panel" for
// the platform. This module ships the first slice — a typed,
// tenant-scoped key-value config store with declared defaults.
//
// Design:
//   - DEFAULTS is the source of truth for the *schema* (what keys
//     exist, what type each value has, what category they belong to).
//     The schema is platform-wide.
//   - The store persists only *overrides*: a tenant can change the
//     value of a key, otherwise the entry reports the platform default
//     with `is_default=true`.
//   - Reset = remove the override → entry reverts to platform default.
//
// Why this lives in the BFF: prototypes don't need a service split,
// and the config consumers (alerts, notifications, scoring) all run
// inside the BFF process. Production might extract this to a dedicated
// admin-svc — the ConfigStore interface keeps that swap mechanical.

// ─── Public types ──────────────────────────────────────────────────────

export type ConfigType = 'number' | 'string' | 'boolean' | 'json';

export type ConfigValue = number | string | boolean | Record<string, unknown>;

export type ConfigCategory =
  | 'alerts'
  | 'notifications'
  | 'reporting'
  | 'scoring'
  | 'features';

export interface ConfigDef {
  key: string;
  category: ConfigCategory;
  type: ConfigType;
  description: string;
  default_value: ConfigValue;
}

export interface ConfigEntry extends ConfigDef {
  /** Effective value — override if set, else default_value. */
  value: ConfigValue;
  /** True iff no override exists for this tenant. */
  is_default: boolean;
  /** ISO timestamp of last update — null when is_default=true. */
  updated_at: string | null;
  /** Username that last updated the override — null when is_default=true. */
  updated_by: string | null;
}

export interface ConfigStore {
  /** Schema-aware list. Returns one entry per declared key. */
  list(tenant_id: string): ConfigEntry[];
  /** Single entry by key. Returns null when the key is unknown
   *  (i.e. not in the platform schema). */
  get(tenant_id: string, key: string): ConfigEntry | null;
  /**
   * Set the override for a key. Validates the value against the
   * declared type — throws ConfigValidationError on mismatch. Throws
   * with code 'unknown_key' when key is not in the schema.
   */
  set(tenant_id: string, key: string, value: ConfigValue, updated_by: string, now: Date): ConfigEntry;
  /** Remove the override → entry reverts to default. Returns the
   *  resulting entry. Throws 'unknown_key' on bad key. */
  reset(tenant_id: string, key: string): ConfigEntry;
}

export class ConfigValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

// ─── Platform default schema ───────────────────────────────────────────
//
// The BIL pitch + Banking API doc surface roughly these knobs as
// operator-tunable. Adding a key here is an additive schema change;
// removing one is a breaking change for any persisted overrides.

export const DEFAULTS: readonly ConfigDef[] = [
  // alerts — SLA windows per BIL §11 (mirrors bil_alert_classification.ts).
  {
    key: 'alerts.red_sla_hours',
    category: 'alerts',
    type: 'number',
    description: 'SLA in hours for Red (Critical) alerts before escalation',
    default_value: 4,
  },
  {
    key: 'alerts.orange_sla_hours',
    category: 'alerts',
    type: 'number',
    description: 'SLA in hours for Orange (High) alerts',
    default_value: 24,
  },
  {
    key: 'alerts.yellow_sla_hours',
    category: 'alerts',
    type: 'number',
    description: 'SLA in hours for Yellow (Medium) alerts',
    default_value: 72,
  },

  // notifications — channel toggles + addressing.
  {
    key: 'notifications.email.enabled',
    category: 'notifications',
    type: 'boolean',
    description: 'Master switch for the email notification channel',
    default_value: true,
  },
  {
    key: 'notifications.email.from_address',
    category: 'notifications',
    type: 'string',
    description: 'From-address used by the email transport',
    default_value: 'alerts@apex-ews.test',
  },
  {
    key: 'notifications.sms.enabled',
    category: 'notifications',
    type: 'boolean',
    description: 'Master switch for the SMS notification channel (M10.2, pending)',
    default_value: false,
  },

  // reporting — schedules + retention.
  {
    key: 'reporting.daily_report_time_utc',
    category: 'reporting',
    type: 'string',
    description: 'UTC time-of-day (HH:MM) when the daily ops report is generated',
    default_value: '06:00',
  },
  {
    key: 'reporting.retention_days',
    category: 'reporting',
    type: 'number',
    description: 'Days reports + ledger entries are retained',
    default_value: 365,
  },

  // scoring — BIL Σ(W×V) thresholds (mirrors bil_scoring.ts).
  {
    key: 'scoring.default_thresholds.low_max',
    category: 'scoring',
    type: 'number',
    description: 'Default low_max threshold for the BIL risk-scoring engine',
    default_value: 30,
  },
  {
    key: 'scoring.default_thresholds.medium_max',
    category: 'scoring',
    type: 'number',
    description: 'Default medium_max threshold for the BIL risk-scoring engine',
    default_value: 70,
  },

  // features — UI / capability toggles.
  {
    key: 'features.scenario_simulation_enabled',
    category: 'features',
    type: 'boolean',
    description: 'Whether the scenario simulation page is shown to users',
    default_value: true,
  },
  {
    key: 'features.copilot_enabled',
    category: 'features',
    type: 'boolean',
    description: 'Whether the AI co-pilot panel is shown to users',
    default_value: true,
  },
  {
    key: 'features.maker_checker_enabled',
    category: 'features',
    type: 'boolean',
    description: 'Whether maker-checker approval is required for sensitive actions',
    default_value: false,
  },
];

const DEFAULTS_BY_KEY = new Map<string, ConfigDef>(DEFAULTS.map((d) => [d.key, d]));

export function listDefaultKeys(): string[] {
  return DEFAULTS.map((d) => d.key);
}

export function listCategories(): ConfigCategory[] {
  // Stable order matching the schema.
  const seen = new Set<ConfigCategory>();
  const out: ConfigCategory[] = [];
  for (const d of DEFAULTS) {
    if (!seen.has(d.category)) {
      seen.add(d.category);
      out.push(d.category);
    }
  }
  return out;
}

// ─── Validation ────────────────────────────────────────────────────────

export function validateValue(def: ConfigDef, value: unknown): ConfigValue {
  switch (def.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ConfigValidationError(
          'invalid_value',
          `${def.key}: expected a finite number, got ${typeof value === 'number' ? 'NaN/Infinity' : typeof value}`,
        );
      }
      return value;
    case 'string':
      if (typeof value !== 'string' || value.length === 0) {
        throw new ConfigValidationError(
          'invalid_value',
          `${def.key}: expected a non-empty string`,
        );
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new ConfigValidationError(
          'invalid_value',
          `${def.key}: expected a boolean`,
        );
      }
      return value;
    case 'json':
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConfigValidationError(
          'invalid_value',
          `${def.key}: expected a JSON object`,
        );
      }
      return value as Record<string, unknown>;
  }
}

// ─── In-memory store ───────────────────────────────────────────────────

interface Override {
  value: ConfigValue;
  updated_at: string;
  updated_by: string;
}

export class InMemoryConfigStore implements ConfigStore {
  /** tenant_id → key → Override. */
  private readonly overrides = new Map<string, Map<string, Override>>();

  list(tenant_id: string): ConfigEntry[] {
    const tMap = this.overrides.get(tenant_id);
    return DEFAULTS.map((d) => this.composeEntry(d, tMap?.get(d.key)));
  }

  get(tenant_id: string, key: string): ConfigEntry | null {
    const def = DEFAULTS_BY_KEY.get(key);
    if (!def) return null;
    const ov = this.overrides.get(tenant_id)?.get(key);
    return this.composeEntry(def, ov);
  }

  set(
    tenant_id: string,
    key: string,
    value: ConfigValue,
    updated_by: string,
    now: Date,
  ): ConfigEntry {
    const def = DEFAULTS_BY_KEY.get(key);
    if (!def) {
      throw new ConfigValidationError('unknown_key', `unknown config key: ${key}`);
    }
    const validated = validateValue(def, value);
    let tMap = this.overrides.get(tenant_id);
    if (!tMap) {
      tMap = new Map();
      this.overrides.set(tenant_id, tMap);
    }
    tMap.set(key, {
      value: validated,
      updated_at: now.toISOString(),
      updated_by,
    });
    return this.composeEntry(def, tMap.get(key));
  }

  reset(tenant_id: string, key: string): ConfigEntry {
    const def = DEFAULTS_BY_KEY.get(key);
    if (!def) {
      throw new ConfigValidationError('unknown_key', `unknown config key: ${key}`);
    }
    this.overrides.get(tenant_id)?.delete(key);
    return this.composeEntry(def, undefined);
  }

  /** Test helper. */
  reset_all(): void {
    this.overrides.clear();
  }

  private composeEntry(def: ConfigDef, ov: Override | undefined): ConfigEntry {
    return {
      ...def,
      value: ov?.value ?? def.default_value,
      is_default: ov === undefined,
      updated_at: ov?.updated_at ?? null,
      updated_by: ov?.updated_by ?? null,
    };
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultConfigStore: ConfigStore = new InMemoryConfigStore();
