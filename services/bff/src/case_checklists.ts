// services/bff/src/case_checklists.ts
//
// T6 M9.2 — Custom investigation checklists.
//
// M9.1 shipped the default BIL §17 8-step claim-fraud checklist.
// M9.2 lets tenants define custom checklists for non-claim-fraud
// workflows: KYC reviews, sanctions reviews, complaint investigations,
// AML escalations, etc. Each tenant has its own custom set; the
// platform's built-in default is always available.
//
// The investigation engine (M9.1) consumes the resolved steps via the
// existing `OpenInvestigationInput.steps_override` parameter — when a
// caller supplies `checklist_template_id`, the route looks up the
// template's steps and passes them through. No changes to the M9.1
// state machine.

import { randomUUID } from 'node:crypto';
import { defaultSteps, type InvestigationStep } from './case_investigation';

// ─── Public types ──────────────────────────────────────────────────────

export type ChecklistCategory =
  | 'claim_fraud'
  | 'kyc_review'
  | 'sanctions'
  | 'complaint'
  | 'other';

export interface ChecklistTemplate {
  id: string;
  /** Tenant the template belongs to. 'PLATFORM' for the built-in default
   *  (visible to every tenant). */
  tenant_id: string;
  name: string;
  description: string;
  category: ChecklistCategory;
  /** True for the platform built-in (BIL §17). False for tenant custom. */
  is_built_in: boolean;
  steps: ChecklistTemplateStep[];
  created_at: string;
  created_by: string;
}

/** Step shape on a TEMPLATE. Distinct from InvestigationStep on a live
 *  investigation: templates carry only the static metadata; the live
 *  shape adds completed/completed_at/completed_by/evidence_link runtime
 *  fields. `materialiseSteps()` converts. */
export interface ChecklistTemplateStep {
  step_id: string;
  name: string;
  description: string;
}

export class ChecklistError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ChecklistError';
  }
}

const VALID_CATEGORIES: ChecklistCategory[] = [
  'claim_fraud',
  'kyc_review',
  'sanctions',
  'complaint',
  'other',
];

export function isChecklistCategory(s: unknown): s is ChecklistCategory {
  return typeof s === 'string' && VALID_CATEGORIES.includes(s as ChecklistCategory);
}

export function listChecklistCategories(): ChecklistCategory[] {
  return [...VALID_CATEGORIES];
}

// ─── Built-in template ────────────────────────────────────────────────

/** ID of the platform built-in BIL §17 claim-fraud checklist —
 *  same step set as M9.1's `defaultSteps()`. */
export const BUILT_IN_TEMPLATE_ID = 'tpl_bil_claim_fraud_default';

const BUILT_IN_TEMPLATE: ChecklistTemplate = {
  id: BUILT_IN_TEMPLATE_ID,
  tenant_id: 'PLATFORM',
  name: 'BIL Claim-Fraud Investigation (default)',
  description:
    'Platform default — the BIL §17 standard 8-step claim-fraud investigation checklist',
  category: 'claim_fraud',
  is_built_in: true,
  // Pull the steps from M9.1's defaultSteps() so the two are
  // never out of sync — if M9.1 changes, the template tracks.
  steps: defaultSteps().map((s) => ({
    step_id: s.step_id,
    name: s.name,
    description: s.description,
  })),
  created_at: '2026-04-01T00:00:00.000Z',
  created_by: 'platform',
};

// ─── Validation ────────────────────────────────────────────────────────

export interface CreateTemplateInput {
  name: string;
  description: string;
  category: ChecklistCategory;
  steps: ChecklistTemplateStep[];
}

export function validateTemplateInput(input: unknown): CreateTemplateInput {
  if (!input || typeof input !== 'object') {
    throw new ChecklistError('invalid_input', 'request body required');
  }
  const i = input as Partial<CreateTemplateInput>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new ChecklistError('invalid_input', 'name is required');
  }
  if (i.name.length > 200) {
    throw new ChecklistError('invalid_input', 'name must be ≤ 200 chars');
  }
  if (typeof i.description !== 'string') {
    throw new ChecklistError('invalid_input', 'description is required');
  }
  if (i.description.length > 2000) {
    throw new ChecklistError('invalid_input', 'description must be ≤ 2000 chars');
  }
  if (!isChecklistCategory(i.category)) {
    throw new ChecklistError(
      'invalid_category',
      `category must be one of ${VALID_CATEGORIES.join(',')}`,
    );
  }
  if (!Array.isArray(i.steps) || i.steps.length === 0) {
    throw new ChecklistError('invalid_steps', 'steps must be a non-empty array');
  }
  if (i.steps.length > 32) {
    throw new ChecklistError('invalid_steps', 'a template may carry at most 32 steps');
  }
  const seen = new Set<string>();
  const cleanSteps: ChecklistTemplateStep[] = [];
  for (let idx = 0; idx < i.steps.length; idx++) {
    const s = i.steps[idx] as Partial<ChecklistTemplateStep> | undefined;
    if (!s || typeof s !== 'object') {
      throw new ChecklistError('invalid_steps', `step[${idx}] must be an object`);
    }
    if (typeof s.step_id !== 'string' || !/^[a-z0-9_]+$/.test(s.step_id)) {
      throw new ChecklistError(
        'invalid_steps',
        `step[${idx}].step_id must be lowercase a-z, 0-9, or _ (got '${s.step_id}')`,
      );
    }
    if (seen.has(s.step_id)) {
      throw new ChecklistError('invalid_steps', `duplicate step_id: ${s.step_id}`);
    }
    seen.add(s.step_id);
    if (typeof s.name !== 'string' || !s.name.trim()) {
      throw new ChecklistError('invalid_steps', `step[${idx}].name is required`);
    }
    if (typeof s.description !== 'string') {
      throw new ChecklistError('invalid_steps', `step[${idx}].description is required`);
    }
    cleanSteps.push({
      step_id: s.step_id,
      name: s.name,
      description: s.description,
    });
  }
  return {
    name: i.name,
    description: i.description,
    category: i.category,
    steps: cleanSteps,
  };
}

