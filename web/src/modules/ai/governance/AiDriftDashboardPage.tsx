// web/src/modules/ai/governance/AiDriftDashboardPage.tsx
//
// AI Governance → Drift Monitoring Dashboard.
//
// Fleet-wide drift rollup over api.aiDriftFleet(). Distinct from the
// existing /ai/drift (DriftMonitoringPage) which is the per-model deep-
// dive — this page is the watchlist + click-through.
//
// Per-row: highest PSI, KS prediction drift, performance-drift verdict,
// click → per-model history. KPI strip: red / amber / green counts +
// distribution chart.

import { Navigate, Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { Activity, ArrowRight, AlertTriangle } from 'lucide-react';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api } from '@/lib/api';

type DriftVerdict = 'green' | 'amber' | 'red';

interface DriftFleetRow {
  model_id: string;
  highest_psi?: number | null;
  ks_pred?: number | null;
  verdict?: DriftVerdict | null;
  last_evaluated_at?: string | null;
}
interface DriftFleetShape {
  items?: DriftFleetRow[];
}

const VERDICT_TONE: Record<DriftVerdict, 'success' | 'warning' | 'danger'> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
};

const VERDICT_COLOR: Record<DriftVerdict, string> = {
  green: '#10B981',
  amber: '#F59E0B',
  red: '#EF4444',
};

export function AiDriftDashboardPage() {
  const me = useAuth((s) => s.user);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  const fleetQ = useQuery({
    queryKey: ['ai-drift-fleet'],
    queryFn: () => api.aiDriftFleet() as Promise<DriftFleetShape>,
    staleTime: 60_000,
  });

  const rows = useMemo(() => fleetQ.data?.items ?? [], [fleetQ.data]);

  const totals = useMemo(() => {
    const t = { green: 0, amber: 0, red: 0, unknown: 0 };
    for (const r of rows) {
      const v = r.verdict ?? null;
      if (v === 'green') t.green += 1;
      else if (v === 'amber') t.amber += 1;
      else if (v === 'red') t.red += 1;
      else t.unknown += 1;
    }
    return t;
  }, [rows]);

  const sorted = useMemo(() => {
    const ORDER: Record<DriftVerdict | 'unknown', number> = { red: 0, amber: 1, green: 2, unknown: 3 };
    return [...rows].sort((a, b) => {
      const va = (a.verdict ?? 'unknown') as DriftVerdict | 'unknown';
      const vb = (b.verdict ?? 'unknown') as DriftVerdict | 'unknown';
      return ORDER[va] - ORDER[vb] || (b.highest_psi ?? 0) - (a.highest_psi ?? 0);
    });
  }, [rows]);

  const distribution = [
    { name: 'green', count: totals.green, fill: VERDICT_COLOR.green },
    { name: 'amber', count: totals.amber, fill: VERDICT_COLOR.amber },
    { name: 'red', count: totals.red, fill: VERDICT_COLOR.red },
  ];

  return (
    <div data-testid="ai-drift-dashboard-page">
      <PageHeader
        title="Drift Monitoring Dashboard"
        subtitle="Fleet drift rollup — highest PSI per model + verdict watchlist. Click a row for the per-model deep-dive at /ai/drift."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4" data-testid="ai-drift-kpis">
        <MetricCard label="Red (action required)" value={totals.red.toString()} tone={totals.red > 0 ? 'danger' : 'neutral'} testId="ai-drift-kpi-red" />
        <MetricCard label="Amber (watch)" value={totals.amber.toString()} tone={totals.amber > 0 ? 'warning' : 'neutral'} testId="ai-drift-kpi-amber" />
        <MetricCard label="Green (healthy)" value={totals.green.toString()} testId="ai-drift-kpi-green" />
        <MetricCard label="Unevaluated" value={totals.unknown.toString()} testId="ai-drift-kpi-unknown" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
        <Panel title="Verdict distribution" className="xl:col-span-1">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={distribution} margin={{ top: 8, right: 12, bottom: 8, left: 12 }}>
              <CartesianGrid stroke="#E4E7F2" strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="count">
                {distribution.map((d) => (
                  <Cell key={d.name} fill={d.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Worst offenders (top 5)" className="xl:col-span-2">
          {sorted.length === 0 ? (
            <p className="text-sm text-muted">No drift data yet — run recompute from the per-model page.</p>
          ) : (
            <ul className="text-[12px] divide-y divide-divider" data-testid="ai-drift-worst-list">
              {sorted.slice(0, 5).map((r) => (
                <li key={r.model_id} className="py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {r.verdict === 'red' && <AlertTriangle size={13} className="text-danger" />}
                    <span className="font-medium text-ink">{r.model_id}</span>
                    {r.verdict && <Badge tone={VERDICT_TONE[r.verdict]}>{r.verdict}</Badge>}
                  </div>
                  <div className="text-muted tabular-nums">
                    PSI {r.highest_psi !== null && r.highest_psi !== undefined ? r.highest_psi.toFixed(3) : '—'} ·
                    {' '}KS {r.ks_pred !== null && r.ks_pred !== undefined ? r.ks_pred.toFixed(3) : '—'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Full fleet">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-2"><Activity size={14} /> No models evaluated.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]" data-testid="ai-drift-table">
              <thead className="text-[11px] uppercase tracking-wide text-muted border-b border-divider">
                <tr>
                  <th className="text-left py-2 px-2">Model</th>
                  <th className="text-left py-2 px-2">Verdict</th>
                  <th className="text-right py-2 px-2">Highest PSI</th>
                  <th className="text-right py-2 px-2">KS pred drift</th>
                  <th className="text-left py-2 px-2">Last evaluated</th>
                  <th className="text-left py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.model_id} className="border-b border-divider/60 hover:bg-aurora-tint/30" data-testid={`ai-drift-row-${r.model_id}`}>
                    <td className="py-1.5 px-2 font-medium text-ink">{r.model_id}</td>
                    <td className="py-1.5 px-2">{r.verdict ? <Badge tone={VERDICT_TONE[r.verdict]}>{r.verdict}</Badge> : <span className="text-muted">—</span>}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{r.highest_psi !== null && r.highest_psi !== undefined ? r.highest_psi.toFixed(3) : '—'}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{r.ks_pred !== null && r.ks_pred !== undefined ? r.ks_pred.toFixed(3) : '—'}</td>
                    <td className="py-1.5 px-2 text-muted">{r.last_evaluated_at ? new Date(r.last_evaluated_at).toISOString().slice(0, 10) : '—'}</td>
                    <td className="py-1.5 px-2">
                      <Link
                        to={`/ai/drift?model_id=${encodeURIComponent(r.model_id)}`}
                        className="inline-flex items-center gap-1 text-action hover:underline text-[11px]"
                        data-testid={`ai-drift-drill-${r.model_id}`}
                      >
                        Deep dive <ArrowRight size={11} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
