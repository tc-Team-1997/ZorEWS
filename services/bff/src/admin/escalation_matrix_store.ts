// services/bff/src/admin/escalation_matrix_store.ts
//
// CRUD store for app_admin.escalation_matrix (T6 M14.15 schema).
// Mirrors the notification_templates_store + sla_config_store pattern:
// in-memory implementation for tests + dev fallback; PG-backed deferred.
//
// Validation enforces every DB CHECK (021_*.sql) at the API boundary so
// malformed payloads fail cheaply before INSERT:
//
//   - priority IN (P1..P4)
//   - level_1_after_minutes >= 0
//   - level_2 columns paired (both set or both null) AND minutes >
//     level_1_after_minutes
//   - level_3 columns paired (both set or both null) AND level_2 set
//     AND minutes > level_2_after_minutes
//   - level_*_role drawn from the canonical RBAC role list
//   - status IN (ACTIVE, ARCHIVED)

import { randomUUID } from 'node:crypto';
import {
  ESCALATION_ROLES,
  PRIORITIES,
  type EscalationMatrixRule,
  type EscalationRole,
  type EscalationStatus,
  type Priority,
} from './case_scenarios_types';

// Re-export so consumers can keep importing from this module unchanged
// (the canonical declaration lives in case_scenarios_types).
export { ESCALATION_ROLES };
export type { EscalationRole };

export interface CreateEscalationInput {
  name: string;
  case_category: string;
  priority: Priority;
  level_1_after_minutes: number;
  level_1_role: EscalationRole;
  level_2_after_minutes?: number | null;
  level_2_role?: EscalationRole | null;
  level_3_after_minutes?: number | null;
  level_3_role?: EscalationRole | null;
}

export interface UpdateEscalationInput {
  name?: string;
  level_1_after_minutes?: number;
  level_1_role?: EscalationRole;
  level_2_after_minutes?: number | null;
  level_2_role?: EscalationRole | null;
  level_3_after_minutes?: number | null;
  level_3_role?: EscalationRole | null;
}

export interface ListFilter {
  case_category?: string;
  priority?: Priority;
  status?: EscalationStatus[];
  page?: number;
  page_size?: number;
}

export interface ListResult {
  items: EscalationMatrixRule[];
  total: number;
  page: number;
  page_size: number;
}

export interface ActorContext {
  actor_id: string;
}

export class EscalationMatrixError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'EscalationMatrixError';
  }
}

// ─── Validation (pure, no IO) ─────────────────────────────────────────

function bad(code: string, msg: string): never {
  throw new EscalationMatrixError(400, code, msg);
}

function validateName(s: unknown): string {
  if (typeof s !== 'string') bad('EWS_400_invalid_input', 'name must be a string');
  const t = (s as string).trim();
  if (t.length < 1 || t.length > 120) bad('EWS_400_invalid_input', 'name length must be 1..120');
  return t;
}

function validatePriority(p: unknown): Priority {
  if (typeof p !== 'string' || !(PRIORITIES as readonly string[]).includes(p)) {
    bad('EWS_400_invalid_input', `priority must be one of ${PRIORITIES.join('|')}`);
  }
  return p as Priority;
}

function validateMinutesNonneg(n: unknown, fieldName: string): number {
  const x = typeof n === 'number' ? n : Number(n);
  if (!Number.isInteger(x) || x < 0) {
    bad('EWS_400_invalid_input', `${fieldName} must be a non-negative integer`);
  }
  return x;
}

function validateRole(r: unknown, fieldName: string): EscalationRole {
  if (typeof r !== 'string' || !(ESCALATION_ROLES as readonly string[]).includes(r)) {
    bad(
      'EWS_400_invalid_input',
      `${fieldName} must be one of ${ESCALATION_ROLES.join('|')}`,
    );
  }
  return r as EscalationRole;
}

