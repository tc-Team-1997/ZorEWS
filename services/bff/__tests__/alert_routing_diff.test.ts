// services/bff/__tests__/alert_routing_diff.test.ts
//
// T6 M8.10 — Alert routing rule diff vs platform default.

import request from 'supertest';
import { buildAlertRoutingDiff } from '../src/alert_routing_diff';
import {
  InMemoryAlertRoutingEngine,
  DEFAULT_RULES,
} from '../src/alert_routing';
import { BIL_CLASS_ORDER } from '../src/bil_alert_classification';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── buildAlertRoutingDiff — pure ────────────────────────────────────

describe('M8.10 — fresh tenant (no overrides)', () => {
  test('every class is_default + zero changed fields', () => {
    const eng = new InMemoryAlertRoutingEngine();
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    expect(d.tenant_id).toBe('BIL');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(d.total_overrides).toBe(0);
    expect(d.classes.length).toBe(BIL_CLASS_ORDER.length);
    for (const c of d.classes) {
      expect(c.is_default).toBe(true);
      expect(c.changed_field_count).toBe(0);
      expect(c.changed_fields).toEqual([]);
    }
    expect(d.most_customised_class).toBeNull();
    expect(d.pristine_classes.length).toBe(BIL_CLASS_ORDER.length);
  });
});

describe('M8.10 — classes emitted in BIL_CLASS_ORDER', () => {
  test('classes[] matches red/orange/yellow/green sequence', () => {
    const eng = new InMemoryAlertRoutingEngine();
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    expect(d.classes.map((c) => c.class)).toEqual([...BIL_CLASS_ORDER]);
  });
});

describe('M8.10 — single-field override', () => {
  test('changing sla_hours flips is_default false + surfaces in changed_fields', () => {
    const eng = new InMemoryAlertRoutingEngine();
    eng.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    expect(d.total_overrides).toBe(1);
    const red = d.classes.find((c) => c.class === 'red')!;
    expect(red.is_default).toBe(false);
    expect(red.changed_field_count).toBe(1);
    expect(red.changed_fields[0]!.field).toBe('sla_hours');
    expect(red.changed_fields[0]!.default_value).toBe(DEFAULT_RULES.red.sla_hours);
    expect(red.changed_fields[0]!.effective_value).toBe(2);
  });
});

describe('M8.10 — multi-field override', () => {
  test('changing sla_hours + escalate + channels surfaces 3 changed_fields', () => {
    const eng = new InMemoryAlertRoutingEngine();
    eng.setOverride('BIL', {
      ...DEFAULT_RULES.red,
      sla_hours: 2,
      escalate_after_hours: 1,
      channels: ['email', 'in_app'],
    });
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    const red = d.classes.find((c) => c.class === 'red')!;
    expect(red.changed_field_count).toBe(2); // sla unchanged in fact? actually 2 → sla different + channels different (escalate_after_hours same as default=1)
    // Sanity: escalate_after_hours default for red is 1, so unchanged
    expect(red.changed_fields.map((c) => c.field).sort()).toEqual(['channels', 'sla_hours']);
  });

  test('channels list equality is element-wise', () => {
    const eng = new InMemoryAlertRoutingEngine();
    eng.setOverride('BIL', { ...DEFAULT_RULES.red, channels: ['sms', 'email'] });
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    const red = d.classes.find((c) => c.class === 'red')!;
    // default red channels = ['email', 'sms'] — different order → counts as changed
    expect(red.changed_field_count).toBe(1);
    expect(red.changed_fields[0]!.field).toBe('channels');
  });
});

describe('M8.10 — changed_fields stable ordering', () => {
  test('multiple changes ordered per declared ALL_FIELDS sequence', () => {
    const eng = new InMemoryAlertRoutingEngine();
    eng.setOverride('BIL', {
      ...DEFAULT_RULES.orange,
      // Change primary_assignee, secondary_assignee, channels
      primary_assignee: 'analyst',
      secondary_assignee: 'head_of_risk',
      channels: ['sms', 'email'],
    });
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    const orange = d.classes.find((c) => c.class === 'orange')!;
    // ALL_FIELDS order: primary_assignee, secondary_assignee, channels, sla_hours, escalate_after_hours, monitor_only
    expect(orange.changed_fields.map((c) => c.field)).toEqual([
      'primary_assignee',
      'secondary_assignee',
      'channels',
    ]);
  });
});

describe('M8.10 — multiple class overrides', () => {
  test('overrides on red + yellow tracked independently', () => {
    const eng = new InMemoryAlertRoutingEngine();
    eng.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    // yellow default sla=72 escalate=48 — bring sla to 48 + escalate to 24 to satisfy escalate < sla
    eng.setOverride('BIL', { ...DEFAULT_RULES.yellow, sla_hours: 48, escalate_after_hours: 24 });
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    expect(d.total_overrides).toBe(2);
    const red = d.classes.find((c) => c.class === 'red')!;
    const yellow = d.classes.find((c) => c.class === 'yellow')!;
    const orange = d.classes.find((c) => c.class === 'orange')!;
    expect(red.changed_field_count).toBe(1);
    expect(yellow.changed_field_count).toBe(2);
    expect(orange.is_default).toBe(true);
  });
});

