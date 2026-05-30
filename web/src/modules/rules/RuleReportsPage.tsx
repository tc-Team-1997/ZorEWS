// web/src/modules/rules/RuleReportsPage.tsx
//
// Phase 9 T10 — fleet-wide rule engine report (NEW page).
//
// Backed by GET /v1/rules/reports/engine-summary. Renders:
//   - 6 KPI cards (total / active / alerts 12mo / triggers this month
//     / mean precision / mean FP rate)
//   - cohort chips (by state / by family / by severity / by performance)
//   - monthly fleet-volume chart (stacked-bar by family)
//   - top-firing table (loudest rules)
//   - underperforming list (active rules with high FP)
//   - silent rules list (active but zero firings)
//   - Export ▾ dropdown (CSV / PDF / Excel)
//
// Re-uses the same shape as the existing /reports + /analytics pages so
// the SPA's report-page pattern stays consistent.

import { useMemo, useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  XCircle,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type RuleEngineReport, type RuleEngineReportRow } from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  downloadRulesCsv,
  downloadRulesPdf,
  downloadRulesXlsx,
} from '@/lib/ruleReportsExport';

const FAMILY_COLORS: Record<string, string> = {
  Financial: '#1d4ed8',
  Behavioural: '#0ea5e9',
  Transaction: '#16a34a',
  Credit: '#f59e0b',
  Fraud: '#dc2626',
};

function statusTone(s: RuleEngineReportRow['status']):
  'success' | 'warning' | 'danger' | 'neutral' {
  switch (s) {
    case 'performing':
      return 'success';
    case 'underperforming':
      return 'danger';
    case 'deprecated':
      return 'neutral';
    case 'no_data':
      return 'warning';
  }
}

function severityTone(s: RuleEngineReportRow['severity']):
  'danger' | 'warning' | 'neutral' | 'blue' {
  switch (s) {
    case 'critical':
      return 'danger';
    case 'high':
      return 'danger';
    case 'medium':
      return 'warning';
    case 'low':
      return 'blue';
  }
}

