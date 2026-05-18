// services/bff/src/recovery/types.ts
//
// Shared types for the centralised soft-delete + recovery surface.
//
// Architecture summary:
//
//   ┌──────────────────┐     archive()      ┌──────────────────────┐
//   │  Service store   │  ────────────────► │  RecoveryStore       │
//   │ (Pg*Store /      │  before DELETE     │  app_recovery.       │
//   │  InMemory*Store) │                    │  deleted_records     │
//   └──────────────────┘                    └──────────────────────┘
//                                                      │
//                                                      │ restore() looks up
//                                                      │ adapter by entity_type
//                                                      ▼
//                                          ┌──────────────────────┐
//                                          │  RecoveryAdapter     │
//                                          │  (per entity_type;   │
//                                          │   registered at      │
//                                          │   server boot)       │
//                                          └──────────────────────┘
//                                                      │
//                                                      │ re-inserts payload
//                                                      ▼
//                                          ┌──────────────────────┐
//                                          │  Original service    │
//                                          │  store (Pg / Memory) │
//                                          └──────────────────────┘

/** Canonical status of a deleted_records row. Derived from the
 *  presence of restored_at / purged_at; not stored directly. */
export type RecoveryStatus = 'archived' | 'restored' | 'purged';

/** Hard-coded service identifiers — keep stable; the SPA filter
 *  chips show these as module tabs. */
export type RecoveryModule =
  | 'bff'
  | 'auth-svc'
  | 'cases-svc'
  | 'alerts-svc'
  | 'rules-svc';

/** What was deleted + why. The full row is preserved in `payload`. */
export interface DeletedRecord {
  recovery_id: string;
  tenant_id: string;
  module: RecoveryModule;
  /** e.g. 'webhook_subscription' / 'saved_scenario' / 'user'. Used as
   *  the lookup key for the restore adapter. */
  entity_type: string;
  /** PK of the original row, stringified for portability. */
  original_id: string;
  /** Fully-qualified table name for audit + ops debugging. */
  original_table: string;
  /** Full snapshot of the row at delete time. The restore adapter
   *  re-inserts THIS back into the original table. */
  payload: Record<string, unknown>;
  deleted_by: string;
  deleted_at: string;
  deletion_reason: string | null;
  source_action: string | null;
  prior_status: string | null;
  restored_at: string | null;
  restored_by: string | null;
  purged_at: string | null;
  purged_by: string | null;
  /** Derived getter — not stored. Mutually-exclusive per CHECK constraint. */
  status: RecoveryStatus;
}

/** Caller passes this to recoveryStore.archive() right before the
 *  destructive operation in the service. */
export interface ArchiveInput {
  tenant_id: string;
  module: RecoveryModule;
  entity_type: string;
  original_id: string;
  original_table: string;
  payload: Record<string, unknown>;
  deleted_by: string;
  deletion_reason?: string | null;
  source_action?: string | null;
  prior_status?: string | null;
}

/** Filters for the list endpoint. All optional; combinable. */
export interface RecoveryListFilters {
  tenant_id: string;            // mandatory at the routing layer
  module?: RecoveryModule;
  entity_type?: string;
  deleted_by?: string;
  status?: RecoveryStatus;      // default: 'archived'
  since?: string;               // ISO datetime
  until?: string;               // ISO datetime
  page?: number;                // 1-based
  page_size?: number;           // bounded 1..200, default 50
}

/** Restore-adapter contract: each service registers ONE adapter per
 *  entity_type. The adapter knows how to re-insert the payload into
 *  the original table and what conflict policy to enforce. */
export interface RecoveryAdapter {
  /** Stable id — matches DeletedRecord.entity_type. */
  entity_type: string;
  /** For UI labels + auditability. */
  display_name: string;
  /** Used to disambiguate when two services share an entity_type
   *  (shouldn't happen, but better safe). */
  module: RecoveryModule;
  /** Original table — must match what was passed at archive time. */
  original_table: string;
  /** Re-insert `payload` into the original table. Implementations:
   *    - MUST throw RestoreConflictError when the original_id already exists
   *    - MUST be idempotent against same-payload re-runs (caller retries)
   *    - MUST restore relationships (FKs etc.) — for simple types
   *      that's just a single INSERT; for cascading entities the
   *      adapter handles it (or refuses with a domain-specific error).
   */
  restore: (record: DeletedRecord) => Promise<void> | void;
}

/** Specific error subtypes — the BFF route catches these and maps to
 *  the right HTTP status codes (404 / 409 / 503 etc.). */
export class RecoveryError extends Error {
  constructor(
    public readonly code:
      | 'unknown_record'
      | 'already_restored'
      | 'already_purged'
      | 'invalid_status_transition'
      | 'no_adapter'
      | 'restore_conflict'
      | 'invalid_input',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    // Prefix the message with the code so log-scrapers + test assertions
    // can pattern-match against the canonical identity. Human-readable
    // body still follows the colon.
    super(`${code}: ${message}`);
    this.name = 'RecoveryError';
  }
}

/** Thrown by adapters when the row already exists in the original
 *  table (typically: someone re-created the entity with the same id
 *  between delete and restore). */
export class RestoreConflictError extends RecoveryError {
  constructor(entity_type: string, original_id: string) {
    super(
      'restore_conflict',
      `restore conflict: ${entity_type} with id ${original_id} already exists`,
      { entity_type, original_id },
    );
  }
}
