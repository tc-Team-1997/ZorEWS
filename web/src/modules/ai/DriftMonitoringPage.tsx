// web/src/modules/ai/DriftMonitoringPage.tsx
//
// AI Workbench — T7 Module 7: Drift Detection (operational surface).
//
// The live drift dashboard the ops team polls between batch runs of the
// offline ml/monitoring/drift.py job. Per monitored model: a status band
// (stable / warn / drift) rolled up from per-feature PSI, KS prediction
// drift, rolling-AUC performance drift, and anomaly-rate spikes. Click a
// model for the full feature-level PSI breakdown + signal detail. Backed by
// /v1/ai/drift/*; MSW-backed in dev. Enterprise + audit-friendly — a
// surveillance console, not a marketing chart.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  api,
  type DriftFleetShape,
  type DriftSnapshotShape,
  type DriftBandShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Modal, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const BAND_TONE: Record<DriftBandShape, BadgeTone> = {
  stable: 'success',
  warn: 'warning',
  drift: 'danger',
};
const BAND_LABEL: Record<DriftBandShape, string> = {
  stable: 'Stable',
  warn: 'Watch',
  drift: 'Drift',
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function DriftMonitoringPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data: fleet } = useQuery<DriftFleetShape>({ queryKey: ['drift.fleet'], queryFn: () => api.aiDriftFleet() });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Drift Detection"
        subtitle="Live model-drift surveillance — per-feature PSI, prediction-distribution KS, rolling-AUC, and anomaly-rate spikes. Mirrors the offline drift monitor's thresholds (PSI stable < 0.10 ≤ watch < 0.25 ≤ drift)."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard label="Models monitored" value={fleet?.total_models.toString() ?? '—'} tone="blue" testId="drift-kpi-total" />
        <MetricCard label="Stable" value={fleet?.by_status.stable.toString() ?? '—'} tone="success" testId="drift-kpi-stable" />
        <MetricCard label="Watch" value={fleet?.by_status.warn.toString() ?? '—'} tone="warning" testId="drift-kpi-warn" />
        <MetricCard label="Drift" value={fleet?.by_status.drift.toString() ?? '—'} tone="danger" testId="drift-kpi-drift" />
      </div>

      {fleet?.worst_offender && (
        <div className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-3 text-sm" data-testid="drift-worst">
          <span className="font-semibold text-danger">Worst offender:</span>{' '}
          <span className="font-mono">{fleet.worst_offender.model_id}</span> — {BAND_LABEL[fleet.worst_offender.overall_status]} · max PSI {fleet.worst_offender.max_psi.toFixed(3)}
        </div>
      )}

      <Panel title="Monitored models" action={<span className="text-xs text-ink-subtle">{fleet?.models_needing_attention ?? 0} need attention</span>}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="drift-table">
            <thead className="text-left text-xs uppercase text-ink-subtle">
              <tr>
                <th className="pb-2 pr-3">Model</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3 text-right">Max PSI</th>
                <th className="pb-2 pr-3 text-right">KS</th>
                <th className="pb-2 pr-3 text-right">AUC Δ</th>
                <th className="pb-2 pr-3 text-right">Anomaly ×</th>
                <th className="pb-2 pr-3">Signals</th>
              </tr>
            </thead>
            <tbody>
              {fleet?.models.map((m) => (
                <tr
                  key={m.model_id}
                  data-testid={`drift-row-${m.model_id}`}
                  className="cursor-pointer border-t border-divider align-top hover:bg-action/5"
                  onClick={() => setSelected(m.model_id)}
                >
                  <td className="py-2 pr-3">
                    <div className="font-mono text-xs">{m.model_id}</div>
                    <div className="text-[10px] text-ink-subtle">{m.model_type} · {m.model_version}</div>
                  </td>
                  <td className="py-2 pr-3"><Badge tone={BAND_TONE[m.overall_status]}>{BAND_LABEL[m.overall_status]}</Badge></td>
                  <td className="py-2 pr-3 text-right tabular-nums">{m.data_drift.max_psi.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{m.model_drift.ks_stat.toFixed(3)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{m.performance_drift.delta != null ? m.performance_drift.delta.toFixed(3) : '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{m.anomaly_spike.ratio.toFixed(2)}</td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {m.model_drift.drifted && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger">model</span>}
                      {m.performance_drift.drifted && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">perf</span>}
                      {m.anomaly_spike.spiked && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">anomaly</span>}
                      {m.data_drift.drifted_count > 0 && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger">{m.data_drift.drifted_count} feat</span>}
                      {m.overall_status === 'stable' && <span className="text-[10px] text-ink-subtle">—</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {selected && <DriftDetailModal model_id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function DriftDetailModal({ model_id, onClose }: { model_id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<DriftSnapshotShape>({
    queryKey: ['drift.model', model_id],
    queryFn: () => api.aiDriftModel(model_id),
  });
  const recomputeMut = useMutation({
    mutationFn: () => api.aiDriftRecompute(model_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drift.model', model_id] });
      qc.invalidateQueries({ queryKey: ['drift.fleet'] });
    },
  });

  return (
    <Modal open onClose={onClose} ariaLabel={`Drift — ${model_id}`} size="3xl" testId="drift-detail-modal">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Drift — {model_id}</h2>
        <Button variant="ghost" onClick={() => recomputeMut.mutate()} disabled={recomputeMut.isPending} data-testid="drift-recompute">
          <RefreshCw className="mr-1 size-4" />
          Recompute
        </Button>
      </div>
      {isLoading || !data ? (
        <p className="text-sm text-ink-subtle">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={BAND_TONE[data.overall_status]}>{BAND_LABEL[data.overall_status]}</Badge>
            <span className="text-xs text-ink-subtle">{data.model_type} · {data.model_version} · {data.reference_window} → {data.current_window} · {new Date(data.computed_at).toLocaleString()}</span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Panel title="Model drift (KS)">
              <dl className="space-y-1 text-sm" data-testid="drift-ks">
                <Row k="KS statistic" v={data.model_drift.ks_stat.toFixed(4)} />
                <Row k="p-value" v={data.model_drift.p_value.toFixed(4)} />
                <Row k="Drifted" v={data.model_drift.drifted ? 'yes' : 'no'} danger={data.model_drift.drifted} />
              </dl>
            </Panel>
            <Panel title="Performance (AUC)">
              <dl className="space-y-1 text-sm" data-testid="drift-perf">
                <Row k="Current" v={data.performance_drift.current_auc != null ? data.performance_drift.current_auc.toFixed(3) : 'n/a'} />
                <Row k="Baseline" v={data.performance_drift.baseline_auc != null ? data.performance_drift.baseline_auc.toFixed(3) : 'n/a'} />
                <Row k="Delta" v={data.performance_drift.delta != null ? data.performance_drift.delta.toFixed(3) : '—'} danger={data.performance_drift.drifted} />
              </dl>
            </Panel>
            <Panel title="Anomaly spike">
              <dl className="space-y-1 text-sm" data-testid="drift-anomaly">
                <Row k="Baseline rate" v={data.anomaly_spike.baseline_rate.toFixed(2)} />
                <Row k="Current rate" v={data.anomaly_spike.current_rate.toFixed(2)} />
                <Row k="Ratio" v={`${data.anomaly_spike.ratio.toFixed(2)}×`} danger={data.anomaly_spike.spiked} />
              </dl>
            </Panel>
          </div>

          <Panel title={`Feature distribution drift (PSI) — ${data.data_drift.features.length} features`}>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm" data-testid="drift-feature-table">
                <thead className="text-left text-xs uppercase text-ink-subtle">
                  <tr>
                    <th className="pb-2 pr-3">Feature</th>
                    <th className="pb-2 pr-3">Type</th>
                    <th className="pb-2 pr-3 text-right">PSI</th>
                    <th className="pb-2 pr-3">Band</th>
                    <th className="pb-2 pr-3">Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.data_drift.features].sort((a, b) => b.psi - a.psi).map((f) => (
                    <tr key={f.feature} className="border-t border-divider">
                      <td className="py-1.5 pr-3 font-mono text-xs">{f.feature}</td>
                      <td className="py-1.5 pr-3 text-xs text-ink-subtle">{f.feature_type}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{f.psi.toFixed(4)}</td>
                      <td className="py-1.5 pr-3"><Badge tone={BAND_TONE[f.band]}>{BAND_LABEL[f.band]}</Badge></td>
                      <td className="py-1.5 pr-3">
                        <div className="h-2 w-32 rounded bg-divider/40">
                          <div
                            className={`h-2 rounded ${f.band === 'drift' ? 'bg-danger' : f.band === 'warn' ? 'bg-warning' : 'bg-success'}`}
                            style={{ width: pct(Math.min(1, f.psi / 0.4)) }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
    </Modal>
  );
}

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-subtle">{k}</dt>
      <dd className={`font-mono tabular-nums ${danger ? 'font-semibold text-danger' : ''}`}>{v}</dd>
    </div>
  );
}
