// services/bff/src/notification_per_recipient.ts
//
// T6 M10.14 — Notification per-recipient cross-channel rollup.
//
// M10.12 ships per-channel ledger analytics with `top_recipients[]`
// SEPARATED by channel. M10.14 ships the UNIFIED recipient list
// across all three channels — one row per recipient identifier
// disambiguated by kind:
//   - email_address  → email recipients (string)
//   - sms_phone      → SMS recipients (E.164 string)
//   - push_user      → push recipients (user_id, deduplicated across
//                      devices of the same user per send)
//
// An email + SMS + push for the same human still surfaces as
// THREE rows. Operators reason about "who's getting alerts via
// this channel" — the recipient identifier IS the address space,
// not the human behind it.
//
// Pure rollup. Companion to M15.8 (audit per-actor activity) but
// for the notifications surface.

import type { EmailLedgerEntry, EmailTransport } from './notifications/email';
import type { SmsLedgerEntry, SmsTransport } from './notifications/sms';
import type { PushLedgerEntry, PushTransport } from './notifications/push';

// ─── Public types ─────────────────────────────────────────────────────

export type RecipientKind = 'email_address' | 'sms_phone' | 'push_user';

export interface RecipientRow {
  recipient_id: string;
  recipient_kind: RecipientKind;
  total_sent: number;
  /** Per-channel breakdown. The "channel" is implied by the kind
   *  (email_address → email, sms_phone → sms, push_user → push) but
   *  we still emit the same shape for SPA grid uniformity. */
  by_channel: { email: number; sms: number; push: number };
  /** Most-recent ISO timestamp across this recipient's sends. */
  most_recent_at: string | null;
  /** Distinct template_ids observed for this recipient. Sorted asc. */
  distinct_templates: string[];
}

export interface NotificationPerRecipientSummary {
  tenant_id: string;
  generated_at: string;
  total_sent_all_channels: number;
  total_distinct_recipients: number;
  /** Per-kind counts of distinct recipients (NOT messages — a single
   *  email recipient who got 5 messages counts once here). */
  by_kind: Record<RecipientKind, number>;
  /** Top recipients sorted by total_sent desc with recipient_id asc
   *  tie-break. Capped at 20 for SPA "biggest fan-out targets" panel. */
  top_recipients: RecipientRow[];
  /** Full ranked list — same sort as top_recipients but uncapped.
   *  Lets callers paginate / filter without re-aggregating. */
  recipients: RecipientRow[];
  /** Most-active recipient. null when zero sends observed. */
  most_active_recipient: {
    recipient_id: string;
    recipient_kind: RecipientKind;
    total_sent: number;
  } | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

const TOP_CAP = 20;

function key(kind: RecipientKind, id: string): string {
  return `${kind}::${id}`;
}

function bumpRow(
  rows: Map<string, RecipientRow>,
  kind: RecipientKind,
  recipient_id: string,
  channel: 'email' | 'sms' | 'push',
  sent_at: string,
  template_id: string | undefined,
): void {
  const k = key(kind, recipient_id);
  let row = rows.get(k);
  if (!row) {
    row = {
      recipient_id,
      recipient_kind: kind,
      total_sent: 0,
      by_channel: { email: 0, sms: 0, push: 0 },
      most_recent_at: null,
      distinct_templates: [],
    };
    rows.set(k, row);
  }
  row.total_sent++;
  row.by_channel[channel]++;
  if (!row.most_recent_at || sent_at > row.most_recent_at) {
    row.most_recent_at = sent_at;
  }
  if (template_id && !row.distinct_templates.includes(template_id)) {
    row.distinct_templates.push(template_id);
  }
}

export function buildPerRecipientSummary(
  tenant_id: string,
  email: readonly EmailLedgerEntry[],
  sms: readonly SmsLedgerEntry[],
  push: readonly PushLedgerEntry[],
  now: Date,
): NotificationPerRecipientSummary {
  const rows = new Map<string, RecipientRow>();

  // email: 'to' is string[] — multi-recipient fan-out counts as N sends.
  // 'cc' addresses NOT counted: ops convention is that the primary
  // recipient is the addressee; cc is a copy. Same convention as M10.12.
  for (const e of email) {
    for (const addr of e.to ?? []) {
      bumpRow(rows, 'email_address', addr, 'email', e.sent_at, e.template_id);
    }
  }

  // sms: 'to' is single E.164 string per entry.
  for (const s of sms) {
    bumpRow(rows, 'sms_phone', s.to, 'sms', s.sent_at, s.template_id);
  }

  // push: 'to' is PushDevice[] but the recipient is the USER. A push
  // fanned out to 2 devices of the same user counts as 1 send for that
  // user (matches M10.12 push recipient counting).
  for (const p of push) {
    const seen = new Set<string>();
    for (const d of p.to ?? []) {
      if (seen.has(d.user_id)) continue;
      seen.add(d.user_id);
      bumpRow(rows, 'push_user', d.user_id, 'push', p.sent_at, p.template_id);
    }
  }

  // Sort distinct_templates per row.
  for (const row of rows.values()) row.distinct_templates.sort();

  const recipients = [...rows.values()].sort((a, b) => {
    if (b.total_sent !== a.total_sent) return b.total_sent - a.total_sent;
    return a.recipient_id.localeCompare(b.recipient_id);
  });

  const total_sent_all_channels = recipients.reduce((acc, r) => acc + r.total_sent, 0);

  const by_kind: Record<RecipientKind, number> = {
    email_address: 0,
    sms_phone: 0,
    push_user: 0,
  };
  for (const r of recipients) by_kind[r.recipient_kind]++;

  const top_recipients = recipients.slice(0, TOP_CAP);
  const most_active_recipient = recipients.length > 0
    ? {
        recipient_id: recipients[0]!.recipient_id,
        recipient_kind: recipients[0]!.recipient_kind,
        total_sent: recipients[0]!.total_sent,
      }
    : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_sent_all_channels,
    total_distinct_recipients: recipients.length,
    by_kind,
    top_recipients,
    recipients,
    most_active_recipient,
  };
}

/** Route-level convenience: drains tenant ledgers from the 3
 *  transports and runs the summary. Limit caller-tunable. */
export function buildPerRecipientSummaryFromTransports(
  tenant_id: string,
  emailTransport: EmailTransport,
  smsTransport: SmsTransport,
  pushTransport: PushTransport,
  now: Date,
  limit = 500,
): NotificationPerRecipientSummary {
  const email = emailTransport.recent(tenant_id, limit);
  const sms = smsTransport.recent(tenant_id, limit);
  const push = pushTransport.recent(tenant_id, limit);
  return buildPerRecipientSummary(tenant_id, email, sms, push, now);
}
