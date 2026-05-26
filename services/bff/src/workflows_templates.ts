// services/bff/src/workflows_templates.ts
//
// Workflow templates (non-case) — closes §2.3 #20 of
// ZorEWS_Pending_Gap_Analysis.md.
//
// Existing CMS workflow (M9.x) covers CASE lifecycle only. This module
// supports operator-defined workflows for sectors OUTSIDE CMS — e.g.
// "Borrower escalation workflow", "Onboarding KYC workflow", "Annual
// review workflow", "Stress-test approval workflow". Each template
// describes the ORDERED sequence of operator-driven steps + required
// approvers per step.
//
//   GET    /v1/workflows/templates
//   POST   /v1/workflows/templates
//   GET    /v1/workflows/templates/:template_id
//   PATCH  /v1/workflows/templates/:template_id
//   DELETE /v1/workflows/templates/:template_id
//   POST   /v1/workflows/templates/:template_id/clone

export type WorkflowDomain = 'borrower_escalation' | 'kyc_onboarding' | 'annual_review' | 'stress_test' | 'covenant_review' | 'recovery' | 'other';
export const ALL_WORKFLOW_DOMAINS: readonly WorkflowDomain[] = [
  'borrower_escalation', 'kyc_onboarding', 'annual_review', 'stress_test', 'covenant_review', 'recovery', 'other',
];

export interface WorkflowStep {
  step_order: number;
  name: string;
  description: string;
  required_role: string;
  expected_duration_hours: number;
  optional: boolean;
  // M5.4 — Workflows: 4-eyes gate on this stage.
  // When `requires_4_eyes=true`, this stage must be routed to TWO
  // different operators (maker + checker — must not be the same person)
  // drawn from `approver_pool`. The pool falls back to `[required_role]`
  // when not explicitly set, so existing templates pre-M5.4 keep
  // working without migration.
  requires_4_eyes?: boolean;
  approver_pool?: string[];
}

export interface WorkflowTemplate {
  template_id: string;
  tenant_id: string;
  name: string;
  domain: WorkflowDomain;
  description: string;
  steps: WorkflowStep[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export class WorkflowTemplateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WorkflowTemplateError';
  }
}

export function isWorkflowDomain(x: unknown): x is WorkflowDomain {
  return typeof x === 'string' && ALL_WORKFLOW_DOMAINS.includes(x as WorkflowDomain);
}

const _store = new Map<string, WorkflowTemplate>();
let _seq = 0;

const NAME_RE = /^[A-Za-z0-9 _.&()-]{3,120}$/;

function validateSteps(steps: unknown): WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length === 0)
    throw new WorkflowTemplateError('invalid_input', 'steps must be non-empty');
  if (steps.length > 30) throw new WorkflowTemplateError('invalid_input', 'steps > 30');
  const seen = new Set<number>();
  const out: WorkflowStep[] = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') throw new WorkflowTemplateError('invalid_step', 'step must be object');
    const so = s as Partial<WorkflowStep>;
    if (typeof so.step_order !== 'number' || !Number.isInteger(so.step_order) || so.step_order < 1)
      throw new WorkflowTemplateError('invalid_step', 'step_order must be a positive integer');
    if (seen.has(so.step_order)) throw new WorkflowTemplateError('invalid_step', `duplicate step_order ${so.step_order}`);
    seen.add(so.step_order);
    if (!so.name || typeof so.name !== 'string' || so.name.length < 3 || so.name.length > 120)
      throw new WorkflowTemplateError('invalid_step', 'step name must be 3..120 chars');
    if (!so.required_role || typeof so.required_role !== 'string')
      throw new WorkflowTemplateError('invalid_step', 'required_role required');
    if (typeof so.expected_duration_hours !== 'number' || !Number.isFinite(so.expected_duration_hours) || so.expected_duration_hours <= 0)
      throw new WorkflowTemplateError('invalid_step', 'expected_duration_hours must be positive finite');
    // M5.4 — Workflows: validate 4-eyes + approver_pool when present.
    let approver_pool: string[] | undefined;
    if (so.approver_pool !== undefined) {
      if (!Array.isArray(so.approver_pool))
        throw new WorkflowTemplateError('invalid_step', 'approver_pool must be array');
      const cleaned: string[] = [];
      for (const r of so.approver_pool) {
        if (typeof r !== 'string' || !r.trim())
          throw new WorkflowTemplateError('invalid_step', 'approver_pool entries must be non-empty strings');
        if (!cleaned.includes(r)) cleaned.push(r);
      }
      approver_pool = cleaned;
    }
    const requires_4_eyes = !!so.requires_4_eyes;
    // A 4-eyes stage needs at least 2 distinct operators — enforce that
    // the resolved pool (explicit or fallback to required_role) is
    // expressive enough. Single-role pool means everyone in that role
    // can act as either maker or checker, which is acceptable; an
    // EMPTY pool would prevent any routing at all.
    if (requires_4_eyes) {
      const resolved = approver_pool ?? [so.required_role];
      if (resolved.length === 0)
        throw new WorkflowTemplateError('invalid_step', '4-eyes stage requires non-empty approver_pool');
    }
    out.push({
      step_order: so.step_order,
      name: so.name,
      description: so.description ?? '',
      required_role: so.required_role,
      expected_duration_hours: so.expected_duration_hours,
      optional: !!so.optional,
      requires_4_eyes,
      approver_pool,
    });
  }
  out.sort((a, b) => a.step_order - b.step_order);
  return out;
}

