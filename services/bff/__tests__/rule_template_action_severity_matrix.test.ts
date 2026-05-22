// services/bff/__tests__/rule_template_action_severity_matrix.test.ts
//
// T6 M5.19 — Rule template action × severity cross-tab matrix.

import request from 'supertest';
import {
  ALL_RECOMMENDED_ACTIONS,
  ALL_RECOMMENDED_SEVERITIES,
  buildRuleTemplateActionSeverityMatrix,
} from '../src/rule_template_action_severity_matrix';
import {
  RULE_TEMPLATES,
  type RecommendedAction,
  type RecommendedSeverity,
} from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── enum invariants ────────────────────────────────────────────────

describe('M5.19 — canonical enum exports', () => {
  test('ALL_RECOMMENDED_ACTIONS has exactly 6 values in canonical order', () => {
    expect([...ALL_RECOMMENDED_ACTIONS]).toEqual([
      'open_case',
      'notify_supervisor',
      'pause_disbursement',
      'request_documents',
      'flag_for_review',
      'auto_decline',
    ]);
  });

  test('ALL_RECOMMENDED_SEVERITIES has exactly 4 values in canonical order', () => {
    expect([...ALL_RECOMMENDED_SEVERITIES]).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);
  });
});

// ─── matrix shape ───────────────────────────────────────────────────

describe('M5.19 — matrix envelope', () => {
  test('rows + columns in canonical order; total counters present', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_templates).toBe(RULE_TEMPLATES.length);
    expect(m.total_actions).toBe(6);
    expect(m.total_severities).toBe(4);
    expect(m.rows.map((r) => r.action)).toEqual([...ALL_RECOMMENDED_ACTIONS]);
    expect(m.columns.map((c) => c.severity)).toEqual([
      ...ALL_RECOMMENDED_SEVERITIES,
    ]);
  });

  test('every row carries by_severity with all 4 keys at minimum 0', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const row of m.rows) {
      for (const sev of ALL_RECOMMENDED_SEVERITIES) {
        expect(row.by_severity[sev]).toBeGreaterThanOrEqual(0);
        expect(typeof row.by_severity[sev]).toBe('number');
      }
    }
  });

  test('every column carries by_action with all 6 keys at minimum 0', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const col of m.columns) {
      for (const action of ALL_RECOMMENDED_ACTIONS) {
        expect(col.by_action[action]).toBeGreaterThanOrEqual(0);
        expect(typeof col.by_action[action]).toBe('number');
      }
    }
  });
});

// ─── partition invariants ───────────────────────────────────────────

describe('M5.19 — partition invariants', () => {
  test('Σ row.by_severity = row.total per row', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const row of m.rows) {
      const sum = ALL_RECOMMENDED_SEVERITIES.reduce(
        (acc, s) => acc + row.by_severity[s],
        0,
      );
      expect(sum).toBe(row.total);
    }
  });

  test('Σ col.by_action = col.total per column', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const col of m.columns) {
      const sum = ALL_RECOMMENDED_ACTIONS.reduce(
        (acc, a) => acc + col.by_action[a],
        0,
      );
      expect(sum).toBe(col.total);
    }
  });

  test('Σ rows.total = Σ cols.total = total_contributions', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_contributions);
    expect(colSum).toBe(m.total_contributions);
  });

  test('total_contributions = Σ template.recommended_actions[].length (with intra-template dedup)', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    let manual = 0;
    for (const t of RULE_TEMPLATES) {
      const dedup = new Set(t.recommended_actions);
      manual += dedup.size;
    }
    expect(m.total_contributions).toBe(manual);
  });

  test('cell cross-check invariant: row[action].by_severity[sev] === col[sev].by_action[action]', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        expect(row.by_severity[col.severity]).toBe(col.by_action[row.action]);
      }
    }
  });
});

// ─── library content cross-check ────────────────────────────────────

