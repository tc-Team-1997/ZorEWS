import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Bell, Briefcase } from 'lucide-react';
import {
  api,
  type Alert,
  type AmlEwsCorrelation,
  type CaseState,
  type CaseSummary,
  type ShapReason,
  type Severity,
  type SlaStatus,
} from '@/lib/api';
import { Badge, type BadgeTone, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { color } from '@/styles/tokens';
import { useChatContext } from '@/components/copilot/useChatContext';
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { ExportButton } from '@/components/export/ExportButton';
import { buildCustomerReportData } from './customerReportAdapter';

const LEVEL_TONE: Record<string, BadgeTone> = {
  Low: 'success',
  Medium: 'warning',
  High: 'danger',
};

const formatKES = (n: number) =>
  new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES',
    maximumFractionDigits: 0,
  }).format(n);

export function CustomerRiskProfilePage() {
  const { id = 'c-101' } = useParams();
  const { data, isLoading } = useQuery({
    queryKey: ['customer.risk', id],
    queryFn: () => api.customerRisk(id),
  });
  useChatContext({
    page: 'customer',
    entity: data
      ? {
          type: 'customer',
          id: data.id,
          label: data.name,
          facts: {
            pd: data.pd,
            level: data.level,
            dpd_max_90d: data.dpd,
            exposure: data.exposure,
            top_reasons: data.top_reasons,
          },
        }
      : undefined,
  });

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title="Customer Risk Profile" subtitle="Loading…" />
      </div>
    );
  }

  const trendStart = data.balance_trend[0]?.balance ?? 0;
  const trendEnd = data.balance_trend[data.balance_trend.length - 1]?.balance ?? 0;
  const trendDelta = trendEnd - trendStart;

  return (
    <div>
      <PageHeader
        title={data.name}
        subtitle={`Customer ${data.id} · single-customer risk view`}
        actions={
          <>
            <Badge tone={LEVEL_TONE[data.level]} className="text-[12px] px-3 py-1">
              {data.level} risk
            </Badge>
            {/* Enterprise export (P1) — RBAC-gated; renders null without
                reports:export. Linked alerts/cases are fetched in the child
                panels below, not in header scope, so the export carries the
                in-scope customer summary + KPIs; the case/alert tables export
                empty rather than refetching. BFF stamps tenant/actor. */}
            <ExportButton
              module="customer_360"
              reportType="customer"
              adapter={(config) =>
                buildCustomerReportData(
                  {
                    customer: {
                      id: data.id,
                      name: data.name,
                      risk_score: data.pd,
                      npa_status: data.level,
                    },
                    alerts: [],
                    cases: [],
                    meta: { tenant_id: 'BANK_DEMO', generated_by: 'operator', role: 'admin' },
                  },
                  config,
                )
              }
            />
          </>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <MetricCard
          label="PD score"
          value={`${(data.pd * 100).toFixed(1)}%`}
          tone={LEVEL_TONE[data.level]}
          sub={`level: ${data.level}`}
        />
        <MetricCard
          label="Exposure"
          value={formatKES(data.exposure)}
          tone="blue"
          sub="outstanding"
        />
        <MetricCard
          label="DPD"
          value={data.dpd}
          tone={data.dpd >= 30 ? 'danger' : data.dpd > 0 ? 'warning' : 'success'}
          sub={data.dpd === 0 ? 'current' : 'days past due'}
        />
        <MetricCard
          label="6-month balance Δ"
          value={formatKES(trendDelta)}
          tone={trendDelta < 0 ? 'danger' : 'success'}
          sub={trendDelta < 0 ? 'declining' : 'stable / up'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Account balance — last 6 months" className="lg:col-span-2">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.balance_trend}>
                <defs>
                  <linearGradient id="bal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color.blue} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={color.blue} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={color.divider} strokeDasharray="3 3" />
                <XAxis dataKey="month" stroke={color.muted} fontSize={11} />
                <YAxis stroke={color.muted} fontSize={11} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{
                    background: color.surface,
                    border: `1px solid ${color.divider}`,
                    fontSize: 12,
                  }}
                  formatter={(v) => formatKES(Number(v))}
                />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke={color.blue}
                  strokeWidth={2}
                  fill="url(#bal)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel
          title="SHAP top 5"
          action={
            <span className="font-mono text-2xs text-muted">
              {data.model_name}@{data.model_version}
            </span>
          }
        >
          <ShapBars reasons={data.top_reasons} />
          <p className="caption mt-3">
            Per-feature contribution to PD for this customer. Red pushes risk up, green pulls
            it down. Sorted by absolute SHAP value.
          </p>
        </Panel>
      </div>

      {/* Linked alerts + cases — spec §5.3 360-view. The customer's own
          alerts feed the queue with criticality scores already computed
          server-side (see web/src/lib/criticality.ts). The cases panel
          uses the same SLA join the case list page does. Both link out
          to the canonical list pages with the customer pre-filtered. */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LinkedAlertsPanel customerId={id} />
        <LinkedCasesPanel customerId={id} />
      </div>

      {/* AML ↔ EWS correlation — T3.3. Lists open AML matches for the
          customer; running the forward correlation surfaces the
          recommended action across alerts/cases/investigations. */}
      <div className="mt-6">
        <AmlCorrelationPanel customerId={id} />
      </div>
    </div>
  );
}

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

const STATE_TONE: Record<CaseState, BadgeTone> = {
  open: 'blue',
  assigned: 'warning',
  in_action: 'purple',
  monitored: 'success',
  closed: 'neutral',
};

const SLA_TONE: Record<SlaStatus, BadgeTone> = {
  on_track: 'success',
  approaching: 'warning',
  breached: 'danger',
  closed: 'neutral',
};

function LinkedAlertsPanel({ customerId }: { customerId: string }) {
  // Fetch with dedup OFF — on a single-customer view we want every
  // individual alert visible, not customer-collapsed.
  const { data, isLoading } = useQuery({
    queryKey: ['customer.alerts', customerId],
    queryFn: () => api.alerts({ customer_id: customerId, dedup: false, sort: 'criticality' }),
  });

  return (
    <Panel
      title="Linked alerts"
      action={
        <Link
          to={`/alerts?dedup=false`}
          className="text-2xs text-action hover:underline focus:outline-none focus:ring-2 focus:ring-brand-blue/40 rounded"
        >
          Open in queue →
        </Link>
      }
    >
      {isLoading && <p className="caption">Loading…</p>}
      {!isLoading && (data?.items.length ?? 0) === 0 && (
        <div className="text-center py-6" data-testid="linked-alerts-empty">
          <Bell size={18} className="mx-auto text-muted mb-2" />
          <p className="text-[12px] text-muted">No alerts on this customer.</p>
        </div>
      )}
      {data && data.items.length > 0 && (
        <ul className="divide-y divide-divider" data-testid="linked-alerts-list">
          {data.items.map((a: Alert) => (
            <li key={a.id} className="py-2.5 flex items-start gap-3">
              <Badge tone={SEVERITY_TONE[a.severity]} className="uppercase tracking-wide shrink-0">
                {a.severity}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-ink truncate">{a.rule.name}</p>
                <p className="text-2xs text-muted mt-0.5">
                  <span className="font-mono">{a.id}</span> · score{' '}
                  <span className="tabular text-ink">{a.criticality_score.toFixed(2)}</span> ·
                  {a.indicators.length > 0 && (
                    <>
                      {' '}
                      indicators {a.indicators.join(', ')}
                    </>
                  )}
                </p>
              </div>
              <span className="text-2xs text-muted shrink-0 tabular">
                {a.age_min < 60
                  ? `${a.age_min}m`
                  : a.age_min < 1440
                    ? `${Math.floor(a.age_min / 60)}h`
                    : `${Math.floor(a.age_min / 1440)}d`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LinkedCasesPanel({ customerId }: { customerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer.cases', customerId],
    queryFn: () => api.cases({ customer_id: customerId }),
  });

  return (
    <Panel
      title="Linked cases"
      action={
        <Link
          to="/cms/cases"
          className="text-2xs text-action hover:underline focus:outline-none focus:ring-2 focus:ring-brand-blue/40 rounded"
        >
          Open case queue →
        </Link>
      }
    >
      {isLoading && <p className="caption">Loading…</p>}
      {!isLoading && (data?.items.length ?? 0) === 0 && (
        <div className="text-center py-6" data-testid="linked-cases-empty">
          <Briefcase size={18} className="mx-auto text-muted mb-2" />
          <p className="text-[12px] text-muted">No cases on this customer.</p>
        </div>
      )}
      {data && data.items.length > 0 && (
        <ul className="divide-y divide-divider" data-testid="linked-cases-list">
          {data.items.map((c: CaseSummary) => (
            <li key={c.id} className="py-2.5 flex items-start gap-3">
              <Badge tone={STATE_TONE[c.state]} className="uppercase tracking-wide shrink-0">
                {c.state.replace('_', ' ')}
              </Badge>
              <div className="min-w-0 flex-1">
                <Link
                  to={`/cases/${c.id}`}
                  className="text-[12px] font-medium text-ink hover:text-action focus:outline-none focus:ring-2 focus:ring-brand-blue/40 rounded font-mono"
                  data-testid={`linked-case-link-${c.id}`}
                >
                  {c.id}
                </Link>
                <p className="text-2xs text-muted mt-0.5">
                  origin alert <span className="font-mono">{c.alert_id}</span>
                  {c.assignee && (
                    <>
                      {' '}
                      · assigned to <span className="text-ink">{c.assignee}</span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                {c.sla_status && (
                  <Badge tone={SLA_TONE[c.sla_status]} className="uppercase tracking-wide text-[9px]">
                    {c.sla_status.replace('_', ' ')}
                  </Badge>
                )}
                <span className="text-2xs text-muted tabular">
                  {c.age_min < 60
                    ? `${c.age_min}m`
                    : c.age_min < 1440
                      ? `${Math.floor(c.age_min / 60)}h`
                      : `${Math.floor(c.age_min / 1440)}d`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const FEATURE_LABELS: Record<string, string> = {
  utilization: 'Utilisation',
  dpd_max_90d: 'Max DPD (90d)',
  bureau_score: 'Bureau score',
  repayment_delay_streak: 'Repayment delay streak',
  txn_volume_zscore_90d: 'Txn volume z-score (90d)',
  tenure_months: 'Tenure (months)',
  balance_drop_30d_pct: 'Balance drop (30d)',
};

function humaniseFeature(feature: string): string {
  // Categorical encoding: `product_type=credit_card` etc.
  if (feature.includes('=')) {
    const [head, val] = feature.split('=');
    const headLabel = FEATURE_LABELS[head] ?? head.replace(/_/g, ' ');
    return `${headLabel} = ${val.replace(/_/g, ' ')}`;
  }
  return FEATURE_LABELS[feature] ?? feature.replace(/_/g, ' ');
}

function formatValue(v: number | string | null): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v.replace(/_/g, ' ');
  // 0..1 ranges (e.g. utilization) → percent; small ints → as-is; rest → 2dp.
  if (Math.abs(v) <= 1.5 && !Number.isInteger(v)) return `${(v * 100).toFixed(0)}%`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

/**
 * Diverging horizontal bar chart — left side = protective (negative SHAP,
 * green), right side = risky (positive SHAP, red). Bars are normalised to
 * the max absolute value across the visible reasons. The midline is the
 * baseline (model expected value); the further from the line, the larger
 * the contribution.
 */
function ShapBars({ reasons }: { reasons: ShapReason[] }) {
  if (!reasons.length) {
    return <p className="caption">No SHAP attribution available.</p>;
  }
  const sorted = [...reasons].sort(
    (a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value),
  );
  const maxAbs = Math.max(...sorted.map((r) => Math.abs(r.shap_value)), 0.01);

  return (
    <ul aria-label="shap top reasons" className="space-y-3">
      {sorted.map((r) => {
        const pct = Math.round((Math.abs(r.shap_value) / maxAbs) * 50);
        const positive = r.direction === 'positive';
        return (
          <li key={`${r.feature}:${r.value}`}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-xs text-ink">{humaniseFeature(r.feature)}</span>
              <span className="text-2xs text-muted">
                {formatValue(r.value)}
                <span
                  className={`ml-2 font-mono tabular ${
                    positive ? 'text-danger' : 'text-success'
                  }`}
                >
                  {positive ? '+' : ''}
                  {r.shap_value.toFixed(2)}
                </span>
              </span>
            </div>
            <div className="relative h-2 rounded-full bg-divider">
              <div className="absolute left-1/2 top-0 h-full w-px bg-ink-sub/30" />
              {positive ? (
                <div
                  className="absolute left-1/2 top-0 h-full rounded-r-full bg-danger"
                  style={{ width: `${pct}%` }}
                />
              ) : (
                <div
                  className="absolute right-1/2 top-0 h-full rounded-l-full bg-success"
                  style={{ width: `${pct}%` }}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ─── AML correlation panel (T3.3) ────────────────────────────────────

const AML_SEVERITY_TONE: Record<string, BadgeTone> = {
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

const ACTION_TONE: Record<string, BadgeTone> = {
  escalate_case: 'danger',
  open_investigation: 'warning',
  monitor: 'blue',
  no_action: 'success',
};

const ACTION_LABEL: Record<string, string> = {
  escalate_case: 'Escalate case',
  open_investigation: 'Open investigation',
  monitor: 'Monitor',
  no_action: 'No action',
};

function AmlCorrelationPanel({ customerId }: { customerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['aml.matches', customerId],
    queryFn: () => api.amlMatchesForCustomer(customerId),
  });

  const [correlation, setCorrelation] = useState<AmlEwsCorrelation | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runCorrelation(match_id: string) {
    setRunning(true);
    setError(null);
    try {
      const out = await api.amlCorrelateForward(match_id);
      setCorrelation(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'correlation failed');
    } finally {
      setRunning(false);
    }
  }

  const matches = data?.matches ?? [];

  return (
    <Panel
      title="AML correlation"
      action={
        <Link
          to="/aml/dashboard"
          className="text-2xs text-action hover:underline focus:outline-none focus:ring-2 focus:ring-brand-blue/40 rounded"
        >
          Open AML console →
        </Link>
      }
    >
      {isLoading && <p className="caption">Loading matches…</p>}
      {!isLoading && matches.length === 0 && (
        <div className="text-center py-6" data-testid="aml-empty">
          <ShieldAlert size={18} className="mx-auto text-muted mb-2" />
          <p className="text-[12px] text-muted">No AML matches on this customer.</p>
        </div>
      )}
      {matches.length > 0 && (
        <div data-testid="aml-matches" className="space-y-3">
          <ul className="divide-y divide-divider">
            {matches.map((m) => (
              <li key={m.match_id} className="py-2.5 flex items-start gap-3">
                <Badge
                  tone={AML_SEVERITY_TONE[m.severity] ?? 'neutral'}
                  className="uppercase tracking-wide shrink-0"
                >
                  {m.severity}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-ink truncate">
                    {m.list_entity_name}{' '}
                    <span className="text-2xs text-muted font-normal">
                      ({m.list_name})
                    </span>
                  </p>
                  <p className="text-2xs text-muted mt-0.5">
                    <span className="font-mono">{m.match_id}</span> · {m.match_type} ·
                    status {m.status} · confidence{' '}
                    <span className="tabular text-ink">{m.confidence_score.toFixed(2)}</span>
                  </p>
                </div>
                <button
                  type="button"
                  className="text-2xs text-action hover:underline disabled:opacity-50 shrink-0"
                  disabled={running}
                  onClick={() => runCorrelation(m.match_id)}
                  data-testid={`correlate-${m.match_id}`}
                >
                  {running ? 'Running…' : 'Correlate →'}
                </button>
              </li>
            ))}
          </ul>

          {error && (
            <div
              className="rounded-md border border-danger bg-danger/10 px-3 py-2 text-2xs text-danger"
              data-testid="aml-error"
            >
              {error}
            </div>
          )}

          {correlation && (
            <div
              className="rounded-md border border-divider bg-surface-subtle px-3 py-3 text-2xs"
              data-testid="correlation-result"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <p className="text-[12px] font-medium text-ink">
                    Correlation result —{' '}
                    <span className="font-mono">{correlation.aml_match.match_id}</span>
                  </p>
                  <p className="text-2xs text-muted mt-0.5">
                    Peak EWS severity:{' '}
                    {correlation.peak_alert_severity ?? 'none'} ·
                    bidirectional-high:{' '}
                    {correlation.bidirectional_high_flag ? 'yes' : 'no'}
                  </p>
                </div>
                <Badge tone={ACTION_TONE[correlation.recommended_action] ?? 'neutral'}>
                  {ACTION_LABEL[correlation.recommended_action] ??
                    correlation.recommended_action}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-2">
                <CorrelationStat
                  label="Linked alerts"
                  count={correlation.linked_alerts.length}
                />
                <CorrelationStat
                  label="Linked cases"
                  count={correlation.linked_cases.length}
                />
                <CorrelationStat
                  label="Investigations"
                  count={correlation.linked_investigations.length}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function CorrelationStat({ label, count }: { label: string; count: number }) {
  return (
    <div className="rounded border border-divider bg-surface px-2 py-1.5">
      <p className="text-2xs text-muted">{label}</p>
      <p className="text-base font-semibold text-ink tabular">{count}</p>
    </div>
  );
}
