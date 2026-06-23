// web/src/modules/ai/ExperimentTrackingPage.tsx
//
// AI Workbench — T7 Module 10: Experiment Tracking.
//
// The pre-deployment ML R&D ledger: every experiment run (dataset, params,
// evaluation metrics, outcome, owner) that feeds the M7.2 model-promotion
// decision. Sits alongside the existing Workbench / Model Registry /
// Explainability pages in the ai-workbench nav category. Backed by
// /v1/ai/experiments/*; MSW-backed in dev. Enterprise + data-dense — a
// governance ledger, not a marketing dashboard.

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  api,
  type ExperimentListShape,
  type ExperimentSummaryShape,
  type ExperimentShape,
  type ExperimentStatusShape,
  type ExperimentDomainShape,
  type ExperimentModelTypeShape,
  type ExperimentOutcomeShape,
} from '@/lib/api';
import { Badge, Button, Input, Modal, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';

const MODEL_TYPES: ExperimentModelTypeShape[] = ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'];
const DOMAINS: ExperimentDomainShape[] = ['banking', 'insurance'];
const STATUSES: ExperimentStatusShape[] = ['running', 'completed', 'failed', 'archived'];
const OUTCOMES: ExperimentOutcomeShape[] = ['promoted', 'rejected', 'inconclusive'];

// Legal next-states (mirror of the BFF state machine).
const NEXT: Record<ExperimentStatusShape, ExperimentStatusShape[]> = {
  running: ['completed', 'failed'],
  completed: ['archived'],
  failed: ['archived'],
  archived: [],
};

const STATUS_TONE: Record<ExperimentStatusShape, BadgeTone> = {
  running: 'blue',
  completed: 'success',
  failed: 'danger',
  archived: 'neutral',
};
const OUTCOME_TONE: Record<ExperimentOutcomeShape, BadgeTone> = {
  promoted: 'success',
  rejected: 'danger',
  inconclusive: 'warning',
};

const fmtAuc = (m: Record<string, number>) => (typeof m.auc === 'number' ? m.auc.toFixed(3) : '—');

export function ExperimentTrackingPage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const canMutate = user?.roles.some((r) => ['admin', 'supervisor', 'risk_analyst'].includes(r)) ?? false;

  const [params, setParams] = useSearchParams();
  const domain = (params.get('domain') ?? '') as ExperimentDomainShape | '';
  const status = (params.get('status') ?? '') as ExperimentStatusShape | '';

  const [selected, setSelected] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const setFilter = (key: 'domain' | 'status', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const { data: summary } = useQuery<ExperimentSummaryShape>({
    queryKey: ['aiexp.summary'],
    queryFn: () => api.aiExperimentSummary(),
  });
  const { data: list } = useQuery<ExperimentListShape>({
    queryKey: ['aiexp.list', domain, status],
    queryFn: () => api.aiExperiments({ domain: domain || undefined, status: status || undefined }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Experiment Tracking"
        subtitle="Pre-deployment ML experiment ledger — dataset, parameters, evaluation metrics, outcome, owner. Feeds the model-promotion decision."
        actions={
          canMutate ? (
            <Button onClick={() => setShowCreate(true)} data-testid="exp-log-btn">
              <Plus className="mr-1 size-4" />
              Log experiment
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <MetricCard label="Total runs" value={summary?.total.toString() ?? '—'} tone="blue" testId="exp-kpi-total" />
        <MetricCard label="Running" value={summary?.by_status.running.toString() ?? '—'} tone="warning" testId="exp-kpi-running" />
        <MetricCard label="Completed" value={summary?.by_status.completed.toString() ?? '—'} tone="success" testId="exp-kpi-completed" />
        <MetricCard label="Pending outcome" value={summary?.pending_outcome_count.toString() ?? '—'} tone="warning" testId="exp-kpi-pending" />
        <MetricCard label="Best AUC" value={summary?.best_auc ? summary.best_auc.auc.toFixed(3) : '—'} tone="blue" testId="exp-kpi-best-auc" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1" data-testid="exp-filter-domain">
          <span className="mr-1 text-xs uppercase text-ink-subtle">Domain</span>
          <FilterChip label="All" active={domain === ''} onClick={() => setFilter('domain', '')} testId="exp-filter-domain-all" />
          {DOMAINS.map((d) => (
            <FilterChip key={d} label={d} active={domain === d} onClick={() => setFilter('domain', d)} testId={`exp-filter-domain-${d}`} />
          ))}
        </div>
        <div className="flex items-center gap-1" data-testid="exp-filter-status">
          <span className="mr-1 text-xs uppercase text-ink-subtle">Status</span>
          <FilterChip label="All" active={status === ''} onClick={() => setFilter('status', '')} testId="exp-filter-status-all" />
          {STATUSES.map((s) => (
            <FilterChip key={s} label={s} active={status === s} onClick={() => setFilter('status', s)} testId={`exp-filter-status-${s}`} />
          ))}
        </div>
      </div>

      <Panel title="Experiment runs" action={list ? <span className="text-xs text-ink-subtle">{list.total} total</span> : null}>
        {!list || list.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-subtle" data-testid="exp-empty">
            No experiments match the filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="exp-table">
              <thead className="text-left text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-3">Experiment</th>
                  <th className="pb-2 pr-3">Domain · Model</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3 text-right">AUC</th>
                  <th className="pb-2 pr-3">Owner</th>
                  <th className="pb-2 pr-3">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((e) => (
                  <tr
                    key={e.experiment_id}
                    data-testid={`exp-row-${e.experiment_id}`}
                    className="cursor-pointer border-t border-divider align-top hover:bg-action/5"
                    onClick={() => setSelected(e.experiment_id)}
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">{e.name}</div>
                      <div className="font-mono text-[10px] text-ink-subtle">{e.dataset_ref} · {e.dataset_rows.toLocaleString()} rows</div>
                    </td>
                    <td className="py-2 pr-3 text-xs">{e.domain} · {e.model_type}</td>
                    <td className="py-2 pr-3"><Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge></td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtAuc(e.metrics)}</td>
                    <td className="py-2 pr-3 text-xs">{e.owner}</td>
                    <td className="py-2 pr-3">{e.outcome ? <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome}</Badge> : <span className="text-xs text-ink-subtle">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {showCreate && (
        <CreateExperimentModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['aiexp.list'] });
            qc.invalidateQueries({ queryKey: ['aiexp.summary'] });
            setShowCreate(false);
          }}
        />
      )}
      {selected && (
        <ExperimentDetailModal
          experiment_id={selected}
          canMutate={canMutate}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick, testId }: { label: string; active: boolean; onClick: () => void; testId: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs capitalize transition ${active ? 'bg-action text-white' : 'border border-divider text-ink-subtle hover:border-action hover:text-action'}`}
    >
      {label}
    </button>
  );
}

function CreateExperimentModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState<ExperimentDomainShape>('banking');
  const [modelType, setModelType] = useState<ExperimentModelTypeShape>('pd');
  const [datasetRef, setDatasetRef] = useState('mart.customer_360@2026-Q1');
  const [datasetRows, setDatasetRows] = useState('10000');
  const [owner, setOwner] = useState('');
  const [auc, setAuc] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api.aiExperimentCreate({
        name: name.trim(),
        domain,
        model_type: modelType,
        dataset_ref: datasetRef.trim(),
        dataset_rows: Number.isFinite(parseInt(datasetRows, 10)) ? parseInt(datasetRows, 10) : 0,
        owner: owner.trim() || undefined,
        metrics: auc.trim() && Number.isFinite(parseFloat(auc)) ? { auc: parseFloat(auc) } : undefined,
      }),
    onSuccess: onCreated,
  });

  return (
    <Modal open onClose={onClose} ariaLabel="Log experiment run" testId="exp-create-modal">
      <h2 className="mb-4 text-lg font-semibold">Log experiment run</h2>
      <div className="space-y-3">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="XGBoost PD v4 sweep" data-testid="exp-c-name" /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Domain">
            <select value={domain} onChange={(e) => setDomain(e.target.value as ExperimentDomainShape)} data-testid="exp-c-domain" className="w-full rounded border border-divider bg-surface px-2 py-1.5 text-sm">
              {DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Model type">
            <select value={modelType} onChange={(e) => setModelType(e.target.value as ExperimentModelTypeShape)} data-testid="exp-c-model_type" className="w-full rounded border border-divider bg-surface px-2 py-1.5 text-sm">
              {MODEL_TYPES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Dataset ref"><Input value={datasetRef} onChange={(e) => setDatasetRef(e.target.value)} data-testid="exp-c-dataset_ref" /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="Rows"><Input value={datasetRows} onChange={(e) => setDatasetRows(e.target.value)} data-testid="exp-c-dataset_rows" /></Field>
          <Field label="Owner"><Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="dsci.alice" data-testid="exp-c-owner" /></Field>
          <Field label="AUC (opt)"><Input value={auc} onChange={(e) => setAuc(e.target.value)} placeholder="0.842" data-testid="exp-c-auc" /></Field>
        </div>
        {mut.isError && <p className="text-sm text-danger" data-testid="exp-c-error">Could not log experiment — check the inputs.</p>}
        <div className="flex justify-end gap-2 border-t border-divider pt-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !name.trim() || !datasetRef.trim()} data-testid="exp-c-submit">Log run</Button>
        </div>
      </div>
    </Modal>
  );
}

function ExperimentDetailModal({ experiment_id, canMutate, onClose }: { experiment_id: string; canMutate: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<ExperimentOutcomeShape>('promoted');
  const { data, isLoading } = useQuery<ExperimentShape>({
    queryKey: ['aiexp.get', experiment_id],
    queryFn: () => api.aiExperimentGet(experiment_id),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['aiexp.get', experiment_id] });
    qc.invalidateQueries({ queryKey: ['aiexp.list'] });
    qc.invalidateQueries({ queryKey: ['aiexp.summary'] });
  };
  const statusMut = useMutation({ mutationFn: (s: ExperimentStatusShape) => api.aiExperimentSetStatus(experiment_id, s), onSuccess: invalidate });
  const outcomeMut = useMutation({ mutationFn: () => api.aiExperimentSetOutcome(experiment_id, outcome), onSuccess: invalidate });

  return (
    <Modal open onClose={onClose} ariaLabel={data ? `Experiment ${data.name}` : 'Experiment'} size="3xl" testId="exp-detail-modal">
      <h2 className="mb-4 text-lg font-semibold">{data ? `Experiment — ${data.name}` : 'Experiment'}</h2>
      {isLoading || !data ? (
        <p className="text-sm text-ink-subtle">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[data.status]}>{data.status}</Badge>
            {data.outcome && <Badge tone={OUTCOME_TONE[data.outcome]}>{data.outcome}</Badge>}
            <span className="text-xs text-ink-subtle">{data.domain} · {data.model_type} · {data.dataset_ref} · {data.dataset_rows.toLocaleString()} rows · {data.owner}</span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Panel title="Parameters">
              {Object.keys(data.params).length === 0 ? (
                <p className="text-sm text-ink-subtle">No parameters recorded.</p>
              ) : (
                <dl className="space-y-1 text-sm" data-testid="exp-params">
                  {Object.entries(data.params).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3"><dt className="text-ink-subtle">{k}</dt><dd className="font-mono">{String(v)}</dd></div>
                  ))}
                </dl>
              )}
            </Panel>
            <Panel title="Evaluation metrics">
              {Object.keys(data.metrics).length === 0 ? (
                <p className="text-sm text-ink-subtle">No metrics recorded.</p>
              ) : (
                <dl className="space-y-1 text-sm" data-testid="exp-metrics">
                  {Object.entries(data.metrics).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3"><dt className="text-ink-subtle">{k}</dt><dd className="font-mono tabular-nums">{v}</dd></div>
                  ))}
                </dl>
              )}
            </Panel>
          </div>

          {canMutate && (
            <div className="rounded-lg border border-divider p-4" data-testid="exp-lifecycle">
              <div className="mb-2 text-xs font-semibold uppercase text-ink-subtle">Lifecycle</div>
              <div className="flex flex-wrap items-center gap-2">
                {NEXT[data.status].map((s) => (
                  <Button key={s} variant="ghost" onClick={() => statusMut.mutate(s)} disabled={statusMut.isPending} data-testid={`exp-to-${s}`}>
                    Mark {s}
                  </Button>
                ))}
                {(data.status === 'completed' || data.status === 'archived') && (
                  <div className="flex items-center gap-2">
                    <select value={outcome} onChange={(e) => setOutcome(e.target.value as ExperimentOutcomeShape)} data-testid="exp-outcome-select" className="rounded border border-divider bg-surface px-2 py-1 text-sm">
                      {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                    <Button onClick={() => outcomeMut.mutate()} disabled={outcomeMut.isPending} data-testid="exp-set-outcome">Record outcome</Button>
                  </div>
                )}
                {NEXT[data.status].length === 0 && data.outcome && (
                  <span className="text-xs text-ink-subtle">Archived + judged — no further actions.</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-ink-subtle">{label}</span>
      {children}
    </label>
  );
}
