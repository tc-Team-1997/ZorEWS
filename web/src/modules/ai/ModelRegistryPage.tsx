// web/src/modules/ai/ModelRegistryPage.tsx
//
// Module 4.2 — Model Registry.
//
// Operator surface for the full lifecycle of AI models per spec:
//   - Active Models table (every status, not just deployed) — filterable
//     by type + status; columns reflect M4.2 acceptance (status badge,
//     AUC, training-rows, version, framework).
//   - Register modal — POST /v1/ai/models. Status defaults to
//     experimental; the spec's "production requires gate + maker-checker"
//     rule is enforced by the backend (status=production is rejected).
//   - Edit modal — PUT /v1/ai/models/:id. Status is intentionally
//     read-only; promotion happens through /promotion-gate/auto-promote
//     + /v1/ai/promotions (see AiWorkbenchPage + future M4.3).
//   - Retire — DELETE /v1/ai/models/:id. Production retires require
//     force=true (the form surfaces an explicit checkbox + warning).
//
// This page is COMPLEMENTARY to /ai/workbench — workbench is the
// daily "what's deployed and how are prompts working" view; this page
// is the governance + lifecycle surface.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { Badge, Button, Input, MetricCard, Modal, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, type AiModelRow } from '@/lib/api';

const MODEL_TYPES = ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'] as const;
const FRAMEWORKS = ['xgboost', 'sklearn', 'torch', 'lightgbm', 'isolation_forest'] as const;
const CREATE_STATUSES = ['experimental', 'staging', 'shadow'] as const;

const STATUS_TONE: Record<string, 'success' | 'warning' | 'blue' | 'danger'> = {
  production: 'success',
  shadow: 'warning',
  staging: 'blue',
  experimental: 'blue',
  retired: 'danger',
};

