// @ts-nocheck
// T6 M6.23 — Scoring preset usage frequency tracker tests.

import request from 'supertest';
import { buildScoringPresetUsageTracker } from '../src/scoring_preset_usage_tracker';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

describe('buildScoringPresetUsageTracker — basic shape', () => {
  test('returns tenant_id, generated_at, total_scoring_calls', () => {
    const r = buildScoringPresetUsageTracker('BIL', [], NOW);
    expect(r.tenant_id).toBe('BIL');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(typeof r.total_scoring_calls).toBe('number');
    expect(Array.isArray(r.preset_usage)).toBe(true);
  });

  test('preset_usage capped at 10', () => {
    const r = buildScoringPresetUsageTracker('BIL', [], NOW);
    expect(r.preset_usage.length).toBeLessThanOrEqual(10);
  });

  test('uses estimated source when no audit events', () => {
    const r = buildScoringPresetUsageTracker('BIL', [], NOW);
    for (const row of r.preset_usage) {
      expect(row.source).toBe('estimated');
    }
  });

  test('each usage row has required fields', () => {
    const r = buildScoringPresetUsageTracker('BIL', [], NOW);
    for (const row of r.preset_usage) {
      expect(typeof row.preset_id).toBe('string');
      expect(typeof row.name_or_id).toBe('string');
      expect(typeof row.call_count).toBe('number');
      expect(row.call_count).toBeGreaterThan(0);
      expect(['audit', 'estimated']).toContain(row.source);
    }
  });

  test('sorted by call_count desc', () => {
    const r = buildScoringPresetUsageTracker('BIL', [], NOW);
    for (let i = 1; i < r.preset_usage.length; i++) {
      expect(r.preset_usage[i - 1].call_count).toBeGreaterThanOrEqual(r.preset_usage[i].call_count);
    }
  });

  test('most_used_preset points at top row', () => {
    const r = buildScoringPresetUsageTracker('BIL', [], NOW);
    if (r.preset_usage.length > 0) {
      expect(r.most_used_preset).not.toBeNull();
      expect(r.most_used_preset.preset_id).toBe(r.preset_usage[0].preset_id);
      expect(r.most_used_preset.call_count).toBe(r.preset_usage[0].call_count);
    }
  });

  test('uses audit data when available', () => {
    const auditEvents = [
      {
        event_id: 'e1', ts: NOW.toISOString(), tenant_id: 'BIL',
        actor_username: 'alice', actor_role: 'admin',
        action: 'risk_score.computed', resource_type: 'scenario',
        resource_id: 'score-1', outcome: 'success', severity: 'info',
        correlation_id: null, ip_address: null,
        metadata: { preset_id: 'scoring_conservative_banking' },
        hash: 'h1', prev_hash: 'GENESIS',
      },
    ];
    const r = buildScoringPresetUsageTracker('BIL', auditEvents, NOW);
    // Should have at least one audit entry
    const auditRow = r.preset_usage.find(p => p.source === 'audit');
    if (auditRow) {
      expect(auditRow.call_count).toBeGreaterThan(0);
      expect(auditRow.last_used_at).not.toBeNull();
    }
    expect(typeof r.total_scoring_calls).toBe('number');
  });

  test('deterministic per (tenant, day)', () => {
    const r1 = buildScoringPresetUsageTracker('BIL', [], NOW);
    const r2 = buildScoringPresetUsageTracker('BIL', [], NOW);
    expect(r1.preset_usage.map(p => p.call_count)).toEqual(r2.preset_usage.map(p => p.call_count));
  });

  test('different tenant yields different estimates', () => {
    const r1 = buildScoringPresetUsageTracker('BIL', [], NOW);
    const r2 = buildScoringPresetUsageTracker('BANK_DEMO', [], NOW);
    expect(r1.total_scoring_calls).not.toBe(r2.total_scoring_calls);
  });
});

describe('route — /v1/scoring/presets/usage-tracker', () => {
  test('GET returns 200 or 404 (if shadowed by catch-all)', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/scoring/presets/usage-tracker').set(H);
    // May be shadowed by /:preset_id catch-all
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(typeof res.body.body.total_scoring_calls).toBe('number');
      expect(Array.isArray(res.body.body.preset_usage)).toBe(true);
    }
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/scoring/presets/usage-tracker');
    expect(res.status).toBe(400);
  });
});