function validateCategory(s: unknown): string {
  if (typeof s !== 'string') bad('EWS_400_invalid_input', 'case_category must be a string');
  const t = (s as string).trim();
  if (t.length < 1 || t.length > 80) bad('EWS_400_invalid_input', 'case_category length must be 1..80');
  return t;
}

/** Pair-and-order check for level 2 + level 3. Mirrors the DB CHECK. */
function validateLevelChain(
  l1Min: number,
  l2Min: number | null,
  l2Role: EscalationRole | null,
  l3Min: number | null,
  l3Role: EscalationRole | null,
): {
  level_2_after_minutes: number | null;
  level_2_role: EscalationRole | null;
  level_3_after_minutes: number | null;
  level_3_role: EscalationRole | null;
} {
  // Level 2 pairing
  const l2Set = l2Min !== null;
  const l2RoleSet = l2Role !== null;
  if (l2Set !== l2RoleSet) {
    bad(
      'EWS_400_invalid_input',
      'level_2_after_minutes and level_2_role must be set together (or both null)',
    );
  }
  if (l2Set && (l2Min as number) <= l1Min) {
    bad('EWS_400_invalid_input', 'level_2_after_minutes must be greater than level_1_after_minutes');
  }
  // Level 3 pairing
  const l3Set = l3Min !== null;
  const l3RoleSet = l3Role !== null;
  if (l3Set !== l3RoleSet) {
    bad(
      'EWS_400_invalid_input',
      'level_3_after_minutes and level_3_role must be set together (or both null)',
    );
  }
  if (l3Set && !l2Set) {
    bad('EWS_400_invalid_input', 'level_3 cannot be set without level_2');
  }
  if (l3Set && (l3Min as number) <= (l2Min as number)) {
    bad('EWS_400_invalid_input', 'level_3_after_minutes must be greater than level_2_after_minutes');
  }
  return {
    level_2_after_minutes: l2Min,
    level_2_role: l2Role,
    level_3_after_minutes: l3Min,
    level_3_role: l3Role,
  };
}

function nullableMinutes(v: unknown, fieldName: string): number | null {
  if (v === null || v === undefined) return null;
  return validateMinutesNonneg(v, fieldName);
}
function nullableRole(v: unknown, fieldName: string): EscalationRole | null {
  if (v === null || v === undefined) return null;
  return validateRole(v, fieldName);
}

export function validateCreate(raw: unknown): CreateEscalationInput {
  if (!raw || typeof raw !== 'object') bad('EWS_400_invalid_input', 'request body required');
  const r = raw as Record<string, unknown>;
  const name = validateName(r.name);
  const case_category = validateCategory(r.case_category);
  const priority = validatePriority(r.priority);
  const level_1_after_minutes = validateMinutesNonneg(r.level_1_after_minutes, 'level_1_after_minutes');
  const level_1_role = validateRole(r.level_1_role, 'level_1_role');
  const l2Min = nullableMinutes(r.level_2_after_minutes, 'level_2_after_minutes');
  const l2Role = nullableRole(r.level_2_role, 'level_2_role');
  const l3Min = nullableMinutes(r.level_3_after_minutes, 'level_3_after_minutes');
  const l3Role = nullableRole(r.level_3_role, 'level_3_role');
  const chain = validateLevelChain(level_1_after_minutes, l2Min, l2Role, l3Min, l3Role);
  return {
    name,
    case_category,
    priority,
    level_1_after_minutes,
    level_1_role,
    ...chain,
  };
}

