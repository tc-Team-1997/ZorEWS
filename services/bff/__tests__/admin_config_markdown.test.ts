// services/bff/__tests__/admin_config_markdown.test.ts
//
// T6 M13.13 — Config schema Markdown reference export.

import request from 'supertest';
import { renderConfigSchemaMarkdown } from '../src/admin_config_markdown';
import { DEFAULTS, listCategories } from '../src/admin_config';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── renderConfigSchemaMarkdown — pure ───────────────────────────────

describe('M13.13 — output shape', () => {
  test('starts with H1 heading', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    expect(md.startsWith('# Admin Configuration Schema')).toBe(true);
  });

  test('summary line carries totals + ISO timestamp', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    expect(md).toContain(NOW.toISOString());
    expect(md).toContain(`${DEFAULTS.length} platform default`);
  });

  test('ends with trailing newline', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    expect(md.endsWith('\n')).toBe(true);
  });

  test('one H2 per non-empty category', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    for (const c of listCategories()) {
      const hasKeys = DEFAULTS.some((d) => d.category === c);
      if (hasKeys) {
        expect(md).toContain(`## ${c}`);
      }
    }
  });

  test('categories emitted in canonical listCategories order', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    const cats = listCategories();
    const indices = cats.map((c) => md.indexOf(`## ${c}`));
    // All non-(-1) indices should be strictly increasing
    const populated = indices.filter((i) => i >= 0);
    for (let i = 1; i < populated.length; i++) {
      expect(populated[i]).toBeGreaterThan(populated[i - 1]!);
    }
  });
});

describe('M13.13 — table content', () => {
  test('table header rendered per category', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    expect(md).toContain('| Key | Type | Default | Description |');
    expect(md).toContain('|-----|------|---------|-------------|');
  });

  test('every key in DEFAULTS appears in the markdown', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    for (const d of DEFAULTS) {
      expect(md).toContain(`\`${d.key}\``);
    }
  });

  test('every key type label appears in the markdown', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    for (const d of DEFAULTS) {
      // Type rendered as plain text in column
      expect(md).toContain(`| ${d.type} |`);
    }
  });
});

describe('M13.13 — value formatting', () => {
  test('number default rendered backticked literal', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    const num = DEFAULTS.find((d) => d.type === 'number');
    if (num) {
      expect(md).toContain(`\`${num.default_value}\``);
    }
  });

  test('boolean default rendered backticked literal', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    const bool = DEFAULTS.find((d) => d.type === 'boolean');
    if (bool) {
      expect(md).toContain(`\`${bool.default_value}\``);
    }
  });

  test('string default wrapped in quotes and backticks', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    const str = DEFAULTS.find((d) => d.type === 'string' && typeof d.default_value === 'string');
    if (str) {
      const v = str.default_value as string;
      if (v === '') {
        expect(md).toContain('`""`');
      } else {
        expect(md).toContain(`\`"${v}"\``);
      }
    }
  });
});

describe('M13.13 — keys sorted within a category', () => {
  test('per-category alphabetical ordering', () => {
    const md = renderConfigSchemaMarkdown(NOW);
    for (const c of listCategories()) {
      const keysInCat = DEFAULTS.filter((d) => d.category === c).map((d) => d.key);
      const sortedKeys = [...keysInCat].sort();
      // Find each key's position in the markdown and assert order
      const positions = sortedKeys.map((k) => md.indexOf(`\`${k}\``));
      // Each position must be strictly less than the next
      for (let i = 1; i < positions.length; i++) {
        if (positions[i - 1]! >= 0 && positions[i]! >= 0) {
          expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
        }
      }
    }
  });
});

describe('M13.13 — generated_at echo', () => {
  test('different NOWs produce different markdown', () => {
    const now1 = new Date('2026-05-15T12:00:00Z');
    const now2 = new Date('2026-05-16T12:00:00Z');
    const md1 = renderConfigSchemaMarkdown(now1);
    const md2 = renderConfigSchemaMarkdown(now2);
    expect(md1).not.toEqual(md2);
    expect(md1).toContain(now1.toISOString());
    expect(md2).toContain(now2.toISOString());
  });
});

// ─── GET /v1/admin/config/schema.md ──────────────────────────────────

function makeMdApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M13.13 — GET /v1/admin/config/schema.md', () => {
  test('admin → 200 with text/markdown content type', async () => {
    const { app } = makeMdApp('admin');
    const r = await request(app).get('/v1/admin/config/schema.md').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/markdown/);
  });

  test('response body is the markdown string (not enveloped)', async () => {
    const { app } = makeMdApp('admin');
    const r = await request(app).get('/v1/admin/config/schema.md').set(TH_BIL);
    expect(r.text.startsWith('# Admin Configuration Schema')).toBe(true);
    expect(r.text).toContain(NOW.toISOString());
  });

  test('Content-Disposition header set for download', async () => {
    const { app } = makeMdApp('admin');
    const r = await request(app).get('/v1/admin/config/schema.md').set(TH_BIL);
    expect(r.headers['content-disposition']).toContain('admin-config-schema');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMdApp('case_owner');
    const r = await request(app).get('/v1/admin/config/schema.md').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO get identical markdown', async () => {
    const { app } = makeMdApp('admin');
    const bil = await request(app).get('/v1/admin/config/schema.md').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/admin/config/schema.md')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.text).toEqual(bank.text);
  });

  test('M13.9 /v1/admin/config/summary.txt still works (sibling text route)', async () => {
    const { app } = makeMdApp('admin');
    const r = await request(app).get('/v1/admin/config/summary.txt').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
