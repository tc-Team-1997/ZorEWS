// services/bff/src/alert_class_channel_matrix.ts
//
// T6 M8.14 — Alert class × channel dispatch cross-tab matrix.
//
// M8.13 ships per-channel distribution (1D pivot with by_class
// inside each row). M8.14 elevates that to the proper 2D matrix:
// rows = 4 BilAlertClass × cols = 4 NotificationChannel = 16 cells.
//
// Cells count DISPATCHES not unique alerts — a record with class=red
// channels=['email','sms'] contributes 1 to (red, email) AND 1 to
// (red, sms). Mirror of M7.14 / M5.17 / M13.15 / M14.28 / M3.11
// matrix pattern for the alert routing surface.
//
// Pure resolver — walks a window of RoutedAlertRecord (M8.6 ledger).
// Drives "are critical-class alerts going to email + sms as the
// routing matrix dictates? where are dispatch gaps?".

import {
  BIL_CLASS_ORDER,
  type BilAlertClass,
} from './bil_alert_classification';
import { ALL_NOTIFICATION_CHANNELS } from './alert_channel_distribution';
import type { NotificationChannel } from './alert_routing';
import type { RoutedAlertRecord } from './alert_routing_analytics';

// ─── Public types ─────────────────────────────────────────────────────

export interface AlertClassChannelCell {
  class: BilAlertClass;
  channel: NotificationChannel;
  count: number;
}

export interface AlertClassRow {
  class: BilAlertClass;
  total: number;
  by_channel: Record<NotificationChannel, number>;
  /** Channels never dispatched for this class within the window.
   *  Sorted in canonical ALL_NOTIFICATION_CHANNELS order. */
  channels_without: NotificationChannel[];
}

export interface AlertChannelColumn {
  channel: NotificationChannel;
  total: number;
  by_class: Record<BilAlertClass, number>;
  /** Classes that never dispatched this channel within the window.
   *  Sorted in canonical BIL_CLASS_ORDER. */
  classes_without: BilAlertClass[];
}

