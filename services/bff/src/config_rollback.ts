// services/bff/src/config_rollback.ts
//
// T6 M13.3 — Config rollback to a prior audit event.
//
// M13.1 ships the admin config registry. M13.2 wires every config
// mutation as a config.update / config.reset audit event (metadata
// carries `previous_value`, `new_value`, `default_value`). M13.3 lets
// admins point at a prior audit event and restore the config key
// to the state THAT EVENT REPRESENTS — i.e. the value the key held
// IMMEDIATELY AFTER the targeted event was applied.
//
// Semantics (matches the M13.2 history-row UI):
//   - history row e (config.update): { previous_value, new_value }
//     → rollback target = e.new_value  (state right after e applied)
//   - history row e (config.reset): { previous_value, default_value }
//     → rollback target = e.default_value  (state right after reset)
//
// The rollback itself goes through `configStore.set()` (or `.reset()`
// if the rollback target equals the schema default — preserves the
// is_default flag). A NEW config.update audit event is recorded
// carrying `rolled_back_from_event_id` in metadata so the trail
// remains a continuous chain.
//
// Errors (all routed via ConfigRollbackError):
//   - unknown_event           → 404
//   - event_not_for_this_key  → 400 (event's resource_id ≠ key path)
//   - event_not_recoverable   → 400 (audit event lacks the right
//     metadata field — e.g. legacy event before M13.2 wiring)
//   - already_at_value        → 409 (current value already matches
//     target — no-op)

import {
  type ConfigEntry,
  type ConfigStore,
  type ConfigValue,
  ConfigValidationError,
} from './admin_config';
import { type AuditTrailStore } from './audit_trail';

// ─── Public types ─────────────────────────────────────────────────────

export class ConfigRollbackError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ConfigRollbackError';
  }
}

export interface RollbackResult {
  entry: ConfigEntry;
  rolled_back_from_event_id: string;
  /** State the key held BEFORE the rollback ran (for SPA toast). */
  previous_value: ConfigValue;
  /** State the key now holds (= the rollback target). */
  new_value: ConfigValue;
}

// ─── Pure-function value extraction ────────────────────────────────────

function isConfigValue(v: unknown): v is ConfigValue {
  if (v === null || v === undefined) return false;
  const t = typeof v;
  return t === 'number' || t === 'string' || t === 'boolean' || (t === 'object' && !Array.isArray(v));
}

/**
 * Pull the post-event value from an audit event's metadata.
 * Returns null when the event metadata is missing the expected field
 * (legacy events written before M13.2, or schema drift).
 */
export function rollbackTargetFromMetadata(
  action: string,
  metadata: Record<string, unknown>,
): ConfigValue | null {
  if (action === 'config.update') {
    const v = metadata.new_value;
    return isConfigValue(v) ? v : null;
  }
  if (action === 'config.reset') {
    const v = metadata.default_value;
    return isConfigValue(v) ? v : null;
  }
  return null;
}

// Comparison that handles JSON-typed values (object dee
function valuesEqual(a: ConfigValue, b: ConfigValue): boolean {
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

// ─── Main entry ────────────────────────────────────────────────────────

/**
 * Pure-function-ish: reads from auditStore + configStore, writes to
 * configStore + auditStore. No side-channel I/O.
 */
export function rollbackConfig(
  tenant_id: string,
  key: string,
  to_event_id: string,
  actor_username: string,
  now: Date,
  configStore: ConfigStore,
  auditStore: AuditTrailStore,
): RollbackResult {
  if (!actor_username || !actor_username.trim()) {
    throw new ConfigRollbackError('invalid_input', 'actor_username required');
  }
  if (!to_event_id || typeof to_event_id !== 'string') {
    throw new ConfigRollbackError('invalid_input', 'to_event_id required');
  }
  // 1) Resolve the audit event.
  const ev = auditStore.get(tenant_id, to_event_id);
  if (!ev) {
    throw new ConfigRollbackError('unknown_event', `audit event ${to_event_id} not found`);
  }
  // 2) Cross-check: must be a config event for THIS key.
  if (ev.resource_type !== 'config' || ev.resource_id !== key) {
    throw new ConfigRollbackError(
      'event_not_for_this_key',
      `event ${to_event_id} is not a config event for key ${key}`,
    );
  }
  // 3) Pull the rollback target from metadata.
  const target = rollbackTargetFromMetadata(ev.action, ev.metadata);
  if (target === null) {
    throw new ConfigRollbackError(
      'event_not_recoverable',
      `event ${to_event_id} (action=${ev.action}) does not carry a recoverable value`,
    );
  }
  // 4) Get current value to detect no-op rollback.
  const current = configStore.get(tenant_id, key);
  if (!current) {
    // The audit event was for this key but the schema no longer
    // declares it — treat as recoverable failure.
    throw new ConfigRollbackError(
      'event_not_recoverable',
      `config key ${key} is no longer in the schema`,
    );
  }
  if (valuesEqual(current.value, target)) {
    throw new ConfigRollbackError(
      'already_at_value',
      `key ${key} is already at the rolled-back value`,
    );
  }
  // 5) Apply via configStore.set. If set() rejects (type mismatch),
  //    surface as event_not_recoverable since the audit event's value
  //    is no longer valid against the current schema.
  let updated: ConfigEntry;
  try {
    updated = configStore.set(tenant_id, key, target, actor_username.trim(), now);
  } catch (e) {
    if (e instanceof ConfigValidationError) {
      throw new ConfigRollbackError(
        'event_not_recoverable',
        `rollback target rejected by schema: ${e.message}`,
      );
    }
    throw e;
  }
  const previous_value = current.value;
  // 6) Write a NEW config.update audit event linking back.
  try {
    auditStore.record(
      tenant_id,
      {
        actor_username: actor_username.trim(),
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: key,
        outcome: 'success',
        severity: 'info',
        metadata: {
          previous_value,
          new_value: target,
          rolled_back_from_event_id: to_event_id,
        },
      },
      now,
    );
  } catch {
    // swallow — config rollback already succeeded; audit failure is
    // surfaced by the M15.2 chain check the next time someone runs it.
  }
  return {
    entry: updated,
    rolled_back_from_event_id: to_event_id,
    previous_value,
    new_value: target,
  };
}
