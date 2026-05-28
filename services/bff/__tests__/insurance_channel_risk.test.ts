// services/bff/__tests__/insurance_channel_risk.test.ts
//
// Coverage for Insurance EWS Module 7 — Channel Risk. Pure builders
// (dashboard, agent analyze, high-risk list) + the 3 BFF routes.

import request from 'supertest';
import {
  buildChannelRiskDashboard,
  analyzeAgent,
  listHighRiskAgents,
  bandForRisk,
  severityFromBand,
  CHANNEL_TYPES,
  CHANNEL_RISK_BANDS,
  MIS_SELLING_INDICATORS,
  COMPLAINT_CATEGORIES,
  ChannelRiskError,
} from '../src/insurance_channel_risk';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');

function makeInsApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── bandForRisk / severityFromBand ───────────────────────────────────────

describe('bandForRisk', () => {
  test('boundary mapping', () => {
    expect(bandForRisk(0.24)).toBe('healthy');
    expect(bandForRisk(0.25)).toBe('watch');
    expect(bandForRisk(0.5)).toBe('elevated');
    expect(bandForRisk(0.75)).toBe('critical');
  });
});

describe('severityFromBand', () => {
  test('band → severity', () => {
    expect(severityFromBand('critical')).toBe('critical');
    expect(severityFromBand('elevated')).toBe('warning');
    expect(severityFromBand('watch')).toBe('info');
    expect(severityFromBand('healthy')).toBe('info');
  });
});

// ─── buildChannelRiskDashboard ─────────────────────────────────────────────