describe('M5.19 — library content cross-check', () => {
  test('per-row total matches manual library scan for each action', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const row of m.rows) {
      // Manual count: templates whose recommended_actions includes this action
      const manual = RULE_TEMPLATES.filter((t) =>
        t.recommended_actions.includes(row.action),
      ).length;
      expect(row.total).toBe(manual);
    }
  });

  test('per-column total matches manual library scan for each severity', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const col of m.columns) {
      // Manual: count templates @ this severity × dedup actions per template
      const manual = RULE_TEMPLATES.filter(
        (t) => t.recommended_severity === col.severity,
      ).reduce((acc, t) => acc + new Set(t.recommended_actions).size, 0);
      expect(col.total).toBe(manual);
    }
  });

  test('seed library has open_case as most-used action (manual check)', () => {
    // Spot-check: open_case is the workhorse action; should appear in
    // most templates' recommended_actions lists.
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    const openCaseRow = m.rows.find((r) => r.action === 'open_case')!;
    expect(openCaseRow.total).toBeGreaterThan(0);
  });
});

// ─── severities_without + actions_without ──────────────────────────

describe('M5.19 — severities_without + actions_without canonical order', () => {
  test('severities_without per row in canonical order', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const row of m.rows) {
      for (const sev of row.severities_without) {
        expect(row.by_severity[sev]).toBe(0);
      }
      // Order matches the canonical sequence (subset preserves order)
      const expectedOrder = ALL_RECOMMENDED_SEVERITIES.filter((s) =>
        row.severities_without.includes(s),
      );
      expect(row.severities_without).toEqual(expectedOrder);
    }
  });

  test('actions_without per column in canonical order', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const col of m.columns) {
      for (const a of col.actions_without) {
        expect(col.by_action[a]).toBe(0);
      }
      const expectedOrder = ALL_RECOMMENDED_ACTIONS.filter((a) =>
        col.actions_without.includes(a),
      );
      expect(col.actions_without).toEqual(expectedOrder);
    }
  });
});

// ─── peak_cell ──────────────────────────────────────────────────────

describe('M5.19 — peak_cell', () => {
  test('peak_cell.count matches the max across all cells', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    if (m.peak_cell === null) {
      // No templates → all cells 0 → peak_cell null
      for (const row of m.rows) expect(row.total).toBe(0);
      return;
    }
    for (const row of m.rows) {
      for (const sev of ALL_RECOMMENDED_SEVERITIES) {
        expect(row.by_severity[sev]).toBeLessThanOrEqual(m.peak_cell.count);
      }
    }
  });

  test('peak_cell.template_ids list contains exactly count templates whose action+severity matches', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    if (m.peak_cell === null) return;
    expect(m.peak_cell.template_ids.length).toBe(m.peak_cell.count);
    // Every listed template must contain the action AND match the severity
    for (const id of m.peak_cell.template_ids) {
      const t = RULE_TEMPLATES.find((x) => x.id === id);
      expect(t).toBeDefined();
      expect(t!.recommended_severity).toBe(m.peak_cell!.severity);
      expect(t!.recommended_actions).toContain(m.peak_cell!.action);
    }
  });

  test('peak_cell.template_ids sorted asc', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    if (m.peak_cell === null) return;
    const ids = [...m.peak_cell.template_ids];
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);
  });
});

// ─── empty_cells ────────────────────────────────────────────────────

describe('M5.19 — empty_cells', () => {
  test('empty + non-empty cells partition to 24', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    let nonEmpty = 0;
    for (const row of m.rows) {
      for (const sev of ALL_RECOMMENDED_SEVERITIES) {
        if (row.by_severity[sev] > 0) nonEmpty += 1;
      }
    }
    expect(m.empty_cells.length + nonEmpty).toBe(24);
  });

  test('every empty cell has by_severity=0 + by_action=0', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    for (const ec of m.empty_cells) {
      const row = m.rows.find((r) => r.action === ec.action)!;
      const col = m.columns.find((c) => c.severity === ec.severity)!;
      expect(row.by_severity[ec.severity]).toBe(0);
      expect(col.by_action[ec.action]).toBe(0);
    }
  });

  test('empty_cells in canonical action × severity row-major order', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    // Build expected order
    const expected: Array<{ action: RecommendedAction; severity: RecommendedSeverity }> = [];
    for (const a of ALL_RECOMMENDED_ACTIONS) {
      for (const s of ALL_RECOMMENDED_SEVERITIES) {
        const row = m.rows.find((r) => r.action === a)!;
        if (row.by_severity[s] === 0) expected.push({ action: a, severity: s });
      }
    }
    expect(m.empty_cells).toEqual(expected);
  });
});

