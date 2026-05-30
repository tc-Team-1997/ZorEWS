// web/src/modules/ai/governance/AiModelMonitoringPage.tsx
//
// AI Governance → Model Monitoring Dashboard.
//
// Fleet-wide health rollup over the M7.1 model registry. Composes:
//   • api.aiModels()            — full registry
//   • api.aiDriftFleet()        — per-model drift verdict (PSI / KS)
// into a single ranked health table for the SPA.
//
// Status badge derivation is purely client-side over the existing
// data — zero new BFF route. Each row is click-through to the existing
// per-model drift drill-down (/ai/drift) for the deep dive.

import { Navigate, Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  CircleSlash2,
  Clock,
} from 'lucide-react';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, type AiModelRow } from '@/lib/api';

type HealthBucket = 'healthy' | 'watch' | 'drift_alert' | 'stale' | 'retired';

interface DriftFleetRow {
  model_id: string;
  highest_psi?: number | null;
  ks_pred?: number | null;
  verdict?: 'green' | 'amber' | 'red' | null;
}

interface DriftFleetShape {
  items?: DriftFleetRow[];
}

interface MonitoringRow {
  model_id: string;
  name: string;
  type: string;
  version: string;
  status: AiModelRow['status'];
  deployed_at: string | null;
  trained_at: string | null;
  days_since_deployed: number | null;
  drift_verdict: 'green' | 'amber' | 'red' | null;
  highest_psi: number | null;
  health: HealthBucket;
}

const STALE_DAYS = 180;

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / (1000 * 60 * 60 * 24)));
}

function deriveHealth(
  status: AiModelRow['status'],
  daysDeployed: number | null,
  driftVerdict: DriftFleetRow['verdict'],
): HealthBucket {
  if (status === 'retired') return 'retired';
  if (driftVerdict === 'red') return 'drift_alert';
  if (driftVerdict === 'amber') return 'watch';
  if (daysDeployed !== null && daysDeployed > STALE_DAYS) return 'stale';
  return 'healthy';
}

function bucketTone(b: HealthBucket): 'success' | 'warning' | 'danger' | 'neutral' {
  if (b === 'healthy') return 'success';
  if (b === 'watch' || b === 'stale') return 'warning';
  if (b === 'drift_alert') return 'danger';
  return 'neutral';
}

function bucketLabel(b: HealthBucket): string {
  switch (b) {
    case 'healthy':
      return 'Healthy';
    case 'watch':
      return 'Watch';
    case 'drift_alert':
      return 'Drift alert';
    case 'stale':
      return 'Stale (>180d deployed)';
    case 'retired':
      return 'Retired';
  }
}

