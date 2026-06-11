// @ts-nocheck
import request from 'supertest';
import { buildAdminConfigAuditSummary } from '../src/admin_config_audit_summary';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-11T12:00:00Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin') {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), getRole: () => role, now: () => NOW });
  return app;
}

describe('buildAdminConfigAuditSummary', () => {
  test('returns report with expected fields', () => {
    const r = buildAdminConfigAuditSummary('AUDIT_SUM_1', NOW);
    expect(r.tenant_id).toBe('AUDIT_SUM_1');
    expect(typeof r.total_config_changes).toBe('number');
    expect(Array.isArray(r.by_actor)).toBe(true);
  });
  test('by_category is defined', () => {
    const r = buildAdminConfigAuditSummary('AUDIT_SUM_2', NOW);
    expect(r.by_category).toBeDefined();
  });
  test('generated_at echoed', () => {
    const r = buildAdminConfigAuditSummary('AUDIT_SUM_3', NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });
  test('total_config_changes is non-negative', () => {
    const r = buildAdminConfigAuditSummary('AUDIT_SUM_4', NOW);
    expect(r.total_config_changes).toBeGreaterThanOrEqual(0);
  });
  test('most_changed_key is null or string', () => {
    const r = buildAdminConfigAuditSummary('AUDIT_SUM_5', NOW);
    expect(r.most_changed_key === null || typeof r.most_changed_key === 'string').toBe(true);
  });
  test('deterministic', () => {
    const a = buildAdminConfigAuditSummary('AUDIT_SUM_DET', NOW);
    const b = buildAdminConfigAuditSummary('AUDIT_SUM_DET', NOW);
    expect(a.total_config_changes).toBe(b.total_config_changes);
  });
});

describe('GET /v1/admin/config/audit-summary', () => {
  test('admin → 200', async () => {
    const res = await request(fakeApp()).get('/v1/admin/config/audit-summary').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('total_config_changes');
    expect(res.body.body).toHaveProperty('by_actor');
  });
  test('field_officer → 403', async () => {
    const res = await request(fakeApp('field_officer')).get('/v1/admin/config/audit-summary').set(H);
    expect(res.status).toBe(403);
  });
  test('no tenant → 400', async () => {
    const res = await request(fakeApp()).get('/v1/admin/config/audit-summary').set('X-Channel','API');
    expect(res.status).toBe(400);
  });
});
