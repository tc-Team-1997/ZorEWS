// services/bff/src/notification_template_usage.ts
//
// T6 M10.16 — Notification template usage analytics.
//
// M10.11 ships the unified template catalog (12 templates: 4 email +
// 4 SMS + 4 push). M10.12 ships the cross-channel ledger analytics
// pivoted by CHANNEL. M10.13 ships the variable cross-reference.
// M10.16 lands the orthogonal pivot — by TEMPLATE — answering "which
// canned templates get the most use? are any unused (cleanup
// candidates)?".
//
// Mirror of M10.12 structure but with template_id as the primary axis.
// Each template_id uniquely identifies (channel, template) since the
// 12 BIL templates use distinct ids across channels (ALERT_RED for
// email, ALERT_RED_BRIEF for SMS, ALERT_RED_PUSH for push).
//
// Drives the SPA's "template usage" inventory panel + cleanup
// recommendations ("OTP_LOGIN unused this quarter — deprecate?").
//
// Pure resolver — accepts per-channel ledger arrays; tenant scoping
// happens at the caller (transport.recent(tenant_id, ...)).

import {
  introspectNotificationTemplateCatalog,
  type NotificationChannelKey,
  type NotificationCatalogEntry,
} from './notification_template_catalog';
import type { EmailLedgerEntry } from './notifications/email';
import type { SmsLedgerEntry } from './notifications/sms';
import type { PushLedgerEntry } from './notifications/push';

// ─── Public types ─────────────────────────────────────────────────────

export interface TemplateUsageRow {
  template_id: string;
  channel: NotificationChannelKey;
  description: string;
  /** Total sends using this template across the ledger window. */
  total_sent: number;
  /** Distinct recipients — same semantics as M10.12:
   *    email: distinct addresses (one send to to=[a,b] → 2);
   *    sms: distinct E.164;
   *    push: distinct user_ids (one fan-out to N devices of one user → 1). */
  distinct_recipients: number;
  /** Newest sent_at across this template's sends. null when unused. */
  most_recent_sent_at: string | null;
}

export interface NotificationTemplateUsageSummary {
  tenant_id: string;
  generated_at: string;
  total_sent_all_templates: number;
  total_templates_in_catalog: number;
  total_templates_used: number;
  templates: TemplateUsageRow[];
  /** Templates with total_sent === 0 — cleanup candidates. Sorted
   *  canonical (channel asc then template_id asc). */
  unused_templates: TemplateUsageRow[];
  /** Per-channel rollup over the templates (sum + used_count). */
  by_channel: Record<NotificationChannelKey, { total_sent: number; used_count: number; catalog_count: number }>;
  /** Top template by total_sent. Tie-break canonical (channel asc then
   *  template_id asc via iteration order). null when no sends. */
  most_used_template: { template_id: string; channel: NotificationChannelKey; total_sent: number } | null;
  /** Templates where total_sent > 0 + most_recent_sent_at older than
   *  STALE_DAYS days (computed against `now`). Sorted oldest-first. */
  stale_templates: TemplateUsageRow[];
}

// ─── Constants ────────────────────────────────────────────────────────

const STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────

interface TemplateBuilder {
  template_id: string;
  channel: NotificationChannelKey;
  description: string;
  total_sent: number;
  recipients: Set<string>;
  most_recent_ms: number;
  most_recent_iso: string | null;
}

function emptyChannelMap(catalog: readonly NotificationCatalogEntry[]) {
  const out: Record<NotificationChannelKey, { total_sent: number; used_count: number; catalog_count: number }> = {
    email: { total_sent: 0, used_count: 0, catalog_count: 0 },
    sms: { total_sent: 0, used_count: 0, catalog_count: 0 },
    push: { total_sent: 0, used_count: 0, catalog_count: 0 },
  };
  for (const t of catalog) out[t.channel].catalog_count++;
  return out;
}

function bumpEmail(b: TemplateBuilder, entry: EmailLedgerEntry): void {
  b.total_sent++;
  for (const addr of entry.to ?? []) {
    if (typeof addr === 'string' && addr) b.recipients.add(addr);
  }
  const ts = new Date(entry.sent_at).getTime();
  if (Number.isFinite(ts) && ts > b.most_recent_ms) {
    b.most_recent_ms = ts;
    b.most_recent_iso = entry.sent_at;
  }
}

function bumpSms(b: TemplateBuilder, entry: SmsLedgerEntry): void {
  b.total_sent++;
  if (entry.to) b.recipients.add(entry.to);
  const ts = new Date(entry.sent_at).getTime();
  if (Number.isFinite(ts) && ts > b.most_recent_ms) {
    b.most_recent_ms = ts;
    b.most_recent_iso = entry.sent_at;
  }
}