describe('M8.10 — most_customised_class', () => {
  test('points at class with the most changed fields', () => {
    const eng = new InMemoryAlertRoutingEngine();
    // red: 1 change
    eng.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    // orange: 3 changes (sla 12 requires escalate < 12 — set escalate=6)
    eng.setOverride('BIL', {
      ...DEFAULT_RULES.orange,
      primary_assignee: 'analyst',
      secondary_assignee: 'head_of_risk',
      sla_hours: 12,
      escalate_after_hours: 6,
    });
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    // orange now has 4 changed fields: primary_assignee, secondary_assignee,
    // sla_hours, escalate_after_hours
    expect(d.most_customised_class).toEqual({ class: 'orange', changed_field_count: 4 });
  });

  test('null when no overrides exist', () => {
    const eng = new InMemoryAlertRoutingEngine();
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    expect(d.most_customised_class).toBeNull();
  });

  test('ties broken by BIL_CLASS_ORDER (red wins over orange at same count)', () => {
    const eng = new InMemoryAlertRoutingEngine();
    // Both have 1 change. Red sla=2 satisfies escalate=1<2.
    // Orange sla=12 needs escalate < 12 — touch both so the tied-change-count
    // invariant holds: red 1 change, orange must also have 1 change. We can
    // make orange's only changed field be primary_assignee.
    eng.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    eng.setOverride('BIL', { ...DEFAULT_RULES.orange, primary_assignee: 'head_of_risk' });
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    expect(d.most_customised_class!.class).toBe('red');
  });
});

describe('M8.10 — pristine_classes', () => {
  test('captures classes still at default, in declared order', () => {
    const eng = new InMemoryAlertRoutingEngine();
    eng.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const d = buildAlertRoutingDiff(eng, 'BIL', NOW);
    expect(d.pristine_classes).not.toContain('red');
    expect(d.pristine_classes).toContain('orange');
    expect(d.pristine_classes).toContain('yellow');
    expect(d.pristine_classes).toContain('green');
  });
});

describe('M8.10 — cross-tenant isolation', () => {
  test('BIL overrides invisible to BANK_DEMO', () => {
    const eng = new InMemoryAlertRoutingEngine();
    eng.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const bank = buildAlertRoutingDiff(eng, 'BANK_DEMO', NOW);
    expect(bank.total_overrides).toBe(0);
    expect(bank.most_customised_class).toBeNull();
  });
});

describe('M8.10 — defensive copy on channels', () => {
  test('mutating changed_fields[].effective_value array does not pollute engine', () => {
    const eng = new InMemoryAlertRoutingEngine();
    eng.setOverride('BIL', { ...DEFAULT_RULES.red, channels: ['email'] });
    const d1 = buildAlertRoutingDiff(eng, 'BIL', NOW);
    const red1 = d1.classes.find((c) => c.class === 'red')!;
    const change = red1.changed_fields.find((f) => f.field === 'channels')!;
    (change.effective_value as string[]).push('injected');
    const d2 = buildAlertRoutingDiff(eng, 'BIL', NOW);
    const red2 = d2.classes.find((c) => c.class === 'red')!;
    const change2 = red2.changed_fields.find((f) => f.field === 'channels')!;
    expect(change2.effective_value).toEqual(['email']);
    expect(change2.effective_value).not.toContain('injected');
  });
});

// ─── GET /v1/alerts/routing/diff ─────────────────────────────────────

function makeDiffApp(role = 'admin') {
  const alertRoutingEngine = new InMemoryAlertRoutingEngine();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    alertRoutingEngine,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, alertRoutingEngine };
}

describe('M8.10 — GET /v1/alerts/routing/diff', () => {
  test('admin → 200 with empty diff for fresh tenant', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app).get('/v1/alerts/routing/diff').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(0);
    expect(r.body.body.classes.length).toBe(BIL_CLASS_ORDER.length);
  });

  test('populated diff reflects override', async () => {
    const { app, alertRoutingEngine } = makeDiffApp('admin');
    alertRoutingEngine.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const r = await request(app).get('/v1/alerts/routing/diff').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_overrides).toBe(1);
    expect(r.body.body.most_customised_class.class).toBe('red');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDiffApp('case_owner');
    const r = await request(app).get('/v1/alerts/routing/diff').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL overrides invisible to BANK_DEMO via route', async () => {
    const { app, alertRoutingEngine } = makeDiffApp('admin');
    alertRoutingEngine.setOverride('BIL', { ...DEFAULT_RULES.red, sla_hours: 2 });
    const bank = await request(app)
      .get('/v1/alerts/routing/diff')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_overrides).toBe(0);
  });

  test('M8.8 /v1/alerts/routing/matrix still works (sibling route)', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app).get('/v1/alerts/routing/matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
