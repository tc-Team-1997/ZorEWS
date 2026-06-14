// web/src/modules/banking/SmaClassificationPage.tsx
//
// Module 2.4 — SMA Classification.
//
// 6 BFF endpoints back this screen (5 already shipped pre-M2.4 + 1 new):
//   GET  /v1/banking/sma/movements?date=&framework=    (pre-existing)
//   GET  /v1/banking/sma/drill?from=&to=&framework=    (pre-existing)
//   GET  /v1/banking/sma/sector-view?framework=        (pre-existing)
//   GET  /v1/banking/sma/trend?customer_id=&framework= (pre-existing)
//   POST /v1/banking/sma/run-classification?framework= (pre-existing; M2.4 extended with ?customer_count=)
//   GET  /v1/banking/sma/framework?framework=          (M2.4 new — framework introspection)

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import {
  Activity,
  Building2,
  ChevronRight,
  Globe,
  Play,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type {
  FrameworkCatalogShape,
  Framework,
  SmaMovementsReport,
  SmaDrillShape,
  SmaSectorViewShape,
  SmaTrendShape,
  SmaRunResultShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildSmaClassificationReportData } from './smaClassificationReportAdapter';
import { color } from '@/styles/tokens';

const fmtKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

const CATEGORY_TONE: Record<string, BadgeTone> = {
  'SMA-0': 'warning',
  'SMA-1': 'warning',
  'SMA-2': 'danger',
  NPA: 'danger',
  CURRENT: 'success',
};

const CATEGORY_COLOR: Record<string, string> = {
  'SMA-0': color.warning ?? '#f59e0b',
  'SMA-1': color.warning ?? '#f59e0b',
  'SMA-2': color.danger ?? '#dc2626',
  NPA: color.danger ?? '#dc2626',
};

export function SmaClassificationPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [framework, setFramework] = useState<Framework>('RBI');
  const [drillOpen, setDrillOpen] = useState<{ from: string; to: string } | null>(null);
  const [sectorOpen, setSectorOpen] = useState(false);
  const [trendCustomer, setTrendCustomer] = useState<string | null>(null);
  const [runReceipt, setRunReceipt] = useState<SmaRunResultShape | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const frameworkQ = useQuery({
    queryKey: ['sma-framework', framework],
    queryFn: () => api.smaFramework(framework) as Promise<FrameworkCatalogShape>,
    staleTime: 5 * 60_000,
  });

  const movementsQ = useQuery({
    queryKey: ['sma-movements', framework],
    queryFn: () => api.smaMovements({ framework }) as Promise<SmaMovementsReport>,
  });

  const runMut = useMutation({
    mutationFn: () => api.smaRunClassification({ framework }),
    onSuccess: (r) => {
      setRunReceipt(r);
      setRunError(null);
      qc.invalidateQueries({ queryKey: ['sma-movements'] });
    },
    onError: (e: Error) => setRunError(e.message || 'classification failed'),
  });

  const body = movementsQ.data;
  const def = frameworkQ.data?.active_definition;
  const chartData = body
    ? Object.entries(body.by_category_count).map(([category, count]) => ({ category, count }))
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="SMA Classification"
        subtitle="Special Mention Account classification per regulator. Drill today's movements, view by sector, trend per borrower, or trigger re-classification."
        actions={
          /* Enterprise export (P2) — RBAC-gated; renders null without
             reports:export. Reports today's SMA movement rows + the movement
             KPI strip for the active framework. */
          <ExportButton
            module="sma_classification"
            reportType="risk"
            adapter={(config) =>
              buildSmaClassificationReportData(
                {
                  framework,
                  date: body?.date ?? '—',
                  summary: {
                    total_movements: body?.total_movements ?? 0,
                    deteriorations: body?.deteriorations ?? 0,
                    improvements: body?.improvements ?? 0,
                    total_exposure_at_risk_kes: body?.total_exposure_at_risk_kes ?? 0,
                  },
                  movements: body?.movements ?? [],
                  meta: { tenant_id: 'BANK_DEMO', generated_by: me?.username ?? 'operator', role: me?.roles?.[0] ?? 'admin' },
                },
                config,
              )
            }
          />
        }
      />

      {/* Framework banner */}
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3" data-testid="sma-framework-banner">
          <div className="flex items-center gap-3">
            <Globe className="h-5 w-5 text-action" />
            <div>
              <div className="text-sm font-medium" data-testid="sma-active-framework">
                Active framework: <b>{def?.code ?? framework}</b> — {def?.regulator ?? '…'} ({def?.country ?? '…'})
              </div>
              <div className="text-xs text-ink-subtle">
                {def
                  ? `SMA-0 1-${def.sma1_min - 1}d · SMA-1 ${def.sma1_min}-${def.sma2_min - 1}d · SMA-2 ${def.sma2_min}-${def.npa_min - 1}d · NPA ≥ ${def.npa_min}d`
                  : '…'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ink-subtle">Switch:</label>
            <select
              data-testid="sma-framework-select"
              className="h-9 rounded border border-divider bg-surface px-2 text-sm"
              value={framework}
              onChange={(e) => setFramework(e.target.value as Framework)}
            >
              {(frameworkQ.data?.frameworks ?? []).map((f) => (
                <option key={f.code} value={f.code}>
                  {f.code} — {f.country}
                </option>
              ))}
              {!frameworkQ.data && (
                <>
                  <option value="RBI">RBI — India</option>
                  <option value="RMA">RMA — Bhutan</option>
                  <option value="CBK">CBK — Kenya</option>
                </>
              )}
            </select>
            <Button
              variant="primary"
              disabled={runMut.isPending}
              onClick={() => runMut.mutate()}
              data-testid="sma-run-classification"
            >
              <Play className="h-4 w-4 mr-2" />
              {runMut.isPending ? 'Running…' : 'Run classification'}
            </Button>
          </div>
        </div>
        {runError && (
          <div className="mt-2 text-sm text-danger" data-testid="sma-run-error">{runError}</div>
        )}
        {runReceipt && (
          <div className="mt-2 rounded bg-success/10 text-success border border-success/30 p-2 text-sm" data-testid="sma-run-receipt">
            Re-classified <b>{runReceipt.customers_evaluated.toLocaleString()}</b> accounts ·{' '}
            <b>{runReceipt.customers_changed}</b> changed bucket · {runReceipt.duration_ms} ms ·{' '}
            run id <span className="font-mono">{runReceipt.run_id}</span>
          </div>
        )}
      </Panel>

      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetricCard testId="sma-kpi-total" label="Total movements today" value={body?.total_movements ?? 0} />
        <MetricCard testId="sma-kpi-det" label="Deteriorations" value={body?.deteriorations ?? 0} tone="danger" />
        <MetricCard testId="sma-kpi-imp" label="Improvements" value={body?.improvements ?? 0} tone="success" />
        <MetricCard
          testId="sma-kpi-exposure"
          label="Exposure at risk"
          value={body ? fmtKES(body.total_exposure_at_risk_kes) : '—'}
        />
      </div>

      {/* Category-mix chart + actions */}
      <Panel
        title={`Category mix — as of ${body?.date ?? '—'} (${framework})`}
        action={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              data-testid="sma-open-sector"
              onClick={() => setSectorOpen(true)}
            >
              <Building2 className="h-4 w-4 mr-2" /> Sector view
            </Button>
            <Button
              variant="ghost"
              data-testid="sma-open-drill"
              onClick={() => {
                const until = new Date();
                const from = new Date(until.getTime() - 7 * 86_400_000);
                setDrillOpen({ from: from.toISOString().slice(0, 10), to: until.toISOString().slice(0, 10) });
              }}
            >
              <Activity className="h-4 w-4 mr-2" /> Drill last 7 days
            </Button>
          </div>
        }
      >
        {movementsQ.isLoading ? (
          <div className="text-sm text-ink-subtle">Loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <XAxis dataKey="category" stroke={color.ink} fontSize={12} />
              <YAxis stroke={color.ink} fontSize={12} />
              <Tooltip />
              <Bar dataKey="count">
                {chartData.map((d, i) => (
                  <Cell key={i} fill={CATEGORY_COLOR[d.category] ?? color.blue} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>

      {/* SMA Movement — Today table */}
      <Panel title={`SMA Movement — Today (${body?.movements.length ?? 0})`}>
        {body && body.movements.length > 0 ? (
          <div className="overflow-x-auto" data-testid="sma-movements-table">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="text-left px-3 py-2">Customer</th>
                  <th className="text-left px-3 py-2">Sector</th>
                  <th className="text-left px-3 py-2">From → To</th>
                  <th className="text-right px-3 py-2">DPD</th>
                  <th className="text-right px-3 py-2">Outstanding</th>
                  <th className="text-left px-3 py-2">Trend</th>
                </tr>
              </thead>
              <tbody>
                {body.movements.slice(0, 50).map((m, idx) => (
                  <tr key={`${m.customer_id}-${idx}`} className="border-t border-divider hover:bg-action/5">
                    <td className="px-3 py-2">
                      <div className="font-medium">{m.customer_name}</div>
                      <div className="text-xs text-ink-subtle font-mono">{m.customer_id}</div>
                    </td>
                    <td className="px-3 py-2 text-ink-subtle">{m.sector}</td>
                    <td className="px-3 py-2">
                      <Badge tone={CATEGORY_TONE[m.from_category] ?? 'success'}>{m.from_category}</Badge>
                      <ChevronRight className="inline h-3 w-3 mx-1 text-ink-subtle" />
                      <Badge tone={CATEGORY_TONE[m.to_category] ?? 'warning'}>{m.to_category}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.dpd}d</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtKES(m.outstanding_kes)}</td>
                    <td className="px-3 py-2">
                      <button
                        data-testid={`sma-trend-${m.customer_id}`}
                        className="text-xs text-action hover:underline"
                        onClick={() => setTrendCustomer(m.customer_id)}
                      >
                        View 30d trend
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-ink-subtle">No movements observed today.</p>
        )}
      </Panel>

      {drillOpen && (
        <DrillModal
          from={drillOpen.from}
          to={drillOpen.to}
          framework={framework}
          onClose={() => setDrillOpen(null)}
        />
      )}

      {sectorOpen && (
        <SectorModal framework={framework} onClose={() => setSectorOpen(false)} />
      )}

      {trendCustomer && (
        <TrendModal
          customer_id={trendCustomer}
          framework={framework}
          onClose={() => setTrendCustomer(null)}
        />
      )}
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────

function DrillModal({
  from,
  to,
  framework,
  onClose,
}: {
  from: string;
  to: string;
  framework: Framework;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ['sma-drill', from, to, framework],
    queryFn: () => api.smaDrill({ from, to, framework }) as Promise<SmaDrillShape>,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto" data-testid="sma-drill-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">SMA Drill Movements — {from} → {to}</h3>
            <div className="text-xs text-ink-subtle">{framework} · {q.data?.total ?? 0} rows</div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="sma-drill-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-3">
          {q.isLoading ? (
            <div className="text-sm text-ink-subtle">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="text-left px-2 py-1.5">Date</th>
                  <th className="text-left px-2 py-1.5">Customer</th>
                  <th className="text-left px-2 py-1.5">From → To</th>
                  <th className="text-right px-2 py-1.5">DPD</th>
                  <th className="text-left px-2 py-1.5">Reason</th>
                </tr>
              </thead>
              <tbody>
                {(q.data?.rows ?? []).slice(0, 200).map((r, i) => (
                  <tr key={i} className="border-t border-divider">
                    <td className="px-2 py-1 text-xs">{new Date(r.movement_at).toLocaleDateString()}</td>
                    <td className="px-2 py-1">
                      <div className="font-medium">{r.customer_name}</div>
                      <div className="text-xs text-ink-subtle font-mono">{r.customer_id}</div>
                    </td>
                    <td className="px-2 py-1">
                      <Badge tone={CATEGORY_TONE[r.from_category] ?? 'success'}>{r.from_category}</Badge>
                      <ChevronRight className="inline h-3 w-3 mx-1" />
                      <Badge tone={CATEGORY_TONE[r.to_category] ?? 'warning'}>{r.to_category}</Badge>
                    </td>
                    <td className="px-2 py-1 text-right">{r.dpd}d</td>
                    <td className="px-2 py-1 text-xs text-ink-subtle">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function SectorModal({ framework, onClose }: { framework: Framework; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['sma-sector', framework],
    queryFn: () => api.smaSectorView(framework) as Promise<SmaSectorViewShape>,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" data-testid="sma-sector-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">SMA Sector View ({framework})</h3>
            <div className="text-xs text-ink-subtle">
              {q.data?.total_sectors ?? 0} sectors · total outstanding{' '}
              {q.data ? fmtKES(q.data.total_outstanding_kes) : '—'}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="sma-sector-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-3">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-ink-subtle">
              <tr>
                <th className="text-left px-2 py-1.5">Sector</th>
                <th className="text-right px-2 py-1.5">Customers</th>
                <th className="text-right px-2 py-1.5">SMA-0</th>
                <th className="text-right px-2 py-1.5">SMA-1</th>
                <th className="text-right px-2 py-1.5">SMA-2</th>
                <th className="text-right px-2 py-1.5">NPA</th>
                <th className="text-right px-2 py-1.5">NPA %</th>
                <th className="text-left px-2 py-1.5">Worst</th>
              </tr>
            </thead>
            <tbody>
              {(q.data?.sectors ?? []).map((s) => (
                <tr key={s.sector} className="border-t border-divider">
                  <td className="px-2 py-1.5">{s.sector}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{s.total_customers}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{s.by_category['SMA-0']}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{s.by_category['SMA-1']}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{s.by_category['SMA-2']}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-danger">{s.by_category.NPA}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{s.npa_ratio_pct.toFixed(1)}%</td>
                  <td className="px-2 py-1.5">
                    <Badge tone={CATEGORY_TONE[s.worst_category] ?? 'success'}>{s.worst_category}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TrendModal({
  customer_id,
  framework,
  onClose,
}: {
  customer_id: string;
  framework: Framework;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ['sma-trend', customer_id, framework],
    queryFn: () => api.smaTrend(customer_id, { framework }) as Promise<SmaTrendShape>,
  });
  const points = q.data?.series ?? [];
  const maxDpd = Math.max(1, ...points.map((p) => p.dpd));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" data-testid="sma-trend-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">SMA Trend — {customer_id} ({framework})</h3>
            <div className="text-xs text-ink-subtle">
              {points[0]?.date ?? '—'} → {points[points.length - 1]?.date ?? '—'} · {points.length} days · trend{' '}
              <b>{q.data?.trend_direction ?? '—'}</b>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="sma-trend-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-3">
          <div className="rounded border border-divider p-3" data-testid="sma-trend-chart">
            <div className="text-xs text-ink-subtle mb-2">DPD trail (bar height = days past due, colour = SMA bucket)</div>
            <div className="flex items-end gap-0.5 h-24">
              {points.map((p, i) => {
                const h = Math.max(2, (p.dpd / maxDpd) * 100);
                const c =
                  p.category === 'NPA' ? color.danger ?? '#dc2626' : p.category === 'SMA-2' ? color.danger ?? '#dc2626' : p.category === 'SMA-1' ? color.warning ?? '#f59e0b' : color.success ?? '#16a34a';
                return (
                  <div
                    key={i}
                    className="flex-1 rounded-t"
                    style={{ height: `${h}%`, backgroundColor: c }}
                    title={`${p.date}: DPD ${p.dpd} (${p.category})`}
                  />
                );
              })}
            </div>
            <div className="mt-2 flex justify-between text-xs text-ink-subtle font-mono">
              <span>{points[0]?.date ?? '—'}</span>
              <span>{points[points.length - 1]?.date ?? '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SmaClassificationPage;