function bumpPush(b: TemplateBuilder, entry: PushLedgerEntry): void {
  b.total_sent++;
  // Distinct push recipients = distinct user_ids in the fan-out (matches
  // M10.12 / M10.14 user-level reach counting).
  const seen = new Set<string>();
  for (const dev of entry.to ?? []) {
    const uid = dev?.user_id;
    if (typeof uid === 'string' && uid && !seen.has(uid)) {
      seen.add(uid);
      b.recipients.add(uid);
    }
  }
  const ts = new Date(entry.sent_at).getTime();
  if (Number.isFinite(ts) && ts > b.most_recent_ms) {
    b.most_recent_ms = ts;
    b.most_recent_iso = entry.sent_at;
  }
}

function toRow(b: TemplateBuilder): TemplateUsageRow {
  return {
    template_id: b.template_id,
    channel: b.channel,
    description: b.description,
    total_sent: b.total_sent,
    distinct_recipients: b.recipients.size,
    most_recent_sent_at: b.most_recent_iso,
  };
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeNotificationTemplateUsage(
  tenant_id: string,
  email: readonly EmailLedgerEntry[],
  sms: readonly SmsLedgerEntry[],
  push: readonly PushLedgerEntry[],
  now: Date,
): NotificationTemplateUsageSummary {
  const catalog = introspectNotificationTemplateCatalog().templates;

  // Seed builders with every catalog entry so unused templates always
  // surface at 0 (stable SPA grid).
  const builders = new Map<string, TemplateBuilder>();
  for (const entry of catalog) {
    builders.set(entry.template_id, {
      template_id: entry.template_id,
      channel: entry.channel,
      description: entry.description,
      total_sent: 0,
      recipients: new Set(),
      most_recent_ms: -Infinity,
      most_recent_iso: null,
    });
  }

  // Walk each ledger.
  for (const e of email) {
    if (!e.template_id) continue; // untemplated sends excluded
    const b = builders.get(e.template_id);
    if (b) bumpEmail(b, e);
  }
  for (const s of sms) {
    if (!s.template_id) continue;
    const b = builders.get(s.template_id);
    if (b) bumpSms(b, s);
  }
  for (const p of push) {
    if (!p.template_id) continue;
    const b = builders.get(p.template_id);
    if (b) bumpPush(b, p);
  }

  // Canonical order: channel asc (email → in_app → push → sms via
  // String.localeCompare; we want email → sms → in_app → push to match
  // M10.12 NotificationChannel display order). Iterate catalog directly
  // since `listNotificationTemplateCatalog` returns canonical order.
  const templates: TemplateUsageRow[] = catalog.map((t) => toRow(builders.get(t.template_id)!));

  // Aggregate totals.
  let total_sent_all_templates = 0;
  let total_templates_used = 0;
  const by_channel = emptyChannelMap(catalog);
  for (const row of templates) {
    total_sent_all_templates += row.total_sent;
    if (row.total_sent > 0) {
      total_templates_used++;
      by_channel[row.channel].used_count++;
    }
    by_channel[row.channel].total_sent += row.total_sent;
  }

  // unused_templates — total_sent === 0; canonical order.
  const unused_templates = templates.filter((r) => r.total_sent === 0);

  // most_used_template — highest total_sent; canonical iteration order
  // tie-break (templates[] already in canonical order, so strict `>` keeps
  // the first one at any tied count).
  let most_used: TemplateUsageRow | null = null;
  for (const row of templates) {
    if (row.total_sent > 0 && (!most_used || row.total_sent > most_used.total_sent)) {
      most_used = row;
    }
  }
  const most_used_template = most_used
    ? { template_id: most_used.template_id, channel: most_used.channel, total_sent: most_used.total_sent }
    : null;

  // stale_templates — used but last send > STALE_DAYS ago.
  const staleCutoff = now.getTime() - STALE_DAYS * MS_PER_DAY;
  const stale_templates: TemplateUsageRow[] = templates
    .filter((r) => {
      if (r.total_sent === 0 || !r.most_recent_sent_at) return false;
      const ts = new Date(r.most_recent_sent_at).getTime();
      return Number.isFinite(ts) && ts < staleCutoff;
    })
    .sort((a, z) => (a.most_recent_sent_at ?? '').localeCompare(z.most_recent_sent_at ?? ''));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_sent_all_templates,
    total_templates_in_catalog: catalog.length,
    total_templates_used,
    templates,
    unused_templates,
    by_channel,
    most_used_template,
    stale_templates,
  };
}

// ─── Route convenience ────────────────────────────────────────────────

import type { EmailTransport } from './notifications/email';
import type { SmsTransport } from './notifications/sms';
import type { PushTransport } from './notifications/push';

/** Drains the 3 channel ledgers via the transports and runs the
 *  summary. limit caller-tunable. */
export function summarizeNotificationTemplateUsageFromTransports(
  tenant_id: string,
  emailTransport: EmailTransport,
  smsTransport: SmsTransport,
  pushTransport: PushTransport,
  now: Date,
  limit = 500,
): NotificationTemplateUsageSummary {
  const email = emailTransport.recent(tenant_id, limit);
  const sms = smsTransport.recent(tenant_id, limit);
  const push = pushTransport.recent(tenant_id, limit);
  return summarizeNotificationTemplateUsage(tenant_id, email, sms, push, now);
}
