/**
 * M12.23 — Report schedule cost forecast
 * Estimates monthly compute cost for all enabled report schedules.
 */

import { defaultReportScheduleStore } from './report_schedules';

const BASE_COSTS: Record<string, number> = {
  daily:             0.50,
  weekly:            0.12,
  monthly:           0.05,
  quarterly:         0.02,
  last_day_of_month: 0.05,
};

const FORMAT_MULTIPLIERS: Record<string, number> = {
  pdf:  1.5,
  xlsx: 1.3,
  csv:  1.0,
  json: 0.8,
};

export interface ScheduleCostItem {
  schedule_id: string;
  name: string;
  cadence: string;
  format: string;
  recipient_count: number;
  monthly_cost_usd: number;
}

export interface ReportScheduleCostForecastReport {
  tenant_id: string;
  generated_at: string;
  total_enabled_schedules: number;
  monthly_cost_forecast_usd: number;
  by_cadence: Record<string, number>;
  by_format: Record<string, number>;
  most_expensive_schedule: string | null;
  cheapest_schedule: string | null;
}

export function buildReportScheduleCostForecast(
  tenant_id: string,
  now: Date = new Date(),
): ReportScheduleCostForecastReport {
  if (!tenant_id) throw new Error('tenant_id required');

  const scheduleItems: ScheduleCostItem[] = [];
  let page = 1;
  while (true) {
    const res = defaultReportScheduleStore.list(tenant_id, page, 200);
    for (const entry of res.items) {
      if (!entry.enabled) continue;

      const base = BASE_COSTS[entry.cadence] ?? 0.05;
      const fmt_mult = FORMAT_MULTIPLIERS[entry.format] ?? 1.0;
      const recipients = entry.recipients ? entry.recipients.length : 1;
      const recipient_factor = 1 + Math.max(0, recipients - 5) * 0.1;
      const monthly_cost_usd = base * fmt_mult * recipient_factor;

      scheduleItems.push({
        schedule_id: entry.schedule_id,
        name: entry.name,
        cadence: entry.cadence,
        format: entry.format,
        recipient_count: recipients,
        monthly_cost_usd,
      });
    }
    if (res.items.length < 200) break;
    page++;
  }

  const total_cost = scheduleItems.reduce((s, i) => s + i.monthly_cost_usd, 0);

  const by_cadence: Record<string, number> = {};
  const by_format: Record<string, number> = {};

  for (const item of scheduleItems) {
    by_cadence[item.cadence] = (by_cadence[item.cadence] ?? 0) + item.monthly_cost_usd;
    by_format[item.format] = (by_format[item.format] ?? 0) + item.monthly_cost_usd;
  }

  scheduleItems.sort((a, b) => b.monthly_cost_usd - a.monthly_cost_usd);

  const most_expensive_schedule = scheduleItems.length > 0 ? scheduleItems[0].schedule_id : null;
  const cheapest_schedule =
    scheduleItems.length > 0 ? scheduleItems[scheduleItems.length - 1].schedule_id : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_enabled_schedules: scheduleItems.length,
    monthly_cost_forecast_usd: total_cost,
    by_cadence,
    by_format,
    most_expensive_schedule,
    cheapest_schedule,
  };
}
