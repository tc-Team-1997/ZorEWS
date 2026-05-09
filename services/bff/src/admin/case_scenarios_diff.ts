// services/bff/src/admin/case_scenarios_diff.ts
//
// Tiny pure helper that computes a JSON-Patch-flavoured diff between
// two case_scenario row snapshots. Used by case_scenarios_store.ts to
// populate case_scenario_history.diff per the M14.15 schema.
//
// Scope: only the fields a user can mutate (name / case_category /
// priority / trigger_indicator_id / trigger_threshold /
// default_escalation_id / notification_template_id / checklist /
// status). Identity (scenario_id / tenant_id) and timestamps are not
// diffed — they're always present in after_state for replay.
//
// Output shape mirrors RFC-6902:
//   [{ op: 'replace', path: '/name', value: 'New name' }, ...]
//
// Add operations cover null → non-null transitions; remove covers
// non-null → null; replace covers value changes. Arrays + objects
// (checklist) are compared by deep-equal — a single replace op carries
// the whole new value rather than a per-element patch (smaller code,
// the consumer reads after_state for full replay anyway).

const TRACKED_FIELDS = [
  'name',
  'case_category',
  'priority',
  'trigger_indicator_id',
  'trigger_threshold',
  'default_escalation_id',
  'notification_template_id',
  'checklist',
  'status',
] as const;

export type DiffOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown };

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    return arrA.every((v, i) => deepEqual(v, arrB[i]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const ka = Object.keys(objA).sort();
  const kb = Object.keys(objB).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && deepEqual(objA[k], objB[k]));
}

/**
 * Diff two row snapshots. Returns an array of DiffOps for the tracked
 * fields. For a brand-new row (before === null) every non-null field
 * becomes an `add`; for an archive (after === null) every field becomes
 * a `remove`. Either-side null is rare (CRUD always has both) but
 * handled for symmetry with the audit replay use case.
 */
export function diffRows(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): DiffOp[] {
  const out: DiffOp[] = [];
  for (const f of TRACKED_FIELDS) {
    const a = before?.[f];
    const b = after?.[f];
    const aHas = before !== null && a !== undefined && a !== null;
    const bHas = after !== null && b !== undefined && b !== null;
    if (!aHas && !bHas) continue;
    if (!aHas && bHas) {
      out.push({ op: 'add', path: `/${f}`, value: b });
      continue;
    }
    if (aHas && !bHas) {
      out.push({ op: 'remove', path: `/${f}` });
      continue;
    }
    if (!deepEqual(a, b)) {
      out.push({ op: 'replace', path: `/${f}`, value: b });
    }
  }
  return out;
}
