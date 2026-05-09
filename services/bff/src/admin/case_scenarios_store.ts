// services/bff/src/admin/case_scenarios_store.ts
//
// CRUD store for app_admin.case_scenarios (T6 M14.15 schema). Largest
// of the 4 M14.15 surfaces:
//
//   - FK validation against escalation_matrix + notification_templates,
//     done via injected resolver functions so the store doesn't need to
//     hold references to the full sibling stores. Tests pass simple
//     mocks; production wires the InMemory* siblings or PG-backed
//     equivalents.
//   - Lifecycle DRAFT → ACTIVE → ARCHIVED, plus restore (ARCHIVED →
//     DRAFT) which un-soft-deletes.
//   - Soft-delete via deleted_at — list() hides by default.
//   - Optional history fan-out: every mutation (create/update/activate/
//     archive/restore) appends one row to the injected history store
//     with an RFC-6902-flavoured diff. If no history store is wired the
//     fan-out is silently skipped (dev-mode fallback).

import { randomUUID } from 'node:crypto';
import {
  PRIORITIES,
  type CaseScenario,
  type CaseScenarioChecklistItem,
  type CaseScenarioStatus,
  type Priority,
} from './case_scenarios_types';
import {
  diffRows,
  type DiffOp,
} from './case_scenarios_diff';
import type {
  CaseScenarioHistoryStore,
} from './case_scenario_history_store';

// ─── Public input shapes ─────────────────────────────────────────────

export interface CreateCaseScenarioInput {
  name: string;
  case_category: string;
  priority: Priority;
  trigger_indicator_id?: string | null;
  trigger_threshold?: number | null;
  default_escalation_id: string;
  notification_template_id?: string | null;
  checklist?: CaseScenarioChecklistItem[];
}

export interface UpdateCaseScenarioInput {
  name?: string;
  case_category?: string;
  priority?: Priority;
  trigger_indicator_id?: string | null;
  trigger_threshold?: number | null;
  default_escalation_id?: string;
  notification_template_id?: string | null;
  checklist?: CaseScenarioChecklistItem[];
}

export interface ListFilter {
  status?: CaseScenarioStatus[];
  case_category?: string;
  priority?: Priority;
  trigger_indicator_id?: string;
  /** Default false — soft-deleted rows hidden. */
  include_deleted?: boolean;
  page?: number;
  page_size?: number;
}

export interface ListResult {
  items: CaseScenario[];
  total: number;
  page: number;
  page_size: number;
}

export interface ActorContext {
  actor_id: string;
}

export class CaseScenarioError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'CaseScenarioError';
  }
}

// ─── Resolver shape for FK validation ────────────────────────────────
//
// Lets the store check that an escalation_matrix or notification_template
// FK target exists, belongs to the same tenant, and isn't archived /
// soft-deleted — without depending on the full sibling store classes.

export interface CaseScenarioStoreDeps {
  /** Returns the row's status, or null if not found in this tenant. */
  resolveEscalation: (
    tenant_id: string,
    escalation_id: string,
  ) => Promise<{ status: 'ACTIVE' | 'ARCHIVED' } | null>;
  /** Returns row metadata, or null if not found in this tenant. */
  resolveTemplate: (
    tenant_id: string,
    template_id: string,
  ) => Promise<{ status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; deleted_at: string | null } | null>;
  /** Optional — when set, mutations append to history. */
  history?: CaseScenarioHistoryStore;
}

// ─── Validation (pure, no IO) ─────────────────────────────────────────

function bad(code: string, msg: string): never {
  throw new CaseScenarioError(400, code, msg);
}

function validateName(s: unknown): string {
  if (typeof s !== 'string') bad('EWS_400_invalid_input', 'name must be a string');
  const t = (s as string).trim();
  if (t.length < 1 || t.length > 120) bad('EWS_400_invalid_input', 'name length must be 1..120');
  return t;
}

function validateCategory(s: unknown): string {
  if (typeof s !== 'string') bad('EWS_400_invalid_input', 'case_category must be a string');
  const t = (s as string).trim();
  if (t.length < 1 || t.length > 80) bad('EWS_400_invalid_input', 'case_category length must be 1..80');
  return t;
}

