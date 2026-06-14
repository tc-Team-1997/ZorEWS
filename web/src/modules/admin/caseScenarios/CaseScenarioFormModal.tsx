// Shared create/edit modal for case_scenarios. Largest of the 3
// admin form modals — drives:
//   - escalation_matrix dropdown (only ACTIVE rules)
//   - notification_templates dropdown (only ACTIVE rows, optional)
//   - trigger pair (indicator + threshold both-or-neither)
//   - checklist editor (add/remove items, required toggle)

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { Button, DialogFooter, EnterpriseDialog } from '@/components/ui';
import {
  api,
  type CaseScenarioChecklistItem,
  type CaseScenarioCreateInput,
  type CaseScenarioPriority,
  type CaseScenarioRow,
  type CaseScenarioUpdateInput,
} from '@/lib/api';

const PRIORITIES: CaseScenarioPriority[] = ['P1', 'P2', 'P3', 'P4'];

interface PropsCreate {
  mode: 'create';
  existing: ReadonlyArray<CaseScenarioRow>;
  onClose: () => void;
  onSubmit: (input: CaseScenarioCreateInput) => void;
  isPending: boolean;
  error: unknown;
}
interface PropsEdit {
  mode: 'edit';
  row: CaseScenarioRow;
  onClose: () => void;
  onSubmit: (patch: CaseScenarioUpdateInput) => void;
  isPending: boolean;
  error: unknown;
}
type Props = PropsCreate | PropsEdit;

