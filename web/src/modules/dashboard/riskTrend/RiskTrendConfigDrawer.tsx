// web/src/modules/dashboard/riskTrend/RiskTrendConfigDrawer.tsx
//
// Enterprise Risk Trend Intelligence Configuration — 3-panel drawer.
// Left sidebar (sections) | Center (controls) | Right (live preview).
// Fully additive — no existing component is modified.

import { useState, useMemo } from 'react';
import {
  BarChart3,
  FileText,
  Filter,
  Globe,
  Layout,
  Save,
  Shield,
  Sparkles,
  Target,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  ReferenceLine,
} from 'recharts';

import { Button } from '@/components/ui/Button';
import {
  type RiskTrendConfig,
  type RiskDomain,
  type MetricType,
  type AlertSource,
  type BenchmarkPeriod,
  type RoleTemplate,
  type SeverityThreshold,
  ALL_DOMAINS,
  ALL_METRICS,
  ALL_SOURCES,
  ALL_ROLE_TEMPLATES,
  getDomainLabel,
  getMetricLabel,
  getSourceLabel,
  ROLE_TEMPLATE_LABELS,
} from './riskTrendConfigurationEngine';
import { getBenchmarkLabel } from './riskTrendBenchmarkEngine';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface RiskTrendConfigDrawerProps {
  open: boolean;
  onClose: () => void;
  config: RiskTrendConfig;
  onChange: (config: RiskTrendConfig) => void;
  onSave: (config: RiskTrendConfig, asDefault?: boolean) => void;
  onApplyToRole?: (template: RoleTemplate) => void;
  onReset: () => void;
  currentRole?: string;
}

// ─── Section definitions ──────────────────────────────────────────────────────

type SectionId =
  | 'domains'
  | 'metrics'
  | 'severity'
  | 'forecast'
  | 'benchmark'
  | 'sources'
  | 'executive'
  | 'persistence'
  | 'visual'
  | 'audit';

interface Section {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
}

const SECTIONS: Section[] = [
  { id: 'domains',     label: 'Risk Domains',       icon: <Globe className="h-4 w-4" /> },
  { id: 'metrics',     label: 'Metric Config',       icon: <BarChart3 className="h-4 w-4" /> },
  { id: 'severity',    label: 'Severity Intelligence', icon: <Shield className="h-4 w-4" /> },
  { id: 'forecast',    label: 'AI Forecast',         icon: <Sparkles className="h-4 w-4" /> },
  { id: 'benchmark',   label: 'Benchmark',           icon: <TrendingUp className="h-4 w-4" /> },
  { id: 'sources',     label: 'Alert Sources',       icon: <Filter className="h-4 w-4" /> },
  { id: 'executive',   label: 'Executive View',      icon: <Target className="h-4 w-4" /> },
  { id: 'persistence', label: 'Persistence',         icon: <Save className="h-4 w-4" /> },
  { id: 'visual',      label: 'Visual Settings',     icon: <Layout className="h-4 w-4" /> },
  { id: 'audit',       label: 'Audit',               icon: <FileText className="h-4 w-4" /> },
];

// ─── Mini chart preview helpers ───────────────────────────────────────────────

function generatePreviewData(config: RiskTrendConfig) {
  const points = 14;
  return Array.from({ length: points }, (_, i) => {
    const base = 30 + Math.sin((i / points) * Math.PI * 2) * 15 + i * 0.8;
    return {
      name: `D${i + 1}`,
      value: Math.round(base),
      forecast: i >= 10 ? Math.round(base + 3 + i * 0.5) : undefined,
      benchmark: config.benchmark != null ? Math.round(base * 1.12) : undefined,
    };
  });
}

// ─── Individual section panes ─────────────────────────────────────────────────

