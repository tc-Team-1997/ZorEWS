// services/bff/src/cms_automation.ts
//
// CMS-4 — automation surface.
//
// Three concerns:
//
//  1. Auto-create a CMS case when a RED alert lands.
//     Pure function `autoCreateCaseFromAlert` — caller supplies the
//     alert envelope + the CmsCaseStore + the assignee pool +
//     `now`. Returns the created case OR null if a case for that
//     alert_id already exists (idempotent).
//
//  2. Per-tenant assignee pool — the round-robin candidates the
//     UI exposes as "auto-assign on RED alerts" + `/assign-from-pool`.
//     InMemoryAssigneePoolStore. Cap 50 members per tenant.
//
//  3. Inactive-case detection — `findInactiveCases` returns the
//     cases needing a reminder ping (status != CLOSED + updated_at
//     older than threshold_hours, default 48). Pure function.
//
// All three surfaces are pure / deterministic so route handlers in
// CMS-3 (extended in this commit) can compose them safely.

import { CmsCaseError, type CmsCase, type CmsPriority } from './cms_cases';
import { type CmsCaseStore } from './cms_store';

// ─── Auto-create from alert ─────────────────────────────────────────

const ALERT_SEVERITY_TO_PRIORITY: Record<string, CmsPriority> = {
  RED: 'P1',
  ORANGE: 'P2',
  YELLOW: 'P3',
  GREEN: 'P4',
  // BIL classification synonyms (M8.1)
  red: 'P1',
  orange: 'P2',
  yellow: 'P3',
  green: 'P4',
  // Pri synonyms
  critical: 'P1',
  high: 'P2',
  medium: 'P3',
  low: 'P4',
};

export interface AutoCreateInput {
  alert_id: string;
  alert_severity: string;       // RED / ORANGE / etc — mapped to priority
  customer_id?: string;
  rule_id?: string;
  rule_name?: string;
  /** Free-form summary stamped on the case description. */
  context?: string;
}

export interface AutoCreateResult {
  case: CmsCase;
  created: boolean;
  /** When created=false, the existing case_id we matched on. */
  matched_case_id?: string;
}

/**
 * Pure-function: caller supplies the store + pool + now. Idempotent
 * on alert_id within a tenant — re-firing with the same alert_id
 * returns the existing case rather than spawning a duplicate.
 */
export function autoCreateCaseFromAlert(
  input: AutoCreateInput,
  store: CmsCaseStore,
  tenant_id: string,
  pool: readonly string[],
  created_by: string,
  now: Date,
): AutoCreateResult {
  if (!input || typeof input !== 'object') {
    throw new CmsCaseError('invalid_input', 'auto-create body required');
  }
  if (typeof input.alert_id !== 'string' || !input.alert_id.trim()) {
    throw new CmsCaseError('invalid_input', 'alert_id required');
  }
  if (typeof input.alert_severity !== 'string') {
    throw new CmsCaseError('invalid_input', 'alert_severity required');
  }
  const priority = ALERT_SEVERITY_TO_PRIORITY[input.alert_severity];
  if (!priority) {
    throw new CmsCaseError(
      'invalid_input',
      `alert_severity '${input.alert_severity}' not in mapping`,
    );
  }

  // Idempotency: any existing case with the same alert_id wins.
  const existing = store.list(tenant_id, { alert_id: input.alert_id })[0];
  if (existing) {
    return { case: existing, created: false, matched_case_id: existing.case_id };
  }

  const customerLabel = input.customer_id ? ` for ${input.customer_id}` : '';
  const ruleLabel = input.rule_id ? ` (rule: ${input.rule_id})` : '';
  const title = `${input.alert_severity.toUpperCase()} alert${customerLabel}${ruleLabel}`;
  const description = [
    input.rule_name ? `Rule: ${input.rule_name}` : '',
    input.customer_id ? `Customer: ${input.customer_id}` : '',
    input.context ? `Context: ${input.context}` : '',
    `Source alert: ${input.alert_id}`,
  ]
    .filter(Boolean)
    .join(' | ');

  // Pool feeds round-robin: pick the first slot when no prior
  // assignment exists. Falls back to "no assignee" when pool empty.
  const assigned_to = pool.length > 0 ? pool[0]! : undefined;

  const created = store.create(
    tenant_id,
    {
      title: title.slice(0, 200),
      description: description.slice(0, 4000),
      priority,
      alert_id: input.alert_id,
      tags: [`auto:${input.alert_severity.toLowerCase()}`],
      assigned_to,
    },
    created_by.trim(),
    now,
  );

  return { case: created, created: true };
}

