// services/bff/__tests__/tenant_readiness.test.ts
//
// T6 M2.1 — Tenant readiness check.

import request from 'supertest';
import {
  computeOverallStatus,
  runReadinessChecks,
  summariseChecks,
  type ReadinessCheck,
  type ReadinessTenantLookup,
  type ReadinessTenantRecord,
} from '../src/tenant_readiness';
import { InMemoryConfigStore } from '../src/admin_config';
import { InMemoryAlertRoutingEngine } from '../src/alert_routing';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRdyApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

function tenantLookupOf(records: ReadinessTenantRecord[]): ReadinessTenantLookup {
  const m = new Map(records.map((r) => [r.tenant_id, r]));
  return {
    async get(tenant_id: string): Promise<ReadinessTenantRecord | null> {
      return m.get(tenant_id) ?? null;
    },
  };
}

const HEALTHY_TENANT: ReadinessTenantRecord = {
  tenant_id: 'BIL',
  name: 'Bank of Insurance Limited',
  channels: ['API', 'WEB'],
  active: true,
  vertical: 'insurance',
};

function freshDeps(records: ReadinessTenantRecord[] = [HEALTHY_TENANT]) {
  return {
    tenantLookup: tenantLookupOf(records),
    configStore: new InMemoryConfigStore(),
    alertRoutingEngine: new InMemoryAlertRoutingEngine(),
    auditTrailStore: new InMemoryAuditTrailStore(),
    now: () => NOW,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

describe('computeOverallStatus', () => {
  test('all passing → ready', () => {
    expect(
      computeOverallStatus([
        { id: 'a', name: '', category: 'tenant', severity: 'blocking', passing: true, message: '' },
        { id: 'b', name: '', category: 'tenant', severity: 'warning', passing: true, message: '' },
      ]),
    ).toBe('ready');
  });

  test('any blocking failure → blocked', () => {
    expect(
      computeOverallStatus([
        { id: 'a', name: '', category: 'tenant', severity: 'blocking', passing: false, message: '' },
        { id: 'b', name: '', category: 'tenant', severity: 'warning', passing: false, message: '' },
      ]),
    ).toBe('blocked');
  });

  test('warnings only → warnings', () => {
    expect(
      computeOverallStatus([
        { id: 'a', name: '', category: 'tenant', severity: 'warning', passing: false, message: '' },
        { id: 'b', name: '', category: 'tenant', severity: 'info', passing: false, message: '' },
      ]),
    ).toBe('warnings');
  });

  test('failing info-severity does NOT bump to warnings (info is informational only)', () => {
    expect(
      computeOverallStatus([
        { id: 'a', name: '', category: 'tenant', severity: 'info', passing: false, message: '' },
      ]),
    ).toBe('ready');
  });
});

describe('summariseChecks', () => {
  test('counts the categories correctly', () => {
    const checks: ReadinessCheck[] = [
      { id: 'a', name: '', category: 'tenant', severity: 'blocking', passing: true, message: '' },
      { id: 'b', name: '', category: 'tenant', severity: 'blocking', passing: false, message: '' },
      { id: 'c', name: '', category: 'tenant', severity: 'warning', passing: false, message: '' },
      { id: 'd', name: '', category: 'tenant', severity: 'info', passing: true, message: '' },
    ];
    expect(summariseChecks(checks)).toEqual({
      total: 4,
      passing: 2,
      warnings: 1,
      blocking: 1,
    });
  });
});

// ─── runReadinessChecks ────────────────────────────────────────────────

describe('runReadinessChecks — happy path on a healthy tenant', () => {
  test('all blocking checks pass → overall_status not "blocked"', async () => {
    const deps = freshDeps();
    // Add an audit event so the audit-trail-active info check passes too.
    deps.auditTrailStore.record(
      'BIL',
      {
        actor_username: 'a',
        actor_role: 'admin',
        action: 'auth.login',
        resource_type: 'session',
        resource_id: 's-1',
        outcome: 'success',
      },
      NOW,
    );
    const report = await runReadinessChecks('BIL', deps);
    expect(report.overall_status).toBe('ready');
    expect(report.summary.blocking).toBe(0);
    expect(report.summary.passing).toBe(report.summary.total);
  });

  test('returns a report shape: tenant_id, generated_at, summary, checks', async () => {
    const deps = freshDeps();
    const report = await runReadinessChecks('BIL', deps);
    expect(report.tenant_id).toBe('BIL');
    expect(report.generated_at).toBe(NOW.toISOString());
    expect(report.summary.total).toBeGreaterThanOrEqual(8);
    expect(Array.isArray(report.checks)).toBe(true);
  });
});

describe('runReadinessChecks — tenant not registered', () => {
  test('only the tenant_exists check is returned, status=blocked', async () => {
    const deps = freshDeps([]);
    const report = await runReadinessChecks('UNKNOWN', deps);
    expect(report.overall_status).toBe('blocked');
    expect(report.checks.length).toBe(1);
    expect(report.checks[0]!.id).toBe('tenant_exists');
    expect(report.checks[0]!.passing).toBe(false);
  });
});

describe('runReadinessChecks — individual failure modes', () => {
  test('inactive tenant → tenant_active fails (blocking)', async () => {
    const deps = freshDeps([{ ...HEALTHY_TENANT, active: false }]);
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'tenant_active')!;
    expect(c.passing).toBe(false);
    expect(c.severity).toBe('blocking');
    expect(report.overall_status).toBe('blocked');
  });

  test('no channels → channels_configured fails (blocking)', async () => {
    const deps = freshDeps([{ ...HEALTHY_TENANT, channels: [] }]);
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'channels_configured')!;
    expect(c.passing).toBe(false);
    expect(report.overall_status).toBe('blocked');
  });

  test('vertical missing → vertical_assigned fails (warning, not blocking)', async () => {
    const deps = freshDeps([{ ...HEALTHY_TENANT, vertical: undefined }]);
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'vertical_assigned')!;
    expect(c.passing).toBe(false);
    expect(c.severity).toBe('warning');
    // The other checks should still pass, so overall = warnings (not blocked)
    expect(report.overall_status).toBe('warnings');
  });

  test('email_channel disabled → email_channel_enabled fails (warning)', async () => {
    const deps = freshDeps();
    deps.configStore.set('BIL', 'notifications.email.enabled', false, 'admin', NOW);
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'email_channel_enabled')!;
    expect(c.passing).toBe(false);
    expect(c.severity).toBe('warning');
  });

  test('email from-address malformed → email_from_address_valid fails (warning)', async () => {
    const deps = freshDeps();
    deps.configStore.set('BIL', 'notifications.email.from_address', 'not-an-email', 'admin', NOW);
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'email_from_address_valid')!;
    expect(c.passing).toBe(false);
  });

  test('routing override that turns ALL classes monitor_only → has_active_routing fails', async () => {
    const deps = freshDeps();
    for (const cls of ['red', 'orange', 'yellow', 'green'] as const) {
      deps.alertRoutingEngine.setOverride('BIL', {
        class: cls,
        primary_assignee: 'none',
        secondary_assignee: null,
        channels: ['in_app'],
        sla_hours: null,
        escalate_after_hours: null,
        monitor_only: true,
      });
    }
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'has_active_routing')!;
    expect(c.passing).toBe(false);
    expect(c.severity).toBe('blocking');
    expect(report.overall_status).toBe('blocked');
  });

  test('alert_routing_complete passes by default (defaults cover all 4 classes)', async () => {
    const deps = freshDeps();
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'alert_routing_complete')!;
    expect(c.passing).toBe(true);
  });

  test('audit_trail_active is info-severity; failure does not flip status', async () => {
    const deps = freshDeps(); // no audit events yet
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'audit_trail_active')!;
    expect(c.passing).toBe(false);
    expect(c.severity).toBe('info');
    // Pre-launch: no audit yet but the tenant is otherwise healthy → ready
    expect(report.overall_status).toBe('ready');
  });

  test('audit_trail_active passes when ≥1 event in last 7 days', async () => {
    const deps = freshDeps();
    deps.auditTrailStore.record(
      'BIL',
      {
        actor_username: 'a',
        actor_role: 'admin',
        action: 'auth.login',
        resource_type: 'session',
        resource_id: 's-1',
        outcome: 'success',
      },
      NOW,
    );
    const report = await runReadinessChecks('BIL', deps);
    const c = report.checks.find((x) => x.id === 'audit_trail_active')!;
    expect(c.passing).toBe(true);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/tenants/me/readiness', () => {
  test('admin BIL caller → 200 with report scoped to BIL', async () => {
    const { app } = makeRdyApp('admin');
    const r = await request(app).get('/v1/tenants/me/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(['ready', 'warnings', 'blocked']).toContain(r.body.body.overall_status);
    expect(Array.isArray(r.body.body.checks)).toBe(true);
  });

  test('non-admin → 403', async () => {
    const { app } = makeRdyApp('risk_analyst');
    const r = await request(app).get('/v1/tenants/me/readiness').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/tenants/:tenant_id/readiness', () => {
  test('valid tenant → 200', async () => {
    const { app } = makeRdyApp('admin');
    const r = await request(app).get('/v1/tenants/BIL/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('unregistered tenant → 200 with overall_status=blocked + only tenant_exists check', async () => {
    const { app } = makeRdyApp('admin');
    const r = await request(app).get('/v1/tenants/UNKNOWN_X/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.overall_status).toBe('blocked');
    expect(r.body.body.checks.length).toBe(1);
    expect(r.body.body.checks[0].id).toBe('tenant_exists');
    expect(r.body.body.checks[0].passing).toBe(false);
  });

  test('non-admin → 403', async () => {
    const { app } = makeRdyApp('risk_analyst');
    const r = await request(app).get('/v1/tenants/BIL/readiness').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('admin can probe another tenant (BANK_DEMO) from BIL context', async () => {
    const { app } = makeRdyApp('admin');
    const r = await request(app).get('/v1/tenants/BANK_DEMO/readiness').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
  });
});
