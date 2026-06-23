// web/src/modules/admin/WorkflowsPage.tsx
//
// M5.4 — Workflows
//
// Workflow template management. Reuses the 5 BFF spec routes + the
// derived /routing view (M5.4 acceptance surface: 4-eyes stage
// auto-routes to the configured role pool).
//
// Screen contents (per spec):
//   - Workflow library — All defined workflows (template + step count)
//   - Add/Edit workflow modal — Stages, approvers (role pool), SLA,
//     escalation chain (4-eyes toggle per stage)
//   - Stage graph — Visual state machine (linear order + 4-eyes badge
//     on stages that require dual control)
//   - Workflow detail / routing view
//
// User actions: Create, Edit (PATCH), Delete, Clone

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Copy, Trash2, X, Users, ArrowRight, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { Badge } from '@/components/ui/Badge';
import { api } from '@/lib/api';
import type {
  WorkflowTemplate,
  WorkflowStep,
  WorkflowDomain,
  WorkflowTemplateCreateInput,
  StageRouting,
} from '@/lib/api';
import { ALL_WORKFLOW_DOMAINS } from '@/lib/api';

const DOMAIN_LABELS: Record<WorkflowDomain, string> = {
  borrower_escalation: 'Borrower escalation',
  kyc_onboarding: 'KYC onboarding',
  annual_review: 'Annual review',
  stress_test: 'Stress test',
  covenant_review: 'Covenant review',
  recovery: 'Recovery',
  other: 'Other',
};

