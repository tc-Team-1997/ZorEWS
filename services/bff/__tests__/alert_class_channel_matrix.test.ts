// services/bff/__tests__/alert_class_channel_matrix.test.ts
//
// T6 M8.14 — Alert class × channel dispatch cross-tab matrix.

import request from 'supertest';
import { buildAlertClassChannelMatrix } from '../src/alert_class_channel_matrix';
import { ALL_NOTIFICATION_CHANNELS } from '../src/alert_channel_distribution';
import { BIL_CLASS_ORDER } from '../src/bil_alert_classification';
import {
  InMemoryRoutingLedger,
  type RoutedAlertRecord,
} from '../src/alert_routing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function record(overrides: Partial<RoutedAlertRecord> = {}): RoutedAlertRecord {
  return {
    alert_id: 'a-1',
    tenant_id: 'BIL',
    created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    severity_in: 'HIGH',
    class: 'orange',
    channels: ['email'],
    sla_hours: 24,
    escalate_after_hours: 12,
    monitor_only: false,
    acked_at: null,
    ...overrides,
  };
}

function makeCcApp(role: string = 'admin') {
  const ledger = new InMemoryRoutingLedger();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    routingLedger: ledger,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, ledger };
}

// ─── buildAlertClassChannelMatrix — pure ─────────────────────────────

describe('M8.14 — empty input', () => {
  test('zero records → every row × col emitted at 0; null leaderboards', () => {
    const m = buildAlertClassChannelMatrix('BIL', [], 50, NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.window).toBe(50);
    expect(m.total_records).toBe(0);
    expect(m.total_dispatches).toBe(0);
    expect(m.rows.length).toBe(BIL_CLASS_ORDER.length);
    expect(m.columns.length).toBe(ALL_NOTIFICATION_CHANNELS.length);
    for (const row of m.rows) {
      expect(row.total).toBe(0);
      for (const ch of ALL_NOTIFICATION_CHANNELS) expect(row.by_channel[ch]).toBe(0);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_diverse_class).toBeNull();
    expect(m.most_universal_channel).toBeNull();
    expect(m.empty_cells.length).toBe(BIL_CLASS_ORDER.length * ALL_NOTIFICATION_CHANNELS.length);
  });
});

describe('M8.14 — rows in canonical class order', () => {
  test('rows[] follows BIL_CLASS_ORDER', () => {
    const m = buildAlertClassChannelMatrix('BIL', [], 50, NOW);
    expect(m.rows.map((r) => r.class)).toEqual([...BIL_CLASS_ORDER]);
  });
});

describe('M8.14 — columns in canonical channel order', () => {
  test('columns[] follows ALL_NOTIFICATION_CHANNELS', () => {
    const m = buildAlertClassChannelMatrix('BIL', [], 50, NOW);
    expect(m.columns.map((c) => c.channel)).toEqual([...ALL_NOTIFICATION_CHANNELS]);
  });
});

describe('M8.14 — single-channel record', () => {
  test('1 red alert via email → cell populated; total_records=1, total_dispatches=1', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a-1', class: 'red', channels: ['email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.total_records).toBe(1);
    expect(m.total_dispatches).toBe(1);
    const red = m.rows.find((r) => r.class === 'red')!;
    expect(red.by_channel.email).toBe(1);
    expect(red.by_channel.sms).toBe(0);
    expect(red.total).toBe(1);
    const email = m.columns.find((c) => c.channel === 'email')!;
    expect(email.by_class.red).toBe(1);
    expect(email.by_class.orange).toBe(0);
    expect(email.total).toBe(1);
    expect(m.peak_cell).toEqual({ class: 'red', channel: 'email', count: 1 });
  });
});

describe('M8.14 — multi-channel record', () => {
  test('1 record with channels=[email, sms] → total_dispatches=2, total_records=1', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a-1', class: 'red', channels: ['email', 'sms'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.total_records).toBe(1);
    expect(m.total_dispatches).toBe(2);
    const red = m.rows.find((r) => r.class === 'red')!;
    expect(red.by_channel.email).toBe(1);
    expect(red.by_channel.sms).toBe(1);
    expect(red.total).toBe(2);
  });
});

