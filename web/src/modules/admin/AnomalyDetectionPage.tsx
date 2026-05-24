// web/src/modules/admin/AnomalyDetectionPage.tsx
//
// Module 1.5 — Anomaly Detection (AI).
//
// Spec deliverables:
//   - "Anomalies — Last 24 hours" table with filters
//   - Anomaly Case Modal: time-series chart + contributing fields + Investigate / Dismiss
//   - Pattern config panel (enable/threshold per pattern)
//   - "Inject 10× spike" demo button — closes the spec acceptance
//
// Wired to:
//   GET  /v1/anomalies?window=24h&source_id=&severity=&min_score=&pattern=
//   GET  /v1/anomalies/:id                 (time_series + score_100)
//   GET  /v1/anomalies/patterns/config
//   POST /v1/anomalies/patterns/config
//   POST /v1/anomalies/rerun
//   POST /v1/anomalies/inject-spike
//   POST /v1/anomalies/:id/investigate
//   POST /v1/anomalies/:id/dismiss

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceDot,
} from 'recharts';
import {
  AlertTriangle,
  Activity,
  CheckCircle2,
  Cpu,
  Eye,
  RefreshCw,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
void Activity;
void Eye;
import { Link } from 'react-router-dom';
import {
  api,
  type AnomalyDetail,
  type AnomalyListReport,
  type AnomalyPattern,
  type AnomalyPatternConfigRow,
  type AnomalySeverity,
  type AnomalyStatus,
  type AnomalySummary,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const SEVERITY_OPTIONS: AnomalySeverity[] = ['critical', 'high', 'medium', 'low'];
const STATUS_OPTIONS: AnomalyStatus[] = ['open', 'acknowledged', 'investigating', 'resolved', 'false_positive'];
const PATTERN_OPTIONS: AnomalyPattern[] = [
  'txn_volume_spike',
  'geo_velocity',
  'channel_shift',
  'amount_outlier',
  'frequency_outlier',
  'schema_drift',
  'pipeline_lag',
  'duplicate_burst',
];
const KNOWN_SOURCES = ['cbs_loans', 'cbs_repayments', 'cbs_txns', 'mart_customer_360', 'mart_loan_360', 'bureau_score'];

const SEV_TONE: Record<AnomalySeverity, BadgeTone> = {
  critical: 'danger',
  high: 'warning',
  medium: 'neutral',
  low: 'success',
};
const STATUS_TONE: Record<AnomalyStatus, BadgeTone> = {
  open: 'danger',
  acknowledged: 'warning',
  investigating: 'blue',
  resolved: 'success',
  false_positive: 'neutral',
};

function score100(a: { anomaly_score: number }): number {
  return Math.round(a.anomaly_score * 100);
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { hour12: false });
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(0)}%`;
}

export function AnomalyDetectionPage() {
  const qc = useQueryClient();
  const [window] = useState('24h');
  const [pattern, setPattern] = useState<AnomalyPattern | ''>('');
  const [severity, setSeverity] = useState<AnomalySeverity | ''>('');
  const [status, setStatus] = useState<AnomalyStatus | ''>('');
  const [sourceId, setSourceId] = useState('');
  const [minScore, setMinScore] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState('');

  const listQ = useQuery({
    queryKey: ['anomalies', window, pattern, severity, status, sourceId, minScore],
    queryFn: () =>
      api.anomaliesList({
        window,
        pattern: pattern || undefined,
        severity: severity || undefined,
        status: status || undefined,
        source_id: sourceId || undefined,
        min_score: minScore ? Number(minScore) : undefined,
      }),
  });

  const detailQ = useQuery({
    queryKey: ['anomaly', selectedId],
    queryFn: () => api.anomalyGet(selectedId!),
    enabled: !!selectedId,
  });

  const configQ = useQuery({
    queryKey: ['anomaly-patterns'],
    queryFn: api.anomalyPatternsConfigGet,
    enabled: showConfig,
  });

  const rerunMut = useMutation({
    mutationFn: api.anomalyRerun,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['anomalies'] }),
  });

  const injectMut = useMutation({
    mutationFn: () => api.anomalyInjectSpike({ source_id: sourceId || 'cbs_txns', multiplier: 10 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['anomalies'] }),
  });

  const investigateMut = useMutation({
    mutationFn: (id: string) => api.anomalyInvestigate(id, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['anomalies'] });
      qc.invalidateQueries({ queryKey: ['anomaly', id] });
    },
  });

  const dismissMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.anomalyDismiss(id, reason),
    onSuccess: (_, vars) => {
      setDismissingId(null);
      setDismissReason('');
      qc.invalidateQueries({ queryKey: ['anomalies'] });
      qc.invalidateQueries({ queryKey: ['anomaly', vars.id] });
    },
  });

  const cfgUpdateMut = useMutation({
    mutationFn: (updates: Array<{ pattern: AnomalyPattern; enabled?: boolean; threshold?: number }>) =>
      api.anomalyPatternsConfigSet(updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['anomaly-patterns'] }),
  });

  const report: AnomalyListReport | undefined = listQ.data;

  const filteredAnomalies = useMemo(() => report?.anomalies ?? [], [report]);

  const aiHealthy = !listQ.isError;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Anomaly Detection (AI)"
        subtitle="Statistical + ML outlier detection across all feeds — catches what rules miss"
        actions={
          <>
            <Button variant="ghost" onClick={() => rerunMut.mutate()} disabled={rerunMut.isPending} data-testid="anom-rerun">
              <RefreshCw size={14} className={rerunMut.isPending ? 'animate-spin' : ''} />
              Rerun detection
            </Button>
            <Button
              variant="ghost"
              onClick={() => injectMut.mutate()}
              disabled={injectMut.isPending}
              data-testid="anom-inject-spike"
              title="Inject a 10× spike for demo/acceptance"
            >
              <Zap size={14} />
              Inject 10× spike (demo)
            </Button>
            <Button onClick={() => setShowConfig(true)} data-testid="anom-config-open">
              <Cpu size={14} />
              Pattern config
            </Button>
          </>
        }
      />

      {!aiHealthy && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle size={14} className="mr-2 inline" />
          AI service unavailable — falling back to deterministic baseline only.
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard
          label="Total (24h)"
          value={report?.total ?? 0}
          sub={listQ.isLoading ? 'Loading…' : `${KNOWN_SOURCES.length} sources monitored`}
          testId="anom-kpi-total"
        />
        <MetricCard
          label="Critical"
          value={report?.by_severity?.critical ?? 0}
          sub="score ≥ 90"
          tone="danger"
          testId="anom-kpi-critical"
        />
        <MetricCard
          label="High"
          value={report?.by_severity?.high ?? 0}
          sub="score ≥ 75"
          tone="warning"
          testId="anom-kpi-high"
        />
        <MetricCard
          label="Investigating"
          value={report?.by_status?.investigating ?? 0}
          sub="open cases via Investigate"
          tone="blue"
          testId="anom-kpi-investigating"
        />
      </div>

      {/* Filter bar */}
      <Panel title="Anomalies — Last 24 hours" data-testid="anom-list-panel">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as AnomalySeverity | '')}
            className="rounded border border-slate-300 px-2 py-1"
            data-testid="anom-filter-severity"
          >
            <option value="">All severities</option>
            {SEVERITY_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={pattern}
            onChange={(e) => setPattern(e.target.value as AnomalyPattern | '')}
            className="rounded border border-slate-300 px-2 py-1"
            data-testid="anom-filter-pattern"
          >
            <option value="">All patterns</option>
            {PATTERN_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as AnomalyStatus | '')}
            className="rounded border border-slate-300 px-2 py-1"
            data-testid="anom-filter-status"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
            data-testid="anom-filter-source"
          >
            <option value="">All sources</option>
            {KNOWN_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1 text-slate-600">
            Min score
            <input
              type="number"
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
              placeholder="0-100"
              min={0}
              max={100}
              className="w-20 rounded border border-slate-300 px-2 py-1"
              data-testid="anom-filter-min-score"
            />
          </label>
          {(pattern || severity || status || sourceId || minScore) && (
            <button
              type="button"
              onClick={() => { setPattern(''); setSeverity(''); setStatus(''); setSourceId(''); setMinScore(''); }}
              className="ml-auto text-slate-500 underline hover:text-slate-700"
              data-testid="anom-filter-clear"
            >
              Clear filters
            </button>
          )}
        </div>

        {listQ.isLoading ? (
          <div className="text-sm text-slate-500">Loading anomalies…</div>
        ) : !report || report.total === 0 ? (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            No anomalies in the last 24h match your filters.
          </div>
        ) : (
          <div className="overflow-x-auto" data-testid="anom-table">
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">ID</th>
                  <th className="px-2 py-1.5">Source</th>
                  <th className="px-2 py-1.5">Pattern</th>
                  <th className="px-2 py-1.5">Score</th>
                  <th className="px-2 py-1.5">Severity</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Detected</th>
                  <th className="px-2 py-1.5">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {filteredAnomalies.map((a: AnomalySummary) => (
                  <tr
                    key={a.anomaly_id}
                    onClick={() => setSelectedId(a.anomaly_id)}
                    className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                    data-testid={`anom-row-${a.anomaly_id}`}
                  >
                    <td className="px-2 py-2 font-mono text-xs text-slate-500">
                      {a.anomaly_id.length > 24 ? `${a.anomaly_id.slice(0, 24)}…` : a.anomaly_id}
                      {a.injected && (
                        <span
                          className="ml-1 inline-flex items-center gap-0.5 rounded-full border border-blue-200 bg-blue-50 px-1 py-0 text-[9px] text-blue-700"
                          data-testid={`anom-injected-${a.anomaly_id}`}
                        >
                          <Sparkles size={8} /> demo
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">{a.source_id}</td>
                    <td className="px-2 py-2 text-xs">{a.pattern}</td>
                    <td className="px-2 py-2 font-mono text-xs">
                      <Badge tone={a.anomaly_score >= 0.80 ? 'danger' : 'neutral'}>
                        {score100(a)}
                      </Badge>
                    </td>
                    <td className="px-2 py-2"><Badge tone={SEV_TONE[a.severity]}>{a.severity}</Badge></td>
                    <td className="px-2 py-2"><Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge></td>
                    <td className="px-2 py-2 text-xs text-slate-500">{fmtTime(a.detected_at)}</td>
                    <td className="px-2 py-2 text-xs text-slate-600">{a.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Case modal */}
      {selectedId && (
        <AnomalyCaseModal
          anomalyId={selectedId}
          detail={detailQ.data}
          isLoading={detailQ.isLoading}
          onClose={() => setSelectedId(null)}
          onInvestigate={() => investigateMut.mutate(selectedId)}
          onDismiss={() => setDismissingId(selectedId)}
          isInvestigatePending={investigateMut.isPending}
        />
      )}

      {/* Dismiss reason prompt */}
      {dismissingId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="anom-dismiss-modal"
        >
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h3 className="mb-2 text-base font-semibold">Dismiss as false positive</h3>
            <p className="mb-3 text-xs text-slate-500">A reason is required for the audit trail.</p>
            <textarea
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              rows={4}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="e.g. False positive — expected EOM batch ran 30 min late"
              data-testid="anom-dismiss-reason"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setDismissingId(null); setDismissReason(''); }}>
                Cancel
              </Button>
              <Button
                onClick={() => dismissMut.mutate({ id: dismissingId, reason: dismissReason })}
                disabled={!dismissReason.trim() || dismissMut.isPending}
                data-testid="anom-dismiss-confirm"
              >
                Confirm dismiss
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Pattern config modal */}
      {showConfig && (
        <PatternConfigPanel
          config={configQ.data?.patterns ?? null}
          isLoading={configQ.isLoading}
          onClose={() => setShowConfig(false)}
          onSave={(updates) => cfgUpdateMut.mutate(updates)}
          isSavePending={cfgUpdateMut.isPending}
        />
      )}
    </div>
  );
}

// ── Anomaly Case Modal ─────────────────────────────────────────────────

function AnomalyCaseModal({
  anomalyId,
  detail,
  isLoading,
  onClose,
  onInvestigate,
  onDismiss,
  isInvestigatePending,
}: {
  anomalyId: string;
  detail: AnomalyDetail | undefined;
  isLoading: boolean;
  onClose: () => void;
  onInvestigate: () => void;
  onDismiss: () => void;
  isInvestigatePending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="anom-case-modal">
      <div className="w-full max-w-3xl rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="font-mono text-sm text-slate-500">{anomalyId}</h3>
            {detail && (
              <div className="mt-1 flex items-center gap-2">
                <Badge tone={SEV_TONE[detail.severity]}>{detail.severity}</Badge>
                <Badge tone={STATUS_TONE[detail.status]}>{detail.status}</Badge>
                <span className="text-xs text-slate-500">Score</span>
                <Badge tone={detail.anomaly_score >= 0.80 ? 'danger' : 'neutral'}>
                  {detail.score_100 ?? score100(detail)}
                </Badge>
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700" data-testid="anom-modal-close">
            <X size={18} />
          </button>
        </div>

        {isLoading || !detail ? (
          <div className="text-sm text-slate-500">Loading anomaly detail…</div>
        ) : (
          <>
            <div className="mb-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <span className="mr-1 font-semibold">Description:</span>{detail.description}
            </div>

            <div className="mb-4 rounded border border-slate-200" data-testid="anom-timeseries">
              <div className="border-b border-slate-200 px-3 py-1 text-xs text-slate-500">
                Time series — 24h ending at detected_at
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={detail.time_series} margin={{ top: 10, right: 16, left: 0, bottom: 8 }}>
                  <XAxis dataKey="ts" tickFormatter={(v) => new Date(v).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' })} fontSize={10} />
                  <YAxis fontSize={10} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#0f172a" strokeWidth={1.5} dot={false} />
                  {detail.time_series.filter((p) => p.is_outlier).map((p) => (
                    <ReferenceDot key={p.ts} x={p.ts} y={p.value} r={5} fill="#dc2626" stroke="none" />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded border border-slate-200 px-3 py-2">
                <div className="mb-1 text-xs font-semibold text-slate-500">Source</div>
                <div className="font-mono text-sm">{detail.source_id}</div>
                <div className="mt-1 text-xs text-slate-500">Pattern: {detail.pattern}</div>
              </div>
              <div className="rounded border border-slate-200 px-3 py-2">
                <div className="mb-1 text-xs font-semibold text-slate-500">Affected records</div>
                <div className="text-sm">{detail.affected_records.toLocaleString()}</div>
                <div className="mt-1 text-xs text-slate-500">Detected: {fmtTime(detail.detected_at)}</div>
              </div>
            </div>

            {detail.case_id && (
              <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                Cross-linked case:{' '}
                <Link className="underline" to={`/cases/${encodeURIComponent(detail.case_id)}`} data-testid="anom-case-link">
                  {detail.case_id}
                </Link>
              </div>
            )}

            {(detail.status_updates && detail.status_updates.length > 0) && (
              <details className="mb-3 rounded border border-slate-200 px-3 py-2 text-xs">
                <summary className="cursor-pointer text-slate-600">Status history ({detail.status_updates.length})</summary>
                <ul className="mt-2 space-y-1">
                  {detail.status_updates.map((u, idx) => (
                    <li key={idx} className="text-slate-600">
                      <Badge tone={STATUS_TONE[u.status as AnomalyStatus] ?? 'neutral'}>{u.status}</Badge>{' '}
                      by {u.actor_username} at {fmtTime(u.changed_at)} — {u.notes ?? 'no notes'}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                onClick={onDismiss}
                disabled={detail.status === 'false_positive'}
                data-testid="anom-dismiss-open"
              >
                <X size={14} />
                Dismiss as false positive
              </Button>
              <Button
                onClick={onInvestigate}
                disabled={isInvestigatePending || detail.status === 'investigating' || detail.status === 'false_positive' || detail.status === 'resolved'}
                data-testid="anom-investigate"
              >
                <CheckCircle2 size={14} />
                Investigate (create case)
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Pattern config panel ───────────────────────────────────────────────

function PatternConfigPanel({
  config,
  isLoading,
  onClose,
  onSave,
  isSavePending,
}: {
  config: AnomalyPatternConfigRow[] | null;
  isLoading: boolean;
  onClose: () => void;
  onSave: (updates: Array<{ pattern: AnomalyPattern; enabled?: boolean; threshold?: number }>) => void;
  isSavePending: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, { enabled: boolean; threshold: number }>>({});

  function toggleEnabled(row: AnomalyPatternConfigRow): void {
    setDrafts((d) => ({
      ...d,
      [row.pattern]: { enabled: !(d[row.pattern]?.enabled ?? row.enabled), threshold: d[row.pattern]?.threshold ?? row.threshold },
    }));
  }
  function setThreshold(row: AnomalyPatternConfigRow, v: number): void {
    setDrafts((d) => ({
      ...d,
      [row.pattern]: { enabled: d[row.pattern]?.enabled ?? row.enabled, threshold: v },
    }));
  }

  function commit(): void {
    if (!config) return;
    const updates: Array<{ pattern: AnomalyPattern; enabled?: boolean; threshold?: number }> = [];
    for (const row of config) {
      const dr = drafts[row.pattern];
      if (!dr) continue;
      const payload: { pattern: AnomalyPattern; enabled?: boolean; threshold?: number } = { pattern: row.pattern };
      if (dr.enabled !== row.enabled) payload.enabled = dr.enabled;
      if (dr.threshold !== row.threshold) payload.threshold = dr.threshold;
      if (payload.enabled !== undefined || payload.threshold !== undefined) updates.push(payload);
    }
    if (updates.length === 0) {
      onClose();
      return;
    }
    onSave(updates);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="anom-config-modal">
      <div className="w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Pattern configuration</h3>
            <p className="mt-1 text-xs text-slate-500">Configure which detection patterns run, and their score threshold (0–1).</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700"><X size={18} /></button>
        </div>

        {isLoading || !config ? (
          <div className="text-sm text-slate-500">Loading config…</div>
        ) : (
          <div className="overflow-y-auto" data-testid="anom-config-table">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Pattern</th>
                  <th className="px-2 py-1.5">Enabled</th>
                  <th className="px-2 py-1.5">Threshold</th>
                </tr>
              </thead>
              <tbody>
                {config.map((row) => {
                  const dr = drafts[row.pattern];
                  const effEnabled = dr ? dr.enabled : row.enabled;
                  const effThr = dr ? dr.threshold : row.threshold;
                  return (
                    <tr key={row.pattern} className="border-b border-slate-100" data-testid={`anom-cfg-row-${row.pattern}`}>
                      <td className="px-2 py-2 font-mono text-xs">{row.pattern}</td>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          checked={effEnabled}
                          onChange={() => toggleEnabled(row)}
                          data-testid={`anom-cfg-enabled-${row.pattern}`}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="number"
                          step={0.05}
                          min={0}
                          max={1}
                          value={effThr}
                          onChange={(e) => setThreshold(row, Number(e.target.value))}
                          className="w-20 rounded border border-slate-300 px-2 py-1 text-xs"
                          data-testid={`anom-cfg-threshold-${row.pattern}`}
                        />
                        <span className="ml-1 text-xs text-slate-500">({fmtPct(effThr)})</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={commit} disabled={isSavePending} data-testid="anom-config-save">
            Save config
          </Button>
        </div>
      </div>
    </div>
  );
}
