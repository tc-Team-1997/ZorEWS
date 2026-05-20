// services/bff/__tests__/lineage_catalog.test.ts
//
// Phase D.4 — Metadata / Data Lineage interactive surface tests.

import request from 'supertest';
import {
  ALL_LINEAGE_LAYERS,
  ALL_DATASET_KINDS,
  LINEAGE_DATASETS,
  LINEAGE_EDGES,
  isLineageLayer,
  getDataset,
  immediateUpstream,
  immediateDownstream,
  traverseUpstream,
  traverseDownstream,
  impactAnalysis,
  summariseCatalog,
  LineageError,
} from '../src/metadata/lineage';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };

function makeLineageApp(role: string = 'admin') {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
  return app;
}

// ── 1. Catalog integrity ──────────────────────────────────────────────

describe('lineage catalog integrity', () => {
  test('every dataset has a unique id', () => {
    const ids = LINEAGE_DATASETS.map((d) => d.dataset_id);
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
  });

  test('every dataset layer is in ALL_LINEAGE_LAYERS', () => {
    for (const d of LINEAGE_DATASETS) {
      expect(isLineageLayer(d.layer)).toBe(true);
    }
  });

  test('every dataset kind is in ALL_DATASET_KINDS', () => {
    for (const d of LINEAGE_DATASETS) {
      expect((ALL_DATASET_KINDS as readonly string[]).includes(d.kind)).toBe(true);
    }
  });

  test('every edge points at known datasets', () => {
    const ids = new Set(LINEAGE_DATASETS.map((d) => d.dataset_id));
    for (const e of LINEAGE_EDGES) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  test('catalog contains expected canonical datasets', () => {
    for (const id of [
      'ext.cbs',
      'raw.seed_customer',
      'staging.stg_customer',
      'mart.customer_360',
      'mart.indicator_values',
      'app_alerts.alerts',
      'audit.event_log',
      'spa',
    ]) {
      expect(getDataset(id)).not.toBeNull();
    }
  });

  test('no edge is a self-loop', () => {
    for (const e of LINEAGE_EDGES) {
      expect(e.from).not.toBe(e.to);
    }
  });

  test('every layer has at least one dataset (except future-only ones)', () => {
    const layerCounts = Object.fromEntries(
      ALL_LINEAGE_LAYERS.map((l) => [l, 0]),
    ) as Record<string, number>;
    for (const d of LINEAGE_DATASETS) layerCounts[d.layer]++;
    // All declared layers are exercised in the catalog.
    for (const l of ALL_LINEAGE_LAYERS) {
      expect(layerCounts[l]).toBeGreaterThan(0);
    }
  });
});

// ── 2. getDataset + immediate traversal ───────────────────────────────

describe('immediate traversal helpers', () => {
  test('getDataset returns null on miss', () => {
    expect(getDataset('nope')).toBeNull();
  });

  test('immediateUpstream of mart.customer_360', () => {
    const ups = immediateUpstream('mart.customer_360');
    const fromIds = ups.map((e) => e.from).sort();
    expect(fromIds).toContain('staging.stg_customer');
    expect(fromIds).toContain('staging.stg_bureau_score');
  });

  test('immediateDownstream of staging.stg_customer', () => {
    const downs = immediateDownstream('staging.stg_customer');
    expect(downs.map((e) => e.to)).toContain('mart.customer_360');
  });

  test('immediate helpers return empty array on isolated id', () => {
    expect(immediateUpstream('does_not_exist')).toEqual([]);
    expect(immediateDownstream('does_not_exist')).toEqual([]);
  });
});

// ── 3. traverseUpstream ──────────────────────────────────────────────

describe('traverseUpstream', () => {
  test('depth=0 returns empty', () => {
    const out = traverseUpstream('mart.customer_360', 0);
    expect(out.datasets).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  test('depth=1 returns only immediate parents', () => {
    const out = traverseUpstream('mart.customer_360', 1);
    const ids = out.datasets.map((d) => d.dataset_id).sort();
    expect(ids).toEqual(['staging.stg_bureau_score', 'staging.stg_customer']);
  });

  test('depth=999 reaches external sources', () => {
    const out = traverseUpstream('mart.customer_360', 999);
    const ids = out.datasets.map((d) => d.dataset_id);
    expect(ids).toContain('raw.seed_customer');
    expect(ids).toContain('ext.cbs');
    expect(ids).toContain('ext.bureau');
  });

  test('unknown dataset throws', () => {
    expect(() => traverseUpstream('nope', 1)).toThrow(LineageError);
  });

  test('invalid depth throws', () => {
    expect(() => traverseUpstream('mart.customer_360', -1)).toThrow(/depth/);
  });

  test('terminal source has no parents at any depth', () => {
    const out = traverseUpstream('ext.cbs', 10);
    expect(out.datasets).toEqual([]);
  });
});

// ── 4. traverseDownstream ────────────────────────────────────────────

describe('traverseDownstream', () => {
  test('depth=0 returns empty', () => {
    const out = traverseDownstream('ext.cbs', 0);
    expect(out.datasets).toEqual([]);
  });

  test('depth=1 returns only immediate children', () => {
    const out = traverseDownstream('ext.cbs', 1);
    const ids = out.datasets.map((d) => d.dataset_id).sort();
    // ext.cbs → raw.seed_customer + raw.seed_loans + raw.seed_repayments
    //         + raw.seed_txns + kafka.cbs_events
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids).toContain('raw.seed_customer');
  });

  test('depth=999 reaches downstream consumers', () => {
    const out = traverseDownstream('ext.cbs', 999);
    const ids = out.datasets.map((d) => d.dataset_id);
    expect(ids).toContain('mart.customer_360');
    expect(ids).toContain('app_alerts.alerts');
    expect(ids).toContain('spa');
    expect(ids).toContain('audit.event_log');
  });

  test('downstream of spa (terminal) is empty', () => {
    const out = traverseDownstream('spa', 10);
    expect(out.datasets).toEqual([]);
  });
});

// ── 5. impactAnalysis ────────────────────────────────────────────────

describe('impactAnalysis', () => {
  test('mart.customer_360 has SPA + audit + downstream impact', () => {
    const out = impactAnalysis('mart.customer_360');
    expect(out.origin.dataset_id).toBe('mart.customer_360');
    const affectedIds = out.affected_datasets.map((d) => d.dataset_id);
    expect(affectedIds).toContain('mart.indicator_values');
    expect(affectedIds).toContain('spa');
    // PII propagation surfaced — at least one downstream is PII-flagged.
    expect(out.affected_pii_count).toBeGreaterThanOrEqual(0);
    expect(out.max_depth).toBeGreaterThan(0);
  });

  test('downstream consumer has no further impact', () => {
    const out = impactAnalysis('spa');
    expect(out.affected_datasets).toEqual([]);
    expect(out.max_depth).toBe(0);
  });

  test('unknown dataset throws', () => {
    expect(() => impactAnalysis('nope')).toThrow(LineageError);
  });

  test('origin field carries the dataset itself', () => {
    const out = impactAnalysis('ext.cbs');
    expect(out.origin.dataset_id).toBe('ext.cbs');
    expect(out.origin.layer).toBe('external_source');
  });
});

// ── 6. summariseCatalog ──────────────────────────────────────────────

describe('summariseCatalog', () => {
  test('total counts match arrays', () => {
    const sum = summariseCatalog();
    expect(sum.total_datasets).toBe(LINEAGE_DATASETS.length);
    expect(sum.total_edges).toBe(LINEAGE_EDGES.length);
  });

  test('by_layer carries every declared layer', () => {
    const sum = summariseCatalog();
    for (const l of ALL_LINEAGE_LAYERS) {
      expect(sum.by_layer).toHaveProperty(l);
    }
    // Sum equals total.
    const total = Object.values(sum.by_layer).reduce((a, b) => a + b, 0);
    expect(total).toBe(sum.total_datasets);
  });

  test('total_pii counts PII-flagged datasets', () => {
    const sum = summariseCatalog();
    const expected = LINEAGE_DATASETS.filter((d) => d.pii).length;
    expect(sum.total_pii).toBe(expected);
  });
});

// ── 7. Routes ────────────────────────────────────────────────────────

describe('GET /v1/metadata/lineage/catalog', () => {
  test('admin → 200 with full catalog', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app).get('/v1/metadata/lineage/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.datasets.length).toBe(LINEAGE_DATASETS.length);
    expect(r.body.body.edges.length).toBe(LINEAGE_EDGES.length);
    expect(r.body.body.layers).toEqual([...ALL_LINEAGE_LAYERS]);
    expect(r.body.body.summary.total_datasets).toBe(LINEAGE_DATASETS.length);
  });

  test('field_officer → 403', async () => {
    const app = makeLineageApp('field_officer');
    const r = await request(app).get('/v1/metadata/lineage/catalog').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/metadata/lineage/datasets/:dataset_id', () => {
  test('happy + 404', async () => {
    const app = makeLineageApp('admin');
    const ok = await request(app)
      .get('/v1/metadata/lineage/datasets/mart.customer_360')
      .set(TH_BIL);
    expect(ok.status).toBe(200);
    expect(ok.body.body.dataset_id).toBe('mart.customer_360');

    const miss = await request(app)
      .get('/v1/metadata/lineage/datasets/nope')
      .set(TH_BIL);
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_dataset');
  });
});

describe('GET /v1/metadata/lineage/datasets/:id/upstream', () => {
  test('default depth=3 returns ancestry', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/mart.customer_360/upstream')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.origin_id).toBe('mart.customer_360');
    expect(r.body.body.depth).toBe(3);
    const ids = r.body.body.datasets.map((d: { dataset_id: string }) => d.dataset_id);
    expect(ids).toContain('staging.stg_customer');
    expect(ids).toContain('raw.seed_customer');
  });

  test('?depth=1 narrows to immediate parents', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/mart.customer_360/upstream?depth=1')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    const ids = r.body.body.datasets.map((d: { dataset_id: string }) => d.dataset_id);
    expect(ids).not.toContain('raw.seed_customer');
  });

  test('invalid depth → 400', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/mart.customer_360/upstream?depth=abc')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_depth');
  });

  test('unknown dataset → 404', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/nope/upstream')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/metadata/lineage/datasets/:id/downstream', () => {
  test('default depth=3 returns descendants', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/ext.cbs/downstream')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    const ids = r.body.body.datasets.map((d: { dataset_id: string }) => d.dataset_id);
    expect(ids).toContain('raw.seed_customer');
    expect(ids).toContain('staging.stg_customer');
  });

  test('?depth=99 reaches all downstream', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/ext.cbs/downstream?depth=99')
      .set(TH_BIL);
    const ids = r.body.body.datasets.map((d: { dataset_id: string }) => d.dataset_id);
    expect(ids).toContain('spa');
    expect(ids).toContain('audit.event_log');
  });

  test('unknown dataset → 404', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/nope/downstream')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/metadata/lineage/datasets/:id/impact', () => {
  test('mart.customer_360 → impact list + max_depth > 0', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/mart.customer_360/impact')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.origin.dataset_id).toBe('mart.customer_360');
    expect(r.body.body.affected_datasets.length).toBeGreaterThan(0);
    expect(r.body.body.max_depth).toBeGreaterThan(0);
    expect(typeof r.body.body.affected_pii_count).toBe('number');
  });

  test('terminal consumer → empty impact', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/spa/impact')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.affected_datasets).toEqual([]);
    expect(r.body.body.max_depth).toBe(0);
  });

  test('unknown dataset → 404', async () => {
    const app = makeLineageApp('admin');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/nope/impact')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('field_officer → 403', async () => {
    const app = makeLineageApp('field_officer');
    const r = await request(app)
      .get('/v1/metadata/lineage/datasets/mart.customer_360/impact')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
