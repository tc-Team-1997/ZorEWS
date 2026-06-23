// web/src/modules/insurance/SolvencyWatchPage.tsx
//
// Insurance EWS — Module 4: Solvency Watch (IRDAI).
//
// 4 widgets per the spec (current solvency ratio · forecast solvency trend
// · capital stress simulation · compliance alerts) + an ad-hoc forecast
// drawer. Backed by /v1/insurance/solvency/{dashboard,forecast,compliance}.

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { TrendingDown, ShieldCheck, Activity } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  SolvencyDashboardShape,
  SolvencyStatusShape,
  SolvencyForecastShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, Modal, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildSolvencyReportData } from './solvencyReportAdapter';
import { color } from '@/styles/tokens';

const CONTROL_LEVEL = 1.5;
const fmtKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0, notation: 'compact' }).format(n);
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtRatio = (n: number) => n.toFixed(2);

const STATUS_TONE: Record<SolvencyStatusShape, BadgeTone> = {
  compliant: 'success',
  watch: 'warning',
  breach: 'danger',
};
const SEV_TONE: Record<string, BadgeTone> = {
  critical: 'danger',
  warning: 'warning',
  info: 'blue',
};

export function SolvencyWatchPage() {
  const me = useAuth((s) => s.user);
  const [forecastOpen, setForecastOpen] = useState(false);

  const { data, isLoading } = useQuery<SolvencyDashboardShape>({
    queryKey: ['insurance', 'solvency', 'dashboard'],
    queryFn: () => api.insuranceSolvencyDashboard(),
  });

  return (
    <div>
      <PageHeader
        title="Solvency Watch"
        subtitle="IRDAI solvency ratio · forecasting · capital stress · compliance"
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setForecastOpen(true)} data-testid="solvency-forecast-open">
              <Activity size={15} className="mr-1.5 -ml-0.5" /> Run forecast
            </Button>
            {/* Enterprise export (P3) — RBAC-gated; renders null without
                reports:export. Reports the IRDAI compliance-alerts list + solvency KPIs. */}
            <ExportButton
              module="solvency"
              reportType="compliance"
              adapter={(config) =>
                buildSolvencyReportData(
                  {
                    current: {
                      solvency_ratio: data?.current.solvency_ratio ?? 0,
                      control_level: data?.current.control_level ?? 0,
                      available_solvency_margin_kes: data?.current.available_solvency_margin_kes ?? 0,
                      required_solvency_margin_kes: data?.current.required_solvency_margin_kes ?? 0,
                      capital_adequacy_pct: data?.current.capital_adequacy_pct ?? 0,
                      status: data?.current.status ?? '—',
                    },
                    totals: {
                      open_alerts: data?.totals.open_alerts ?? 0,
                      critical_alerts: data?.totals.critical_alerts ?? 0,
                      min_forecast_ratio: data?.totals.min_forecast_ratio ?? 0,
                      breach_horizon_days: data?.totals.breach_horizon_days ?? null,
                    },
                    compliance_alerts: data?.compliance_alerts ?? [],
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
          <p className="caption" data-testid="solvency-loading">Loading solvency position…</p>
        </Panel>
      ) : (
        <div className="space-y-5" data-testid="solvency-dashboard">
          {/* ── Current solvency ratio + KPI row ────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard
              label="Solvency ratio"
              value={fmtRatio(data.current.solvency_ratio)}
              tone={STATUS_TONE[data.current.status]}
              sub={data.current.status}
              testId="solvency-ratio-card"
            />
            <MetricCard label="Control level" value={fmtRatio(data.current.control_level)} sub="IRDAI floor" />
            <MetricCard label="Available margin" value={fmtKES(data.current.available_solvency_margin_kes)} tone="blue" />
            <MetricCard label="Required margin" value={fmtKES(data.current.required_solvency_margin_kes)} />
            <MetricCard
              label="Open alerts"
              value={data.totals.open_alerts}
              tone={data.totals.critical_alerts > 0 ? 'danger' : 'warning'}
              sub={`${data.totals.critical_alerts} critical`}
            />
          </div>

          {/* ── Forecast solvency trend ─────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <TrendingDown size={16} className="text-brand-blue" />
              <h2 className="section-title">Forecast solvency trend</h2>
              {data.totals.breach_horizon_days != null && (
                <Badge tone="danger">projected breach in {data.totals.breach_horizon_days}d</Badge>
              )}
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data.forecast_trend} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis domain={[1, 'auto']} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: number) => [fmtRatio(v), 'Solvency ratio']} />
                <ReferenceLine y={CONTROL_LEVEL} stroke={color.danger} strokeDasharray="4 4" label={{ value: 'IRDAI 1.50', position: 'right', fontSize: 10, fill: color.danger }} />
                <Line
                  type="monotone"
                  dataKey="solvency_ratio"
                  stroke={color.blue}
                  strokeWidth={2}
                  dot={(props: { cx?: number; cy?: number; payload?: { is_forecast?: boolean; status?: SolvencyStatusShape } }) => {
                    const { cx, cy, payload } = props;
                    const fc = payload?.is_forecast;
                    const fill = payload?.status === 'breach' ? color.danger : payload?.status === 'watch' ? color.warning : color.blue;
                    return (
                      <circle
                        key={`${cx}-${cy}`}
                        cx={cx}
                        cy={cy}
                        r={fc ? 4 : 3}
                        fill={fc ? '#fff' : fill}
                        stroke={fill}
                        strokeWidth={fc ? 2 : 1}
                      />
                    );
                  }}
                />
              </LineChart>
            </ResponsiveContainer>
            <p className="caption mt-1">Hollow dots = forecast · dashed red = IRDAI control level (1.50)</p>
          </Panel>

          {/* ── Capital stress simulation ───────────────────────────── */}
          <Panel>
            <h2 className="section-title mb-3">Capital stress simulation</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="stress-simulation">
              {data.capital_stress_simulation.map((s) => (
                <div key={s.scenario} className="rounded-card border border-divider p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold capitalize">{s.scenario}</span>
                    <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                  </div>
                  <p className="mt-2 text-2xl font-bold tabular">{fmtRatio(s.projected_ratio)}</p>
                  <p className="caption">projected ratio @ +{fmtPct(s.claims_growth_pct)} claims</p>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-muted">Breach prob.</span>
                    <span className="font-semibold text-danger">{fmtPct(s.breach_probability)}</span>
                  </div>
                  {s.capital_shortfall_kes > 0 && (
                    <p className="mt-1 text-[11px] text-danger">Shortfall {fmtKES(s.capital_shortfall_kes)}</p>
                  )}
                </div>
              ))}
            </div>
          </Panel>

          {/* ── Compliance alerts ───────────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck size={16} className="text-danger" />
              <h2 className="section-title">Compliance alerts (IRDAI)</h2>
            </div>
            {data.compliance_alerts.length === 0 ? (
              <p className="caption" data-testid="compliance-empty">No open compliance alerts — solvency within IRDAI bounds.</p>
            ) : (
              <div className="space-y-2" data-testid="compliance-alerts">
                {data.compliance_alerts.map((a) => (
                  <div key={a.alert_id} className="flex items-start justify-between gap-3 rounded border border-divider p-2.5">
                    <div className="min-w-0">
                      <p className="text-sm">{a.message}</p>
                      <p className="font-mono text-[11px] text-muted mt-0.5">{a.rule_code} · {a.regulator}</p>
                    </div>
                    <Badge tone={SEV_TONE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <p className="caption text-right">
            Model {data.model_version} · generated {new Date(data.generated_at).toLocaleString()}
          </p>
        </div>
      )}

      {forecastOpen && <ForecastModal onClose={() => setForecastOpen(false)} />}
    </div>
  );
}

// ── Ad-hoc forecast ────────────────────────────────────────────────────

function ForecastModal({ onClose }: { onClose: () => void }) {
  const [currentRatio, setCurrentRatio] = useState(1.7);
  const [claimsGrowth, setClaimsGrowth] = useState(0.2);
  const [premiumGrowth, setPremiumGrowth] = useState(0.05);
  const [scenario, setScenario] = useState('adverse');
  const [horizon, setHorizon] = useState(90);

  const forecast = useMutation<SolvencyForecastShape, Error>({
    mutationFn: () =>
      api.insuranceSolvencyForecast({
        current_ratio: currentRatio,
        claims_growth_pct: claimsGrowth,
        premium_growth_pct: premiumGrowth,
        scenario,
        horizon_days: horizon,
      }),
  });
  const result = forecast.data;

  return (
    <Modal open onClose={onClose} ariaLabel="Run solvency forecast" size="md" testId="solvency-forecast">
      <div className="space-y-3" data-testid="solvency-forecast-modal">
        <div className="flex items-center justify-between border-b border-divider pb-3">
          <h2 className="section-title">Run solvency forecast</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Current ratio">
            <input type="number" min={0.5} step={0.05} className="input" value={currentRatio} onChange={(e) => setCurrentRatio(Number(e.target.value))} />
          </Field>
          <Field label="Claims growth (0–1)">
            <input type="number" min={0} step={0.05} className="input" value={claimsGrowth} onChange={(e) => setClaimsGrowth(Number(e.target.value))} />
          </Field>
          <Field label="Premium growth (0–1)">
            <input type="number" min={0} step={0.05} className="input" value={premiumGrowth} onChange={(e) => setPremiumGrowth(Number(e.target.value))} />
          </Field>
          <Field label="Horizon (days)">
            <select className="input" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              <option value={30}>30</option>
              <option value={60}>60</option>
              <option value={90}>90</option>
            </select>
          </Field>
          <Field label="Scenario">
            <select className="input" value={scenario} onChange={(e) => setScenario(e.target.value)}>
              <option value="baseline">Baseline</option>
              <option value="adverse">Adverse</option>
              <option value="severe">Severe</option>
            </select>
          </Field>
        </div>

        <Button onClick={() => forecast.mutate()} disabled={forecast.isPending} data-testid="solvency-forecast-run">
          {forecast.isPending ? 'Projecting…' : 'Project solvency'}
        </Button>

        {result && (
          <div className="mt-2 rounded-card border border-divider p-4" data-testid="solvency-forecast-result">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Projected ratio</span>
              <span className="text-2xl font-bold tabular">{fmtRatio(result.projected_ratio)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Status</span>
              <Badge tone={STATUS_TONE[result.status]}>{result.status}</Badge>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Breach probability</span>
              <span className="font-semibold tabular text-danger">{fmtPct(result.breach_probability)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="text-muted">Baseline {fmtRatio(result.baseline_ratio)} → {result.horizon_days}d / {result.scenario}</span>
            </div>
            {result.capital_shortfall_kes != null && result.capital_shortfall_kes > 0 && (
              <p className="mt-2 text-[11px] text-danger border-t border-divider pt-2">
                Capital shortfall to control level: {fmtKES(result.capital_shortfall_kes)}
              </p>
            )}
          </div>
        )}
        {forecast.isError && (
          <p className="text-xs text-danger" role="alert">{forecast.error.message}</p>
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
