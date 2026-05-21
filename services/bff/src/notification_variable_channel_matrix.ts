// services/bff/src/notification_variable_channel_matrix.ts
//
// T6 M10.18 — Notification variable × channel cross-tab matrix.
//
// M10.11 ships the unified template catalog (12 templates across
// email + sms + push). M10.13 ships the inverted variable index:
// for each unique `{{variable}}`, list which templates require it.
//
// M10.18 elevates M10.13's index into a proper 2D pivot: rows =
// distinct variables (open axis, sorted asc) × cols = 3 channels
// (canonical email → sms → push). Each cell counts how many templates
// in that channel require this variable.
//
// A variable can appear in multiple cells (e.g. `customer_name` may be
// used by email + sms + push templates). Cell count = how many
// templates in the column's channel list the row's variable in their
// required_vars. (A single template requiring a variable counts as 1,
// even if it's used multiple times in the body.)
//
// Per-row {variable, total (Σ across channels), by_channel (3 keys at
// 0 when absent), channels_with[] in canonical order — the subset where
// count > 0, channels_without[], spans_all_channels (= channels_with
// covers all 3)}.
//
// Per-col {channel, total (Σ across variables), distinct_variables,
// templates_count (= total templates in this channel), top_variables
// (cap 5 — variables this channel uses most + canonical asc tie-break)}.
//
// Envelope: peak_cell (highest count cell + canonical iteration
// tie-break — variables asc × channels canonical), empty_cells[] in
// canonical row-major order, most_universal_variable (variable with
// most distinct non-zero channels + canonical variable asc tie-break),
// cross_channel_variables[] (spans_all_channels=true; canonical asc),
// single_channel_variables[] (only one non-zero channel; canonical asc
// — refactor / promotion candidates).
//
// Mirror of M10.13 cross-reference but with 2D matrix shape. Platform-
// static — same response across tenants.

import { introspectNotificationTemplateCatalog } from './notification_template_catalog';
import type { NotificationChannelKey } from './notification_template_catalog';

// ─── Canonical enums ───────────────────────────────────────────────────

export const ALL_NOTIFICATION_CHANNEL_KEYS: readonly NotificationChannelKey[] = [
  'email',
  'sms',
  'push',
] as const;

// ─── Public types ──────────────────────────────────────────────────────

export interface NotificationVariableChannelRow {
  variable: string;
  total: number;
  by_channel: Record<NotificationChannelKey, number>;
  channels_with: NotificationChannelKey[];
  channels_without: NotificationChannelKey[];
  spans_all_channels: boolean;
}

export interface NotificationVariableChannelColumn {
  channel: NotificationChannelKey;
  total: number;
  distinct_variables: number;
  templates_count: number;
  top_variables: string[];
}

export interface NotificationVariableChannelCell {
  variable: string;
  channel: NotificationChannelKey;
}

export interface NotificationVariableChannelPeakCell extends NotificationVariableChannelCell {
  count: number;
}

