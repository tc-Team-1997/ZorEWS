// services/bff/__tests__/dashboard_config_key_index.test.ts
//
// T6 M11.16 — Dashboard widget config-key cross-reference.

import request from 'supertest';
import { buildDashboardConfigKeyIndex } from '../src/dashboard_config_key_index';
import { WIDGET_TYPES, WIDGET_CATALOG } from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCkApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── buildDashboardConfigKeyIndex — pure ──────────────────────────────

describe('M11.16 — basic shape', () => {
  test('returns expected envelope fields', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    expect(idx.generated_at).toBe(NOW.toISOString());
    expect(idx.total_widget_types).toBe(WIDGET_TYPES.length);
    expect(idx.total_config_keys).toBeGreaterThan(0);
    expect(Array.isArray(idx.config_keys)).toBe(true);
    expect(Array.isArray(idx.single_use_keys)).toBe(true);
    expect(Array.isArray(idx.universal_keys)).toBe(true);
  });
});

describe('M11.16 — catalog coverage', () => {
  test('every config_key in WIDGET_CATALOG surfaces in the index', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    const indexKeys = new Set(idx.config_keys.map((r) => r.config_key));
    const catalogKeys = new Set<string>();
    for (const wt of WIDGET_TYPES) {
      for (const k of WIDGET_CATALOG[wt].config_keys) catalogKeys.add(k);
    }
    for (const key of catalogKeys) {
      expect(indexKeys.has(key)).toBe(true);
    }
    expect(idx.total_config_keys).toBe(catalogKeys.size);
  });
});

describe('M11.16 — reference_count matches manual count', () => {
  test('per-key reference_count equals number of widget_types declaring it', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    for (const row of idx.config_keys) {
      const manual = WIDGET_TYPES.filter((wt) =>
        WIDGET_CATALOG[wt].config_keys.includes(row.config_key),
      ).length;
      expect(row.reference_count).toBe(manual);
    }
  });
});

describe('M11.16 — widget_types sort asc per row', () => {
  test('widget_types array sorted ascending', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    for (const row of idx.config_keys) {
      const sorted = [...row.widget_types].sort((a, z) => a.localeCompare(z));
      expect(row.widget_types).toEqual(sorted);
    }
  });
});

describe('M11.16 — config_keys[] sort', () => {
  test('reference_count desc + config_key asc tie-break', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    for (let i = 1; i < idx.config_keys.length; i++) {
      const prev = idx.config_keys[i - 1]!;
      const curr = idx.config_keys[i]!;
      if (prev.reference_count === curr.reference_count) {
        expect(prev.config_key.localeCompare(curr.config_key)).toBeLessThan(0);
      } else {
        expect(prev.reference_count).toBeGreaterThan(curr.reference_count);
      }
    }
  });
});

describe('M11.16 — known config_keys present', () => {
  test('known catalog keys appear in index', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    const keys = new Set(idx.config_keys.map((r) => r.config_key));
    // From WIDGET_CATALOG: vertical (risk_score_histogram + top_breaches)
    expect(keys.has('vertical')).toBe(true);
    // limit (open_cases + top_breaches + audit_recent)
    expect(keys.has('limit')).toBe(true);
    // since_hours (alerts_by_class only — single use)
    expect(keys.has('since_hours')).toBe(true);
    // bucket_count (risk_score_histogram only — single use)
    expect(keys.has('bucket_count')).toBe(true);
  });
});

describe('M11.16 — shared config_keys', () => {
  test('`vertical` shared between risk_score_histogram + top_breaches', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    const vertical = idx.config_keys.find((r) => r.config_key === 'vertical')!;
    expect(vertical.widget_types).toEqual(['risk_score_histogram', 'top_breaches']);
    expect(vertical.reference_count).toBe(2);
  });

  test('`limit` shared across multiple widget_types', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    const limit = idx.config_keys.find((r) => r.config_key === 'limit')!;
    // open_cases + top_breaches + audit_recent all declare `limit`
    expect(limit.reference_count).toBeGreaterThanOrEqual(2);
    expect(limit.widget_types).toContain('open_cases');
    expect(limit.widget_types).toContain('top_breaches');
    expect(limit.widget_types).toContain('audit_recent');
  });
});

describe('M11.16 — single_use_keys', () => {
  test('keys with reference_count=1 surface in single_use_keys', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    for (const row of idx.single_use_keys) {
      expect(row.reference_count).toBe(1);
    }
    // since_hours is single-use (alerts_by_class only)
    const since_hours = idx.single_use_keys.find((r) => r.config_key === 'since_hours');
    expect(since_hours).toBeDefined();
  });

  test('every single_use key matches manual scan', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    const manual: string[] = [];
    const keyCounts = new Map<string, number>();
    for (const wt of WIDGET_TYPES) {
      for (const k of WIDGET_CATALOG[wt].config_keys) {
        keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
      }
    }
    for (const [k, c] of keyCounts) {
      if (c === 1) manual.push(k);
    }
    manual.sort();
    expect(idx.single_use_keys.map((r) => r.config_key).sort()).toEqual(manual);
  });
});

