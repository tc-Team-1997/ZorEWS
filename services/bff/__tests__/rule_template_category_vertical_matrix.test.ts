// services/bff/__tests__/rule_template_category_vertical_matrix.test.ts
//
// T6 M5.17 — Rule template category × vertical cross-tab matrix.

import request from 'supertest';
import {
  buildRuleTemplateCategoryVerticalMatrix,
  ALL_RULE_TEMPLATE_VERTICALS,
} from '../src/rule_template_category_vertical_matrix';
import {
  RULE_TEMPLATES,
  listCategories,
} from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCvApp(role: string = 'risk_analyst') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildRuleTemplateCategoryVerticalMatrix — pure ──────────────────

describe('M5.17 — basic shape', () => {
  test('envelope carries every expected field', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_templates).toBe(RULE_TEMPLATES.length);
    expect(m.total_categories).toBe(listCategories().length);
    expect(m.total_verticals).toBe(ALL_RULE_TEMPLATE_VERTICALS.length);
    expect(m.rows.length).toBe(listCategories().length);
    expect(m.columns.length).toBe(ALL_RULE_TEMPLATE_VERTICALS.length);
  });
});

describe('M5.17 — rows in canonical category order', () => {
  test('rows[] follows listCategories()', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    expect(m.rows.map((r) => r.category)).toEqual(listCategories());
  });
});

describe('M5.17 — columns in canonical vertical order', () => {
  test('columns[] follows ALL_RULE_TEMPLATE_VERTICALS', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    expect(m.columns.map((c) => c.vertical)).toEqual([...ALL_RULE_TEMPLATE_VERTICALS]);
  });
});

describe('M5.17 — total_templates matches catalog size', () => {
  test('total_templates === RULE_TEMPLATES.length', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    expect(m.total_templates).toBe(RULE_TEMPLATES.length);
  });
});

describe('M5.17 — per-row partition invariant', () => {
  test('Σ by_vertical = row.total per row', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const row of m.rows) {
      const sum = Object.values(row.by_vertical).reduce((a, b) => a + b, 0);
      expect(row.total).toBe(sum);
    }
  });
});

describe('M5.17 — per-column partition invariant', () => {
  test('Σ by_category = col.total per column', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_category).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });
});

describe('M5.17 — grand-total cross-check', () => {
  test('Σ rows.total = Σ cols.total = total_templates', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_templates);
    expect(colSum).toBe(m.total_templates);
  });
});

describe('M5.17 — every-vertical-key-present per row', () => {
  test('row.by_vertical has every RuleTemplateVertical key', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const row of m.rows) {
      for (const v of ALL_RULE_TEMPLATE_VERTICALS) {
        expect(row.by_vertical).toHaveProperty(v);
        expect(typeof row.by_vertical[v]).toBe('number');
      }
    }
  });
});

describe('M5.17 — every-category-key-present per column', () => {
  test('col.by_category has every category key', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const col of m.columns) {
      for (const cat of listCategories()) {
        expect(col.by_category).toHaveProperty(cat);
        expect(typeof col.by_category[cat]).toBe('number');
      }
    }
  });
});

describe('M5.17 — cell cross-check invariant', () => {
  test('row[cat].by_vertical[v] === col[v].by_category[cat] for every pair', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        expect(row.by_vertical[col.vertical]).toBe(col.by_category[row.category]);
      }
    }
  });
});

describe('M5.17 — verticals_without per row', () => {
  test('canonical vertical order; entries have by_vertical=0', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const row of m.rows) {
      const expected = ALL_RULE_TEMPLATE_VERTICALS.filter((v) => row.by_vertical[v] === 0);
      expect(row.verticals_without).toEqual(expected);
      for (const v of row.verticals_without) {
        expect(row.by_vertical[v]).toBe(0);
      }
    }
  });
});

describe('M5.17 — categories_without per column', () => {
  test('canonical category order; entries have by_category=0', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    const catOrder = listCategories();
    for (const col of m.columns) {
      const expected = catOrder.filter((c) => col.by_category[c] === 0);
      expect(col.categories_without).toEqual(expected);
      for (const c of col.categories_without) {
        expect(col.by_category[c]).toBe(0);
      }
    }
  });
});

describe('M5.17 — peak_cell formula', () => {
  test('peak_cell.count equals max across all cells', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    let maxSeen = 0;
    for (const row of m.rows) {
      for (const v of ALL_RULE_TEMPLATE_VERTICALS) {
        if (row.by_vertical[v] > maxSeen) maxSeen = row.by_vertical[v];
      }
    }
    expect(m.peak_cell!.count).toBe(maxSeen);
  });

  test('peak_cell.template_ids is sorted asc', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    const ids = m.peak_cell!.template_ids;
    const sorted = [...ids].sort((a, z) => a.localeCompare(z));
    expect(ids).toEqual(sorted);
  });

  test('peak_cell.template_ids matches the (category, vertical) bucket', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    const peak = m.peak_cell!;
    const manualIds = RULE_TEMPLATES
      .filter((t) => t.category === peak.category && t.vertical === peak.vertical)
      .map((t) => t.id)
      .sort((a, z) => a.localeCompare(z));
    expect(peak.template_ids).toEqual(manualIds);
  });
});

