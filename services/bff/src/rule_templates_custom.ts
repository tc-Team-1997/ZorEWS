// services/bff/src/rule_templates_custom.ts
//
// T6 M5.6 — Custom user-defined rule templates.
//
// M5.1 ships the platform-static rule template library (12 BIL
// templates). M5.6 adds a per-tenant CRUD store so tenants author
// their own template starters. Same RuleTemplate shape so M5.2
// bulk-clone, M5.3 simulation, M5.4 simulation-bundle, and M5.5
// diff all work unchanged when a custom id is passed in (callers
// just need to use getEffectiveRuleTemplate).
//
// Mirrors the M16.4 (custom scenario presets) pattern:
//  - Per-tenant cap = 30
//  - Custom ids prefixed `tpl_custom_` + 8 hex chars
//  - Defensive collision-check against the library on create

import { randomUUID } from 'node:crypto';
import {
  type RuleTemplate,
  type RuleTemplateCategory,
  type RuleTemplateVertical,
  type RecommendedSeverity,
  type RecommendedAction,
  isRuleTemplateCategory,
  isRuleTemplateVertical,
  getTemplate as getLibraryTemplate,
} from './rule_templates';

export class CustomRuleTemplateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CustomRuleTemplateError';
  }
}

const VALID_SEVERITIES: readonly RecommendedSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
] as const;

const VALID_ACTIONS: readonly RecommendedAction[] = [
  'open_case',
  'notify_supervisor',
  'pause_disbursement',
  'request_documents',
  'flag_for_review',
  'auto_decline',
] as const;

const CAP_PER_TENANT = 30;

export interface CustomRuleTemplateInput {
  name: string;
  description: string;
  vertical: RuleTemplateVertical;
  category: RuleTemplateCategory;
  condition_pseudocode: string;
  recommended_severity: RecommendedSeverity;
  recommended_actions: RecommendedAction[];
  supporting_indicators: string[];
  source_doc?: string;
}

function validate(input: unknown): CustomRuleTemplateInput {
  if (!input || typeof input !== 'object') {
    throw new CustomRuleTemplateError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new CustomRuleTemplateError('invalid_input', 'name is required');
  }
  if (i.name.length > 80) {
    throw new CustomRuleTemplateError('invalid_input', 'name ≤ 80 chars');
  }
  if (typeof i.description !== 'string' || !i.description.trim()) {
    throw new CustomRuleTemplateError('invalid_input', 'description is required');
  }
  if (i.description.length > 500) {
    throw new CustomRuleTemplateError('invalid_input', 'description ≤ 500 chars');
  }
  if (!isRuleTemplateVertical(i.vertical)) {
    throw new CustomRuleTemplateError('invalid_input', 'vertical must be banking|insurance|both');
  }
  if (!isRuleTemplateCategory(i.category)) {
    throw new CustomRuleTemplateError(
      'invalid_input',
      'invalid category (risk_monitoring|fraud_detection|compliance|operational|underwriting)',
    );
  }
  if (typeof i.condition_pseudocode !== 'string' || !i.condition_pseudocode.trim()) {
    throw new CustomRuleTemplateError('invalid_input', 'condition_pseudocode is required');
  }
  if (i.condition_pseudocode.length > 1000) {
    throw new CustomRuleTemplateError('invalid_input', 'condition_pseudocode ≤ 1000 chars');
  }
  if (
    typeof i.recommended_severity !== 'string' ||
    !VALID_SEVERITIES.includes(i.recommended_severity as RecommendedSeverity)
  ) {
    throw new CustomRuleTemplateError(
      'invalid_input',
      `recommended_severity must be one of ${VALID_SEVERITIES.join('|')}`,
    );
  }
  if (!Array.isArray(i.recommended_actions) || i.recommended_actions.length === 0) {
    throw new CustomRuleTemplateError(
      'invalid_input',
      'recommended_actions[] must be non-empty',
    );
  }
  if (i.recommended_actions.length > 6) {
    throw new CustomRuleTemplateError('invalid_input', 'recommended_actions ≤ 6 entries');
  }
  for (const a of i.recommended_actions) {
    if (!VALID_ACTIONS.includes(a as RecommendedAction)) {
      throw new CustomRuleTemplateError(
        'invalid_input',
        `'${String(a)}' is not a valid recommended_action`,
      );
    }
  }
  if (!Array.isArray(i.supporting_indicators) || i.supporting_indicators.length === 0) {
    throw new CustomRuleTemplateError(
      'invalid_input',
      'supporting_indicators[] must be non-empty',
    );
  }
  if (i.supporting_indicators.length > 25) {
    throw new CustomRuleTemplateError('invalid_input', 'supporting_indicators ≤ 25 entries');
  }
  for (const s of i.supporting_indicators) {
    if (typeof s !== 'string' || !s.trim()) {
      throw new CustomRuleTemplateError(
        'invalid_input',
        'supporting_indicators must be non-empty strings',
      );
    }
  }
  let source_doc: string | undefined;
  if (i.source_doc !== undefined) {
    if (typeof i.source_doc !== 'string') {
      throw new CustomRuleTemplateError('invalid_input', 'source_doc must be a string');
    }
    if (i.source_doc.length > 200) {
      throw new CustomRuleTemplateError('invalid_input', 'source_doc ≤ 200 chars');
    }
    source_doc = i.source_doc.trim();
  }
  // Dedupe action + indicator entries (idempotent on repeats)
  const dedupeActions: RecommendedAction[] = Array.from(
    new Set(i.recommended_actions as RecommendedAction[]),
  );
  const dedupeIndicators: string[] = Array.from(new Set(i.supporting_indicators as string[]));
  return {
    name: i.name.trim(),
    description: i.description.trim(),
    vertical: i.vertical,
    category: i.category,
    condition_pseudocode: i.condition_pseudocode.trim(),
    recommended_severity: i.recommended_severity as RecommendedSeverity,
    recommended_actions: dedupeActions,
    supporting_indicators: dedupeIndicators,
    source_doc,
  };
}

