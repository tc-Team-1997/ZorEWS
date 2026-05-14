// services/bff/src/routing_matrix_snapshot.ts
//
// T6 M8.8 — Alert routing matrix snapshot + fingerprint hash.
//
// M8.2 ships the routing engine with per-class rules + tenant
// overrides. M8.7 ships the per-severity decision preview. M8.8
// emits the WHOLE matrix in one shot — the canonical 4-row table
// (red/orange/yellow/green) merged with tenant overrides applied,
// plus a SHA-256 fingerprint of the canonical encoding so the SPA
// can detect "routing has changed since I last looked" with one
// round-trip rather than diffing field-by-field.
//
// Per-class `source` annotation lets the SPA badge each row with
// "platform default" vs "tenant override" without a separate
// resolution-chain call.

import { createHash } from 'node:crypto';
import {
  type RoutingRule,
  type AlertRoutingEngine,
  DEFAULT_RULES,
} from './alert_routing';
import { BIL_CLASS_ORDER, type BilAlertClass } from './bil_alert_classification';

// ─── Public types ─────────────────────────────────────────────────────

export interface RoutingMatrixRow {
  class: BilAlertClass;
  rule: RoutingRule;
  /** 'tenant_override' when the rule differs from the platform default,
   *  'platform_default' otherwise. */
  source: 'platform_default' | 'tenant_override';
}

export interface RoutingMatrixSnapshot {
  tenant_id: string;
  rows: RoutingMatrixRow[];
  /** SHA-256 hex over the canonical JSON encoding of the matrix.
   *  Deterministic per (tenant, rules) — same matrix always yields
   *  the same fingerprint. Different across tenants iff any override
   *  differs. */
  fingerprint: string;
  /** Count of classes where source='tenant_override'. */
  override_count: number;
}

// ─── Pure helpers ─────────────────────────────────────────────────────

function rulesEqual(a: RoutingRule, b: RoutingRule): boolean {
  if (a.class !== b.class) return false;
  if (a.primary_assignee !== b.primary_assignee) return false;
  if (a.secondary_assignee !== b.secondary_assignee) return false;
  if (a.sla_hours !== b.sla_hours) return false;
  if (a.escalate_after_hours !== b.escalate_after_hours) return false;
  if (a.monitor_only !== b.monitor_only) return false;
  if (a.channels.length !== b.channels.length) return false;
  for (let i = 0; i < a.channels.length; i += 1) {
    if (a.channels[i] !== b.channels[i]) return false;
  }
  return true;
}

/**
 * Pure fingerprint — SHA-256 hex over canonical JSON of the 4-row
 * matrix. Rules serialised in fixed BIL_CLASS_ORDER (red/orange/
 * yellow/green) so two equivalent matrices produced in different
 * insertion orders yield the same hash. Inside each rule, keys
 * sorted alphabetically.
 */
export function computeRoutingMatrixFingerprint(
  rulesByClass: Readonly<Record<BilAlertClass, RoutingRule>>,
): string {
  const canonical = BIL_CLASS_ORDER.map((cls) => {
    const r = rulesByClass[cls];
    // Sort rule fields alphabetically for deterministic encoding.
    return {
      channels: [...r.channels],
      class: r.class,
      escalate_after_hours: r.escalate_after_hours,
      monitor_only: r.monitor_only,
      primary_assignee: r.primary_assignee,
      secondary_assignee: r.secondary_assignee,
      sla_hours: r.sla_hours,
    };
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Build the matrix snapshot for a tenant via the routing engine.
 * Calls `engine.listRules(tenant)` to get the effective rules, then
 * compares each against DEFAULT_RULES to annotate the source.
 */
export function listRoutingMatrix(
  engine: AlertRoutingEngine,
  tenant_id: string,
): RoutingMatrixSnapshot {
  const effective = engine.listRules(tenant_id);
  const byClass: Record<BilAlertClass, RoutingRule> = {} as Record<
    BilAlertClass,
    RoutingRule
  >;
  for (const r of effective) {
    byClass[r.class] = r;
  }
  // Defensive: ensure every BIL class is present (use the default
  // when the engine omitted it, which shouldn't happen but is a
  // cheap belt-and-braces).
  for (const cls of BIL_CLASS_ORDER) {
    if (!byClass[cls]) byClass[cls] = DEFAULT_RULES[cls];
  }
  const rows: RoutingMatrixRow[] = BIL_CLASS_ORDER.map((cls) => {
    const rule = byClass[cls];
    return {
      class: cls,
      rule,
      source: rulesEqual(rule, DEFAULT_RULES[cls]) ? 'platform_default' : 'tenant_override',
    };
  });
  const override_count = rows.filter((r) => r.source === 'tenant_override').length;
  const fingerprint = computeRoutingMatrixFingerprint(byClass);
  return {
    tenant_id,
    rows,
    fingerprint,
    override_count,
  };
}
