// services/bff/src/alert_auto_ack.ts
//
// T6 M8.4 — Alert auto-ack via threshold rules.
//
// M8.3 ships the manual ack/unack lifecycle. M8.4 ships the
// auto-ack policy: green-class alerts (and other low-priority
// signals) get marked acknowledged at receipt time so analysts
// don't have to clear them manually. Reduces dashboard noise.
//
// Design:
//  - Pure data: a tenant-keyed list of `AutoAckRule` records
//    describing WHICH alerts get auto-acked.
//  - Pure-function `evaluateAutoAck(rules, alert)` returns null
//    when no rule matches OR a `{rule_id, reason}` payload that
//    the caller passes to M8.3's `acknowledge()`.
//  - Match criteria are AND-combined: bil_class (red|orange|...),
//    source_system (claims|cbs|aml|...), tag includes (any-of).
//  - Per-tenant cap of 20 rules — same shape as the M8.2 routing
//    matrix.
//
// Out of scope (deferred):
//  - Wiring auto-ack into a real alert ingestion pipeline. The BIL
//    BFF doesn't synthesize live alerts here; this slice is the
//    POLICY surface (CRUD + evaluate). M8.5 wires the policy
//    into the alert-create path on the existing /v1/alerts surface.

import { randomUUID } from 'node:crypto';
import { type BilAlertClass, isBilAlertClass } from './bil_alert_classification';

// ─── Public types ─────────────────────────────────────────────────────

export interface AutoAckRuleInput {
  /** Display name for the rule. */
  name: string;
  /** AND-combined matchers; null = any. */
  bil_class?: BilAlertClass;
  source_system?: string;
  /** Match if alert.tags contains ANY of these. */
  tags_any?: string[];
  /** Default reason recorded as the ack note. */
  reason: string;
  /** Defaults to true. */
  enabled?: boolean;
}

export interface AutoAckRule {
  rule_id: string;
  tenant_id: string;
  name: string;
  bil_class: BilAlertClass | null;
  source_system: string | null;
  tags_any: readonly string[];
  reason: string;
  enabled: boolean;
  created_at: string;
  created_by: string;
}

export interface AlertContext {
  bil_class: BilAlertClass;
  source_system?: string;
  tags?: string[];
}

export interface AutoAckMatch {
  rule_id: string;
  rule_name: string;
  reason: string;
}

export class AutoAckError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AutoAckError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

function validateInput(input: unknown): AutoAckRuleInput {
  if (!input || typeof input !== 'object') {
    throw new AutoAckError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new AutoAckError('invalid_input', 'name is required');
  }
  if (i.name.length > 80) throw new AutoAckError('invalid_input', 'name ≤ 80 chars');
  if (typeof i.reason !== 'string' || !i.reason.trim()) {
    throw new AutoAckError('invalid_input', 'reason is required');
  }
  if (i.reason.length > 500) {
    throw new AutoAckError('invalid_input', 'reason ≤ 500 chars');
  }
  if (i.bil_class !== undefined && !isBilAlertClass(i.bil_class)) {
    throw new AutoAckError(
      'invalid_input',
      'bil_class must be red|orange|yellow|green',
    );
  }
  if (i.source_system !== undefined) {
    if (typeof i.source_system !== 'string' || !i.source_system.trim()) {
      throw new AutoAckError('invalid_input', 'source_system must be a non-empty string');
    }
    if (i.source_system.length > 64) {
      throw new AutoAckError('invalid_input', 'source_system ≤ 64 chars');
    }
  }
  if (i.tags_any !== undefined) {
    if (!Array.isArray(i.tags_any)) {
      throw new AutoAckError('invalid_input', 'tags_any must be an array');
    }
    if (i.tags_any.length > 20) {
      throw new AutoAckError('invalid_input', 'at most 20 tags');
    }
    for (const t of i.tags_any) {
      if (typeof t !== 'string' || !t.trim()) {
        throw new AutoAckError('invalid_input', 'tags must be non-empty strings');
      }
    }
  }
  // At least ONE matcher must be set — otherwise the rule auto-acks every alert
  if (
    i.bil_class === undefined &&
    i.source_system === undefined &&
    (!Array.isArray(i.tags_any) || (i.tags_any as unknown[]).length === 0)
  ) {
    throw new AutoAckError(
      'invalid_input',
      'at least one of bil_class / source_system / tags_any is required',
    );
  }
  if (i.enabled !== undefined && typeof i.enabled !== 'boolean') {
    throw new AutoAckError('invalid_input', 'enabled must be a boolean');
  }
  return {
    name: i.name.trim(),
    bil_class: i.bil_class as BilAlertClass | undefined,
    source_system: i.source_system as string | undefined,
    tags_any: (i.tags_any as string[]) ?? undefined,
    reason: i.reason.trim(),
    enabled: i.enabled as boolean | undefined,
  };
}