/** T6 M5.12 — version snapshot. Captured on create + on every
 *  successful update (snapshot of the POST-write state — so
 *  version_n always equals "the state at version n"). Also pushed
 *  on restoreVersion so restoring is itself an audit-visible
 *  event. Cap 20 per template; oldest evicted on overflow with
 *  version numbers staying monotonic across eviction. */
export interface TemplateVersion {
  version: number; // 1-based
  captured_at: string;
  captured_by: string;
  snapshot: RuleTemplate;
}

const TEMPLATE_VERSION_CAP = 20;

export interface CustomRuleTemplateStore {
  list(tenant_id: string): RuleTemplate[];
  get(tenant_id: string, template_id: string): RuleTemplate | null;
  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): RuleTemplate;
  /** Replace mutable fields. id is immutable. Throws unknown_template
   *  on miss, invalid_input on a bad patch shape. */
  update(
    tenant_id: string,
    template_id: string,
    input: unknown,
    updated_by: string,
    now: Date,
  ): RuleTemplate;
  delete(tenant_id: string, template_id: string): boolean;
  /** T6 M5.12 — version snapshots oldest-first. Empty list when
   *  the template has been evicted from versions but still exists
   *  live (shouldn't happen — every CRUD path pushes a snapshot —
   *  but defensive). */
  listVersions(tenant_id: string, template_id: string): TemplateVersion[];
  /** T6 M5.12 — restore the live template to a captured version.
   *  Returns the new live state + the version number restored from.
   *  A new version snapshot is pushed AFTER the restore so the
   *  audit trail shows the restore as a discrete event. */
  restoreVersion(
    tenant_id: string,
    template_id: string,
    version: number,
    restored_by: string,
    now: Date,
  ): { template: RuleTemplate; restored_from_version: number };
}

export class InMemoryCustomRuleTemplateStore implements CustomRuleTemplateStore {
  private readonly perTenant = new Map<string, RuleTemplate[]>();
  // (tenant, template_id) → versions[] (oldest-first; newest at end)
  private readonly versions = new Map<string, TemplateVersion[]>();

  private vk(tenant_id: string, template_id: string): string {
    return `${tenant_id}::${template_id}`;
  }

  private pushVersion(
    tenant_id: string,
    template_id: string,
    snapshot: RuleTemplate,
    captured_by: string,
    now: Date,
  ): void {
    const key = this.vk(tenant_id, template_id);
    const arr = this.versions.get(key) ?? [];
    // Monotonic — derive from the last entry, not arr.length, so
    // numbers stay stable after the cap evicts oldest entries.
    const last = arr[arr.length - 1];
    const next: TemplateVersion = {
      version: last ? last.version + 1 : 1,
      captured_at: now.toISOString(),
      captured_by,
      snapshot: {
        ...snapshot,
        recommended_actions: [...snapshot.recommended_actions],
        supporting_indicators: [...snapshot.supporting_indicators],
      },
    };
    arr.push(next);
    if (arr.length > TEMPLATE_VERSION_CAP) {
      arr.splice(0, arr.length - TEMPLATE_VERSION_CAP);
    }
    this.versions.set(key, arr);
  }

  list(tenant_id: string): RuleTemplate[] {
    return [...(this.perTenant.get(tenant_id) ?? [])];
  }