describe('M11.16 — universal_keys', () => {
  test('keys present in every widget_type surface as universal', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    for (const row of idx.universal_keys) {
      expect(row.reference_count).toBe(WIDGET_TYPES.length);
    }
    // Currently no config_key is used by every widget_type; check empty
    // or full consistency rather than asserting count.
  });
});

describe('M11.16 — most_shared_key', () => {
  test('points at the row with highest reference_count', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    expect(idx.most_shared_key).not.toBeNull();
    expect(idx.most_shared_key!.reference_count).toBe(idx.config_keys[0]!.reference_count);
    expect(idx.most_shared_key!.config_key).toBe(idx.config_keys[0]!.config_key);
  });

  test('reference_count > 0 since catalog is non-empty', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    expect(idx.most_shared_key!.reference_count).toBeGreaterThan(0);
  });
});

describe('M11.16 — widget_display_names', () => {
  test('matches widget_types via WIDGET_CATALOG lookup, sorted asc', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    for (const row of idx.config_keys) {
      const manual = row.widget_types
        .map((t) => WIDGET_CATALOG[t].display_name)
        .sort((a, z) => a.localeCompare(z));
      expect(row.widget_display_names).toEqual(manual);
    }
  });
});

describe('M11.16 — Σ reference_count = total config_key declarations', () => {
  test('partition invariant: Σ refs = Σ |widget.config_keys|', () => {
    const idx = buildDashboardConfigKeyIndex(NOW);
    const sum = idx.config_keys.reduce((acc, r) => acc + r.reference_count, 0);
    let manual = 0;
    for (const wt of WIDGET_TYPES) {
      manual += WIDGET_CATALOG[wt].config_keys.length;
    }
    expect(sum).toBe(manual);
  });
});

describe('M11.16 — platform-static', () => {
  test('same response across invocations (different now still works)', () => {
    const a = buildDashboardConfigKeyIndex(new Date('2026-01-01T00:00:00.000Z'));
    const b = buildDashboardConfigKeyIndex(new Date('2026-12-31T00:00:00.000Z'));
    expect(a.total_widget_types).toBe(b.total_widget_types);
    expect(a.total_config_keys).toBe(b.total_config_keys);
    expect(a.config_keys.map((r) => r.config_key)).toEqual(b.config_keys.map((r) => r.config_key));
  });
});

// ─── GET /v1/dashboards/widgets/config-keys ──────────────────────────

describe('M11.16 — GET /v1/dashboards/widgets/config-keys', () => {
  test('admin → 200 with full index', async () => {
    const { app } = makeCkApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/config-keys').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_widget_types).toBe(WIDGET_TYPES.length);
    expect(r.body.body.total_config_keys).toBeGreaterThan(0);
    expect(r.body.body.most_shared_key).not.toBeNull();
  });

  test('shape contains expected fields', async () => {
    const { app } = makeCkApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/config-keys').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body).toHaveProperty('config_keys');
    expect(r.body.body).toHaveProperty('single_use_keys');
    expect(r.body.body).toHaveProperty('universal_keys');
    expect(r.body.body).toHaveProperty('most_shared_key');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCkApp('case_owner');
    const r = await request(app).get('/v1/dashboards/widgets/config-keys').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL ↔ BANK_DEMO same response', async () => {
    const { app } = makeCkApp('admin');
    const bil = await request(app).get('/v1/dashboards/widgets/config-keys').set(TH_BIL);
    const bank = await request(app).get('/v1/dashboards/widgets/config-keys')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.status).toBe(200);
    expect(bank.status).toBe(200);
    expect(bil.body.body.total_config_keys).toBe(bank.body.body.total_config_keys);
    expect(bil.body.body.most_shared_key).toEqual(bank.body.body.most_shared_key);
  });

  test('M11.11 /v1/dashboards/widgets/usage still 200 (sibling regression)', async () => {
    const { app } = makeCkApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/usage').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M11.12 /v1/dashboards/widgets/defaults still 200 (sibling regression)', async () => {
    const { app } = makeCkApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/defaults').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M11.7 /v1/dashboards/widgets/catalog still 200 (sibling regression)', async () => {
    const { app } = makeCkApp('admin');
    const r = await request(app).get('/v1/dashboards/widgets/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
