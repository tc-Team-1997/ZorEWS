// Shared create/edit modal for escalation_matrix rules. The 3-level
// chain UX is the interesting bit — checkboxes toggle whether L2/L3
// are present, and the minute inputs validate ordering against L1
// (and L2) before save.

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
import {
  ESCALATION_ROLES,
  type EscalationMatrixCreateInput,
  type EscalationMatrixRuleRow,
  type EscalationMatrixUpdateInput,
  type EscalationPriority,
  type EscalationRole,
} from '@/lib/api';

const PRIORITIES: EscalationPriority[] = ['P1', 'P2', 'P3', 'P4'];

interface PropsCreate {
  mode: 'create';
  existing: ReadonlyArray<EscalationMatrixRuleRow>;
  /**
   * When set, the form pre-fills from this row's level/role timing.
   * Name + (case_category, priority) deliberately do NOT pre-fill —
   * the BFF unique-constraints on (case_category, priority) per tenant
   * + name uniqueness force the operator to pick fresh values.
   */
  prefill?: EscalationMatrixRuleRow;
  onClose: () => void;
  onSubmit: (input: EscalationMatrixCreateInput) => void;
  isPending: boolean;
  error: unknown;
}
interface PropsEdit {
  mode: 'edit';
  row: EscalationMatrixRuleRow;
  onClose: () => void;
  onSubmit: (patch: EscalationMatrixUpdateInput) => void;
  isPending: boolean;
  error: unknown;
}
type Props = PropsCreate | PropsEdit;