export function validateUpdate(raw: unknown): UpdateEscalationInput {
  if (!raw || typeof raw !== 'object') bad('EWS_400_invalid_input', 'request body required');
  const r = raw as Record<string, unknown>;
  const out: UpdateEscalationInput = {};
  if (r.name !== undefined) out.name = validateName(r.name);
  if (r.level_1_after_minutes !== undefined) {
    out.level_1_after_minutes = validateMinutesNonneg(r.level_1_after_minutes, 'level_1_after_minutes');
  }
  if (r.level_1_role !== undefined) {
    out.level_1_role = validateRole(r.level_1_role, 'level_1_role');
  }
  if (r.level_2_after_minutes !== undefined) {
    out.level_2_after_minutes = nullableMinutes(r.level_2_after_minutes, 'level_2_after_minutes');
  }
  if (r.level_2_role !== undefined) {
    out.level_2_role = nullableRole(r.level_2_role, 'level_2_role');
  }
  if (r.level_3_after_minutes !== undefined) {
    out.level_3_after_minutes = nullableMinutes(r.level_3_after_minutes, 'level_3_after_minutes');
  }
  if (r.level_3_role !== undefined) {
    out.level_3_role = nullableRole(r.level_3_role, 'level_3_role');
  }
  if (Object.keys(out).length === 0) {
    bad('EWS_400_invalid_input', 'at least one field must be provided');
  }
  // The level-chain re-check happens in update() once we've merged
  // patch onto the existing row — partial patches that only touch L2 or
  // L3 still need to clear the chain rule against the un-touched levels.
  return out;
}

// ─── Store interface ─────────────────────────────────────────────────

export interface EscalationMatrixStore {
  list(tenant_id: string, filter: ListFilter): Promise<ListResult>;
  get(tenant_id: string, id: string): Promise<EscalationMatrixRule | null>;
  /** Best-match lookup by (case_category, priority). Returns the most
   *  recently updated ACTIVE rule, or null. Drives the on-create
   *  case-routing path that picks an escalation rule by case attrs. */
  resolveFor(
    tenant_id: string,
    case_category: string,
    priority: Priority,
  ): Promise<EscalationMatrixRule | null>;
  create(
    tenant_id: string,
    input: CreateEscalationInput,
    actor: ActorContext,
    now: Date,
  ): Promise<EscalationMatrixRule>;
  update(
    tenant_id: string,
    id: string,
    patch: UpdateEscalationInput,
    actor: ActorContext,
    now: Date,
  ): Promise<EscalationMatrixRule>;
  /** Move ACTIVE → ARCHIVED. Idempotent on already-ARCHIVED. */
  archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<EscalationMatrixRule>;
}

// ─── In-memory implementation ────────────────────────────────────────

export class InMemoryEscalationMatrixStore implements EscalationMatrixStore {
  private readonly rows: EscalationMatrixRule[] = [];

  /** Test helper. */
  seed(...rows: EscalationMatrixRule[]): void {
    for (const r of rows) this.rows.push({ ...r });
  }

