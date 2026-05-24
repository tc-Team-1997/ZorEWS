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
  | 'cases'
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

  // cases — Module 3.1 SLA auto-escalation threshold.
  {
    key: 'cases.auto_escalate_at_pct',
    category: 'cases',
    type: 'number',
    description:
      'Auto-escalate non-closed CMS cases when (now - created_at) / (sla_due_at - created_at) ≥ this fraction. ' +
      'Range [0, 1]. Default 0.8 = escalate at 80% of SLA elapsed.',
    default_value: 0.8,
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
  // Module 1.7 — DQ score dimension weights (5 dimensions, sum ≈ 1.0).
  {
    key: 'scoring.dq.dimension_weights',
    category: 'scoring',
    type: 'json',
    description: 'Weights for the 5 DQ dimensions (completeness, validity, consistency, uniqueness, timeliness). Sum must be > 0; values are normalised internally.',
    default_value: {
      completeness: 0.30,
      validity: 0.30,
      consistency: 0.15,
      uniqueness: 0.15,
      timeliness: 0.10,
    },
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

// ─── PgConfigStore — pg-backed mirror of InMemoryConfigStore ────────────────
//
// Closes M13.x persistence gap from docs/database-gap-analysis.md. Migration
// 037_tenant_configs.sql created app_admin.tenant_configs; this class wires it.
//
// Design: cache-on-init + sync reads + write-through fire-and-forget pg.
// Mirrors the established pattern in services/bff/src/webhooks/pg_store.ts
// and services/bff/src/scenario/pg_store.ts.
//
//   - init() fetches every (tenant_id, config_key) row WHERE deleted_at IS NULL
//     into the in-memory `overrides` Map.
//   - list/get serve from cache — SYNC, same shape as InMemoryConfigStore.
//   - set updates cache synchronously, then fires UPSERT to pg in background.
//   - reset deletes from cache synchronously, then soft-deletes the row in pg.
//
// Backward-compat: ConfigStore interface unchanged. Routes don't know which
// impl they got. Existing tests that pass InMemoryConfigStore directly still
// work — they bypass the factory.
//
// JSONB serialization: PG accepts top-level scalars (`42`, `true`, `"foo"`)
// in JSONB columns since PG 9.4. node-pg's pg driver auto-parses jsonb to
// the equivalent JS value on read. Both encode + decode are no-op pass-through.

// Minimal Pool interface — kept loose to dodge requiring `import { Pool } from 'pg'`
// at the top of admin_config.ts (which would couple this module to the pg dep
// at compile time even when running in-memory mode).
interface PgPoolLike {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface OverrideRow {
  tenant_id: string;
  config_key: string;
  value: ConfigValue;
  updated_at: Date | string;
  updated_by: string;
}

export class PgConfigStore implements ConfigStore {
  /** tenant_id → key → Override. Hydrated by init(). */
  private readonly overrides = new Map<string, Map<string, Override>>();
  private initialised = false;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly pool: PgPoolLike) {}

  /** Hydrate cache from pg. Idempotent. */
  async init(): Promise<void> {
    if (this.initialised) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const { rows } = await this.pool.query<OverrideRow>(
        `SELECT tenant_id, config_key, value, updated_at, updated_by
         FROM app_admin.tenant_configs
         WHERE deleted_at IS NULL`
      );
      for (const r of rows) {
        let t = this.overrides.get(r.tenant_id);
        if (!t) {
          t = new Map();
          this.overrides.set(r.tenant_id, t);
        }
        t.set(r.config_key, {
          value: r.value,
          updated_at: typeof r.updated_at === 'string' ? r.updated_at : r.updated_at.toISOString(),
          updated_by: r.updated_by,
        });
      }
      this.initialised = true;
    })();
    return this.initPromise;
  }

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

    // 1. Update cache synchronously — readers see the new value immediately
    let tMap = this.overrides.get(tenant_id);
    if (!tMap) {
      tMap = new Map();
      this.overrides.set(tenant_id, tMap);
    }
    const override: Override = {
      value: validated,
      updated_at: now.toISOString(),
      updated_by,
    };
    tMap.set(key, override);

    // 2. Fire-and-forget pg UPSERT — does not block the caller
    this.pool
      .query(
        `INSERT INTO app_admin.tenant_configs
           (tenant_id, config_key, value_type, value, category, updated_at, updated_by, deleted_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NULL)
         ON CONFLICT (tenant_id, config_key) DO UPDATE SET
           value_type = EXCLUDED.value_type,
           value      = EXCLUDED.value,
           category   = EXCLUDED.category,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by,
           deleted_at = NULL`,
        [
          tenant_id,
          key,
          def.type,
          JSON.stringify(validated),
          def.category,
          now,
          updated_by,
        ],
      )
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[admin_config] PgConfigStore.set pg write failed:', err);
      });

    return this.composeEntry(def, override);
  }

  reset(tenant_id: string, key: string): ConfigEntry {
    const def = DEFAULTS_BY_KEY.get(key);
    if (!def) {
      throw new ConfigValidationError('unknown_key', `unknown config key: ${key}`);
    }

    // 1. Remove from cache synchronously
    this.overrides.get(tenant_id)?.delete(key);

    // 2. Soft-delete the pg row in background
    this.pool
      .query(
        `UPDATE app_admin.tenant_configs
         SET deleted_at = NOW()
         WHERE tenant_id = $1 AND config_key = $2 AND deleted_at IS NULL`,
        [tenant_id, key],
      )
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[admin_config] PgConfigStore.reset pg write failed:', err);
      });

    return this.composeEntry(def, undefined);
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

/**
 * Env-gated factory.
 *
 * - BFF_PG_URL set  → return PgConfigStore connected to that pg instance.
 *   The store's init() fires synchronously after construction; until it
 *   completes any list/get returns platform defaults (no overrides) which
 *   is correct behavior for a freshly-restarted process.
 * - BFF_PG_URL unset → return the existing InMemoryConfigStore.
 *
 * Tests pass their own InMemoryConfigStore via AppDeps.configStore and
 * never hit this factory.
 *
 * Lazy-imports pg only when needed so the pg dep doesn't load in
 * in-memory test runs.
 */
export function makeConfigStore(env: NodeJS.ProcessEnv = process.env): ConfigStore {
  const pgUrl = env.BFF_PG_URL;
  if (!pgUrl) return new InMemoryConfigStore();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pgModule = require('pg') as { Pool: new (opts: { connectionString: string; max?: number }) => PgPoolLike };
  const pool = new pgModule.Pool({ connectionString: pgUrl, max: 5 });
  const store = new PgConfigStore(pool);
  store.init().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[admin_config] PgConfigStore.init failed:', e);
  });
  return store;
}
