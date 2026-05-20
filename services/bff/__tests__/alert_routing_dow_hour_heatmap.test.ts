// T6 M8.17 — Alert routing day-of-week × hour-of-day heatmap.

import request from 'supertest';
import {
  summarizeAlertRoutingDowHour,
  AlertRoutingDowHourHeatmapError,
  DEFAULT_ALERT_DOW_HOUR_WINDOW,
  MAX_ALERT_DOW_HOUR_WINDOW,
  DOW_LABELS,
} from '../src/alert_routing_dow_hour_heatmap';
import {
  InMemoryRoutingLedger,
  type RoutedAlertRecord,
  type RoutingLedger,
} from '../src/alert_routing_analytics';
import { BIL_CLASS_ORDER } from '../src/bil_alert_classification';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin', routingLedger?: RoutingLedger) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    routingLedger,
  });
}

function makeRecord(
  alert_id: string,
  created_at: string,
  cls: 'red' | 'orange' | 'yellow' | 'green' = 'orange',
  tenant_id: string = 'BIL',
): RoutedAlertRecord {
  return {
    alert_id,
    tenant_id,
    created_at,
    severity_in: cls === 'red' ? 'CRITICAL' : cls === 'orange' ? 'HIGH' : cls === 'yellow' ? 'MEDIUM' : 'LOW',
    class: cls,
    channels: ['email'],
    sla_hours: cls === 'green' ? null : 24,
    escalate_after_hours: cls === 'green' ? null : 12,
    monitor_only: cls === 'green',
    acked_at: null,
  };
}