export function listWorkflowTemplates(tenant_id: string, domain?: WorkflowDomain): WorkflowTemplate[] {
  if (!tenant_id) throw new WorkflowTemplateError('invalid_input', 'tenant_id required');
  const out: WorkflowTemplate[] = [];
  for (const v of _store.values()) {
    if (v.tenant_id !== tenant_id) continue;
    if (domain && v.domain !== domain) continue;
    out.push({ ...v, steps: v.steps.map((s) => ({ ...s })) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getWorkflowTemplate(tenant_id: string, template_id: string): WorkflowTemplate | null {
  const found = _store.get(template_id);
  if (!found || found.tenant_id !== tenant_id) return null;
  return { ...found, steps: found.steps.map((s) => ({ ...s })) };
}

export function createWorkflowTemplate(
  tenant_id: string,
  input: { name: string; domain: WorkflowDomain; description?: string; steps: WorkflowStep[]; is_default?: boolean },
  actor: string,
  now: Date,
): WorkflowTemplate {
  if (!tenant_id) throw new WorkflowTemplateError('invalid_input', 'tenant_id required');
  if (!actor) throw new WorkflowTemplateError('invalid_input', 'actor required');
  if (!input.name || !NAME_RE.test(input.name))
    throw new WorkflowTemplateError('invalid_input', 'name must match pattern');
  if (!isWorkflowDomain(input.domain)) throw new WorkflowTemplateError('invalid_domain', `domain ${input.domain}`);
  const steps = validateSteps(input.steps);
  _seq++;
  const id = `wft-${tenant_id}-${String(_seq).padStart(5, '0')}`;
  const entry: WorkflowTemplate = {
    template_id: id,
    tenant_id,
    name: input.name,
    domain: input.domain,
    description: input.description ?? '',
    steps,
    is_default: !!input.is_default,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    created_by: actor,
  };
  _store.set(id, entry);
  return { ...entry, steps: entry.steps.map((s) => ({ ...s })) };
}

export function updateWorkflowTemplate(
  tenant_id: string,
  template_id: string,
  patch: Partial<{ name: string; description: string; steps: WorkflowStep[]; is_default: boolean }>,
  now: Date,
): WorkflowTemplate {
  const entry = _store.get(template_id);
  if (!entry || entry.tenant_id !== tenant_id)
    throw new WorkflowTemplateError('unknown_template', `unknown ${template_id}`);
  if (patch.name !== undefined) {
    if (!NAME_RE.test(patch.name)) throw new WorkflowTemplateError('invalid_input', 'name must match pattern');
    entry.name = patch.name;
  }
  if (patch.description !== undefined) entry.description = patch.description;
  if (patch.steps !== undefined) entry.steps = validateSteps(patch.steps);
  if (patch.is_default !== undefined) entry.is_default = patch.is_default;
  entry.updated_at = now.toISOString();
  return { ...entry, steps: entry.steps.map((s) => ({ ...s })) };
}

export function deleteWorkflowTemplate(tenant_id: string, template_id: string): boolean {
  const entry = _store.get(template_id);
  if (!entry || entry.tenant_id !== tenant_id) return false;
  _store.delete(template_id);
  return true;
}

export function cloneWorkflowTemplate(
  tenant_id: string,
  template_id: string,
  newName: string,
  actor: string,
  now: Date,
): WorkflowTemplate {
  const source = _store.get(template_id);
  if (!source || source.tenant_id !== tenant_id)
    throw new WorkflowTemplateError('unknown_template', `unknown ${template_id}`);
  if (!newName || !NAME_RE.test(newName))
    throw new WorkflowTemplateError('invalid_input', 'newName must match pattern');
  return createWorkflowTemplate(
    tenant_id,
    {
      name: newName,
      domain: source.domain,
      description: `Cloned from ${source.name}: ${source.description}`,
      steps: source.steps.map((s) => ({ ...s })),
      is_default: false,
    },
    actor,
    now,
  );
}

export function _resetWorkflowTemplateStore() {
  _store.clear();
  _seq = 0;
}

// ──────────────────────────────────────────────────────────────────────
// M5.4 — Workflows: stage routing derivation.
//
// Spec acceptance: "A workflow with a 4-eyes stage automatically routes
// to the configured role pool." Given a stage definition, return the
// canonical {strategy, pool} that the case/workflow engine should use
// when assigning the stage to operators.
//
//   - Non-4-eyes stage  → strategy='single', pool=[required_role]
//   - 4-eyes stage      → strategy='four_eyes', pool=approver_pool ??
//                         [required_role]
//
// The pool is sorted asc for deterministic output (test invariants).
// ──────────────────────────────────────────────────────────────────────
export type StageRoutingStrategy = 'single' | 'four_eyes';

export interface StageRouting {
  step_order: number;
  step_name: string;
  strategy: StageRoutingStrategy;
  pool: string[];
  requires_distinct_actors: boolean;
}

export function deriveStageRouting(step: WorkflowStep): StageRouting {
  const requires_4_eyes = !!step.requires_4_eyes;
  const pool = requires_4_eyes
    ? [...(step.approver_pool ?? [step.required_role])]
    : [step.required_role];
  pool.sort((a, b) => a.localeCompare(b));
  return {
    step_order: step.step_order,
    step_name: step.name,
    strategy: requires_4_eyes ? 'four_eyes' : 'single',
    pool,
    requires_distinct_actors: requires_4_eyes,
  };
}

export function deriveWorkflowRouting(tpl: WorkflowTemplate): StageRouting[] {
  return tpl.steps.map(deriveStageRouting);
}
