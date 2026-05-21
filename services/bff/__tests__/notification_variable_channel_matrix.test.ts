// services/bff/__tests__/notification_variable_channel_matrix.test.ts
//
// T6 M10.18 — Notification variable × channel cross-tab matrix.

import request from 'supertest';
import {
  buildNotificationVariableChannelMatrix,
  ALL_NOTIFICATION_CHANNEL_KEYS,
} from '../src/notification_variable_channel_matrix';
import { introspectNotificationTemplateCatalog } from '../src/notification_template_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeVcApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Envelope shape ──────────────────────────────────────────────────

describe('M10.18 — envelope shape', () => {
  test('exactly 3 columns in canonical order', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    expect(s.columns.length).toBe(3);
    expect(s.columns.map((c) => c.channel)).toEqual(['email', 'sms', 'push']);
    expect(s.total_channels).toBe(3);
  });

  test('rows sorted by variable asc', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    const sorted = [...s.rows.map((r) => r.variable)].sort();
    expect(s.rows.map((r) => r.variable)).toEqual(sorted);
  });

  test('total_templates matches catalog', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    const cat = introspectNotificationTemplateCatalog();
    expect(s.total_templates).toBe(cat.total_templates);
  });

  test('generated_at echoed', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });

  test('total_variables matches rows.length', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    expect(s.total_variables).toBe(s.rows.length);
  });
});

// ─── Partition invariants ────────────────────────────────────────────

describe('M10.18 — partition invariants', () => {
  test('Σ col.total = Σ row.total (grand-total invariant)', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    const colSum = s.columns.reduce((a, c) => a + c.total, 0);
    const rowSum = s.rows.reduce((a, r) => a + r.total, 0);
    expect(colSum).toBe(rowSum);
  });

  test('per-row Σ by_channel = row.total', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const r of s.rows) {
      const sum = r.by_channel.email + r.by_channel.sms + r.by_channel.push;
      expect(sum).toBe(r.total);
    }
  });

  test('channels_with + channels_without = 3', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const r of s.rows) {
      expect(r.channels_with.length + r.channels_without.length).toBe(3);
    }
  });

  test('channels_with canonical order', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const r of s.rows) {
      const expected = ALL_NOTIFICATION_CHANNEL_KEYS.filter(
        (c) => r.by_channel[c] > 0,
      );
      expect(r.channels_with).toEqual(expected);
    }
  });

  test('channels_without canonical order + by_channel=0 invariant', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const r of s.rows) {
      for (const c of r.channels_without) {
        expect(r.by_channel[c]).toBe(0);
      }
      const expected = ALL_NOTIFICATION_CHANNEL_KEYS.filter(
        (c) => r.by_channel[c] === 0,
      );
      expect(r.channels_without).toEqual(expected);
    }
  });
});

// ─── Catalog cross-check ─────────────────────────────────────────────

describe('M10.18 — catalog cross-check', () => {
  test('Σ col.total counts every template × required_var contribution', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    const cat = introspectNotificationTemplateCatalog();
    let expected = 0;
    for (const t of cat.templates) {
      // Defensive dedup matches resolver implementation.
      expected += new Set(t.required_vars).size;
    }
    const colSum = s.columns.reduce((a, c) => a + c.total, 0);
    expect(colSum).toBe(expected);
  });

  test('each col.templates_count matches catalog.by_channel', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    const cat = introspectNotificationTemplateCatalog();
    for (const c of s.columns) {
      expect(c.templates_count).toBe(cat.by_channel[c.channel]);
    }
  });

  test('every distinct catalog variable surfaces in rows', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    const cat = introspectNotificationTemplateCatalog();
    const catalogVars = new Set(cat.distinct_required_vars);
    const matrixVars = new Set(s.rows.map((r) => r.variable));
    for (const v of catalogVars) {
      expect(matrixVars.has(v)).toBe(true);
    }
    expect(matrixVars.size).toBe(catalogVars.size);
  });
});

// ─── Spans / leaderboards ───────────────────────────────────────────

describe('M10.18 — spans_all_channels', () => {
  test('flag matches channels_with.length === 3', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const r of s.rows) {
      expect(r.spans_all_channels).toBe(r.channels_with.length === 3);
    }
  });

  test('cross_channel_variables matches spans_all_channels filter', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    const expected = s.rows
      .filter((r) => r.spans_all_channels)
      .map((r) => r.variable);
    expect(s.cross_channel_variables).toEqual(expected);
  });

  test('single_channel_variables matches channels_with.length === 1', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    const expected = s.rows
      .filter((r) => r.channels_with.length === 1)
      .map((r) => r.variable);
    expect(s.single_channel_variables).toEqual(expected);
  });
});

describe('M10.18 — most_universal_variable', () => {
  test('non-null when rows non-empty', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    if (s.rows.length > 0) {
      expect(s.most_universal_variable).not.toBeNull();
    }
  });

  test('points at a row with the maximum channels_with.length', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    if (s.most_universal_variable === null) return;
    const target = s.rows.find(
      (r) => r.variable === s.most_universal_variable,
    )!;
    const maxSpan = Math.max(...s.rows.map((r) => r.channels_with.length));
    expect(target.channels_with.length).toBe(maxSpan);
  });

  test('canonical asc tie-break (no earlier-asc variable has the same span)', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    if (s.most_universal_variable === null) return;
    const target = s.rows.find(
      (r) => r.variable === s.most_universal_variable,
    )!;
    for (const r of s.rows) {
      if (r.variable < target.variable) {
        expect(r.channels_with.length).toBeLessThan(target.channels_with.length);
      }
    }
  });
});

