// web/src/modules/ai/governance/AiPredictionAuditPage.tsx
//
// AI Governance → Prediction Audit Logs.
//
// Filter-driven prediction history across every model. Backs the
// "show me every model decision for this customer / model / type"
// compliance query. Each row deep-links into the existing
// Explainability page (/ai/workbench/explainability?prediction_id=…)
// for the SHAP + trust-signal drill-down.
//
// Reuses api.aiPredictions wrapper over BFF GET /v1/ai/predictions
// (newest-first, tenant-scoped, paginated). Zero new BFF route.

import { Navigate, Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListChecks, ArrowRight, Filter } from 'lucide-react';
import { Badge, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, type PredictionRow } from '@/lib/api';

const TYPES = ['', 'pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'] as const;

function bandTone(band: PredictionRow['band']): 'success' | 'warning' | 'danger' | 'neutral' {
  if (band === 'high') return 'danger';
  if (band === 'medium') return 'warning';
  if (band === 'low') return 'success';
  return 'neutral';
}

export function AiPredictionAuditPage() {
  const me = useAuth((s) => s.user);
  const [customer, setCustomer] = useState('');
  const [model, setModel] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  const q = useQuery({
    queryKey: ['ai-prediction-audit', customer, model, type, since, until, page],
    queryFn: () =>
      api.aiPredictions({
        customer_id: customer || undefined,
        model_id: model || undefined,
        prediction_type: type || undefined,
        since: since || undefined,
        until: until || undefined,
        page,
        page_size: pageSize,
      }),
    placeholderData: (prev) => prev,
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div data-testid="ai-prediction-audit-page">
      <PageHeader
        title="Prediction Audit Logs"
        subtitle="Every model decision across the platform — drill into per-prediction explanation + trust signals."
      />

      <Panel className="mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="ai-prediction-filters">
          <label className="block">
            <span className="text-xs text-muted">Customer ID</span>
            <Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="e.g. c-101" data-testid="ai-prediction-customer" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Model ID</span>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. pd-xgb-v3" data-testid="ai-prediction-model" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Prediction type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
              className="input"
              data-testid="ai-prediction-type"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>{t || '(any)'}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Since (ISO)</span>
            <Input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} data-testid="ai-prediction-since" />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Until (ISO)</span>
            <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} data-testid="ai-prediction-until" />
          </label>
          <div className="flex items-end">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setCustomer('');
                setModel('');
                setType('');
                setSince('');
                setUntil('');
                setPage(1);
              }}
              data-testid="ai-prediction-reset"
            >
              <Filter size={14} className="mr-1" /> Reset
            </Button>
          </div>
        </div>
      </Panel>

      <Panel
        title={`${total.toLocaleString()} prediction${total === 1 ? '' : 's'} — page ${page} / ${totalPages}`}
      >
        {q.isLoading ? (
          <p className="text-sm text-muted">Loading predictions…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-2">
            <ListChecks size={14} /> No predictions match the current filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]" data-testid="ai-prediction-table">
              <thead className="text-[11px] uppercase tracking-wide text-muted border-b border-divider">
                <tr>
                  <th className="text-left py-2 px-2">Generated</th>
                  <th className="text-left py-2 px-2">Customer</th>
                  <th className="text-left py-2 px-2">Model</th>
                  <th className="text-left py-2 px-2">Type</th>
                  <th className="text-right py-2 px-2">Value</th>
                  <th className="text-left py-2 px-2">Band</th>
                  <th className="text-right py-2 px-2">Confidence</th>
                  <th className="text-left py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr
                    key={p.prediction_id}
                    className="border-b border-divider/60 hover:bg-aurora-tint/30"
                    data-testid={`ai-prediction-row-${p.prediction_id}`}
                  >
                    <td className="py-1.5 px-2 text-muted tabular-nums">{new Date(p.generated_at).toISOString().slice(0, 19).replace('T', ' ')}</td>
                    <td className="py-1.5 px-2">
                      <Link to={`/customers/${encodeURIComponent(p.customer_id)}`} className="text-action hover:underline">
                        {p.customer_id}
                      </Link>
                    </td>
                    <td className="py-1.5 px-2 text-ink">{p.model_id}<span className="text-muted text-[10.5px] ml-1">v{p.model_version}</span></td>
                    <td className="py-1.5 px-2 text-ink">{p.prediction_type}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{p.value.toFixed(3)}</td>
                    <td className="py-1.5 px-2"><Badge tone={bandTone(p.band)}>{p.band ?? '—'}</Badge></td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{p.confidence !== null ? `${(p.confidence * 100).toFixed(1)}%` : '—'}</td>
                    <td className="py-1.5 px-2">
                      <Link
                        to={`/ai/workbench/explainability?prediction_id=${encodeURIComponent(p.prediction_id)}`}
                        className="inline-flex items-center gap-1 text-action hover:underline text-[11px]"
                        data-testid={`ai-prediction-drill-${p.prediction_id}`}
                      >
                        Explain <ArrowRight size={11} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between mt-3 text-[11px] text-muted" data-testid="ai-prediction-pager">
              <span>{items.length} of {total.toLocaleString()} rows on page {page}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} data-testid="ai-prediction-prev">Prev</Button>
                <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} data-testid="ai-prediction-next">Next</Button>
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
