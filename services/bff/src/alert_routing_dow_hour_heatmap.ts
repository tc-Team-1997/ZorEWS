// services/bff/src/alert_routing_dow_hour_heatmap.ts
//
// T6 M8.17 — Alert routing day-of-week × hour-of-day heatmap.
//
// M8.6 ships per-tenant routing ledger + 1D analytics. M8.11 SLA
// breach detail. M8.12 ack-time histogram. M8.13 channel dispatch.
// M8.14 class × channel matrix. M8.15 daily volume trend (linear).
// M8.16 SLA compliance by class.
//
// M8.17 ships the CYCLIC INTRADAY heatmap — for each routed alert in
// the M8.6 ledger window, bucket created_at into a 7-day × 24-hour
// UTC grid. Distinct from M8.15 (linear N-day trend) by being the
// cyclic pattern view.
//
// Per cell: count + by_class (4 keys). Marginals: by_dow[7] +
// by_hour[24]. Envelope: peak_cell + peak_dow + peak_hour +
// most_active_class.
//
// Mirror of M14.22 / M15.7 dow×hour heatmap pattern for the alert
// routing surface. Same window semantics as M8.6 family (default 50,
// max 200 records).

import {
  type RoutedAlertRecord,
  type RoutingLedger,
} from './alert_routing_analytics';
import {
  BIL_CLASS_ORDER,
  type BilAlertClass,
} from './bil_alert_classification';

export const DEFAULT_ALERT_DOW_HOUR_WINDOW = 50;
export const MAX_ALERT_DOW_HOUR_WINDOW = 200;

export const DOW_LABELS: readonly string[] = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
] as const;

export interface DowHourCell {
  dow: number;
  hour: number;
  count: number;
  by_class: Record<BilAlertClass, number>;
}

export interface DowMarginal {
  dow: number;
  label: string;
  total: number;
  by_class: Record<BilAlertClass, number>;
}

export interface HourMarginal {
  hour: number;
  total: number;
  by_class: Record<BilAlertClass, number>;
}

export interface AlertRoutingDowHourHeatmap {
  tenant_id: string;
  generated_at: string;
  window: number;
  sample_size: number;
  cells: DowHourCell[];
  by_dow: DowMarginal[];
  by_hour: HourMarginal[];
  peak_cell: { dow: number; label: string; hour: number; count: number } | null;
  peak_dow: { dow: number; label: string; total: number } | null;
  peak_hour: { hour: number; total: number } | null;
  most_active_class: BilAlertClass | null;
}

export class AlertRoutingDowHourHeatmapError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AlertRoutingDowHourHeatmapError';
  }
}

function emptyByClass(): Record<BilAlertClass, number> {
  const out = {} as Record<BilAlertClass, number>;
  for (const c of BIL_CLASS_ORDER) out[c] = 0;
  return out;
}

function utcDayToIso(utcDay: number): number {
  return (utcDay + 6) % 7;
}

export function summarizeAlertRoutingDowHour(
  tenant_id: string,
  records: readonly RoutedAlertRecord[],
  window: number,
  now: Date,
): AlertRoutingDowHourHeatmap {
  if (!Number.isInteger(window) || window < 1 || window > MAX_ALERT_DOW_HOUR_WINDOW) {
    throw new AlertRoutingDowHourHeatmapError(
      'invalid_input',
      `window must be an integer in [1, ${MAX_ALERT_DOW_HOUR_WINDOW}]`,
    );
  }

  const cells: DowHourCell[] = [];
  const cellIndex = new Map<string, DowHourCell>();
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const cell: DowHourCell = { dow, hour, count: 0, by_class: emptyByClass() };
      cells.push(cell);
      cellIndex.set(`${dow}|${hour}`, cell);
    }
  }
  const by_dow: DowMarginal[] = [];
  for (let d = 0; d < 7; d++) {
    by_dow.push({ dow: d, label: DOW_LABELS[d], total: 0, by_class: emptyByClass() });
  }
  const by_hour: HourMarginal[] = [];
  for (let h = 0; h < 24; h++) {
    by_hour.push({ hour: h, total: 0, by_class: emptyByClass() });
  }

  let sample_size = 0;
  const windowed = records.slice(0, window);

  for (const r of windowed) {
    const t = new Date(r.created_at);
    if (Number.isNaN(t.getTime())) continue;
    if (!BIL_CLASS_ORDER.includes(r.class)) continue;
    sample_size++;
    const dow = utcDayToIso(t.getUTCDay());
    const hour = t.getUTCHours();
    const cell = cellIndex.get(`${dow}|${hour}`)!;
    cell.count++;
    cell.by_class[r.class]++;
    by_dow[dow].total++;
    by_dow[dow].by_class[r.class]++;
    by_hour[hour].total++;
    by_hour[hour].by_class[r.class]++;
  }

  let peak_cell: AlertRoutingDowHourHeatmap['peak_cell'] = null;
  let pc = 0;
  for (const c of cells) {
    if (c.count > pc) {
      pc = c.count;
      peak_cell = { dow: c.dow, label: DOW_LABELS[c.dow], hour: c.hour, count: c.count };
    }
  }

  let peak_dow: AlertRoutingDowHourHeatmap['peak_dow'] = null;
  let pd = 0;
  for (const m of by_dow) {
    if (m.total > pd) {
      pd = m.total;
      peak_dow = { dow: m.dow, label: m.label, total: m.total };
    }
  }

  let peak_hour: AlertRoutingDowHourHeatmap['peak_hour'] = null;
  let ph = 0;
  for (const m of by_hour) {
    if (m.total > ph) {
      ph = m.total;
      peak_hour = { hour: m.hour, total: m.total };
    }
  }

  let most_active_class: BilAlertClass | null = null;
  let mac = 0;
  const classTotals = emptyByClass();
  for (const m of by_hour) {
    for (const c of BIL_CLASS_ORDER) classTotals[c] += m.by_class[c];
  }
  for (const c of BIL_CLASS_ORDER) {
    if (classTotals[c] > mac) {
      mac = classTotals[c];
      most_active_class = c;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    window,
    sample_size,
    cells,
    by_dow,
    by_hour,
    peak_cell,
    peak_dow,
    peak_hour,
    most_active_class,
  };
}

export function summarizeAlertRoutingDowHourFromLedger(
  ledger: RoutingLedger,
  tenant_id: string,
  window: number,
  now: Date,
): AlertRoutingDowHourHeatmap {
  if (!Number.isInteger(window) || window < 1 || window > MAX_ALERT_DOW_HOUR_WINDOW) {
    throw new AlertRoutingDowHourHeatmapError(
      'invalid_input',
      `window must be an integer in [1, ${MAX_ALERT_DOW_HOUR_WINDOW}]`,
    );
  }
  const records = ledger.list(tenant_id, window);
  return summarizeAlertRoutingDowHour(tenant_id, records, window, now);
}
