// web/src/modules/predictive/PredictiveRiskCenterPage.tsx
//
// Predictive Risk Center — landing page.
//
// 11th IA addition this session. Additive overlay — existing dashboards /
// Executive Cockpit / Role-Based Dashboard / Recovery Center untouched.
// Mounted at /predictive-risk-center. Gated inside the page; sidebar entry
// visible to admin / supervisor / risk_analyst.
//
// Sections rendered (one Panel each):
//   1. Horizon picker
//   2. Predictive overview KPI strip
//   3. Domain forecasts (banking / insurance tabs × 7 predictions × 4 horizons)
//   4. Risk Evolution Timeline (historical + current + predicted) + AI Explanation
//   5. Signal Explorer (currently-active early-warning signals)
//   6. Prescriptive Actions (issuable recommendations per selected prediction)
//   7. Executive Forecasts (enterprise / country / tenant / portfolio rollups)
//
// Production wire-up (BFF): replaces the deterministic engine resolvers
// with GET /predictive-forecasts, /predictive-signals, /predictive-scores,
// POST /predictive-recommendations. Shape stays stable.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  ArrowRight, BarChart3, ChevronRight, Compass, Crown,
  Gauge, Globe, Lightbulb, LineChart as LineChartIcon, ListChecks,
  Radar, ShieldAlert, Sparkles, Target, TrendingDown, TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import {
  AreaChart, Area, CartesianGrid, Legend, ResponsiveContainer,
  Tooltip, XAxis, YAxis, ReferenceLine,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  BANKING_PREDICTIONS,
  buildExecutiveForecast,
  buildRiskTimeline,
  canAccessPredictiveRiskCenter,
  DEFAULT_THRESHOLDS,
  EXECUTIVE_FORECAST_SCOPES,
  FORECAST_HORIZONS,
  INSURANCE_PREDICTIONS,
  predictBankingSuite,
  predictInsuranceSuite,
  RISK_LEVELS,
  type ExecutiveForecastScope,
  type ForecastHorizon,
  type PredictionForecast,
  type PredictionKind,
  type RiskLevel,
} from './predictiveRiskEngine';
import { listActiveSignals, type SignalSeverity } from './predictiveSignals';
import { buildExplanation } from './predictiveExplanations';
import { recommendationsFor } from './predictiveRecommendations';

const ACTIVE_TENANT = 'BANK_DEMO';

const BAND_TONE: Record<RiskLevel, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  moderate: 'warning',
  high: 'danger',
  severe: 'danger',
  critical: 'danger',
};

const TREND_ICON: Record<PredictionForecast['trend'], LucideIcon> = {
  rising: TrendingUp,
  falling: TrendingDown,
  flat: ArrowRight,
};

const SCOPE_LABEL: Record<ExecutiveForecastScope, string> = {
  enterprise: 'Enterprise',
  country: 'Country',
  tenant: 'Tenant',
  portfolio: 'Portfolio',
};

const SCOPE_ICON: Record<ExecutiveForecastScope, LucideIcon> = {
  enterprise: Globe,
  country: Compass,
  tenant: Crown,
  portfolio: BarChart3,
};

const SEVERITY_TONE: Record<SignalSeverity, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  moderate: 'warning',
  high: 'danger',
  severe: 'danger',
  critical: 'danger',
};

function fmtPct(score: number): string {
  return `${score}%`;
}

function fmtConfidence(c: number): string {
  return `${Math.round(c * 100)}%`;
}

function fmtDelta(delta: number): string {
  if (delta > 0) return `+${delta} pp`;
  if (delta < 0) return `${delta} pp`;
  return '±0 pp';
}