describe('buildChannelRiskDashboard — pure builder', () => {
  test('shape — totals + 4 widgets', () => {
    const d = buildChannelRiskDashboard('BANK_DEMO', NOW);
    expect(d.tenant_id).toBe('BANK_DEMO');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(Array.isArray(d.channel_risk_leaderboard)).toBe(true);
    expect(Array.isArray(d.channel_health)).toBe(true);
    expect(Array.isArray(d.mis_selling_alerts)).toBe(true);
    expect(Array.isArray(d.complaint_analytics)).toBe(true);
  });

  test('deterministic — same (tenant, day) identical', () => {
    const a = buildChannelRiskDashboard('BANK_DEMO', NOW);
    const b = buildChannelRiskDashboard('BANK_DEMO', NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('tenant divergence — BIL scores fewer agents', () => {
    const bank = buildChannelRiskDashboard('BANK_DEMO', NOW);
    const bil = buildChannelRiskDashboard('BIL', NOW);
    expect(bil.totals.agents_scored).toBeLessThan(bank.totals.agents_scored);
  });

  test('channel_risk_leaderboard — capped 10, ranked 1..n by risk desc', () => {
    const d = buildChannelRiskDashboard('BANK_DEMO', NOW);
    expect(d.channel_risk_leaderboard.length).toBeLessThanOrEqual(10);
    d.channel_risk_leaderboard.forEach((a, i) => expect(a.rank).toBe(i + 1));
    for (let i = 1; i < d.channel_risk_leaderboard.length; i++) {
      expect(d.channel_risk_leaderboard[i - 1].composite_risk).toBeGreaterThanOrEqual(d.channel_risk_leaderboard[i].composite_risk);
    }
  });

  test('every leaderboard row — composite in [0,1], 4 sub-scores, band matches', () => {
    const d = buildChannelRiskDashboard('BANK_DEMO', NOW);
    for (const a of d.channel_risk_leaderboard) {
      expect(a.composite_risk).toBeGreaterThanOrEqual(0);
      expect(a.composite_risk).toBeLessThanOrEqual(1);
      expect(a.sub_scores).toHaveProperty('persistency');
      expect(a.sub_scores).toHaveProperty('fraud');
      expect(a.sub_scores).toHaveProperty('complaint');
      expect(a.sub_scores).toHaveProperty('mis_selling');
      expect(a.band).toBe(bandForRisk(a.composite_risk));
    }
  });

  test('channel_health — one row per channel, worst-first by mean_risk', () => {
    const d = buildChannelRiskDashboard('BANK_DEMO', NOW);
    expect(d.channel_health).toHaveLength(CHANNEL_TYPES.length);
    expect(new Set(d.channel_health.map((c) => c.channel)).size).toBe(CHANNEL_TYPES.length);
    for (let i = 1; i < d.channel_health.length; i++) {
      expect(d.channel_health[i - 1].mean_risk).toBeGreaterThanOrEqual(d.channel_health[i].mean_risk);
    }
  });

  test('mis_selling_alerts — open only, capped 12, severity-sorted', () => {
    const d = buildChannelRiskDashboard('BANK_DEMO', NOW);
    expect(d.mis_selling_alerts.length).toBeLessThanOrEqual(12);
    for (const m of d.mis_selling_alerts) {
      expect(m.status).toBe('open');
      expect(MIS_SELLING_INDICATORS).toContain(m.indicator);
    }
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < d.mis_selling_alerts.length; i++) {
      expect(rank[d.mis_selling_alerts[i - 1].severity]).toBeLessThanOrEqual(rank[d.mis_selling_alerts[i].severity]);
    }
  });

  test('complaint_analytics — one row per category, resolved+pending=count', () => {
    const d = buildChannelRiskDashboard('BANK_DEMO', NOW);
    expect(d.complaint_analytics).toHaveLength(COMPLAINT_CATEGORIES.length);
    for (const c of d.complaint_analytics) {
      expect(c.resolved + c.pending).toBe(c.count_30d);
      expect(['up', 'flat', 'down']).toContain(c.trend);
    }
  });

  test('totals consistency', () => {
    const d = buildChannelRiskDashboard('BANK_DEMO', NOW);
    expect(d.totals.agents_scored).toBeGreaterThan(0);
    expect(d.totals.high_risk_agents).toBeLessThanOrEqual(d.totals.agents_scored);
    expect(d.totals.critical_agents).toBeLessThanOrEqual(d.totals.agents_scored);
    expect(d.totals.complaints_30d).toBe(d.complaint_analytics.reduce((a, c) => a + c.count_30d, 0));
  });

  test('empty tenant_id throws', () => {
    expect(() => buildChannelRiskDashboard('', NOW)).toThrow(ChannelRiskError);
  });
});

// ─── listHighRiskAgents ────────────────────────────────────────────────────

describe('listHighRiskAgents — pure builder', () => {
  test('default returns all, ranked worst-first', () => {
    const l = listHighRiskAgents('BANK_DEMO', NOW);
    expect(l.channel_filter).toBe('all');
    expect(l.band_filter).toBe('all');
    for (let i = 1; i < l.agents.length; i++) {
      expect(l.agents[i - 1].composite_risk).toBeGreaterThanOrEqual(l.agents[i].composite_risk);
    }
  });

  test('channel filter narrows', () => {
    const l = listHighRiskAgents('BANK_DEMO', NOW, { channel: 'broker' });
    for (const a of l.agents) expect(a.channel).toBe('broker');
  });

  test('band filter narrows', () => {
    const l = listHighRiskAgents('BANK_DEMO', NOW, { band: 'critical' });
    for (const a of l.agents) expect(a.band).toBe('critical');
  });

  test('limit caps rows', () => {
    const l = listHighRiskAgents('BANK_DEMO', NOW, { limit: 3 });
    expect(l.agents.length).toBeLessThanOrEqual(3);
  });

  test('invalid channel throws', () => {
    expect(() => listHighRiskAgents('BANK_DEMO', NOW, { channel: 'nonsense' })).toThrow(ChannelRiskError);
  });
  test('invalid band throws', () => {
    expect(() => listHighRiskAgents('BANK_DEMO', NOW, { band: 'nonsense' })).toThrow(ChannelRiskError);
  });
});

// ─── analyzeAgent ──────────────────────────────────────────────────────────

describe('analyzeAgent — ad-hoc', () => {
  test('clean agent scores low, no action', () => {
    const r = analyzeAgent({ persistency_13m: 0.95, fraud_flag_count: 0, complaint_rate: 0, free_look_cancellation_rate: 0, early_surrender_rate: 0, suitability_mismatch_rate: 0 }, NOW);
    expect(r.composite_risk).toBeLessThan(0.25);
    expect(r.band).toBe('healthy');
    expect(r.requires_action).toBe(false);
  });

  test('fraud flags drive risk up', () => {
    const clean = analyzeAgent({ fraud_flag_count: 0 }, NOW);
    const hot = analyzeAgent({ fraud_flag_count: 5 }, NOW);
    expect(hot.composite_risk).toBeGreaterThan(clean.composite_risk);
    expect(hot.sub_scores.fraud).toBeGreaterThan(clean.sub_scores.fraud);
  });

  test('low persistency drives persistency sub-score up', () => {
    const r = analyzeAgent({ persistency_13m: 0.4 }, NOW);
    expect(r.sub_scores.persistency).toBeGreaterThan(0.5);
  });

  test('mis-selling signals drive mis_selling sub-score', () => {
    const r = analyzeAgent({ free_look_cancellation_rate: 0.8, early_surrender_rate: 0.7, suitability_mismatch_rate: 0.9 }, NOW);
    expect(r.sub_scores.mis_selling).toBeGreaterThan(0.5);
  });

  test('stacked signals → elevated/critical + requires_action', () => {
    const r = analyzeAgent({ persistency_13m: 0.4, fraud_flag_count: 4, complaint_rate: 0.5, free_look_cancellation_rate: 0.6, early_surrender_rate: 0.6, suitability_mismatch_rate: 0.8 }, NOW);
    expect(['elevated', 'critical']).toContain(r.band);
    expect(r.requires_action).toBe(true);
  });

  test('drivers sorted by weight desc, composite matches band', () => {
    const r = analyzeAgent({ fraud_flag_count: 3, free_look_cancellation_rate: 0.5 }, NOW);
    for (let i = 1; i < r.drivers.length; i++) {
      expect(r.drivers[i - 1].weight).toBeGreaterThanOrEqual(r.drivers[i].weight);
    }
    expect(r.band).toBe(bandForRisk(r.composite_risk));
  });

  test('channel echoed + defaults to agent', () => {
    expect(analyzeAgent({}, NOW).channel).toBe('agent');
    expect(analyzeAgent({ channel: 'bancassurance' }, NOW).channel).toBe('bancassurance');
  });

  test('deterministic', () => {
    const a = analyzeAgent({ fraud_flag_count: 2 }, NOW);
    const b = analyzeAgent({ fraud_flag_count: 2 }, NOW);
    expect(a.composite_risk).toBe(b.composite_risk);
  });

  test('composite clamped to [0,1]', () => {
    const r = analyzeAgent({ persistency_13m: 0, fraud_flag_count: 99, complaint_rate: 1, free_look_cancellation_rate: 1, early_surrender_rate: 1, suitability_mismatch_rate: 1 }, NOW);
    expect(r.composite_risk).toBeLessThanOrEqual(1);
    expect(r.composite_risk).toBeGreaterThanOrEqual(0);
  });

  test('invalid channel throws', () => {
    expect(() => analyzeAgent({ channel: 'nonsense' }, NOW)).toThrow(ChannelRiskError);
  });
  test('negative fraud_flag_count throws', () => {
    expect(() => analyzeAgent({ fraud_flag_count: -1 }, NOW)).toThrow(ChannelRiskError);
  });
  test('out-of-range rate throws', () => {
    expect(() => analyzeAgent({ complaint_rate: 1.5 }, NOW)).toThrow(ChannelRiskError);
  });
  test('non-object throws', () => {
    expect(() => analyzeAgent(null as never, NOW)).toThrow(ChannelRiskError);
  });
});

// ─── enum exports ───────────────────────────────────────────────────────────

describe('exports', () => {
  test('CHANNEL_TYPES has 5', () => {
    expect(CHANNEL_TYPES).toEqual(['agent', 'broker', 'bancassurance', 'direct', 'online']);
  });
  test('CHANNEL_RISK_BANDS canonical', () => {
    expect(CHANNEL_RISK_BANDS).toEqual(['healthy', 'watch', 'elevated', 'critical']);
  });
  test('MIS_SELLING_INDICATORS has 4', () => {
    expect(MIS_SELLING_INDICATORS).toEqual(['free_look_cancellation', 'early_surrender', 'suitability_mismatch', 'churning']);
  });
  test('COMPLAINT_CATEGORIES has 5', () => {
    expect(COMPLAINT_CATEGORIES).toHaveLength(5);
  });
});

// ─── routes ───────────────────────────────────────────────────────────────

describe('GET /v1/insurance/channel-risk/dashboard', () => {
  test('admin happy path — enveloped', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/channel-risk/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.channel_risk_leaderboard).toBeDefined();
    expect(r.body.body.channel_health).toBeDefined();
    expect(r.body.body.mis_selling_alerts).toBeDefined();
    expect(r.body.body.complaint_analytics).toBeDefined();
  });

  test('field_officer (read) accepted', async () => {
    const r = await request(makeInsApp('field_officer').app).get('/v1/insurance/channel-risk/dashboard').set(TH);
    expect(r.status).toBe(200);
  });

  test('tenant scoping — BIL diverges', async () => {
    const bank = await request(makeInsApp('admin').app).get('/v1/insurance/channel-risk/dashboard').set(TH);
    const bil = await request(makeInsApp('admin').app).get('/v1/insurance/channel-risk/dashboard').set(TH_BIL);
    expect(bil.body.body.totals.agents_scored).toBeLessThan(bank.body.body.totals.agents_scored);
  });

  test('missing tenant header → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/channel-risk/dashboard').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
  });
});

