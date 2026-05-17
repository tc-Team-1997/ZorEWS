// services/bff/__tests__/admin_config_type_matrix.test.ts
//
// T6 M13.15 — Admin config category × type cross-tab matrix.

import request from 'supertest';
import {
  buildAdminConfigTypeMatrix,
  ALL_CONFIG_TYPES,
} from '../src/admin_config_type_matrix';
import {
  DEFAULTS,
  listCategories,
} from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTmApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildAdminConfigTypeMatrix — pure ───────────────────────────────

describe('M13.15 — basic shape', () => {
  test('envelope carries every expected field', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_keys).toBe(DEFAULTS.length);
    expect(m.total_categories).toBe(listCategories().length);
    expect(m.total_types).toBe(ALL_CONFIG_TYPES.length);
    expect(m.rows.length).toBe(listCategories().length);
    expect(m.columns.length).toBe(ALL_CONFIG_TYPES.length);
  });
});

describe('M13.15 — rows in canonical category order', () => {
  test('rows[] follows listCategories()', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    expect(m.rows.map((r) => r.category)).toEqual(listCategories());
  });
});

describe('M13.15 — columns in canonical type order', () => {
  test('columns[] follows ALL_CONFIG_TYPES', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    expect(m.columns.map((c) => c.type)).toEqual([...ALL_CONFIG_TYPES]);
  });
});

describe('M13.15 — total_keys matches DEFAULTS.length', () => {
  test('total_keys equals catalog size', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    expect(m.total_keys).toBe(DEFAULTS.length);
  });
});

describe('M13.15 — per-row partition invariant', () => {
  test('Σ by_type = row.total for every row', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const row of m.rows) {
      const sum = Object.values(row.by_type).reduce((a, b) => a + b, 0);
      expect(row.total).toBe(sum);
    }
  });
});

describe('M13.15 — per-column partition invariant', () => {
  test('Σ by_category = col.total for every column', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_category).reduce((a, b) => a + b, 0);
      expect(col.total).toBe(sum);
    }
  });
});

describe('M13.15 — grand-total cross-check', () => {
  test('Σ rows.total = Σ cols.total = total_keys', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total, 0);
    expect(rowSum).toBe(m.total_keys);
    expect(colSum).toBe(m.total_keys);
  });
});

describe('M13.15 — every-type-key-present per row', () => {
  test('row.by_type has every ConfigType key', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const row of m.rows) {
      for (const t of ALL_CONFIG_TYPES) {
        expect(row.by_type).toHaveProperty(t);
        expect(typeof row.by_type[t]).toBe('number');
      }
    }
  });
});

describe('M13.15 — every-category-key-present per column', () => {
  test('col.by_category has every category key', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const col of m.columns) {
      for (const cat of listCategories()) {
        expect(col.by_category).toHaveProperty(cat);
        expect(typeof col.by_category[cat]).toBe('number');
      }
    }
  });
});

describe('M13.15 — cell cross-check invariant', () => {
  test('row[cat].by_type[t] === col[t].by_category[cat] for every pair', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        const fromRow = row.by_type[col.type];
        const fromCol = col.by_category[row.category];
        expect(fromRow).toBe(fromCol);
      }
    }
  });
});

describe('M13.15 — types_without per row', () => {
  test('canonical type order; entries have by_type=0', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const row of m.rows) {
      const expectedOrder = ALL_CONFIG_TYPES.filter((t) => row.by_type[t] === 0);
      expect(row.types_without).toEqual(expectedOrder);
      for (const t of row.types_without) {
        expect(row.by_type[t]).toBe(0);
      }
    }
  });
});

describe('M13.15 — categories_without per column', () => {
  test('canonical category order; entries have by_category=0', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    const categoryOrder = listCategories();
    for (const col of m.columns) {
      const expectedOrder = categoryOrder.filter((cat) => col.by_category[cat] === 0);
      expect(col.categories_without).toEqual(expectedOrder);
      for (const cat of col.categories_without) {
        expect(col.by_category[cat]).toBe(0);
      }
    }
  });
});

describe('M13.15 — peak_cell formula', () => {
  test('peak_cell.count equals max across all cells', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    let maxSeen = 0;
    for (const row of m.rows) {
      for (const t of ALL_CONFIG_TYPES) {
        if (row.by_type[t] > maxSeen) maxSeen = row.by_type[t];
      }
    }
    expect(m.peak_cell!.count).toBe(maxSeen);
  });

  test('peak_cell row × col counts agree', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    const peak = m.peak_cell!;
    const row = m.rows.find((r) => r.category === peak.category)!;
    expect(row.by_type[peak.type]).toBe(peak.count);
  });
});