function validatePriority(p: unknown): Priority {
  if (typeof p !== 'string' || !(PRIORITIES as readonly string[]).includes(p)) {
    bad('EWS_400_invalid_input', `priority must be one of ${PRIORITIES.join('|')}`);
  }
  return p as Priority;
}

function validateUuid(s: unknown, field: string): string {
  if (typeof s !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    bad('EWS_400_invalid_input', `${field} must be a UUID`);
  }
  return s;
}

function validateTriggerPair(
  indicatorId: unknown,
  threshold: unknown,
): { trigger_indicator_id: string | null; trigger_threshold: number | null } {
  const idSet = indicatorId !== null && indicatorId !== undefined && indicatorId !== '';
  const thSet = threshold !== null && threshold !== undefined && (threshold as unknown) !== '';
  if (idSet !== thSet) {
    bad(
      'EWS_400_invalid_input',
      'trigger_indicator_id and trigger_threshold must be set together (or both omitted)',
    );
  }
  if (!idSet) return { trigger_indicator_id: null, trigger_threshold: null };
  if (typeof indicatorId !== 'string') bad('EWS_400_invalid_input', 'trigger_indicator_id must be a string');
  const id = (indicatorId as string).trim();
  if (id.length < 1 || id.length > 50) {
    bad('EWS_400_invalid_input', 'trigger_indicator_id length must be 1..50');
  }
  const th = typeof threshold === 'number' ? threshold : Number(threshold);
  if (!Number.isFinite(th)) bad('EWS_400_invalid_input', 'trigger_threshold must be a number');
  // DB column is NUMERIC(10,4) — round to match.
  return { trigger_indicator_id: id, trigger_threshold: Math.round(th * 10000) / 10000 };
}

function validateChecklist(raw: unknown): CaseScenarioChecklistItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) bad('EWS_400_invalid_input', 'checklist must be an array');
  const out: CaseScenarioChecklistItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      bad('EWS_400_invalid_input', `checklist[${i}] must be an object`);
    }
    const r = item as Record<string, unknown>;
    if (typeof r.title !== 'string') {
      bad('EWS_400_invalid_input', `checklist[${i}].title must be a string`);
    }
    const title = (r.title as string).trim();
    if (title.length < 1 || title.length > 200) {
      bad('EWS_400_invalid_input', `checklist[${i}].title length must be 1..200`);
    }
    if (typeof r.required !== 'boolean') {
      bad('EWS_400_invalid_input', `checklist[${i}].required must be a boolean`);
    }
    out.push({ title, required: r.required });
  }
  return out;
}

export function validateCreate(raw: unknown): {
  name: string;
  case_category: string;
  priority: Priority;
  trigger_indicator_id: string | null;
  trigger_threshold: number | null;
  default_escalation_id: string;
  notification_template_id: string | null;
  checklist: CaseScenarioChecklistItem[];
} {
  if (!raw || typeof raw !== 'object') bad('EWS_400_invalid_input', 'request body required');
  const r = raw as Record<string, unknown>;
  return {
    name: validateName(r.name),
    case_category: validateCategory(r.case_category),
    priority: validatePriority(r.priority),
    ...validateTriggerPair(r.trigger_indicator_id, r.trigger_threshold),
    default_escalation_id: validateUuid(r.default_escalation_id, 'default_escalation_id'),
    notification_template_id:
      r.notification_template_id === undefined || r.notification_template_id === null
        ? null
        : validateUuid(r.notification_template_id, 'notification_template_id'),
    checklist: validateChecklist(r.checklist),
  };
}