export function ModelRegistryPage() {
  const user = useAuth((s) => s.user);
  const canMutate = user?.roles.some((r) => r === 'admin') ?? false;

  const [typeFilter, setTypeFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showRegister, setShowRegister] = useState(false);
  const [editTarget, setEditTarget] = useState<AiModelRow | null>(null);
  const [retireTarget, setRetireTarget] = useState<AiModelRow | null>(null);

  const qc = useQueryClient();
  const modelsQ = useQuery({
    queryKey: ['mr-models', typeFilter, statusFilter],
    queryFn: () =>
      api.aiModelsByStatus(statusFilter || undefined, typeFilter || undefined),
  });
  const items = modelsQ.data?.items ?? [];

  const summary = useMemo(() => {
    const byStatus = new Map<string, number>();
    for (const m of items) byStatus.set(m.status, (byStatus.get(m.status) ?? 0) + 1);
    return {
      total: items.length,
      production: byStatus.get('production') ?? 0,
      staging: byStatus.get('staging') ?? 0,
      retired: byStatus.get('retired') ?? 0,
    };
  }, [items]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Model Registry"
        subtitle="Lifecycle: register → version → promote (with approval) → retrain → retire"
        actions={
          canMutate ? (
            <Button
              variant="primary"
              onClick={() => setShowRegister(true)}
              data-testid="mr-register-btn"
            >
              <Plus size={14} /> Register model
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Total" value={summary.total.toString()} testId="mr-kpi-total" />
        <MetricCard
          label="Production"
          value={summary.production.toString()}
          tone="success"
          testId="mr-kpi-prod"
        />
        <MetricCard label="Staging" value={summary.staging.toString()} tone="blue" />
        <MetricCard
          label="Retired"
          value={summary.retired.toString()}
          tone="danger"
          testId="mr-kpi-retired"
        />
      </div>

      <Panel
        title="Active models"
        action={
          <Button
            variant="ghost"
            onClick={() => qc.invalidateQueries({ queryKey: ['mr-models'] })}
            data-testid="mr-refresh"
          >
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <label className="text-xs text-muted">
            Type
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="ml-2 rounded border border-divider px-2 py-1 text-sm"
              data-testid="mr-filter-type"
            >
              <option value="">All</option>
              {MODEL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Status
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="ml-2 rounded border border-divider px-2 py-1 text-sm"
              data-testid="mr-filter-status"
            >
              <option value="">All</option>
              <option value="production">production</option>
              <option value="shadow">shadow</option>
              <option value="staging">staging</option>
              <option value="experimental">experimental</option>
              <option value="retired">retired</option>
              <option value="deployed">deployed (prod + shadow)</option>
            </select>
          </label>
        </div>

        {modelsQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p
            className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted"
            data-testid="mr-table-empty"
          >
            No models match the current filter. {canMutate && 'Click Register model to add one.'}
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="mr-table">
            <thead className="text-left text-xs uppercase text-muted">
              <tr className="border-b border-divider/40">
                <th className="py-2">Model</th>
                <th>Type</th>
                <th>Status</th>
                <th>Framework</th>
                <th>Version</th>
                <th>AUC</th>
                <th>Trained</th>
                {canMutate && <th></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr
                  key={m.model_id}
                  className="border-b border-divider/40 hover:bg-divider/10"
                  data-testid={`mr-row-${m.model_id}`}
                >
                  <td className="py-2">
                    <div className="font-medium">{m.name ?? m.model_id}</div>
                    <div className="text-xs text-muted font-mono">{m.model_id}</div>
                  </td>
                  <td className="text-xs">{m.type}</td>
                  <td>
                    <Badge tone={STATUS_TONE[m.status] ?? 'blue'}>{m.status}</Badge>
                  </td>
                  <td className="text-xs">{m.framework ?? '—'}</td>
                  <td className="text-xs font-mono">{m.version}</td>
                  <td className="text-xs">{m.metrics?.auc?.toFixed(3) ?? '—'}</td>
                  <td className="text-xs">
                    {m.trained_at ? new Date(m.trained_at).toLocaleDateString() : '—'}
                  </td>
                  {canMutate && (
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          onClick={() => setEditTarget(m)}
                          data-testid={`mr-edit-${m.model_id}`}
                          aria-label={`Edit ${m.model_id}`}
                        >
                          <Pencil size={12} />
                        </Button>
                        {m.status !== 'retired' && (
                          <Button
                            variant="ghost"
                            onClick={() => setRetireTarget(m)}
                            data-testid={`mr-retire-${m.model_id}`}
                            aria-label={`Retire ${m.model_id}`}
                          >
                            <Trash2 size={12} />
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Promotion governance">
        <div className="text-sm text-muted space-y-2">
          <p>
            <strong>Status mutation:</strong> direct status patches via this page are forbidden.
            Promotion from <code className="text-action">staging</code> to{' '}
            <code className="text-action">production</code> requires the metric gate to pass AND
            a human approver (4-eyes maker-checker). Drive promotions from the{' '}
            <a href="/ai/workbench" className="text-action hover:underline">
              AI Workbench
            </a>{' '}
            or the M7.2 promotion-request flow.
          </p>
          <p>
            <strong>Retirement:</strong> production models cannot be retired without an explicit{' '}
            <code className="text-action">force=true</code> flag — the prompt below requires you
            to acknowledge that a successor model is already serving traffic.
          </p>
        </div>
      </Panel>

      {showRegister && (
        <RegisterModal
          onClose={() => setShowRegister(false)}
          onSuccess={() => {
            setShowRegister(false);
            qc.invalidateQueries({ queryKey: ['mr-models'] });
          }}
        />
      )}
      {editTarget && (
        <EditModal
          model={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => {
            setEditTarget(null);
            qc.invalidateQueries({ queryKey: ['mr-models'] });
          }}
        />
      )}
      {retireTarget && (
        <RetireModal
          model={retireTarget}
          onClose={() => setRetireTarget(null)}
          onSuccess={() => {
            setRetireTarget(null);
            qc.invalidateQueries({ queryKey: ['mr-models'] });
          }}
        />
      )}
    </div>
  );
}

function RegisterModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [model_id, setModelId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof MODEL_TYPES)[number]>('pd');
  const [version, setVersion] = useState('0.1.0');
  const [framework, setFramework] = useState<(typeof FRAMEWORKS)[number]>('xgboost');
  const [status, setStatus] = useState<(typeof CREATE_STATUSES)[number]>('experimental');
  const [aucStr, setAucStr] = useState('');
  const [trainingRowsStr, setTrainingRowsStr] = useState('');
  const [keyFeaturesStr, setKeyFeaturesStr] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => {
      const auc = aucStr.trim() === '' ? undefined : Number(aucStr);
      const training_rows = trainingRowsStr.trim() === '' ? undefined : Number(trainingRowsStr);
      const key_features = keyFeaturesStr
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return api.aiModelCreate({
        model_id: model_id.trim(),
        name: name.trim(),
        type,
        version: version.trim(),
        framework,
        status,
        key_features: key_features.length > 0 ? key_features : undefined,
        metrics:
          auc !== undefined || training_rows !== undefined
            ? {
                ...(auc !== undefined ? { auc } : {}),
                ...(training_rows !== undefined ? { training_rows } : {}),
              }
            : undefined,
      });
    },
    onSuccess,
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: { message?: string } } } };
      setErrorMsg(e.response?.data?.error?.message ?? 'Register failed');
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel="Register new model"
      size="lg"
      testId="mr-register-modal"
    >
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Register a new model</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </header>
        <p className="text-xs text-muted">
          Models register at <code>experimental</code>, <code>staging</code>, or{' '}
          <code>shadow</code>. Production promotion requires the metric gate + human approval.
        </p>
        {errorMsg && (
          <div
            className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
            data-testid="mr-register-error"
          >
            <AlertTriangle size={14} className="inline mr-1" /> {errorMsg}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Model ID"
            value={model_id}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="pd_v3_2026q2"
            data-testid="mr-register-id"
          />
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="PD challenger Q2"
            data-testid="mr-register-name"
          />
          <label className="text-xs text-muted">
            Type
            <select
              value={type}
              onChange={(e) => setType(e.target.value as (typeof MODEL_TYPES)[number])}
              className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm"
              data-testid="mr-register-type"
            >
              {MODEL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Framework
            <select
              value={framework}
              onChange={(e) => setFramework(e.target.value as (typeof FRAMEWORKS)[number])}
              className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm"
              data-testid="mr-register-framework"
            >
              {FRAMEWORKS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="Version (semver)"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="0.1.0"
            data-testid="mr-register-version"
          />
          <label className="text-xs text-muted">
            Initial status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as (typeof CREATE_STATUSES)[number])}
              className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm"
              data-testid="mr-register-status"
            >
              {CREATE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="AUC (optional)"
            value={aucStr}
            onChange={(e) => setAucStr(e.target.value)}
            placeholder="0.82"
            data-testid="mr-register-auc"
          />
          <Input
            label="Training rows (optional)"
            value={trainingRowsStr}
            onChange={(e) => setTrainingRowsStr(e.target.value)}
            placeholder="5000"
            data-testid="mr-register-rows"
          />
        </div>
        <Input
          label="Key features (comma-separated)"
          value={keyFeaturesStr}
          onChange={(e) => setKeyFeaturesStr(e.target.value)}
          placeholder="dpd_30, limit_util_p95, …"
          data-testid="mr-register-features"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => m.mutate()}
            disabled={m.isPending || !model_id.trim() || !name.trim()}
            data-testid="mr-register-submit"
          >
            {m.isPending ? 'Registering…' : 'Register'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EditModal({
  model,
  onClose,
  onSuccess,
}: {
  model: AiModelRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(model.name ?? '');
  const [description, setDescription] = useState('');
  const [trainingWindowStr, setTrainingWindowStr] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {};
      if (name.trim() && name !== model.name) patch.name = name.trim();
      if (description.trim()) patch.description = description.trim();
      if (trainingWindowStr.trim()) {
        const n = Number(trainingWindowStr);
        if (Number.isFinite(n)) patch.training_data_window_days = n;
      }
      return api.aiModelUpdate(model.model_id, patch);
    },
    onSuccess,
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: { message?: string } } } };
      setErrorMsg(e.response?.data?.error?.message ?? 'Update failed');
    },
  });

  return (
    <Modal open onClose={onClose} ariaLabel={`Edit ${model.model_id}`} size="md" testId="mr-edit-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Edit {model.model_id}</h2>
            <p className="text-xs text-muted">
              Status <Badge tone={STATUS_TONE[model.status] ?? 'blue'}>{model.status}</Badge> — promote via the gate, not here.
            </p>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </header>
        {errorMsg && (
          <div
            className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
            data-testid="mr-edit-error"
          >
            <AlertTriangle size={14} className="inline mr-1" /> {errorMsg}
          </div>
        )}
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="mr-edit-name"
        />
        <label className="block text-xs text-muted">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm"
            data-testid="mr-edit-description"
          />
        </label>
        <Input
          label="Training data window (days)"
          value={trainingWindowStr}
          onChange={(e) => setTrainingWindowStr(e.target.value)}
          placeholder="e.g. 365"
          data-testid="mr-edit-window"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => m.mutate()}
            disabled={m.isPending}
            data-testid="mr-edit-submit"
          >
            {m.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RetireModal({
  model,
  onClose,
  onSuccess,
}: {
  model: AiModelRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isProd = model.status === 'production';
  const [force, setForce] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => api.aiModelDelete(model.model_id, isProd ? force : false),
    onSuccess,
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { error?: { message?: string } } } };
      setErrorMsg(e.response?.data?.error?.message ?? 'Retire failed');
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={`Retire ${model.model_id}`}
      size="md"
      testId="mr-retire-modal"
    >
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Retire {model.model_id}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </header>
        <p className="text-sm">
          This soft-deletes the model — status flips to <Badge tone="danger">retired</Badge> and
          predictions against it will be refused with HTTP 409.
        </p>
        {errorMsg && (
          <div
            className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
            data-testid="mr-retire-error"
          >
            <AlertTriangle size={14} className="inline mr-1" /> {errorMsg}
          </div>
        )}
        {isProd && (
          <label className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="mt-0.5"
              data-testid="mr-retire-force"
            />
            <span>
              <strong>Production model.</strong> I confirm a successor is already serving
              traffic, and that retiring this model will not blank-out scoring. Without this
              checkbox the API will refuse with{' '}
              <code>EWS_409_protected_production_retire</code>.
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => m.mutate()}
            disabled={m.isPending || (isProd && !force)}
            data-testid="mr-retire-submit"
          >
            {m.isPending ? 'Retiring…' : 'Retire model'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
