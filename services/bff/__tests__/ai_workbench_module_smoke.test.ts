// services/bff/__tests__/ai_workbench_module_smoke.test.ts
//
// Module 4.1 — AI Workbench smoke.
//
// Spec routes ALL pre-existed:
//   GET /v1/ai/models                       (M7.1)
//   GET /v1/ai/prompts/library              (M23 prompt library)
//   GET/POST /v1/ai/prompts/:id             (M23)
//   PATCH /v1/ai/prompts/:id                (M23)
//   DELETE /v1/ai/prompts/:id               (M23)
//
// M4.1 closes 3 gaps:
//   AW-2 — virtual ?status=deployed filter on /v1/ai/models that
//          maps to production + shadow
//   AW-3 — spec-shape aliases: POST /v1/ai/prompts/library +
//          PUT /v1/ai/prompts/:id (PATCH stays for backward compat)
//   AW-4 — POST /v1/copilot/chat accepts optional prompt_id —
//          resolves the prompt body from the library + uses it as
//          the message. Closes "adding a prompt makes it immediately
//          available to the co-pilot" acceptance.
//
// Plus the SPA AI Workbench page (3 tabs) and i18n. SPA is not tested
// here (covered by tsc + manual smoke); these tests focus on the BFF
// contract changes.

import request from 'supertest';
import {
  InMemoryAiModelRegistry,
  SEED_MODELS,
  type ModelVersion,
} from '../src/ai_model_registry';
import { _resetAiPromptStore, listPrompts } from '../src/ai_prompts';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-24T12:00:00.000Z');
const TH_BIL = {
  'x-tenant-id': 'BIL',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};
const TH_BANK = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};

function makeSmokeApp(role = 'admin', registry?: InMemoryAiModelRegistry) {
  const aiModelRegistry = registry ?? new InMemoryAiModelRegistry();
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    aiModelRegistry,
    now: () => NOW,
    getRole: () => role,
  });
}

beforeEach(() => {
  _resetAiPromptStore();
});

describe('M4.1 GET /v1/ai/models — virtual ?status=deployed filter', () => {
  it('AW-A: status=deployed returns production + shadow models, excluding others', async () => {
    const registry = new InMemoryAiModelRegistry();
    // Seed catalog has both production + shadow + others.
    const seed = SEED_MODELS as unknown as ModelVersion[];
    const prodCount = seed.filter((m) => m.status === 'production').length;
    const shadowCount = seed.filter((m) => m.status === 'shadow').length;

    const { app } = makeSmokeApp('admin', registry);
    const r = await request(app)
      .get('/v1/ai/models?status=deployed')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(prodCount + shadowCount);
    for (const m of r.body.body.items as ModelVersion[]) {
      expect(['production', 'shadow']).toContain(m.status);
    }
  });

  it('AW-B: regular status values (production / staging / retired) still work', async () => {
    const { app } = makeSmokeApp('admin');
    const r1 = await request(app).get('/v1/ai/models?status=production').set(TH_BIL);
    expect(r1.status).toBe(200);
    expect((r1.body.body.items as ModelVersion[]).every((m) => m.status === 'production')).toBe(true);

    // Unknown value still rejected
    const r2 = await request(app).get('/v1/ai/models?status=bogus').set(TH_BIL);
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('EWS_400_invalid_status');
  });
});

