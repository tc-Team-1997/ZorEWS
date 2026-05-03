import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { respond, type ChatRequest } from '../src/copilot/chat';

function makeChatApp(role: string | null = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => role,
  });
}

describe('copilot brain — respond()', () => {
  test('greeting → friendly preamble + suggestions', () => {
    const out = respond({ message: 'hello there' });
    expect(out.reply.toLowerCase()).toContain('apex ews copilot');
    expect(out.suggestions.length).toBeGreaterThan(0);
    expect(out.used_context.matched_intent).toBe('greeting');
  });

  test('help → describes capabilities', () => {
    const out = respond({ message: 'what can you do?' });
    expect(out.reply).toMatch(/I can:/);
    expect(out.used_context.matched_intent).toBe('help');
  });

  test('risk_score with customer entity → quotes PD + level', () => {
    const req: ChatRequest = {
      message: 'what is the PD?',
      context: {
        page: 'customer',
        entity: {
          type: 'customer',
          id: 'c-101',
          label: 'Acme Co',
          facts: { pd: 0.62, level: 'High' },
        },
      },
    };
    const out = respond(req);
    expect(out.reply).toMatch(/Acme Co \(c-101\)/);
    expect(out.reply).toMatch(/62\.0%/);
    expect(out.reply).toMatch(/High risk/);
    expect(out.used_context.matched_intent).toBe('risk_score');
    expect(out.used_context.entity_id).toBe('c-101');
  });

  test('risk_score without entity → asks the user to open one', () => {
    const out = respond({ message: 'what is the risk score?', context: { page: 'dashboard' } });
    expect(out.reply.toLowerCase()).toMatch(/open a customer or case/);
  });

  test('why_high with SHAP top_reasons → renders the top 3 with arrows', () => {
    const out = respond({
      message: 'why is the PD high?',
      context: {
        page: 'customer',
        entity: {
          type: 'customer',
          id: 'c-101',
          facts: {
            top_reasons: [
              { feature: 'utilization', direction: 'risk' },
              { feature: 'dpd_max_90d', direction: 'risk' },
              { feature: 'bureau_score', direction: 'protective' },
              { feature: 'tenure_months', direction: 'protective' },
            ] as unknown as never,
          },
        },
      },
    });
    expect(out.reply).toMatch(/Top SHAP drivers/);
    expect(out.reply).toMatch(/↑ utilization/);
    expect(out.reply).toMatch(/↑ dpd_max_90d/);
    expect(out.reply).toMatch(/↓ bureau_score/);
    // Only top 3 are rendered
    expect(out.reply).not.toMatch(/tenure_months/);
  });

  test('recommend_action on customer → role-tailored suggestions', () => {
    const baseFacts = { pd: 0.65 };
    const noRole = respond({
      message: 'what should I do?',
      context: {
        page: 'customer',
        entity: { type: 'customer', id: 'c-1', facts: baseFacts },
      },
    });
    const fieldRole = respond({
      message: 'what should I do next?',
      context: {
        page: 'customer',
        entity: { type: 'customer', id: 'c-1', facts: baseFacts },
        role: 'field_officer',
      },
    });
    expect(noRole.reply).toMatch(/Collection officer/);
    expect(fieldRole.reply).toMatch(/Field officer:/);
  });

  test('summary on case entity → state + severity + action count', () => {
    const out = respond({
      message: 'tldr',
      context: {
        page: 'case',
        entity: {
          type: 'case',
          id: 'case-99',
          label: 'Acme Co arrears',
          facts: { state: 'in_action', severity: 'critical', action_count: 3 },
        },
      },
    });
    expect(out.reply).toMatch(/in_action/);
    expect(out.reply).toMatch(/critical/);
    expect(out.reply).toMatch(/3 actions/);
  });

  test('fallback returns a helpful pointer + suggestions still sized', () => {
    const out = respond({ message: 'qwerty asdf zxcv', context: { page: 'dashboard' } });
    expect(out.used_context.matched_intent).toBe('fallback');
    expect(out.suggestions.length).toBeGreaterThan(0);
  });

  test('suggestions vary by page', () => {
    const dash = respond({ message: 'hi', context: { page: 'dashboard' } });
    const alerts = respond({ message: 'hi', context: { page: 'alerts' } });
    expect(dash.suggestions).not.toEqual(alerts.suggestions);
  });
});

describe('POST /v1/copilot/chat (T4.24 enveloped)', () => {
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('happy path returns reply + suggestions + used_context wrapped in envelope', async () => {
    const { app } = makeChatApp('risk_analyst');
    const res = await request(app)
      .post('/v1/copilot/chat')
      .set(TENANT_HEADERS)
      .send({ message: 'hello', context: { page: 'dashboard' } });
    expect(res.status).toBe(200);
    expect(res.body.header.status).toBe('SUCCESS');
    const inner = res.body.body;
    expect(typeof inner.reply).toBe('string');
    expect(Array.isArray(inner.suggestions)).toBe(true);
    expect(inner.used_context.matched_intent).toBe('greeting');
    expect(inner.used_context.page).toBe('dashboard');
  });

  test('400 envelope when message is empty', async () => {
    const { app } = makeChatApp();
    const res = await request(app).post('/v1/copilot/chat').set(TENANT_HEADERS).send({ message: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EWS_400');
  });

  test('400 envelope when message exceeds 2000 chars', async () => {
    const { app } = makeChatApp();
    const big = 'x'.repeat(2001);
    const res = await request(app).post('/v1/copilot/chat').set(TENANT_HEADERS).send({ message: big });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/2000/);
  });

  test('401 envelope when no role header / role injector returns null', async () => {
    const { app } = makeChatApp(null);
    const res = await request(app).post('/v1/copilot/chat').set(TENANT_HEADERS).send({ message: 'hi' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('EWS_401');
  });

  test('role from request flows into context.role unless explicitly passed', async () => {
    const { app } = makeChatApp('field_officer');
    const res = await request(app)
      .post('/v1/copilot/chat')
      .set(TENANT_HEADERS)
      .send({
        message: 'what should I do next?',
        context: {
          page: 'customer',
          entity: { type: 'customer', id: 'c-1', facts: { pd: 0.55 } },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.body.reply).toMatch(/Field officer:/);
  });
});
