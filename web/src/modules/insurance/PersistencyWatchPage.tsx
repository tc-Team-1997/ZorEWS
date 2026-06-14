// web/src/modules/insurance/PersistencyWatchPage.tsx
//
// Insurance EWS — Module 5: Persistency Watch.
//
// 4 widgets per the spec (persistency trend across milestones · product-wise
// retention · channel risk · location-wise persistency) + an AI root-cause
// analyze drawer. Backed by /v1/insurance/persistency/{dashboard,analyze,alerts}.

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  ReferenceLine,
} from 'recharts';
import { Activity, Boxes, Network, MapPin, Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  PersistencyDashboardShape,
  PersistencyBandShape,
  DimensionPersistencyShape,
  PersistencyAnalysisShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, Modal, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildPersistencyReportData } from './persistencyReportAdapter';
import { color } from '@/styles/tokens';

const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const BAND_TONE: Record<PersistencyBandShape, BadgeTone> = {
  healthy: 'success',
  watch: 'warning',
  concern: 'warning',
  critical: 'danger',
};
const BAND_COLOR: Record<PersistencyBandShape, string> = {
  healthy: color.success ?? '#1D9E75',
  watch: color.warning ?? '#EF9F27',
  concern: '#F5793B',
  critical: color.danger ?? '#E24B4A',
};

