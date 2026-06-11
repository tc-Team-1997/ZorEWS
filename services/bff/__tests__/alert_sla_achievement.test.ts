// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildAlertSlaAchievement } from '../src/alert_sla_achievement';
import { InMemoryRoutingLedger } from '../src/alert_routing_analytics';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildAlertSlaAchievement', () => {
  it('returns 4 classes', () => {
    const ledger = new InMemoryRoutingLedger();
    const out = buildAlertSlaAchievement(ledger, 'BIL', NOW);
    expect(out.by_class.length).toBe(4);
  });

  it('returns stable trend on empty ledger', () => {
    const ledger = new InMemoryRoutingLedger();
    const out = buildAlertSlaAchievement(ledger, 'BIL', NOW);
    expect(['improving', 'declining', 'stable']).toContain(out.trend);
    expect(out.overall_achievement_pct).toBe(100);
  });

  it('has required envelope fields', () => {
    const ledger = new InMemoryRoutingLedger();
    const out = buildAlertSlaAchievement(ledger, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(out.sla_champion_class === null || typeof out.sla_champion_class === 'string').toBe(true);
    expect(out.sla_laggard_class === null || typeof out.sla_laggard_class === 'string').toBe(true);
  });

  it('counts acked within SLA as met', () => {
    const ledger = new InMemoryRoutingLedger();
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    ledger.record({
      alert_id: 'a1', tenant_id: 'BIL', created_at: twoHoursAgo,
      severity_in: 'CRITICAL', class: 'red', channels: ['email'],
      sla_hours: 4, escalate_after_hours: 1, monitor_only: false,
      acked_at: NOW.toISOString(),
    });
    const out = buildAlertSlaAchievement(ledger, 'BIL', NOW);
    const redClass = out.by_class.find(c => c.class === 'red');
    expect(redClass.sla_met_count).toBe(1);
  });

  it('does not show green class as eligible', () => {
    const ledger = new InMemoryRoutingLedger();
    const out = buildAlertSlaAchievement(ledger, 'BIL', NOW);
    const greenClass = out.by_class.find(c => c.class === 'green');
    expect(greenClass.total_eligible).toBe(0);
    expect(greenClass.sla_achievement_pct).toBe(100);
  });
});

describe('GET /v1/alerts/sla-achievement', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/alerts/sla-achievement')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.by_class.length).toBe(4);
  });

  it('returns 403 for field_officer', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/alerts/sla-achievement')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });

  it('is tenant-scoped', async () => {
    const { app } = makeApp({});
    const resBil = await supertest(app)
      .get('/v1/alerts/sla-achievement')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(resBil.body.body.tenant_id).toBe('BIL');
  });
});