function titleWithIcon(label: string, icon: LucideIcon, sub?: string): ReactNode {
  const Icon = icon;
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-orange-400" aria-hidden />
      <span>{label}</span>
      {sub && <span className="text-xs font-normal text-slate-400 ml-2">{sub}</span>}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────────────────

function ForecastChart({ forecast }: { forecast: PredictionForecast }) {
  const data = forecast.points.map((p) => ({
    day: `${p.day_offset >= 0 ? '+' : ''}${p.day_offset}d`,
    score: p.score,
    lower: p.lower_bound,
    upper: p.upper_bound,
  }));
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id={`grad-${forecast.kind}-${forecast.horizon}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F97316" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#F97316" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="day" stroke="rgba(255,255,255,0.45)" fontSize={11} />
          <YAxis domain={[0, 100]} stroke="rgba(255,255,255,0.45)" fontSize={11} width={32} />
          <Tooltip
            contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(249,115,22,0.5)', color: '#fff', borderRadius: 8 }}
            labelStyle={{ color: '#F97316' }}
          />
          <ReferenceLine y={DEFAULT_THRESHOLDS.high} stroke="#F59E0B" strokeDasharray="3 3" />
          <ReferenceLine y={DEFAULT_THRESHOLDS.severe} stroke="#EF4444" strokeDasharray="3 3" />
          <Area
            type="monotone"
            dataKey="score"
            stroke="#F97316"
            strokeWidth={2}
            fill={`url(#grad-${forecast.kind}-${forecast.horizon})`}
            name="Predicted score"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface ForecastGridProps {
  forecasts: PredictionForecast[];
  onPickPrediction: (kind: PredictionKind) => void;
  selectedKind: PredictionKind | null;
}

function ForecastGrid({ forecasts, onPickPrediction, selectedKind }: ForecastGridProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
      {forecasts.map((f) => {
        const TrendIcon = TREND_ICON[f.trend];
        const isSelected = selectedKind === f.kind;
        return (
          <button
            key={f.kind}
            type="button"
            onClick={() => onPickPrediction(f.kind)}
            data-testid={`forecast-card-${f.kind}`}
            className={`text-left rounded-xl border p-3 transition ${
              isSelected
                ? 'border-orange-500/80 bg-orange-950/30 shadow-lg shadow-orange-500/20'
                : 'border-slate-700/60 bg-slate-900/40 hover:border-orange-500/50 hover:bg-slate-900/70'
            }`}
          >
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="text-xs font-mono uppercase tracking-wider text-slate-400">{f.kind}</div>
                <div className="text-sm font-semibold text-white mt-0.5">{f.label}</div>
              </div>
              <Badge tone={BAND_TONE[f.forecast_band]}>{f.forecast_band}</Badge>
            </div>
            <div className="flex items-end gap-3 mb-2">
              <div className="text-2xl font-bold text-white tabular-nums">{fmtPct(f.forecast_score)}</div>
              <div className="text-xs text-slate-400 pb-1">at +{f.horizon}d</div>
            </div>
            <div className="flex items-center gap-3 text-xs mb-2">
              <span className="text-slate-400">Now {fmtPct(f.current_score)}</span>
              <span className={`flex items-center gap-1 ${f.trend === 'rising' ? 'text-orange-400' : f.trend === 'falling' ? 'text-emerald-400' : 'text-slate-400'}`}>
                <TrendIcon className="size-3" /> {fmtDelta(f.delta_pp)}
              </span>
              <span className="text-slate-500">conf {fmtConfidence(f.confidence)}</span>
            </div>
            <ForecastChart forecast={f} />
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export function PredictiveRiskCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessPredictiveRiskCenter(user.roles)) {
    return <Navigate to="/" replace />;
  }

  const asOf = useMemo(() => new Date(), []);
  const [horizon, setHorizon] = useState<ForecastHorizon>(90);
  const [selectedKind, setSelectedKind] = useState<PredictionKind>('npa_probability');
  const [domainTab, setDomainTab] = useState<'banking' | 'insurance'>('banking');
  const [signalFilter, setSignalFilter] = useState<'all' | 'banking' | 'insurance'>('all');
  const [scope, setScope] = useState<ExecutiveForecastScope>('enterprise');

  const bankingSuite = useMemo(
    () => predictBankingSuite(ACTIVE_TENANT, horizon, asOf),
    [horizon, asOf],
  );
  const insuranceSuite = useMemo(
    () => predictInsuranceSuite(ACTIVE_TENANT, horizon, asOf),
    [horizon, asOf],
  );
  const selectedForecast = useMemo(
    () => [...bankingSuite, ...insuranceSuite].find((f) => f.kind === selectedKind) ?? bankingSuite[0],
    [bankingSuite, insuranceSuite, selectedKind],
  );
  const timeline = useMemo(
    () => buildRiskTimeline(ACTIVE_TENANT, selectedForecast.kind, horizon, asOf),
    [selectedForecast, horizon, asOf],
  );
  const explanation = useMemo(
    () => buildExplanation(selectedForecast, asOf),
    [selectedForecast, asOf],
  );
  const recommendations = useMemo(
    () => recommendationsFor(explanation),
    [explanation],
  );
  const signals = useMemo(
    () => listActiveSignals(ACTIVE_TENANT, asOf, signalFilter === 'all' ? undefined : { domain: signalFilter }),
    [asOf, signalFilter],
  );
  const executiveRows = useMemo(
    () => buildExecutiveForecast(scope, horizon, asOf),
    [scope, horizon, asOf],
  );

  const overviewKpis = useMemo(() => {
    const all = [...bankingSuite, ...insuranceSuite];
    const critical = all.filter((f) => f.forecast_band === 'critical').length;
    const severe = all.filter((f) => f.forecast_band === 'severe').length;
    const risingCount = all.filter((f) => f.trend === 'rising').length;
    const avgConfidence = all.reduce((a, f) => a + f.confidence, 0) / all.length;
    return { critical, severe, risingCount, avgConfidence, total: all.length };
  }, [bankingSuite, insuranceSuite]);

  const horizonChips: ForecastHorizon[] = useMemo(() => [...FORECAST_HORIZONS] as ForecastHorizon[], []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Predictive Risk Center"
        subtitle="Forward-looking risk intelligence across banking + insurance — 30 / 60 / 90 / 180-day forecasts with confidence bands, SHAP-style drivers, and prescriptive actions."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="warning"><Radar className="size-3 mr-1 inline" />Predictive</Badge>
            <Badge tone="neutral">Tenant: {ACTIVE_TENANT}</Badge>
          </div>
        }
      />

      {/* Horizon picker — applied to every section below */}
      <Panel
        title={titleWithIcon('Forecast horizon', Gauge)}
        data-testid="cockpit-section-horizon"
      >
        <div className="flex items-center gap-2 flex-wrap">
          {horizonChips.map((h) => {
            const active = h === horizon;
            return (
              <button
                key={h}
                type="button"
                onClick={() => setHorizon(h)}
                data-testid={`horizon-${h}`}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition border ${
                  active
                    ? 'border-orange-500 bg-orange-500/15 text-orange-300'
                    : 'border-slate-700 bg-slate-900/40 text-slate-300 hover:border-orange-500/60'
                }`}
              >
                +{h} days
              </button>
            );
          })}
          <span className="text-xs text-slate-500 ml-2">
            Bands: {RISK_LEVELS.join(' / ')} · default thresholds {DEFAULT_THRESHOLDS.moderate}/{DEFAULT_THRESHOLDS.high}/{DEFAULT_THRESHOLDS.severe}/{DEFAULT_THRESHOLDS.critical}
          </span>
        </div>
      </Panel>

      {/* Overview KPI strip */}
      <Panel
        title={titleWithIcon('Predictive overview', Sparkles)}
        data-testid="cockpit-section-overview"
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <MetricCard
            label="Predictions tracked"
            value={String(overviewKpis.total)}
            sub="banking + insurance"
            testId="kpi-total"
          />
          <MetricCard
            label="Critical band"
            value={String(overviewKpis.critical)}
            sub={`at +${horizon}d horizon`}
            tone={overviewKpis.critical > 0 ? 'danger' : 'success'}
            testId="kpi-critical"
          />
          <MetricCard
            label="Severe band"
            value={String(overviewKpis.severe)}
            sub={`at +${horizon}d horizon`}
            tone={overviewKpis.severe > 0 ? 'warning' : 'success'}
            testId="kpi-severe"
          />
          <MetricCard
            label="Rising trend"
            value={String(overviewKpis.risingCount)}
            sub="forecasts trending up"
            testId="kpi-rising"
          />
          <MetricCard
            label="Avg confidence"
            value={fmtConfidence(overviewKpis.avgConfidence)}
            sub="across all forecasts"
            testId="kpi-confidence"
          />
        </div>
      </Panel>

      {/* Domain forecasts (tabs) */}
      <Panel
        title={titleWithIcon('Domain forecasts', LineChartIcon)}
        action={
          <div className="flex gap-1.5">
            {(['banking', 'insurance'] as const).map((d) => {
              const active = d === domainTab;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDomainTab(d)}
                  data-testid={`domain-tab-${d}`}
                  className={`px-3 py-1 rounded text-xs font-medium transition ${
                    active
                      ? 'bg-orange-500/15 text-orange-300 border border-orange-500'
                      : 'bg-slate-900/40 text-slate-400 border border-slate-700 hover:border-orange-500/60'
                  }`}
                >
                  {d === 'banking' ? `Banking (${BANKING_PREDICTIONS.length})` : `Insurance (${INSURANCE_PREDICTIONS.length})`}
                </button>
              );
            })}
          </div>
        }
        data-testid="cockpit-section-forecasts"
      >
        <ForecastGrid
          forecasts={domainTab === 'banking' ? bankingSuite : insuranceSuite}
          onPickPrediction={setSelectedKind}
          selectedKind={selectedKind}
        />
      </Panel>

      {/* Risk Evolution Timeline + AI Explanation (side-by-side) */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          <Panel
            title={titleWithIcon(
              `Risk evolution — ${selectedForecast.label}`,
              Target,
              `History (${timeline.history_window_days}d) · current · forecast (+${horizon}d)`,
            )}
            data-testid="cockpit-section-timeline"
          >
            <div className="h-56 w-full">
              <ResponsiveContainer>
                <AreaChart
                  data={timeline.points.map((p) => ({
                    day: `${p.day_offset >= 0 ? '+' : ''}${p.day_offset}d`,
                    score: p.score,
                    historical: p.source === 'historical' ? p.score : null,
                    current: p.source === 'current' ? p.score : null,
                    predicted: p.source === 'predicted' ? p.score : null,
                  }))}
                  margin={{ top: 4, right: 12, bottom: 0, left: -12 }}
                >
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="day" stroke="rgba(255,255,255,0.45)" fontSize={11} />
                  <YAxis domain={[0, 100]} stroke="rgba(255,255,255,0.45)" fontSize={11} width={32} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(249,115,22,0.5)', color: '#fff', borderRadius: 8 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine x="+0d" stroke="#F97316" strokeDasharray="2 4" label={{ value: 'Now', fill: '#F97316', fontSize: 10 }} />
                  <ReferenceLine y={DEFAULT_THRESHOLDS.severe} stroke="#EF4444" strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="historical" stroke="#94A3B8" fill="rgba(148,163,184,0.20)" name="Historical" connectNulls />
                  <Area type="monotone" dataKey="current" stroke="#3B82F6" fill="#3B82F6" name="Current" />
                  <Area type="monotone" dataKey="predicted" stroke="#F97316" fill="rgba(249,115,22,0.30)" name="Predicted" connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>

        <Panel
          title={titleWithIcon(
            'AI explanation',
            Lightbulb,
            `${explanation.model_id} v${explanation.model_version} · ${fmtConfidence(explanation.confidence)} confidence`,
          )}
          data-testid="cockpit-section-explanation"
        >
          <div className="space-y-3">
            <div className="rounded-lg border border-orange-500/40 bg-orange-950/20 p-3">
              <div className="text-xs uppercase tracking-wider text-orange-300 font-mono">Prediction score</div>
              <div className="text-3xl font-bold text-white tabular-nums">{fmtPct(explanation.prediction_score)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 font-mono">Key drivers (SHAP)</div>
              <div className="space-y-1.5">
                {explanation.top_drivers.map((d) => (
                  <div key={d.feature} className="flex items-center justify-between text-xs">
                    <div>
                      <div className="text-slate-200 font-medium">{d.display_label}</div>
                      <div className="text-slate-500 font-mono">{d.feature} = {d.human_value}</div>
                    </div>
                    <span className={d.direction === 'up' ? 'text-orange-400 font-mono' : 'text-emerald-400 font-mono'}>
                      {d.shap_value > 0 ? '+' : ''}{d.shap_value.toFixed(3)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 font-mono">Risk factors</div>
              <ul className="space-y-1 text-xs text-slate-300 list-disc list-inside">
                {explanation.risk_factors.map((f, idx) => (
                  <li key={idx}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
        </Panel>
      </div>

      {/* Signal Explorer */}
      <Panel
        title={titleWithIcon('Signal explorer', Radar, `${signals.length} active early-warning signals`)}
        action={
          <div className="flex gap-1.5">
            {(['all', 'banking', 'insurance'] as const).map((f) => {
              const active = f === signalFilter;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setSignalFilter(f)}
                  data-testid={`signal-filter-${f}`}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                    active
                      ? 'bg-orange-500/15 text-orange-300 border border-orange-500'
                      : 'bg-slate-900/40 text-slate-400 border border-slate-700 hover:border-orange-500/60'
                  }`}
                >
                  {f}
                </button>
              );
            })}
          </div>
        }
        data-testid="cockpit-section-signals"
      >
        {signals.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-6">No active signals match this filter.</div>
        ) : (
          <div className="space-y-1.5">
            {signals.slice(0, 12).map((s) => (
              <div
                key={s.observation_id}
                data-testid={`signal-row-${s.signal_id}`}
                className="flex items-start justify-between gap-3 rounded border border-slate-800 bg-slate-900/30 p-2.5"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <ShieldAlert className="size-4 text-orange-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{s.label}</div>
                    <div className="text-xs text-slate-500 truncate">{s.description}</div>
                    <div className="text-xs text-slate-400 mt-1 font-mono">
                      {s.entity_id} · feeds: {s.feeds_predictions.slice(0, 2).join(', ')}{s.feeds_predictions.length > 2 ? ' …' : ''}
                    </div>
                  </div>
                </div>
                <Badge tone={SEVERITY_TONE[s.severity]}>{s.severity}</Badge>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Prescriptive Actions */}
      <Panel
        title={titleWithIcon(
          'Prescriptive actions',
          ListChecks,
          `${recommendations.length} recommended for ${selectedForecast.label}`,
        )}
        data-testid="cockpit-section-actions"
      >
        {recommendations.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-4">No prescriptive actions recommended.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {recommendations.map((r) => (
              <div
                key={r.action_id}
                data-testid={`action-card-${r.action_id}`}
                className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 hover:border-orange-500/50 transition"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-sm font-semibold text-white">{r.label}</div>
                  {r.requires_maker_checker && <Badge tone="warning">maker-checker</Badge>}
                </div>
                <div className="text-xs text-slate-400 mb-2">{r.description}</div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-mono">assignee: {r.default_assignee_role}</span>
                  <button
                    type="button"
                    data-testid={`action-issue-${r.action_id}`}
                    className="px-2.5 py-1 rounded bg-orange-500/15 text-orange-300 hover:bg-orange-500/25 border border-orange-500/40 font-medium transition flex items-center gap-1"
                  >
                    Issue <ChevronRight className="size-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Executive Forecasts */}
      <Panel
        title={titleWithIcon('Executive forecasts', Crown, `${SCOPE_LABEL[scope]} rollup at +${horizon}d`)}
        action={
          <div className="flex gap-1.5">
            {EXECUTIVE_FORECAST_SCOPES.map((s) => {
              const active = s === scope;
              const Icon = SCOPE_ICON[s];
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  data-testid={`exec-scope-${s}`}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition flex items-center gap-1 ${
                    active
                      ? 'bg-orange-500/15 text-orange-300 border border-orange-500'
                      : 'bg-slate-900/40 text-slate-400 border border-slate-700 hover:border-orange-500/60'
                  }`}
                >
                  <Icon className="size-3" /> {SCOPE_LABEL[s]}
                </button>
              );
            })}
          </div>
        }
        data-testid="cockpit-section-executive"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">Entity</th>
                <th className="text-left py-2 px-3">Forecast</th>
                <th className="text-left py-2 px-3">Band</th>
                <th className="text-left py-2 px-3">Δ</th>
                <th className="text-left py-2 px-3">Trend</th>
                <th className="text-left py-2 px-3">Confidence</th>
                <th className="text-left py-2 px-3">Top driver</th>
              </tr>
            </thead>
            <tbody>
              {executiveRows.map((e) => {
                const TrendIcon = TREND_ICON[e.trend];
                return (
                  <tr
                    key={e.entity_id}
                    data-testid={`exec-row-${e.entity_id}`}
                    className="border-b border-slate-900/50 hover:bg-slate-900/30 transition"
                  >
                    <td className="py-2.5 px-3 font-mono text-slate-300">{e.entity_label}</td>
                    <td className="py-2.5 px-3 text-white font-bold tabular-nums">{fmtPct(e.forecast_score)}</td>
                    <td className="py-2.5 px-3"><Badge tone={BAND_TONE[e.forecast_band]}>{e.forecast_band}</Badge></td>
                    <td className="py-2.5 px-3 text-slate-300 tabular-nums">{fmtDelta(e.delta_pp)}</td>
                    <td className="py-2.5 px-3">
                      <span className={`flex items-center gap-1 text-xs ${e.trend === 'rising' ? 'text-orange-400' : e.trend === 'falling' ? 'text-emerald-400' : 'text-slate-400'}`}>
                        <TrendIcon className="size-3" /> {e.trend}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-slate-400 tabular-nums">{fmtConfidence(e.confidence)}</td>
                    <td className="py-2.5 px-3 text-slate-400 font-mono text-xs">{e.top_kind ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Cross-IA navigation footer */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1">
        <span>Cross-IA:</span>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/executive-cockpit">Executive Cockpit</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/dashboards/role-based">Role Dashboard</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/analytics">Analytics</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/admin/governance">Governance</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/audit-center">Audit Center</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/recovery-center">Recovery</Link>
      </div>
    </div>
  );
}