describe('M8.17 — summarizeAlertRoutingDowHour', () => {
  test('empty records → 168 zero cells + marginals at 0', () => {
    const m = summarizeAlertRoutingDowHour('BIL', [], 50, NOW);
    expect(m.sample_size).toBe(0);
    expect(m.cells.length).toBe(168);
    for (const c of m.cells) expect(c.count).toBe(0);
    expect(m.by_dow.length).toBe(7);
    expect(m.by_hour.length).toBe(24);
    expect(m.peak_cell).toBeNull();
    expect(m.peak_dow).toBeNull();
    expect(m.peak_hour).toBeNull();
    expect(m.most_active_class).toBeNull();
  });

  test('cells in canonical row-major (dow asc × hour asc) order', () => {
    const m = summarizeAlertRoutingDowHour('BIL', [], 50, NOW);
    for (let i = 0; i < 168; i++) {
      expect(m.cells[i].dow).toBe(Math.floor(i / 24));
      expect(m.cells[i].hour).toBe(i % 24);
    }
  });

  test('by_dow in ISO Mon..Sun order', () => {
    const m = summarizeAlertRoutingDowHour('BIL', [], 50, NOW);
    expect(m.by_dow.map((d) => d.label)).toEqual([...DOW_LABELS]);
  });

  test('by_hour in 0..23 order', () => {
    const m = summarizeAlertRoutingDowHour('BIL', [], 50, NOW);
    expect(m.by_hour.map((h) => h.hour)).toEqual(Array.from({length: 24}, (_, i) => i));
  });

  test('single record Mon 14:00 lands in correct cell', () => {
    // 2026-05-18 = Monday
    const records = [makeRecord('a1', '2026-05-18T14:00:00.000Z', 'orange')];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.sample_size).toBe(1);
    const cell = m.cells.find((c) => c.dow === 0 && c.hour === 14)!;
    expect(cell.count).toBe(1);
    expect(cell.by_class.orange).toBe(1);
    expect(m.by_dow[0].total).toBe(1);
    expect(m.by_dow[0].label).toBe('Mon');
    expect(m.by_hour[14].total).toBe(1);
  });

  test('Sun 09:00 lands in (dow=6, hour=9)', () => {
    // 2026-05-17 = Sunday
    const records = [makeRecord('a1', '2026-05-17T09:30:00.000Z', 'red')];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    const cell = m.cells.find((c) => c.dow === 6 && c.hour === 9)!;
    expect(cell.count).toBe(1);
    expect(cell.by_class.red).toBe(1);
    expect(m.by_dow[6].label).toBe('Sun');
  });

  test('Σ cells.count = sample_size partition', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red'),
      makeRecord('a2', '2026-05-19T11:00:00.000Z', 'orange'),
      makeRecord('a3', '2026-05-20T12:00:00.000Z', 'yellow'),
      makeRecord('a4', '2026-05-21T13:00:00.000Z', 'green'),
      makeRecord('a5', '2026-05-22T14:00:00.000Z', 'red'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    const sum = m.cells.reduce((a, c) => a + c.count, 0);
    expect(sum).toBe(m.sample_size);
    expect(sum).toBe(5);
  });

  test('Σ by_dow.total + Σ by_hour.total = sample_size each', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red'),
      makeRecord('a2', '2026-05-19T11:00:00.000Z', 'orange'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.by_dow.reduce((a, d) => a + d.total, 0)).toBe(2);
    expect(m.by_hour.reduce((a, h) => a + h.total, 0)).toBe(2);
  });

  test('cell.by_class accumulates + Σ by_class = cell.count', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red'),
      makeRecord('a2', '2026-05-18T10:30:00.000Z', 'red'),
      makeRecord('a3', '2026-05-18T10:45:00.000Z', 'orange'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    const cell = m.cells.find((c) => c.dow === 0 && c.hour === 10)!;
    expect(cell.count).toBe(3);
    expect(cell.by_class.red).toBe(2);
    expect(cell.by_class.orange).toBe(1);
    for (const c of m.cells) {
      const sum = BIL_CLASS_ORDER.reduce((a, k) => a + c.by_class[k], 0);
      expect(sum).toBe(c.count);
    }
  });

  test('peak_cell formula', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red'),
      makeRecord('a2', '2026-05-18T10:30:00.000Z', 'red'),
      makeRecord('a3', '2026-05-18T10:45:00.000Z', 'orange'),
      makeRecord('a4', '2026-05-19T14:00:00.000Z', 'yellow'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.peak_cell).toEqual({ dow: 0, label: 'Mon', hour: 10, count: 3 });
  });

  test('peak_cell canonical iteration tie-break (dow asc × hour asc)', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red'),
      makeRecord('a2', '2026-05-19T14:00:00.000Z', 'orange'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.peak_cell?.dow).toBe(0);
    expect(m.peak_cell?.hour).toBe(10);
  });

  test('peak_cell null on empty', () => {
    const m = summarizeAlertRoutingDowHour('BIL', [], 50, NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('peak_dow canonical Mon-first tie-break', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red'),
      makeRecord('a2', '2026-05-19T11:00:00.000Z', 'orange'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.peak_dow?.dow).toBe(0);
    expect(m.peak_dow?.label).toBe('Mon');
  });

  test('peak_hour earliest-hour-wins tie-break', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red'),
      makeRecord('a2', '2026-05-19T14:00:00.000Z', 'orange'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.peak_hour?.hour).toBe(10);
  });

  test('most_active_class formula', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'orange'),
      makeRecord('a2', '2026-05-18T10:30:00.000Z', 'orange'),
      makeRecord('a3', '2026-05-19T11:00:00.000Z', 'red'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.most_active_class).toBe('orange');
  });

  test('most_active_class canonical tie-break (red wins at tied)', () => {
    const records = [
      makeRecord('a1', '2026-05-18T10:00:00.000Z', 'orange'),
      makeRecord('a2', '2026-05-19T11:00:00.000Z', 'red'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.most_active_class).toBe('red');
  });

  test('most_active_class null on empty', () => {
    const m = summarizeAlertRoutingDowHour('BIL', [], 50, NOW);
    expect(m.most_active_class).toBeNull();
  });

  test('window narrows record set', () => {
    const records: RoutedAlertRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(makeRecord(`a${i}`, '2026-05-18T10:00:00.000Z', 'red'));
    }
    const m = summarizeAlertRoutingDowHour('BIL', records, 3, NOW);
    expect(m.sample_size).toBe(3);
  });

  test('invalid window throws (0 / MAX+1 / non-integer)', () => {
    expect(() => summarizeAlertRoutingDowHour('BIL', [], 0, NOW)).toThrow(AlertRoutingDowHourHeatmapError);
    expect(() => summarizeAlertRoutingDowHour('BIL', [], MAX_ALERT_DOW_HOUR_WINDOW + 1, NOW)).toThrow(AlertRoutingDowHourHeatmapError);
    expect(() => summarizeAlertRoutingDowHour('BIL', [], 7.5, NOW)).toThrow(AlertRoutingDowHourHeatmapError);
  });

  test('window=MAX boundary accepted', () => {
    const m = summarizeAlertRoutingDowHour('BIL', [], MAX_ALERT_DOW_HOUR_WINDOW, NOW);
    expect(m.window).toBe(MAX_ALERT_DOW_HOUR_WINDOW);
  });

  test('records with NaN created_at skipped', () => {
    const records = [
      makeRecord('a1', 'not-a-date', 'red'),
      makeRecord('a2', '2026-05-18T10:00:00.000Z', 'orange'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.sample_size).toBe(1);
  });

  test('records with out-of-enum class skipped', () => {
    const records = [
      { ...makeRecord('a1', '2026-05-18T10:00:00.000Z'), class: 'bogus' as never },
      makeRecord('a2', '2026-05-18T10:00:00.000Z', 'red'),
    ];
    const m = summarizeAlertRoutingDowHour('BIL', records, 50, NOW);
    expect(m.sample_size).toBe(1);
  });

  test('tenant_id + generated_at + window echo', () => {
    const m = summarizeAlertRoutingDowHour('BIL', [], 50, NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.window).toBe(50);
  });
});

