// services/bff/src/tenant_onboarding.ts
//
// T6 M2.2 — Tenant onboarding wizard.
//
// M2.1 ships the readiness check (cross-module structural verdict).
// M2.2 ships the operator-facing tracker that admins use to walk
// a new tenant through onboarding step-by-step. Each step has a
// status (pending / completed / skipped), an actor, a timestamp,
// and optional notes. The state is per-tenant; the step CATALOGUE
// is platform-static.
//
// Design:
//  - 8 platform-defined steps in a fixed order. Required vs.
//    optional flags so "skipped" is allowed for non-required steps.
//  - Skipping a required step is allowed (some onboardings legitimately
//    defer e.g. operator-invited until later) but the wizard reports
//    `is_complete = false` until every required step is `completed`.
//    A skipped required step counts as "incomplete" for the
//    is_complete computation.
//  - Pure data + in-memory progress store. No `AppDeps` dependency
//    on M2.1 — onboarding is its own state.
//  - `get(tenant_id)` is total: returns a fresh "all-pending" state
//    for never-touched tenants. No 404.
//  - `markStep` rejects bogus step ids (404), bogus statuses (400),
//    and overlong notes (400). Re-marking a step is allowed (overwrites
//    the prior completion).
//  - `reset(tenant_id)` zeroes the progress for one tenant.
//  - Cross-tenant: state lives keyed by tenant_id, no leakage.
//
// Routes (registered by server.ts):
//   GET  /v1/tenants/onboarding/steps                — platform catalog
//   GET  /v1/tenants/me/onboarding                   — caller's tenant
//   GET  /v1/tenants/:tenant_id/onboarding           — admin lookup
//   POST /v1/tenants/:tenant_id/onboarding/steps/:step_id  body { status, notes? }
//   POST /v1/tenants/:tenant_id/onboarding/reset

// ─── Public types ──────────────────────────────────────────────────────

export type OnboardingStepId =
  | 'tenant_provisioned'
  | 'channels_configured'
  | 'vertical_set'
  | 'config_baseline'
  | 'email_channel'
  | 'alert_routing'
  | 'audit_active'
  | 'operator_invited';

export type StepStatus = 'pending' | 'completed' | 'skipped';

export const VALID_STEP_STATUSES: readonly StepStatus[] = ['pending', 'completed', 'skipped'] as const;

export interface OnboardingStepDef {
  id: OnboardingStepId;
  name: string;
  description: string;
  /** Required steps must be `completed` for the wizard to report
   *  is_complete=true. Skipped required steps count as incomplete. */
  required: boolean;
  /** Display order — 1-based. */
  order: number;
}

export interface StepProgress {
  step_id: OnboardingStepId;
  status: StepStatus;
  completed_at: string | null;
  completed_by: string | null;
  notes: string | null;
}

export interface OnboardingState {
  tenant_id: string;
  steps: StepProgress[];
  /** Total platform-defined steps. Stays constant across onboardings. */
  total_steps: number;
  required_steps: number;
  completed_count: number;
  skipped_count: number;
  pending_count: number;
  /** True iff every REQUIRED step is `completed`. Skipped optional
   *  steps don't disqualify; skipped required steps DO. */
  is_complete: boolean;
  /** Last `markStep` / `reset` timestamp. null on a never-touched tenant. */
  updated_at: string | null;
}

export class OnboardingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OnboardingError';
  }
}

// ─── Platform catalogue ───────────────────────────────────────────────

export const ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  {
    id: 'tenant_provisioned',
    name: 'Tenant provisioned',
    description: 'Tenant record created in app_iam.tenants — completed automatically when the tenant row is inserted.',
    required: true,
    order: 1,
  },
  {
    id: 'channels_configured',
    name: 'Channels configured',
    description: 'At least one channel allowlisted (BIL, BANK_DEMO, API, etc.).',
    required: true,
    order: 2,
  },
  {
    id: 'vertical_set',
    name: 'Vertical assigned',
    description: 'Tenant tagged as banking / insurance / both — drives M5.1 rule template visibility.',
    required: true,
    order: 3,
  },
  {
    id: 'config_baseline',
    name: 'Config baseline reviewed',
    description: 'M13.1 admin config defaults reviewed; per-tenant overrides set if any.',
    required: true,
    order: 4,
  },
  {
    id: 'email_channel',
    name: 'Email channel enabled',
    description: 'M10.1 email transport configured + from_address set; ALERT_RED + CASE_ASSIGNED templates verified.',
    required: true,
    order: 5,
  },
  {
    id: 'alert_routing',
    name: 'Alert routing reviewed',
    description: 'M8.2 routing matrix reviewed; per-tenant overrides set if any.',
    required: true,
    order: 6,
  },
  {
    id: 'audit_active',
    name: 'Audit trail active',
    description: 'M15.1 audit-trail receiving events; M15.2 hash-chain verified once after first 100 events.',
    required: true,
    order: 7,
  },
  {
    id: 'operator_invited',
    name: 'First operator invited',
    description: 'At least one analyst+ user invited; first-login wizard scheduled. Optional during onboarding — production deploy can defer.',
    required: false,
    order: 8,
  },
] as const;

const STEPS_BY_ID = new Map<string, OnboardingStepDef>(
  ONBOARDING_STEPS.map((s) => [s.id, s]),
);

