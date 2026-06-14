// web/src/modules/insurance/PolicyLapsePage.tsx
//
// Insurance EWS — Module 1: Policy Lapse Risk.
//
// Predict-and-retain screen. 5 dashboard widgets per the spec
// (high-risk policies · upcoming lapse trend · channel-wise · region-wise
// · top retention opportunities) + an ad-hoc lapse-prediction drawer.
// Backed by /v1/insurance/policy-lapse/{dashboard,high-risk,predict}.

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from 'recharts';
import { ShieldAlert, TrendingDown, Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  LapseDashboardShape,
  PolicyLapseRowShape,
  RetentionBandShape,
  LapsePredictionShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { Modal } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildPolicyLapseReportData } from './policyLapseReportAdapter';
import { color } from '@/styles/tokens';

const fmtKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const BAND_TONE: Record<RetentionBandShape, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};
const BAND_COLOR: Record<RetentionBandShape, string> = {
  critical: color.danger ?? '#E24B4A',
  high: '#F5793B',
  medium: color.warning ?? '#EF9F27',
  low: color.success ?? '#1D9E75',
};

export function PolicyLapsePage() {
  const me = useAuth((s) => s.user);
  const [predictOpen, setPredictOpen] = useState(false);

  const { data, isLoading } = useQuery<LapseDashboardShape>({
    queryKey: ['insurance', 'policy-lapse', 'dashboard'],
    queryFn: () => api.insurancePolicyLapseDashboard(),
  });

  return (
    <div>
      <PageHeader
        title="Policy Lapse Risk"
        subtitle="AI lapse prediction · premium-behaviour tracking · retention prioritisation"
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setPredictOpen(true)} data-testid="lapse-predict-open">
              <Sparkles size={15} className="mr-1.5 -ml-0.5" /> Predict lapse
            </Button>
            {/* Enterprise export (P3) — RBAC-gated; renders null without
                reports:export. Reports the high-risk policies table + lapse KPI totals. */}
            <ExportButton
              module="policy_lapse"
              reportType="risk"
              adapter={(config) =>
                buildPolicyLapseReportData(
                  {
                    totals: {
                      in_force_policies: data?.totals.in_force_policies ?? 0,
                      at_risk_policies: data?.totals.at_risk_policies ?? 0,
                      critical_count: data?.totals.critical_count ?? 0,
                      gwp_at_risk_kes: data?.totals.gwp_at_risk_kes ?? 0,
                      mean_lapse_probability: data?.totals.mean_lapse_probability ?? 0,
                    },
                    high_risk_policies: data?.high_risk_policies ?? [],
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
          <p className="caption" data-testid="lapse-loading">Loading lapse intelligence…</p>
        </Panel>
      ) : (
        <div className="space-y-5" data-testid="lapse-dashboard">
          {/* ── KPI row ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard label="In-force policies" value={data.totals.in_force_policies.toLocaleString()} />
            <MetricCard
              label="At risk (30–90d)"
              value={data.totals.at_risk_policies.toLocaleString()}
              tone="warning"
              sub={`${data.totals.critical_count} critical`}
            />
            <MetricCard label="Critical" value={data.totals.critical_count} tone="danger" />
            <MetricCard label="GWP at risk" value={fmtKES(data.totals.gwp_at_risk_kes)} tone="danger" />
            <MetricCard
              label="Mean lapse prob."
              value={fmtPct(data.totals.mean_lapse_probability)}
              tone="blue"
            />
          </div>

          {/* ── Upcoming lapse trend ────────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <TrendingDown size={16} className="text-brand-blue" />
              <h2 className="section-title">Upcoming lapse trend — next 12 weeks</h2>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={data.upcoming_lapse_trend} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="lapseFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color.blue} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={color.blue} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  formatter={(v: number, name: string) =>
                    name === 'gwp_at_risk_kes' ? [fmtKES(v), 'GWP at risk'] : [v, 'Expected lapses']
                  }
                />
                <Area
                  type="monotone"
                  dataKey="expected_lapses"
                  stroke={color.blue}
                  strokeWidth={2}
                  fill="url(#lapseFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* ── Channel + Region risk ───────────────────────────────── */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Panel>
              <h2 className="section-title mb-3">Channel-wise lapse risk</h2>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.channel_lapse_risk} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
                  <XAxis dataKey="channel" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip formatter={(v: number) => [v, 'Policies at risk']} />
                  <Bar dataKey="policies_at_risk" radius={[4, 4, 0, 0]}>
                    {data.channel_lapse_risk.map((c) => (
                      <Cell key={c.channel} fill={color.blue} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>
            <Panel>
              <h2 className="section-title mb-3">Region-wise lapse risk</h2>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.region_lapse_risk} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
                  <XAxis dataKey="region" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip formatter={(v: number) => [v, 'Policies at risk']} />
                  <Bar dataKey="policies_at_risk" radius={[4, 4, 0, 0]}>
                    {data.region_lapse_risk.map((r) => (
                      <Cell key={r.region} fill={color.sky} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>

          {/* ── High-risk policies ──────────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <ShieldAlert size={16} className="text-danger" />
              <h2 className="section-title">High-risk policies</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="lapse-high-risk-table">
                <thead>
                  <tr className="text-left text-xs text-muted border-b border-divider">
                    <th className="py-2 pr-3 font-medium">Policy</th>
                    <th className="py-2 pr-3 font-medium">Customer</th>
                    <th className="py-2 pr-3 font-medium">Product</th>
                    <th className="py-2 pr-3 font-medium">Channel</th>
                    <th className="py-2 pr-3 font-medium text-right">GWP</th>
                    <th className="py-2 pr-3 font-medium text-right">Lapse prob.</th>
                    <th className="py-2 pr-3 font-medium">Band</th>
                    <th className="py-2 font-medium">Recommended action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.high_risk_policies.map((p: PolicyLapseRowShape) => (
                    <tr key={p.policy_id} className="border-b border-divider/60 hover:bg-surface-alt">
                      <td className="py-2 pr-3 font-mono text-xs">{p.policy_id}</td>
                      <td className="py-2 pr-3">{p.customer_name}</td>
                      <td className="py-2 pr-3">{p.product_code}</td>
                      <td className="py-2 pr-3 capitalize">{p.channel}</td>
                      <td className="py-2 pr-3 text-right tabular">{fmtKES(p.gwp_kes)}</td>
                      <td className="py-2 pr-3 text-right tabular font-semibold">{fmtPct(p.lapse_probability)}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={BAND_TONE[p.retention_risk_band]}>{p.retention_risk_band}</Badge>
                      </td>
                      <td className="py-2 text-xs text-ink-sub">{p.recommended_action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* ── Top retention opportunities ─────────────────────────── */}
          <Panel>
            <h2 className="section-title mb-3">Top retention opportunities</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {data.top_retention_opportunities.map((o) => (
                <div
                  key={o.policy_id}
                  className="rounded-card border border-divider p-3.5 hover:border-brand-blue transition-colors"
                  data-testid="retention-opportunity"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-sm">{o.customer_name}</p>
                    <Badge tone="success">save {fmtKES(o.expected_gwp_saved_kes)}</Badge>
                  </div>
                  <p className="font-mono text-[11px] text-muted mt-0.5">{o.policy_id}</p>
                  <div className="mt-2 flex items-center gap-4 text-xs">
                    <span>
                      GWP <span className="font-semibold">{fmtKES(o.gwp_kes)}</span>
                    </span>
                    <span>
                      Lapse <span className="font-semibold text-danger">{fmtPct(o.lapse_probability)}</span>
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-ink-sub leading-snug">{o.recommended_action}</p>
                </div>
              ))}
            </div>
          </Panel>

          <p className="caption text-right">
            Model {data.model_version} · generated {new Date(data.generated_at).toLocaleString()}
          </p>
        </div>
      )}

      {predictOpen && <PredictModal onClose={() => setPredictOpen(false)} />}
    </div>
  );
}

// ── Ad-hoc lapse predictor ────────────────────────────────────────────

function PredictModal({ onClose }: { onClose: () => void }) {
  const [customerId, setCustomerId] = useState('CUST-DEMO-1');
  const [missed, setMissed] = useState(2);
  const [daysSince, setDaysSince] = useState(60);
  const [priorLapses, setPriorLapses] = useState(0);
  const [horizon, setHorizon] = useState(30);

  const predict = useMutation<LapsePredictionShape, Error>({
    mutationFn: () =>
      api.insurancePolicyLapsePredict({
        customer_id: customerId,
        missed_instalments_12m: missed,
        days_since_last_payment: daysSince,
        prior_lapses: priorLapses,
        horizon_days: horizon,
      }),
  });

  const result = predict.data;

  return (
    <Modal open onClose={onClose} ariaLabel="Predict policy lapse" size="md" testId="lapse-predict">
      <div className="space-y-3" data-testid="lapse-predict-modal">
        <div className="flex items-center justify-between border-b border-divider pb-3">
          <h2 className="section-title">Predict policy lapse</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>
        <Field label="Customer ID">
          <input className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Missed instalments (12m)">
            <input
              type="number"
              min={0}
              className="input"
              value={missed}
              onChange={(e) => setMissed(Number(e.target.value))}
            />
          </Field>
          <Field label="Days since last payment">
            <input
              type="number"
              min={0}
              className="input"
              value={daysSince}
              onChange={(e) => setDaysSince(Number(e.target.value))}
            />
          </Field>
          <Field label="Prior lapses">
            <input
              type="number"
              min={0}
              className="input"
              value={priorLapses}
              onChange={(e) => setPriorLapses(Number(e.target.value))}
            />
          </Field>
          <Field label="Horizon (days)">
            <select className="input" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              <option value={30}>30</option>
              <option value={60}>60</option>
              <option value={90}>90</option>
            </select>
          </Field>
        </div>

        <Button onClick={() => predict.mutate()} disabled={predict.isPending} data-testid="lapse-predict-run">
          {predict.isPending ? 'Scoring…' : 'Score lapse risk'}
        </Button>

        {result && (
          <div className="mt-2 rounded-card border border-divider p-4" data-testid="lapse-predict-result">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Lapse probability</span>
              <span className="text-2xl font-bold tabular">{fmtPct(result.lapse_probability)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Retention band</span>
              <Badge tone={BAND_TONE[result.retention_risk_band]}>{result.retention_risk_band}</Badge>
            </div>
            <p className="mt-3 text-xs font-medium text-muted">Top drivers</p>
            <ul className="mt-1 space-y-1">
              {result.top_drivers.map((d) => (
                <li key={d.feature} className="flex items-center justify-between text-xs">
                  <span>{d.feature}</span>
                  <span
                    className="tabular font-semibold"
                    style={{ color: d.contribution >= 0 ? BAND_COLOR.high : BAND_COLOR.low }}
                  >
                    {d.contribution >= 0 ? '+' : ''}
                    {d.contribution.toFixed(3)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-ink-sub leading-snug border-t border-divider pt-2">
              {result.recommended_action}
            </p>
          </div>
        )}
        {predict.isError && (
          <p className="text-xs text-danger" role="alert">
            {predict.error.message}
          </p>
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