export function validateUpdate(raw: unknown): UpdateCaseScenarioInput {
  if (!raw || typeof raw !== 'object') bad('EWS_400_invalid_input', 'request body required');
  const r = raw as Record<string, unknown>;
  const out: UpdateCaseScenarioInput = {};
  if (r.name !== undefined) out.name = validateName(r.name);
  if (r.case_category !== undefined) out.case_category = validateCategory(r.case_category);
  if (r.priority !== undefined) out.priority = validatePriority(r.priority);
  // Trigger pair requires both-or-neither — the merge check happens in update().
  if (r.trigger_indicator_id !== undefined) {
    out.trigger_indicator_id =
      r.trigger_indicator_id === null || r.trigger_indicator_id === ''
        ? null
        : (r.trigger_indicator_id as string);
  }
  if (r.trigger_threshold !== undefined) {
    out.trigger_threshold =
      r.trigger_threshold === null
        ? null
        : (typeof r.trigger_threshold === 'number'
            ? r.trigger_threshold
            : Number(r.trigger_threshold));
    if (out.trigger_threshold !== null && !Number.isFinite(out.trigger_threshold)) {
      bad('EWS_400_invalid_input', 'trigger_threshold must be a number');
    }
  }
  if (r.default_escalation_id !== undefined) {
    out.default_escalation_id = validateUuid(r.default_escalation_id, 'default_escalation_id');
  }
  if (r.notification_template_id !== undefined) {
    out.notification_template_id =
      r.notification_template_id === null
        ? null
        : validateUuid(r.notification_template_id, 'notification_template_id');
  }
  if (r.checklist !== undefined) out.checklist = validateChecklist(r.checklist);
  if (Object.keys(out).length === 0) {
    bad('EWS_400_invalid_input', 'at least one field must be provided');
  }
  return out;
}

// ─── Store interface ─────────────────────────────────────────────────

