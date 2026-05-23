// services/bff/src/notification_template_freshness.ts
//
// T6 M10.19 — Notification template freshness rollup.
//
// Per-template staleness rollup across the M10.1 email + M10.2 SMS +
// M10.3 push ledgers. For each of the 12 BIL canned templates,
// surfaces "when was this last sent?" + classifies freshness so ops
// can spot templates that are declared but never used (deprecation
// candidates) or templates whose last fire happened long enough ago
// to warrant a "is this still in active rotation?" review.
//
// 4 canonical freshness buckets:
//   recent        — < fresh_days since last send
//   stable        — in [fresh_days, stale_days]
//   stale         — > stale_days since last send (review candidate)
//   never_sent    — no send ever recorded (config-gap signal —
//                   template declared but never fired)
//
// Strict-< on fresh boundary + strict-> on stale boundary (exact
// thresholds land in 'stable' — matches M11.18 + M13.11 semantics).
//
// Distinct from:
//   M10.11 — unified catalog (catalogue snapshot, no usage data)
//   M10.12 — cross-channel ledger analytics (current send mix; no
//            freshness bucketing per template)
//   M10.13 — variable cross-reference (per-variable indexing)
//   M10.14 — per-recipient rollup
//   M10.15 — daily volume timeline (time-series, not per-template)
//   M10.16 — template usage analytics (usage counts + most_recent
//            but no fresh/stale classification)
//   M10.17 — push platform distribution
//   M10.18 — variable × channel matrix
//
// Mirror of M11.18 (dashboard freshness) + M7.18 (model performance
// freshness) + M13.11 (config override age) bucketing pattern for
// the notification templates surface.
//
// Drives BIL ops review per docs/bau-runbook.md monthly checklist:
//   "Do we have any templates declared but never used? — drop them"
//   "OTP_LOGIN last fired 90 days ago — verify SMS flow not broken"

import { introspectNotificationTemplateCatalog } from './notification_template_catalog';
import type { NotificationChannelKey } from './notification_template_catalog';
import type { EmailTransport, EmailLedgerEntry } from './notifications/email';
import type { SmsTransport, SmsLedgerEntry } from './notifications/sms';
import type { PushTransport, PushLedgerEntry } from './notifications/push';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export type TemplateFreshness = 'recent' | 'stable' | 'stale' | 'never_sent';

export const ALL_TEMPLATE_FRESHNESS_BUCKETS: readonly TemplateFreshness[] = [
  'recent',
  'stable',
  'stale',
  'never_sent',
] as const;

/** Weekly-cadence default — quarterly cleanup review per docs/bau-
 *  runbook.md monthly checklist; tighter than M11.18 because canned
 *  templates fire more often than dashboards get updated. */
export const DEFAULT_TEMPLATE_FRESH_DAYS = 14;
export const DEFAULT_TEMPLATE_STALE_DAYS = 60;
export const MAX_STALE_TEMPLATES_LIST = 20;
export const LEDGER_DRAIN_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export class TemplateFreshnessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TemplateFreshnessError';
  }
}

// ---------------------------------------------------------------------
// Pure bucketing helper
// ---------------------------------------------------------------------

/** Bucket a days-since-last-send into recent / stable / stale.
 *  Returns null for never-sent (caller maps to 'never_sent'). */
