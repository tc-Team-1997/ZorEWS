// services/bff/__tests__/copilot_audit_store.test.ts
//
// Copilot-1 — audit + conversation store tests.

import {
  AUDIT_CAP_PER_TENANT,
  CONVERSATION_CAP_PER_TENANT,
  CopilotAuditError,
  InMemoryCopilotAuditStore,
} from '../src/copilot/audit_store';

const NOW = new Date('2026-05-06T10:00:00.000Z');

describe('Copilot-1 — InMemoryCopilotAuditStore', () => {
  // ── Conversations ─────────────────────────────────────────────────

  test('startConversation returns header with user/page/entity', () => {
    const s = new InMemoryCopilotAuditStore();
    const c = s.startConversation({
      tenant_id: 'BIL',
      user_id: 'jane',
      initial_page: 'customer',
      initial_entity_id: 'cust-001',
      now: NOW,
    });
    expect(c.conversation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.user_id).toBe('jane');
    expect(c.message_count).toBe(0);
    expect(c.initial_page).toBe('customer');
    expect(c.initial_entity_id).toBe('cust-001');
  });

  test('rejects empty tenant or user', () => {
    const s = new InMemoryCopilotAuditStore();
    expect(() =>
      s.startConversation({ tenant_id: '', user_id: 'jane', now: NOW } as never),
    ).toThrow(/tenant_id/);
  });

  test('listConversations newest-first; honours user filter', () => {
    const s = new InMemoryCopilotAuditStore();
    s.startConversation({ tenant_id: 'BIL', user_id: 'jane', now: NOW });
    s.startConversation({
      tenant_id: 'BIL',
      user_id: 'bob',
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(s.listConversations('BIL').length).toBe(2);
    expect(s.listConversations('BIL', 'jane').length).toBe(1);
    expect(s.listConversations('BIL')[0]!.user_id).toBe('bob'); // newest first
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryCopilotAuditStore();
    s.startConversation({ tenant_id: 'BIL', user_id: 'jane', now: NOW });
    expect(s.listConversations('BANK_DEMO')).toEqual([]);
  });

  test('conversation FIFO eviction at cap', () => {
    const s = new InMemoryCopilotAuditStore();
    for (let i = 0; i < CONVERSATION_CAP_PER_TENANT + 3; i++) {
      s.startConversation({ tenant_id: 'BIL', user_id: `u${i}`, now: NOW });
    }
    expect(
      s.listConversations('BIL', undefined, 500).length,
    ).toBeLessThanOrEqual(CONVERSATION_CAP_PER_TENANT);
  });

  // ── Messages ──────────────────────────────────────────────────────

  test('appendMessage updates conversation message_count + last_message_at', () => {
    const s = new InMemoryCopilotAuditStore();
    const c = s.startConversation({ tenant_id: 'BIL', user_id: 'jane', now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    s.appendMessage({
      tenant_id: 'BIL',
      conversation_id: c.conversation_id,
      role: 'user',
      text: 'Why is cust-001 high risk?',
      now: later,
    });
    const refetched = s.getConversation('BIL', c.conversation_id)!;
    expect(refetched.message_count).toBe(1);
    expect(refetched.last_message_at).toBe(later.toISOString());
  });

  test('appendMessage to unknown conversation → unknown_conversation', () => {
    const s = new InMemoryCopilotAuditStore();
    try {
      s.appendMessage({
        tenant_id: 'BIL',
        conversation_id: 'no-such',
        role: 'user',
        text: 'hi',
        now: NOW,
      });
      fail('expected throw');
    } catch (e) {
      expect((e as CopilotAuditError).code).toBe('unknown_conversation');
    }
  });

  test('rejects bad role', () => {
    const s = new InMemoryCopilotAuditStore();
    const c = s.startConversation({ tenant_id: 'BIL', user_id: 'jane', now: NOW });
    expect(() =>
      s.appendMessage({
        tenant_id: 'BIL',
        conversation_id: c.conversation_id,
        role: 'system' as never,
        text: 'x',
        now: NOW,
      }),
    ).toThrow(/role/);
  });

  test('listMessages returns oldest-first within a conversation', () => {
    const s = new InMemoryCopilotAuditStore();
    const c = s.startConversation({ tenant_id: 'BIL', user_id: 'jane', now: NOW });
    s.appendMessage({
      tenant_id: 'BIL',
      conversation_id: c.conversation_id,
      role: 'user',
      text: 'first',
      now: NOW,
    });
    s.appendMessage({
      tenant_id: 'BIL',
      conversation_id: c.conversation_id,
      role: 'assistant',
      text: 'reply',
      matched_intent: 'why_high',
      now: new Date(NOW.getTime() + 1000),
    });
    const items = s.listMessages('BIL', c.conversation_id);
    expect(items.map((m) => m.text)).toEqual(['first', 'reply']);
    expect(items[1]!.matched_intent).toBe('why_high');
  });

  // ── Audit log ─────────────────────────────────────────────────────

  test('recordAudit assigns monotonic sequence_no', () => {
    const s = new InMemoryCopilotAuditStore();
    const a = s.recordAudit({
      tenant_id: 'BIL',
      user_id: 'jane',
      message_length: 32,
      masked_pii_kinds: [],
      used_llm: false,
      now: NOW,
    });
    const b = s.recordAudit({
      tenant_id: 'BIL',
      user_id: 'jane',
      message_length: 64,
      masked_pii_kinds: ['email'],
      used_llm: true,
      now: NOW,
    });
    expect(a.sequence_no).toBe(1);
    expect(b.sequence_no).toBe(2);
  });

  test('recordAudit captures pii kinds + intent + page + entity', () => {
    const s = new InMemoryCopilotAuditStore();
    const e = s.recordAudit({
      tenant_id: 'BIL',
      user_id: 'jane',
      conversation_id: 'conv-1',
      intent: 'why_flagged',
      page: 'customer',
      entity_type: 'customer',
      entity_id: 'cust-001',
      message_length: 40,
      masked_pii_kinds: ['customer_id'],
      used_llm: true,
      now: NOW,
    });
    expect(e.intent).toBe('why_flagged');
    expect(e.entity_id).toBe('cust-001');
    expect(e.masked_pii_kinds).toEqual(['customer_id']);
    expect(e.used_llm).toBe(true);
  });

  test('listAudit newest-first; honours user filter', () => {
    const s = new InMemoryCopilotAuditStore();
    s.recordAudit({
      tenant_id: 'BIL',
      user_id: 'jane',
      message_length: 1,
      masked_pii_kinds: [],
      used_llm: false,
      now: NOW,
    });
    s.recordAudit({
      tenant_id: 'BIL',
      user_id: 'bob',
      message_length: 2,
      masked_pii_kinds: [],
      used_llm: false,
      now: new Date(NOW.getTime() + 1000),
    });
    expect(s.listAudit('BIL').length).toBe(2);
    expect(s.listAudit('BIL', { user_id: 'jane' }).length).toBe(1);
    expect(s.listAudit('BIL')[0]!.user_id).toBe('bob');
  });

  test('audit cap eviction', () => {
    const s = new InMemoryCopilotAuditStore();
    for (let i = 0; i < AUDIT_CAP_PER_TENANT + 3; i++) {
      s.recordAudit({
        tenant_id: 'BIL',
        user_id: 'jane',
        message_length: 1,
        masked_pii_kinds: [],
        used_llm: false,
        now: NOW,
      });
    }
    const all = s.listAudit('BIL', {}, 1000);
    expect(all.length).toBeLessThanOrEqual(AUDIT_CAP_PER_TENANT);
  });

  test('listAudit since/until filter', () => {
    const s = new InMemoryCopilotAuditStore();
    s.recordAudit({
      tenant_id: 'BIL',
      user_id: 'jane',
      message_length: 1,
      masked_pii_kinds: [],
      used_llm: false,
      now: new Date('2026-05-01T00:00:00Z'),
    });
    s.recordAudit({
      tenant_id: 'BIL',
      user_id: 'jane',
      message_length: 1,
      masked_pii_kinds: [],
      used_llm: false,
      now: new Date('2026-05-05T00:00:00Z'),
    });
    expect(
      s.listAudit('BIL', { since: '2026-05-03T00:00:00Z' }).length,
    ).toBe(1);
    expect(
      s.listAudit('BIL', { until: '2026-05-03T00:00:00Z' }).length,
    ).toBe(1);
  });

  test('listMessages bad limit rejected', () => {
    const s = new InMemoryCopilotAuditStore();
    expect(() => s.listMessages('BIL', 'conv', 0)).toThrow(/limit/);
    expect(() => s.listMessages('BIL', 'conv', 1001)).toThrow(/limit/);
  });

  test('listAudit bad limit rejected', () => {
    const s = new InMemoryCopilotAuditStore();
    expect(() => s.listAudit('BIL', {}, 0)).toThrow(/limit/);
    expect(() => s.listAudit('BIL', {}, 1001)).toThrow(/limit/);
  });

  test('listConversations bad limit rejected', () => {
    const s = new InMemoryCopilotAuditStore();
    expect(() => s.listConversations('BIL', undefined, 0)).toThrow(/limit/);
    expect(() => s.listConversations('BIL', undefined, 501)).toThrow(/limit/);
  });
});
