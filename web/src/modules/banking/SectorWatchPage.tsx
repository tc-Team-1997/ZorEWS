// web/src/modules/banking/SectorWatchPage.tsx
//
// Sector Watch heatmap (M2.7 SW-4) — heatmap + click-for-summary + deep-dive
// modal (NPA 12m trend + top at-risk customers + contributing rules) + watchlist
// add/remove. Reuses existing api wrappers + Panel/MetricCard/PageHeader/Badge.

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Star, StarOff, X } from 'lucide-react';
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
  type SectorHeatmapReport,
  type SectorSummary,
  type SectorDeepDiveReport,
  type SectorHeatLevel,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildSectorWatchReportData } from './sectorWatchReportAdapter';

const formatKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

const HEAT_COLOUR: Record<SectorHeatLevel, string> = {
  critical: 'border-danger bg-danger/15 text-danger',
  high: 'border-warning bg-warning/15 text-warning',
  medium: 'border-action/40 bg-action/5 text-action',
  low: 'border-success/40 bg-success/10 text-success',
};

const HEAT_TONE: Record<SectorHeatLevel, 'danger' | 'warning' | 'blue' | 'success'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'blue',
  low: 'success',
};

export function SectorWatchPage() {
  const me = useAuth((s) => s.user);
  const [selected, setSelected] = useState<string | null>(null);
  const [showDeepDive, setShowDeepDive] = useState(false);

  const { data: body, isLoading } = useQuery<SectorHeatmapReport>({
    queryKey: ['sectors.heatmap'],
    queryFn: () => api.sectorHeatmap(),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sector Watch"
        subtitle="Portfolio concentration × stress heatmap. Click a tile for sector summary; open deep-dive for 12-month trend, top at-risk customers, and contributing rules."
        actions={
          /* Enterprise export (P2) — RBAC-gated; renders null without
             reports:export. Reports the sector heatmap cells + the heat-level
             KPI strip. */
          <ExportButton
            module="sector_watch"
            reportType="portfolio"
            adapter={(config) =>
              buildSectorWatchReportData(
                {
                  summary: {
                    total_sectors: body?.total_sectors ?? 0,
                    by_heat_level: body?.by_heat_level ?? {},
                  },
                  cells: body?.cells ?? [],
                  meta: { tenant_id: 'BANK_DEMO', generated_by: me?.username ?? 'operator', role: me?.roles?.[0] ?? 'admin' },
                },
                config,
              )
            }
          />
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label="Total sectors" value={body?.total_sectors.toString() ?? '—'} />
        <MetricCard label="Critical heat" value={(body?.by_heat_level.critical ?? 0).toString()} tone="danger" />
        <MetricCard label="High heat" value={(body?.by_heat_level.high ?? 0).toString()} tone="warning" />
        <MetricCard label="Low heat" value={(body?.by_heat_level.low ?? 0).toString()} tone="success" />
      </div>

      <Panel
        title="Sector heatmap"
        action={
          body ? (
            <span className="text-xs text-ink-subtle">Generated {new Date(body.generated_at).toLocaleString()}</span>
          ) : null
        }
      >
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {body?.cells.map((cell) => (
              <button
                key={cell.sector}
                data-testid={`sector-${cell.sector}`}
                onClick={() => setSelected(cell.sector)}
                className={`rounded-lg border p-4 text-left transition hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-action ${
                  HEAT_COLOUR[cell.heat_level] ?? 'border-divider bg-surface'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{cell.sector.replace(/_/g, ' ')}</h3>
                  {cell.is_watchlisted && <Star className="size-4 fill-current" aria-label="Watchlisted" />}
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
        <SectorDetailModal
          sector_id={selected}
          onClose={() => setSelected(null)}
          onOpenDeepDive={() => setShowDeepDive(true)}
        />
      )}
      {selected && showDeepDive && (
        <SectorDeepDiveModal
          sector_id={selected}
          onClose={() => {
            setShowDeepDive(false);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function SectorDetailModal({
  sector_id,
  onClose,
  onOpenDeepDive,
}: {
  sector_id: string;
  onClose: () => void;
  onOpenDeepDive: () => void;
}) {
  const qc = useQueryClient();
  const { data: summary, isLoading } = useQuery<SectorSummary>({
    queryKey: ['sector.detail', sector_id],
    queryFn: () => api.sectorDetail(sector_id),
  });

  const addMut = useMutation({
    mutationFn: () => api.sectorWatchlistAdd(sector_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sectors.heatmap'] });
      qc.invalidateQueries({ queryKey: ['sector.detail', sector_id] });
    },
  });
  const removeMut = useMutation({
    mutationFn: () => api.sectorWatchlistRemove(sector_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sectors.heatmap'] });
      qc.invalidateQueries({ queryKey: ['sector.detail', sector_id] });
    },
  });

  return (
    <ModalShell title={`Sector: ${sector_id.replace(/_/g, ' ')}`} onClose={onClose} testId="sector-detail-modal">
      {isLoading || !summary ? (
        <p className="text-sm text-ink-subtle">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge tone={HEAT_TONE[summary.heat_level]}>{summary.heat_level.toUpperCase()}</Badge>
            {summary.is_watchlisted && <Badge tone="warning">Watchlisted</Badge>}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="NPA Ratio" value={`${summary.npa_ratio_pct.toFixed(2)}%`} />
            <MetricCard
              label="30d Δ"
              value={`${summary.delta_30d_pct >= 0 ? '+' : ''}${summary.delta_30d_pct.toFixed(1)}%`}
            />
            <MetricCard label="Customers" value={summary.total_customers.toString()} />
            <MetricCard label="Outstanding" value={formatKES(summary.total_outstanding_kes)} />
          </div>
          <div className="flex flex-wrap gap-2 border-t border-divider pt-4">
            {summary.is_watchlisted ? (
              <Button
                variant="ghost"
                onClick={() => removeMut.mutate()}
                disabled={removeMut.isPending}
                data-testid="sector-watchlist-remove"
              >
                <StarOff className="mr-1 size-4" />
                Remove from watchlist
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => addMut.mutate()}
                disabled={addMut.isPending}
                data-testid="sector-watchlist-add"
              >
                <Star className="mr-1 size-4" />
                Add to watchlist
              </Button>
            )}
            <Button onClick={onOpenDeepDive} data-testid="sector-open-deep-dive">
              Open deep-dive →
            </Button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function SectorDeepDiveModal({ sector_id, onClose }: { sector_id: string; onClose: () => void }) {
  const { data, isLoading } = useQuery<SectorDeepDiveReport>({
    queryKey: ['sector.deep-dive', sector_id],
    queryFn: () => api.sectorDeepDive(sector_id),
  });

  return (
    <ModalShell
      title={`Deep-dive: ${sector_id.replace(/_/g, ' ')}`}
      onClose={onClose}
      testId="sector-deep-dive-modal"
      width="wide"
    >
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

          <Panel
            title="NPA trend (12 months)"
            action={<span className="text-xs text-ink-subtle">Monthly NPA % anchored to current</span>}
          >
            <div className="h-64" data-testid="sector-npa-trend-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.npa_trend_12m}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.2)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} unit="%" />
                  <Tooltip
                    formatter={(v: number) => [`${v.toFixed(2)}%`, 'NPA']}
                    contentStyle={{ background: 'rgb(15 23 42)', border: 'none', borderRadius: 6 }}
                  />
                  <Line type="monotone" dataKey="npa_pct" stroke="rgb(59 130 246)" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Top at-risk customers">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm" data-testid="sector-top-customers">
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
                      <td className="py-2 pr-3 text-ink-subtle">{c.customer_id}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{(c.pd * 100).toFixed(1)}%</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatKES(c.outstanding_kes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Contributing rules (30 days)">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm" data-testid="sector-contributing-rules">
                <thead className="text-left text-xs uppercase text-ink-subtle">
                  <tr>
                    <th className="pb-2 pr-3">Rule</th>
                    <th className="pb-2 pr-3">ID</th>
                    <th className="pb-2 pr-3 text-right">Firings (30d)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contributing_rules.map((r) => (
                    <tr key={r.rule_id} className="border-t border-divider">
                      <td className="py-2 pr-3 font-medium">{r.rule_name}</td>
                      <td className="py-2 pr-3 text-ink-subtle">{r.rule_id}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.firings_30d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-subtle hover:bg-divider/40 hover:text-ink"
            aria-label="Close"
            data-testid="modal-close"
          >
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
