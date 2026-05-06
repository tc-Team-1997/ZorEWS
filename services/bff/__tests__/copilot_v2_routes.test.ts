// services/bff/__tests__/copilot_v2_routes.test.ts
//
// Copilot-2 — hardened route tests.

import request from 'supertest';
import { InMemoryCopilotAuditStore } from '../src/copilot/audit_store';
import {
  COPILOT_DEFAULT_LIMIT,
  defaultRateState,
} from '../src/copilot/rate_limiter';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCopilotApp(role = 'risk_analyst') {
  // Reset the per-process rate state between tests (singleton across
  // makeApp calls otherwise).
  defaultRateState.buckets.clear();
  const copilotAuditStore = new InMemoryCopilotAuditStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    copilotAuditStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, copilotAuditStore };
}

// ─── POST /v1/copilot/v2/chat ────────────────────────────────────────

describe('Copilot-2 — POST /v1/copilot/v2/chat', () => {
  test('happy: 200 + conversation_id + EWS intent fires', async () => {
    const { app } = makeCopilotApp();
    const r = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({
        message: 'Why is this customer high risk?',
        context: {
          page: 'customer',
          entity: { type: 'customer', id: 'cust-001', facts: { pd: 0.7 } },
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.conversation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.body.used_intent).toBe('why_flagged');
    expect(r.body.body.reply).toContain('high risk');
    expect(r.body.body.quota.remaining).toBe(COPILOT_DEFAULT_LIMIT - 1);
  });

  test('PII masked before persistence + audit', async () => {
    const { app, copilotAuditStore } = makeCopilotApp();
    const r = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({
        message: 'Email jane@bil.com about cust-001 (PAN ABCDE1234F)',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.masked_pii_kinds.sort()).toEqual([
      'customer_id',
      'email',
      'pan',
    ]);
    // Persisted user message must be masked
    const conv = copilotAuditStore.listConversations('BIL', 'jane.analyst')[0]!;
    const messages = copilotAuditStore.listMessages('BIL', conv.conversation_id);
    expect(messages[0]!.text).toContain('[EMAIL]');
    expect(messages[0]!.text).toContain('[CUSTOMER_ID]');
    expect(messages[0]!.text).toContain('[PAN]');
    expect(messages[0]!.text).not.toContain('jane@bil.com');
  });

  test('conversation_id allows multi-turn continuity', async () => {
    const { app } = makeCopilotApp();
    const a = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({ message: 'hello' });
    const id = a.body.body.conversation_id;
    const b = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({ message: 'what next?', conversation_id: id });
    expect(b.body.body.conversation_id).toBe(id);
  });

  test('unknown conversation_id → 404', async () => {
    const { app } = makeCopilotApp();
    const r = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({ message: 'hi', conversation_id: 'no-such' });
    expect(r.status).toBe(404);
  });

  test('cross-user conversation → 403', async () => {
    const { app } = makeCopilotApp();
    const a = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({ message: 'hi' });
    const id = a.body.body.conversation_id;
    const b = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({ message: 'hi', conversation_id: id });
    expect(b.status).toBe(403);
    expect(b.body.error.code).toBe('EWS_403_conversation_owner_mismatch');
  });

  test('missing message → 400', async () => {
    const { app } = makeCopilotApp();
    const r = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
  });

  test('message > 2000 chars → 400', async () => {
    const { app } = makeCopilotApp();
    const r = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .send({ message: 'x'.repeat(2001) });
    expect(r.status).toBe(400);
  });

  test('rate limit: 30 succeed, 31st returns 429 + Retry-After', async () => {
    const { app } = makeCopilotApp();
    for (let i = 0; i < COPILOT_DEFAULT_LIMIT; i++) {
      const r = await request(app)
        .post('/v1/copilot/v2/chat')
        .set(TH_BIL)
        .set('X-APEX-USER', 'jane.analyst')
        .send({ message: 'hi' });
      expect(r.status).toBe(200);
    }
    const blocked = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({ message: 'hi' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('EWS_429_rate_limited');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  test('non-allowed role (collection_officer) → 403', async () => {
    const { app } = makeCopilotApp('collection_officer');
    const r = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .send({ message: 'hi' });
    expect(r.status).toBe(403);
  });

  test('audit log captures intent + page + entity_type + entity_id + pii kinds', async () => {
    const { app, copilotAuditStore } = makeCopilotApp();
    await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({
        message: 'why is cust-001 high risk',
        context: {
          page: 'customer',
          entity: { type: 'customer', id: 'cust-001', facts: { pd: 0.7 } },
        },
      });
    const audit = copilotAuditStore.listAudit('BIL');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.intent).toBe('why_flagged');
    expect(audit[0]!.page).toBe('customer');
    expect(audit[0]!.entity_type).toBe('customer');
    expect(audit[0]!.entity_id).toBe('cust-001');
    expect(audit[0]!.masked_pii_kinds).toEqual(['customer_id']);
  });

  test('falls through to legacy brain when no EWS intent matches', async () => {
    const { app } = makeCopilotApp();
    const r = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({ message: 'hello' });
    expect(r.status).toBe(200);
    // Legacy brain matches 'greeting' intent
    expect(r.body.body.used_intent).not.toMatch(/why_flagged|summarize_alert|suggest_case_steps|explain_kri/);
  });
});

// ─── GET /v1/copilot/v2/conversations ────────────────────────────────

describe('Copilot-2 — GET /v1/copilot/v2/conversations', () => {
  test('lists user own conversations only', async () => {
    const { app } = makeCopilotApp();
    await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({ message: 'a1' });
    await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({ message: 'b1' });
    const aliceList = await request(app)
      .get('/v1/copilot/v2/conversations')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice');
    expect(aliceList.body.body.total).toBe(1);
    const bobList = await request(app)
      .get('/v1/copilot/v2/conversations')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob');
    expect(bobList.body.body.total).toBe(1);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeCopilotApp();
    await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({ message: 'hi' });
    const other = await request(app)
      .get('/v1/copilot/v2/conversations')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API')
      .set('X-APEX-USER', 'jane');
    expect(other.body.body.total).toBe(0);
  });
});

// ─── GET /v1/copilot/v2/conversations/:id ────────────────────────────

describe('Copilot-2 — GET /v1/copilot/v2/conversations/:id', () => {
  test('returns conversation + messages', async () => {
    const { app } = makeCopilotApp();
    const post = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst')
      .send({ message: 'hi' });
    const id = post.body.body.conversation_id;
    const get = await request(app)
      .get(`/v1/copilot/v2/conversations/${id}`)
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane.analyst');
    expect(get.status).toBe(200);
    expect(get.body.body.conversation_id).toBe(id);
    expect(get.body.body.messages.length).toBe(2); // user + assistant
  });

  test('cross-user → 403', async () => {
    const { app } = makeCopilotApp();
    const post = await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({ message: 'hi' });
    const id = post.body.body.conversation_id;
    const get = await request(app)
      .get(`/v1/copilot/v2/conversations/${id}`)
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob');
    expect(get.status).toBe(403);
  });

  test('unknown id → 404', async () => {
    const { app } = makeCopilotApp();
    const r = await request(app)
      .get('/v1/copilot/v2/conversations/no-such')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

// ─── GET /v1/copilot/v2/quota ────────────────────────────────────────

describe('Copilot-2 — GET /v1/copilot/v2/quota', () => {
  test('returns initial empty quota', async () => {
    const { app } = makeCopilotApp();
    const r = await request(app)
      .get('/v1/copilot/v2/quota')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane');
    expect(r.body.body.limit).toBe(COPILOT_DEFAULT_LIMIT);
    expect(r.body.body.used).toBe(0);
    expect(r.body.body.remaining).toBe(COPILOT_DEFAULT_LIMIT);
    expect(r.body.body.reset_at).toBeNull();
  });

  test('used count reflects prior calls', async () => {
    const { app } = makeCopilotApp();
    await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({ message: 'hi' });
    const r = await request(app)
      .get('/v1/copilot/v2/quota')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane');
    expect(r.body.body.used).toBe(1);
    expect(r.body.body.remaining).toBe(COPILOT_DEFAULT_LIMIT - 1);
  });
});

// ─── GET /v1/copilot/v2/audit ────────────────────────────────────────

describe('Copilot-2 — GET /v1/copilot/v2/audit', () => {
  test('admin-only (audit:read)', async () => {
    const { app } = makeCopilotApp('risk_analyst');
    const r = await request(app).get('/v1/copilot/v2/audit').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('admin can read audit log', async () => {
    const { app } = makeCopilotApp('admin');
    await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'jane')
      .send({ message: 'hi' });
    const r = await request(app)
      .get('/v1/copilot/v2/audit')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(1);
  });

  test('?user_id filter', async () => {
    const { app } = makeCopilotApp('admin');
    await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'alice')
      .send({ message: 'hi' });
    await request(app)
      .post('/v1/copilot/v2/chat')
      .set(TH_BIL)
      .set('X-APEX-USER', 'bob')
      .send({ message: 'hi' });
    const r = await request(app)
      .get('/v1/copilot/v2/audit?user_id=alice')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });
});

// ─── No-regression: legacy /v1/copilot/chat still works ─────────────

describe('Copilot-2 — legacy /v1/copilot/chat untouched', () => {
  test('legacy route still responds (any authenticated role)', async () => {
    const { app } = makeCopilotApp('collection_officer');
    const r = await request(app)
      .post('/v1/copilot/chat')
      .set(TH_BIL)
      .send({ message: 'hello' });
    expect(r.status).toBe(200);
    // Legacy route doesn't have copilot:use gate — collection_officer
    // accepted because the route only requires authentication.
  });
});
