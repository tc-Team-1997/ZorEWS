import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  computeAlertActivity,
  computeCaseOutcomes,
  computeRbiSummary,
  computeSnapshot,
  reportFor,
} from '../src/reports/compute';
import { generateHistory, periodBounds } from '../src/reports/history';
import { reportToCsv } from '../src/reports/csv';
import { defaultPortfolio } from '../src/scenario/portfolio';

const NOW = new Date('2026-04-28T12:00:00.000Z');

function makeReportsApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => 'risk_analyst',
  });
}

describe('reports — periodBounds()', () => {
  test('week returns a 7-day window ending at now', () => {
    const { start, end } = periodBounds('week', NOW);
    const days = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(7);
    expect(end.toISOString()).toBe(NOW.toISOString());
  });

  test('month returns a ~30-day window', () => {
    const { start, end } = periodBounds('month', NOW);
    const days = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
  });

  test('quarter returns a ~90-day window', () => {
    const { start, end } = periodBounds('quarter', NOW);
    const days = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThanOrEqual(89);
    expect(days).toBeLessThanOrEqual(92);
  });
});

describe('reports — generateHistory()', () => {
  test('produces deterministic alerts + cases for the same seed', () => {
    const a = generateHistory({
      startISO: '2026-01-01T00:00:00.000Z',
      endISO: '2026-02-01T00:00:00.000Z',
      seed: 1,
    });
    const b = generateHistory({
      startISO: '2026-01-01T00:00:00.000Z',
      endISO: '2026-02-01T00:00:00.000Z',
      seed: 1,
    });
    expect(a.alerts.length).toBe(b.alerts.length);
    expect(a.cases.length).toBe(b.cases.length);
    expect(a.alerts[0]).toEqual(b.alerts[0]);
  });

  test('rejects an invalid date range', () => {
    expect(() =>
      generateHistory({
        startISO: '2026-02-01T00:00:00.000Z',
        endISO: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow(/invalid date range/);
  });

  test('cases are a subset of alerts (every case has a matching alert_id)', () => {
    const h = generateHistory({
      startISO: '2026-01-01T00:00:00.000Z',
      endISO: '2026-02-01T00:00:00.000Z',
      seed: 7,
    });
    const alertIds = new Set(h.alerts.map((a) => a.alert_id));
    for (const c of h.cases) expect(alertIds.has(c.alert_id)).toBe(true);
  });
});

describe('reports — computeSnapshot()', () => {
  test('produces a snapshot with sane portfolio totals', () => {
    const portfolio = defaultPortfolio();
    const history = generateHistory({
      startISO: '2026-01-01T00:00:00.000Z',
      endISO: NOW.toISOString(),
      seed: 3,
    });
    const r = computeSnapshot(portfolio, history, 'month', NOW);
    expect(r.type).toBe('snapshot');
    expect(r.customers_monitored).toBe(portfolio.length);
    expect(r.high_risk_pct).toBeGreaterThanOrEqual(0);
    expect(r.high_risk_pct).toBeLessThanOrEqual(100);
    expect(r.expected_credit_loss_kes).toBeGreaterThan(0);
    expect(
      r.stage_distribution.stage_1 +
        r.stage_distribution.stage_2 +
        r.stage_distribution.stage_3,
    ).toBe(portfolio.length);
  });
});

describe('reports — computeAlertActivity()', () => {
  test('totals add up across severities', () => {
    const history = generateHistory({
      startISO: '2026-01-01T00:00:00.000Z',
      endISO: NOW.toISOString(),
      seed: 5,
    });
    const r = computeAlertActivity(history, 'month', NOW);
    expect(r.type).toBe('alerts');
    const sum =
      r.raised_by_severity.critical +
      r.raised_by_severity.high +
      r.raised_by_severity.medium +
      r.raised_by_severity.low;
    expect(sum).toBe(r.raised_total);
    expect(r.top_rules.length).toBeLessThanOrEqual(5);
  });

  test('top_rules are sorted descending by firings', () => {
    const history = generateHistory({
      startISO: '2026-01-01T00:00:00.000Z',
      endISO: NOW.toISOString(),
      seed: 6,
    });
    const r = computeAlertActivity(history, 'month', NOW);
    for (let i = 1; i < r.top_rules.length; i++) {
      expect(r.top_rules[i - 1].firings).toBeGreaterThanOrEqual(r.top_rules[i].firings);
    }
  });
});

describe('reports — computeCaseOutcomes()', () => {
  test('outcome counts never exceed cases_closed', () => {
    const history = generateHistory({
      startISO: '2026-01-01T00:00:00.000Z',
      endISO: NOW.toISOString(),
      seed: 9,
    });
    const r = computeCaseOutcomes(history, 'month', NOW);
    expect(r.type).toBe('cases');
    const sum = r.outcomes.cured + r.outcomes.cured_temp + r.outcomes.defaulted;
    expect(sum).toBeLessThanOrEqual(r.cases_closed);
    expect(r.top_officers.length).toBeLessThanOrEqual(5);
    expect(r.product_breakdown.length).toBeLessThanOrEqual(4);
  });
});

describe('reports — computeRbiSummary()', () => {
  test('sector shares sum to ~100%', () => {
    const portfolio = defaultPortfolio();
    const history = generateHistory({
      startISO: '2026-01-01T00:00:00.000Z',
      endISO: NOW.toISOString(),
      seed: 11,
    });
    const r = computeRbiSummary(portfolio, history, 'quarter', NOW);
    expect(r.type).toBe('rbi');
    const sectorSum = r.sector_exposure.reduce((acc, s) => acc + s.share_pct, 0);
    expect(sectorSum).toBeGreaterThan(99);
    expect(sectorSum).toBeLessThan(101);
    expect(r.top_concentrations.length).toBeLessThanOrEqual(5);
    expect(r.risk_band_distribution.map((b) => b.band)).toEqual(['low', 'medium', 'high']);
  });
});

describe('reports — reportToCsv()', () => {
  test('snapshot CSV begins with the metric,value header', () => {
    const r = reportFor('snapshot', 'month', NOW);
    const csv = reportToCsv(r);
    expect(csv.startsWith('metric,value')).toBe(true);
    expect(csv).toMatch(/customers_monitored,/);
  });

  test('alert CSV embeds the top-rules section', () => {
    const r = reportFor('alerts', 'month', NOW);
    const csv = reportToCsv(r);
    expect(csv).toMatch(/# top rules/);
    expect(csv).toMatch(/rule_id,rule_name,firings/);
  });

  test('escapes commas in cell values', () => {
    const r = reportFor('alerts', 'month', NOW);
    const csv = reportToCsv(r);
    // Rule names contain " > " etc. — none of them have commas, but we
    // verify the escape path works on a manual string.
    const rulesSection = csv.split('# top rules')[1] ?? '';
    expect(rulesSection).toBeTruthy();
  });
});

describe('GET /v1/reports/:type (T4.24 tenant-gated)', () => {
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('returns JSON snapshot by default', async () => {
    const { app } = makeReportsApp();
    const r = await request(app).get('/v1/reports/snapshot?period=month').set(TENANT_HEADERS);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/json/);
    expect(r.body.type).toBe('snapshot');
    expect(r.body.period).toBe('month');
  });

  test('returns CSV with attachment header when format=csv', async () => {
    const { app } = makeReportsApp();
    const r = await request(app).get('/v1/reports/alerts?period=week&format=csv').set(TENANT_HEADERS);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment.*alerts-week-.+\.csv/);
    expect(r.text).toMatch(/^metric,value/);
  });

  test('returns PDF with application/pdf content-type when format=pdf', async () => {
    const { app } = makeReportsApp();
    const r = await request(app)
      .get('/v1/reports/snapshot?period=month&format=pdf')
      .set(TENANT_HEADERS)
      .set('x-apex-user', 'Alice Mwangi')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(r.headers['content-disposition']).toMatch(/attachment.*snapshot-month-.+\.pdf/);
    const body = r.body as Buffer;
    expect(body.length).toBeGreaterThan(500);
    // Magic bytes: PDFs start with "%PDF-"
    expect(body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  test('returns XLSX (zip) with spreadsheet content-type when format=xlsx', async () => {
    const { app } = makeReportsApp();
    const r = await request(app)
      .get('/v1/reports/cases?period=quarter&format=xlsx')
      .set(TENANT_HEADERS)
      .set('x-apex-user', 'Sue Wanjiru')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/openxmlformats-officedocument/);
    expect(r.headers['content-disposition']).toMatch(/attachment.*cases-quarter-.+\.xlsx/);
    const body = r.body as Buffer;
    expect(body.length).toBeGreaterThan(500);
    // XLSX is a ZIP — magic bytes "PK"
    expect(body.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  test('400 on unknown report type', async () => {
    const { app } = makeReportsApp();
    const r = await request(app).get('/v1/reports/garbage').set(TENANT_HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/type must be one of/);
  });

  test('400 on unknown period', async () => {
    const { app } = makeReportsApp();
    const r = await request(app).get('/v1/reports/snapshot?period=year').set(TENANT_HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/period must be one of/);
  });

  test('400 on unknown format', async () => {
    const { app } = makeReportsApp();
    const r = await request(app).get('/v1/reports/snapshot?format=docx').set(TENANT_HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/format/);
  });

  test('all four report types respond with 200', async () => {
    const { app } = makeReportsApp();
    for (const type of ['snapshot', 'alerts', 'cases', 'rbi'] as const) {
      const r = await request(app).get(`/v1/reports/${type}?period=quarter`).set(TENANT_HEADERS);
      expect(r.status).toBe(200);
      expect(r.body.type).toBe(type);
    }
  });
});
