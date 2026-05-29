// web/src/modules/admin/RiskScoreConfigPage.tsx
//
// Master Setup — Risk Score Configuration (MASTER SETUP spec screen #11).
//
// Per-tenant NAMED scoring factors, each with a percentage weight. The
// composite risk score weights each factor's signal, so the ENABLED factors
// of a domain must sum to 100%. The page's headline affordance is rebalancing
// weights with a LIVE "total / balanced?" indicator + a one-click Normalize
// that rescales enabled weights to exactly 100.
//
// Distinct from /scoring presets (per-indicator multipliers) and Master Setup
// reference-data tabs (flat rows, no sum constraint).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Plus,
  RefreshCw,
  Scale,
  Trash2,
  X,
} from 'lucide-react';
import { Badge, Button, Input, MetricCard, Modal, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  api,
  type ScoreFactorDomainShape,
  type ScoreFactorShape,
} from '@/lib/api';

const DOMAINS: { id: ScoreFactorDomainShape; label: string }[] = [
  { id: 'banking', label: 'Banking' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'both', label: 'Both' },
];

export function RiskScoreConfigPage() {
  const [domain, setDomain] = useState<ScoreFactorDomainShape>('banking');
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const user = useAuth((s) => s.user);
  const canEdit = user?.roles.includes('admin') ?? false;

  const factorsQ = useQuery({
    queryKey: ['rsc-factors', domain],
    queryFn: () => api.riskScoreFactors(domain),
  });
  const summaryQ = useQuery({
    queryKey: ['rsc-summary', domain],
    queryFn: () => api.riskScoreSummary(domain),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['rsc-factors', domain] });
    qc.invalidateQueries({ queryKey: ['rsc-summary', domain] });
  };

  const updateMut = useMutation({
    mutationFn: ({ factor_id, patch }: { factor_id: string; patch: Parameters<typeof api.riskScoreFactorUpdate>[1] }) =>
      api.riskScoreFactorUpdate(factor_id, patch),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: (factor_id: string) => api.riskScoreFactorDelete(factor_id),
    onSuccess: invalidate,
  });
  const reorderMut = useMutation({
    mutationFn: (ordered_ids: string[]) => api.riskScoreReorder(domain, ordered_ids),
    onSuccess: invalidate,
  });
  const normalizeMut = useMutation({
    mutationFn: () => api.riskScoreNormalize(domain),
    onSuccess: invalidate,
  });

  const factors = factorsQ.data?.factors ?? [];
  const summary = summaryQ.data;

  const move = (idx: number, dir: -1 | 1) => {
    const ids = factors.map((f) => f.factor_id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    reorderMut.mutate(ids);
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Risk Score Configuration"
        subtitle="Named scoring factors — enabled weights per domain must sum to 100%"
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setShowCreate(true)} data-testid="rsc-create-btn">
              <Plus size={14} /> Add factor
            </Button>
          ) : null
        }
      />

      {/* Domain selector */}
      <div className="flex gap-1 border-b border-divider" role="tablist" data-testid="rsc-domain-tabs">
        {DOMAINS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={domain === d.id}
            onClick={() => setDomain(d.id)}
            data-testid={`rsc-domain-${d.id}`}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              domain === d.id ? 'border-b-2 border-action text-action -mb-px' : 'text-muted hover:text-ink'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* Live weight summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Factors" value={String(summary?.factor_count ?? 0)} testId="rsc-kpi-count" />
        <MetricCard label="Enabled" value={String(summary?.enabled_count ?? 0)} testId="rsc-kpi-enabled" />
        <MetricCard
          label="Total weight"
          value={`${summary?.total_weight_pct ?? 0}%`}
          tone={summary?.balanced ? 'success' : 'warning'}
          testId="rsc-kpi-total"
        />
        <MetricCard
          label="Remainder"
          value={`${summary?.remainder_pct ?? 0}%`}
          tone={summary?.balanced ? 'success' : 'danger'}
          testId="rsc-kpi-remainder"
        />
      </div>

      <Panel
        title={`${DOMAINS.find((d) => d.id === domain)!.label} factors`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={invalidate} data-testid="rsc-refresh">
              <RefreshCw size={14} /> Refresh
            </Button>
            {canEdit && (
              <Button
                variant="ghost"
                onClick={() => normalizeMut.mutate()}
                disabled={normalizeMut.isPending || factors.filter((f) => f.enabled).length === 0}
                data-testid="rsc-normalize"
                title="Rescale enabled weights to exactly 100%"
              >
                <Scale size={14} /> Normalize to 100%
              </Button>
            )}
          </div>
        }
      >
        {/* Balanced banner */}
        {summary && (
          <div
            className={`mb-4 flex items-center gap-2 rounded border p-3 text-sm ${
              summary.balanced
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-warning/40 bg-warning/10 text-warning'
            }`}
            data-testid="rsc-balance-banner"
          >
            {summary.balanced ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            {summary.balanced ? (
              <span>Balanced — enabled weights sum to exactly 100%.</span>
            ) : (
              <span>
                Imbalanced — enabled weights total <strong>{summary.total_weight_pct}%</strong> (
                {summary.remainder_pct > 0 ? `${summary.remainder_pct}% short` : `${Math.abs(summary.remainder_pct)}% over`}).
                {canEdit && ' Use Normalize to rebalance.'}
              </span>
            )}
          </div>
        )}

        {factorsQ.isLoading ? (
          <p className="text-sm text-muted">Loading factors…</p>
        ) : factors.length === 0 ? (
          <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted" data-testid="rsc-empty">
            No factors in this domain.{canEdit && ' Click Add factor to register the first one.'}
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="rsc-table">
            <thead className="text-left text-xs uppercase text-muted">
              <tr className="border-b border-divider/40">
                <th className="py-2 w-10"></th>
                <th>Factor</th>
                <th className="w-28">Weight %</th>
                <th className="w-24">Status</th>
                {canEdit && <th className="w-24"></th>}
              </tr>
            </thead>
            <tbody>
              {factors.map((f, i) => (
                <FactorRow
                  key={f.factor_id}
                  f={f}
                  idx={i}
                  total={factors.length}
                  canEdit={canEdit}
                  onWeight={(weight_pct) => updateMut.mutate({ factor_id: f.factor_id, patch: { weight_pct } })}
                  onToggle={(enabled) => updateMut.mutate({ factor_id: f.factor_id, patch: { enabled } })}
                  onMoveUp={() => move(i, -1)}
                  onMoveDown={() => move(i, 1)}
                  onDelete={() => {
                    if (window.confirm(`Delete factor "${f.name}"? This cannot be undone.`)) {
                      deleteMut.mutate(f.factor_id);
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {showCreate && (
        <CreateFactorModal
          domain={domain}
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            setShowCreate(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function FactorRow({
  f,
  idx,
  total,
  canEdit,
  onWeight,
  onToggle,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  f: ScoreFactorShape;
  idx: number;
  total: number;
  canEdit: boolean;
  onWeight: (w: number) => void;
  onToggle: (enabled: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const [weight, setWeight] = useState(String(f.weight_pct));
  // Keep the controlled input synced when the row's weight changes server-side
  // (e.g. after Normalize). React resets the input because the row key is stable.
  const [lastServer, setLastServer] = useState(f.weight_pct);
  if (f.weight_pct !== lastServer) {
    setLastServer(f.weight_pct);
    setWeight(String(f.weight_pct));
  }

  const commitWeight = () => {
    const n = Number(weight);
    if (Number.isFinite(n) && n >= 0 && n <= 100 && n !== f.weight_pct) onWeight(n);
    else setWeight(String(f.weight_pct));
  };

  return (
    <tr className="border-b border-divider/40 hover:bg-divider/10" data-testid={`rsc-row-${f.code}`}>
      <td className="py-2">
        {canEdit && (
          <div className="flex flex-col">
            <button
              onClick={onMoveUp}
              disabled={idx === 0}
              aria-label={`Move ${f.code} up`}
              className="text-muted hover:text-ink disabled:opacity-30"
              data-testid={`rsc-up-${f.code}`}
            >
              <ArrowUp size={12} />
            </button>
            <button
              onClick={onMoveDown}
              disabled={idx === total - 1}
              aria-label={`Move ${f.code} down`}
              className="text-muted hover:text-ink disabled:opacity-30"
              data-testid={`rsc-down-${f.code}`}
            >
              <ArrowDown size={12} />
            </button>
          </div>
        )}
      </td>
      <td>
        <div className="font-medium">{f.name}</div>
        <div className="text-xs text-muted">
          <code className="rounded bg-divider/20 px-1">{f.code}</code>
          {f.description && <span> · {f.description}</span>}
        </div>
      </td>
      <td>
        {canEdit ? (
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            onBlur={commitWeight}
            className="w-20 rounded border border-divider px-2 py-1 text-sm font-mono"
            data-testid={`rsc-weight-${f.code}`}
            disabled={!f.enabled}
          />
        ) : (
          <span className="font-mono">{f.weight_pct}%</span>
        )}
      </td>
      <td>
        {canEdit ? (
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={f.enabled}
              onChange={(e) => onToggle(e.target.checked)}
              data-testid={`rsc-enabled-${f.code}`}
            />
            {f.enabled ? 'Enabled' : 'Disabled'}
          </label>
        ) : (
          <Badge tone={f.enabled ? 'success' : 'neutral'}>{f.enabled ? 'enabled' : 'disabled'}</Badge>
        )}
      </td>
      {canEdit && (
        <td className="text-right">
          <Button variant="ghost" onClick={onDelete} aria-label={`Delete ${f.code}`} data-testid={`rsc-delete-${f.code}`}>
            <Trash2 size={12} />
          </Button>
        </td>
      )}
    </tr>
  );
}

function CreateFactorModal({
  domain,
  onClose,
  onSuccess,
}: {
  domain: ScoreFactorDomainShape;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [weight, setWeight] = useState('10');
  const [err, setErr] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () =>
      api.riskScoreFactorCreate({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim() || null,
        domain,
        weight_pct: Number(weight),
      }),
    onSuccess,
    onError: (e: unknown) => {
      const x = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setErr(x.response?.data?.error?.message ?? x.message ?? 'Create failed');
    },
  });

  const armed = code.trim().length >= 2 && name.trim().length >= 1 && Number.isFinite(Number(weight));

  return (
    <Modal open onClose={onClose} ariaLabel="Add risk score factor" size="lg" testId="rsc-create-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add factor — {domain}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </header>
        {err && (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger" data-testid="rsc-create-error">
            <AlertTriangle size={14} className="inline mr-1" /> {err}
          </div>
        )}
        <Input label="Code (uppercase A-Z 0-9 _)" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. COLLATERAL" data-testid="rsc-create-code" />
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" data-testid="rsc-create-name" />
        <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="rsc-create-desc" />
        <Input label="Weight %" type="number" value={weight} onChange={(e) => setWeight(e.target.value)} data-testid="rsc-create-weight" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => m.mutate()} disabled={!armed || m.isPending} data-testid="rsc-create-submit">
            {m.isPending ? 'Creating…' : 'Create factor'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
