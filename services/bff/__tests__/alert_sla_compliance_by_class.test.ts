// services/bff/__tests__/alert_sla_compliance_by_class.test.ts
//
// T6 M8.16 — Alert SLA compliance rate by class.

import request from 'supertest';
import { summarizeAlertSlaComplianceByClass } from '../src/alert_sla_compliance_by_class';
import {
  InMemoryRoutingLedger,
  type RoutedAlertRecord,
  type RoutingLedger,
} from '../src/alert_routing_analytics';
import type { BilAlertClass } from '../src/bil_alert_classification';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeScApp(role: string = 'admin', routingLedger?: RoutingLedger) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    routingLedger: routingLedger ?? new InMemoryRoutingLedger(),
  });
}

function rec(overrides: Partial<RoutedAlertRecord> = {}): RoutedAlertRecord {
  return {
    alert_id: 'a-' + Math.random(),
    tenant_id: 'BIL',
    created_at: NOW.toISOString(),
    severity_in: 'CRITICAL',
    class: 'red',
    channels: ['email'],
    sla_hours: 4,
    escalate_after_hours: 1,
    monitor_only: false,
    acked_at: null,
    ...overrides,
  };
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M8.16 — empty input', () => {
  test('zero records → 4 empty class rows + nulls', () => {
    const s = summarizeAlertSlaComplianceByClass('BIL', [], 50, NOW);
    expect(s.total_records).toBe(0);
    expect(s.total_sla_eligible).toBe(0);
    expect(s.total_breaches).toBe(0);
    expect(s.classes.length).toBe(4);
    for (const r of s.classes) {
      expect(r.total).toBe(0);
      expect(r.compliance_rate).toBeNull();
      expect(r.breach_rate).toBeNull();
    }
    expect(s.overall_compliance_rate).toBeNull();
    expect(s.worst_class).toBeNull();
    expect(s.best_class).toBeNull();
  });
});

describe('M8.16 — canonical class order', () => {
  test('classes[] in canonical red → orange → yellow → green order', () => {
    const s = summarizeAlertSlaComplianceByClass('BIL', [], 50, NOW);
    expect(s.classes.map((r) => r.class)).toEqual(['red', 'orange', 'yellow', 'green']);
  });
});

describe('M8.16 — monitor_only excluded from SLA evaluation', () => {
  test('green monitor_only=true counted in total but not sla_eligible', () => {
    const records: RoutedAlertRecord[] = [
      rec({
        class: 'green',
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
      }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    const green = s.classes.find((r) => r.class === 'green')!;
    expect(green.total).toBe(1);
    expect(green.sla_eligible_count).toBe(0);
    expect(green.compliance_rate).toBeNull();
  });
});

describe('M8.16 — acked within SLA counts as on_time', () => {
  test('acked 1h after creation with 4h SLA → on_time', () => {
    const created = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const acked = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
    const records: RoutedAlertRecord[] = [
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: created.toISOString(),
        acked_at: acked.toISOString(),
      }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    const red = s.classes.find((r) => r.class === 'red')!;
    expect(red.on_time_count).toBe(1);
    expect(red.late_count).toBe(0);
    expect(red.total_breach_count).toBe(0);
    expect(red.compliance_rate).toBe(1);
  });
});

describe('M8.16 — acked past SLA counts as late', () => {
  test('acked 5h after creation with 4h SLA → late', () => {
    const created = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);
    const acked = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
    const records: RoutedAlertRecord[] = [
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: created.toISOString(),
        acked_at: acked.toISOString(),
      }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    const red = s.classes.find((r) => r.class === 'red')!;
    expect(red.late_count).toBe(1);
    expect(red.total_breach_count).toBe(1);
    expect(red.on_time_count).toBe(0);
    expect(red.compliance_rate).toBe(0);
  });
});

describe('M8.16 — open past SLA counts as open_breached', () => {
  test('still-open 5h after creation with 4h SLA → open_breached', () => {
    const created = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
    const records: RoutedAlertRecord[] = [
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: created.toISOString(),
        acked_at: null,
      }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    const red = s.classes.find((r) => r.class === 'red')!;
    expect(red.open_breached_count).toBe(1);
    expect(red.total_breach_count).toBe(1);
  });
});

describe('M8.16 — open within SLA counts as on_time (not breached yet)', () => {
  test('still-open 2h after creation with 4h SLA → on_time', () => {
    const created = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const records: RoutedAlertRecord[] = [
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: created.toISOString(),
        acked_at: null,
      }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    const red = s.classes.find((r) => r.class === 'red')!;
    expect(red.on_time_count).toBe(1);
    expect(red.open_breached_count).toBe(0);
  });
});

describe('M8.16 — compliance + breach rates', () => {
  test('half on_time, half late → 0.5 each', () => {
    const created = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);
    const records: RoutedAlertRecord[] = [
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        acked_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      }), // on_time
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: created.toISOString(),
        acked_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      }), // late
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    const red = s.classes.find((r) => r.class === 'red')!;
    expect(red.compliance_rate).toBe(0.5);
    expect(red.breach_rate).toBe(0.5);
  });
});