// ─── Store ─────────────────────────────────────────────────────────────

export interface ChecklistTemplateStore {
  /** All templates visible to a tenant (built-in + tenant custom). */
  list(tenant_id: string, opts?: { category?: ChecklistCategory }): ChecklistTemplate[];
  /** Single template. Returns null when:
   *   - id is unknown, OR
   *   - id belongs to a different tenant (built-in 'PLATFORM' is visible to all). */
  get(tenant_id: string, template_id: string): ChecklistTemplate | null;
  /** Create a custom template. Validates input. */
  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): ChecklistTemplate;
  /**
   * Delete a custom template. Throws 'cannot_delete_builtin' when target is the
   * platform built-in, 'unknown_template' on miss, 'cross_tenant' on cross-
   * tenant attempt.
   */
  delete(tenant_id: string, template_id: string): void;
}

export class InMemoryChecklistTemplateStore implements ChecklistTemplateStore {
  /** tenant_id → template_id → ChecklistTemplate (custom only; built-in is
   *  served from the constant). */
  private readonly customs = new Map<string, Map<string, ChecklistTemplate>>();

  list(tenant_id: string, opts: { category?: ChecklistCategory } = {}): ChecklistTemplate[] {
    const tMap = this.customs.get(tenant_id);
    const customs = tMap ? [...tMap.values()] : [];
    const all = [BUILT_IN_TEMPLATE, ...customs];
    return opts.category ? all.filter((t) => t.category === opts.category) : all;
  }

  get(tenant_id: string, template_id: string): ChecklistTemplate | null {
    if (template_id === BUILT_IN_TEMPLATE_ID) return BUILT_IN_TEMPLATE;
    return this.customs.get(tenant_id)?.get(template_id) ?? null;
  }

  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): ChecklistTemplate {
    const validated = validateTemplateInput(input);
    const tpl: ChecklistTemplate = {
      id: `tpl-${randomUUID()}`,
      tenant_id,
      name: validated.name,
      description: validated.description,
      category: validated.category,
      is_built_in: false,
      steps: validated.steps,
      created_at: now.toISOString(),
      created_by,
    };
    let tMap = this.customs.get(tenant_id);
    if (!tMap) {
      tMap = new Map();
      this.customs.set(tenant_id, tMap);
    }
    tMap.set(tpl.id, tpl);
    return tpl;
  }

  delete(tenant_id: string, template_id: string): void {
    if (template_id === BUILT_IN_TEMPLATE_ID) {
      throw new ChecklistError(
        'cannot_delete_builtin',
        'the platform built-in checklist cannot be deleted',
      );
    }
    const tMap = this.customs.get(tenant_id);
    if (!tMap || !tMap.has(template_id)) {
      throw new ChecklistError(
        'unknown_template',
        `unknown checklist template: ${template_id}`,
      );
    }
    tMap.delete(template_id);
  }

  /** Test helper. */
  reset(): void {
    this.customs.clear();
  }
}

/** Module-level singleton. */
export const defaultChecklistTemplateStore: ChecklistTemplateStore =
  new InMemoryChecklistTemplateStore();

// ─── Step materialisation ──────────────────────────────────────────────

/**
 * Convert a template's static steps into the runtime InvestigationStep
 * shape M9.1's CaseInvestigationStore expects (with completed=false +
 * null timestamps + null evidence_link).
 *
 * Returns fresh objects on each call so concurrent investigations don't
 * share state — same contract as `defaultSteps()`.
 */
export function materialiseSteps(template: ChecklistTemplate): InvestigationStep[] {
  return template.steps.map((s) => ({
    step_id: s.step_id,
    name: s.name,
    description: s.description,
    completed: false,
    completed_at: null,
    completed_by: null,
    evidence_link: null,
  }));
}