function StageGraph({ stages }: { stages: StageRouting[] }) {
  if (!stages.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="wf-stage-graph">
      {stages.map((s, idx) => (
        <div key={s.step_order} className="flex items-center gap-2">
          <div
            className={`rounded-lg border px-3 py-2 ${
              s.strategy === 'four_eyes'
                ? 'border-warning/40 bg-warning/5'
                : 'border-divider bg-surface'
            }`}
            data-testid={`wf-stage-${s.step_order}`}
          >
            <div className="flex items-center gap-1 text-xs font-semibold text-ink">
              {s.strategy === 'four_eyes' && (
                <ShieldCheck className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
              )}
              Stage {s.step_order}
            </div>
            <div className="text-xs text-ink-muted">{s.step_name}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {s.pool.map((r) => (
                <span
                  key={r}
                  className="rounded bg-brand-sky/10 px-1.5 py-0.5 text-[10px] font-mono text-brand-blue"
                >
                  {r}
                </span>
              ))}
            </div>
            {s.requires_distinct_actors && (
              <div className="mt-1 text-[10px] font-semibold text-warning">
                4-eyes · distinct actors
              </div>
            )}
          </div>
          {idx < stages.length - 1 && (
            <ArrowRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  );
}

const BLANK_STEP: WorkflowStep = {
  step_order: 1,
  name: '',
  description: '',
  required_role: 'analyst',
  expected_duration_hours: 4,
  optional: false,
  requires_4_eyes: false,
};

function EditModal({
  initial,
  onClose,
  onSubmit,
  title,
  testid,
}: {
  initial: WorkflowTemplateCreateInput | null;
  onClose: () => void;
  onSubmit: (input: WorkflowTemplateCreateInput) => void;
  title: string;
  testid: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [domain, setDomain] = useState<WorkflowDomain>(initial?.domain ?? 'other');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [steps, setSteps] = useState<WorkflowStep[]>(
    initial?.steps?.length ? initial.steps : [{ ...BLANK_STEP }],
  );

  function updateStep(idx: number, patch: Partial<WorkflowStep>) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  function addStep() {
    setSteps((prev) => [
      ...prev,
      { ...BLANK_STEP, step_order: prev.length + 1, name: `Stage ${prev.length + 1}` },
    ]);
  }

  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_order: i + 1 })));
  }

  function handleSubmit() {
    onSubmit({ name, domain, description, steps });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      data-testid={testid}
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-divider bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-divider px-5 py-3">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-surface-alt"
            aria-label="close"
            data-testid={`${testid}-close`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-semibold text-ink-muted">Name</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="wf-edit-name"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-ink-muted">Domain</span>
              <select
                value={domain}
                onChange={(e) => setDomain(e.target.value as WorkflowDomain)}
                className="mt-1 w-full rounded-md border border-divider bg-surface px-2 py-1.5 text-sm"
                data-testid="wf-edit-domain"
              >
                {ALL_WORKFLOW_DOMAINS.map((d) => (
                  <option key={d} value={d}>
                    {DOMAIN_LABELS[d]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="block text-xs font-semibold text-ink-muted">Description</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="wf-edit-description"
            />
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">Stages</span>
              <Button size="sm" variant="secondary" onClick={addStep} data-testid="wf-edit-add-stage">
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add stage
              </Button>
            </div>
            <div className="space-y-3">
              {steps.map((s, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-divider p-3"
                  data-testid={`wf-edit-stage-${idx}`}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-ink-muted">Stage {s.step_order}</span>
                    {steps.length > 1 && (
                      <button
                        onClick={() => removeStep(idx)}
                        className="text-xs text-danger hover:underline"
                        data-testid={`wf-edit-remove-stage-${idx}`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Input
                      placeholder="Stage name"
                      value={s.name}
                      onChange={(e) => updateStep(idx, { name: e.target.value })}
                      data-testid={`wf-edit-stage-name-${idx}`}
                    />
                    <Input
                      placeholder="Required role"
                      value={s.required_role}
                      onChange={(e) => updateStep(idx, { required_role: e.target.value })}
                      data-testid={`wf-edit-stage-role-${idx}`}
                    />
                    <Input
                      placeholder="Description"
                      value={s.description}
                      onChange={(e) => updateStep(idx, { description: e.target.value })}
                    />
                    <Input
                      type="number"
                      placeholder="Expected hours"
                      value={s.expected_duration_hours}
                      onChange={(e) =>
                        updateStep(idx, { expected_duration_hours: Number(e.target.value) || 0 })
                      }
                      data-testid={`wf-edit-stage-hours-${idx}`}
                    />
                  </div>
                  <div className="mt-2 flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={s.optional}
                        onChange={(e) => updateStep(idx, { optional: e.target.checked })}
                      />
                      Optional
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={!!s.requires_4_eyes}
                        onChange={(e) => updateStep(idx, { requires_4_eyes: e.target.checked })}
                        data-testid={`wf-edit-stage-4eyes-${idx}`}
                      />
                      <ShieldCheck className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
                      Requires 4-eyes
                    </label>
                  </div>
                  {s.requires_4_eyes && (
                    <label className="mt-2 block">
                      <span className="block text-xs font-semibold text-ink-muted">
                        Approver pool (comma-separated roles; leave blank to use required role)
                      </span>
                      <Input
                        placeholder="supervisor, head_of_risk, compliance_officer"
                        value={(s.approver_pool ?? []).join(', ')}
                        onChange={(e) =>
                          updateStep(idx, {
                            approver_pool: e.target.value
                              .split(',')
                              .map((r) => r.trim())
                              .filter(Boolean),
                          })
                        }
                        data-testid={`wf-edit-stage-pool-${idx}`}
                      />
                    </label>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-divider px-5 py-3">
          <Button variant="secondary" onClick={onClose} data-testid={`${testid}-cancel`}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} data-testid={`${testid}-save`}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export function WorkflowsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WorkflowTemplate | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const templatesQ = useQuery({
    queryKey: ['workflows', 'list'],
    queryFn: () => api.workflowsList(),
  });

  const templates = (templatesQ.data?.templates ?? []) as WorkflowTemplate[];

  // Pick the first template by default after the list loads.
  const selected = useMemo(() => {
    if (!templates.length) return null;
    return templates.find((t) => t.template_id === selectedId) ?? templates[0];
  }, [templates, selectedId]);

  const routingQ = useQuery({
    queryKey: ['workflows', 'routing', selected?.template_id],
    queryFn: () => api.workflowRouting(selected!.template_id),
    enabled: !!selected,
  });

  const createMut = useMutation({
    mutationFn: (input: WorkflowTemplateCreateInput) => api.workflowCreate(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows', 'list'] });
      setCreating(false);
    },
  });
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<WorkflowTemplateCreateInput> }) =>
      api.workflowUpdate(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      setEditing(null);
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.workflowDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });
  const cloneMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.workflowClone(id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });

  // KPI tiles
  const total = templates.length;
  const defaults = templates.filter((t) => t.is_default).length;
  const fourEyesCount = templates.filter((t) =>
    t.steps.some((s) => !!s.requires_4_eyes),
  ).length;
  const totalStages = templates.reduce((acc, t) => acc + t.steps.length, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('workflows', { defaultValue: 'Workflows' })}
        subtitle="Workflow templates — stages, approvers, SLAs, 4-eyes routing"
        actions={
          <Button onClick={() => setCreating(true)} data-testid="wf-new">
            <Plus className="mr-1 h-4 w-4" />
            New workflow
          </Button>
        }
      />

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard
          testId="wf-kpi-total"
          label="Templates"
          value={String(total)}
          sub="Defined workflows"
        />
        <MetricCard
          testId="wf-kpi-defaults"
          label="Defaults"
          value={String(defaults)}
          sub="is_default=true"
        />
        <MetricCard
          testId="wf-kpi-4eyes"
          label="With 4-eyes"
          value={String(fourEyesCount)}
          sub="Templates with ≥1 dual-control stage"
        />
        <MetricCard
          testId="wf-kpi-stages"
          label="Total stages"
          value={String(totalStages)}
          sub="Across all templates"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Library */}
        <Panel title="Workflow library" className="lg:col-span-1">
          {templatesQ.isLoading ? (
            <div className="h-40 w-full animate-pulse rounded-lg bg-surface-alt" />
          ) : templates.length === 0 ? (
            <div className="text-sm text-ink-muted">No workflows yet. Create the first one →</div>
          ) : (
            <div className="space-y-2" data-testid="wf-library">
              {templates.map((tpl) => {
                const has4 = tpl.steps.some((s) => !!s.requires_4_eyes);
                const selectedRow = selected?.template_id === tpl.template_id;
                return (
                  <button
                    key={tpl.template_id}
                    onClick={() => setSelectedId(tpl.template_id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                      selectedRow
                        ? 'border-action bg-action/5'
                        : 'border-divider hover:border-action/40'
                    }`}
                    data-testid={`wf-row-${tpl.template_id}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink">{tpl.name}</span>
                      {tpl.is_default && (
                        <Badge tone="success" className="text-[10px]">
                          default
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-ink-muted">
                      <span>{DOMAIN_LABELS[tpl.domain] ?? tpl.domain}</span>
                      <span aria-hidden="true">·</span>
                      <span>{tpl.steps.length} stages</span>
                      {has4 && (
                        <Badge tone="warning" className="text-[10px]">
                          <ShieldCheck className="mr-1 inline h-3 w-3" />
                          4-eyes
                        </Badge>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Panel>

        {/* Detail */}
        <Panel title="Workflow detail" className="lg:col-span-2">
          {!selected ? (
            <div className="text-sm text-ink-muted">Select a workflow to view its details.</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-ink" data-testid="wf-detail-name">
                    {selected.name}
                  </h3>
                  <p className="text-sm text-ink-muted">{selected.description || '—'}</p>
                  <div className="mt-1 text-xs text-ink-muted">
                    Domain: {DOMAIN_LABELS[selected.domain] ?? selected.domain} · Created by{' '}
                    {selected.created_by}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setEditing(selected)}
                    data-testid="wf-edit-btn"
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      cloneMut.mutate({
                        id: selected.template_id,
                        name: `${selected.name} (copy)`,
                      })
                    }
                    data-testid="wf-clone-btn"
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" /> Clone
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (window.confirm(`Delete "${selected.name}"?`)) {
                        deleteMut.mutate(selected.template_id);
                        setSelectedId(null);
                      }
                    }}
                    data-testid="wf-delete-btn"
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </div>

              {/* Stage graph (acceptance surface) */}
              <div>
                <h4 className="mb-2 flex items-center gap-1 text-sm font-semibold text-ink">
                  <Users className="h-4 w-4" aria-hidden="true" />
                  Stage routing
                </h4>
                {routingQ.isLoading ? (
                  <div className="h-24 w-full animate-pulse rounded-lg bg-surface-alt" />
                ) : (
                  <StageGraph stages={(routingQ.data?.stages ?? []) as StageRouting[]} />
                )}
              </div>

              {/* Stage table */}
              <div>
                <h4 className="mb-2 text-sm font-semibold text-ink">Stages</h4>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm" data-testid="wf-stage-table">
                    <thead>
                      <tr className="border-b border-divider text-left text-xs font-semibold text-ink-muted">
                        <th className="px-2 py-1.5">#</th>
                        <th className="px-2 py-1.5">Name</th>
                        <th className="px-2 py-1.5">Role / pool</th>
                        <th className="px-2 py-1.5">SLA (h)</th>
                        <th className="px-2 py-1.5">4-eyes</th>
                        <th className="px-2 py-1.5">Optional</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.steps.map((s) => (
                        <tr
                          key={s.step_order}
                          className="border-b border-divider/50"
                          data-testid={`wf-detail-stage-${s.step_order}`}
                        >
                          <td className="px-2 py-1.5 font-mono text-xs">{s.step_order}</td>
                          <td className="px-2 py-1.5">{s.name}</td>
                          <td className="px-2 py-1.5">
                            {s.requires_4_eyes ? (
                              <span className="font-mono text-xs">
                                {(s.approver_pool ?? [s.required_role]).join(', ')}
                              </span>
                            ) : (
                              <span className="font-mono text-xs">{s.required_role}</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">{s.expected_duration_hours}</td>
                          <td className="px-2 py-1.5">
                            {s.requires_4_eyes ? (
                              <Badge tone="warning" className="text-[10px]">
                                yes
                              </Badge>
                            ) : (
                              <span className="text-ink-muted">—</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5">{s.optional ? 'yes' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {creating && (
        <EditModal
          initial={null}
          title="New workflow"
          testid="wf-create-modal"
          onClose={() => setCreating(false)}
          onSubmit={(input) => createMut.mutate(input)}
        />
      )}
      {editing && (
        <EditModal
          initial={{
            name: editing.name,
            domain: editing.domain,
            description: editing.description,
            steps: editing.steps,
            is_default: editing.is_default,
          }}
          title={`Edit "${editing.name}"`}
          testid="wf-edit-modal"
          onClose={() => setEditing(null)}
          onSubmit={(input) =>
            updateMut.mutate({ id: editing.template_id, patch: input })
          }
        />
      )}
    </div>
  );
}