  async list(tenant_id: string, filter: ListFilter): Promise<ListResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const all = this.rows
      .filter((r) => r.tenant_id === tenant_id)
      .filter((r) => !filter.case_category || r.case_category === filter.case_category)
      .filter((r) => !filter.priority || r.priority === filter.priority)
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize).map((r) => ({ ...r })),
      total: all.length,
      page,
      page_size: pageSize,
    };
  }

  async get(tenant_id: string, id: string): Promise<EscalationMatrixRule | null> {
    const r = this.rows.find((x) => x.tenant_id === tenant_id && x.escalation_id === id);
    return r ? { ...r } : null;
  }

  async resolveFor(
    tenant_id: string,
    case_category: string,
    priority: Priority,
  ): Promise<EscalationMatrixRule | null> {
    const matches = this.rows
      .filter(
        (r) =>
          r.tenant_id === tenant_id &&
          r.status === 'ACTIVE' &&
          r.case_category === case_category &&
          r.priority === priority,
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return matches.length > 0 ? { ...matches[0]! } : null;
  }

  async create(
    tenant_id: string,
    input: CreateEscalationInput,
    actor: ActorContext,
    now: Date,
  ): Promise<EscalationMatrixRule> {
    // Mirror DB UNIQUE (tenant_id, lower(name))
    const dup = this.rows.find(
      (r) => r.tenant_id === tenant_id && r.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (dup) {
      throw new EscalationMatrixError(
        409,
        'EWS_409_duplicate_escalation_name',
        `escalation name already used (id=${dup.escalation_id})`,
      );
    }
    const ts = now.toISOString();
    const row: EscalationMatrixRule = {
      escalation_id: randomUUID(),
      tenant_id,
      name: input.name,
      case_category: input.case_category,
      priority: input.priority,
      level_1_after_minutes: input.level_1_after_minutes,
      level_1_role: input.level_1_role,
      level_2_after_minutes: input.level_2_after_minutes ?? null,
      level_2_role: input.level_2_role ?? null,
      level_3_after_minutes: input.level_3_after_minutes ?? null,
      level_3_role: input.level_3_role ?? null,
      status: 'ACTIVE',
      created_by: actor.actor_id,
      updated_by: null,
      created_at: ts,
      updated_at: ts,
    };
    this.rows.push(row);
    return { ...row };
  }

  async update(
    tenant_id: string,
    id: string,
    patch: UpdateEscalationInput,
    actor: ActorContext,
    now: Date,
  ): Promise<EscalationMatrixRule> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.escalation_id === id);
    if (idx < 0) {
      throw new EscalationMatrixError(404, 'EWS_404_not_found', `escalation rule ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.status === 'ARCHIVED') {
      throw new EscalationMatrixError(409, 'EWS_409_invalid_state', 'cannot update an archived escalation rule');
    }
    // Merge then re-validate the level chain (so partial patches that
    // only touch L2 or L3 still respect ordering against the un-touched
    // levels).
    const merged: {
      level_1_after_minutes: number;
      level_2_after_minutes: number | null;
      level_2_role: EscalationRole | null;
      level_3_after_minutes: number | null;
      level_3_role: EscalationRole | null;
    } = {
      level_1_after_minutes: patch.level_1_after_minutes ?? old.level_1_after_minutes,
      level_2_after_minutes:
        patch.level_2_after_minutes !== undefined ? patch.level_2_after_minutes : old.level_2_after_minutes,
      level_2_role:
        patch.level_2_role !== undefined ? patch.level_2_role : old.level_2_role,
      level_3_after_minutes:
        patch.level_3_after_minutes !== undefined ? patch.level_3_after_minutes : old.level_3_after_minutes,
      level_3_role:
        patch.level_3_role !== undefined ? patch.level_3_role : old.level_3_role,
    };
    const chain = validateLevelChain(
      merged.level_1_after_minutes,
      merged.level_2_after_minutes,
      merged.level_2_role,
      merged.level_3_after_minutes,
      merged.level_3_role,
    );
    // Re-check unique name when name patches.
    const nextName = patch.name ?? old.name;
    if (nextName.toLowerCase() !== old.name.toLowerCase()) {
      const dup = this.rows.find(
        (r) =>
          r.tenant_id === tenant_id &&
          r.escalation_id !== id &&
          r.name.toLowerCase() === nextName.toLowerCase(),
      );
      if (dup) {
        throw new EscalationMatrixError(
          409,
          'EWS_409_duplicate_escalation_name',
          `escalation name already used (id=${dup.escalation_id})`,
        );
      }
    }
    const ts = now.toISOString();
    const updated: EscalationMatrixRule = {
      ...old,
      name: nextName,
      level_1_after_minutes: merged.level_1_after_minutes,
      level_1_role: patch.level_1_role ?? old.level_1_role,
      ...chain,
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = updated;
    return { ...updated };
  }

  async archive(
    tenant_id: string,
    id: string,
    actor: ActorContext,
    now: Date,
  ): Promise<EscalationMatrixRule> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.escalation_id === id);
    if (idx < 0) {
      throw new EscalationMatrixError(404, 'EWS_404_not_found', `escalation rule ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.status === 'ARCHIVED') return { ...old }; // idempotent
    const ts = now.toISOString();
    const updated: EscalationMatrixRule = {
      ...old,
      status: 'ARCHIVED',
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = updated;
    return { ...updated };
  }
}
