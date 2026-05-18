// services/bff/src/recovery/audit.ts
//
// Recovery lifecycle → audit fan-out helper.
//
// Every archive / restore / purge writes one event to the M15.1 audit
// trail (app_iam.audit_events) so:
//   - SPA audit log shows soft-deletes alongside other events
//   - M15.x activity heatmap / per-actor rollup picks up recovery work
//   - Compliance can reconstruct WHO deleted/restored/purged WHAT WHEN
//
// Best-effort: audit failure never blocks the recovery operation. We
// always succeed the user action first, then fire-and-forget the
// audit. Logged on failure for ops to notice.
//
// Resource type: 'system' (the AuditResourceType enum doesn't include
// 'recovery' yet). The `action` field carries the discrimination
// (`recovery.archive` / `recovery.restore` / `recovery.purge`), and
// `metadata` carries the entity_type + original_id so audit consumers
// can pivot on either axis.

import type { AuditTrailStore } from '../audit_trail';
import type { DeletedRecord, RecoveryStatus } from './types';

export interface RecoveryAuditCtx {
  /** When undefined, no audit fan-out happens — useful for tests + when
   *  callers don't want auditing (e.g. some background sweep). */
  auditTrailStore?: AuditTrailStore;
  tenant_id: string;
  actor_username: string;
  actor_role: string;
  ip_address?: string;
  /** Optional correlation_id — when present, the recovery event joins
   *  the same correlation chain as the originating request. */
  correlation_id?: string;
  now: Date;
}

/** Map recovery lifecycle stage → audit action verb. */
type RecoveryAction = 'recovery.archive' | 'recovery.restore' | 'recovery.purge';

const STAGE_TO_ACTION: Record<RecoveryStatus, RecoveryAction> = {
  archived: 'recovery.archive',
  restored: 'recovery.restore',
  purged: 'recovery.purge',
};

/** Best-effort audit-event emission. Returns the recorded event_id
 *  (when successful) so tests can pin it; never throws. */
export function recordRecoveryAudit(
  ctx: RecoveryAuditCtx,
  record: DeletedRecord,
): string | undefined {
  if (!ctx.auditTrailStore) return undefined;
  try {
    const action = STAGE_TO_ACTION[record.status];
    const ev = ctx.auditTrailStore.record(
      ctx.tenant_id,
      {
        actor_username: ctx.actor_username,
        actor_role: ctx.actor_role,
        action,
        resource_type: 'system',
        resource_id: record.recovery_id,
        outcome: 'success',
        severity: record.status === 'purged' ? 'warning' : 'info',
        ip_address: ctx.ip_address,
        correlation_id: ctx.correlation_id,
        metadata: {
          entity_type: record.entity_type,
          original_id: record.original_id,
          original_table: record.original_table,
          module: record.module,
          // Snapshot for cross-reference (don't carry the full payload —
          // audit events are queried often and the payload can be large).
          deleted_by: record.deleted_by,
          deleted_at: record.deleted_at,
          ...(record.restored_at && { restored_at: record.restored_at, restored_by: record.restored_by }),
          ...(record.purged_at && { purged_at: record.purged_at, purged_by: record.purged_by }),
        },
      },
      ctx.now,
    );
    return ev.event_id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[recovery] audit fan-out failed', err);
    return undefined;
  }
}
