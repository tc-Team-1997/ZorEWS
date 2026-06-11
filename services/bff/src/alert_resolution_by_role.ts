// services/bff/src/alert_resolution_by_role.ts
// T6 M8.27 — Alert resolution time by assignee role.

import { defaultRoutingLedger, type RoutingLedger } from './alert_routing_analytics';
import { DEFAULT_RULES } from './alert_routing';

export interface AlertResolutionByRoleRow {
  role: string;
  total_alerts: number;
  acked_count: number;
  avg_ack_hours: number | null;
  unacked_count: number;
  ack_rate: number;
}

export interface AlertResolutionByRole {
  tenant_id: string;
  generated_at: string;
  by_role: AlertResolutionByRoleRow[];
  fastest_role: string | null;
  overall_ack_rate: number;
}

export function buildAlertResolutionByRole(
  tenant_id: string,
  ledger: RoutingLedger,
  now: Date,
): AlertResolutionByRole {
  const records = ledger.list(tenant_id, 200);

  // Map class → primary_assignee_role via default routing rules
  const classToRole = new Map<string, string>();
  for (const [cls, rule] of Object.entries(DEFAULT_RULES)) {
    classToRole.set(cls, rule.primary_assignee ?? 'none');
  }

  type RoleAccum = { total: number; acked: number; totalAckMs: number; ackCount: number };
  const byRole = new Map<string, RoleAccum>();

  for (const rec of records) {
    const role = classToRole.get(rec.class) ?? 'none';
    const prev = byRole.get(role) ?? { total: 0, acked: 0, totalAckMs: 0, ackCount: 0 };
    prev.total += 1;
    if (rec.acked_at) {
      const ackMs = new Date(rec.acked_at).getTime() - new Date(rec.created_at).getTime();
      if (ackMs >= 0) {
        prev.acked += 1;
        prev.totalAckMs += ackMs;
        prev.ackCount += 1;
      }
    }
    byRole.set(role, prev);
  }

  const rows: AlertResolutionByRoleRow[] = Array.from(byRole.entries()).map(([role, accum]) => {
    const ack_rate = accum.total > 0 ? Math.round((accum.acked / accum.total) * 10000) / 10000 : 0;
    const avg_ack_hours = accum.ackCount > 0
      ? Math.round((accum.totalAckMs / accum.ackCount / 3600000) * 100) / 100
      : null;
    return { role, total_alerts: accum.total, acked_count: accum.acked, avg_ack_hours, unacked_count: accum.total - accum.acked, ack_rate };
  });

  rows.sort((a, b) => b.ack_rate - a.ack_rate);

  const rowsWithAck = rows.filter((r) => r.avg_ack_hours !== null);
  let fastest_role: string | null = null;
  if (rowsWithAck.length > 0) {
    fastest_role = rowsWithAck.reduce((best, r) => (r.avg_ack_hours! < best.avg_ack_hours! ? r : best)).role;
  }

  const totalAlerts = rows.reduce((s, r) => s + r.total_alerts, 0);
  const totalAcked = rows.reduce((s, r) => s + r.acked_count, 0);
  const overall_ack_rate = totalAlerts > 0 ? Math.round((totalAcked / totalAlerts) * 10000) / 10000 : 0;

  return { tenant_id, generated_at: now.toISOString(), by_role: rows, fastest_role, overall_ack_rate };
}

export { defaultRoutingLedger };
