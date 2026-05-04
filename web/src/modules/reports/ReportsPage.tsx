import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Download, FileSpreadsheet, FileText, FileType, RefreshCw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';
import {
  api,
  type AlertActivityReport,
  type CaseOutcomesReport,
  type PortfolioSnapshot,
  type RbiSummaryReport,
  type ReportPayload,
  type ReportPeriod,
  type ReportType,
} from '@/lib/api';
import { color } from '@/styles/tokens';

const TYPES: { value: ReportType; label: string; description: string }[] = [
  {
    value: 'snapshot',
    label: 'Portfolio risk snapshot',
    description: 'Point-in-time KPIs · IFRS-9 stage counts · ECL · NPA %',
  },
  {
    value: 'alerts',
    label: 'Alert activity',
    description: 'Alerts raised + closed in period · top firing rules · ack/close SLAs',
  },
  {
    value: 'cases',
    label: 'Case outcomes',
    description: 'Cases opened/closed · cured vs defaulted · top officers · product mix',
  },
  {
    value: 'rbi',
    label: 'RBI-style summary',
    description: 'Sector exposure · risk-band distribution · ECL QoQ · top concentrations',
  },
];

const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'quarter', label: 'Last 90 days' },
];

function fmtKes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} Bn`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)} K`;
  return n.toLocaleString();
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

type DownloadFormat = 'csv' | 'pdf' | 'xlsx';

const FORMATS: { value: DownloadFormat; label: string; icon: typeof FileText }[] = [
  { value: 'pdf', label: 'PDF — printable summary', icon: FileType },
  { value: 'xlsx', label: 'Excel — multi-sheet workbook', icon: FileSpreadsheet },
  { value: 'csv', label: 'CSV — flat data', icon: FileText },
];

