// services/bff/__tests__/release_info.test.ts
//
// Phase E.2 — Version & Release Management surface tests.

import request from 'supertest';
import {
  ALL_RELEASE_ENVIRONMENTS,
  ALL_RELEASE_STATUSES,
  isReleaseEnvironment,
  isReleaseStatus,
  resolveReleaseInfo,
  InMemoryReleaseHistoryStore,
  ReleaseHistoryError,
  RELEASE_HISTORY_CAP_PER_TENANT,
  type ReleaseHistoryCreateInput,
} from '../src/release/release_info';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T14:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeReleaseApp(
  role: string = 'admin',
  overrides: {
    releaseHistoryStore?: InMemoryReleaseHistoryStore;
    releaseEnvSource?: NodeJS.ProcessEnv;
  } = {},
) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    releaseHistoryStore: overrides.releaseHistoryStore ?? new InMemoryReleaseHistoryStore(),
    releaseEnvSource: overrides.releaseEnvSource,
  });
  return app;
}

const validInput = (over: Partial<ReleaseHistoryCreateInput> = {}): ReleaseHistoryCreateInput => ({
  release_id: 'r_1_4_0_prod',
  version: '1.4.0',
  git_sha: 'abc123def456',
  environment: 'production',
  status: 'deployed',
  released_at: '2026-05-21T12:00:00.000Z',
  released_by: 'release.eng',
  release_notes: 'Phase D.4 metadata lineage + Phase E.1 DR admin',
  jira_keys: ['REL-101', 'REL-102'],
  ...over,
});

// ── 1. Constants ──────────────────────────────────────────────────────

describe('release_info constants', () => {
  test('ALL_RELEASE_ENVIRONMENTS canonical order', () => {
    expect(ALL_RELEASE_ENVIRONMENTS).toEqual(['development', 'sandbox', 'staging', 'production']);
  });

  test('ALL_RELEASE_STATUSES has 4 states', () => {
    expect(ALL_RELEASE_STATUSES).toEqual(['planned', 'built', 'deployed', 'rolled_back']);
  });

  test('type guards accept valid + reject invalid', () => {
    expect(isReleaseEnvironment('production')).toBe(true);
    expect(isReleaseEnvironment('test')).toBe(false);
    expect(isReleaseStatus('deployed')).toBe(true);
    expect(isReleaseStatus('promoted')).toBe(false);
  });
});

// ── 2. resolveReleaseInfo ─────────────────────────────────────────────

describe('resolveReleaseInfo', () => {
  test('happy path with all env vars set', () => {
    const info = resolveReleaseInfo(
      {
        APEX_VERSION: '1.4.0',
        APEX_GIT_SHA: '0123456789abcdef',
        APEX_GIT_BRANCH: 'main',
        APEX_BUILT_AT: '2026-05-21T10:00:00.000Z',
        APEX_ENVIRONMENT: 'production',
        APEX_SERVICE_NAME: 'bff',
      },
      () => NOW,
    );
    expect(info.version).toBe('1.4.0');
    expect(info.git_sha).toBe('0123456789ab');
    expect(info.git_sha_full).toBe('0123456789abcdef');
    expect(info.git_branch).toBe('main');
    expect(info.built_at).toBe('2026-05-21T10:00:00.000Z');
    expect(info.environment).toBe('production');
    expect(info.service_name).toBe('bff');
    expect(info.runtime.node_version).toBe(process.version);
  });

  test('falls back to defaults when env unset', () => {
    const info = resolveReleaseInfo({}, () => NOW);
    expect(info.version).toBe('0.0.0-dev');
    expect(info.git_sha).toBe('unknown');
    expect(info.environment).toBe('development');
    expect(info.built_at).toBe(NOW.toISOString());
  });

  test('rejects unknown environment by falling back to development', () => {
    const info = resolveReleaseInfo({ APEX_ENVIRONMENT: 'sandboox' }, () => NOW);
    expect(info.environment).toBe('development');
  });

  test('short SHA passthrough', () => {
    const info = resolveReleaseInfo({ APEX_GIT_SHA: 'abc1234' }, () => NOW);
    expect(info.git_sha).toBe('abc1234');
    expect(info.git_sha_full).toBe('abc1234');
  });
});

// ── 3. Store CRUD ─────────────────────────────────────────────────────

