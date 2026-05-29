// web/src/modules/banking/BranchHeatmapPage.tsx
//
// Branch / Geography Risk heatmap (§2.1.8) — portfolio stress by BRANCH and
// by REGION with a dimension toggle, click-for-summary + deep-dive modal
// (12-month NPA trend + top at-risk customers + sector mix). Distinct from
// Sector Watch (industry pivot) — this is the geographic / org-unit view.
// Reuses Panel/MetricCard/Badge/Button/PageHeader + the established
// banking-page architecture; MSW-backed in dev.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  api,
  type BranchHeatmapReport,
  type BranchSummary,
  type BranchDeepDiveReport,
  type BranchHeatLevel,
  type BranchHeatmapDimension,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const formatKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

const HEAT_COLOUR: Record<BranchHeatLevel, string> = {
  critical: 'border-danger bg-danger/15 text-danger',
  high: 'border-warning bg-warning/15 text-warning',
  medium: 'border-action/40 bg-action/5 text-action',
  low: 'border-success/40 bg-success/10 text-success',
};
const HEAT_TONE: Record<BranchHeatLevel, 'danger' | 'warning' | 'blue' | 'success'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'blue',
  low: 'success',
};

export function BranchHeatmapPage() {
  const [params, setParams] = useSearchParams();
  const dimension = (params.get('dimension') as BranchHeatmapDimension | null) ?? 'branch';
  const [selected, setSelected] = useState<string | null>(null);
  const [showDeepDive, setShowDeepDive] = useState(false);

  const { data, isLoading } = useQuery<BranchHeatmapReport>({
    queryKey: ['branches.heatmap', dimension],
    queryFn: () => api.branchHeatmap(dimension),
  });

  const setDimension = (d: BranchHeatmapDimension) => {
    const next = new URLSearchParams(params);
    next.set('dimension', d);
    setParams(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Branch & Geography Risk"
        subtitle="Portfolio stress by branch and by region. Toggle the dimension; click a tile for the summary, then open deep-dive for the 12-month NPA trend, top at-risk customers, and sector mix."
      />

      {/* Dimension toggle */}
      <div className="flex items-center gap-2" data-testid="bh-dimension-toggle">
        <span className="text-xs font-medium uppercase text-ink-subtle">View by:</span>
        {(['branch', 'region'] as BranchHeatmapDimension[]).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={dimension === d}
            onClick={() => setDimension(d)}
            data-testid={`bh-dim-${d}`}
            className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition ${
              dimension === d ? 'border-action bg-action/10 text-action' : 'border-divider text-ink-subtle hover:text-ink'
            }`}
          >
            {d}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label={dimension === 'branch' ? 'Total branches' : 'Total regions'} value={data?.total_cells.toString() ?? '—'} testId="bh-kpi-total" />
        <MetricCard label="Critical heat" value={(data?.by_heat_level.critical ?? 0).toString()} tone="danger" testId="bh-kpi-critical" />
        <MetricCard label="High heat" value={(data?.by_heat_level.high ?? 0).toString()} tone="warning" testId="bh-kpi-high" />
        <MetricCard label="Low heat" value={(data?.by_heat_level.low ?? 0).toString()} tone="success" testId="bh-kpi-low" />
      </div>

      <Panel
        title={dimension === 'branch' ? 'Branch heatmap' : 'Region heatmap'}
        action={data ? <span className="text-xs text-ink-subtle">Generated {new Date(data.generated_at).toLocaleString()}</span> : null}
      >
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="bh-grid">
            {data?.cells.map((cell) => (
              <button
                key={cell.id}
                data-testid={`bh-cell-${cell.id}`}
                onClick={() => {
                  // Region cells have no deep-dive (rollup); only branch cells open one.
                  if (cell.branch_count == null) setSelected(cell.id);
                }}
                disabled={cell.branch_count != null}
                className={`rounded-lg border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-action ${
                  cell.branch_count == null ? 'hover:scale-[1.02] cursor-pointer' : 'cursor-default'
                } ${HEAT_COLOUR[cell.heat_level] ?? 'border-divider bg-surface'}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{cell.label}</h3>
                  <Badge tone={HEAT_TONE[cell.heat_level]}>{cell.heat_level.toUpperCase()}</Badge>
                </div>
                <div className="mt-1 text-xs opacity-70">
                  {cell.city ? `${cell.city} · ${cell.region}` : `${cell.branch_count} branches`}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-xs uppercase opacity-70">NPA Ratio</div>
                    <div className="text-xl font-bold tabular-nums">{cell.npa_ratio_pct.toFixed(2)}%</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase opacity-70">30d Δ</div>
                    <div className="text-xl font-bold tabular-nums">
                      {cell.delta_30d_pct >= 0 ? '+' : ''}
                      {cell.delta_30d_pct.toFixed(1)}%
                    </div>
                  </div>
                </div>
                <div className="mt-3 border-t border-current/30 pt-2 text-xs opacity-80">
                  {cell.total_customers} customers · {formatKES(cell.total_outstanding_kes)}
                </div>
              </button>
            ))}
          </div>
        )}
      </Panel>

      {selected && !showDeepDive && (
        <BranchDetailModal branch_id={selected} onClose={() => setSelected(null)} onOpenDeepDive={() => setShowDeepDive(true)} />
      )}
      {selected && showDeepDive && (
        <BranchDeepDiveModal
          branch_id={selected}
          onClose={() => {
            setShowDeepDive(false);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function BranchDetailModal({
  branch_id,
  onClose,
  onOpenDeepDive,
}: {
  branch_id: string;
  onClose: () => void;
  onOpenDeepDive: () => void;
}) {
  const { data, isLoading } = useQuery<BranchSummary>({
    queryKey: ['branch.detail', branch_id],
    queryFn: () => api.branchSummary(branch_id),
  });
  return (
    <ModalShell title={`Branch: ${data?.label ?? branch_id}`} onClose={onClose} testId="bh-detail-modal">
      {isLoading || !data ? (
        <p className="text-sm text-ink-subtle">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge tone={HEAT_TONE[data.heat_level]}>{data.heat_level.toUpperCase()}</Badge>
            <span className="text-xs text-ink-subtle">{data.city} · {data.region}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="NPA Ratio" value={`${data.npa_ratio_pct.toFixed(2)}%`} />
            <MetricCard label="30d Δ" value={`${data.delta_30d_pct >= 0 ? '+' : ''}${data.delta_30d_pct.toFixed(1)}%`} />
            <MetricCard label="Customers" value={data.total_customers.toString()} />
            <MetricCard label="Outstanding" value={formatKES(data.total_outstanding_kes)} />
          </div>
          <div className="border-t border-divider pt-4">
            <Button onClick={onOpenDeepDive} data-testid="bh-open-deep-dive">
              Open deep-dive →
            </Button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function BranchDeepDiveModal({ branch_id, onClose }: { branch_id: string; onClose: () => void }) {
  const { data, isLoading } = useQuery<BranchDeepDiveReport>({
    queryKey: ['branch.deep-dive', branch_id],
    queryFn: () => api.branchDeepDive(branch_id),
  });
  return (
    <ModalShell title={`Deep-dive: ${data?.branch_name ?? branch_id}`} onClose={onClose} testId="bh-deep-dive-modal" width="wide">
      {isLoading || !data ? (
        <p className="text-sm text-ink-subtle">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="NPA Ratio" value={`${data.npa_ratio_pct.toFixed(2)}%`} />
            <MetricCard label="Heat" value={data.heat_level.toUpperCase()} tone={HEAT_TONE[data.heat_level]} />
            <MetricCard label="Customers" value={data.total_customers.toString()} />
            <MetricCard label="Outstanding" value={formatKES(data.total_outstanding_kes)} />
          </div>

          <Panel title="NPA trend (12 months)" action={<span className="text-xs text-ink-subtle">Monthly NPA % anchored to current</span>}>
            <div className="h-64" data-testid="bh-npa-trend-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.npa_trend_12m}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} unit="%" />
                  <Tooltip formatter={(v: number) => [`${v.toFixed(2)}%`, 'NPA']} contentStyle={{ background: 'rgb(15 23 42)', border: 'none', borderRadius: 6 }} />
                  <Line type="monotone" dataKey="npa_pct" stroke="rgb(59 130 246)" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Top at-risk customers">
            <table className="min-w-full text-sm" data-testid="bh-top-customers">
              <thead className="text-left text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-3">Customer</th>
                  <th className="pb-2 pr-3">ID</th>
                  <th className="pb-2 pr-3 text-right">PD</th>
                  <th className="pb-2 pr-3 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {data.top_at_risk_customers.map((c) => (
                  <tr key={c.customer_id} className="border-t border-divider">
                    <td className="py-2 pr-3 font-medium">{c.name}</td>
                    <td className="py-2 pr-3">
                      <Link to={`/customers/${encodeURIComponent(c.customer_id)}`} className="text-action hover:underline">
                        {c.customer_id}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{(c.pd * 100).toFixed(1)}%</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatKES(c.outstanding_kes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Sector mix (within branch)">
            <table className="min-w-full text-sm" data-testid="bh-sector-mix">
              <thead className="text-left text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-3">Sector</th>
                  <th className="pb-2 pr-3 text-right">Customers</th>
                  <th className="pb-2 pr-3 text-right">NPA Ratio</th>
                </tr>
              </thead>
              <tbody>
                {data.sector_mix.map((s) => (
                  <tr key={s.sector} className="border-t border-divider">
                    <td className="py-2 pr-3 font-medium">{s.sector.replace(/_/g, ' ')}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.customers}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.npa_ratio_pct.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
  testId,
  width = 'normal',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  testId?: string;
  width?: 'normal' | 'wide';
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      onClick={onClose}
    >
      <div
        className={`w-full ${width === 'wide' ? 'max-w-5xl' : 'max-w-2xl'} rounded-lg border border-divider bg-surface p-6 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-ink-subtle hover:bg-divider/40 hover:text-ink" aria-label="Close" data-testid="modal-close">
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