function pct(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(1)}%`;
}

// ── Export dropdown ────────────────────────────────────────────────────

function ExportDropdown({ report }: { report: RuleEngineReport }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'csv' | 'pdf' | 'xlsx' | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function pick(kind: 'csv' | 'pdf' | 'xlsx') {
    setBusy(kind);
    try {
      if (kind === 'csv') downloadRulesCsv(report.rows);
      else if (kind === 'pdf') downloadRulesPdf(report);
      else await downloadRulesXlsx(report);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        onClick={() => setOpen((s) => !s)}
        data-testid="rule-reports-export"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busy ? (
          <Loader2 size={14} className="mr-1.5 animate-spin" />
        ) : (
          <Download size={14} className="mr-1.5" />
        )}
        Export <ChevronDown size={12} className="ml-1" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-44 rounded border border-divider bg-surface shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-divider/30"
            onClick={() => pick('csv')}
            data-testid="rule-reports-export-csv"
          >
            <FileText size={14} /> Download CSV
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-divider/30"
            onClick={() => pick('pdf')}
            data-testid="rule-reports-export-pdf"
          >
            <FileText size={14} /> Download PDF
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-divider/30"
            onClick={() => pick('xlsx')}
            data-testid="rule-reports-export-xlsx"
          >
            <FileSpreadsheet size={14} /> Download Excel
          </button>
        </div>
      )}
    </div>
  );
}

// ── Sub-views ──────────────────────────────────────────────────────────

function CohortChips({
  title,
  data,
}: {
  title: string;
  data: Record<string, number>;
}) {
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  return (
    <Panel title={title} className="h-full">
      <div className="flex flex-wrap gap-2">
        {entries.length === 0 ? (
          <span className="text-sm text-muted">No rules.</span>
        ) : (
          entries.map(([k, v]) => (
            <Badge key={k} tone="blue">
              {k}: {v}
            </Badge>
          ))
        )}
      </div>
    </Panel>
  );
}

function MonthlyVolumeChart({ report }: { report: RuleEngineReport }) {
  const data = useMemo(
    () =>
      report.monthly_volume.map((p) => ({
        month: p.month,
        ...p.by_family,
      })),
    [report.monthly_volume],
  );
  const families = Object.keys(FAMILY_COLORS);
  return (
    <Panel
      title={`Monthly fleet volume (active rules) — ${report.monthly_volume.length} months · stacked by family`}
    >
      <div style={{ width: '100%', height: 280 }}>
        <ResponsiveContainer>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" />
            <YAxis />
            <ReTooltip />
            <Legend />
            {families.map((f) => (
              <Bar key={f} dataKey={f} stackId="a" fill={FAMILY_COLORS[f]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function RuleRow({ row }: { row: RuleEngineReportRow }) {
  return (
    <tr className="border-b border-divider/30 last:border-b-0">
      <td className="px-3 py-2 font-mono text-xs">{row.rule_id}</td>
      <td className="px-3 py-2">{row.name}</td>
      <td className="px-3 py-2">{row.family}</td>
      <td className="px-3 py-2">
        <Badge tone={severityTone(row.severity)}>{row.severity}</Badge>
      </td>
      <td className="px-3 py-2 text-right">{row.total_alerts_12mo.toLocaleString()}</td>
      <td className="px-3 py-2 text-right">{row.triggers_month.toLocaleString()}</td>
      <td className="px-3 py-2 text-right">{row.precision_pct.toFixed(1)}%</td>
      <td className="px-3 py-2 text-right">{row.false_positive_rate.toFixed(1)}%</td>
      <td className="px-3 py-2">
        <Badge tone={statusTone(row.status)}>{row.status}</Badge>
      </td>
    </tr>
  );
}

function RulesTable({
  title,
  rows,
  emptyMsg,
  testid,
}: {
  title: string;
  rows: RuleEngineReportRow[];
  emptyMsg: string;
  testid?: string;
}) {
  return (
    <Panel title={`${title} — ${rows.length} rule${rows.length === 1 ? '' : 's'}`}>
      <div className="overflow-x-auto" data-testid={testid}>
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-muted">{emptyMsg}</div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="border-b border-divider bg-divider/10 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2">Rule</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Family</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2 text-right">Alerts (12mo)</th>
                <th className="px-3 py-2 text-right">This month</th>
                <th className="px-3 py-2 text-right">Precision</th>
                <th className="px-3 py-2 text-right">FP rate</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RuleRow key={r.rule_id} row={r} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

// ── Page ───────────────────────────────────────────────────────────────

export function RuleReportsPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['rule-engine-report'],
    queryFn: api.ruleEngineReport,
  });

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader
          title="Rule Engine Reports"
          subtitle="Loading fleet-wide rule report…"
        />
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Rule Engine Reports" subtitle="Failed to load." />
        <Panel title="Error">
          <div className="flex items-center gap-2 text-danger">
            <XCircle size={16} /> {(error as Error | null)?.message ?? 'Unknown error.'}
          </div>
        </Panel>
      </div>
    );
  }

  const report = data;

  return (
    <div className="space-y-6 p-6" data-testid="rule-reports-page">
      <PageHeader
        title="Rule Engine Reports"
        subtitle={`${report.total_rules} rule${report.total_rules === 1 ? '' : 's'} · ${report.total_active_rules} active · ${report.tenant_id}`}
        actions={<ExportDropdown report={report} />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="Total rules"
          value={report.total_rules.toLocaleString()}
          testId="kpi-total-rules"
        />
        <MetricCard
          label="Active"
          value={report.total_active_rules.toLocaleString()}
          testId="kpi-active-rules"
        />
        <MetricCard
          label="Alerts 12mo"
          value={report.total_alerts_12mo.toLocaleString()}
          testId="kpi-alerts-12mo"
        />
        <MetricCard
          label="This month"
          value={report.triggers_month_total.toLocaleString()}
          testId="kpi-triggers-month"
        />
        <MetricCard
          label="Mean precision"
          value={pct(report.mean_precision_pct)}
          tone={
            report.mean_precision_pct !== null && report.mean_precision_pct >= 60
              ? 'success'
              : 'warning'
          }
          testId="kpi-mean-precision"
        />
        <MetricCard
          label="Mean FP rate"
          value={pct(report.mean_false_positive_rate)}
          tone={
            report.mean_false_positive_rate !== null && report.mean_false_positive_rate <= 30
              ? 'success'
              : 'danger'
          }
          testId="kpi-mean-fp"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CohortChips title="By state" data={report.by_state} />
        <CohortChips title="By family" data={report.by_family} />
        <CohortChips title="By severity" data={report.by_severity} />
        <CohortChips title="By performance" data={report.by_performance_status} />
      </div>

      <MonthlyVolumeChart report={report} />

      <RulesTable
        title="Top firing"
        rows={report.top_firing}
        emptyMsg="No active rules have fired in the last 12 months."
        testid="top-firing-table"
      />

      <RulesTable
        title="Underperforming"
        rows={report.underperforming}
        emptyMsg="Every active rule is in the performing band."
        testid="underperforming-table"
      />

      <RulesTable
        title="Silent rules (active, zero firings)"
        rows={report.silent_rules}
        emptyMsg="Every active rule has fired at least once in the last 12 months."
        testid="silent-rules-table"
      />
    </div>
  );
}