describe('InMemoryReleaseHistoryStore', () => {
  test('create happy path', () => {
    const s = new InMemoryReleaseHistoryStore();
    const e = s.create('BIL', validInput(), 'admin', NOW);
    expect(e.release_id).toBe('r_1_4_0_prod');
    expect(e.version).toBe('1.4.0');
    expect(e.status).toBe('deployed');
    expect(e.rollback_of).toBeNull();
  });

  test('rolled_back status requires rollback_of', () => {
    const s = new InMemoryReleaseHistoryStore();
    expect(() =>
      s.create('BIL', validInput({ status: 'rolled_back' }), 'admin', NOW),
    ).toThrow(/invalid_rollback_ref/);
  });

  test('rollback_of set without status=rolled_back → invalid', () => {
    const s = new InMemoryReleaseHistoryStore();
    expect(() =>
      s.create(
        'BIL',
        validInput({ rollback_of: 'r_1_3_5_prod' }),
        'admin',
        NOW,
      ),
    ).toThrow(/invalid_rollback_ref/);
  });

  test('rolled_back happy path', () => {
    const s = new InMemoryReleaseHistoryStore();
    const e = s.create(
      'BIL',
      validInput({
        release_id: 'r_1_4_0_rollback',
        status: 'rolled_back',
        rollback_of: 'r_1_3_5_prod',
      }),
      'admin',
      NOW,
    );
    expect(e.status).toBe('rolled_back');
    expect(e.rollback_of).toBe('r_1_3_5_prod');
  });

  test('duplicate release_id → 409', () => {
    const s = new InMemoryReleaseHistoryStore();
    s.create('BIL', validInput(), 'admin', NOW);
    expect(() => s.create('BIL', validInput(), 'admin', NOW)).toThrow(/duplicate_release_id/);
  });

  test('list sorted newest-first by released_at', () => {
    const s = new InMemoryReleaseHistoryStore();
    s.create(
      'BIL',
      validInput({ release_id: 'r_a', released_at: '2026-01-15T09:00:00.000Z' }),
      'admin',
      NOW,
    );
    s.create(
      'BIL',
      validInput({ release_id: 'r_b', released_at: '2026-03-15T09:00:00.000Z' }),
      'admin',
      NOW,
    );
    s.create(
      'BIL',
      validInput({ release_id: 'r_c', released_at: '2026-02-15T09:00:00.000Z' }),
      'admin',
      NOW,
    );
    expect(s.list('BIL').map((r) => r.release_id)).toEqual(['r_b', 'r_c', 'r_a']);
  });

  test('list filter by environment', () => {
    const s = new InMemoryReleaseHistoryStore();
    s.create('BIL', validInput({ release_id: 'r_prod' }), 'admin', NOW);
    s.create(
      'BIL',
      validInput({ release_id: 'r_staging', environment: 'staging' }),
      'admin',
      NOW,
    );
    expect(s.list('BIL', { environment: 'staging' }).map((r) => r.release_id)).toEqual([
      'r_staging',
    ]);
  });

  test('resolveCurrent returns newest deployed for env', () => {
    const s = new InMemoryReleaseHistoryStore();
    s.create(
      'BIL',
      validInput({
        release_id: 'r_old',
        released_at: '2026-01-15T09:00:00.000Z',
        status: 'deployed',
      }),
      'admin',
      NOW,
    );
    s.create(
      'BIL',
      validInput({
        release_id: 'r_new',
        released_at: '2026-04-15T09:00:00.000Z',
        status: 'deployed',
      }),
      'admin',
      NOW,
    );
    expect(s.resolveCurrent('BIL', 'production')?.release_id).toBe('r_new');
  });

  test('resolveCurrent returns null when no deployed entry', () => {
    const s = new InMemoryReleaseHistoryStore();
    s.create('BIL', validInput({ status: 'built' }), 'admin', NOW);
    expect(s.resolveCurrent('BIL', 'production')).toBeNull();
  });

  test('soft-delete excludes from list', () => {
    const s = new InMemoryReleaseHistoryStore();
    s.create('BIL', validInput(), 'admin', NOW);
    s.softDelete('BIL', 'r_1_4_0_prod', 'admin', NOW);
    expect(s.list('BIL')).toHaveLength(0);
    expect(s.list('BIL', { include_deleted: true })).toHaveLength(1);
    expect(s.get('BIL', 'r_1_4_0_prod')).toBeNull();
  });

  test('update merges patch + cross-field invariant', () => {
    const s = new InMemoryReleaseHistoryStore();
    s.create('BIL', validInput(), 'admin', NOW);
    // Switching to rolled_back without rollback_of throws.
    expect(() =>
      s.update('BIL', 'r_1_4_0_prod', { status: 'rolled_back' }, 'admin', NOW),
    ).toThrow(/invalid_rollback_ref/);
    // With rollback_of → ok.
    const ok = s.update(
      'BIL',
      'r_1_4_0_prod',
      { status: 'rolled_back', rollback_of: 'r_1_3_5_prod' },
      'admin',
      NOW,
    );
    expect(ok.status).toBe('rolled_back');
    expect(ok.rollback_of).toBe('r_1_3_5_prod');
  });

  test('restore round-trip', () => {
    const s = new InMemoryReleaseHistoryStore();
    const e = s.create('BIL', validInput(), 'admin', NOW);
    s.softDelete('BIL', 'r_1_4_0_prod', 'admin', NOW);
    expect(s.restore({ ...e, deleted_at: NOW.toISOString(), deleted_by: 'admin' })).toBe(true);
    expect(s.get('BIL', 'r_1_4_0_prod')?.deleted_at).toBeNull();
    // Restore conflict.
    expect(s.restore({ ...e })).toBe(false);
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryReleaseHistoryStore();
    s.create('BIL', validInput(), 'admin', NOW);
    expect(s.list('BANK_DEMO')).toHaveLength(0);
    expect(s.get('BANK_DEMO', 'r_1_4_0_prod')).toBeNull();
  });

  test('validation: bad version', () => {
    const s = new InMemoryReleaseHistoryStore();
    expect(() => s.create('BIL', validInput({ version: 'not valid!' }), 'admin', NOW)).toThrow(/invalid_version/);
  });

  test('validation: bad git_sha', () => {
    const s = new InMemoryReleaseHistoryStore();
    expect(() => s.create('BIL', validInput({ git_sha: 'XYZ' }), 'admin', NOW)).toThrow(/invalid_git_sha/);
  });

  test('cap_reached', () => {
    const s = new InMemoryReleaseHistoryStore();
    for (let i = 0; i < RELEASE_HISTORY_CAP_PER_TENANT; i++) {
      s.create('BIL', validInput({ release_id: `r_${i}_x` }), 'admin', NOW);
    }
    expect(() =>
      s.create('BIL', validInput({ release_id: 'r_over_x' }), 'admin', NOW),
    ).toThrow(/cap_reached/);
  });
});