describe('M8.16 — multi-class records', () => {
  test('mix across red/orange/yellow → per-class totals', () => {
    const records: RoutedAlertRecord[] = [
      rec({ class: 'red' }),
      rec({ class: 'red' }),
      rec({ class: 'orange', sla_hours: 24 }),
      rec({ class: 'yellow', sla_hours: 72 }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    expect(s.total_records).toBe(4);
    expect(s.classes.find((r) => r.class === 'red')!.total).toBe(2);
    expect(s.classes.find((r) => r.class === 'orange')!.total).toBe(1);
    expect(s.classes.find((r) => r.class === 'yellow')!.total).toBe(1);
  });
});

describe('M8.16 — worst_class + best_class', () => {
  test('lowest compliance → worst; highest → best', () => {
    const records: RoutedAlertRecord[] = [
      // red: 1 late → 0% compliance
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        acked_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      }),
      // orange: 1 on_time → 100% compliance
      rec({
        class: 'orange',
        sla_hours: 24,
        created_at: new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString(),
        acked_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    expect(s.worst_class).toBe('red');
    expect(s.best_class).toBe('orange');
  });

  test('null when no eligible records', () => {
    const records: RoutedAlertRecord[] = [
      rec({
        class: 'green',
        monitor_only: true,
        sla_hours: null,
        escalate_after_hours: null,
      }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    expect(s.worst_class).toBeNull();
    expect(s.best_class).toBeNull();
  });
});

describe('M8.16 — overall_compliance_rate', () => {
  test('aggregate across all classes', () => {
    const records: RoutedAlertRecord[] = [
      // red: 1 on_time
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        acked_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      }),
      // orange: 1 late
      rec({
        class: 'orange',
        sla_hours: 24,
        created_at: new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString(),
        acked_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    expect(s.overall_compliance_rate).toBe(0.5);
  });
});

describe('M8.16 — partition invariants', () => {
  test('on_time + late + open_breached = sla_eligible per row', () => {
    const records: RoutedAlertRecord[] = [
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        acked_at: NOW.toISOString(),
      }), // on_time
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        acked_at: NOW.toISOString(),
      }), // late
      rec({
        class: 'red',
        sla_hours: 4,
        created_at: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(),
        acked_at: null,
      }), // open_breached
    ];
    const s = summarizeAlertSlaComplianceByClass('BIL', records, 50, NOW);
    const red = s.classes.find((r) => r.class === 'red')!;
    expect(red.on_time_count + red.late_count + red.open_breached_count).toBe(red.sla_eligible_count);
  });
});

describe('M8.16 — tenant_id + generated_at echo', () => {
  test('envelope echoes', () => {
    const s = summarizeAlertSlaComplianceByClass('BIL', [], 50, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.window).toBe(50);
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M8.16 — GET /v1/alerts/sla-compliance-by-class', () => {
  test('admin → 200 with empty ledger', async () => {
    const { app } = makeScApp('admin');
    const r = await request(app)
      .get('/v1/alerts/sla-compliance-by-class')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_records).toBe(0);
    expect(r.body.body.classes.length).toBe(4);
  });

  test('populated → reflects records', async () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(rec({
      class: 'red',
      sla_hours: 4,
      created_at: new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString(),
      acked_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
    }));
    const { app } = makeScApp('admin', ledger);
    const r = await request(app)
      .get('/v1/alerts/sla-compliance-by-class')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_breaches).toBe(1);
    expect(r.body.body.worst_class).toBe('red');
  });

  test('?window=0 → 400', async () => {
    const { app } = makeScApp('admin');
    const r = await request(app)
      .get('/v1/alerts/sla-compliance-by-class?window=0')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeScApp('case_owner');
    const r = await request(app)
      .get('/v1/alerts/sla-compliance-by-class')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const ledger = new InMemoryRoutingLedger();
    ledger.record(rec({ tenant_id: 'BIL', class: 'red' }));
    const { app } = makeScApp('admin', ledger);
    const bankR = await request(app)
      .get('/v1/alerts/sla-compliance-by-class')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_records).toBe(0);
  });

  test('M8.15 /v1/alerts/daily-volume sibling regression still 200', async () => {
    const { app } = makeScApp('admin');
    const r = await request(app)
      .get('/v1/alerts/daily-volume')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