export function EscalationMatrixFormModal(props: Props) {
  const isEdit = props.mode === 'edit';
  const isDuplicate = props.mode === 'create' && !!props.prefill;
  // Source row for default values: edit → the row being edited; create+prefill
  // → the row being duplicated; create → null (defaults).
  const initial = isEdit
    ? props.row
    : props.mode === 'create'
      ? props.prefill ?? null
      : null;

  // For duplicate, pre-fill the level timings + roles but NOT the
  // identity fields (name + category + priority) — the operator has
  // to pick fresh values to clear the BFF uniqueness checks.
  const [name, setName] = useState(isEdit ? (initial?.name ?? '') : '');
  const [category, setCategory] = useState(
    isEdit ? (initial?.case_category ?? 'fraud') : 'fraud',
  );
  const [priority, setPriority] = useState<EscalationPriority>(
    isEdit ? (initial?.priority ?? 'P1') : 'P1',
  );
  const [l1m, setL1m] = useState(String(initial?.level_1_after_minutes ?? 60));
  const [l1r, setL1r] = useState<EscalationRole>(initial?.level_1_role ?? 'supervisor');
  const [l2on, setL2on] = useState(initial?.level_2_after_minutes !== null && initial?.level_2_after_minutes !== undefined);
  const [l2m, setL2m] = useState(String(initial?.level_2_after_minutes ?? 240));
  const [l2r, setL2r] = useState<EscalationRole>(initial?.level_2_role ?? 'risk_analyst');
  const [l3on, setL3on] = useState(initial?.level_3_after_minutes !== null && initial?.level_3_after_minutes !== undefined);
  const [l3m, setL3m] = useState(String(initial?.level_3_after_minutes ?? 720));
  const [l3r, setL3r] = useState<EscalationRole>(initial?.level_3_role ?? 'admin');
  const [validation, setValidation] = useState<string | null>(null);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  // Disabling L2 forces L3 off (DB CHECK: l3 set ⇒ l2 set)
  useEffect(() => {
    if (!l2on && l3on) setL3on(false);
  }, [l2on, l3on]);

  const dupHint = useMemo(() => {
    if (isEdit) return null;
    const target = name.trim().toLowerCase();
    if (!target) return null;
    const ex = (props as PropsCreate).existing.find(
      (r) => r.name.toLowerCase() === target,
    );
    return ex
      ? `Already used (${ex.status.toLowerCase()}). Pick a different name.`
      : null;
  }, [isEdit, props, name]);

  const submit = () => {
    setValidation(null);
    if (!name.trim()) return setValidation('Name is required');
    if (name.trim().length > 120) return setValidation('Name max 120 chars');
    if (!category.trim()) return setValidation('Case category is required');
    const l1 = Number(l1m);
    if (!Number.isInteger(l1) || l1 < 0) return setValidation('Level 1 minutes must be a non-negative integer');
    if (l2on) {
      const l2 = Number(l2m);
      if (!Number.isInteger(l2) || l2 < 0) return setValidation('Level 2 minutes must be a non-negative integer');
      if (l2 <= l1) return setValidation('Level 2 minutes must be greater than level 1');
    }
    if (l3on) {
      if (!l2on) return setValidation('Level 3 cannot be set without level 2');
      const l2 = Number(l2m);
      const l3 = Number(l3m);
      if (!Number.isInteger(l3) || l3 < 0) return setValidation('Level 3 minutes must be a non-negative integer');
      if (l3 <= l2) return setValidation('Level 3 minutes must be greater than level 2');
    }
    const payload = {
      level_1_after_minutes: l1,
      level_1_role: l1r,
      level_2_after_minutes: l2on ? Number(l2m) : null,
      level_2_role: l2on ? l2r : null,
      level_3_after_minutes: l3on ? Number(l3m) : null,
      level_3_role: l3on ? l3r : null,
    };
    if (isEdit) {
      const r = (props as PropsEdit).row;
      const patch: EscalationMatrixUpdateInput = {};
      if (name.trim() !== r.name) patch.name = name.trim();
      if (payload.level_1_after_minutes !== r.level_1_after_minutes) patch.level_1_after_minutes = payload.level_1_after_minutes;
      if (payload.level_1_role !== r.level_1_role) patch.level_1_role = payload.level_1_role;
      if (payload.level_2_after_minutes !== r.level_2_after_minutes) patch.level_2_after_minutes = payload.level_2_after_minutes;
      if (payload.level_2_role !== r.level_2_role) patch.level_2_role = payload.level_2_role;
      if (payload.level_3_after_minutes !== r.level_3_after_minutes) patch.level_3_after_minutes = payload.level_3_after_minutes;
      if (payload.level_3_role !== r.level_3_role) patch.level_3_role = payload.level_3_role;
      if (Object.keys(patch).length === 0) return setValidation('No changes to save');
      (props as PropsEdit).onSubmit(patch);
      return;
    }
    if (dupHint) return setValidation(dupHint);
    (props as PropsCreate).onSubmit({
      name: name.trim(),
      case_category: category.trim(),
      priority,
      ...payload,
    });
  };

  const errMsg =
    props.error instanceof Error ? props.error.message : props.error ? String(props.error) : null;

  const heading = isEdit
    ? 'Edit escalation rule'
    : isDuplicate
      ? 'Duplicate escalation rule'
      : 'New escalation rule';

  return (
    <div
      role="dialog"
      aria-label={heading}
      data-testid="escalation-matrix-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={props.onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-base font-semibold">
            {heading}
          </h3>
          <button
            type="button"
            onClick={props.onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 p-4 text-sm">
          {isDuplicate && (
            <p
              className="rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-2xs text-blue-800"
              data-testid="esc-duplicate-hint"
            >
              Pick a fresh name + (case category, priority) — the matrix is
              keyed on (case_category, priority) per tenant. Level timings + roles
              are pre-filled from the source rule.
            </p>
          )}
          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1"
              placeholder="e.g. BANK Fraud P1 fast-escalate"
              data-testid="esc-name"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">Case category</span>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1"
                placeholder="e.g. fraud"
                disabled={isEdit}
                data-testid="esc-category"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">
                Priority {isEdit && <em className="ml-1 normal-case text-muted">(locked)</em>}
              </span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as EscalationPriority)}
                className="w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-50 disabled:text-slate-500"
                disabled={isEdit}
                data-testid="esc-priority"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="rounded border border-slate-200 p-3">
            <legend className="px-1 text-2xs font-semibold uppercase text-slate-500">Level 1 (always required)</legend>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-2xs text-slate-500">After minutes</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={l1m}
                  onChange={(e) => setL1m(e.target.value)}
                  className="w-full rounded border border-slate-300 px-2 py-1 tabular-nums"
                  data-testid="esc-l1-minutes"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-2xs text-slate-500">Role</span>
                <select
                  value={l1r}
                  onChange={(e) => setL1r(e.target.value as EscalationRole)}
                  className="w-full rounded border border-slate-300 px-2 py-1"
                  data-testid="esc-l1-role"
                >
                  {ESCALATION_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset className="rounded border border-slate-200 p-3">
            <legend className="flex items-center gap-1 px-1 text-2xs font-semibold uppercase text-slate-500">
              <input
                type="checkbox"
                checked={l2on}
                onChange={(e) => setL2on(e.target.checked)}
                data-testid="esc-l2-toggle"
              />
              Level 2
            </legend>
            <div className={`grid grid-cols-2 gap-3 ${l2on ? '' : 'opacity-40 pointer-events-none'}`}>
              <label className="block">
                <span className="mb-1 block text-2xs text-slate-500">After minutes (must be &gt; level 1)</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={l2m}
                  onChange={(e) => setL2m(e.target.value)}
                  disabled={!l2on}
                  className="w-full rounded border border-slate-300 px-2 py-1 tabular-nums"
                  data-testid="esc-l2-minutes"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-2xs text-slate-500">Role</span>
                <select
                  value={l2r}
                  onChange={(e) => setL2r(e.target.value as EscalationRole)}
                  disabled={!l2on}
                  className="w-full rounded border border-slate-300 px-2 py-1"
                  data-testid="esc-l2-role"
                >
                  {ESCALATION_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset className="rounded border border-slate-200 p-3">
            <legend className="flex items-center gap-1 px-1 text-2xs font-semibold uppercase text-slate-500">
              <input
                type="checkbox"
                checked={l3on}
                onChange={(e) => setL3on(e.target.checked)}
                disabled={!l2on}
                data-testid="esc-l3-toggle"
              />
              Level 3 {!l2on && <em className="normal-case text-muted">(needs level 2)</em>}
            </legend>
            <div className={`grid grid-cols-2 gap-3 ${l3on && l2on ? '' : 'opacity-40 pointer-events-none'}`}>
              <label className="block">
                <span className="mb-1 block text-2xs text-slate-500">After minutes (must be &gt; level 2)</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={l3m}
                  onChange={(e) => setL3m(e.target.value)}
                  disabled={!l3on || !l2on}
                  className="w-full rounded border border-slate-300 px-2 py-1 tabular-nums"
                  data-testid="esc-l3-minutes"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-2xs text-slate-500">Role</span>
                <select
                  value={l3r}
                  onChange={(e) => setL3r(e.target.value as EscalationRole)}
                  disabled={!l3on || !l2on}
                  className="w-full rounded border border-slate-300 px-2 py-1"
                  data-testid="esc-l3-role"
                >
                  {ESCALATION_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
            </div>
          </fieldset>

          {dupHint && !validation && (
            <div className="rounded bg-amber-50 px-2 py-1.5 text-2xs text-amber-700">{dupHint}</div>
          )}
          {validation && (
            <div className="rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" data-testid="esc-validation">
              {validation}
            </div>
          )}
          {errMsg && !validation && (
            <div className="rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" data-testid="esc-error">
              {errMsg}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button onClick={submit} disabled={props.isPending} data-testid="esc-save">
            {isEdit ? 'Save changes' : 'Create rule'}
          </Button>
        </div>
      </div>
    </div>
  );
}