export interface AlertClassChannelMatrix {
  tenant_id: string;
  generated_at: string;
  window: number;
  total_records: number;
  /** Σ dispatches (= Σ rows.total = Σ cols.total). A multi-channel
   *  record with channels=['email','sms'] contributes 2. */
  total_dispatches: number;
  rows: AlertClassRow[];
  columns: AlertChannelColumn[];
  /** Highest-count cell. Canonical iteration tie-break (classes in
   *  BIL_CLASS_ORDER × channels in ALL_NOTIFICATION_CHANNELS order).
   *  Null on empty. */
  peak_cell: AlertClassChannelCell | null;
  /** Zero-count (class, channel) cells in canonical class × channel
   *  row-major order — comprehensive gap list. */
  empty_cells: Array<{ class: BilAlertClass; channel: NotificationChannel }>;
  /** Class with the most distinct non-zero channels. Canonical
   *  BIL_CLASS_ORDER tie-break. Null on empty. */
  most_diverse_class: { class: BilAlertClass; channels_used: number } | null;
  /** Channel with the most distinct non-zero classes. Canonical
   *  ALL_NOTIFICATION_CHANNELS tie-break. Null on empty. */
  most_universal_channel: { channel: NotificationChannel; classes_using: number } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByChannel(): Record<NotificationChannel, number> {
  const out: Partial<Record<NotificationChannel, number>> = {};
  for (const c of ALL_NOTIFICATION_CHANNELS) out[c] = 0;
  return out as Record<NotificationChannel, number>;
}

function emptyByClass(): Record<BilAlertClass, number> {
  const out: Partial<Record<BilAlertClass, number>> = {};
  for (const c of BIL_CLASS_ORDER) out[c] = 0;
  return out as Record<BilAlertClass, number>;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildAlertClassChannelMatrix(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  window: number,
  now: Date,
): AlertClassChannelMatrix {
  // Cell counts per (class, channel).
  const cell = new Map<BilAlertClass, Map<NotificationChannel, number>>();
  for (const c of BIL_CLASS_ORDER) cell.set(c, new Map());

  let total_dispatches = 0;
  for (const rec of records) {
    if (!BIL_CLASS_ORDER.includes(rec.class)) continue;
    const inner = cell.get(rec.class)!;
    for (const ch of rec.channels ?? []) {
      if (!ALL_NOTIFICATION_CHANNELS.includes(ch)) continue;
      inner.set(ch, (inner.get(ch) ?? 0) + 1);
      total_dispatches++;
    }
  }

  // Rows (classes × all channels).
  const rows: AlertClassRow[] = BIL_CLASS_ORDER.map((klass) => {
    const inner = cell.get(klass)!;
    const by_channel = emptyByChannel();
    let total = 0;
    for (const ch of ALL_NOTIFICATION_CHANNELS) {
      const count = inner.get(ch) ?? 0;
      by_channel[ch] = count;
      total += count;
    }
    const channels_without = ALL_NOTIFICATION_CHANNELS.filter((ch) => by_channel[ch] === 0);
    return { class: klass, total, by_channel, channels_without };
  });

  // Columns (channels × all classes).
  const columns: AlertChannelColumn[] = ALL_NOTIFICATION_CHANNELS.map((channel) => {
    const by_class = emptyByClass();
    let total = 0;
    for (const klass of BIL_CLASS_ORDER) {
      const count = cell.get(klass)!.get(channel) ?? 0;
      by_class[klass] = count;
      total += count;
    }
    const classes_without = BIL_CLASS_ORDER.filter((klass) => by_class[klass] === 0);
    return { channel, total, by_class, classes_without };
  });

  // peak_cell — canonical iteration tie-break.
  let peak: AlertClassChannelCell | null = null;
  for (const klass of BIL_CLASS_ORDER) {
    for (const ch of ALL_NOTIFICATION_CHANNELS) {
      const count = cell.get(klass)!.get(ch) ?? 0;
      if (count > 0 && (!peak || count > peak.count)) {
        peak = { class: klass, channel: ch, count };
      }
    }
  }

  // empty_cells canonical row-major (class × channel).
  const empty_cells: Array<{ class: BilAlertClass; channel: NotificationChannel }> = [];
  for (const klass of BIL_CLASS_ORDER) {
    for (const ch of ALL_NOTIFICATION_CHANNELS) {
      const count = cell.get(klass)!.get(ch) ?? 0;
      if (count === 0) empty_cells.push({ class: klass, channel: ch });
    }
  }

  // most_diverse_class — highest distinct non-zero by_channel count.
  let bestClassSpan = 0;
  let mostDiverseClass: AlertClassRow | null = null;
  for (const row of rows) {
    const span = ALL_NOTIFICATION_CHANNELS.filter((ch) => row.by_channel[ch] > 0).length;
    if (span > bestClassSpan) {
      bestClassSpan = span;
      mostDiverseClass = row;
    }
  }
  const most_diverse_class = mostDiverseClass
    ? { class: mostDiverseClass.class, channels_used: bestClassSpan }
    : null;

  // most_universal_channel — highest distinct non-zero by_class count.
  let bestChSpan = 0;
  let mostUniversalCh: AlertChannelColumn | null = null;
  for (const col of columns) {
    const span = BIL_CLASS_ORDER.filter((klass) => col.by_class[klass] > 0).length;
    if (span > bestChSpan) {
      bestChSpan = span;
      mostUniversalCh = col;
    }
  }
  const most_universal_channel = mostUniversalCh
    ? { channel: mostUniversalCh.channel, classes_using: bestChSpan }
    : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window,
    total_records: records.length,
    total_dispatches,
    rows,
    columns,
    peak_cell: peak,
    empty_cells,
    most_diverse_class,
    most_universal_channel,
  };
}
