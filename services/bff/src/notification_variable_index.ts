// services/bff/src/notification_variable_index.ts
//
// T6 M10.13 — Notification template variable cross-reference.
//
// M10.11 ships the unified template catalog (12 BIL canned templates
// across email/sms/push, each declaring its required_vars[]).
// M10.13 ships the INVERTED index: for each unique variable name,
// list every template that requires it + which channels they cover.
//
// Mirror of M5.15 (template→action reverse map) and M4.11 (indicator→
// template reverse map), but for notification template variables.
//
// Use case: when the SDK contract gains a new field (e.g. add
// `customer_segment` to the alert payload), ops can query "which
// templates already require this variable, and which need updating?".
// Conversely: "is any variable required by only one template?" surfaces
// candidates for inlining or renaming for consistency.
//
// Pure — platform-static. Same response across every tenant.

import {
  introspectNotificationTemplateCatalog,
  type NotificationCatalogEntry,
  type NotificationChannelKey,
} from './notification_template_catalog';

// ─── Public types ─────────────────────────────────────────────────────

export interface VariableUsageEntry {
  variable: string;
  /** Templates requiring this variable. Sorted by (channel asc,
   *  template_id asc) for stable rendering. */
  templates: Array<{
    channel: NotificationChannelKey;
    template_id: string;
    description: string;
  }>;
  /** Total templates referencing this variable. */
  reference_count: number;
  /** Channels covered (subset of email/sms/push). Sorted asc. */
  channels: NotificationChannelKey[];
  /** True iff every channel (email + sms + push) covers this variable.
   *  Drives SPA chip "shared by all channels". */
  spans_all_channels: boolean;
}

export interface NotificationVariableIndex {
  total_variables: number;
  total_templates: number;
  /** Variables sorted by reference_count desc with variable name asc
   *  tie-break. Most-referenced ones float to the top. */
  variables: VariableUsageEntry[];
  /** Variables referenced by exactly one template — candidates for
   *  inlining or renaming for consistency. Sorted by variable asc. */
  single_use_variables: string[];
  /** Variables that span all three channels — well-established
   *  cross-channel concepts. Sorted by variable asc. */
  shared_variables: string[];
  /** Most-referenced variable. null when no variables observed. */
  most_referenced: string | null;
}

const ALL_CHANNELS: readonly NotificationChannelKey[] = ['email', 'sms', 'push'] as const;

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildNotificationVariableIndex(): NotificationVariableIndex {
  const catalog = introspectNotificationTemplateCatalog();
  const byVar = new Map<string, VariableUsageEntry>();

  for (const t of catalog.templates) {
    // Defensive intra-template dedup in case a template lists the same
    // variable twice (caller error in the registry).
    const seenInThisTemplate = new Set<string>();
    for (const v of t.required_vars) {
      if (seenInThisTemplate.has(v)) continue;
      seenInThisTemplate.add(v);
      let row = byVar.get(v);
      if (!row) {
        row = {
          variable: v,
          templates: [],
          reference_count: 0,
          channels: [],
          spans_all_channels: false,
        };
        byVar.set(v, row);
      }
      row.templates.push({
        channel: t.channel,
        template_id: t.template_id,
        description: t.description,
      });
      row.reference_count++;
    }
  }

  for (const row of byVar.values()) {
    // Sort templates: channel asc then template_id asc.
    row.templates.sort((a, b) => {
      if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
      return a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0;
    });
    // Channels = unique channel set in this row.
    const channelSet = new Set<NotificationChannelKey>(row.templates.map((t) => t.channel));
    row.channels = ALL_CHANNELS.filter((c) => channelSet.has(c));
    row.spans_all_channels = ALL_CHANNELS.every((c) => channelSet.has(c));
  }

  const variables = [...byVar.values()].sort((a, b) => {
    if (b.reference_count !== a.reference_count) return b.reference_count - a.reference_count;
    return a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0;
  });

  const single_use_variables = variables
    .filter((v) => v.reference_count === 1)
    .map((v) => v.variable)
    .sort();
  const shared_variables = variables
    .filter((v) => v.spans_all_channels)
    .map((v) => v.variable)
    .sort();
  const most_referenced = variables[0]?.variable ?? null;

  return {
    total_variables: variables.length,
    total_templates: catalog.total_templates,
    variables,
    single_use_variables,
    shared_variables,
    most_referenced,
  };
}
