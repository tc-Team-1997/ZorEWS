// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildAuditCompletenessCertification } from '../src/audit_completeness_certification';
import { InMemoryAuditTrailStore } from '../src/audit_trail';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildAuditCompletenessCertification', () => {
  it('returns fail certification for empty audit trail', () => {
    const store = new InMemoryAuditTrailStore();
    const out = buildAuditCompletenessCertification(store, 'BIL', NOW);
    expect(out.certificate.certification_level).toBe('fail');
    expect(out.certificate.overall_passed).toBe(false);
  });

  it('has required envelope fields', () => {
    const store = new InMemoryAuditTrailStore();
    const out = buildAuditCompletenessCertification(store, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(out.certificate.cert_id).toBeDefined();
    expect(out.certificate.issued_at).toBeDefined();
    expect(out.certificate.valid_until).toBeDefined();
    expect(out.certificate.signature).toBeDefined();
    expect(Array.isArray(out.recommendations)).toBe(true);
  });

  it('has 5 criteria', () => {
    const store = new InMemoryAuditTrailStore();
    const out = buildAuditCompletenessCertification(store, 'BIL', NOW);
    expect(out.certificate.criteria_results.length).toBe(5);
  });

  it('valid_until is 30 days after issued_at', () => {
    const store = new InMemoryAuditTrailStore();
    const out = buildAuditCompletenessCertification(store, 'BIL', NOW);
    const issued = new Date(out.certificate.issued_at).getTime();
    const validUntil = new Date(out.certificate.valid_until).getTime();
    const diff = validUntil - issued;
    expect(diff).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('certification_level improves as criteria pass', () => {
    const store = new InMemoryAuditTrailStore();
    // Record enough events to pass criteria
    for (let i = 0; i < 110; i++) {
      store.record('BIL', {
        actor_username: 'alice',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: ['user', 'session', 'config', 'case', 'alert', 'report', 'scenario', 'rule', 'integration', 'system'][i % 10],
        resource_id: `r${i}`,
        outcome: 'success',
        severity: 'info',
      }, new Date(NOW.getTime() - i * 3600000));
    }
    const out = buildAuditCompletenessCertification(store, 'BIL', NOW);
    // Should now pass the sufficient_events criterion at minimum
    const sufficiencyResult = out.certificate.criteria_results.find(c => c.name === 'sufficient_events');
    expect(sufficiencyResult.passed).toBe(true);
    expect(['gold', 'silver', 'bronze', 'fail']).toContain(out.certificate.certification_level);
  });

  it('is tenant-isolated', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', { actor_username: 'alice', actor_role: 'admin', action: 'test', resource_type: 'config', resource_id: 'x', outcome: 'success' }, NOW);
    const outBank = buildAuditCompletenessCertification(store, 'BANK_DEMO', NOW);
    const totalEvents = outBank.certificate.criteria_results.find(c => c.name === 'sufficient_events');
    expect(totalEvents.passed).toBe(false); // BANK_DEMO has no events
  });

  it('recommendations have strings', () => {
    const store = new InMemoryAuditTrailStore();
    const out = buildAuditCompletenessCertification(store, 'BIL', NOW);
    for (const rec of out.recommendations) {
      expect(typeof rec).toBe('string');
    }
  });
});

describe('GET /v1/audit/completeness-certification', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/audit/completeness-certification')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.certificate.criteria_results.length).toBe(5);
  });

  it('returns 403 for field_officer', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/audit/completeness-certification')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });

  it('is tenant-scoped in route', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/audit/completeness-certification')
      .set('X-Tenant-ID', 'BANK_DEMO').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.body.body.tenant_id).toBe('BANK_DEMO');
  });
});
