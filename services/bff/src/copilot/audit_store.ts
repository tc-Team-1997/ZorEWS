// services/bff/src/copilot/audit_store.ts
//
// Copilot-1 — conversation persistence + audit log.
//
// 3 facets behind one store interface:
//   1. CopilotConversation — header row per (tenant, user, session)
//   2. CopilotMessage — append-only thread, MASKED text only
//   3. CopilotAuditEntry — one row per query for compliance review
//
// Caps:
//   1000 conversations / tenant
//   5000 messages / tenant
//   10000 audit entries / tenant
// All FIFO with monotonic sequence_no per tenant for stable
// cursor semantics across eviction.

import { randomUUID } from 'node:crypto';
import type { PiiKind } from './pii_masker';

// ─── Public types ─────────────────────────────────────────────────────

export interface CopilotConversation {
  conversation_id: string;
  tenant_id: string;
  user_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  initial_page: string | null;
  initial_entity_id: string | null;
}

export interface CopilotMessage {
  message_id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'assistant';
  /** ALREADY MASKED if role='user'. */
  text: string;
  matched_intent: string | null;
  ts: string;
}

export interface CopilotAuditEntry {
  audit_id: string;
  sequence_no: number;
  tenant_id: string;
  user_id: string;
  conversation_id: string | null;
  intent: string | null;
  page: string | null;
  entity_type: string | null;
  entity_id: string | null;
  message_length: number;
  masked_pii_kinds: PiiKind[];
  used_llm: boolean;
  occurred_at: string;
}

// ─── Caps ─────────────────────────────────────────────────────────────

export const CONVERSATION_CAP_PER_TENANT = 1000;
export const MESSAGE_CAP_PER_TENANT = 5000;
export const AUDIT_CAP_PER_TENANT = 10_000;

// ─── Errors ───────────────────────────────────────────────────────────

export class CopilotAuditError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CopilotAuditError';
  }
}

// ─── Store interface ─────────────────────────────────────────────────

export interface StartConversationInput {
  tenant_id: string;
  user_id: string;
  initial_page?: string;
  initial_entity_id?: string;
  now: Date;
}

export interface AppendMessageInput {
  tenant_id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  text: string;
  matched_intent?: string | null;
  now: Date;
}

export interface RecordAuditInput {
  tenant_id: string;
  user_id: string;
  conversation_id?: string | null;
  intent?: string | null;
  page?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  message_length: number;
  masked_pii_kinds: readonly PiiKind[];
  used_llm: boolean;
  now: Date;
}

export interface CopilotAuditStore {
  startConversation(input: StartConversationInput): CopilotConversation;
  getConversation(tenant_id: string, conversation_id: string): CopilotConversation | null;
  listConversations(
    tenant_id: string,
    user_id?: string,
    limit?: number,
  ): CopilotConversation[];
  appendMessage(input: AppendMessageInput): CopilotMessage;
  listMessages(
    tenant_id: string,
    conversation_id: string,
    limit?: number,
  ): CopilotMessage[];
  recordAudit(input: RecordAuditInput): CopilotAuditEntry;
  listAudit(
    tenant_id: string,
    filter?: { user_id?: string; since?: string; until?: string },
    limit?: number,
  ): CopilotAuditEntry[];
}