export function bucketForDaysSinceSend(
  days_since: number | null,
  fresh_days: number,
  stale_days: number,
): TemplateFreshness {
  if (days_since === null) return 'never_sent';
  // strict-< on fresh; strict-> on stale; exact-boundary = stable
  if (days_since < fresh_days) return 'recent';
  if (days_since > stale_days) return 'stale';
  return 'stable';
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface TemplateFreshnessRow {
  channel: NotificationChannelKey;
  template_id: string;
  description: string;
  /** ISO timestamp of newest sent_at where template_id matched.
   *  null when no send ever recorded. */
  last_sent_at: string | null;
  /** Whole-number days elapsed; null when never_sent. */
  days_since_last_send: number | null;
  freshness: TemplateFreshness;
  /** Total sends in the drained ledger window. */
  total_sends_observed: number;
}

export interface NotificationTemplateFreshnessRollup {
  tenant_id: string;
  generated_at: string;
  fresh_days: number;
  stale_days: number;
  total_templates: number;
  /** 4-key partition over the 4 freshness buckets (sum = total_templates). */
  recent_count: number;
  stable_count: number;
  stale_count: number;
  never_sent_count: number;
  /** Mean days_since_last_send across templates with a send observed.
   *  Rounded to 2 decimals; null when zero templates have any send. */
  mean_days_since_send: number | null;
  /** All templates sorted by days_since_last_send desc + (channel, template_id)
   *  asc tie-break (oldest first). never_sent templates appear AT THE TOP
   *  (highest "staleness" score conceptually). */
  templates: TemplateFreshnessRow[];
  /** Subset filter for SPA "review these" panel — never_sent first
   *  (deprecation candidates), then stale, capped at MAX_STALE_TEMPLATES_LIST. */
  templates_needing_attention: TemplateFreshnessRow[];
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function validateBounds(fresh_days: number, stale_days: number): void {
  if (!Number.isInteger(fresh_days) || fresh_days < 0) {
    throw new TemplateFreshnessError(
      'invalid_input',
      'fresh_days must be a non-negative integer',
    );
  }
  if (!Number.isInteger(stale_days) || stale_days < 0) {
    throw new TemplateFreshnessError(
      'invalid_input',
      'stale_days must be a non-negative integer',
    );
  }
  if (stale_days < fresh_days) {
    throw new TemplateFreshnessError(
      'invalid_input',
      'stale_days must be >= fresh_days',
    );
  }
}

/** Sort key for templates[]: never_sent first (Infinity days),
 *  then by days_since desc, tie-break (channel, template_id) asc. */
function compareRow(a: TemplateFreshnessRow, b: TemplateFreshnessRow): number {
  const da = a.days_since_last_send ?? Number.POSITIVE_INFINITY;
  const db = b.days_since_last_send ?? Number.POSITIVE_INFINITY;
  if (da !== db) return db - da;
  if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
  return a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0;
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export interface FreshnessLedgerInput {
  /** Email send ledger filtered to the target tenant (callers can drain
   *  via emailTransport.recent(tenant_id, LEDGER_DRAIN_LIMIT)). */
  email: readonly EmailLedgerEntry[];
  sms: readonly SmsLedgerEntry[];
  push: readonly PushLedgerEntry[];
}

export function summarizeNotificationTemplateFreshness(
  tenant_id: string,
  ledgers: FreshnessLedgerInput,
  now: Date,
  fresh_days: number = DEFAULT_TEMPLATE_FRESH_DAYS,
  stale_days: number = DEFAULT_TEMPLATE_STALE_DAYS,
): NotificationTemplateFreshnessRollup {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new TemplateFreshnessError('invalid_input', 'tenant_id required');
  }
  validateBounds(fresh_days, stale_days);

  // Build per-template (channel, template_id) → { last_sent_ms, total_sends }
  // by scanning each channel's ledger for entries carrying template_id.
  const stats = new Map<
    string,
    { last_sent_ms: number; total_sends: number }
  >();
  const key = (channel: NotificationChannelKey, template_id: string) =>
    `${channel}::${template_id}`;

  const recordSend = (
    channel: NotificationChannelKey,
    template_id: string | undefined,
    sent_at: string,
  ) => {
    if (!template_id) return; // ad-hoc untemplated sends excluded
    const sentMs = Date.parse(sent_at);
    if (!Number.isFinite(sentMs)) return;
    const k = key(channel, template_id);
    const prev = stats.get(k);
    if (prev) {
      prev.total_sends += 1;
      if (sentMs > prev.last_sent_ms) prev.last_sent_ms = sentMs;
    } else {
      stats.set(k, { last_sent_ms: sentMs, total_sends: 1 });
    }
  };

  for (const e of ledgers.email) recordSend('email', e.template_id, e.sent_at);
  for (const e of ledgers.sms) recordSend('sms', e.template_id, e.sent_at);
  for (const e of ledgers.push) recordSend('push', e.template_id, e.sent_at);

  // Walk every template in the catalog (always emit a row even if no
  // sends — that's the never_sent case). Catalog is platform-static
  // so order is canonical (channel asc, template_id asc).
  const catalog = introspectNotificationTemplateCatalog();
  const rows: TemplateFreshnessRow[] = [];
  const nowMs = now.getTime();

  for (const entry of catalog.templates) {
    const k = key(entry.channel, entry.template_id);
    const s = stats.get(k);
    const last_sent_ms = s?.last_sent_ms ?? null;
    const last_sent_at =
      last_sent_ms === null ? null : new Date(last_sent_ms).toISOString();
    const days_since_last_send =
      last_sent_ms === null
        ? null
        : Math.max(0, Math.floor((nowMs - last_sent_ms) / DAY_MS));
    const freshness = bucketForDaysSinceSend(
      days_since_last_send,
      fresh_days,
      stale_days,
    );
    rows.push({
      channel: entry.channel,
      template_id: entry.template_id,
      description: entry.description,
      last_sent_at,
      days_since_last_send,
      freshness,
      total_sends_observed: s?.total_sends ?? 0,
    });
  }

  rows.sort(compareRow);

  // Aggregate stats
  let recent_count = 0;
  let stable_count = 0;
  let stale_count = 0;
  let never_sent_count = 0;
  let sumDays = 0;
  let countedDays = 0;
  for (const r of rows) {
    if (r.freshness === 'recent') recent_count += 1;
    else if (r.freshness === 'stable') stable_count += 1;
    else if (r.freshness === 'stale') stale_count += 1;
    else never_sent_count += 1;
    if (r.days_since_last_send !== null) {
      sumDays += r.days_since_last_send;
      countedDays += 1;
    }
  }
  const mean_days_since_send =
    countedDays === 0 ? null : Math.round((sumDays / countedDays) * 100) / 100;

  // templates_needing_attention: never_sent first (deprecation
  // candidates), then stale, both already at the top of rows[]
  // (since rows[] sorts never_sent at the top by Infinity days_since)
  const attention = rows
    .filter((r) => r.freshness === 'never_sent' || r.freshness === 'stale')
    .slice(0, MAX_STALE_TEMPLATES_LIST);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    fresh_days,
    stale_days,
    total_templates: rows.length,
    recent_count,
    stable_count,
    stale_count,
    never_sent_count,
    mean_days_since_send,
    templates: rows,
    templates_needing_attention: attention,
  };
}

// ---------------------------------------------------------------------
// Transport adapter — drains all 3 channels' ledgers
// ---------------------------------------------------------------------

export function summarizeNotificationTemplateFreshnessFromTransports(
  email: EmailTransport,
  sms: SmsTransport,
  push: PushTransport,
  tenant_id: string,
  now: Date,
  fresh_days: number = DEFAULT_TEMPLATE_FRESH_DAYS,
  stale_days: number = DEFAULT_TEMPLATE_STALE_DAYS,
): NotificationTemplateFreshnessRollup {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new TemplateFreshnessError('invalid_input', 'tenant_id required');
  }
  const ledgers: FreshnessLedgerInput = {
    email: email.recent(tenant_id, LEDGER_DRAIN_LIMIT),
    sms: sms.recent(tenant_id, LEDGER_DRAIN_LIMIT),
    push: push.recent(tenant_id, LEDGER_DRAIN_LIMIT),
  };
  return summarizeNotificationTemplateFreshness(
    tenant_id,
    ledgers,
    now,
    fresh_days,
    stale_days,
  );
}