export function isOnboardingStepId(s: unknown): s is OnboardingStepId {
  return typeof s === 'string' && STEPS_BY_ID.has(s);
}

export function isStepStatus(s: unknown): s is StepStatus {
  return typeof s === 'string' && VALID_STEP_STATUSES.includes(s as StepStatus);
}

export function getOnboardingStepDef(id: string): OnboardingStepDef | null {
  return STEPS_BY_ID.get(id) ?? null;
}

// ─── Validation ───────────────────────────────────────────────────────

const NOTES_CAP = 1000;

function checkActor(actor_username: unknown): asserts actor_username is string {
  if (typeof actor_username !== 'string' || !actor_username.trim()) {
    throw new OnboardingError('invalid_input', 'actor_username is required');
  }
}

function normaliseNotes(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new OnboardingError('invalid_input', 'notes must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length > NOTES_CAP) {
    throw new OnboardingError('invalid_input', `notes ≤ ${NOTES_CAP} chars`);
  }
  return trimmed.length === 0 ? null : trimmed;
}

// ─── State assembly ───────────────────────────────────────────────────

function pendingStep(id: OnboardingStepId): StepProgress {
  return {
    step_id: id,
    status: 'pending',
    completed_at: null,
    completed_by: null,
    notes: null,
  };
}

function buildState(
  tenant_id: string,
  progressMap: Map<OnboardingStepId, StepProgress>,
  updated_at: string | null,
): OnboardingState {
  const ordered = [...ONBOARDING_STEPS]
    .sort((a, b) => a.order - b.order)
    .map((def) => progressMap.get(def.id) ?? pendingStep(def.id));

  let completed_count = 0;
  let skipped_count = 0;
  let pending_count = 0;
  for (const s of ordered) {
    if (s.status === 'completed') completed_count++;
    else if (s.status === 'skipped') skipped_count++;
    else pending_count++;
  }
  const required_ids = new Set<OnboardingStepId>(
    ONBOARDING_STEPS.filter((s) => s.required).map((s) => s.id),
  );
  const is_complete = ordered.every(
    (s) => !required_ids.has(s.step_id) || s.status === 'completed',
  );
  return {
    tenant_id,
    steps: ordered,
    total_steps: ONBOARDING_STEPS.length,
    required_steps: required_ids.size,
    completed_count,
    skipped_count,
    pending_count,
    is_complete,
    updated_at,
  };
}

// ─── Store ────────────────────────────────────────────────────────────

export interface OnboardingStore {
  /** Total — returns an all-pending state for never-touched tenants. */
  get(tenant_id: string): OnboardingState;
  markStep(
    tenant_id: string,
    step_id: string,
    status: string,
    actor_username: string,
    notes: unknown,
    now: Date,
  ): OnboardingState;
  reset(tenant_id: string, actor_username: string, now: Date): OnboardingState;
}

export class InMemoryOnboardingStore implements OnboardingStore {
  private readonly progress = new Map<string, Map<OnboardingStepId, StepProgress>>();
  private readonly lastUpdated = new Map<string, string>();

  private bucket(tenant_id: string): Map<OnboardingStepId, StepProgress> {
    let m = this.progress.get(tenant_id);
    if (!m) {
      m = new Map();
      this.progress.set(tenant_id, m);
    }
    return m;
  }

  get(tenant_id: string): OnboardingState {
    if (!tenant_id || typeof tenant_id !== 'string') {
      throw new OnboardingError('invalid_input', 'tenant_id required');
    }
    const m = this.progress.get(tenant_id) ?? new Map<OnboardingStepId, StepProgress>();
    return buildState(tenant_id, m, this.lastUpdated.get(tenant_id) ?? null);
  }

  markStep(
    tenant_id: string,
    step_id: string,
    status: string,
    actor_username: string,
    notes: unknown,
    now: Date,
  ): OnboardingState {
    if (!tenant_id || typeof tenant_id !== 'string') {
      throw new OnboardingError('invalid_input', 'tenant_id required');
    }
    if (!isOnboardingStepId(step_id)) {
      throw new OnboardingError('unknown_step', `unknown onboarding step: ${step_id}`);
    }
    if (!isStepStatus(status)) {
      throw new OnboardingError(
        'invalid_status',
        `status must be one of ${VALID_STEP_STATUSES.join(', ')}`,
      );
    }
    checkActor(actor_username);
    const cleanNotes = normaliseNotes(notes);
    const ts = now.toISOString();
    const bucket = this.bucket(tenant_id);
    bucket.set(step_id, {
      step_id,
      status,
      completed_at: status === 'completed' ? ts : null,
      completed_by: status === 'completed' || status === 'skipped' ? actor_username.trim() : null,
      notes: cleanNotes,
    });
    this.lastUpdated.set(tenant_id, ts);
    return this.get(tenant_id);
  }

  reset(tenant_id: string, actor_username: string, now: Date): OnboardingState {
    if (!tenant_id || typeof tenant_id !== 'string') {
      throw new OnboardingError('invalid_input', 'tenant_id required');
    }
    checkActor(actor_username);
    this.progress.set(tenant_id, new Map());
    this.lastUpdated.set(tenant_id, now.toISOString());
    return this.get(tenant_id);
  }
}

export const defaultOnboardingStore: OnboardingStore = new InMemoryOnboardingStore();
