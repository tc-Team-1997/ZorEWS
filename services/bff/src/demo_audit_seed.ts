// services/bff/src/demo_audit_seed.ts
//
// Cold-start seeder for the in-memory audit trail (M15.1 surface).
// Without this, /v1/admin/audit-log lands on an empty table — fine for
// fresh production tenants but embarrassing for the demo (Act 6).
//
// Adds ~12 realistic events per tenant backdated across the last 24h
// covering each AuditResourceType so filters work in the SPA preview.
// Idempotent — if the store already carries events for the tenant the
// seeder no-ops (avoid duplicating after restart-with-pg or test runs).

import type { AuditTrailStore, AuditEventInput, AuditResourceType, AuditSeverity, AuditOutcome } from './audit_trail';

interface SeedRow {
  hours_ago: number;
  actor_username: string;
  actor_role: string;
  action: string;
  resource_type: AuditResourceType;
  resource_id: string;
  outcome: AuditOutcome;
  severity?: AuditSeverity;
  correlation_id?: string;
  metadata?: Record<string, unknown>;
}

const SEED_ROWS: SeedRow[] = [
  { hours_ago: 23, actor_username: 'alice.admin', actor_role: 'admin', action: 'auth.login', resource_type: 'session', resource_id: 'sid-001', outcome: 'success', severity: 'info' },
  { hours_ago: 22, actor_username: 'ravi.risk', actor_role: 'risk_analyst', action: 'auth.login', resource_type: 'session', resource_id: 'sid-002', outcome: 'success', severity: 'info' },
  { hours_ago: 20, actor_username: 'alice.admin', actor_role: 'admin', action: 'config.update', resource_type: 'config', resource_id: 'alerts.red_sla_hours', outcome: 'success', severity: 'warning', metadata: { previous_value: 4, new_value: 2 } },
  { hours_ago: 18, actor_username: 'ravi.risk', actor_role: 'risk_analyst', action: 'rule.create', resource_type: 'rule', resource_id: 'rule-r-031', outcome: 'success', severity: 'info', metadata: { cloned_from: 'tpl_dpd_30_60' } },
  { hours_ago: 16, actor_username: 'ravi.risk', actor_role: 'risk_analyst', action: 'rule.transition', resource_type: 'rule', resource_id: 'rule-r-031', outcome: 'success', severity: 'info', metadata: { from: 'draft', to: 'live' } },
  { hours_ago: 14, actor_username: 'system', actor_role: 'system', action: 'alert.created', resource_type: 'alert', resource_id: 'a-1009', outcome: 'success', severity: 'critical', correlation_id: 'corr-c-115', metadata: { customer_id: 'c-115', class: 'red', criticality_score: 8.45 } },
  { hours_ago: 13, actor_username: 'ravi.risk', actor_role: 'risk_analyst', action: 'alert.ack', resource_type: 'alert', resource_id: 'a-1009', outcome: 'success', severity: 'info', correlation_id: 'corr-c-115' },
  { hours_ago: 12, actor_username: 'ravi.risk', actor_role: 'risk_analyst', action: 'case.opened', resource_type: 'case', resource_id: 'case-c-115-01', outcome: 'success', severity: 'warning', correlation_id: 'corr-c-115' },
  { hours_ago: 10, actor_username: 'sue.super', actor_role: 'supervisor', action: 'case.assigned', resource_type: 'case', resource_id: 'case-c-115-01', outcome: 'success', severity: 'info', correlation_id: 'corr-c-115', metadata: { assignee: 'carl.collect' } },
  { hours_ago: 8, actor_username: 'carl.collect', actor_role: 'collection_officer', action: 'case.note_added', resource_type: 'case', resource_id: 'case-c-115-01', outcome: 'success', severity: 'info', correlation_id: 'corr-c-115' },
  { hours_ago: 6, actor_username: 'system', actor_role: 'system', action: 'integration.adapter.probe', resource_type: 'integration', resource_id: 'cbs_loan_book', outcome: 'success', severity: 'info' },
  { hours_ago: 5, actor_username: 'system', actor_role: 'system', action: 'integration.adapter.probe', resource_type: 'integration', resource_id: 'bureau_pull', outcome: 'failure', severity: 'warning', metadata: { error: 'timeout after 1500ms' } },
  { hours_ago: 4, actor_username: 'alice.admin', actor_role: 'admin', action: 'scenario.create', resource_type: 'scenario', resource_id: 'scn-rbi-adverse-2026q2', outcome: 'success', severity: 'info', metadata: { cloned_from: 'rbi_adverse' } },
  { hours_ago: 3, actor_username: 'alice.admin', actor_role: 'admin', action: 'report.run', resource_type: 'report', resource_id: 'portfolio_snapshot_daily', outcome: 'success', severity: 'info', metadata: { format: 'pdf' } },
  { hours_ago: 2, actor_username: 'fiona.field', actor_role: 'field_officer', action: 'auth.login', resource_type: 'session', resource_id: 'sid-003', outcome: 'failure', severity: 'warning', metadata: { reason: 'wrong_password' } },
  { hours_ago: 1, actor_username: 'fiona.field', actor_role: 'field_officer', action: 'auth.login', resource_type: 'session', resource_id: 'sid-004', outcome: 'success', severity: 'info' },
  { hours_ago: 0.5, actor_username: 'system', actor_role: 'system', action: 'user.access.review', resource_type: 'user', resource_id: 'ravi.risk', outcome: 'denied', severity: 'critical', metadata: { reason: 'dormant_90d_check' } },
];

const SEED_TENANTS = ['BANK_DEMO', 'BIL'] as const;

export function seedDemoAuditEvents(store: AuditTrailStore, now: Date = new Date()): { seeded: number; skipped_tenants: string[] } {
  let seeded = 0;
  const skipped: string[] = [];

  for (const tenant_id of SEED_TENANTS) {
    // Idempotency: if the tenant already has any events, skip — assume
    // either a prior bootstrap seed OR a pg-backed store with real data.
    const existing = store.list(tenant_id, { page: 1, page_size: 1 });
    if (existing.total > 0) {
      skipped.push(tenant_id);
      continue;
    }
    for (const row of SEED_ROWS) {
      const ts = new Date(now.getTime() - row.hours_ago * 3_600_000);
      const input: AuditEventInput = {
        actor_username: row.actor_username,
        actor_role: row.actor_role,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        outcome: row.outcome,
        severity: row.severity,
        correlation_id: row.correlation_id,
        metadata: row.metadata,
      };
      store.record(tenant_id, input, ts);
      seeded++;
    }
  }

  return { seeded, skipped_tenants: skipped };
}