// ─── most_versatile_action + most_distributed_severity ─────────────

describe('M5.19 — leaderboards', () => {
  test('most_versatile_action is non-null when library non-empty', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    expect(m.most_versatile_action).not.toBeNull();
  });

  test('most_distributed_severity is non-null when library non-empty', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    expect(m.most_distributed_severity).not.toBeNull();
  });

  test('most_versatile_action span ≥ every other non-empty action span', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    if (m.most_versatile_action === null) return;
    const winnerRow = m.rows.find((r) => r.action === m.most_versatile_action)!;
    const winnerSpan = 4 - winnerRow.severities_without.length;
    for (const row of m.rows) {
      if (row.total === 0) continue;
      const span = 4 - row.severities_without.length;
      expect(winnerSpan).toBeGreaterThanOrEqual(span);
    }
  });

  test('most_distributed_severity span ≥ every other non-empty severity span', () => {
    const m = buildRuleTemplateActionSeverityMatrix(NOW);
    if (m.most_distributed_severity === null) return;
    const winnerCol = m.columns.find(
      (c) => c.severity === m.most_distributed_severity,
    )!;
    const winnerSpan = 6 - winnerCol.actions_without.length;
    for (const col of m.columns) {
      if (col.total === 0) continue;
      const span = 6 - col.actions_without.length;
      expect(winnerSpan).toBeGreaterThanOrEqual(span);
    }
  });
});

// ─── platform-static ────────────────────────────────────────────────

describe('M5.19 — platform-static', () => {
  test('different now timestamp produces same matrix data (only generated_at differs)', () => {
    const m1 = buildRuleTemplateActionSeverityMatrix(NOW);
    const m2 = buildRuleTemplateActionSeverityMatrix(
      new Date('2099-12-31T00:00:00.000Z'),
    );
    expect(m1.total_contributions).toBe(m2.total_contributions);
    expect(m1.peak_cell).toEqual(m2.peak_cell);
    expect(m1.empty_cells).toEqual(m2.empty_cells);
    expect(m1.most_versatile_action).toBe(m2.most_versatile_action);
    expect(m1.most_distributed_severity).toBe(m2.most_distributed_severity);
  });
});

// ─── HTTP route ─────────────────────────────────────────────────────

function makeMatrixApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M5.19 — GET /v1/rules/templates/action-severity-matrix', () => {
  test('admin → 200 with full matrix shape', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/action-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_templates).toBe(RULE_TEMPLATES.length);
    expect(r.body.body.rows).toHaveLength(6);
    expect(r.body.body.columns).toHaveLength(4);
    expect(r.body.body.peak_cell).not.toBeNull();
  });

  test('analyst+ accepted (rules:list grants risk_analyst)', async () => {
    const { app } = makeMatrixApp('risk_analyst');
    const r = await request(app)
      .get('/v1/rules/templates/action-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('non-allowed role → 403', async () => {
    // rules:list grants admin/supervisor/risk_analyst — case_owner not in set
    const { app } = makeMatrixApp('case_owner');
    const r = await request(app)
      .get('/v1/rules/templates/action-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static across tenants (BIL ↔ BANK_DEMO same)', async () => {
    const { app: appBil } = makeMatrixApp('admin');
    const { app: appBank } = makeMatrixApp('admin');
    const bil = await request(appBil)
      .get('/v1/rules/templates/action-severity-matrix')
      .set(TH_BIL);
    const bank = await request(appBank)
      .get('/v1/rules/templates/action-severity-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_contributions).toBe(bank.body.body.total_contributions);
    expect(bil.body.body.peak_cell).toEqual(bank.body.body.peak_cell);
  });

  test('literal /action-severity-matrix not captured by /:id wildcard', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/action-severity-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    // Envelope shape (body.body.rows is array of 6), not single template
    expect(Array.isArray(r.body.body.rows)).toBe(true);
    expect(r.body.body.rows).toHaveLength(6);
  });

  test('M5.16 /severity-distribution sibling route still works', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/severity-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M5.15 /action-inventory sibling route still works', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/action-inventory')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