export function PersistencyWatchPage() {
  const me = useAuth((s) => s.user);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  const { data, isLoading } = useQuery<PersistencyDashboardShape>({
    queryKey: ['insurance', 'persistency', 'dashboard'],
    queryFn: () => api.insurancePersistencyDashboard(),
  });

  return (
    <div>
      <PageHeader
        title="Persistency Watch"
        subtitle="13/25/37/49/61-month retention · product · channel · region · AI root-cause"
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setAnalyzeOpen(true)} data-testid="persistency-analyze-open">
              <Sparkles size={15} className="mr-1.5 -ml-0.5" /> Root-cause analysis
            </Button>
            {/* Enterprise export (P3) — RBAC-gated; renders null without
                reports:export. Reports the by-milestone persistency trend + headline KPIs. */}
            <ExportButton
              module="persistency"
              reportType="portfolio"
              adapter={(config) =>
                buildPersistencyReportData(
                  {
                    totals: {
                      headline_13m_pct: data?.totals.headline_13m_pct ?? 0,
                      headline_61m_pct: data?.totals.headline_61m_pct ?? 0,
                      cohorts_below_target: data?.totals.cohorts_below_target ?? 0,
                      open_alerts: data?.totals.open_alerts ?? 0,
                      worst_dimension: data?.totals.worst_dimension ?? null,
                    },
                    persistency_trend: data?.persistency_trend ?? [],
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
          <p className="caption" data-testid="persistency-loading">Loading persistency metrics…</p>
        </Panel>
      ) : (
        <div className="space-y-5" data-testid="persistency-dashboard">
          {/* ── KPI row ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="13-month persistency" value={fmtPct(data.totals.headline_13m_pct)} tone="blue" />
            <MetricCard label="61-month persistency" value={fmtPct(data.totals.headline_61m_pct)} />
            <MetricCard label="Cohorts below target" value={data.totals.cohorts_below_target} tone="warning" />
            <MetricCard
              label="Open alerts"
              value={data.totals.open_alerts}
              tone={data.totals.open_alerts > 0 ? 'danger' : 'success'}
              sub={data.totals.worst_dimension ?? undefined}
            />
          </div>

          {/* ── Persistency trend across milestones ─────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <Activity size={16} className="text-brand-blue" />
              <h2 className="section-title">Persistency trend — by milestone</h2>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart
                data={data.persistency_trend.map((t) => ({ ...t, label: `${t.period_month}m` }))}
                margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis domain={[0.3, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: number, name: string) => [fmtPct(v), name === 'target_pct' ? 'Target' : 'Actual']} />
                <Line type="monotone" dataKey="target_pct" stroke={color.warning} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                <Line
                  type="monotone"
                  dataKey="persistency_pct"
                  stroke={color.blue}
                  strokeWidth={2.5}
                  dot={(props: { cx?: number; cy?: number; payload?: { band?: PersistencyBandShape } }) => {
                    const { cx, cy, payload } = props;
                    const fill = payload?.band ? BAND_COLOR[payload.band] : color.blue;
                    return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={4} fill={fill} stroke="#fff" strokeWidth={1} />;
                  }}
                />
              </LineChart>
            </ResponsiveContainer>
            <p className="caption mt-1">Solid = actual (dot colour = band) · dashed amber = IRDAI milestone target</p>
          </Panel>

          {/* ── Product + Channel + Region ──────────────────────────── */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <DimensionPanel title="Product-wise retention" icon={<Boxes size={16} className="text-brand-blue" />} rows={data.product_retention} testId="product-retention" />
            <DimensionPanel title="Channel risk" icon={<Network size={16} className="text-danger" />} rows={data.channel_risk} testId="channel-risk" />
            <DimensionPanel title="Location-wise persistency" icon={<MapPin size={16} className="text-brand-blue" />} rows={data.location_persistency} testId="location-persistency" />
          </div>

          <p className="caption text-right">
            Model {data.model_version} · generated {new Date(data.generated_at).toLocaleString()}
          </p>
        </div>
      )}

      {analyzeOpen && <AnalyzeModal onClose={() => setAnalyzeOpen(false)} />}
    </div>
  );
}

function DimensionPanel({
  title,
  icon,
  rows,
  testId,
}: {
  title: string;
  icon: React.ReactNode;
  rows: DimensionPersistencyShape[];
  testId: string;
}) {
  return (
    <Panel>
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="section-title">{title}</h2>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" horizontal={false} />
          <XAxis type="number" domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fontSize: 9 }} />
          <YAxis type="category" dataKey="dimension_value" width={90} tick={{ fontSize: 10 }} />
          <Tooltip formatter={(v: number) => [fmtPct(v), 'Persistency']} />
          <ReferenceLine x={rows[0]?.target_pct ?? 0.85} stroke={color.warning} strokeDasharray="3 3" />
          <Bar dataKey="persistency_pct" radius={[0, 4, 4, 0]}>
            {rows.map((r) => (
              <Cell key={r.dimension_value} fill={BAND_COLOR[r.band]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 space-y-1" data-testid={testId}>
        {rows.map((r) => (
          <div key={r.dimension_value} className="flex items-center justify-between text-xs">
            <span className="capitalize">{r.dimension_value}</span>
            <span className="flex items-center gap-2">
              <span className="tabular">{fmtPct(r.persistency_pct)}</span>
              <Badge tone={BAND_TONE[r.band]}>{r.band}</Badge>
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── AI root-cause analyzer ─────────────────────────────────────────────

function AnalyzeModal({ onClose }: { onClose: () => void }) {
  const [dimension, setDimension] = useState('channel');
  const [value, setValue] = useState('online');
  const [period, setPeriod] = useState(13);
  const [pct, setPct] = useState(0.65);
  const [autoDebit, setAutoDebit] = useState(0.4);
  const [attrition, setAttrition] = useState(0.2);

  const analyze = useMutation<PersistencyAnalysisShape, Error>({
    mutationFn: () =>
      api.insurancePersistencyAnalyze({
        dimension,
        dimension_value: value,
        period_month: period,
        persistency_pct: pct,
        auto_debit_share: autoDebit,
        agent_attrition_rate: attrition,
      }),
  });
  const result = analyze.data;

  return (
    <Modal open onClose={onClose} ariaLabel="Persistency root-cause analysis" size="md" testId="persistency-analyze">
      <div className="space-y-3" data-testid="persistency-analyze-modal">
        <div className="flex items-center justify-between border-b border-divider pb-3">
          <h2 className="section-title">Root-cause analysis</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Dimension">
            <select className="input" value={dimension} onChange={(e) => setDimension(e.target.value)}>
              <option value="product">Product</option>
              <option value="channel">Channel</option>
              <option value="region">Region</option>
            </select>
          </Field>
          <Field label="Value">
            <input className="input" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Milestone (months)">
            <select className="input" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              {[13, 25, 37, 49, 61].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Observed persistency (0–1)">
            <input type="number" min={0} max={1} step={0.01} className="input" value={pct} onChange={(e) => setPct(Number(e.target.value))} />
          </Field>
          <Field label="Auto-debit share (0–1)">
            <input type="number" min={0} max={1} step={0.05} className="input" value={autoDebit} onChange={(e) => setAutoDebit(Number(e.target.value))} />
          </Field>
          <Field label="Agent attrition (0–1)">
            <input type="number" min={0} max={1} step={0.05} className="input" value={attrition} onChange={(e) => setAttrition(Number(e.target.value))} />
          </Field>
        </div>

        <Button onClick={() => analyze.mutate()} disabled={analyze.isPending} data-testid="persistency-analyze-run">
          {analyze.isPending ? 'Analyzing…' : 'Analyze root causes'}
        </Button>

        {result && (
          <div className="mt-2 rounded-card border border-divider p-4" data-testid="persistency-analyze-result">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Persistency vs target</span>
              <span className="text-lg font-bold tabular">
                {fmtPct(result.persistency_pct)} <span className="text-muted text-sm font-normal">/ {fmtPct(result.target_pct)}</span>
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Band</span>
              <Badge tone={BAND_TONE[result.band]}>{result.band}</Badge>
            </div>
            {result.root_causes.length > 0 && (
              <>
                <p className="mt-3 text-xs font-medium text-muted">Root causes</p>
                <ul className="mt-1 space-y-1.5">
                  {result.root_causes.map((c) => (
                    <li key={c.cause}>
                      <div className="flex items-center justify-between text-xs">
                        <span>{c.cause.replace(/_/g, ' ')}</span>
                        <span className="tabular font-semibold">{fmtPct(c.weight)}</span>
                      </div>
                      <div className="mt-0.5 h-1.5 rounded bg-divider overflow-hidden">
                        <div className="h-full rounded bg-brand-blue" style={{ width: `${c.weight * 100}%` }} />
                      </div>
                      <p className="text-[10.5px] text-ink-sub mt-0.5">{c.detail}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-3 text-[11px] text-ink-sub leading-snug border-t border-divider pt-2">
              {result.recommendation}
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