describe('M8.17 — GET /v1/alerts/dow-hour-heatmap', () => {
  test('admin → 200 with empty ledger', async () => {
    const { app } = makeTestApp('admin', new InMemoryRoutingLedger());
    const r = await request(app).get('/v1/alerts/dow-hour-heatmap').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.sample_size).toBe(0);
    expect(r.body.body.cells.length).toBe(168);
    expect(r.body.body.by_dow.length).toBe(7);
    expect(r.body.body.by_hour.length).toBe(24);
    expect(r.body.body.window).toBe(DEFAULT_ALERT_DOW_HOUR_WINDOW);
  });

  test('populated reflects ledger', async () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red'));
    ledger.record(makeRecord('a2', '2026-05-18T10:30:00.000Z', 'red'));
    const { app } = makeTestApp('admin', ledger);
    const r = await request(app).get('/v1/alerts/dow-hour-heatmap').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.sample_size).toBe(2);
    expect(r.body.body.peak_cell.dow).toBe(0);
    expect(r.body.body.peak_cell.hour).toBe(10);
    expect(r.body.body.most_active_class).toBe('red');
  });

  test('?window=10 narrows', async () => {
    const { app } = makeTestApp('admin', new InMemoryRoutingLedger());
    const r = await request(app).get('/v1/alerts/dow-hour-heatmap?window=10').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.window).toBe(10);
  });

  test('?window=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeTestApp('admin', new InMemoryRoutingLedger());
    const r = await request(app).get('/v1/alerts/dow-hour-heatmap?window=0').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?window=400 → 400', async () => {
    const { app } = makeTestApp('admin', new InMemoryRoutingLedger());
    const r = await request(app).get('/v1/alerts/dow-hour-heatmap?window=400').set(TH);
    expect(r.status).toBe(400);
  });

  test('?window=abc → 400', async () => {
    const { app } = makeTestApp('admin', new InMemoryRoutingLedger());
    const r = await request(app).get('/v1/alerts/dow-hour-heatmap?window=abc').set(TH);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner', new InMemoryRoutingLedger());
    const r = await request(app).get('/v1/alerts/dow-hour-heatmap').set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(makeRecord('a1', '2026-05-18T10:00:00.000Z', 'red', 'BIL'));
    const { app } = makeTestApp('admin', ledger);
    const r = await request(app).get('/v1/alerts/dow-hour-heatmap').set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.sample_size).toBe(0);
  });

  test('M8.15 /daily-volume sibling regression still 200', async () => {
    const { app } = makeTestApp('admin', new InMemoryRoutingLedger());
    const r = await request(app).get('/v1/alerts/daily-volume').set(TH);
    expect(r.status).toBe(200);
  });

  test('M8.16 /sla-compliance-by-class sibling regression still 200', async () => {
    const { app } = makeTestApp('admin', new InMemoryRoutingLedger());
    const r = await request(app).get('/v1/alerts/sla-compliance-by-class').set(TH);
    expect(r.status).toBe(200);
  });
});