describe('M5.17 — empty_cells', () => {
  test('every empty_cell has by_vertical=0 in its row', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const ec of m.empty_cells) {
      const row = m.rows.find((r) => r.category === ec.category)!;
      expect(row.by_vertical[ec.vertical]).toBe(0);
    }
  });

  test('partition: empty_cells.length + non_empty_count = total_cells', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    const total_cells = m.rows.length * ALL_RULE_TEMPLATE_VERTICALS.length;
    let non_empty = 0;
    for (const row of m.rows) {
      for (const v of ALL_RULE_TEMPLATE_VERTICALS) {
        if (row.by_vertical[v] > 0) non_empty++;
      }
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });

  test('canonical row-major order (category asc, then vertical asc within)', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    const catOrder = listCategories();
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevCatIdx = catOrder.indexOf(prev.category);
      const currCatIdx = catOrder.indexOf(curr.category);
      if (prevCatIdx !== currCatIdx) {
        expect(currCatIdx).toBeGreaterThan(prevCatIdx);
      } else {
        const prevVIdx = ALL_RULE_TEMPLATE_VERTICALS.indexOf(prev.vertical);
        const currVIdx = ALL_RULE_TEMPLATE_VERTICALS.indexOf(curr.vertical);
        expect(currVIdx).toBeGreaterThan(prevVIdx);
      }
    }
  });
});

describe('M5.17 — most_covered_category', () => {
  test('points at category with most distinct non-zero verticals', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    const target = m.rows.find((r) => r.category === m.most_covered_category!.category)!;
    const span = ALL_RULE_TEMPLATE_VERTICALS.filter((v) => target.by_vertical[v] > 0).length;
    expect(m.most_covered_category!.verticals_covered).toBe(span);
    for (const row of m.rows) {
      const otherSpan = ALL_RULE_TEMPLATE_VERTICALS.filter((v) => row.by_vertical[v] > 0).length;
      expect(otherSpan).toBeLessThanOrEqual(span);
    }
  });
});

describe('M5.17 — most_covered_vertical', () => {
  test('points at vertical with most distinct non-zero categories', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    const target = m.columns.find((c) => c.vertical === m.most_covered_vertical!.vertical)!;
    const catOrder = listCategories();
    const span = catOrder.filter((c) => target.by_category[c] > 0).length;
    expect(m.most_covered_vertical!.categories_covered).toBe(span);
    for (const col of m.columns) {
      const otherSpan = catOrder.filter((c) => col.by_category[c] > 0).length;
      expect(otherSpan).toBeLessThanOrEqual(span);
    }
  });
});

describe('M5.17 — RULE_TEMPLATES manual count cross-check', () => {
  test('per-row total matches manual filter by category', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const row of m.rows) {
      const manual = RULE_TEMPLATES.filter((t) => t.category === row.category).length;
      expect(row.total).toBe(manual);
    }
  });

  test('per-column total matches manual filter by vertical', () => {
    const m = buildRuleTemplateCategoryVerticalMatrix(NOW);
    for (const col of m.columns) {
      const manual = RULE_TEMPLATES.filter((t) => t.vertical === col.vertical).length;
      expect(col.total).toBe(manual);
    }
  });
});

describe('M5.17 — platform-static', () => {
  test('different now → same matrix data', () => {
    const a = buildRuleTemplateCategoryVerticalMatrix(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildRuleTemplateCategoryVerticalMatrix(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_templates).toBe(b.total_templates);
    expect(a.peak_cell).toEqual(b.peak_cell);
    expect(a.rows.map((r) => r.total)).toEqual(b.rows.map((r) => r.total));
  });
});

// ─── GET /v1/rules/templates/category-vertical-matrix ────────────────

describe('M5.17 — GET /v1/rules/templates/category-vertical-matrix', () => {
  test('analyst+ → 200 with full matrix', async () => {
    const { app } = makeCvApp('risk_analyst');
    const r = await request(app).get('/v1/rules/templates/category-vertical-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_templates).toBe(RULE_TEMPLATES.length);
    expect(r.body.body.rows.length).toBe(listCategories().length);
    expect(r.body.body.columns.length).toBe(ALL_RULE_TEMPLATE_VERTICALS.length);
  });

  test('admin → 200 also', async () => {
    const { app } = makeCvApp('admin');
    const r = await request(app).get('/v1/rules/templates/category-vertical-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCvApp('case_owner');
    const r = await request(app).get('/v1/rules/templates/category-vertical-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeCvApp('admin');
    const bil = await request(app).get('/v1/rules/templates/category-vertical-matrix').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/rules/templates/category-vertical-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_templates).toBe(bank.body.body.total_templates);
    expect(bil.body.body.peak_cell).toEqual(bank.body.body.peak_cell);
  });

  test('literal `/category-vertical-matrix` not captured as :id', async () => {
    const { app } = makeCvApp('admin');
    // If shadowed by /:id, would 404 unknown_template.
    const r = await request(app).get('/v1/rules/templates/category-vertical-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M5.16 /v1/rules/templates/severity-distribution still 200 (sibling regression)', async () => {
    const { app } = makeCvApp('admin');
    const r = await request(app).get('/v1/rules/templates/severity-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M5.1 /v1/rules/templates/categories still 200 (sibling regression)', async () => {
    const { app } = makeCvApp('admin');
    const r = await request(app).get('/v1/rules/templates/categories').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