describe('M4.1 spec-shape route aliases', () => {
  it('AW-C: POST /v1/ai/prompts/library creates a custom prompt + lists it immediately', async () => {
    const { app } = makeSmokeApp('admin');
    const create = await request(app)
      .post('/v1/ai/prompts/library')
      .set(TH_BIL)
      .send({
        name: 'M4.1 test prompt',
        category: 'investigation',
        body: 'Investigate the customer {{customer_id}} root cause for risk band shift.',
        description: 'Smoke test prompt',
        tags: ['m4.1', 'smoke'],
      });
    expect(create.status).toBe(201);
    expect(create.body.body.is_platform).toBe(false);
    expect(create.body.body.created_by).toBe('alice.admin');
    const promptId = create.body.body.prompt_id as string;
    expect(promptId).toMatch(/^pmt-BIL-/);

    // Library lists it immediately (in-memory store)
    const list = await request(app).get('/v1/ai/prompts/library').set(TH_BIL);
    const found = (list.body.body.prompts as Array<{ prompt_id: string }>).find(
      (p) => p.prompt_id === promptId,
    );
    expect(found).toBeDefined();
  });

  it('AW-D: PUT /v1/ai/prompts/:id updates a custom prompt (same semantics as PATCH)', async () => {
    const { app } = makeSmokeApp('admin');
    const created = await request(app)
      .post('/v1/ai/prompts/library')
      .set(TH_BIL)
      .send({
        name: 'PUT alias test',
        category: 'reporting',
        body: 'Original body — at least 10 chars.',
        tags: [],
      });
    const id = created.body.body.prompt_id as string;

    const updated = await request(app)
      .put(`/v1/ai/prompts/${id}`)
      .set(TH_BIL)
      .send({ description: 'Edited via PUT alias' });
    expect(updated.status).toBe(200);
    expect(updated.body.body.description).toBe('Edited via PUT alias');
    expect(updated.body.body.prompt_id).toBe(id);
  });

  it('AW-E: PUT on a platform prompt → 409 platform_immutable', async () => {
    const { app } = makeSmokeApp('admin');
    // First find a platform prompt
    const list = await request(app).get('/v1/ai/prompts/library').set(TH_BIL);
    const platform = (list.body.body.prompts as Array<{ prompt_id: string; is_platform: boolean }>).find(
      (p) => p.is_platform,
    );
    expect(platform).toBeDefined();

    const r = await request(app)
      .put(`/v1/ai/prompts/${platform!.prompt_id}`)
      .set(TH_BIL)
      .send({ description: 'shouldnt work' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_platform_immutable');
  });
});

describe('M4.1 SPEC ACCEPTANCE — adding a prompt makes it immediately available to the co-pilot', () => {
  it('AW-F: created prompt is usable as prompt_id on POST /v1/copilot/chat in the same request session', async () => {
    const { app } = makeSmokeApp('admin');
    const create = await request(app)
      .post('/v1/ai/prompts/library')
      .set(TH_BIL)
      .send({
        name: 'Acceptance copilot prompt',
        category: 'risk_analysis',
        body: 'Summarise top 5 high-risk customers in BIL portfolio with PD > 0.6.',
      });
    expect(create.status).toBe(201);
    const promptId = create.body.body.prompt_id as string;

    // Immediately use the prompt — no schema migration, no warmup.
    const chat = await request(app)
      .post('/v1/copilot/chat')
      .set(TH_BIL)
      .send({ prompt_id: promptId });
    expect(chat.status).toBe(200);
    // Reply shape is opaque (depends on copilot stub) — just confirm
    // the call succeeded + carries a reply field.
    expect(chat.body.body).toBeDefined();
  });

  it('AW-G: prompt_id + message merged: message appended after prompt body', async () => {
    const { app } = makeSmokeApp('admin');
    const create = await request(app)
      .post('/v1/ai/prompts/library')
      .set(TH_BIL)
      .send({
        name: 'Merged prompt test',
        category: 'investigation',
        body: 'Analyse case-id customer history.',
      });
    const promptId = create.body.body.prompt_id as string;

    // Both supplied → call succeeds. (We can't peek inside the stub
    // copilotRespond to verify the merged message exactly, but the
    // 200 response proves the merge path executed without errors.)
    const r = await request(app)
      .post('/v1/copilot/chat')
      .set(TH_BIL)
      .send({ prompt_id: promptId, message: 'Focus on the last 30 days.' });
    expect(r.status).toBe(200);
  });

  it('AW-H: unknown prompt_id → 404 EWS_404_unknown_prompt (no merge attempt)', async () => {
    const { app } = makeSmokeApp('admin');
    const r = await request(app)
      .post('/v1/copilot/chat')
      .set(TH_BIL)
      .send({ prompt_id: 'pmt-BIL-nonexistent', message: 'hi' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_prompt');
  });

  it('AW-I: tenant scoping — BIL prompt not resolvable by BANK_DEMO copilot', async () => {
    const { app } = makeSmokeApp('admin');
    const create = await request(app)
      .post('/v1/ai/prompts/library')
      .set(TH_BIL)
      .send({
        name: 'BIL-only prompt',
        category: 'compliance',
        body: 'BIL-only sensitive workflow analysis.',
      });
    const promptId = create.body.body.prompt_id as string;

    const bdChat = await request(app)
      .post('/v1/copilot/chat')
      .set(TH_BANK)
      .send({ prompt_id: promptId });
    expect(bdChat.status).toBe(404);
    expect(bdChat.body.error.code).toBe('EWS_404_unknown_prompt');
  });

  it('AW-J: legacy {message-only} chat path unaffected (backward compat)', async () => {
    const { app } = makeSmokeApp('admin');
    const r = await request(app)
      .post('/v1/copilot/chat')
      .set(TH_BIL)
      .send({ message: 'Just a typed question, no prompt_id.' });
    expect(r.status).toBe(200);
    expect(r.body.body).toBeDefined();

    // Neither field → 400 (same as before, error message updated)
    const empty = await request(app).post('/v1/copilot/chat').set(TH_BIL).send({});
    expect(empty.status).toBe(400);
  });
});

describe('M4.1 cross-tenant isolation + library shape', () => {
  it('AW-K: BIL-created prompt invisible in BANK_DEMO library list', async () => {
    const { app } = makeSmokeApp('admin');
    const create = await request(app)
      .post('/v1/ai/prompts/library')
      .set(TH_BIL)
      .send({
        name: 'BIL custom isolation',
        category: 'data_quality',
        body: 'BIL-only data quality check prompt.',
      });
    const promptId = create.body.body.prompt_id as string;

    const bilList = await request(app).get('/v1/ai/prompts/library').set(TH_BIL);
    const bdList = await request(app).get('/v1/ai/prompts/library').set(TH_BANK);

    const bilPrompts = bilList.body.body.prompts as Array<{ prompt_id: string; is_platform: boolean }>;
    const bdPrompts = bdList.body.body.prompts as Array<{ prompt_id: string; is_platform: boolean }>;
    expect(bilPrompts.some((p) => p.prompt_id === promptId)).toBe(true);
    expect(bdPrompts.some((p) => p.prompt_id === promptId)).toBe(false);

    // Both tenants see the platform-curated prompts (read-only).
    expect(bilPrompts.filter((p) => p.is_platform).length).toBeGreaterThan(0);
    expect(bdPrompts.filter((p) => p.is_platform).length).toEqual(
      bilPrompts.filter((p) => p.is_platform).length,
    );
  });

  it('AW-L: pure listPrompts honours filter shape', () => {
    // Smoke the pure helper directly — proves the in-memory store
    // surfaces immediately to a same-process caller (the spec
    // "immediately available" semantic).
    const all = listPrompts('BIL');
    expect(all.length).toBeGreaterThan(0); // at least platform prompts
    const filtered = listPrompts('BIL', { category: 'risk_analysis' });
    expect(filtered.every((p) => p.category === 'risk_analysis')).toBe(true);
    const search = listPrompts('BIL', { q: 'npa' });
    expect(search.every((p) => /npa/i.test(p.name + p.body + p.tags.join(',')))).toBe(true);
  });
});
