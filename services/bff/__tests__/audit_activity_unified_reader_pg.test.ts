// services/bff/__tests__/audit_activity_unified_reader_pg.test.ts
//
// B3 of v1.5+ unified.* consumer migration: pg + hermetic tests for
// the unified.audit_activity cross-chain reader. Distinct from B1/B2/B4
// — this is a NEW admin read surface, not a migration. The view UNIONs
// 3 underlying audit chains:
//   chain      ← audit.event_log (WORM hash-chained regulatory trail)
//   auth_local ← app_iam.audit_events (auth-svc login/role events)
//   approval   ← app_audit.approvals (maker-checker proposals)

import { Pool } from 'pg';
import {
  PgUnifiedAuditActivityReader,
  InMemoryUnifiedAuditActivityReader,
  makeUnifiedAuditActivityReader,
  isAuditActivitySource,
  ALL_AUDIT_ACTIVITY_SOURCES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type AuditActivityEvent,
} from '../src/audit_activity_unified_reader';

const PG_URL = process.env.BFF_PG_URL ?? process.env.ADMIN_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('audit_activity_unified_reader (pg integration — requires BFF_PG_URL)', () => {
  let pool: Pool;
  let reader: PgUnifiedAuditActivityReader;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    reader = new PgUnifiedAuditActivityReader(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  test('fetchActivity returns rows with the full AuditActivityEvent shape', async () => {
    const events = await reader.fetchActivity({ tenant_id: 'BANK_DEMO', limit: 5 });
    expect(events.length).toBeGreaterThan(0);
    const e = events[0];
    expect(isAuditActivitySource(e.source)).toBe(true);
    expect(typeof e.tenant_id).toBe('string');
    expect(typeof e.event_id).toBe('string');
    expect(typeof e.ts).toBe('string');
    // actor / resource_type / resource_id / outcome / severity /
    // correlation_id / metadata may be null per view DDL.
    expect(e.actor === null || typeof e.actor === 'string').toBe(true);
    expect(typeof e.action).toBe('string');
    expect(e.resource_type === null || typeof e.resource_type === 'string').toBe(true);
    expect(e.resource_id === null || typeof e.resource_id === 'string').toBe(true);
    expect(e.outcome === null || typeof e.outcome === 'string').toBe(true);
    expect(e.severity === null || typeof e.severity === 'string').toBe(true);
    expect(e.correlation_id === null || typeof e.correlation_id === 'string').toBe(true);
    expect(e.metadata === null || typeof e.metadata === 'object').toBe(true);
  });

  test('fetchActivity newest-first ordering by ts DESC', async () => {
    const events = await reader.fetchActivity({ tenant_id: 'BANK_DEMO', limit: 20 });
    for (let i = 1; i < events.length; i++) {
      const prev = Date.parse(events[i - 1].ts);
      const curr = Date.parse(events[i].ts);
      // Equal timestamps allowed; never earlier-than-current first.
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  test('fetchActivity respects source filter (chain only)', async () => {
    const chainOnly = await reader.fetchActivity({
      tenant_id: 'BANK_DEMO',
      source: ['chain'],
      limit: 20,
    });
    for (const e of chainOnly) {
      expect(e.source).toBe('chain');
    }
  });

  test('fetchActivity respects multi-source filter', async () => {
    const twoSrcs = await reader.fetchActivity({
      tenant_id: 'BANK_DEMO',
      source: ['chain', 'approval'],
      limit: 50,
    });
    for (const e of twoSrcs) {
      expect(['chain', 'approval']).toContain(e.source);
    }
  });

  test('fetchActivity rejects bogus source enum value', async () => {
    await expect(
      reader.fetchActivity({
        tenant_id: 'BANK_DEMO',
        // @ts-expect-error — testing runtime validation
        source: ['not_a_real_source'],
      }),
    ).rejects.toThrow(/invalid source/);
  });

  test('fetchActivity rejects empty tenant_id', async () => {
    await expect(reader.fetchActivity({ tenant_id: '' })).rejects.toThrow(/tenant_id/);
  });

  test('fetchActivity tenant isolation: BIL returns 0 (no seed)', async () => {
    const bil = await reader.fetchActivity({ tenant_id: 'BIL', limit: 100 });
    expect(bil).toEqual([]);
  });

  test('fetchActivity limit clamped [1, MAX_LIMIT]', async () => {
    const big = await reader.fetchActivity({ tenant_id: 'BANK_DEMO', limit: 999_999 });
    expect(big.length).toBeLessThanOrEqual(MAX_LIMIT);
    const one = await reader.fetchActivity({ tenant_id: 'BANK_DEMO', limit: 0 });
    expect(one.length).toBeLessThanOrEqual(1);
  });

  test('fetchActivity since filter narrows window', async () => {
    // Pick an arbitrary recent date — the seed has events from 2026-05.
    const since = '2026-05-01T00:00:00Z';
    const events = await reader.fetchActivity({ tenant_id: 'BANK_DEMO', since, limit: 100 });
    const sinceMs = Date.parse(since);
    for (const e of events) {
      expect(Date.parse(e.ts)).toBeGreaterThanOrEqual(sinceMs);
    }
  });

  test('fetchActivity until filter narrows window', async () => {
    const until = '2026-01-01T00:00:00Z';
    const events = await reader.fetchActivity({ tenant_id: 'BANK_DEMO', until, limit: 100 });
    const untilMs = Date.parse(until);
    for (const e of events) {
      expect(Date.parse(e.ts)).toBeLessThanOrEqual(untilMs);
    }
  });

  test('fetchByCorrelationId returns oldest-first ladder', async () => {
    // Find a correlation_id that has > 1 event
    const corr = await pool.query(
      `SELECT correlation_id, COUNT(*) AS n
         FROM unified.audit_activity
        WHERE tenant_id = 'BANK_DEMO' AND correlation_id IS NOT NULL
        GROUP BY correlation_id
        HAVING COUNT(*) > 1
        LIMIT 1`,
    );
    if (corr.rowCount === 0) {
      // No multi-event correlation_id in seed — exercise the path anyway.
      const empty = await reader.fetchByCorrelationId('BANK_DEMO', 'unknown-corr-id');
      expect(empty).toEqual([]);
      return;
    }
    const cid = corr.rows[0].correlation_id as string;
    const events = await reader.fetchByCorrelationId('BANK_DEMO', cid, 20);
    expect(events.length).toBeGreaterThan(1);
    // All same tenant + correlation_id
    for (const e of events) {
      expect(e.tenant_id).toBe('BANK_DEMO');
      expect(e.correlation_id).toBe(cid);
    }
    // Oldest-first
    for (let i = 1; i < events.length; i++) {
      const prev = Date.parse(events[i - 1].ts);
      const curr = Date.parse(events[i].ts);
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  test('fetchByCorrelationId returns empty for unknown correlation', async () => {
    const events = await reader.fetchByCorrelationId('BANK_DEMO', 'does-not-exist-99999');
    expect(events).toEqual([]);
  });

  test('fetchByCorrelationId rejects empty inputs', async () => {
    await expect(reader.fetchByCorrelationId('', 'x')).rejects.toThrow(/tenant_id/);
    await expect(reader.fetchByCorrelationId('BANK_DEMO', '')).rejects.toThrow(
      /correlation_id/,
    );
  });

  test('fetchByCorrelationId tenant scoping (cross-tenant returns empty)', async () => {
    const corr = await pool.query(
      `SELECT correlation_id FROM unified.audit_activity
        WHERE tenant_id = 'BANK_DEMO' AND correlation_id IS NOT NULL
        LIMIT 1`,
    );
    if (corr.rowCount === 0) return; // no correlation_id in seed
    const cid = corr.rows[0].correlation_id as string;
    const bil = await reader.fetchByCorrelationId('BIL', cid);
    expect(bil).toEqual([]);
  });

  test('makeUnifiedAuditActivityReader returns reader when view exists', async () => {
    const made = await makeUnifiedAuditActivityReader(pool);
    expect(made).toBeInstanceOf(PgUnifiedAuditActivityReader);
  });

  test('makeUnifiedAuditActivityReader returns undefined on null pool', async () => {
    const made = await makeUnifiedAuditActivityReader(null);
    expect(made).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Hermetic stub tests
// ---------------------------------------------------------------------

describe('InMemoryUnifiedAuditActivityReader (hermetic stub)', () => {
  const seed: AuditActivityEvent[] = [
    {
      source: 'chain',
      tenant_id: 'BANK_DEMO',
      event_id: 'e-001',
      ts: '2026-05-21T10:00:00.000Z',
      actor: 'alice.admin',
      action: 'CASE_CREATED',
      resource_type: null,
      resource_id: 'case-001',
      outcome: null,
      severity: null,
      correlation_id: 'corr-aaa',
      metadata: { reason: 'manual' },
    },
    {
      source: 'auth_local',
      tenant_id: 'BANK_DEMO',
      event_id: 'auth-1',
      ts: '2026-05-21T09:00:00.000Z',
      actor: 'alice.admin',
      action: 'LOGIN_SUCCESS',
      resource_type: 'user',
      resource_id: 'alice.admin',
      outcome: null,
      severity: null,
      correlation_id: null,
      metadata: { ip: '10.0.0.5' },
    },
    {
      source: 'approval',
      tenant_id: 'BANK_DEMO',
      event_id: 'ap-1',
      ts: '2026-05-21T11:00:00.000Z',
      actor: 'bob.maker',
      action: 'PROPOSE',
      resource_type: 'cap',
      resource_id: 'cap-001',
      outcome: 'pending',
      severity: null,
      correlation_id: 'corr-aaa',
      metadata: { case_id: 'case-001' },
    },
    {
      source: 'chain',
      tenant_id: 'BIL',
      event_id: 'e-bil-001',
      ts: '2026-05-20T08:00:00.000Z',
      actor: 'bil.user',
      action: 'CASE_CREATED',
      resource_type: null,
      resource_id: 'case-bil-001',
      outcome: null,
      severity: null,
      correlation_id: 'corr-bil',
      metadata: null,
    },
  ];

  test('fetchActivity newest-first by ts', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const items = await r.fetchActivity({ tenant_id: 'BANK_DEMO' });
    expect(items).toHaveLength(3);
    // ap-1 11:00 → e-001 10:00 → auth-1 09:00
    expect(items[0].event_id).toBe('ap-1');
    expect(items[1].event_id).toBe('e-001');
    expect(items[2].event_id).toBe('auth-1');
  });

  test('fetchActivity tenant-scoped', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const bil = await r.fetchActivity({ tenant_id: 'BIL' });
    expect(bil).toHaveLength(1);
    expect(bil[0].event_id).toBe('e-bil-001');
  });

  test('fetchActivity source filter', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const approvals = await r.fetchActivity({
      tenant_id: 'BANK_DEMO',
      source: ['approval'],
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0].source).toBe('approval');
  });

  test('fetchActivity multi-source filter', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const chainAndApproval = await r.fetchActivity({
      tenant_id: 'BANK_DEMO',
      source: ['chain', 'approval'],
    });
    expect(chainAndApproval).toHaveLength(2);
  });

  test('fetchActivity actor filter', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const alice = await r.fetchActivity({
      tenant_id: 'BANK_DEMO',
      actor: 'alice.admin',
    });
    expect(alice).toHaveLength(2);
  });

  test('fetchActivity action filter', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const logins = await r.fetchActivity({
      tenant_id: 'BANK_DEMO',
      action: 'LOGIN_SUCCESS',
    });
    expect(logins).toHaveLength(1);
    expect(logins[0].action).toBe('LOGIN_SUCCESS');
  });

  test('fetchActivity correlation_id filter', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const corrAaa = await r.fetchActivity({
      tenant_id: 'BANK_DEMO',
      correlation_id: 'corr-aaa',
    });
    expect(corrAaa).toHaveLength(2);
  });

  test('fetchActivity since + until window', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    // Only events between 09:30 and 10:30 → only e-001 at 10:00
    const window = await r.fetchActivity({
      tenant_id: 'BANK_DEMO',
      since: '2026-05-21T09:30:00.000Z',
      until: '2026-05-21T10:30:00.000Z',
    });
    expect(window).toHaveLength(1);
    expect(window[0].event_id).toBe('e-001');
  });

  test('fetchByCorrelationId oldest-first', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const ladder = await r.fetchByCorrelationId('BANK_DEMO', 'corr-aaa');
    expect(ladder).toHaveLength(2);
    expect(ladder[0].event_id).toBe('e-001');   // 10:00
    expect(ladder[1].event_id).toBe('ap-1');    // 11:00
  });

  test('fetchByCorrelationId empty for unknown', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const none = await r.fetchByCorrelationId('BANK_DEMO', 'no-such-corr');
    expect(none).toEqual([]);
  });

  test('fetchByCorrelationId tenant-scoped', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const bil = await r.fetchByCorrelationId('BIL', 'corr-aaa');
    expect(bil).toEqual([]);
  });

  test('limit clamping [1, MAX_LIMIT]', async () => {
    const r = new InMemoryUnifiedAuditActivityReader(seed);
    const zero = await r.fetchActivity({ tenant_id: 'BANK_DEMO', limit: 0 });
    expect(zero.length).toBe(1); // clamped to 1
    const big = await r.fetchActivity({ tenant_id: 'BANK_DEMO', limit: 999_999 });
    expect(big.length).toBeLessThanOrEqual(MAX_LIMIT);
  });

  test('exports DEFAULT_LIMIT=200 + MAX_LIMIT=5000 + closed source enum', () => {
    expect(DEFAULT_LIMIT).toBe(200);
    expect(MAX_LIMIT).toBe(5000);
    expect(ALL_AUDIT_ACTIVITY_SOURCES).toEqual(['chain', 'auth_local', 'approval']);
  });

  test('isAuditActivitySource accepts the 3 valid sources, rejects others', () => {
    expect(isAuditActivitySource('chain')).toBe(true);
    expect(isAuditActivitySource('auth_local')).toBe(true);
    expect(isAuditActivitySource('approval')).toBe(true);
    expect(isAuditActivitySource('other')).toBe(false);
    expect(isAuditActivitySource(null)).toBe(false);
    expect(isAuditActivitySource(undefined)).toBe(false);
    expect(isAuditActivitySource(123)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// HTTP route tests: /v1/admin/audit-activity[/correlation/:cid]
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

const SEED: AuditActivityEvent[] = [
  {
    source: 'chain',
    tenant_id: 'BANK_DEMO',
    event_id: 'e-001',
    ts: '2026-05-21T10:00:00.000Z',
    actor: 'alice.admin',
    action: 'CASE_CREATED',
    resource_type: null,
    resource_id: 'case-001',
    outcome: null,
    severity: null,
    correlation_id: 'corr-aaa',
    metadata: null,
  },
  {
    source: 'auth_local',
    tenant_id: 'BANK_DEMO',
    event_id: 'auth-1',
    ts: '2026-05-21T09:00:00.000Z',
    actor: 'alice.admin',
    action: 'LOGIN_SUCCESS',
    resource_type: 'user',
    resource_id: 'alice.admin',
    outcome: null,
    severity: null,
    correlation_id: null,
    metadata: null,
  },
  {
    source: 'approval',
    tenant_id: 'BANK_DEMO',
    event_id: 'ap-1',
    ts: '2026-05-21T11:00:00.000Z',
    actor: 'bob.maker',
    action: 'PROPOSE',
    resource_type: 'cap',
    resource_id: 'cap-001',
    outcome: 'pending',
    severity: null,
    correlation_id: 'corr-aaa',
    metadata: null,
  },
];

describe('GET /v1/admin/audit-activity (hermetic — InMemoryUnifiedAuditActivityReader)', () => {
  test('200 envelope with newest-first events', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app).get('/v1/admin/audit-activity').set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.total).toBe(3);
    expect(r.body.body.events[0].event_id).toBe('ap-1'); // newest
  });

  test('501 when no reader wired', async () => {
    const { app } = makeApp({}); // no auditActivityReader
    const r = await request(app).get('/v1/admin/audit-activity').set(HEADERS_ADMIN);
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('EWS_501_not_available');
  });

  test('403 when role lacks audit:read', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('?source=chain narrows results', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity?source=chain')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.events.every((e: AuditActivityEvent) => e.source === 'chain')).toBe(
      true,
    );
  });

  test('?source=chain,approval (comma list)', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity?source=chain,approval')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
  });

  test('?source=bogus → 400 EWS_400_invalid_source', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity?source=not_real')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_source');
  });

  test('?actor + ?action filters', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity?actor=alice.admin&action=LOGIN_SUCCESS')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.events[0].event_id).toBe('auth-1');
  });

  test('?limit clamped to integer + forwarded', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity?limit=2')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
  });

  test('?limit=NaN → 400 EWS_400_invalid_input', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity?limit=not_a_number')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('BIL tenant returns 0 (cross-tenant isolation via HTTP)', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });
});

describe('GET /v1/admin/audit-activity/correlation/:correlation_id', () => {
  test('200 oldest-first ladder', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity/correlation/corr-aaa')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.correlation_id).toBe('corr-aaa');
    expect(r.body.body.total).toBe(2);
    // Oldest-first: e-001 (10:00) before ap-1 (11:00)
    expect(r.body.body.events[0].event_id).toBe('e-001');
    expect(r.body.body.events[1].event_id).toBe('ap-1');
  });

  test('200 empty for unknown correlation_id', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity/correlation/unknown-cid')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });

  test('501 when no reader wired', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/audit-activity/correlation/x')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('EWS_501_not_available');
  });

  test('403 when role lacks audit:read', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity/correlation/corr-aaa')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('BIL tenant returns empty (cross-tenant isolation)', async () => {
    const reader = new InMemoryUnifiedAuditActivityReader(SEED);
    const { app } = makeApp({ auditActivityReader: reader });
    const r = await request(app)
      .get('/v1/admin/audit-activity/correlation/corr-aaa')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(0);
  });
});