// ─── peak_cell ───────────────────────────────────────────────────────

describe('M10.18 — peak_cell', () => {
  test('non-null when total_variables > 0', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    if (s.total_variables > 0) {
      expect(s.peak_cell).not.toBeNull();
    }
  });

  test('peak_cell.count >= every cell', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    if (s.peak_cell === null) return;
    for (const r of s.rows) {
      for (const c of ALL_NOTIFICATION_CHANNEL_KEYS) {
        expect(r.by_channel[c]).toBeLessThanOrEqual(s.peak_cell!.count);
      }
    }
  });

  test('peak_cell canonical iteration tie-break (no earlier variable+channel has the same count)', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    if (s.peak_cell === null) return;
    for (const r of s.rows) {
      for (const c of ALL_NOTIFICATION_CHANNEL_KEYS) {
        // Earlier variables or same variable + earlier channel mustn't
        // strictly equal peak; if so, peak_cell should have been that
        // one. We assert no strictly-greater cell exists (peak.count
        // is the max) — already covered in the test above.
        // Here we assert canonical ordering: peak is the FIRST
        // encountered in canonical iteration order.
        if (r.variable < s.peak_cell!.variable) {
          expect(r.by_channel[c]).toBeLessThan(s.peak_cell!.count);
        }
      }
    }
  });
});

// ─── empty_cells canonical row-major order ───────────────────────────

describe('M10.18 — empty_cells canonical row-major order', () => {
  test('every empty_cell has by_channel=0', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const cell of s.empty_cells) {
      const row = s.rows.find((r) => r.variable === cell.variable)!;
      expect(row.by_channel[cell.channel]).toBe(0);
    }
  });

  test('empty_cells.length matches manual count', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    let manualEmpty = 0;
    for (const r of s.rows) {
      for (const c of ALL_NOTIFICATION_CHANNEL_KEYS) {
        if (r.by_channel[c] === 0) manualEmpty++;
      }
    }
    expect(s.empty_cells.length).toBe(manualEmpty);
  });

  test('canonical row-major order: variable asc × channel canonical', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (let i = 1; i < s.empty_cells.length; i++) {
      const prev = s.empty_cells[i - 1];
      const curr = s.empty_cells[i];
      const prevVarIdx = s.rows.findIndex((r) => r.variable === prev.variable);
      const currVarIdx = s.rows.findIndex((r) => r.variable === curr.variable);
      const prevChIdx = ALL_NOTIFICATION_CHANNEL_KEYS.indexOf(prev.channel);
      const currChIdx = ALL_NOTIFICATION_CHANNEL_KEYS.indexOf(curr.channel);
      // (variable_index, channel_index) must be lexicographically
      // strictly increasing.
      if (prevVarIdx === currVarIdx) {
        expect(prevChIdx).toBeLessThan(currChIdx);
      } else {
        expect(prevVarIdx).toBeLessThan(currVarIdx);
      }
    }
  });
});

// ─── Per-column top_variables ────────────────────────────────────────

describe('M10.18 — top_variables per column', () => {
  test('cap 5 per column', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const c of s.columns) {
      expect(c.top_variables.length).toBeLessThanOrEqual(5);
    }
  });

  test('top_variables.length ≤ distinct_variables', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const c of s.columns) {
      expect(c.top_variables.length).toBeLessThanOrEqual(c.distinct_variables);
    }
  });

  test('top_variables every entry has > 0 count in this channel', () => {
    const s = buildNotificationVariableChannelMatrix(NOW);
    for (const c of s.columns) {
      for (const v of c.top_variables) {
        const row = s.rows.find((r) => r.variable === v)!;
        expect(row.by_channel[c.channel]).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Route ───────────────────────────────────────────────────────────

describe('M10.18 — GET /v1/notifications/variables/channel-matrix', () => {
  test('admin → 200 with populated matrix', async () => {
    const { app } = makeVcApp('admin');
    const r = await request(app)
      .get('/v1/notifications/variables/channel-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.columns.length).toBe(3);
    expect(r.body.body.total_variables).toBeGreaterThan(0);
    expect(r.body.body.total_templates).toBeGreaterThan(0);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeVcApp('case_owner');
    const r = await request(app)
      .get('/v1/notifications/variables/channel-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: same response across BIL ↔ BANK_DEMO', async () => {
    const { app } = makeVcApp('admin');
    const bil = await request(app)
      .get('/v1/notifications/variables/channel-matrix')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/notifications/variables/channel-matrix')
      .set(TH_BANK);
    expect(bil.body.body.total_variables).toBe(bank.body.body.total_variables);
    expect(bil.body.body.most_universal_variable).toBe(
      bank.body.body.most_universal_variable,
    );
  });

  test('M10.11 /v1/notifications/templates/catalog sibling regression still 200', async () => {
    const { app } = makeVcApp('admin');
    const r = await request(app)
      .get('/v1/notifications/templates/catalog')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M10.13 /v1/notifications/variables/index sibling regression still 200', async () => {
    const { app } = makeVcApp('admin');
    const r = await request(app)
      .get('/v1/notifications/variables/index')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