function SectionDomains({ config, onChange }: { config: RiskTrendConfig; onChange: (c: RiskTrendConfig) => void }) {
  const toggle = (d: RiskDomain) => {
    const next = config.domains.includes(d)
      ? config.domains.filter((x) => x !== d)
      : [...config.domains, d];
    if (next.length > 0) onChange({ ...config, domains: next });
  };
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Select Risk Domains</h3>
      <p className="text-xs text-slate-500 mb-4">Choose the risk domains to include in the trend analysis. At least one must be selected.</p>
      <div className="grid grid-cols-2 gap-2" data-testid="domain-grid">
        {ALL_DOMAINS.map((d) => {
          const active = config.domains.includes(d);
          return (
            <label key={d} className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${active ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
              <input
                type="checkbox"
                checked={active}
                onChange={() => toggle(d)}
                className="accent-indigo-600"
                data-testid={`domain-checkbox-${d}`}
              />
              <span className="text-xs font-medium text-slate-700">{getDomainLabel(d)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function SectionMetrics({ config, onChange }: { config: RiskTrendConfig; onChange: (c: RiskTrendConfig) => void }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Primary Metric</h3>
      <p className="text-xs text-slate-500 mb-4">Select the metric to visualise on the trend chart.</p>
      <div className="space-y-2" data-testid="metric-radio-group">
        {ALL_METRICS.map((m) => (
          <label key={m} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${config.metricType === m ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
            <input
              type="radio"
              name="metric_type"
              checked={config.metricType === m}
              onChange={() => onChange({ ...config, metricType: m })}
              className="accent-indigo-600"
              data-testid={`metric-radio-${m}`}
            />
            <span className="text-xs font-medium text-slate-700">{getMetricLabel(m as MetricType)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function SectionSeverity({ config, onChange }: { config: RiskTrendConfig; onChange: (c: RiskTrendConfig) => void }) {
  const updateThreshold = (idx: number, patch: Partial<SeverityThreshold>) => {
    const next = config.severities.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange({ ...config, severities: next });
  };
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Severity Intelligence</h3>
      <p className="text-xs text-slate-500 mb-4">Configure which severity levels to show and their threshold ranges.</p>
      <div className="space-y-3" data-testid="severity-list">
        {config.severities.map((s, idx) => (
          <div key={s.level} className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 bg-white">
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => updateThreshold(idx, { enabled: e.target.checked })}
              className="accent-indigo-600"
              data-testid={`severity-toggle-${s.level}`}
            />
            <span
              className="inline-block w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-xs font-semibold w-16 text-slate-700">{s.label}</span>
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <span>Min</span>
              <input
                type="number"
                value={s.min}
                onChange={(e) => updateThreshold(idx, { min: Number(e.target.value) })}
                className="w-16 px-1.5 py-1 rounded border border-slate-200 text-xs"
                data-testid={`severity-min-${s.level}`}
              />
              <span>Max</span>
              <input
                type="number"
                value={s.max ?? ''}
                placeholder="∞"
                onChange={(e) => updateThreshold(idx, { max: e.target.value ? Number(e.target.value) : null })}
                className="w-16 px-1.5 py-1 rounded border border-slate-200 text-xs"
                data-testid={`severity-max-${s.level}`}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionForecast({ config, onChange }: { config: RiskTrendConfig; onChange: (c: RiskTrendConfig) => void }) {
  const HORIZONS: Array<{ value: 7 | 30 | 60 | 90; label: string }> = [
    { value: 7,  label: '7 days' },
    { value: 30, label: '30 days' },
    { value: 60, label: '60 days' },
    { value: 90, label: '90 days' },
  ];
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">AI Forecast Configuration</h3>
      <label className="flex items-center gap-2 mb-4 cursor-pointer">
        <input
          type="checkbox"
          checked={config.forecast.enabled}
          onChange={(e) => onChange({ ...config, forecast: { ...config.forecast, enabled: e.target.checked } })}
          className="accent-indigo-600"
          data-testid="forecast-enable-toggle"
        />
        <span className="text-sm font-medium text-slate-700">Enable AI Forecast Overlay</span>
      </label>

      {config.forecast.enabled && (
        <div className="space-y-4 pl-4 border-l-2 border-indigo-200">
          <div>
            <p className="text-xs font-medium text-slate-600 mb-2">Forecast Horizon</p>
            <div className="flex flex-wrap gap-2" data-testid="forecast-horizon-radios">
              {HORIZONS.map((h) => (
                <label key={h.value} className={`px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer border transition-colors ${config.forecast.horizon === h.value ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'}`}>
                  <input
                    type="radio"
                    name="forecast_horizon"
                    className="sr-only"
                    checked={config.forecast.horizon === h.value}
                    onChange={() => onChange({ ...config, forecast: { ...config.forecast, horizon: h.value } })}
                    data-testid={`forecast-horizon-${h.value}`}
                  />
                  {h.label}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-600">Advanced Options</p>
            {[
              { key: 'showConfidenceBand', label: 'Show confidence band' },
              { key: 'showDriftDetection', label: 'Enable drift detection' },
              { key: 'showKeyDrivers',     label: 'Show key risk drivers' },
              { key: 'explainLogic',       label: 'Explain forecast logic' },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.forecast[key as keyof typeof config.forecast] as boolean}
                  onChange={(e) => onChange({ ...config, forecast: { ...config.forecast, [key]: e.target.checked } })}
                  className="accent-indigo-600"
                  data-testid={`forecast-option-${key}`}
                />
                <span className="text-xs text-slate-600">{label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const BENCHMARK_OPTIONS: BenchmarkPeriod[] = [
  'previous_period', 'previous_month', 'previous_quarter',
  'previous_year', 'industry_benchmark', 'peer_institutions',
];

function SectionBenchmark({ config, onChange }: { config: RiskTrendConfig; onChange: (c: RiskTrendConfig) => void }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Benchmark Comparison</h3>
      <p className="text-xs text-slate-500 mb-4">Overlay a comparison line on the trend chart to contextualise performance.</p>
      <div className="space-y-2" data-testid="benchmark-radio-group">
        <label className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer ${config.benchmark === null ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
          <input
            type="radio"
            name="benchmark"
            checked={config.benchmark === null}
            onChange={() => onChange({ ...config, benchmark: null })}
            className="accent-indigo-600"
            data-testid="benchmark-none"
          />
          <span className="text-xs font-medium text-slate-700">No Benchmark</span>
        </label>
        {BENCHMARK_OPTIONS.map((b) => (
          <label key={b} className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer ${config.benchmark === b ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
            <input
              type="radio"
              name="benchmark"
              checked={config.benchmark === b}
              onChange={() => onChange({ ...config, benchmark: b })}
              className="accent-indigo-600"
              data-testid={`benchmark-${b}`}
            />
            <span className="text-xs font-medium text-slate-700">{getBenchmarkLabel(b)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function SectionSources({ config, onChange }: { config: RiskTrendConfig; onChange: (c: RiskTrendConfig) => void }) {
  const toggle = (s: AlertSource) => {
    const next = config.sources.includes(s)
      ? config.sources.filter((x) => x !== s)
      : [...config.sources, s];
    if (next.length > 0) onChange({ ...config, sources: next });
  };
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Alert Sources</h3>
      <p className="text-xs text-slate-500 mb-4">Filter alerts to only those originating from selected sources.</p>
      <div className="grid grid-cols-2 gap-2" data-testid="sources-grid">
        {ALL_SOURCES.map((s) => {
          const active = config.sources.includes(s);
          return (
            <label key={s} className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer ${active ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
              <input
                type="checkbox"
                checked={active}
                onChange={() => toggle(s)}
                className="accent-indigo-600"
                data-testid={`source-checkbox-${s}`}
              />
              <span className="text-xs font-medium text-slate-700">{getSourceLabel(s as AlertSource)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function SectionExecutive({ config, onChange }: { config: RiskTrendConfig; onChange: (c: RiskTrendConfig) => void }) {
  const items = [
    { key: 'showEmergingRisks',      label: 'Show Emerging Risks',        desc: 'Highlight risks identified in last 7 days' },
    { key: 'showTopRiskDrivers',     label: 'Show Top Risk Drivers',      desc: 'Surface the top 5 contributing signals' },
    { key: 'showPortfolioImpact',    label: 'Show Portfolio Impact',      desc: 'KES-denominated exposure impact' },
    { key: 'showRiskTrendSummary',   label: 'Show Risk Trend Summary',    desc: 'One-paragraph AI narrative' },
    { key: 'showRecommendedActions', label: 'Show Recommended Actions',   desc: 'AI-suggested next steps' },
  ] as const;
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Executive View Configuration</h3>
      <p className="text-xs text-slate-500 mb-4">Configure which executive-level panels to display.</p>
      <div className="space-y-3" data-testid="executive-options">
        {items.map(({ key, label, desc }) => (
          <label key={key} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${config.executiveInsights[key] ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
            <input
              type="checkbox"
              checked={config.executiveInsights[key]}
              onChange={(e) => onChange({ ...config, executiveInsights: { ...config.executiveInsights, [key]: e.target.checked } })}
              className="mt-0.5 accent-indigo-600"
              data-testid={`executive-toggle-${key}`}
            />
            <div>
              <p className="text-xs font-semibold text-slate-700">{label}</p>
              <p className="text-xs text-slate-500">{desc}</p>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

function SectionPersistence({
  config,
  onSave,
  onApplyToRole,
}: {
  config: RiskTrendConfig;
  onSave: (c: RiskTrendConfig, asDefault?: boolean) => void;
  onApplyToRole?: (template: RoleTemplate) => void;
}) {
  const [selectedRole, setSelectedRole] = useState<RoleTemplate>('risk_analyst');
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Save & Persist Configuration</h3>

      <div className="space-y-3">
        <Button
          variant="primary"
          size="sm"
          onClick={() => onSave(config, false)}
          className="w-full justify-start"
          data-testid="persist-save-session"
        >
          <Save className="h-3.5 w-3.5" />
          Save for this session
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => onSave(config, true)}
          className="w-full justify-start"
          data-testid="persist-save-default"
        >
          <Save className="h-3.5 w-3.5" />
          Save as my default
        </Button>

        {onApplyToRole && (
          <div className="pt-4 border-t border-slate-200">
            <p className="text-xs font-medium text-slate-600 mb-2">Apply as role template</p>
            <div className="flex gap-2">
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as RoleTemplate)}
                className="flex-1 text-xs rounded border border-slate-200 px-2 py-1.5 bg-white"
                data-testid="persist-role-select"
              >
                {ALL_ROLE_TEMPLATES.map((r) => (
                  <option key={r} value={r}>{ROLE_TEMPLATE_LABELS[r]}</option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onApplyToRole(selectedRole)}
                data-testid="persist-apply-to-role"
              >
                Apply
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionVisual({ config, onChange }: { config: RiskTrendConfig; onChange: (c: RiskTrendConfig) => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-800 mb-3">Chart Type</h3>
        <div className="flex gap-2" data-testid="chart-type-group">
          {(['line', 'bar', 'area'] as const).map((t) => (
            <button
              key={t}
              onClick={() => onChange({ ...config, chartType: t })}
              className={`px-3 py-1.5 rounded-full text-xs font-medium capitalize border transition-colors ${config.chartType === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'}`}
              data-testid={`chart-type-${t}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-800 mb-3">Time Range</h3>
        <div className="flex gap-2" data-testid="time-range-group">
          {(['7d', '30d', '90d', '1y'] as const).map((r) => (
            <button
              key={r}
              onClick={() => onChange({ ...config, timeRange: r })}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${config.timeRange === r ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'}`}
              data-testid={`time-range-${r}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-800 mb-3">Granularity</h3>
        <div className="flex gap-2" data-testid="granularity-group">
          {(['daily', 'weekly', 'monthly'] as const).map((g) => (
            <button
              key={g}
              onClick={() => onChange({ ...config, granularity: g })}
              className={`px-3 py-1.5 rounded-full text-xs font-medium capitalize border transition-colors ${config.granularity === g ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300'}`}
              data-testid={`granularity-${g}`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Fake last-5-changes for the audit log section
const MOCK_AUDIT_LOG = [
  { ts: '2026-06-11 14:23', actor: 'alice.admin',  action: 'config.update', field: 'domains' },
  { ts: '2026-06-10 09:11', actor: 'bob.risk',     action: 'config.update', field: 'forecast.horizon' },
  { ts: '2026-06-08 16:42', actor: 'alice.admin',  action: 'config.reset',  field: 'severity' },
  { ts: '2026-06-07 11:05', actor: 'carol.cro',    action: 'config.update', field: 'benchmark' },
  { ts: '2026-06-05 08:30', actor: 'alice.admin',  action: 'config.update', field: 'sources' },
];

function SectionAudit() {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800 mb-3">Configuration Audit Log</h3>
      <p className="text-xs text-slate-500 mb-4">Last 5 changes to the Risk Trend configuration (read-only).</p>
      <div className="space-y-2" data-testid="audit-log-list">
        {MOCK_AUDIT_LOG.map((entry, i) => (
          <div key={i} className="flex items-start gap-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200">
            <FileText className="h-3.5 w-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-xs text-slate-700 font-medium">{entry.action} · <span className="font-mono">{entry.field}</span></p>
              <p className="text-xs text-slate-400">{entry.ts} · {entry.actor}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Mini Chart Preview ───────────────────────────────────────────────────────

function MiniChartPreview({ config }: { config: RiskTrendConfig }) {
  const data = useMemo(() => generatePreviewData(config), [config]);

  const commonProps = {
    data,
    margin: { top: 4, right: 4, left: -20, bottom: 0 },
  };

  const axisStyle = { fontSize: 9, fill: '#888' };

  const renderContent = () => {
    if (config.chartType === 'bar') {
      return (
        <BarChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8ECF0" />
          <XAxis dataKey="name" tick={axisStyle} />
          <YAxis tick={axisStyle} />
          <Tooltip contentStyle={{ fontSize: 10 }} />
          <Bar dataKey="value" fill="#6366F1" radius={[2, 2, 0, 0]} />
          {config.benchmark != null && <Bar dataKey="benchmark" fill="#E24B4A" fillOpacity={0.4} radius={[2, 2, 0, 0]} />}
        </BarChart>
      );
    }
    if (config.chartType === 'area') {
      return (
        <AreaChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8ECF0" />
          <XAxis dataKey="name" tick={axisStyle} />
          <YAxis tick={axisStyle} />
          <Tooltip contentStyle={{ fontSize: 10 }} />
          <Area type="monotone" dataKey="value" stroke="#6366F1" fill="#EEF2FF" strokeWidth={2} />
          {config.benchmark != null && <Area type="monotone" dataKey="benchmark" stroke="#E24B4A" fill="transparent" strokeWidth={1.5} strokeDasharray="4 2" />}
          {config.forecast.enabled && <Area type="monotone" dataKey="forecast" stroke="#EF9F27" fill="transparent" strokeWidth={1.5} strokeDasharray="3 3" />}
        </AreaChart>
      );
    }
    // line (default)
    return (
      <LineChart {...commonProps}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E8ECF0" />
        <XAxis dataKey="name" tick={axisStyle} />
        <YAxis tick={axisStyle} />
        <Tooltip contentStyle={{ fontSize: 10 }} />
        <Line type="monotone" dataKey="value" stroke="#6366F1" strokeWidth={2} dot={false} />
        {config.benchmark != null && <Line type="monotone" dataKey="benchmark" stroke="#E24B4A" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />}
        {config.forecast.enabled && (
          <>
            <Line type="monotone" dataKey="forecast" stroke="#EF9F27" strokeWidth={1.5} strokeDasharray="3 3" dot={false} />
            <ReferenceLine x="D10" stroke="#EF9F27" strokeDasharray="3 3" label={{ value: 'Forecast →', fontSize: 8, fill: '#EF9F27' }} />
          </>
        )}
      </LineChart>
    );
  };

  // Severity colour distribution bar
  const enabledSeverities = config.severities.filter((s) => s.enabled);

  return (
    <div className="flex flex-col gap-3 h-full" data-testid="mini-chart-preview">
      {/* Chart type badge */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Live Preview</span>
        <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-medium capitalize">{config.chartType}</span>
      </div>

      {/* Mini recharts */}
      <div className="rounded-lg border border-slate-200 bg-white p-2 flex-1 min-h-[160px]">
        <ResponsiveContainer width="100%" height="100%">
          {renderContent()}
        </ResponsiveContainer>
      </div>

      {/* Severity distribution bar */}
      {enabledSeverities.length > 0 && (
        <div>
          <p className="text-[10px] text-slate-500 mb-1">Severity filters active</p>
          <div className="flex rounded overflow-hidden h-2">
            {enabledSeverities.map((s) => (
              <div
                key={s.level}
                className="flex-1"
                style={{ backgroundColor: s.color }}
                title={s.label}
              />
            ))}
          </div>
        </div>
      )}

      {/* Config summary chips */}
      <div className="flex flex-wrap gap-1">
        {config.domains.slice(0, 3).map((d) => (
          <span key={d} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">
            {getDomainLabel(d)}
          </span>
        ))}
        {config.domains.length > 3 && (
          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">+{config.domains.length - 3}</span>
        )}
        {config.benchmark && (
          <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-[10px]">
            {getBenchmarkLabel(config.benchmark)}
          </span>
        )}
        {config.forecast.enabled && (
          <span className="px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700 text-[10px]">
            Forecast {config.forecast.horizon}d
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main Drawer ──────────────────────────────────────────────────────────────

export function RiskTrendConfigDrawer({
  open,
  onClose,
  config,
  onChange,
  onSave,
  onApplyToRole,
  onReset,
}: RiskTrendConfigDrawerProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('domains');

  if (!open) return null;

  const renderSection = () => {
    switch (activeSection) {
      case 'domains':     return <SectionDomains config={config} onChange={onChange} />;
      case 'metrics':     return <SectionMetrics config={config} onChange={onChange} />;
      case 'severity':    return <SectionSeverity config={config} onChange={onChange} />;
      case 'forecast':    return <SectionForecast config={config} onChange={onChange} />;
      case 'benchmark':   return <SectionBenchmark config={config} onChange={onChange} />;
      case 'sources':     return <SectionSources config={config} onChange={onChange} />;
      case 'executive':   return <SectionExecutive config={config} onChange={onChange} />;
      case 'persistence': return <SectionPersistence config={config} onSave={onSave} onApplyToRole={onApplyToRole} />;
      case 'visual':      return <SectionVisual config={config} onChange={onChange} />;
      case 'audit':       return <SectionAudit />;
      default:            return null;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      data-testid="risk-trend-config-drawer-overlay"
    >
      <div
        className="relative bg-white rounded-xl shadow-2xl w-full max-w-6xl mx-4 h-[90vh] flex flex-col overflow-hidden"
        data-testid="risk-trend-config-drawer"
      >
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-indigo-50 to-white flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <Sparkles className="h-4 w-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-800">Risk Trend Intelligence Configuration</h2>
              <p className="text-xs text-slate-500">Configure how risk trends are analysed and displayed</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            aria-label="Close configuration drawer"
            data-testid="risk-trend-config-close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Body: 3 panels */}
        <div className="flex flex-1 min-h-0">
          {/* Left sidebar */}
          <nav
            className="w-[200px] flex-shrink-0 border-r border-slate-200 bg-slate-50 py-3 overflow-y-auto"
            aria-label="Configuration sections"
            data-testid="config-section-nav"
          >
            {SECTIONS.map((sec) => {
              const isActive = activeSection === sec.id;
              return (
                <button
                  key={sec.id}
                  onClick={() => setActiveSection(sec.id)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors ${isActive ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-800'}`}
                  data-testid={`config-nav-${sec.id}`}
                  aria-selected={isActive}
                >
                  <span className={isActive ? 'text-white' : 'text-slate-400'}>{sec.icon}</span>
                  <span className="text-xs font-medium">{sec.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Center panel */}
          <main
            className="flex-1 overflow-y-auto px-8 py-6"
            data-testid="config-center-panel"
          >
            {renderSection()}
          </main>

          {/* Right panel: live preview */}
          <aside
            className="w-[280px] flex-shrink-0 border-l border-slate-200 bg-slate-50 px-4 py-5 overflow-y-auto flex flex-col"
            data-testid="config-preview-panel"
          >
            <MiniChartPreview config={config} />
          </aside>
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between px-6 py-3 border-t border-slate-200 bg-white flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            data-testid="risk-trend-config-reset"
          >
            Reset to Defaults
          </Button>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              data-testid="risk-trend-config-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSave(config, true)}
              data-testid="risk-trend-config-save-default"
            >
              Save as Default
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSave(config, false)}
              data-testid="risk-trend-config-apply"
            >
              Apply
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