// ── 4. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/release/info', () => {
  test('admin → 200 with release metadata', async () => {
    const app = makeReleaseApp('admin', {
      releaseEnvSource: {
        APEX_VERSION: '1.4.0',
        APEX_GIT_SHA: 'abc1234567',
        APEX_GIT_BRANCH: 'main',
        APEX_BUILT_AT: '2026-05-21T10:00:00.000Z',
        APEX_ENVIRONMENT: 'production',
      },
    });
    const r = await request(app).get('/v1/release/info').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.version).toBe('1.4.0');
    expect(r.body.body.git_sha).toBe('abc1234567');
    expect(r.body.body.environment).toBe('production');
    expect(r.body.body.environments).toEqual([...ALL_RELEASE_ENVIRONMENTS]);
    expect(r.body.body.statuses).toEqual([...ALL_RELEASE_STATUSES]);
  });

  test('field_officer → 403', async () => {
    const app = makeReleaseApp('field_officer');
    const r = await request(app).get('/v1/release/info').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/release/current/:environment', () => {
  test('happy + null when no deployed', async () => {
    const store = new InMemoryReleaseHistoryStore();
    const app = makeReleaseApp('admin', { releaseHistoryStore: store });
    const ok = await request(app).get('/v1/release/current/production').set(TH_BIL);
    expect(ok.status).toBe(200);
    expect(ok.body.body.release).toBeNull();
    // Add a deployed one.
    store.create('BIL', validInput(), 'admin', NOW);
    const after = await request(app).get('/v1/release/current/production').set(TH_BIL);
    expect(after.body.body.release.release_id).toBe('r_1_4_0_prod');
  });

  test('invalid env → 400', async () => {
    const app = makeReleaseApp('admin');
    const r = await request(app).get('/v1/release/current/bogus').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_environment');
  });
});