describe('M13.15 — empty_cells lists zero-count pairs', () => {
  test('every empty_cell has count=0; canonical order', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const cell of m.empty_cells) {
      expect(cell.count).toBe(0);
    }
    // Canonical order: category order × type order
    const categoryOrder = listCategories();
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevCatIdx = categoryOrder.indexOf(prev.category);
      const currCatIdx = categoryOrder.indexOf(curr.category);
      if (prevCatIdx !== currCatIdx) {
        expect(currCatIdx).toBeGreaterThan(prevCatIdx);
      } else {
        const prevTypeIdx = ALL_CONFIG_TYPES.indexOf(prev.type);
        const currTypeIdx = ALL_CONFIG_TYPES.indexOf(curr.type);
        expect(currTypeIdx).toBeGreaterThan(prevTypeIdx);
      }
    }
  });

  test('empty_cells.length matches partition with non-empty cells', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    const total_cells = m.rows.length * ALL_CONFIG_TYPES.length;
    const non_empty = total_cells - m.empty_cells.length;
    let manualNonEmpty = 0;
    for (const row of m.rows) {
      for (const t of ALL_CONFIG_TYPES) {
        if (row.by_type[t] > 0) manualNonEmpty++;
      }
    }
    expect(non_empty).toBe(manualNonEmpty);
  });
});

describe('M13.15 — most_diverse_category', () => {
  test('points at category with most distinct non-zero by_type entries', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    const target = m.rows.find((r) => r.category === m.most_diverse_category!.category)!;
    const span = ALL_CONFIG_TYPES.filter((t) => target.by_type[t] > 0).length;
    expect(m.most_diverse_category!.types_covered).toBe(span);
    // No other category has STRICTLY more.
    for (const row of m.rows) {
      const otherSpan = ALL_CONFIG_TYPES.filter((t) => row.by_type[t] > 0).length;
      expect(otherSpan).toBeLessThanOrEqual(span);
    }
  });
});

describe('M13.15 — DEFAULTS schema sanity', () => {
  test('manual count matches per-row total', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const row of m.rows) {
      const manualCount = DEFAULTS.filter((d) => d.category === row.category).length;
      expect(row.total).toBe(manualCount);
    }
  });

  test('manual count matches per-column total', () => {
    const m = buildAdminConfigTypeMatrix(NOW);
    for (const col of m.columns) {
      const manualCount = DEFAULTS.filter((d) => d.type === col.type).length;
      expect(col.total).toBe(manualCount);
    }
  });
});

describe('M13.15 — platform-static', () => {
  test('different now → same matrix data', () => {
    const a = buildAdminConfigTypeMatrix(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildAdminConfigTypeMatrix(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_keys).toBe(b.total_keys);
    expect(a.rows.map((r) => r.total)).toEqual(b.rows.map((r) => r.total));
    expect(a.peak_cell).toEqual(b.peak_cell);
  });
});

// ─── GET /v1/admin/config/type-matrix ────────────────────────────────

describe('M13.15 — GET /v1/admin/config/type-matrix', () => {
  test('admin → 200 with full matrix', async () => {
    const { app } = makeTmApp('admin');
    const r = await request(app).get('/v1/admin/config/type-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(DEFAULTS.length);
    expect(r.body.body.rows.length).toBe(listCategories().length);
    expect(r.body.body.columns.length).toBe(ALL_CONFIG_TYPES.length);
  });

  test('shape contains every expected field', async () => {
    const { app } = makeTmApp('admin');
    const r = await request(app).get('/v1/admin/config/type-matrix').set(TH_BIL);
    expect(r.body.body).toHaveProperty('rows');
    expect(r.body.body).toHaveProperty('columns');
    expect(r.body.body).toHaveProperty('peak_cell');
    expect(r.body.body).toHaveProperty('empty_cells');
    expect(r.body.body).toHaveProperty('most_diverse_category');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTmApp('case_owner');
    const r = await request(app).get('/v1/admin/config/type-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeTmApp('admin');
    const bil = await request(app).get('/v1/admin/config/type-matrix').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/admin/config/type-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body.total_keys).toBe(bank.body.body.total_keys);
    expect(bil.body.body.peak_cell).toEqual(bank.body.body.peak_cell);
  });

  test('literal `/type-matrix` not captured as :key wildcard', async () => {
    const { app } = makeTmApp('admin');
    // If shadowed, would hit /:key which 404s on unknown key.
    const r = await request(app).get('/v1/admin/config/type-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M13.10 sibling /v1/admin/config/catalog still 200', async () => {
    const { app } = makeTmApp('admin');
    const r = await request(app).get('/v1/admin/config/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M13.13 sibling /v1/admin/config/schema.md still 200', async () => {
    const { app } = makeTmApp('admin');
    const r = await request(app).get('/v1/admin/config/schema.md').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