export function ReportsPage() {
  const [type, setType] = useState<ReportType>('snapshot');
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [downloading, setDownloading] = useState<DownloadFormat | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useChatContext({ page: 'reports' });

  const query = useQuery({
    queryKey: ['report', type, period],
    queryFn: () => api.getReport(type, period),
  });

  // Close the dropdown on outside click + Escape — keeps a clear
  // keyboard escape route. Arrow-key navigation between items is left
  // to native browser tab traversal since the menu is a small, flat
  // list of buttons; dedicated arrow handling would require a roving
  // tabindex pattern that's not justified for 3 items.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        // Return focus to the trigger so keyboard users don't get stranded.
        const trigger = menuRef.current?.querySelector<HTMLButtonElement>(
          '[data-testid="download-menu-trigger"]',
        );
        trigger?.focus();
      }
    };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const handleDownload = async (format: DownloadFormat) => {
    setMenuOpen(false);
    setDownloading(format);
    try {
      await api.downloadReport(type, period, format);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Reports & Analytics"
        subtitle="Pre-built risk reports · regulatory summaries · CSV export"
      />

      <Panel title="Report selector" className="mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block">
            <span className="label">Report type</span>
            <select
              className="input"
              value={type}
              onChange={(e) => setType(e.target.value as ReportType)}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="caption block mt-1.5">
              {TYPES.find((t) => t.value === type)?.description}
            </span>
          </label>
          <label className="block">
            <span className="label">Period</span>
            <select
              className="input"
              value={period}
              onChange={(e) => setPeriod(e.target.value as ReportPeriod)}
            >
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              className="flex-1"
            >
              <RefreshCw size={14} className="mr-1.5" />
              {query.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
            <div ref={menuRef} className="relative flex-1">
              <Button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                disabled={!query.data || downloading !== null}
                className="w-full"
                data-testid="download-menu-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <Download size={14} className="mr-1.5" />
                {downloading
                  ? `Downloading ${downloading.toUpperCase()}…`
                  : 'Download'}
                <ChevronDown size={12} className="ml-1.5" />
              </Button>
              {menuOpen && (
                <div
                  role="menu"
                  data-testid="download-menu"
                  className="absolute right-0 mt-1 w-64 z-20 rounded-md border border-divider bg-white shadow-lg ring-1 ring-black/5 py-1"
                >
                  {FORMATS.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      role="menuitem"
                      data-testid={`download-${value}`}
                      onClick={() => handleDownload(value)}
                      className="w-full flex items-start gap-2.5 text-left px-3 py-2 text-[13px] text-ink hover:bg-surface-alt transition-colors"
                    >
                      <Icon size={16} className="mt-0.5 shrink-0 text-action" strokeWidth={1.75} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </Panel>

      {query.isLoading && <Panel>Loading report…</Panel>}
      {query.isError && (
        <Panel>
          <p role="alert" className="text-danger text-sm">
            {(query.error as Error)?.message ?? 'Report failed to load.'}
          </p>
        </Panel>
      )}
      {query.data && <ReportRenderer payload={query.data} />}
    </div>
  );
}

function ReportRenderer({ payload }: { payload: ReportPayload }) {
  return (
    <div className="space-y-4" data-testid="report-body">
      <p className="caption">
        Period <span className="font-mono">{fmtDate(payload.period_start)}</span> —{' '}
        <span className="font-mono">{fmtDate(payload.period_end)}</span> · generated{' '}
        <span className="font-mono">{new Date(payload.generated_at).toLocaleString()}</span>
      </p>

      {payload.type === 'snapshot' && <SnapshotView r={payload} />}
      {payload.type === 'alerts' && <AlertActivityView r={payload} />}
      {payload.type === 'cases' && <CaseOutcomesView r={payload} />}
      {payload.type === 'rbi' && <RbiSummaryView r={payload} />}
    </div>
  );
}

function SnapshotView({ r }: { r: PortfolioSnapshot }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Customers monitored"
          value={r.customers_monitored.toLocaleString()}
          tone="blue"
          sub="across all portfolios"
        />
        <MetricCard
          label="High-risk customers"
          value={r.high_risk_customers.toLocaleString()}
          tone="danger"
          sub={`${r.high_risk_pct.toFixed(1)}% of book`}
        />
        <MetricCard
          label="Total exposure"
          value={`KES ${fmtKes(r.total_exposure_kes)}`}
          tone="neutral"
          sub="EAD across all open loans"
        />
        <MetricCard
          label="Expected credit loss"
          value={`KES ${fmtKes(r.expected_credit_loss_kes)}`}
          tone="warning"
          sub={`NPA ${r.npa_pct.toFixed(1)}%`}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="IFRS-9 stage distribution">
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={[
                  { stage: 'Stage 1 (perform.)', count: r.stage_distribution.stage_1 },
                  { stage: 'Stage 2 (SICR)', count: r.stage_distribution.stage_2 },
                  { stage: 'Stage 3 (NPA)', count: r.stage_distribution.stage_3 },
                ]}
              >
                <CartesianGrid stroke={color.divider} vertical={false} />
                <XAxis dataKey="stage" stroke={color.muted} tick={{ fontSize: 11 }} />
                <YAxis stroke={color.muted} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill={color.blue} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="In-flight workload">
          <div className="grid grid-cols-2 gap-4">
            <MetricCard label="Alerts open" value={r.alerts_open} tone="warning" />
            <MetricCard label="Cases in progress" value={r.cases_in_progress} tone="neutral" />
          </div>
        </Panel>
      </div>
    </>
  );
}

function AlertActivityView({ r }: { r: AlertActivityReport }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Alerts raised" value={r.raised_total} tone="blue" />
        <MetricCard label="Alerts closed" value={r.closed_total} tone="success" />
        <MetricCard
          label="Avg time to ack"
          value={`${r.avg_minutes_to_ack.toFixed(0)} min`}
          tone="neutral"
        />
        <MetricCard
          label="Avg time to close"
          value={`${r.avg_minutes_to_close.toFixed(0)} min`}
          tone="warning"
          sub={`${r.open_at_end} still open at period end`}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Severity mix">
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={[
                  { severity: 'Critical', count: r.raised_by_severity.critical },
                  { severity: 'High', count: r.raised_by_severity.high },
                  { severity: 'Medium', count: r.raised_by_severity.medium },
                  { severity: 'Low', count: r.raised_by_severity.low },
                ]}
              >
                <CartesianGrid stroke={color.divider} vertical={false} />
                <XAxis dataKey="severity" stroke={color.muted} tick={{ fontSize: 11 }} />
                <YAxis stroke={color.muted} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill={color.danger} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Top firing rules">
          <table className="w-full text-[12px]">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="text-left py-2 font-medium">Rule</th>
                <th className="text-right py-2 font-medium">Firings</th>
              </tr>
            </thead>
            <tbody>
              {r.top_rules.map((t) => (
                <tr key={t.rule_id} className="border-b border-divider/40">
                  <td className="py-2">
                    <div className="font-medium text-ink">{t.rule_name}</div>
                    <div className="text-[10px] text-muted">{t.rule_id}</div>
                  </td>
                  <td className="text-right tabular text-ink">{t.firings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}

function CaseOutcomesView({ r }: { r: CaseOutcomesReport }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Cases opened" value={r.cases_opened} tone="blue" />
        <MetricCard label="Cases closed" value={r.cases_closed} tone="success" />
        <MetricCard label="Avg days to close" value={r.avg_days_to_close} tone="warning" />
        <MetricCard
          label="Defaulted"
          value={r.outcomes.defaulted}
          tone="danger"
          sub={`Cured ${r.outcomes.cured} · Temp ${r.outcomes.cured_temp}`}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Top officers">
          <table className="w-full text-[12px]">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="text-left py-2 font-medium">Officer</th>
                <th className="text-right py-2 font-medium">Cases closed</th>
              </tr>
            </thead>
            <tbody>
              {r.top_officers.map((o) => (
                <tr key={o.officer_id} className="border-b border-divider/40">
                  <td className="py-2 font-mono text-ink">{o.officer_id}</td>
                  <td className="text-right tabular text-ink">{o.cases_closed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Product breakdown">
          <table className="w-full text-[12px]">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="text-left py-2 font-medium">Product</th>
                <th className="text-right py-2 font-medium">Cases closed</th>
              </tr>
            </thead>
            <tbody>
              {r.product_breakdown.map((p) => (
                <tr key={p.product} className="border-b border-divider/40">
                  <td className="py-2 capitalize text-ink">{p.product}</td>
                  <td className="text-right tabular text-ink">{p.cases_closed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}

function RbiSummaryView({ r }: { r: RbiSummaryReport }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Expected credit loss"
          value={`KES ${fmtKes(r.ecl_kes)}`}
          tone="warning"
          sub="12-month ECL across the book"
        />
        <MetricCard
          label="ECL change QoQ"
          value={`${r.ecl_qoq_delta_kes >= 0 ? '+' : ''}KES ${fmtKes(r.ecl_qoq_delta_kes)}`}
          tone={r.ecl_qoq_delta_kes > 0 ? 'danger' : 'success'}
        />
        <MetricCard
          label="NPA %"
          value={`${r.npa_pct.toFixed(1)}%`}
          tone={r.npa_pct > 5 ? 'danger' : 'neutral'}
        />
        <MetricCard
          label="Top concentration"
          value={r.top_concentrations[0] ? `KES ${fmtKes(r.top_concentrations[0].exposure_kes)}` : '—'}
          tone="neutral"
          sub={r.top_concentrations[0]?.name ?? '—'}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Sector exposure">
          <table className="w-full text-[12px]">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="text-left py-2 font-medium">Sector</th>
                <th className="text-right py-2 font-medium">Exposure</th>
                <th className="text-right py-2 font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {r.sector_exposure.map((s) => (
                <tr key={s.sector} className="border-b border-divider/40">
                  <td className="py-2 capitalize text-ink">{s.sector}</td>
                  <td className="text-right tabular text-sub">KES {fmtKes(s.exposure_kes)}</td>
                  <td className="text-right tabular text-ink">{s.share_pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Risk band distribution">
          <table className="w-full text-[12px]">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="text-left py-2 font-medium">Band</th>
                <th className="text-right py-2 font-medium">Accounts</th>
                <th className="text-right py-2 font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {r.risk_band_distribution.map((b) => (
                <tr key={b.band} className="border-b border-divider/40">
                  <td className="py-2 capitalize text-ink">{b.band}</td>
                  <td className="text-right tabular text-sub">{b.accounts}</td>
                  <td className="text-right tabular text-ink">{b.share_pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel title="Top single-name concentrations">
        <table className="w-full text-[12px]">
          <thead className="text-muted">
            <tr className="border-b border-divider">
              <th className="text-left py-2 font-medium">Customer</th>
              <th className="text-right py-2 font-medium">Exposure</th>
            </tr>
          </thead>
          <tbody>
            {r.top_concentrations.map((c) => (
              <tr key={c.customer_id} className="border-b border-divider/40">
                <td className="py-2">
                  <div className="font-medium text-ink">{c.name}</div>
                  <div className="text-[10px] text-muted">{c.customer_id}</div>
                </td>
                <td className="text-right tabular text-ink">KES {fmtKes(c.exposure_kes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