describe('GET /v1/release/history', () => {
  test('admin → list', async () => {
    const store = new InMemoryReleaseHistoryStore();
    const app = makeReleaseApp('admin', { releaseHistoryStore: store });
    store.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app).get('/v1/release/history').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
  });

  test('?environment filter', async () => {
    const store = new InMemoryReleaseHistoryStore();
    const app = makeReleaseApp('admin', { releaseHistoryStore: store });
    store.create('BIL', validInput(), 'admin', NOW);
    store.create(
      'BIL',
      validInput({ release_id: 'r_staging', environment: 'staging' }),
      'admin',
      NOW,
    );
    const r = await request(app).get('/v1/release/history?environment=staging').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].release_id).toBe('r_staging');
  });

  test('?environment=bogus → 400', async () => {
    const app = makeReleaseApp('admin');
    const r = await request(app).get('/v1/release/history?environment=bogus').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('cross-tenant invisibility', async () => {
    const store = new InMemoryReleaseHistoryStore();
    const app = makeReleaseApp('admin', { releaseHistoryStore: store });
    store.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app).get('/v1/release/history').set(TH_BANK);
    expect(r.body.body.total).toBe(0);
  });
});

describe('POST /v1/release/history', () => {
  test('happy → 201', async () => {
    const app = makeReleaseApp('admin');
    const r = await request(app).post('/v1/release/history').set(TH_BIL).send(validInput());
    expect(r.status).toBe(201);
  });

  test('accepts enveloped body', async () => {
    const app = makeReleaseApp('admin');
    const r = await request(app)
      .post('/v1/release/history')
      .set(TH_BIL)
      .send({ header: { requestId: 'x' }, body: validInput() });
    expect(r.status).toBe(201);
  });

  test('duplicate → 409', async () => {
    const app = makeReleaseApp('admin');
    await request(app).post('/v1/release/history').set(TH_BIL).send(validInput());
    const r = await request(app).post('/v1/release/history').set(TH_BIL).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_release_id');
  });

  test('rolled_back without rollback_of → 400', async () => {
    const app = makeReleaseApp('admin');
    const r = await request(app)
      .post('/v1/release/history')
      .set(TH_BIL)
      .send(validInput({ status: 'rolled_back' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_rollback_ref');
  });

  test('field_officer → 403', async () => {
    const app = makeReleaseApp('field_officer');
    const r = await request(app).post('/v1/release/history').set(TH_BIL).send(validInput());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/release/history/:release_id', () => {
  test('happy + 404', async () => {
    const store = new InMemoryReleaseHistoryStore();
    const app = makeReleaseApp('admin', { releaseHistoryStore: store });
    store.create('BIL', validInput(), 'admin', NOW);
    const ok = await request(app).get('/v1/release/history/r_1_4_0_prod').set(TH_BIL);
    expect(ok.status).toBe(200);
    const miss = await request(app).get('/v1/release/history/nope').set(TH_BIL);
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_release');
  });
});

describe('PATCH /v1/release/history/:release_id', () => {
  test('updates status', async () => {
    const store = new InMemoryReleaseHistoryStore();
    const app = makeReleaseApp('admin', { releaseHistoryStore: store });
    store.create('BIL', validInput({ status: 'built' }), 'admin', NOW);
    const r = await request(app)
      .patch('/v1/release/history/r_1_4_0_prod')
      .set(TH_BIL)
      .send({ status: 'deployed' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('deployed');
  });

  test('unknown release → 404', async () => {
    const app = makeReleaseApp('admin');
    const r = await request(app)
      .patch('/v1/release/history/nope')
      .set(TH_BIL)
      .send({ status: 'deployed' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /v1/release/history/:release_id', () => {
  test('happy → 204', async () => {
    const store = new InMemoryReleaseHistoryStore();
    const app = makeReleaseApp('admin', { releaseHistoryStore: store });
    store.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app).delete('/v1/release/history/r_1_4_0_prod').set(TH_BIL);
    expect(r.status).toBe(204);
    expect(store.get('BIL', 'r_1_4_0_prod')).toBeNull();
  });

  test('unknown → 404', async () => {
    const app = makeReleaseApp('admin');
    const r = await request(app).delete('/v1/release/history/nope').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('field_officer → 403', async () => {
    const app = makeReleaseApp('field_officer');
    const r = await request(app).delete('/v1/release/history/r_1_4_0_prod').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