// ─── Assignee pool store ─────────────────────────────────────────────

const POOL_CAP_PER_TENANT = 50;
const MEMBER_CAP = 64;

export interface AssigneePool {
  tenant_id: string;
  members: string[];
  updated_at: string;
  updated_by: string;
}

export interface AssigneePoolStore {
  get(tenant_id: string): AssigneePool;
  setMembers(
    tenant_id: string,
    members: string[],
    updated_by: string,
    now: Date,
  ): AssigneePool;
}

export class InMemoryAssigneePoolStore implements AssigneePoolStore {
  private readonly perTenant = new Map<string, AssigneePool>();

  get(tenant_id: string): AssigneePool {
    return (
      this.perTenant.get(tenant_id) ?? {
        tenant_id,
        members: [],
        updated_at: '1970-01-01T00:00:00.000Z',
        updated_by: 'system',
      }
    );
  }

  setMembers(
    tenant_id: string,
    members: string[],
    updated_by: string,
    now: Date,
  ): AssigneePool {
    if (!Array.isArray(members)) {
      throw new CmsCaseError('invalid_input', 'members[] must be an array');
    }
    if (members.length > POOL_CAP_PER_TENANT) {
      throw new CmsCaseError(
        'invalid_input',
        `pool cap is ${POOL_CAP_PER_TENANT} members`,
      );
    }
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const m of members) {
      if (typeof m !== 'string' || !m.trim()) {
        throw new CmsCaseError('invalid_input', 'every member must be a non-empty string');
      }
      if (m.length > MEMBER_CAP) {
        throw new CmsCaseError('invalid_input', `member ≤ ${MEMBER_CAP} chars`);
      }
      const t = m.trim();
      if (seen.has(t)) {
        throw new CmsCaseError('invalid_input', `duplicate member: ${t}`);
      }
      seen.add(t);
      cleaned.push(t);
    }
    if (!updated_by || !updated_by.trim()) {
      throw new CmsCaseError('invalid_input', 'updated_by required');
    }
    const pool: AssigneePool = {
      tenant_id,
      members: cleaned,
      updated_at: now.toISOString(),
      updated_by: updated_by.trim(),
    };
    this.perTenant.set(tenant_id, pool);
    return { ...pool, members: [...pool.members] };
  }
}

export const defaultAssigneePoolStore: AssigneePoolStore = new InMemoryAssigneePoolStore();

// ─── Inactive-case detection ─────────────────────────────────────────

export interface InactiveCaseRow {
  case_id: string;
  case_number: string;
  title: string;
  status: CmsCase['status'];
  priority: CmsPriority;
  assigned_to: string | null;
  updated_at: string;
  inactive_hours: number;
}

const TERMINAL: ReadonlySet<CmsCase['status']> = new Set(['CLOSED']);

/**
 * Returns cases needing a "no update in N hours" reminder. Pure —
 * caller supplies the candidate list + threshold + clock.
 *
 * Default threshold per the brief: 48 hours.
 * Sorted longest-inactive first so the SPA shows the most-stale at top.
 */
export function findInactiveCases(
  cases: readonly CmsCase[],
  now: Date,
  threshold_hours = 48,
): InactiveCaseRow[] {
  if (
    !Number.isInteger(threshold_hours) ||
    threshold_hours < 1 ||
    threshold_hours > 720
  ) {
    throw new CmsCaseError('invalid_input', 'threshold_hours must be 1..720');
  }
  const thresholdMs = threshold_hours * 3_600_000;
  const out: InactiveCaseRow[] = [];
  for (const c of cases) {
    if (TERMINAL.has(c.status)) continue;
    const lastUpdate = new Date(c.updated_at).getTime();
    const elapsed = now.getTime() - lastUpdate;
    if (elapsed >= thresholdMs) {
      out.push({
        case_id: c.case_id,
        case_number: c.case_number,
        title: c.title,
        status: c.status,
        priority: c.priority,
        assigned_to: c.assigned_to,
        updated_at: c.updated_at,
        inactive_hours: Math.round((elapsed / 3_600_000) * 10) / 10,
      });
    }
  }
  return out.sort((a, b) => b.inactive_hours - a.inactive_hours);
}

export {
  POOL_CAP_PER_TENANT as CMS_POOL_CAP_PER_TENANT,
  ALERT_SEVERITY_TO_PRIORITY,
};
