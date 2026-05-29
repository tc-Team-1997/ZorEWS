// web/src/modules/ai/AiWorkbenchPage.tsx
//
// Module 4.1 — AI Workbench.
//
// Three sections per the spec:
//   - Active Models Snapshot — production + shadow models from M7.1
//     registry (uses the new ?status=deployed virtual filter).
//   - Prompt Library — CRUD over /v1/ai/prompts/library. Created
//     prompts are IMMEDIATELY available to the copilot — the spec
//     acceptance is enforced server-side by the new prompt_id field
//     on POST /v1/copilot/chat.
//   - Lifecycle Scenarios — static reference cards documenting
//     "what happens when…" governance flows (drift, retire, promote,
//     auto-escalate). These are doc-as-code, not interactive.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BookOpen,
  ChevronRight,
  Database,
  Edit,
  GitMerge,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, type AiModelRow, type AiPrompt, type PromptCategory } from '@/lib/api';
import { HybridRulesPanel } from './HybridRulesPanel';

const CATEGORIES: PromptCategory[] = [
  'risk_analysis',
  'reporting',
  'investigation',
  'compliance',
  'modelling',
  'data_quality',
  'other',
];

const CATEGORY_TONE: Record<PromptCategory, 'blue' | 'success' | 'warning' | 'danger'> = {
  risk_analysis: 'danger',
  reporting: 'blue',
  investigation: 'warning',
  compliance: 'success',
  modelling: 'blue',
  data_quality: 'success',
  other: 'blue',
};

const STATUS_TONE: Record<string, 'success' | 'warning' | 'blue' | 'danger'> = {
  production: 'success',
  shadow: 'warning',
  staging: 'blue',
  experimental: 'blue',
  retired: 'danger',
};

type Tab = 'models' | 'prompts' | 'scenarios' | 'hybrid';

export function AiWorkbenchPage() {
  const [tab, setTab] = useState<Tab>('models');
  const user = useAuth((s) => s.user);
  const canEditPrompts =
    user?.roles.some((r) => ['admin', 'supervisor'].includes(r)) ?? false;
  // Hybrid-rule authoring follows the M5 rule-engine RBAC (rules:create) —
  // analyst-level + above, mirroring who can draft a deterministic rule.
  const canEditHybrid =
    user?.roles.some((r) => ['admin', 'supervisor', 'risk_analyst'].includes(r)) ?? false;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="AI Workbench"
        subtitle="Active models · prompt library · lifecycle governance scenarios"
      />

      <div className="flex gap-1 border-b border-divider" role="tablist">
        <TabBtn active={tab === 'models'} onClick={() => setTab('models')} testId="aiwb-tab-models">
          <Layers size={14} /> Active Models
        </TabBtn>
        <TabBtn active={tab === 'prompts'} onClick={() => setTab('prompts')} testId="aiwb-tab-prompts">
          <BookOpen size={14} /> Prompt Library
        </TabBtn>
        <TabBtn active={tab === 'scenarios'} onClick={() => setTab('scenarios')} testId="aiwb-tab-scenarios">
          <Workflow size={14} /> Lifecycle Scenarios
        </TabBtn>
        <TabBtn active={tab === 'hybrid'} onClick={() => setTab('hybrid')} testId="aiwb-tab-hybrid">
          <GitMerge size={14} /> Hybrid Rules
        </TabBtn>
      </div>

      {tab === 'models' && <ActiveModelsPanel />}
      {tab === 'prompts' && <PromptLibraryPanel canEdit={canEditPrompts} />}
      {tab === 'scenarios' && <LifecycleScenariosPanel />}
      {tab === 'hybrid' && <HybridRulesPanel canEdit={canEditHybrid} />}
    </div>
  );
}

