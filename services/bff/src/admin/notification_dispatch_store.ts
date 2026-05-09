// services/bff/src/admin/notification_dispatch_store.ts
//
// Append-only log of notification dispatch attempts (T6 M14.24). Every
// time the admin clicks Test-fire — or, in future, the case-creation
// pipeline / escalation worker dispatches a real message — one row
// lands here so operators can audit "what did we send for case X".
//
// PG-backed implementation deferred (M14.24b). The in-memory store is
// FIFO-capped at 500 entries per tenant — same shape as the M14.13
// adapter SLA breach event store, so dev/demo data doesn't grow
// unbounded.

import { randomUUID } from 'node:crypto';
import type { NotificationChannel } from './case_scenarios_types';

export type DispatchTrigger =
  | 'admin_test_fire'
  | 'case_create_pipeline'
  | 'escalation_worker';

export type DispatchStatus =
  /** Render produced a usable subject + body and the dispatch was
   *  enqueued/sent (in the prototype, just logged — no real provider). */
  | 'sent'
  /** Render flagged missing vars OR the caller explicitly suppressed
   *  the send (e.g. preview-only). Logged for visibility but no
   *  downstream effect. */
  | 'preview'
  /** Provider-side failure when we wire one (M14.24b+). */
  | 'failed';

export interface DispatchEntry {
  dispatch_id: string;
  tenant_id: string;
  template_id: string;
  template_name: string;
  channel: NotificationChannel;
  /** Free-text recipient address. Email/SMS provider integration is
   *  out of scope for the prototype — this just captures what an
   *  admin typed (e.g. "alice@bank.com" or "+91...."). */
  recipient: string;
  trigger: DispatchTrigger;
  /** Caller-supplied correlation hint (e.g. "case:c-001"); shows up in
   *  the dispatches log so an admin can pivot from a case to its sent
   *  notifications. */
  reference: string | null;
  rendered_subject: string | null;
  rendered_body: string;
  missing_vars: string[];
  status: DispatchStatus;
  status_reason: string | null;
  performed_by: string;
  performed_at: string;
}

export interface AppendDispatchInput {
  template_id: string;
  template_name: string;
  channel: NotificationChannel;
  recipient: string;
  trigger: DispatchTrigger;
  reference?: string | null;
  rendered_subject: string | null;
  rendered_body: string;
  missing_vars: string[];
  status: DispatchStatus;
  status_reason?: string | null;
  performed_by: string;
}

export interface ListDispatchFilter {
  template_id?: string;
  status?: DispatchStatus[];
  trigger?: DispatchTrigger;
  /** Pivot from a case_id (or any caller-defined reference) to all
   *  notifications dispatched for it. */
  reference?: string;
  /** ISO bound — only entries at-or-after this timestamp. */
  since?: Date;
  page?: number;
  page_size?: number;
}

export interface ListDispatchResult {
  items: DispatchEntry[];
  total: number;
  page: number;
  page_size: number;
}

export interface NotificationDispatchStore {
  append(tenant_id: string, input: AppendDispatchInput, now: Date): Promise<DispatchEntry>;
  list(tenant_id: string, filter: ListDispatchFilter): Promise<ListDispatchResult>;
}

export const DISPATCH_LOG_CAP = 500;

/** In-memory FIFO-capped append-only log. */
export class InMemoryNotificationDispatchStore
  implements NotificationDispatchStore
{
  private readonly map = new Map<string, DispatchEntry[]>();

  async append(
    tenant_id: string,
    input: AppendDispatchInput,
    now: Date,
  ): Promise<DispatchEntry> {
    const entry: DispatchEntry = {
      dispatch_id: randomUUID(),
      tenant_id,
      template_id: input.template_id,
      template_name: input.template_name,
      channel: input.channel,
      recipient: input.recipient,
      trigger: input.trigger,
      reference: input.reference ?? null,
      rendered_subject: input.rendered_subject,
      rendered_body: input.rendered_body,
      missing_vars: [...input.missing_vars],
      status: input.status,
      status_reason: input.status_reason ?? null,
      performed_by: input.performed_by,
      performed_at: now.toISOString(),
    };
    const arr = this.map.get(tenant_id) ?? [];
    arr.push(entry);
    while (arr.length > DISPATCH_LOG_CAP) arr.shift();
    this.map.set(tenant_id, arr);
    return { ...entry };
  }

  async list(
    tenant_id: string,
    filter: ListDispatchFilter,
  ): Promise<ListDispatchResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const arr = this.map.get(tenant_id) ?? [];
    const sinceMs = filter.since?.getTime();
    const filtered = arr.filter((e) => {
      if (filter.template_id && e.template_id !== filter.template_id) return false;
      if (filter.trigger && e.trigger !== filter.trigger) return false;
      if (filter.reference && e.reference !== filter.reference) return false;
      if (filter.status && !filter.status.includes(e.status)) return false;
      if (sinceMs !== undefined && new Date(e.performed_at).getTime() < sinceMs) return false;
      return true;
    });
    const newestFirst = [...filtered].reverse();
    const start = (page - 1) * pageSize;
    return {
      items: newestFirst.slice(start, start + pageSize).map((e) => ({ ...e })),
      total: filtered.length,
      page,
      page_size: pageSize,
    };
  }
}