export interface CaseScenarioStore {
  list(tenant_id: string, filter: ListFilter): Promise<ListResult>;
  get(tenant_id: string, id: string): Promise<CaseScenario | null>;
  create(
    tenant_id: string,
    input: ReturnType<typeof validateCreate>,
    actor: ActorContext,
    now: Date,
  ): Promise<CaseScenario>;
  update(
    tenant_id: string,
    id: string,
    patch: UpdateCaseScenarioInput,
    actor: ActorContext,
    now: Date,
  ): Promise<CaseScenario>;
  activate(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<CaseScenario>;
  archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<CaseScenario>;
  /** Restore an ARCHIVED row back to DRAFT — clears deleted_at. */
  restore(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<CaseScenario>;
}

// ─── In-memory implementation ────────────────────────────────────────

export class InMemoryCaseScenarioStore implements CaseScenarioStore {
  private readonly rows: CaseScenario[] = [];
  constructor(private readonly deps: CaseScenarioStoreDeps) {}

  /** Test helper. */
  seed(...rows: CaseScenario[]): void {
    for (const r of rows) this.rows.push({ ...r });
  }

  // ── FK guards ────────────────────────────────────────────────────
  private async assertEscalationOk(tenant_id: string, escalation_id: string): Promise<void> {
    const row = await this.deps.resolveEscalation(tenant_id, escalation_id);
    if (!row) {
      throw new CaseScenarioError(
        400,
        'EWS_400_invalid_fk',
        `escalation_id ${escalation_id} not found in tenant ${tenant_id}`,
      );
    }
    if (row.status !== 'ACTIVE') {
      throw new CaseScenarioError(
        400,
        'EWS_400_invalid_fk',
        `escalation_id ${escalation_id} is ${row.status}; only ACTIVE rules can back a scenario`,
      );
    }
  }
  private async assertTemplateOk(tenant_id: string, template_id: string): Promise<void> {
    const row = await this.deps.resolveTemplate(tenant_id, template_id);
    if (!row) {
      throw new CaseScenarioError(
        400,
        'EWS_400_invalid_fk',
        `notification_template_id ${template_id} not found in tenant ${tenant_id}`,
      );
    }
    if (row.deleted_at !== null || row.status === 'ARCHIVED') {
      throw new CaseScenarioError(
        400,
        'EWS_400_invalid_fk',
        `notification_template_id ${template_id} is archived/deleted`,
      );
    }
  }

  // ── History fan-out (silent if no store wired) ──────────────────
  private async appendHistory(
    tenant_id: string,
    scenario_id: string,
    action: 'create' | 'update' | 'activate' | 'archive' | 'restore',
    before: CaseScenario | null,
    after: CaseScenario,
    actor: ActorContext,
    now: Date,
  ): Promise<DiffOp[]> {
    const beforeRec = before
      ? (before as unknown as Record<string, unknown>)
      : null;
    const afterRec = after as unknown as Record<string, unknown>;
    const diff = diffRows(beforeRec, afterRec);
    if (this.deps.history) {
      try {
        await this.deps.history.append(
          tenant_id,
          {
            scenario_id,
            action,
            diff,
            after_state: { ...afterRec },
            performed_by: actor.actor_id,
          },
          now,
        );
      } catch (e) {
        // Fire-and-forget by design — logged but not propagated. The
        // PG implementation backs this with the BEFORE INSERT trigger
        // chain that already swallows + logs failures.
        // eslint-disable-next-line no-console
        console.warn(
          `case_scenario_history append failed for scenario_id=${scenario_id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return diff;
  }

  // ── CRUD ────────────────────────────────────────────────────────
  async list(tenant_id: string, filter: ListFilter): Promise<ListResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const all = this.rows
      .filter((r) => r.tenant_id === tenant_id)
      .filter((r) => filter.include_deleted || r.deleted_at === null)
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .filter((r) => !filter.case_category || r.case_category === filter.case_category)
      .filter((r) => !filter.priority || r.priority === filter.priority)
      .filter(
        (r) =>
          !filter.trigger_indicator_id ||
          r.trigger_indicator_id === filter.trigger_indicator_id,
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize).map((r) => ({ ...r })),
      total: all.length,
      page,
      page_size: pageSize,
    };
  }

  async get(tenant_id: string, id: string): Promise<CaseScenario | null> {
    const r = this.rows.find((x) => x.tenant_id === tenant_id && x.scenario_id === id);
    return r ? { ...r } : null;
  }

  async create(
    tenant_id: string,
    input: ReturnType<typeof validateCreate>,
    actor: ActorContext,
    now: Date,
  ): Promise<CaseScenario> {
    // Mirror DB UNIQUE (tenant_id, lower(name)) WHERE deleted_at IS NULL
    const dup = this.rows.find(
      (r) =>
        r.tenant_id === tenant_id &&
        r.deleted_at === null &&
        r.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (dup) {
      throw new CaseScenarioError(
        409,
        'EWS_409_duplicate_scenario_name',
        `scenario name already used (id=${dup.scenario_id})`,
      );
    }
    await this.assertEscalationOk(tenant_id, input.default_escalation_id);
    if (input.notification_template_id) {
      await this.assertTemplateOk(tenant_id, input.notification_template_id);
    }
    const ts = now.toISOString();
    const row: CaseScenario = {
      scenario_id: randomUUID(),
      tenant_id,
      name: input.name,
      case_category: input.case_category,
      priority: input.priority,
      trigger_indicator_id: input.trigger_indicator_id,
      trigger_threshold: input.trigger_threshold,
      default_escalation_id: input.default_escalation_id,
      notification_template_id: input.notification_template_id,
      checklist: input.checklist,
      status: 'DRAFT',
      created_by: actor.actor_id,
      updated_by: null,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
    };
    this.rows.push(row);
    await this.appendHistory(tenant_id, row.scenario_id, 'create', null, row, actor, now);
    return { ...row };
  }

  async update(
    tenant_id: string,
    id: string,
    patch: UpdateCaseScenarioInput,
    actor: ActorContext,
    now: Date,
  ): Promise<CaseScenario> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.scenario_id === id);
    if (idx < 0) {
      throw new CaseScenarioError(404, 'EWS_404_not_found', `scenario ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.deleted_at !== null) {
      throw new CaseScenarioError(409, 'EWS_409_invalid_state', 'cannot update an archived scenario');
    }
    // Merge then re-check the trigger pair so partial patches respect the both-or-neither rule.
    const mergedTriggerId =
      patch.trigger_indicator_id !== undefined ? patch.trigger_indicator_id : old.trigger_indicator_id;
    const mergedTriggerTh =
      patch.trigger_threshold !== undefined ? patch.trigger_threshold : old.trigger_threshold;
    const triggerIdSet = mergedTriggerId !== null && mergedTriggerId !== undefined && mergedTriggerId !== '';
    const triggerThSet = mergedTriggerTh !== null && mergedTriggerTh !== undefined;
    if (triggerIdSet !== triggerThSet) {
      throw new CaseScenarioError(
        400,
        'EWS_400_invalid_input',
        'trigger_indicator_id and trigger_threshold must be set together (or both null)',
      );
    }
    // FK re-validation when those fields patch
    if (patch.default_escalation_id) {
      await this.assertEscalationOk(tenant_id, patch.default_escalation_id);
    }
    if (patch.notification_template_id !== undefined && patch.notification_template_id !== null) {
      await this.assertTemplateOk(tenant_id, patch.notification_template_id);
    }
    // Re-check duplicate name when name patches
    const nextName = patch.name ?? old.name;
    if (nextName.toLowerCase() !== old.name.toLowerCase()) {
      const dup = this.rows.find(
        (r) =>
          r.tenant_id === tenant_id &&
          r.scenario_id !== id &&
          r.deleted_at === null &&
          r.name.toLowerCase() === nextName.toLowerCase(),
      );
      if (dup) {
        throw new CaseScenarioError(
          409,
          'EWS_409_duplicate_scenario_name',
          `scenario name already used (id=${dup.scenario_id})`,
        );
      }
    }
    const ts = now.toISOString();
    const updated: CaseScenario = {
      ...old,
      name: nextName,
      case_category: patch.case_category ?? old.case_category,
      priority: patch.priority ?? old.priority,
      trigger_indicator_id: triggerIdSet ? (mergedTriggerId as string) : null,
      trigger_threshold: triggerThSet
        ? Math.round((mergedTriggerTh as number) * 10000) / 10000
        : null,
      default_escalation_id: patch.default_escalation_id ?? old.default_escalation_id,
      notification_template_id:
        patch.notification_template_id !== undefined
          ? patch.notification_template_id
          : old.notification_template_id,
      checklist: patch.checklist ?? old.checklist,
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = updated;
    await this.appendHistory(tenant_id, id, 'update', old, updated, actor, now);
    return { ...updated };
  }

  async activate(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<CaseScenario> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.scenario_id === id);
    if (idx < 0) {
      throw new CaseScenarioError(404, 'EWS_404_not_found', `scenario ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.deleted_at !== null || old.status === 'ARCHIVED') {
      throw new CaseScenarioError(409, 'EWS_409_invalid_state', 'cannot activate an archived scenario');
    }
    if (old.status === 'ACTIVE') return { ...old }; // idempotent — no history entry
    // Re-check FK targets are still valid at activation time.
    await this.assertEscalationOk(tenant_id, old.default_escalation_id);
    if (old.notification_template_id) {
      await this.assertTemplateOk(tenant_id, old.notification_template_id);
    }
    const ts = now.toISOString();
    const updated: CaseScenario = { ...old, status: 'ACTIVE', updated_by: actor.actor_id, updated_at: ts };
    this.rows[idx] = updated;
    await this.appendHistory(tenant_id, id, 'activate', old, updated, actor, now);
    return { ...updated };
  }

  async archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<CaseScenario> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.scenario_id === id);
    if (idx < 0) {
      throw new CaseScenarioError(404, 'EWS_404_not_found', `scenario ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.deleted_at !== null) return { ...old }; // idempotent
    const ts = now.toISOString();
    const updated: CaseScenario = {
      ...old,
      status: 'ARCHIVED',
      deleted_at: ts,
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = updated;
    await this.appendHistory(tenant_id, id, 'archive', old, updated, actor, now);
    return { ...updated };
  }

  async restore(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<CaseScenario> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.scenario_id === id);
    if (idx < 0) {
      throw new CaseScenarioError(404, 'EWS_404_not_found', `scenario ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.deleted_at === null) {
      throw new CaseScenarioError(409, 'EWS_409_invalid_state', 'scenario is not archived; nothing to restore');
    }
    // Restoring an archived row brings it back as DRAFT — admin must
    // re-activate explicitly. Also re-check the unique-name constraint
    // since another scenario may have taken the name during its absence.
    const dup = this.rows.find(
      (r) =>
        r.tenant_id === tenant_id &&
        r.scenario_id !== id &&
        r.deleted_at === null &&
        r.name.toLowerCase() === old.name.toLowerCase(),
    );
    if (dup) {
      throw new CaseScenarioError(
        409,
        'EWS_409_duplicate_scenario_name',
        `name "${old.name}" was reused while archived (id=${dup.scenario_id}); rename before restore`,
      );
    }
    const ts = now.toISOString();
    const updated: CaseScenario = {
      ...old,
      status: 'DRAFT',
      deleted_at: null,
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = updated;
    await this.appendHistory(tenant_id, id, 'restore', old, updated, actor, now);
    return { ...updated };
  }
}