export interface NotificationVariableChannelMatrix {
  generated_at: string;
  total_variables: number;
  total_channels: number;
  total_templates: number;
  rows: NotificationVariableChannelRow[];
  columns: NotificationVariableChannelColumn[];
  peak_cell: NotificationVariableChannelPeakCell | null;
  empty_cells: NotificationVariableChannelCell[];
  most_universal_variable: string | null;
  cross_channel_variables: string[];
  single_channel_variables: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByChannel(): Record<NotificationChannelKey, number> {
  return { email: 0, sms: 0, push: 0 };
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildNotificationVariableChannelMatrix(
  now: Date,
): NotificationVariableChannelMatrix {
  const catalog = introspectNotificationTemplateCatalog();

  // Build counts: variable → channel → count (number of templates in
  // that channel requiring this variable).
  const counts = new Map<string, Record<NotificationChannelKey, number>>();
  const channelTotals: Record<NotificationChannelKey, number> = emptyByChannel();
  const channelTemplateCount: Record<NotificationChannelKey, number> = emptyByChannel();
  // Per-channel: variable → templates-using-it count.
  const channelVarCounts: Record<NotificationChannelKey, Map<string, number>> = {
    email: new Map(),
    sms: new Map(),
    push: new Map(),
  };

  for (const t of catalog.templates) {
    channelTemplateCount[t.channel]++;
    // Defensive intra-template dedup: same variable listed twice on a
    // template counts once (M10.13 convention).
    const seen = new Set<string>();
    for (const raw of t.required_vars) {
      const v = String(raw);
      if (seen.has(v)) continue;
      seen.add(v);
      if (!counts.has(v)) counts.set(v, emptyByChannel());
      counts.get(v)![t.channel]++;
      channelTotals[t.channel]++;
      channelVarCounts[t.channel].set(
        v,
        (channelVarCounts[t.channel].get(v) ?? 0) + 1,
      );
    }
  }

  const sortedVars = [...counts.keys()].sort();

  // Per-row projections.
  const rows: NotificationVariableChannelRow[] = sortedVars.map((variable) => {
    const by_channel = counts.get(variable)!;
    const total = by_channel.email + by_channel.sms + by_channel.push;
    const channels_with = ALL_NOTIFICATION_CHANNEL_KEYS.filter(
      (c) => by_channel[c] > 0,
    );
    const channels_without = ALL_NOTIFICATION_CHANNEL_KEYS.filter(
      (c) => by_channel[c] === 0,
    );
    return {
      variable,
      total,
      by_channel: { ...by_channel },
      channels_with: [...channels_with],
      channels_without: [...channels_without],
      spans_all_channels: channels_with.length === ALL_NOTIFICATION_CHANNEL_KEYS.length,
    };
  });

  // Per-column projections.
  const columns: NotificationVariableChannelColumn[] = ALL_NOTIFICATION_CHANNEL_KEYS.map(
    (channel) => {
      const total = channelTotals[channel];
      const distinct_variables = channelVarCounts[channel].size;
      // top_variables: sort by count desc + variable asc tie-break, cap 5.
      const ranked = [...channelVarCounts[channel].entries()].sort(
        (a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
        },
      );
      return {
        channel,
        total,
        distinct_variables,
        templates_count: channelTemplateCount[channel],
        top_variables: ranked.slice(0, 5).map(([v]) => v),
      };
    },
  );

  // peak_cell — canonical iteration: variables asc × channels canonical.
  let peak_cell: NotificationVariableChannelPeakCell | null = null;
  let peakCount = 0;
  for (const variable of sortedVars) {
    const by_channel = counts.get(variable)!;
    for (const channel of ALL_NOTIFICATION_CHANNEL_KEYS) {
      const c = by_channel[channel];
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { variable, channel, count: c };
      }
    }
  }
  if (peakCount === 0) peak_cell = null;

  // empty_cells — canonical variable × channel row-major.
  const empty_cells: NotificationVariableChannelCell[] = [];
  for (const variable of sortedVars) {
    const by_channel = counts.get(variable)!;
    for (const channel of ALL_NOTIFICATION_CHANNEL_KEYS) {
      if (by_channel[channel] === 0) {
        empty_cells.push({ variable, channel });
      }
    }
  }

  // most_universal_variable — variable with most distinct non-zero
  // channels; canonical variable asc tie-break.
  let most_universal_variable: string | null = null;
  let maxSpan = 0;
  for (const row of rows) {
    if (row.channels_with.length > maxSpan) {
      maxSpan = row.channels_with.length;
      most_universal_variable = row.variable;
    }
  }
  if (maxSpan === 0) most_universal_variable = null;

  // cross_channel_variables — spans_all_channels = true.
  const cross_channel_variables = rows
    .filter((r) => r.spans_all_channels)
    .map((r) => r.variable);

  // single_channel_variables — exactly 1 non-zero channel.
  const single_channel_variables = rows
    .filter((r) => r.channels_with.length === 1)
    .map((r) => r.variable);

  return {
    generated_at: now.toISOString(),
    total_variables: sortedVars.length,
    total_channels: ALL_NOTIFICATION_CHANNEL_KEYS.length,
    total_templates: catalog.total_templates,
    rows,
    columns,
    peak_cell,
    empty_cells,
    most_universal_variable,
    cross_channel_variables,
    single_channel_variables,
  };
}
