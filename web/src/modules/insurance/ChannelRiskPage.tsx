// web/src/modules/insurance/ChannelRiskPage.tsx
//
// Insurance EWS — Module 7: Channel Risk.
//
// 4 widgets per the spec (channel-risk leaderboard · channel health ·
// mis-selling alerts · complaint analytics) + an ad-hoc agent analyzer.
// Backed by /v1/insurance/channel-risk/{dashboard,analyze,high-risk}.

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { Network, Activity, ShieldAlert, MessageSquareWarning, Search } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  ChannelRiskDashboardShape,
  MisSellingAlertShape,
  ChannelRiskBandShape,
  MisSellingSeverityShape,
  AgentRiskAnalysisShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, Modal, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildChannelRiskReportData } from './channelRiskReportAdapter';
import { color } from '@/styles/tokens';

const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`;
const fmtPct1 = (n: number) => `${(n * 100).toFixed(1)}%`;

const BAND_TONE: Record<ChannelRiskBandShape, BadgeTone> = {
  critical: 'danger',
  elevated: 'danger',
  watch: 'warning',
  healthy: 'success',
};
const SEV_TONE: Record<MisSellingSeverityShape, BadgeTone> = {
  critical: 'danger',
  warning: 'warning',
  info: 'blue',
};

// Sub-score bar colour by axis.
const SUB_COLORS: Record<string, string> = {
  persistency: color.warning,
  fraud: color.danger,
  complaint: color.blue,
  mis_selling: '#8b5cf6',
};

export function ChannelRiskPage() {
  const me = useAuth((s) => s.user);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  const { data, isLoading } = useQuery<ChannelRiskDashboardShape>({
    queryKey: ['insurance', 'channel-risk', 'dashboard'],
    queryFn: () => api.insuranceChannelRiskDashboard(),
  });

  return (
    <div>
      <PageHeader
        title="Channel Risk"
        subtitle="Agent & broker risk · persistency · fraud · complaints · mis-selling"
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setAnalyzeOpen(true)} data-testid="chr-analyze-open">
              <Search size={15} className="mr-1.5 -ml-0.5" /> Analyze agent
            </Button>
            {/* Enterprise export (P3) — RBAC-gated; renders null without
                reports:export. Reports the channel-risk leaderboard + channel KPIs. */}
            <ExportButton
              module="channel_risk"
              reportType="risk"
              adapter={(config) =>
                buildChannelRiskReportData(
                  {
                    totals: {
                      agents_scored: data?.totals.agents_scored ?? 0,
                      high_risk_agents: data?.totals.high_risk_agents ?? 0,
                      critical_agents: data?.totals.critical_agents ?? 0,
                      open_mis_selling_alerts: data?.totals.open_mis_selling_alerts ?? 0,
                      complaints_30d: data?.totals.complaints_30d ?? 0,
                      worst_channel: data?.totals.worst_channel ?? null,
                    },
                    channel_risk_leaderboard: data?.channel_risk_leaderboard ?? [],
                    meta: { tenant_id: 'BANK_DEMO', generated_by: me?.username ?? 'operator', role: me?.roles?.[0] ?? 'admin' },
                  },
                  config,
                )
              }
            />
          </div>
        }
      />

      {isLoading || !data ? (
        <Panel>
          <p className="caption" data-testid="chr-loading">Loading channel risk…</p>
        </Panel>
      ) : (
        <div className="space-y-5" data-testid="chr-dashboard">
          {/* ── KPI row ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard label="Agents scored" value={data.totals.agents_scored.toLocaleString()} />
            <MetricCard label="High-risk" value={data.totals.high_risk_agents} tone="warning" sub={`${data.totals.critical_agents} critical`} />
            <MetricCard label="Mis-selling alerts" value={data.totals.open_mis_selling_alerts} tone="danger" />
            <MetricCard label="Complaints (30d)" value={data.totals.complaints_30d.toLocaleString()} tone="blue" />
            <MetricCard label="Worst channel" value={data.totals.worst_channel ?? '—'} tone="danger" />
          </div>

          {/* ── Channel-risk leaderboard + Channel health ───────────── */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Panel>
              <div className="mb-3 flex items-center gap-2">
                <Network size={16} className="text-danger" />
                <h2 className="section-title">Channel risk leaderboard</h2>
              </div>
              <div className="space-y-2" data-testid="channel-risk-leaderboard">
                {data.channel_risk_leaderboard.map((a) => (
                  <div key={a.agent_id} className="rounded border border-divider p-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">
                          <span className="text-muted mr-1.5">#{a.rank}</span>
                          {a.agent_name}
                          <span className="text-[11px] text-muted ml-1.5 capitalize">· {a.channel}</span>
                        </p>
                        <p className="text-[11px] text-muted">
                          {a.policies_sold_90d} policies · {fmtPct(a.persistency_13m)} 13m persistency
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-semibold text-sm text-danger tabular block">{fmtPct(a.composite_risk)}</span>
                        <Badge tone={BAND_TONE[a.band]}>{a.band}</Badge>
                      </div>
                    </div>
                    {/* sub-score sparkbars */}
                    <div className="mt-2 flex gap-1.5">
                      {(['persistency', 'fraud', 'complaint', 'mis_selling'] as const).map((k) => (
                        <div key={k} className="flex-1" title={`${k.replace(/_/g, ' ')}: ${fmtPct(a.sub_scores[k])}`}>
                          <div className="h-1.5 rounded-full bg-surface-alt overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${a.sub_scores[k] * 100}%`, background: SUB_COLORS[k] }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel>
              <div className="mb-3 flex items-center gap-2">
                <Activity size={16} className="text-brand-blue" />
                <h2 className="section-title">Channel health</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="channel-health">
                  <thead>
                    <tr className="text-left text-xs text-muted border-b border-divider">
                      <th className="py-2 pr-3 font-medium">Channel</th>
                      <th className="py-2 pr-3 font-medium text-right">Agents</th>
                      <th className="py-2 pr-3 font-medium text-right">Mean risk</th>
                      <th className="py-2 pr-3 font-medium text-right">High-risk</th>
                      <th className="py-2 font-medium">Band</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.channel_health.map((c) => (
                      <tr key={c.channel} className="border-b border-divider/60 hover:bg-surface-alt">
                        <td className="py-2 pr-3 capitalize font-medium">{c.channel}</td>
                        <td className="py-2 pr-3 text-right tabular">{c.agent_count}</td>
                        <td className="py-2 pr-3 text-right tabular">{fmtPct(c.mean_risk)}</td>
                        <td className="py-2 pr-3 text-right tabular">{c.high_risk_agents}</td>
                        <td className="py-2"><Badge tone={BAND_TONE[c.band]}>{c.band}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          {/* ── Mis-selling alerts ──────────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <ShieldAlert size={16} className="text-danger" />
              <h2 className="section-title">Mis-selling alerts</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="mis-selling-alerts">
                <thead>
                  <tr className="text-left text-xs text-muted border-b border-divider">
                    <th className="py-2 pr-3 font-medium">Agent</th>
                    <th className="py-2 pr-3 font-medium">Channel</th>
                    <th className="py-2 pr-3 font-medium">Indicator</th>
                    <th className="py-2 pr-3 font-medium text-right">Count (30d)</th>
                    <th className="py-2 font-medium">Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {data.mis_selling_alerts.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-4 text-center text-muted text-xs" data-testid="mis-selling-empty">
                        No open mis-selling alerts
                      </td>
                    </tr>
                  ) : (
                    data.mis_selling_alerts.map((m: MisSellingAlertShape) => (
                      <tr key={m.alert_id} className="border-b border-divider/60 hover:bg-surface-alt">
                        <td className="py-2 pr-3">{m.agent_name}</td>
                        <td className="py-2 pr-3 capitalize">{m.channel}</td>
                        <td className="py-2 pr-3">{m.indicator.replace(/_/g, ' ')}</td>
                        <td className="py-2 pr-3 text-right tabular">{m.count_30d}</td>
                        <td className="py-2"><Badge tone={SEV_TONE[m.severity]}>{m.severity}</Badge></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* ── Complaint analytics ─────────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <MessageSquareWarning size={16} className="text-brand-blue" />
              <h2 className="section-title">Complaint analytics — by category (30d)</h2>
            </div>
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={data.complaint_analytics} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} tickFormatter={(c: string) => c.replace(/_/g, ' ')} interval={0} angle={-12} textAnchor="end" height={48} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip formatter={(v: number, name: string) => [v, name === 'pending' ? 'Pending' : 'Resolved']} labelFormatter={(c: string) => c.replace(/_/g, ' ')} />
                <Bar dataKey="resolved" stackId="c" radius={[0, 0, 0, 0]} fill={color.success} />
                <Bar dataKey="pending" stackId="c" radius={[4, 4, 0, 0]} fill={color.danger} />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-1 flex gap-4 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color.success }} /> resolved</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color.danger }} /> pending</span>
            </div>
          </Panel>

          <p className="caption text-right">
            Model {data.model_version} · generated {new Date(data.generated_at).toLocaleString()}
          </p>
        </div>
      )}

      {analyzeOpen && <AnalyzeModal onClose={() => setAnalyzeOpen(false)} />}
    </div>
  );
}

// ── Ad-hoc agent analyzer ──────────────────────────────────────────────

function AnalyzeModal({ onClose }: { onClose: () => void }) {
  const [channel, setChannel] = useState('agent');
  const [persistency, setPersistency] = useState(0.6);
  const [fraudFlags, setFraudFlags] = useState(1);
  const [complaintRate, setComplaintRate] = useState(0.2);
  const [freeLook, setFreeLook] = useState(0.3);
  const [earlySurrender, setEarlySurrender] = useState(0.2);
  const [suitability, setSuitability] = useState(0.3);

  const analyze = useMutation<AgentRiskAnalysisShape, Error>({
    mutationFn: () =>
      api.insuranceChannelRiskAnalyze({
        channel,
        persistency_13m: persistency,
        fraud_flag_count: fraudFlags,
        complaint_rate: complaintRate,
        free_look_cancellation_rate: freeLook,
        early_surrender_rate: earlySurrender,
        suitability_mismatch_rate: suitability,
      }),
  });
  const result = analyze.data;

  return (
    <Modal open onClose={onClose} ariaLabel="Analyze agent channel risk" size="md" testId="chr-analyze">
      <div className="space-y-3" data-testid="chr-analyze-modal">
        <div className="flex items-center justify-between border-b border-divider pb-3">
          <h2 className="section-title">Analyze agent risk</h2>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Channel">
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
              {['agent', 'broker', 'bancassurance', 'direct', 'online'].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="13-month persistency (0–1)">
            <input type="number" min={0} max={1} step={0.05} className="input" value={persistency} onChange={(e) => setPersistency(Number(e.target.value))} />
          </Field>
          <Field label="Open fraud flags">
            <input type="number" min={0} className="input" value={fraudFlags} onChange={(e) => setFraudFlags(Number(e.target.value))} />
          </Field>
          <Field label="Complaint rate (0–1)">
            <input type="number" min={0} max={1} step={0.05} className="input" value={complaintRate} onChange={(e) => setComplaintRate(Number(e.target.value))} />
          </Field>
          <Field label="Free-look cancellation rate (0–1)">
            <input type="number" min={0} max={1} step={0.05} className="input" value={freeLook} onChange={(e) => setFreeLook(Number(e.target.value))} />
          </Field>
          <Field label="Early-surrender rate (0–1)">
            <input type="number" min={0} max={1} step={0.05} className="input" value={earlySurrender} onChange={(e) => setEarlySurrender(Number(e.target.value))} />
          </Field>
          <Field label="Suitability-mismatch rate (0–1)">
            <input type="number" min={0} max={1} step={0.05} className="input" value={suitability} onChange={(e) => setSuitability(Number(e.target.value))} />
          </Field>
        </div>

        <Button onClick={() => analyze.mutate()} disabled={analyze.isPending} data-testid="chr-analyze-run">
          {analyze.isPending ? 'Analyzing…' : 'Analyze risk'}
        </Button>

        {result && (
          <div className="mt-2 rounded-card border border-divider p-4" data-testid="chr-analyze-result">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Composite risk</span>
              <span className="text-2xl font-bold tabular">{fmtPct1(result.composite_risk)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Band</span>
              <Badge tone={BAND_TONE[result.band]}>{result.band}</Badge>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Action</span>
              <Badge tone={result.requires_action ? 'danger' : 'success'}>
                {result.requires_action ? 'Required' : 'Not required'}
              </Badge>
            </div>
            <p className="mt-3 text-xs font-medium text-muted">Risk drivers</p>
            <ul className="mt-1 space-y-1">
              {result.drivers.map((d) => (
                <li key={d.driver} className="text-xs flex items-center justify-between gap-2">
                  <span className="capitalize">{d.driver.replace(/_/g, ' ')} — {d.detail}</span>
                  <span className="tabular text-danger font-semibold shrink-0">{fmtPct1(d.sub_score)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-ink-sub leading-snug border-t border-divider pt-2">
              {result.recommended_action}
            </p>
          </div>
        )}
        {analyze.isError && (
          <p className="text-xs text-danger" role="alert">{analyze.error.message}</p>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted mb-1 block">{label}</span>
      {children}
    </label>
  );
}
