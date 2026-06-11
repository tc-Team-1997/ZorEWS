// @ts-nocheck
// T6 M13.26 — Config rollback readiness assessment.

import request from 'supertest';
import { buildConfigRollbackReadiness } from '../src/config_rollback_readiness';
import { InMemoryConfigStore } from '../src/admin_config';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeReadinessApp(role = 'admin', configStore = new InMemoryConfigStore(), auditStore = new InMemoryAuditTrailStore()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, configStore, auditTrailStore: auditStore });
  return app;
}

describe('M13.26 — no overrides', () => {
  test('empty overrides → readiness_score 100', () => {
    const configStore = new InMemoryConfigStore();
    const auditStore = new InMemoryAuditTrailStore();
    const out = buildConfigRollbackReadiness('BIL', configStore, auditStore, NOW);
    expect(out.total_overrides).toBe(0);
    expect(out.readiness_score).toBe(100);
    expect(out.safe_count).toBe(0);
  });
});

describe('M13.26 — with overrides', () => {
  test('override without audit trail → high_risk', () => {
    const configStore = new InMemoryConfigStore();
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', new Date(NOW.getTime() - 10 * 86400000));
    const auditStore = new InMemoryAuditTrailStore();
    const out = buildConfigRollbackReadiness('BIL', configStore, auditStore, NOW);
    expect(out.total_overrides).toBe(1);
    expect(out.high_risk_count).toBe(1);
    expect(out.overrides[0].has_audit_trail).toBe(false);
    expect(out.overrides[0].rollback_risk).toBe('high_risk');
  });

  test('override with recent audit trail → safe', () => {
    const configStore = new InMemoryConfigStore();
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', new Date(NOW.getTime() - 10 * 86400000));
    const auditStore = new InMemoryAuditTrailStore();
    auditStore.record('BIL', { actor_username: 'alice', actor_role: 'admin', action: 'config.update', resource_type: 'config', resource_id: 'alerts.red_sla_hours', outcome: 'success', severity: 'info', metadata: { new_value: 2 } }, new Date(NOW.getTime() - 5 * 86400000));
    const out = buildConfigRollbackReadiness('BIL', configStore, auditStore, NOW);
    expect(out.safe_count).toBeGreaterThan(0);
    expect(out.overrides[0].has_audit_trail).toBe(true);
    expect(out.overrides[0].rollback_risk).toBe('safe');
  });

  test('readiness_score in [0,100]', () => {
    const configStore = new InMemoryConfigStore();
    configStore.set('BIL', 'alerts.red_sla_hours', 2, 'alice', NOW);
    const auditStore = new InMemoryAuditTrailStore();
    const out = buildConfigRollbackReadiness('BIL', configStore, auditStore, NOW);
    expect(out.readiness_score).toBeGreaterThanOrEqual(0);
    expect(out.readiness_score).toBeLessThanOrEqual(100);
  });

  test('recommendations is array', () => {
    const configStore = new InMemoryConfigStore();
    const auditStore = new InMemoryAuditTrailStore();
    const out = buildConfigRollbackReadiness('BIL', configStore, auditStore, NOW);
    expect(Array.isArray(out.recommendations)).toBe(true);
  });
});

describe('M13.26 — route', () => {
  test('admin GET /v1/admin/config/rollback-readiness returns 200', async () => {
    const app = makeReadinessApp();
    const res = await request(app).get('/v1/admin/config/rollback-readiness').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('readiness_score');
  });

  test('non-admin gets 403', async () => {
    const app = makeReadinessApp('field_officer');
    const res = await request(app).get('/v1/admin/config/rollback-readiness').set(TH);
    expect(res.status).toBe(403);
  });
});
