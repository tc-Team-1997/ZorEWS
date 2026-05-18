// services/bff/src/recovery/adapters.ts
//
// Adapter registry. Services register ONE adapter per entity_type at
// boot time. The restore endpoint looks up the adapter by entity_type
// and dispatches to its restore() handler.
//
// Each service owns its adapter (next to the store it controls) and
// is responsible for the conflict semantics:
//   - throw RestoreConflictError when the original_id already exists
//   - validate the payload shape (it may have been written months ago)
//   - re-establish FKs / relationships where applicable
//
// Phase 1 ships adapters for webhook_subscription + saved_scenario.
// Future tickets register adapters for users / cases / alerts / etc.

import type { DeletedRecord, RecoveryAdapter } from './types';
import { RecoveryError } from './types';

const adapters = new Map<string, RecoveryAdapter>();

/** Register an adapter. Called at server boot for each entity_type.
 *  Throws on duplicate registration to catch typos / re-registration. */
export function registerRecoveryAdapter(adapter: RecoveryAdapter): void {
  if (!adapter.entity_type || !adapter.restore) {
    throw new Error('invalid adapter: entity_type + restore are required');
  }
  if (adapters.has(adapter.entity_type)) {
    throw new Error(
      `duplicate recovery adapter for entity_type "${adapter.entity_type}"`,
    );
  }
  adapters.set(adapter.entity_type, adapter);
}

/** Lookup an adapter for a deleted record's entity_type. */
export function getRecoveryAdapter(entity_type: string): RecoveryAdapter | undefined {
  return adapters.get(entity_type);
}

/** Snapshot of every registered adapter — used by the SPA "Modules"
 *  filter to know which entity_types CAN be restored. */
export function listRecoveryAdapters(): RecoveryAdapter[] {
  return [...adapters.values()].sort((a, b) =>
    a.entity_type < b.entity_type ? -1 : 1,
  );
}

/** Test-only: clear the registry. */
export function _resetRecoveryAdapters(): void {
  adapters.clear();
}

/** Convenience wrapper used by the restore route: locate adapter,
 *  invoke restore, surface no_adapter as a typed error. */
export async function invokeRestore(record: DeletedRecord): Promise<void> {
  const adapter = adapters.get(record.entity_type);
  if (!adapter) {
    throw new RecoveryError(
      'no_adapter',
      `no restore adapter registered for entity_type "${record.entity_type}"`,
      { entity_type: record.entity_type },
    );
  }
  await adapter.restore(record);
}