// ─── Pure-function evaluate ───────────────────────────────────────────

/**
 * Walks the tenant's auto-ack rules and returns the first ENABLED
 * match. AND-combined matchers; tags_any uses OR-on-any-tag.
 */
export function evaluateAutoAck(
  rules: readonly AutoAckRule[],
  alert: AlertContext,
): AutoAckMatch | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.bil_class !== null && rule.bil_class !== alert.bil_class) continue;
    if (
      rule.source_system !== null &&
      rule.source_system !== (alert.source_system ?? '')
    ) {
      continue;
    }
    if (rule.tags_any.length > 0) {
      const tagSet = new Set(alert.tags ?? []);
      const hit = rule.tags_any.some((t) => tagSet.has(t));
      if (!hit) continue;
    }
    return { rule_id: rule.rule_id, rule_name: rule.name, reason: rule.reason };
  }
  return null;
}

// ─── Store ────────────────────────────────────────────────────────────

export interface AutoAckRuleStore {
  list(tenant_id: string): AutoAckRule[];
  get(tenant_id: string, rule_id: string): AutoAckRule | null;
  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): AutoAckRule;
  delete(tenant_id: string, rule_id: string): boolean;
}

const CAP = 20;

export class InMemoryAutoAckRuleStore implements AutoAckRuleStore {
  private readonly perTenant = new Map<string, AutoAckRule[]>();

  list(tenant_id: string): AutoAckRule[] {
    return [...(this.perTenant.get(tenant_id) ?? [])];
  }

  get(tenant_id: string, rule_id: string): AutoAckRule | null {
    return this.perTenant.get(tenant_id)?.find((r) => r.rule_id === rule_id) ?? null;
  }

  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): AutoAckRule {
    if (!created_by || !created_by.trim()) {
      throw new AutoAckError('invalid_input', 'created_by required');
    }
    const valid = validateInput(input);
    const arr = this.perTenant.get(tenant_id) ?? [];
    if (arr.length >= CAP) {
      throw new AutoAckError(
        'cap_reached',
        `tenant ${tenant_id} already has ${CAP} auto-ack rules`,
      );
    }
    const rule: AutoAckRule = {
      rule_id: `aar-${randomUUID()}`,
      tenant_id,
      name: valid.name,
      bil_class: valid.bil_class ?? null,
      source_system: valid.source_system ?? null,
      tags_any: valid.tags_any ?? [],
      reason: valid.reason,
      enabled: valid.enabled ?? true,
      created_at: now.toISOString(),
      created_by: created_by.trim(),
    };
    arr.push(rule);
    this.perTenant.set(tenant_id, arr);
    return rule;
  }

  delete(tenant_id: string, rule_id: string): boolean {
    const arr = this.perTenant.get(tenant_id);
    if (!arr) return false;
    const idx = arr.findIndex((r) => r.rule_id === rule_id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return true;
  }
}

export const defaultAutoAckRuleStore: AutoAckRuleStore = new InMemoryAutoAckRuleStore();