function TabBtn({
  children,
  active,
  onClick,
  testId,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      data-testid={testId}
      className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? 'border-b-2 border-action text-action -mb-px'
          : 'text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

// ─── Active Models ───────────────────────────────────────────────────

function ActiveModelsPanel() {
  const qc = useQueryClient();
  const modelsQ = useQuery({
    queryKey: ['aiwb-models-deployed'],
    queryFn: () => api.aiModelsByStatus('deployed'),
  });
  const all = modelsQ.data?.items ?? [];
  const productionCount = all.filter((m) => m.status === 'production').length;
  const shadowCount = all.filter((m) => m.status === 'shadow').length;

  return (
    <Panel
      title="Active models snapshot"
      action={
        <Button
          variant="ghost"
          onClick={() => qc.invalidateQueries({ queryKey: ['aiwb-models-deployed'] })}
        >
          <RefreshCw size={14} /> Refresh
        </Button>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Total deployed" value={all.length.toString()} />
        <MetricCard label="Production" value={productionCount.toString()} tone="success" />
        <MetricCard label="Shadow" value={shadowCount.toString()} tone="warning" />
        <MetricCard
          label="Distinct types"
          value={new Set(all.map((m) => m.type)).size.toString()}
        />
      </div>

      {modelsQ.isLoading ? (
        <p className="text-sm text-muted">Loading models…</p>
      ) : all.length === 0 ? (
        <p
          className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted"
          data-testid="aiwb-models-empty"
        >
          No deployed models. Promote a model from the registry to production or shadow.
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="aiwb-models-table">
          <thead className="text-left text-xs uppercase text-muted">
            <tr className="border-b border-divider/40">
              <th className="py-2">Model</th>
              <th>Type</th>
              <th>Framework</th>
              <th>Status</th>
              <th>Version</th>
              <th>Deployed</th>
              <th>Traffic</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {all.map((m) => (
              <ModelRow key={m.model_id} m={m} />
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ModelRow({ m }: { m: AiModelRow }) {
  // Traffic split heuristic — production carries 100% by convention,
  // shadow models receive mirrored traffic for comparison but don't
  // affect operator-facing decisions. Production swap = real metric
  // from M7.x deployment manifest.
  const traffic = m.status === 'production' ? '100%' : m.status === 'shadow' ? '0% (shadow)' : '—';
  return (
    <tr
      className="border-b border-divider/40 hover:bg-divider/10"
      data-testid={`aiwb-model-row-${m.model_id}`}
    >
      <td className="py-2">
        <div className="font-medium">{m.name ?? m.model_id}</div>
        <div className="text-xs text-muted">{m.model_id}</div>
      </td>
      <td className="text-xs">{m.type}</td>
      <td className="text-xs">{m.framework ?? '—'}</td>
      <td>
        <Badge tone={STATUS_TONE[m.status] ?? 'blue'}>{m.status}</Badge>
      </td>
      <td className="text-xs font-mono">{m.version}</td>
      <td className="text-xs">{m.deployed_at ? new Date(m.deployed_at).toLocaleDateString() : '—'}</td>
      <td className="text-xs">{traffic}</td>
      <td className="text-right">
        <Link
          to={`/admin/streaming-latency?model=${encodeURIComponent(m.model_id)}`}
          className="text-action hover:underline text-xs"
          data-testid={`aiwb-model-link-${m.model_id}`}
        >
          Open <ChevronRight size={10} className="inline" />
        </Link>
      </td>
    </tr>
  );
}

// ─── Prompt Library ──────────────────────────────────────────────────

function PromptLibraryPanel({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AiPrompt | null>(null);
  const [filterCat, setFilterCat] = useState<PromptCategory | 'all'>('all');
  const [search, setSearch] = useState('');

  const promptsQ = useQuery({
    queryKey: ['aiwb-prompts', filterCat, search],
    queryFn: () =>
      api.aiPromptsList({
        category: filterCat === 'all' ? undefined : filterCat,
        q: search || undefined,
      }),
  });

  const deleteMut = useMutation({
    mutationFn: (prompt_id: string) => api.aiPromptDelete(prompt_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['aiwb-prompts'] }),
  });

  const prompts = promptsQ.data ?? [];
  const platformCount = prompts.filter((p) => p.is_platform).length;
  const tenantCount = prompts.length - platformCount;

  return (
    <Panel
      title="Prompt library"
      action={
        canEdit && (
          <Button
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
            data-testid="aiwb-prompt-new-btn"
          >
            <Plus size={14} /> New prompt
          </Button>
        )
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <MetricCard label="Total prompts" value={prompts.length.toString()} />
        <MetricCard label="Platform (read-only)" value={platformCount.toString()} />
        <MetricCard label="Tenant-custom" value={tenantCount.toString()} tone="success" />
      </div>

      <div className="flex gap-2 mb-3 text-sm">
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value as PromptCategory | 'all')}
          className="rounded border border-divider px-2 py-1"
          data-testid="aiwb-prompt-filter-category"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search prompts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 rounded border border-divider px-2 py-1"
          data-testid="aiwb-prompt-search"
        />
      </div>

      {promptsQ.isLoading ? (
        <p className="text-sm text-muted">Loading prompts…</p>
      ) : prompts.length === 0 ? (
        <p
          className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted"
          data-testid="aiwb-prompts-empty"
        >
          No prompts match these filters.
        </p>
      ) : (
        <div className="space-y-2" data-testid="aiwb-prompts-list">
          {prompts.map((p) => (
            <PromptRow
              key={p.prompt_id}
              p={p}
              canEdit={canEdit}
              onEdit={() => {
                setEditing(p);
                setShowForm(true);
              }}
              onDelete={() => {
                if (window.confirm(`Delete "${p.name}"? This cannot be undone.`)) {
                  deleteMut.mutate(p.prompt_id);
                }
              }}
            />
          ))}
        </div>
      )}

      {showForm && (
        <PromptFormModal
          editing={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['aiwb-prompts'] });
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}
    </Panel>
  );
}

function PromptRow({
  p,
  canEdit,
  onEdit,
  onDelete,
}: {
  p: AiPrompt;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded border border-divider bg-surface p-3"
      data-testid={`aiwb-prompt-row-${p.prompt_id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold">{p.name}</span>
            <Badge tone={CATEGORY_TONE[p.category]}>{p.category}</Badge>
            {p.is_platform && <Badge tone="blue">platform</Badge>}
          </div>
          {p.description && (
            <div className="text-sm text-muted mb-1">{p.description}</div>
          )}
          <div className="text-xs text-muted">
            {p.tags.length > 0 && <span>{p.tags.map((t) => `#${t}`).join(' ')} · </span>}
            {new Date(p.updated_at).toLocaleDateString()}
          </div>
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" onClick={() => setOpen((o) => !o)} data-testid={`aiwb-prompt-toggle-${p.prompt_id}`}>
            {open ? 'Hide' : 'Show'}
          </Button>
          {canEdit && !p.is_platform && (
            <>
              <Button
                variant="ghost"
                onClick={onEdit}
                data-testid={`aiwb-prompt-edit-${p.prompt_id}`}
              >
                <Pencil size={12} />
              </Button>
              <Button
                variant="ghost"
                onClick={onDelete}
                data-testid={`aiwb-prompt-delete-${p.prompt_id}`}
              >
                <Trash2 size={12} />
              </Button>
            </>
          )}
        </div>
      </div>
      {open && (
        <pre
          className="mt-3 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100 whitespace-pre-wrap"
          data-testid={`aiwb-prompt-body-${p.prompt_id}`}
        >
          {p.body}
        </pre>
      )}
    </div>
  );
}

function PromptFormModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: AiPrompt | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [category, setCategory] = useState<PromptCategory>(editing?.category ?? 'other');
  const [body, setBody] = useState(editing?.body ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [tagsText, setTagsText] = useState((editing?.tags ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: () => {
      const tags = tagsText
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const payload = {
        name: name.trim(),
        category,
        body: body.trim(),
        description: description.trim(),
        tags,
      };
      if (editing) {
        return api.aiPromptUpdate(editing.prompt_id, payload);
      }
      return api.aiPromptCreate(payload);
    },
    onSuccess: onSaved,
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setError(err.response?.data?.error?.message ?? err.message ?? 'Save failed');
    },
  });

  const armed = name.trim().length >= 3 && body.trim().length >= 3;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? 'Edit prompt' : 'New prompt'}
      data-testid="aiwb-prompt-form-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-divider bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{editing ? 'Edit prompt' : 'New prompt'}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 hover:bg-divider/40"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-muted">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. NPA root-cause analysis"
              className="w-full rounded border border-divider p-2 text-sm"
              data-testid="aiwb-prompt-form-name"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-muted">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as PromptCategory)}
              className="w-full rounded border border-divider p-2 text-sm"
              data-testid="aiwb-prompt-form-category"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-muted">
              Body (≥ 3 chars)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder='Body text — supports {{var}} placeholders that the copilot interpolates.'
              className="w-full rounded border border-divider p-2 text-sm font-mono"
              data-testid="aiwb-prompt-form-body"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-muted">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line summary"
              className="w-full rounded border border-divider p-2 text-sm"
              data-testid="aiwb-prompt-form-description"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-muted">
              Tags (comma-separated)
            </label>
            <input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="npa, investigation, monthly"
              className="w-full rounded border border-divider p-2 text-sm"
              data-testid="aiwb-prompt-form-tags"
            />
          </div>
          {error && (
            <p
              className="rounded bg-rose-50 border border-rose-200 p-2 text-sm text-rose-700"
              data-testid="aiwb-prompt-form-error"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t border-divider pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMut.mutate()}
              disabled={!armed || saveMut.isPending}
              data-testid="aiwb-prompt-form-save"
            >
              {saveMut.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create prompt'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Lifecycle Scenarios ─────────────────────────────────────────────

interface LifecycleScenario {
  id: string;
  title: string;
  trigger: string;
  outcome: string;
  refRoute?: string;
  icon: typeof Workflow;
  tone: 'blue' | 'warning' | 'danger' | 'success';
}

const SCENARIOS: LifecycleScenario[] = [
  {
    id: 'drift-retrain',
    title: 'Model drift detected',
    trigger:
      'M7.x drift monitor detects PSI > 0.2 on any feature, or KS test on model output shifts beyond config threshold.',
    outcome:
      'M5.1 retraining schedule auto-fires (cadence=drift_triggered). Job lands as in_progress; on success the model registers as a new version + auto-promotion-gate evaluates against the production champion. Manual review required when promotion would lower AUC or miss the configured precision floor.',
    icon: AlertTriangle,
    tone: 'danger',
  },
  {
    id: 'promotion-shadow',
    title: 'Promote a new model',
    trigger:
      'Data-science team uploads a new model version (status=experimental), then submits a promotion request via /v1/ai/promotions.',
    outcome:
      'Promotion request enters maker-checker (M9.3 4-eyes). On approve, model moves: experimental → staging → shadow → production. While in shadow it receives mirrored traffic without affecting operator decisions; production swap retires the previous champion atomically.',
    icon: Workflow,
    tone: 'blue',
    refRoute: '/admin/streaming-latency',
  },
  {
    id: 'retire-stale',
    title: 'Retire a stale model',
    trigger:
      'M7.x retirement-candidates report flags a model whose last_used_at exceeds the configured aging threshold AND production traffic has shifted to a newer version.',
    outcome:
      'Operator-initiated retirement transitions the model to status=retired. Retired models are excluded from /v1/ai/models?status=deployed but stay queryable for audit + reproducibility. Promotion of a retired model back to production requires a fresh validation run.',
    icon: Database,
    tone: 'warning',
  },
  {
    id: 'sla-escalate',
    title: 'SLA breach auto-escalation',
    trigger:
      'M3.1 — cms.auto_escalate_at_pct (default 80%) crossed on an OPEN/ASSIGNED/INVESTIGATING case.',
    outcome:
      'Tick worker submits an escalate transition with reason=auto_sla_breach@<pct>%. Audit chain records auto=true + trigger=sla_breach metadata. Case status flips to ESCALATED; the next maker-checker decision routes to the supervisor pool.',
    icon: Zap,
    tone: 'warning',
    refRoute: '/cms/workflow',
  },
  {
    id: 'reject-with-reason',
    title: 'Maker-checker rejection',
    trigger:
      'A checker rejects a sensitive case action (close / escalate / override_decision) submitted via M9.3 maker-checker.',
    outcome:
      'M3.2 enforces non-empty decision_notes (≥ 3 chars). Reject hits 400 EWS_400_invalid_input without it. Self-rejection by the same user is 409 EWS_409_self_approval_forbidden (RBI segregation-of-duties). Audit event chain records both maker_at + checker_at + decision_notes.',
    icon: Edit,
    tone: 'warning',
    refRoute: '/cms/workflow',
  },
  {
    id: 'scheduler-retry',
    title: 'Scheduled report retry',
    trigger:
      'M3.3 — reportJobStore.submit throws during a scheduler tick (transient or simulated failure).',
    outcome:
      'recordFailure increments retry_state.attempt + sets next_retry_at with exponential backoff (base × 2^(attempt − 1)). Subsequent ticks honour the backoff window. After reporting.scheduler_max_retries (default 3) the schedule is parked; ops sees a danger badge in /reports.',
    icon: RefreshCw,
    tone: 'warning',
    refRoute: '/reports',
  },
];

function LifecycleScenariosPanel() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="aiwb-scenarios-grid">
      {SCENARIOS.map((s) => {
        const Icon = s.icon;
        return (
          <div
            key={s.id}
            className="rounded-md border border-divider bg-surface p-4"
            data-testid={`aiwb-scenario-${s.id}`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`rounded-full p-2 ${
                  s.tone === 'danger'
                    ? 'bg-rose-50 text-rose-600'
                    : s.tone === 'warning'
                      ? 'bg-amber-50 text-amber-600'
                      : s.tone === 'success'
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-blue-50 text-blue-600'
                }`}
              >
                <Icon size={18} />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold mb-1">{s.title}</h3>
                <div className="mb-2">
                  <span className="text-xs font-semibold uppercase text-muted">Trigger</span>
                  <p className="text-sm text-ink">{s.trigger}</p>
                </div>
                <div className="mb-2">
                  <span className="text-xs font-semibold uppercase text-muted">What happens</span>
                  <p className="text-sm text-ink">{s.outcome}</p>
                </div>
                {s.refRoute && (
                  <Link
                    to={s.refRoute}
                    className="text-xs text-action hover:underline inline-flex items-center gap-1"
                  >
                    Go to surface <ChevronRight size={10} />
                  </Link>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
