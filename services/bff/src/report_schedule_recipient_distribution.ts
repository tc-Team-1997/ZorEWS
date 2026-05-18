// services/bff/src/report_schedule_recipient_distribution.ts
//
// T6 M12.16 — Recurring report schedule recipient distribution.
//
// M12.2 ships recurring report schedules with `recipients[]` (1..25
// email addresses). M12.7 ships fleet upcoming runs. M12.8 ships
// conflict detection. M12.9 ships cadence stats. M12.13 ships daily
// volume. M12.14 ships format × status matrix. M12.15 ships error
// pattern clustering.
//
// M12.16 lands the PER-RECIPIENT pivot: who's getting all the reports?
// Per email_address: distinct schedules they're on + per-cadence
// breakdown + per-report breakdown + most-recent next_run_at.
//
// Drives "who's getting flooded with daily reports? are we
// over-emailing compliance@bil.bt?" inventory view. Useful for
// quarterly recipient hygiene (remove employees who've left,
// consolidate redundant subscriptions).
//
// Mirror of M14.27 / M5.16 / M11.11 / M3.13 1D distribution pattern
// applied to schedule recipients.
//
// Pure resolver — caller passes the drained schedule list.

import type {
  ReportScheduleEntry,
  ScheduleCadence,
} from './report_schedules';
import type { ReportFormat } from './reports_catalog';

const ALL_CADENCES: readonly ScheduleCadence[] = [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'last_day_of_month',
] as const;

const ALL_REPORT_FORMATS: readonly ReportFormat[] = [
  'json',
  'csv',
  'pdf',
  'xlsx',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface ScheduleRecipientRow {
  recipient: string;
  /** Distinct schedules this recipient is on. */
  total_schedules: number;
  /** Distinct schedules that are currently enabled. */
  enabled_schedules: number;
  /** Distinct schedules currently disabled. */
  disabled_schedules: number;
  /** Per-cadence breakdown across this recipient's schedules. */
  by_cadence: Record<ScheduleCadence, number>;
  /** Per-format breakdown. */
  by_format: Record<ReportFormat, number>;
  /** Distinct report_ids this recipient is subscribed to (sorted asc). */
  report_ids: string[];
  /** Earliest next_run_at across this recipient's enabled schedules;
   *  null when no enabled schedules. */
  earliest_next_run_at: string | null;
  /** Schedule names (sorted asc) — capped at 20 for SPA grid. */
  schedule_names: string[];
}

export interface ScheduleRecipientDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_schedules: number;
  total_recipients: number;
  /** Σ schedules × recipients_per_schedule — captures fan-out volume. */
  total_subscriptions: number;
  recipients: ScheduleRecipientRow[];
  /** Top row by total_schedules; canonical email asc tie-break; null
   *  on empty. */
  most_subscribed_recipient: string | null;
  /** Subset whose total_schedules >= 5 (the "flooded" threshold);
   *  sorted by total_schedules desc + email asc tie-break. Surfaces
   *  recipients who are likely getting too much email. */
  flooded_recipients: string[];
}

export const FLOODED_THRESHOLD = 5;

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByCadence(): Record<ScheduleCadence, number> {
  return {
    daily: 0,
    weekly: 0,
    monthly: 0,
    quarterly: 0,
    last_day_of_month: 0,
  };
}

function emptyByFormat(): Record<ReportFormat, number> {
  return { json: 0, csv: 0, pdf: 0, xlsx: 0 };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeScheduleRecipientDistribution(
  tenant_id: string,
  schedules: readonly ReportScheduleEntry[],
  now: Date,
): ScheduleRecipientDistributionSummary {
  type Bucket = {
    total_schedules: number;
    enabled_schedules: number;
    disabled_schedules: number;
    by_cadence: Record<ScheduleCadence, number>;
    by_format: Record<ReportFormat, number>;
    report_ids: Set<string>;
    earliest_next_run_at: string | null;
    schedule_names: Set<string>;
  };
  const buckets = new Map<string, Bucket>();

  let total_subscriptions = 0;

  for (const sched of schedules) {
    // Intra-schedule recipient dedup (recipients[] should already be
    // unique per M12.2 validation, but defensive Set anyway).
    const uniqueRecipients = [...new Set(sched.recipients)];

    for (const recipient of uniqueRecipients) {
      let b = buckets.get(recipient);
      if (!b) {
        b = {
          total_schedules: 0,
          enabled_schedules: 0,
          disabled_schedules: 0,
          by_cadence: emptyByCadence(),
          by_format: emptyByFormat(),
          report_ids: new Set<string>(),
          earliest_next_run_at: null,
          schedule_names: new Set<string>(),
        };
        buckets.set(recipient, b);
      }
      b.total_schedules++;
      total_subscriptions++;
      if (sched.enabled) {
        b.enabled_schedules++;
        if (
          sched.next_run_at &&
          (!b.earliest_next_run_at || sched.next_run_at < b.earliest_next_run_at)
        ) {
          b.earliest_next_run_at = sched.next_run_at;
        }
      } else {
        b.disabled_schedules++;
      }
      if (ALL_CADENCES.includes(sched.cadence)) {
        b.by_cadence[sched.cadence]++;
      }
      if (ALL_REPORT_FORMATS.includes(sched.format)) {
        b.by_format[sched.format]++;
      }
      b.report_ids.add(sched.report_id);
      b.schedule_names.add(sched.name);
    }
  }

  const recipients: ScheduleRecipientRow[] = [...buckets.entries()]
    .map(([recipient, b]) => ({
      recipient,
      total_schedules: b.total_schedules,
      enabled_schedules: b.enabled_schedules,
      disabled_schedules: b.disabled_schedules,
      by_cadence: { ...b.by_cadence },
      by_format: { ...b.by_format },
      report_ids: [...b.report_ids].sort(),
      earliest_next_run_at: b.earliest_next_run_at,
      schedule_names: [...b.schedule_names].sort().slice(0, 20),
    }))
    .sort((a, b) => {
      if (b.total_schedules !== a.total_schedules) {
        return b.total_schedules - a.total_schedules;
      }
      return a.recipient.localeCompare(b.recipient);
    });

  const most_subscribed_recipient =
    recipients.length > 0 ? recipients[0].recipient : null;

  const flooded_recipients = recipients
    .filter((r) => r.total_schedules >= FLOODED_THRESHOLD)
    .map((r) => r.recipient);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_schedules: schedules.length,
    total_recipients: recipients.length,
    total_subscriptions,
    recipients,
    most_subscribed_recipient,
    flooded_recipients,
  };
}