export function AiModelMonitoringPage() {
  const me = useAuth((s) => s.user);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  const modelsQ = useQuery({
    queryKey: ['ai-governance-models'],
    queryFn: () => api.aiModels(),
    staleTime: 60_000,
  });
  const driftQ = useQuery({
    queryKey: ['ai-governance-drift-fleet'],
    queryFn: () => api.aiDriftFleet() as Promise<DriftFleetShape>,
    staleTime: 60_000,
  });

  const rows: MonitoringRow[] = useMemo(() => {
    const models = modelsQ.data?.items ?? [];
    const drift = driftQ.data?.items ?? [];
    const byModel = new Map<string, DriftFleetRow>(drift.map((d) => [d.model_id, d]));
    const now = new Date();
    return models.map((m) => {
      const d = byModel.get(m.model_id);
      const daysDeployed = daysSince(m.deployed_at ?? null, now);
      const verdict = d?.verdict ?? null;
      return {
        model_id: m.model_id,
        name: m.name ?? m.model_id,
        type: m.type,
        version: m.version,
        status: m.status,
        deployed_at: m.deployed_at ?? null,
        trained_at: m.trained_at ?? null,
        days_since_deployed: daysDeployed,
        drift_verdict: verdict,
        highest_psi: d?.highest_psi ?? null,
        health: deriveHealth(m.status, daysDeployed, verdict),
      };
    });
  }, [modelsQ.data, driftQ.data]);

  const totals = useMemo(() => {
    const t: Record<HealthBucket, number> = {
      healthy: 0,
      watch: 0,
      drift_alert: 0,
      stale: 0,
      retired: 0,
    };
    for (const r of rows) t[r.health] += 1;
    return t;
  }, [rows]);

  const sorted = useMemo(() => {
    const ORDER: Record<HealthBucket, number> = {
      drift_alert: 0,
      watch: 1,
      stale: 2,
      healthy: 3,
      retired: 4,
    };
    return [...rows].sort((a, b) => ORDER[a.health] - ORDER[b.health] || a.model_id.localeCompare(b.model_id));
  }, [rows]);

  return (
    <div data-testid="ai-monitoring-page">
      <PageHeader
        title="Model Monitoring Dashboard"
        subtitle="Fleet-wide AI model health: deployment age, drift verdict, latest metrics — drilled-into via /ai/drift per row."
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4" data-testid="ai-monitoring-kpis">
        <MetricCard label="Healthy" value={totals.healthy.toString()} testId="ai-monitoring-kpi-healthy" />
        <MetricCard label="Watch" value={totals.watch.toString()} tone={totals.watch > 0 ? 'warning' : 'neutral'} testId="ai-monitoring-kpi-watch" />
        <MetricCard label="Drift alert" value={totals.drift_alert.toString()} tone={totals.drift_alert > 0 ? 'danger' : 'neutral'} testId="ai-monitoring-kpi-drift" />
        <MetricCard label="Stale (>180d)" value={totals.stale.toString()} tone={totals.stale > 0 ? 'warning' : 'neutral'} testId="ai-monitoring-kpi-stale" />
        <MetricCard label="Retired" value={totals.retired.toString()} testId="ai-monitoring-kpi-retired" />
      </div>

      <Panel title="Fleet health (worst first)">
        {modelsQ.isLoading ? (
          <p className="text-sm text-muted">Loading model fleet…</p>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted">No models registered.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]" data-testid="ai-monitoring-table">
              <thead className="text-[11px] uppercase tracking-wide text-muted border-b border-divider">
                <tr>
                  <th className="text-left py-2 px-2">Model</th>
                  <th className="text-left py-2 px-2">Type</th>
                  <th className="text-left py-2 px-2">Version</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Health</th>
                  <th className="text-right py-2 px-2">Days deployed</th>
                  <th className="text-right py-2 px-2">Highest PSI</th>
                  <th className="text-left py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr
                    key={r.model_id}
                    className="border-b border-divider/60 hover:bg-aurora-tint/30"
                    data-testid={`ai-monitoring-row-${r.model_id}`}
                  >
                    <td className="py-1.5 px-2">
                      <div className="font-medium text-ink">{r.name}</div>
                      <div className="text-[10.5px] text-muted">{r.model_id}</div>
                    </td>
                    <td className="py-1.5 px-2 text-ink">{r.type}</td>
                    <td className="py-1.5 px-2 text-muted">{r.version}</td>
                    <td className="py-1.5 px-2 text-ink">{r.status}</td>
                    <td className="py-1.5 px-2">
                      <Badge tone={bucketTone(r.health)}>
                        {r.health === 'drift_alert' && <AlertTriangle size={11} className="inline mr-1" />}
                        {r.health === 'healthy' && <CheckCircle2 size={11} className="inline mr-1" />}
                        {r.health === 'retired' && <CircleSlash2 size={11} className="inline mr-1" />}
                        {(r.health === 'stale' || r.health === 'watch') && <Clock size={11} className="inline mr-1" />}
                        {bucketLabel(r.health)}
                      </Badge>
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {r.days_since_deployed !== null ? r.days_since_deployed : '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {r.highest_psi !== null ? r.highest_psi.toFixed(3) : '—'}
                    </td>
                    <td className="py-1.5 px-2">
                      <Link
                        to={`/ai/drift?model_id=${encodeURIComponent(r.model_id)}`}
                        className="inline-flex items-center gap-1 text-action hover:underline text-[11px]"
                        data-testid={`ai-monitoring-drill-${r.model_id}`}
                      >
                        Drill <ArrowRight size={11} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel className="mt-3" title="How health is derived">
        <ul className="caption space-y-1 list-disc pl-5">
          <li><strong className="text-ink">Drift alert</strong>: drift fleet verdict = red (highest PSI past tier-1 threshold).</li>
          <li><strong className="text-ink">Watch</strong>: drift verdict = amber.</li>
          <li><strong className="text-ink">Stale</strong>: deployed &gt; {STALE_DAYS} days ago (T6 M7.18 freshness budget exceeded).</li>
          <li><strong className="text-ink">Healthy</strong>: drift = green AND deployed within {STALE_DAYS} days.</li>
          <li><strong className="text-ink">Retired</strong>: status = retired (excluded from health computation).</li>
        </ul>
        <p className="caption mt-2 text-[11px] text-muted flex items-center gap-1">
          <Activity size={12} /> Per-model deep-dive: drift history, prediction outliers, retraining trigger — open
          {' '}
          <Link to="/ai/drift" className="text-action underline">/ai/drift</Link>.
        </p>
      </Panel>
    </div>
  );
}

export { deriveHealth, bucketLabel, STALE_DAYS };
