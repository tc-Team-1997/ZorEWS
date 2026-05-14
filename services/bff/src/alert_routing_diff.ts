// services/bff/src/alert_routing_diff.ts
//
// T6 M8.10 — Alert routing rule diff vs platform default.
//
// M8.2 ships the routing rules engine with per-tenant overrides.
// M8.8 ships the matrix snapshot + fingerprint (rows annotated
// with source: 'platform_default'|'tenant_override'). M8.10 adds
// the FIELD-LEVEL diff: per class, which fields differ from
// DEFAULT_RULES + the default → effective delta.
//
// Lets the SPA render "what has ops customised in routing?" as
// per-class diff badges. Companion to M13.12 (config override-rate)
// + M13.11 (config override-age) — same pattern, different module.
//
// Pure resolver — walks the engine + compares against DEFAULT_RULES.

import {
  type RoutingRule,
  DEFAULT_RULES,
  type AlertRoutingEngine,
} from './alert_routing';
import { type BilAlertClass, BIL_CLASS_ORDER } from './bil_alert_classification';

// ─── Public types ─────────────────────────────────────────────────────

export type RoutingRuleFieldName =
  | 'primary_assignee'
  | 'secondary_assignee'
  | 'channels'
  | 'sla_hours'
  | 'escalate_after_hours'
  | 'monitor_only';

const ALL_FIELDS: readonly RoutingRuleFieldName[] = [
  'primary_assignee',
  'secondary_assignee',
  'channels',
  'sla_hours',
  'escalate_after_hours',
  'monitor_only',
] as const;

export interface FieldChange {
  field: RoutingRuleFieldName;
  default_value: unknown;
  effective_value: unknown;
}

export interface ClassDiff {
  class: BilAlertClass;
  is_default: boolean;
  changed_field_count: number;
  /** Only fields where default and effective differ. Sorted by the
   *  declared ALL_FIELDS order for stable rendering. */
  changed_fields: FieldChange[];
}

export interface AlertRoutingDiff {
  tenant_id: string;
  generated_at: string;
  /** Number of classes with at least one field changed from default. */
  total_overrides: number;
  /** Every class in BIL_CLASS_ORDER (red → orange → yellow → green). */
  classes: ClassDiff[];
  /** Class with the most changed fields. Ties broken by
   *  BIL_CLASS_ORDER declared order. null when no overrides. */
  most_customised_class: {
    class: BilAlertClass;
    changed_field_count: number;
  } | null;
  /** Classes still at platform default (changed_field_count === 0). */
  pristine_classes: BilAlertClass[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function fieldsEqual(
  field: RoutingRuleFieldName,
  d: unknown,
  e: unknown,
): boolean {
  if (field === 'channels') {
    return arraysEqual(d as string[], e as string[]);
  }
  return d === e;
}

function defensiveCopy(field: RoutingRuleFieldName, value: unknown): unknown {
  if (field === 'channels' && Array.isArray(value)) {
    return [...value];
  }
  return value;
}

function buildClassDiff(cls: BilAlertClass, effective: RoutingRule): ClassDiff {
  const def = DEFAULT_RULES[cls];
  const changed_fields: FieldChange[] = [];
  for (const field of ALL_FIELDS) {
    const d = (def as unknown as Record<string, unknown>)[field];
    const e = (effective as unknown as Record<string, unknown>)[field];
    if (!fieldsEqual(field, d, e)) {
      changed_fields.push({
        field,
        default_value: defensiveCopy(field, d),
        effective_value: defensiveCopy(field, e),
      });
    }
  }
  return {
    class: cls,
    is_default: changed_fields.length === 0,
    changed_field_count: changed_fields.length,
    changed_fields,
  };
}

export function buildAlertRoutingDiff(
  engine: AlertRoutingEngine,
  tenant_id: string,
  now: Date,
): AlertRoutingDiff {
  const effectiveRules = engine.listRules(tenant_id);
  const byClass = new Map<BilAlertClass, RoutingRule>();
  for (const r of effectiveRules) byClass.set(r.class, r);

  const classes: ClassDiff[] = [];
  for (const cls of BIL_CLASS_ORDER) {
    const effective = byClass.get(cls) ?? DEFAULT_RULES[cls];
    classes.push(buildClassDiff(cls, effective));
  }

  const total_overrides = classes.filter((c) => !c.is_default).length;

  let most_customised_class: AlertRoutingDiff['most_customised_class'] = null;
  for (const c of classes) {
    if (c.changed_field_count === 0) continue;
    if (!most_customised_class || c.changed_field_count > most_customised_class.changed_field_count) {
      most_customised_class = { class: c.class, changed_field_count: c.changed_field_count };
    }
    // Iteration follows BIL_CLASS_ORDER → ties auto-resolve to first-seen.
  }

  const pristine_classes = classes
    .filter((c) => c.is_default)
    .map((c) => c.class);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_overrides,
    classes,
    most_customised_class,
    pristine_classes,
  };
}