// ─── In-memory implementation ────────────────────────────────────────

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export class InMemoryCopilotAuditStore implements CopilotAuditStore {
  private readonly conversations = new Map<string, CopilotConversation[]>();
  private readonly messages = new Map<string, CopilotMessage[]>();
  private readonly audit = new Map<string, CopilotAuditEntry[]>();
  private readonly auditSeq = new Map<string, number>();

  private bucket<T>(map: Map<string, T[]>, key: string): T[] {
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    return arr;
  }

  // ─── Conversations ───────────────────────────────────────────────

  startConversation(input: StartConversationInput): CopilotConversation {
    if (!input.tenant_id || !input.user_id) {
      throw new CopilotAuditError('invalid_input', 'tenant_id + user_id required');
    }
    const arr = this.bucket(this.conversations, input.tenant_id);
    if (arr.length >= CONVERSATION_CAP_PER_TENANT) {
      arr.splice(0, arr.length - CONVERSATION_CAP_PER_TENANT + 1);
    }
    const conv: CopilotConversation = {
      conversation_id: randomUUID(),
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      started_at: input.now.toISOString(),
      last_message_at: input.now.toISOString(),
      message_count: 0,
      initial_page: input.initial_page ?? null,
      initial_entity_id: input.initial_entity_id ?? null,
    };
    arr.push(conv);
    return clone(conv);
  }

  getConversation(tenant_id: string, conversation_id: string): CopilotConversation | null {
    const c = this.conversations.get(tenant_id)?.find((x) => x.conversation_id === conversation_id);
    return c ? clone(c) : null;
  }

  listConversations(
    tenant_id: string,
    user_id?: string,
    limit = 50,
  ): CopilotConversation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new CopilotAuditError('invalid_input', 'limit must be 1..500');
    }
    const arr = this.conversations.get(tenant_id) ?? [];
    return arr
      .filter((c) => !user_id || c.user_id === user_id)
      .sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : -1))
      .slice(0, limit)
      .map((c) => clone(c));
  }

  // ─── Messages ────────────────────────────────────────────────────

  appendMessage(input: AppendMessageInput): CopilotMessage {
    if (input.role !== 'user' && input.role !== 'assistant') {
      throw new CopilotAuditError('invalid_input', "role must be 'user' or 'assistant'");
    }
    if (typeof input.text !== 'string') {
      throw new CopilotAuditError('invalid_input', 'text required');
    }
    const conv = this.conversations
      .get(input.tenant_id)
      ?.find((c) => c.conversation_id === input.conversation_id);
    if (!conv) {
      throw new CopilotAuditError(
        'unknown_conversation',
        `conversation ${input.conversation_id} not found in tenant ${input.tenant_id}`,
      );
    }
    const arr = this.bucket(this.messages, input.tenant_id);
    if (arr.length >= MESSAGE_CAP_PER_TENANT) {
      arr.splice(0, arr.length - MESSAGE_CAP_PER_TENANT + 1);
    }
    const msg: CopilotMessage = {
      message_id: randomUUID(),
      conversation_id: input.conversation_id,
      tenant_id: input.tenant_id,
      role: input.role,
      text: input.text,
      matched_intent: input.matched_intent ?? null,
      ts: input.now.toISOString(),
    };
    arr.push(msg);
    conv.message_count += 1;
    conv.last_message_at = input.now.toISOString();
    return clone(msg);
  }

  listMessages(
    tenant_id: string,
    conversation_id: string,
    limit = 100,
  ): CopilotMessage[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new CopilotAuditError('invalid_input', 'limit must be 1..1000');
    }
    const arr = this.messages.get(tenant_id) ?? [];
    return arr
      .filter((m) => m.conversation_id === conversation_id)
      .sort((a, b) => (a.ts < b.ts ? -1 : 1))
      .slice(0, limit)
      .map((m) => clone(m));
  }

  // ─── Audit log ───────────────────────────────────────────────────

  recordAudit(input: RecordAuditInput): CopilotAuditEntry {
    if (!input.tenant_id || !input.user_id) {
      throw new CopilotAuditError('invalid_input', 'tenant_id + user_id required');
    }
    if (!Number.isInteger(input.message_length) || input.message_length < 0) {
      throw new CopilotAuditError('invalid_input', 'message_length must be a non-negative integer');
    }
    const arr = this.bucket(this.audit, input.tenant_id);
    const next = (this.auditSeq.get(input.tenant_id) ?? 0) + 1;
    this.auditSeq.set(input.tenant_id, next);
    const entry: CopilotAuditEntry = {
      audit_id: randomUUID(),
      sequence_no: next,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      conversation_id: input.conversation_id ?? null,
      intent: input.intent ?? null,
      page: input.page ?? null,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      message_length: input.message_length,
      masked_pii_kinds: [...input.masked_pii_kinds],
      used_llm: input.used_llm,
      occurred_at: input.now.toISOString(),
    };
    arr.push(entry);
    if (arr.length > AUDIT_CAP_PER_TENANT) {
      arr.splice(0, arr.length - AUDIT_CAP_PER_TENANT);
    }
    return clone(entry);
  }

  listAudit(
    tenant_id: string,
    filter: { user_id?: string; since?: string; until?: string } = {},
    limit = 100,
  ): CopilotAuditEntry[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new CopilotAuditError('invalid_input', 'limit must be 1..1000');
    }
    const arr = this.audit.get(tenant_id) ?? [];
    return arr
      .filter((e) => {
        if (filter.user_id && e.user_id !== filter.user_id) return false;
        if (filter.since && e.occurred_at < filter.since) return false;
        if (filter.until && e.occurred_at >= filter.until) return false;
        return true;
      })
      .sort((a, b) => b.sequence_no - a.sequence_no)
      .slice(0, limit)
      .map((e) => clone(e));
  }
}

export const defaultCopilotAuditStore: CopilotAuditStore = new InMemoryCopilotAuditStore();