describe('POST /v1/insurance/channel-risk/analyze', () => {
  test('analyst happy path', async () => {
    const r = await request(makeInsApp('risk_analyst').app)
      .post('/v1/insurance/channel-risk/analyze')
      .set(TH)
      .send({ persistency_13m: 0.5, fraud_flag_count: 2, complaint_rate: 0.3, free_look_cancellation_rate: 0.4 });
    expect(r.status).toBe(200);
    expect(r.body.body.composite_risk).toBeGreaterThan(0);
    expect(r.body.body.drivers).toBeDefined();
    expect(r.body.body.sub_scores).toBeDefined();
  });

  test('enveloped body accepted', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/channel-risk/analyze')
      .set(TH)
      .send({ header: {}, body: { agent_id: 'AGT-X', fraud_flag_count: 1 } });
    expect(r.status).toBe(200);
    expect(r.body.body.agent_id).toBe('AGT-X');
  });

  test('invalid channel → 400', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/channel-risk/analyze')
      .set(TH)
      .send({ channel: 'bogus' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_channel');
  });

  test('out-of-range rate → 400', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/channel-risk/analyze')
      .set(TH)
      .send({ complaint_rate: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_value');
  });

  test('field_officer lacks analyze scope → 403', async () => {
    const r = await request(makeInsApp('field_officer').app)
      .post('/v1/insurance/channel-risk/analyze')
      .set(TH)
      .send({ fraud_flag_count: 1 });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/insurance/channel-risk/high-risk', () => {
  test('happy path', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/channel-risk/high-risk').set(TH);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.agents)).toBe(true);
  });

  test('?channel=broker narrows', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/channel-risk/high-risk?channel=broker').set(TH);
    for (const a of r.body.body.agents) expect(a.channel).toBe('broker');
  });

  test('?channel=bogus → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/channel-risk/high-risk?channel=bogus').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_channel');
  });

  test('?band=bogus → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/channel-risk/high-risk?band=bogus').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_value');
  });
});
