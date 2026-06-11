// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildTenantProductionReadiness } from '../src/tenant_production_readiness';
import { InMemoryOnboardingStore } from '../src/tenant_onboarding';
import { InMemoryApiKeyStore } from '../src/api_keys';
import { WebhookSubscriptionStore } from '../src/webhooks/store';
import { InMemoryAlertRoutingEngine } from '../src/alert_routing';
import { InMemoryConfigStore } from '../src/admin_config';
import { InMemoryScenarioStore } from '../src/scenario/store';
import { RuleStore } from '../src/rules/store';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { StubEmailTransport } from '../src/notifications/email';

const NOW = new Date('2026-06-11T12:00:00Z');

function makeDeps() {
  return {
    onboardingStore: new InMemoryOnboardingStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
    webhookStore: new WebhookSubscriptionStore(),
    alertRoutingEngine: new InMemoryAlertRoutingEngine(),
    configStore: new InMemoryConfigStore(),
    scenarioStore: new InMemoryScenarioStore(),
    ruleStore: new RuleStore([]),
    caseInvestigationStore: new InMemoryCaseInvestigationStore(),
    auditTrailStore: new InMemoryAuditTrailStore(),
    emailTransport: new StubEmailTransport(),
  };
}

describe('buildTenantProductionReadiness', () => {
  it('returns D grade for empty tenant', async () => {
    const deps = makeDeps();
    const out = await buildTenantProductionReadiness('BIL', NOW, deps);
    expect(out.tenant_id).toBe('BIL');
    expect(out.readiness_grade).toBe('D');
    expect(out.criteria.length).toBe(10);
    expect(out.criteria.every(c => typeof c.passed === 'boolean')).toBe(true);
  });

  it('passes onboarding_complete when is_complete = true', async () => {
    const deps = makeDeps();
    // Mark all required steps
    const steps = ['tenant_provisioned','channels_configured','vertical_set','config_baseline','email_channel','alert_routing','audit_active'];
    for (const s of steps) {
      deps.onboardingStore.markStep('BIL', s, 'completed', 'admin', null, NOW);
    }
    const out = await buildTenantProductionReadiness('BIL', NOW, deps);
    const onboardingCrit = out.criteria.find(c => c.name === 'onboarding_complete');
    expect(onboardingCrit.passed).toBe(true);
    expect(onboardingCrit.points_earned).toBe(100);
  });

  it('has blocking_criteria for unpassed high-point criteria', async () => {
    const deps = makeDeps();
    const out = await buildTenantProductionReadiness('BIL', NOW, deps);
    expect(Array.isArray(out.blocking_criteria)).toBe(true);
    expect(Array.isArray(out.next_steps)).toBe(true);
    expect(out.next_steps.length).toBeGreaterThan(0);
  });

  it('normalizes score to 0-100', async () => {
    const deps = makeDeps();
    const out = await buildTenantProductionReadiness('BIL', NOW, deps);
    expect(out.readiness_score).toBeGreaterThanOrEqual(0);
    expect(out.readiness_score).toBeLessThanOrEqual(100);
  });
});

describe('GET /v1/tenants/production-readiness', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/tenants/production-readiness')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.criteria.length).toBe(10);
  });

  it('returns 403 for non-admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/tenants/production-readiness')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