describe('M8.14 — multi-class records', () => {
  test('different classes route to their own cells', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a1', class: 'red', channels: ['email', 'sms'] }),
      record({ alert_id: 'a2', class: 'orange', channels: ['email', 'in_app'] }),
      record({ alert_id: 'a3', class: 'yellow', channels: ['email'] }),
      record({ alert_id: 'a4', class: 'green', channels: ['in_app'], monitor_only: true, sla_hours: null, escalate_after_hours: null }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.total_records).toBe(4);
    expect(m.total_dispatches).toBe(2 + 2 + 1 + 1);
    expect(m.rows.find((r) => r.class === 'red')!.by_channel.email).toBe(1);
    expect(m.rows.find((r) => r.class === 'red')!.by_channel.sms).toBe(1);
    expect(m.rows.find((r) => r.class === 'orange')!.by_channel.email).toBe(1);
    expect(m.rows.find((r) => r.class === 'orange')!.by_channel.in_app).toBe(1);
    expect(m.rows.find((r) => r.class === 'yellow')!.by_channel.email).toBe(1);
    expect(m.rows.find((r) => r.class === 'green')!.by_channel.in_app).toBe(1);
  });
});

describe('M8.14 — partition invariants', () => {
  test('Σ by_channel = row.total per row', () => {
    const recs: RoutedAlertRecord[] = [
      record({ class: 'red', channels: ['email', 'sms'] }),
      record({ class: 'orange', channels: ['email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    for (const row of m.rows) {
      const sum = Object.values(row.by_channel).reduce((a, b) => a + b, 0);
      expect(row.total).toBe(sum);
    }
  });

  test('Σ by_class = col.total per col', () => {
    const recs: RoutedAlertRecord[] = [
      record({ class: 'red', channels: ['email', 'sms'] }),
      record({ class: 'orange', channels: ['email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_class).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });

  test('Σ rows.total = Σ cols.total = total_dispatches', () => {
    const recs: RoutedAlertRecord[] = [
      record({ class: 'red', channels: ['email', 'sms', 'in_app'] }),
      record({ class: 'yellow', channels: ['email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_dispatches);
    expect(colSum).toBe(m.total_dispatches);
    expect(m.total_dispatches).toBe(4);
  });
});

describe('M8.14 — every-key-present invariants', () => {
  test('row.by_channel has every NotificationChannel key', () => {
    const m = buildAlertClassChannelMatrix('BIL', [], 50, NOW);
    for (const row of m.rows) {
      for (const ch of ALL_NOTIFICATION_CHANNELS) {
        expect(row.by_channel).toHaveProperty(ch);
        expect(typeof row.by_channel[ch]).toBe('number');
      }
    }
  });

  test('col.by_class has every BilAlertClass key', () => {
    const m = buildAlertClassChannelMatrix('BIL', [], 50, NOW);
    for (const col of m.columns) {
      for (const klass of BIL_CLASS_ORDER) {
        expect(col.by_class).toHaveProperty(klass);
        expect(typeof col.by_class[klass]).toBe('number');
      }
    }
  });
});

describe('M8.14 — cell cross-check invariant', () => {
  test('row[class].by_channel[ch] === col[ch].by_class[class] for every pair', () => {
    const recs: RoutedAlertRecord[] = [
      record({ class: 'red', channels: ['email', 'sms'] }),
      record({ class: 'orange', channels: ['email', 'in_app'] }),
      record({ class: 'yellow', channels: ['push'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        expect(row.by_channel[col.channel]).toBe(col.by_class[row.class]);
      }
    }
  });
});

describe('M8.14 — channels_without per row', () => {
  test('canonical channel order; entries have by_channel=0', () => {
    const recs: RoutedAlertRecord[] = [record({ class: 'red', channels: ['email'] })];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    for (const row of m.rows) {
      const expected = ALL_NOTIFICATION_CHANNELS.filter((ch) => row.by_channel[ch] === 0);
      expect(row.channels_without).toEqual(expected);
    }
  });
});

describe('M8.14 — classes_without per column', () => {
  test('canonical class order; entries have by_class=0', () => {
    const recs: RoutedAlertRecord[] = [record({ class: 'red', channels: ['email'] })];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    for (const col of m.columns) {
      const expected = BIL_CLASS_ORDER.filter((klass) => col.by_class[klass] === 0);
      expect(col.classes_without).toEqual(expected);
    }
  });
});

describe('M8.14 — peak_cell formula', () => {
  test('points at highest-count cell', () => {
    const recs: RoutedAlertRecord[] = [
      // (red, email) = 3
      record({ alert_id: 'r1', class: 'red', channels: ['email'] }),
      record({ alert_id: 'r2', class: 'red', channels: ['email'] }),
      record({ alert_id: 'r3', class: 'red', channels: ['email'] }),
      // (orange, sms) = 1
      record({ alert_id: 'o1', class: 'orange', channels: ['sms'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.peak_cell).toEqual({ class: 'red', channel: 'email', count: 3 });
  });

  test('canonical iteration tie-break: red/email wins over red/sms at tied count', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'a1', class: 'red', channels: ['email'] }),
      record({ alert_id: 'a2', class: 'red', channels: ['sms'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.peak_cell!.channel).toBe('email');
  });

  test('null on empty', () => {
    const m = buildAlertClassChannelMatrix('BIL', [], 50, NOW);
    expect(m.peak_cell).toBeNull();
  });
});

describe('M8.14 — empty_cells', () => {
  test('partition: empty + non_empty = total_cells', () => {
    const recs: RoutedAlertRecord[] = [
      record({ class: 'red', channels: ['email', 'sms'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    const total_cells = BIL_CLASS_ORDER.length * ALL_NOTIFICATION_CHANNELS.length;
    let non_empty = 0;
    for (const row of m.rows) {
      for (const ch of ALL_NOTIFICATION_CHANNELS) {
        if (row.by_channel[ch] > 0) non_empty++;
      }
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });

  test('canonical row-major order (class asc index, then channel asc index)', () => {
    const recs: RoutedAlertRecord[] = [
      record({ class: 'red', channels: ['email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevCIdx = BIL_CLASS_ORDER.indexOf(prev.class);
      const currCIdx = BIL_CLASS_ORDER.indexOf(curr.class);
      if (prevCIdx !== currCIdx) {
        expect(currCIdx).toBeGreaterThan(prevCIdx);
      } else {
        const prevChIdx = ALL_NOTIFICATION_CHANNELS.indexOf(prev.channel);
        const currChIdx = ALL_NOTIFICATION_CHANNELS.indexOf(curr.channel);
        expect(currChIdx).toBeGreaterThan(prevChIdx);
      }
    }
  });
});

describe('M8.14 — most_diverse_class', () => {
  test('points at class with most distinct non-zero channels', () => {
    const recs: RoutedAlertRecord[] = [
      // red spans 3 channels
      record({ alert_id: 'r1', class: 'red', channels: ['email', 'sms', 'in_app'] }),
      // orange spans 1
      record({ alert_id: 'o1', class: 'orange', channels: ['email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.most_diverse_class!.class).toBe('red');
    expect(m.most_diverse_class!.channels_used).toBe(3);
  });

  test('canonical-order tie-break: red wins over orange at same span', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'r1', class: 'red', channels: ['email'] }),
      record({ alert_id: 'o1', class: 'orange', channels: ['email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.most_diverse_class!.class).toBe('red');
  });

  test('null on empty', () => {
    const m = buildAlertClassChannelMatrix('BIL', [], 50, NOW);
    expect(m.most_diverse_class).toBeNull();
  });
});

describe('M8.14 — most_universal_channel', () => {
  test('points at channel with most distinct non-zero classes', () => {
    const recs: RoutedAlertRecord[] = [
      // email used by red + orange + yellow (3 classes)
      record({ alert_id: 'r1', class: 'red', channels: ['email'] }),
      record({ alert_id: 'o1', class: 'orange', channels: ['email'] }),
      record({ alert_id: 'y1', class: 'yellow', channels: ['email'] }),
      // sms used by red only
      record({ alert_id: 'r2', class: 'red', channels: ['sms'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.most_universal_channel!.channel).toBe('email');
    expect(m.most_universal_channel!.classes_using).toBe(3);
  });

  test('canonical-order tie-break: email wins over sms at same span', () => {
    const recs: RoutedAlertRecord[] = [
      record({ alert_id: 'r1', class: 'red', channels: ['email'] }),
      record({ alert_id: 'r2', class: 'red', channels: ['sms'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.most_universal_channel!.channel).toBe('email');
  });

  test('null on empty', () => {
    const m = buildAlertClassChannelMatrix('BIL', [], 50, NOW);
    expect(m.most_universal_channel).toBeNull();
  });
});

describe('M8.14 — invalid class/channel silently skipped', () => {
  test('records with out-of-enum class not counted', () => {
    const recs: RoutedAlertRecord[] = [
      // Cast through unknown to bypass type-check for the defensive test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      record({ class: 'unknown' as any, channels: ['email'] }),
      record({ class: 'red', channels: ['email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.total_records).toBe(2);
    expect(m.total_dispatches).toBe(1);
  });

  test('records with out-of-enum channel not counted', () => {
    const recs: RoutedAlertRecord[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      record({ class: 'red', channels: ['mystery' as any, 'email'] }),
    ];
    const m = buildAlertClassChannelMatrix('BIL', recs, 50, NOW);
    expect(m.total_dispatches).toBe(1);
  });
});

// ─── GET /v1/alerts/class-channel-matrix ─────────────────────────────

describe('M8.14 — GET /v1/alerts/class-channel-matrix', () => {
  test('admin → 200 with empty matrix on fresh tenant', async () => {
    const { app } = makeCcApp('admin');
    const r = await request(app).get('/v1/alerts/class-channel-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.window).toBe(50);
    expect(r.body.body.total_records).toBe(0);
    expect(r.body.body.rows.length).toBe(BIL_CLASS_ORDER.length);
    expect(r.body.body.columns.length).toBe(ALL_NOTIFICATION_CHANNELS.length);
  });

  test('populated matrix reflects ledger records', async () => {
    const { app, ledger } = makeCcApp('admin');
    ledger.record({
      tenant_id: 'BIL',
      alert_id: 'a1',
      created_at: new Date(NOW.getTime() - 30_000).toISOString(),
      severity_in: 'CRITICAL',
      class: 'red',
      channels: ['email', 'sms'],
      sla_hours: 4,
      escalate_after_hours: 1,
      monitor_only: false,
      acked_at: null,
    });
    const r = await request(app).get('/v1/alerts/class-channel-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records).toBe(1);
    expect(r.body.body.total_dispatches).toBe(2);
    expect(r.body.body.peak_cell.class).toBe('red');
  });

  test('?window=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeCcApp('admin');
    const r = await request(app).get('/v1/alerts/class-channel-matrix?window=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?window=1 narrows sample', async () => {
    const { app } = makeCcApp('admin');
    const r = await request(app).get('/v1/alerts/class-channel-matrix?window=1').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.window).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCcApp('case_owner');
    const r = await request(app).get('/v1/alerts/class-channel-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL ledger invisible to BANK_DEMO', async () => {
    const { app, ledger } = makeCcApp('admin');
    ledger.record({
      tenant_id: 'BIL',
      alert_id: 'a1',
      created_at: new Date(NOW.getTime() - 30_000).toISOString(),
      severity_in: 'CRITICAL',
      class: 'red',
      channels: ['email'],
      sla_hours: 4,
      escalate_after_hours: 1,
      monitor_only: false,
      acked_at: null,
    });
    const bank = await request(app)
      .get('/v1/alerts/class-channel-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_records).toBe(0);
  });

  test('M8.13 /v1/alerts/channel-distribution still 200 (sibling regression)', async () => {
    const { app } = makeCcApp('admin');
    const r = await request(app).get('/v1/alerts/channel-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