export function CaseScenarioFormModal(props: Props) {
  const isEdit = props.mode === 'edit';
  const initial = isEdit ? props.row : null;

  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState(initial?.case_category ?? 'fraud');
  const [priority, setPriority] = useState<CaseScenarioPriority>(initial?.priority ?? 'P1');
  const [triggerOn, setTriggerOn] = useState(initial?.trigger_indicator_id !== null && initial?.trigger_indicator_id !== undefined);
  const [triggerId, setTriggerId] = useState(initial?.trigger_indicator_id ?? '');
  const [triggerThreshold, setTriggerThreshold] = useState(
    initial?.trigger_threshold !== null && initial?.trigger_threshold !== undefined
      ? String(initial.trigger_threshold)
      : '',
  );
  const [escalationId, setEscalationId] = useState(initial?.default_escalation_id ?? '');
  const [templateId, setTemplateId] = useState(initial?.notification_template_id ?? '');
  const [checklist, setChecklist] = useState<CaseScenarioChecklistItem[]>(
    initial?.checklist ?? [],
  );
  const [validation, setValidation] = useState<string | null>(null);

  // Load FK-target candidates from the matrix + templates APIs
  const escalationsQ = useQuery({
    queryKey: ['scenario-form-escalations'],
    queryFn: () => api.escalationMatrixList({ status: 'ACTIVE', page_size: 200 }),
  });
  const templatesQ = useQuery({
    queryKey: ['scenario-form-templates'],
    queryFn: () => api.notificationTemplatesList({ status: 'ACTIVE', page_size: 200 }),
  });

  // On create: default escalation to first available
  useEffect(() => {
    if (!isEdit && !escalationId && escalationsQ.data?.items?.length) {
      setEscalationId(escalationsQ.data.items[0].escalation_id);
    }
  }, [isEdit, escalationId, escalationsQ.data]);

  const dupHint = useMemo(() => {
    if (isEdit) return null;
    const target = name.trim().toLowerCase();
    if (!target) return null;
    const ex = (props as PropsCreate).existing.find(
      (r) => r.deleted_at === null && r.name.toLowerCase() === target,
    );
    return ex
      ? `Already used (${ex.status.toLowerCase()}). Pick a different name.`
      : null;
  }, [isEdit, props, name]);

  const updateChecklistItem = (i: number, patch: Partial<CaseScenarioChecklistItem>) => {
    setChecklist((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  };
  const removeChecklistItem = (i: number) => {
    setChecklist((prev) => prev.filter((_, idx) => idx !== i));
  };
  const addChecklistItem = () => {
    setChecklist((prev) => [...prev, { title: '', required: false }]);
  };

  const submit = () => {
    setValidation(null);
    if (!name.trim()) return setValidation('Name is required');
    if (name.trim().length > 120) return setValidation('Name max 120 chars');
    if (!category.trim()) return setValidation('Case category is required');
    if (!escalationId) return setValidation('Default escalation rule is required');
    if (triggerOn) {
      if (!triggerId.trim()) return setValidation('Trigger indicator id is required when trigger is enabled');
      if (!triggerThreshold.trim()) return setValidation('Trigger threshold is required when trigger is enabled');
      const th = Number(triggerThreshold);
      if (!Number.isFinite(th)) return setValidation('Trigger threshold must be a number');
    }
    // Validate checklist titles
    for (let i = 0; i < checklist.length; i++) {
      if (!checklist[i].title.trim()) {
        return setValidation(`Checklist item ${i + 1} must have a title`);
      }
    }
    const payload = {
      case_category: category.trim(),
      priority,
      trigger_indicator_id: triggerOn ? triggerId.trim() : null,
      trigger_threshold: triggerOn ? Number(triggerThreshold) : null,
      default_escalation_id: escalationId,
      notification_template_id: templateId || null,
      checklist: checklist.map((it) => ({ title: it.title.trim(), required: it.required })),
    };
    if (isEdit) {
      const r = (props as PropsEdit).row;
      const patch: CaseScenarioUpdateInput = {};
      if (name.trim() !== r.name) patch.name = name.trim();
      if (payload.case_category !== r.case_category) patch.case_category = payload.case_category;
      if (payload.priority !== r.priority) patch.priority = payload.priority;
      if (payload.trigger_indicator_id !== r.trigger_indicator_id) patch.trigger_indicator_id = payload.trigger_indicator_id;
      if (payload.trigger_threshold !== r.trigger_threshold) patch.trigger_threshold = payload.trigger_threshold;
      if (payload.default_escalation_id !== r.default_escalation_id) patch.default_escalation_id = payload.default_escalation_id;
      if (payload.notification_template_id !== r.notification_template_id) patch.notification_template_id = payload.notification_template_id;
      if (JSON.stringify(payload.checklist) !== JSON.stringify(r.checklist)) patch.checklist = payload.checklist;
      if (Object.keys(patch).length === 0) return setValidation('No changes to save');
      (props as PropsEdit).onSubmit(patch);
      return;
    }
    if (dupHint) return setValidation(dupHint);
    (props as PropsCreate).onSubmit({ name: name.trim(), ...payload });
  };

  const errMsg =
    props.error instanceof Error ? props.error.message : props.error ? String(props.error) : null;

  return (
    <EnterpriseDialog
      open
      onClose={props.onClose}
      title={isEdit ? 'Edit case scenario' : 'New case scenario'}
      size="md"
      testId="case-scenario-modal"
      footer={
        <DialogFooter
          onCancel={props.onClose}
          primary={
            <Button onClick={submit} disabled={props.isPending} data-testid="cs-save">
              {isEdit ? 'Save changes' : 'Create draft'}
            </Button>
          }
        />
      }
    >
      <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1"
              placeholder="e.g. Fraud P1 sudden DPD spike"
              data-testid="cs-name"
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
                data-testid="cs-category"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as CaseScenarioPriority)}
                className="w-full rounded border border-slate-300 px-2 py-1"
                data-testid="cs-priority"
              >
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>

          <fieldset className="rounded border border-slate-200 p-3">
            <legend className="flex items-center gap-1 px-1 text-2xs font-semibold uppercase text-slate-500">
              <input
                type="checkbox"
                checked={triggerOn}
                onChange={(e) => setTriggerOn(e.target.checked)}
                data-testid="cs-trigger-toggle"
              />
              Auto-trigger on indicator
            </legend>
            <div className={`grid grid-cols-2 gap-3 ${triggerOn ? '' : 'opacity-40 pointer-events-none'}`}>
              <label className="block">
                <span className="mb-1 block text-2xs text-slate-500">Indicator id</span>
                <input
                  value={triggerId}
                  onChange={(e) => setTriggerId(e.target.value)}
                  disabled={!triggerOn}
                  placeholder="e.g. FRD-001"
                  className="w-full rounded border border-slate-300 px-2 py-1"
                  data-testid="cs-trigger-id"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-2xs text-slate-500">Threshold</span>
                <input
                  type="number"
                  step="0.0001"
                  value={triggerThreshold}
                  onChange={(e) => setTriggerThreshold(e.target.value)}
                  disabled={!triggerOn}
                  placeholder="0.85"
                  className="w-full rounded border border-slate-300 px-2 py-1 tabular-nums"
                  data-testid="cs-trigger-threshold"
                />
              </label>
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">
              Default escalation rule (required)
            </span>
            <select
              value={escalationId}
              onChange={(e) => setEscalationId(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1"
              data-testid="cs-escalation"
            >
              <option value="">— Pick a rule —</option>
              {escalationsQ.data?.items?.map((r) => (
                <option key={r.escalation_id} value={r.escalation_id}>
                  {r.name} ({r.case_category} · {r.priority})
                </option>
              ))}
            </select>
            {escalationsQ.isLoading && (
              <span className="mt-1 block text-2xs text-muted">Loading rules…</span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">
              Notification template (optional)
            </span>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1"
              data-testid="cs-template"
            >
              <option value="">— None —</option>
              {templatesQ.data?.items?.map((r) => (
                <option key={r.template_id} value={r.template_id}>
                  {r.name} ({r.channel})
                </option>
              ))}
            </select>
            {templatesQ.isLoading && (
              <span className="mt-1 block text-2xs text-muted">Loading templates…</span>
            )}
          </label>

          <fieldset className="rounded border border-slate-200 p-3">
            <legend className="px-1 text-2xs font-semibold uppercase text-slate-500">
              Checklist ({checklist.length})
            </legend>
            <div className="space-y-1.5">
              {checklist.map((item, i) => (
                <div key={i} className="flex items-center gap-2" data-testid={`cs-checklist-item-${i}`}>
                  <GripVertical className="h-3 w-3 shrink-0 text-slate-300" />
                  <input
                    value={item.title}
                    onChange={(e) => updateChecklistItem(i, { title: e.target.value })}
                    placeholder="e.g. Verify recent transactions with customer"
                    className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                    data-testid={`cs-checklist-title-${i}`}
                  />
                  <label className="flex items-center gap-1 text-2xs">
                    <input
                      type="checkbox"
                      checked={item.required}
                      onChange={(e) => updateChecklistItem(i, { required: e.target.checked })}
                      data-testid={`cs-checklist-required-${i}`}
                    />
                    required
                  </label>
                  <button
                    type="button"
                    onClick={() => removeChecklistItem(i)}
                    className="text-rose-500 hover:text-rose-700"
                    aria-label={`Remove checklist item ${i + 1}`}
                    data-testid={`cs-checklist-remove-${i}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {checklist.length === 0 && (
                <p className="text-2xs italic text-muted">No checklist items yet — add one below.</p>
              )}
              <button
                type="button"
                onClick={addChecklistItem}
                className="mt-1 inline-flex items-center gap-1 text-2xs text-blue-600 hover:underline"
                data-testid="cs-checklist-add"
              >
                <Plus className="h-3 w-3" /> Add checklist item
              </button>
            </div>
          </fieldset>

          {dupHint && !validation && (
            <div className="rounded bg-amber-50 px-2 py-1.5 text-2xs text-amber-700">{dupHint}</div>
          )}
          {validation && (
            <div className="rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" data-testid="cs-validation">
              {validation}
            </div>
          )}
          {errMsg && !validation && (
            <div className="rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" data-testid="cs-error">
              {errMsg}
            </div>
          )}
      </div>
    </EnterpriseDialog>
  );
}