  get(tenant_id: string, template_id: string): RuleTemplate | null {
    return (
      this.perTenant.get(tenant_id)?.find((t) => t.id === template_id) ?? null
    );
  }

  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): RuleTemplate {
    if (!created_by || !created_by.trim()) {
      throw new CustomRuleTemplateError('invalid_input', 'created_by required');
    }
    const valid = validate(input);
    const arr = this.perTenant.get(tenant_id) ?? [];
    if (arr.length >= CAP_PER_TENANT) {
      throw new CustomRuleTemplateError(
        'cap_reached',
        `tenant ${tenant_id} already has ${CAP_PER_TENANT} custom templates`,
      );
    }
    const template: RuleTemplate = {
      id: `tpl_custom_${randomUUID().slice(0, 8)}`,
      name: valid.name,
      description: valid.description,
      vertical: valid.vertical,
      category: valid.category,
      condition_pseudocode: valid.condition_pseudocode,
      recommended_severity: valid.recommended_severity,
      recommended_actions: valid.recommended_actions,
      supporting_indicators: valid.supporting_indicators,
      source_doc: valid.source_doc ?? `User-authored by ${created_by.trim()}`,
    };
    if (getLibraryTemplate(template.id)) {
      throw new CustomRuleTemplateError(
        'id_collision',
        `generated id ${template.id} collides with a library template`,
      );
    }
    arr.push(template);
    this.perTenant.set(tenant_id, arr);
    // T6 M5.12 — capture v1 on create.
    this.pushVersion(tenant_id, template.id, template, created_by.trim(), now);
    return template;
  }

  update(
    tenant_id: string,
    template_id: string,
    input: unknown,
    updated_by: string,
    now: Date,
  ): RuleTemplate {
    if (!updated_by || !updated_by.trim()) {
      throw new CustomRuleTemplateError('invalid_input', 'updated_by required');
    }
    const arr = this.perTenant.get(tenant_id);
    const idx = arr ? arr.findIndex((t) => t.id === template_id) : -1;
    if (!arr || idx < 0) {
      throw new CustomRuleTemplateError(
        'unknown_template',
        `custom template ${template_id} not found`,
      );
    }
    const valid = validate(input);
    const cur = arr[idx]!;
    const next: RuleTemplate = {
      // id is immutable
      id: cur.id,
      name: valid.name,
      description: valid.description,
      vertical: valid.vertical,
      category: valid.category,
      condition_pseudocode: valid.condition_pseudocode,
      recommended_severity: valid.recommended_severity,
      recommended_actions: valid.recommended_actions,
      supporting_indicators: valid.supporting_indicators,
      // Preserve creator's source_doc unless caller supplies a new one
      source_doc: valid.source_doc ?? cur.source_doc,
    };
    arr[idx] = next;
    // T6 M5.12 — push the new state as the next version.
    this.pushVersion(tenant_id, template_id, next, updated_by.trim(), now);
    return next;
  }

  delete(tenant_id: string, template_id: string): boolean {
    const arr = this.perTenant.get(tenant_id);
    if (!arr) return false;
    const idx = arr.findIndex((t) => t.id === template_id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    // Versions stay; they remain queryable as an audit trail of the
    // template that used to exist. Tenant-isolated by the key prefix.
    return true;
  }

  listVersions(tenant_id: string, template_id: string): TemplateVersion[] {
    const arr = this.versions.get(this.vk(tenant_id, template_id)) ?? [];
    return arr.map((v) => ({
      ...v,
      snapshot: {
        ...v.snapshot,
        recommended_actions: [...v.snapshot.recommended_actions],
        supporting_indicators: [...v.snapshot.supporting_indicators],
      },
    }));
  }

  restoreVersion(
    tenant_id: string,
    template_id: string,
    version: number,
    restored_by: string,
    now: Date,
  ): { template: RuleTemplate; restored_from_version: number } {
    if (!restored_by || !restored_by.trim()) {
      throw new CustomRuleTemplateError('invalid_input', 'restored_by required');
    }
    const arr = this.perTenant.get(tenant_id);
    const idx = arr ? arr.findIndex((t) => t.id === template_id) : -1;
    if (!arr || idx < 0) {
      throw new CustomRuleTemplateError(
        'unknown_template',
        `custom template ${template_id} not found`,
      );
    }
    const versionArr = this.versions.get(this.vk(tenant_id, template_id)) ?? [];
    const match = versionArr.find((v) => v.version === version);
    if (!match) {
      throw new CustomRuleTemplateError(
        'unknown_version',
        `version ${version} not found for template ${template_id}`,
      );
    }
    const restored: RuleTemplate = {
      ...match.snapshot,
      recommended_actions: [...match.snapshot.recommended_actions],
      supporting_indicators: [...match.snapshot.supporting_indicators],
    };
    arr[idx] = restored;
    // Push a new version representing the restore so the audit trail
    // shows it as a discrete event (not just an unexplained jump back).
    this.pushVersion(tenant_id, template_id, restored, restored_by.trim(), now);
    return { template: restored, restored_from_version: match.version };
  }
}

export const defaultCustomRuleTemplateStore: CustomRuleTemplateStore =
  new InMemoryCustomRuleTemplateStore();

/** Look up a rule template by id — checks library first, then per-
 *  tenant custom store. Helper for downstream consumers (M5.2 bulk-
 *  clone, M5.3 simulation, M5.5 diff). */
export function getEffectiveRuleTemplate(
  store: CustomRuleTemplateStore,
  tenant_id: string,
  template_id: string,
): RuleTemplate | null {
  const lib = getLibraryTemplate(template_id);
  if (lib) return lib;
  return store.get(tenant_id, template_id);
}
