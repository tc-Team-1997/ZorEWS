// AlertDrilldown — granular analytics for the dashboard charts.
//
// Two modes:
//
//   1. <SeverityDrilldown severity="critical" /> renders when an operator
//      clicks a bar on the "Alerts by severity" chart. Shows 4 distinct
//      angles on the alerts at that severity — top rules, top customers
//      by exposure, age distribution, assignee mix. Each angle answers
//      a different operational question so the panel isn't repetitive.
//
//   2. <TrendWeekDrilldown week="2026-05-04" /> renders when an operator
//      clicks a point on the "Portfolio PD trend" chart. Shows what
//      happened that calendar week — severity mix, rule fan-out, top
//      customers — angles that complement the severity drill-down,
//      so navigating from severity → week → severity doesn't loop on
//      the same data.
//
// Both components do their own /api/alerts fetch (cached by react-query
// under distinct keys) and compute their breakdowns client-side. No new
// BFF surface needed; the existing AlertListResponse is rich enough.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { api, type Alert, type Severity } from '@/lib/api';
import { Badge, Panel } from '@/components/ui';
import { fmtKES } from '@/lib/currency';

const SEVERITY_TONE: Record<Severity, 'danger' | 'warning' | 'blue' | 'success'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'blue',
  low: 'success',
};

const AGE_BUCKETS = [
  { key: '0-2h', label: '0–2 h', maxMin: 120 },
  { key: '2-12h', label: '2–12 h', maxMin: 720 },
  { key: '12-48h', label: '12–48 h', maxMin: 2880 },
  { key: '>48h', label: '> 48 h', maxMin: Number.POSITIVE_INFINITY },
] as const;

function bucketForMin(min: number) {
  for (const b of AGE_BUCKETS) {
    if (min <= b.maxMin) return b.key;
  }
  return AGE_BUCKETS[AGE_BUCKETS.length - 1].key;
}

function topN<T>(arr: T[], by: (x: T) => number, n: number): T[] {
  return [...arr].sort((a, b) => by(b) - by(a)).slice(0, n);
}

interface DrilldownShellProps {
  title: string;
  subtitle: string;
  onClose: () => void;
  testId: string;
  children: React.ReactNode;
}

function DrilldownShell({ title, subtitle, onClose, testId, children }: DrilldownShellProps) {
  return (
    <Panel
      title={title}
      action={
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 text-2xs text-muted hover:text-ink"
          data-testid={`${testId}-close`}
        >
          <X size={12} /> Close
        </button>
      }
    >
      <p className="caption mb-3" data-testid={`${testId}-subtitle`}>{subtitle}</p>
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
        data-testid={testId}
      >
        {children}
      </div>
    </Panel>
  );
}

interface MiniListProps {
  title: string;
  rows: ReadonlyArray<{ key: string; label: React.ReactNode; metric: React.ReactNode }>;
  empty: string;
  testId: string;
}

function MiniList({ title, rows, empty, testId }: MiniListProps) {
  return (
    <div
      className="rounded-md border border-divider bg-page p-3"
      data-testid={testId}
    >
      <p className="text-2xs font-semibold uppercase tracking-wide text-muted mb-2">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="text-2xs italic text-muted">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex items-center justify-between gap-2 text-2xs"
            >
              <span className="flex-1 truncate text-ink">{r.label}</span>
              <span className="font-mono tabular-nums text-muted shrink-0">{r.metric}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Severity drill-down ────────────────────────────────────────────

interface SeverityDrilldownProps {
  severity: Severity;
  onClose: () => void;
}

export function SeverityDrilldown({ severity, onClose }: SeverityDrilldownProps) {
  const q = useQuery({
    queryKey: ['dashboard.alerts.by-severity', severity],
    queryFn: () => api.alerts({ severity, dedup: false }),
  });

  const items = q.data?.items ?? [];

  const byRule = useMemo(() => groupCount(items, (a) => a.rule.id, (a) => a.rule.name), [items]);
  const byCustomerExposure = useMemo(
    () =>
      topN(
        Object.values(
          items.reduce<Record<string, { customer: Alert['customer']; exposure: number; count: number }>>(
            (acc, a) => {
              const k = a.customer.id;
              acc[k] ??= { customer: a.customer, exposure: 0, count: 0 };
              acc[k].exposure = Math.max(acc[k].exposure, a.customer_exposure_kes);
              acc[k].count += 1;
              return acc;
            },
            {},
          ),
        ),
        (x) => x.exposure,
        5,
      ),
    [items],
  );
  const byAge = useMemo(() => {
    const buckets: Record<string, number> = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
    for (const a of items) buckets[bucketForMin(a.age_min)] = (buckets[bucketForMin(a.age_min)] ?? 0) + 1;
    return AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: buckets[b.key] ?? 0 }));
  }, [items]);
  const assigneeMix = useMemo(() => {
    const assigned = items.filter((a) => a.assignee && a.assignee.trim()).length;
    return { assigned, unassigned: items.length - assigned, total: items.length };
  }, [items]);
  // Top indicators — a 5th lens distinct from rules, customers, age,
  // assignee. Each alert can fire >1 indicator (e.g. "DPD_30 + SAL_STOP")
  // so the totals here exceed items.length; the ratio shown is share of
  // alerts in which the indicator appeared, not share of indicators.
  const byIndicator = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of items) {
      for (const ind of a.indicators ?? []) {
        counts[ind] = (counts[ind] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
  }, [items]);

  const subtitle = q.isLoading
    ? 'Loading…'
    : items.length === 0
      ? `No ${severity} alerts in the current view.`
      : `Breaking down ${items.length} ${severity} alert${items.length === 1 ? '' : 's'} into 5 angles — each panel answers a different question so nothing repeats.`;

  return (
    <DrilldownShell
      title={`Alert breakdown · ${severity.toUpperCase()}`}
      subtitle={subtitle}
      onClose={onClose}
      testId="severity-drilldown"
    >
      <MiniList
        title="Top rules firing"
        testId="severity-drilldown-rules"
        empty="No rules to rank."
        rows={topN(byRule, (r) => r.count, 5).map((r) => ({
          key: r.id,
          label: (
            <Link
              to={`/alerts?severity=${severity}&rule_id=${encodeURIComponent(r.id)}`}
              className="text-action hover:underline"
            >
              {r.label}
            </Link>
          ),
          metric: `${r.count} alert${r.count === 1 ? '' : 's'}`,
        }))}
      />
      <MiniList
        title="Top customers by exposure"
        testId="severity-drilldown-customers"
        empty="No exposure data available."
        rows={byCustomerExposure.map((c) => ({
          key: c.customer.id,
          label: (
            <Link
              to={`/customers/${encodeURIComponent(c.customer.id)}`}
              className="text-action hover:underline"
            >
              {c.customer.name}
            </Link>
          ),
          metric: `${fmtKES(c.exposure)} · ${c.count}×`,
        }))}
      />
      <MiniList
        title="Age distribution"
        testId="severity-drilldown-age"
        empty="No alerts to bucket."
        rows={byAge.map((b) => ({
          key: b.key,
          label: b.label,
          metric: `${b.count} · ${pctOf(b.count, items.length)}`,
        }))}
      />
      <MiniList
        title="Assignment status"
        testId="severity-drilldown-assignee"
        empty="No assignment data."
        rows={[
          {
            key: 'assigned',
            label: 'Assigned',
            metric: `${assigneeMix.assigned} · ${pctOf(assigneeMix.assigned, assigneeMix.total)}`,
          },
          {
            key: 'unassigned',
            label: (
              <Link
                to={`/alerts?severity=${severity}&assignee=unassigned`}
                className="text-action hover:underline"
              >
                Unassigned (queue triage)
              </Link>
            ),
            metric: `${assigneeMix.unassigned} · ${pctOf(assigneeMix.unassigned, assigneeMix.total)}`,
          },
        ]}
      />
      <MiniList
        title="Top indicators firing"
        testId="severity-drilldown-indicators"
        empty="No indicators captured on these alerts."
        rows={byIndicator.slice(0, 5).map((r) => ({
          key: r.id,
          label: <span className="font-mono text-2xs">{r.id}</span>,
          metric: `${r.count}× · ${pctOf(r.count, items.length)} of alerts`,
        }))}
      />
    </DrilldownShell>
  );
}

// ── Trend week drill-down ──────────────────────────────────────────

interface TrendWeekDrilldownProps {
  week: string;
  pd: number;
  prevPd: number | null;
  onClose: () => void;
}

export function TrendWeekDrilldown({
  week,
  pd,
  prevPd,
  onClose,
}: TrendWeekDrilldownProps) {
  // Trend rows are stamped to a week-start ISO date. Filter alerts whose
  // `created_at` falls within [week, week + 7d). The all-alerts query is
  // cheap and react-query caches the result across week clicks.
  const q = useQuery({
    queryKey: ['dashboard.alerts.all-for-trend-drill'],
    queryFn: () => api.alerts({ dedup: false }),
  });

  const items = useMemo(() => {
    const all = q.data?.items ?? [];
    const start = new Date(week);
    if (Number.isNaN(start.getTime())) return [];
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    const startMs = start.getTime();
    const endMs = end.getTime();
    return all.filter((a) => {
      const ts = new Date(a.created_at).getTime();
      return ts >= startMs && ts < endMs;
    });
  }, [q.data, week]);

  const bySeverity = useMemo(() => {
    const out: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const a of items) out[a.severity] = (out[a.severity] ?? 0) + 1;
    return out;
  }, [items]);
  const byRule = useMemo(() => groupCount(items, (a) => a.rule.id, (a) => a.rule.name), [items]);
  const byCustomerCount = useMemo(
    () => groupCount(items, (a) => a.customer.id, (a) => a.customer.name),
    [items],
  );
  // Top indicators firing in this week — a 4th lens distinct from
  // severity, rules, customers. Each alert can fire >1 indicator so
  // the percentages here are share-of-alerts, not share-of-indicators.
  const byIndicator = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of items) {
      for (const ind of a.indicators ?? []) {
        counts[ind] = (counts[ind] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count);
  }, [items]);

  const delta = prevPd == null ? null : pd - prevPd;
  const deltaPct = prevPd == null || prevPd === 0 ? null : ((pd - prevPd) / prevPd) * 100;

  const subtitle = q.isLoading
    ? 'Loading…'
    : items.length === 0
      ? `Week of ${week} — portfolio PD ${(pd * 100).toFixed(2)}%. No alerts fired that week.`
      : `Week of ${week} · portfolio PD ${(pd * 100).toFixed(2)}%${
          delta != null
            ? ` · ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)} pp wow${
                deltaPct != null
                  ? ` (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)} %)`
                  : ''
              }`
            : ''
        }. ${items.length} alert${items.length === 1 ? '' : 's'} fired — 4 angles below.`;

  return (
    <DrilldownShell
      title={`Week of ${week} · drill-down`}
      subtitle={subtitle}
      onClose={onClose}
      testId="trend-drilldown"
    >
      <MiniList
        title="Severity mix this week"
        testId="trend-drilldown-severity"
        empty="No alerts to bucket."
        rows={(['critical', 'high', 'medium', 'low'] as const).map((s) => ({
          key: s,
          label: (
            <span className="inline-flex items-center gap-1.5">
              <Badge tone={SEVERITY_TONE[s]} className="uppercase">
                {s}
              </Badge>
            </span>
          ),
          metric: `${bySeverity[s]} · ${pctOf(bySeverity[s], items.length)}`,
        }))}
      />
      <MiniList
        title="Top rules firing"
        testId="trend-drilldown-rules"
        empty="No rules to rank."
        rows={topN(byRule, (r) => r.count, 5).map((r) => ({
          key: r.id,
          label: (
            <Link
              to={`/alerts?rule_id=${encodeURIComponent(r.id)}`}
              className="text-action hover:underline"
            >
              {r.label}
            </Link>
          ),
          metric: `${r.count}`,
        }))}
      />
      <MiniList
        title="Customers most affected"
        testId="trend-drilldown-customers"
        empty="No customers to rank."
        rows={topN(byCustomerCount, (r) => r.count, 5).map((r) => ({
          key: r.id,
          label: (
            <Link
              to={`/customers/${encodeURIComponent(r.id)}`}
              className="text-action hover:underline"
            >
              {r.label}
            </Link>
          ),
          metric: `${r.count} alert${r.count === 1 ? '' : 's'}`,
        }))}
      />
      <MiniList
        title="Top indicators firing"
        testId="trend-drilldown-indicators"
        empty="No indicators captured on these alerts."
        rows={byIndicator.slice(0, 5).map((r) => ({
          key: r.id,
          label: <span className="font-mono text-2xs">{r.id}</span>,
          metric: `${r.count}× · ${pctOf(r.count, items.length)} of alerts`,
        }))}
      />
    </DrilldownShell>
  );
}

// ── Shared helpers ─────────────────────────────────────────────────

function groupCount<T>(
  arr: T[],
  idOf: (x: T) => string,
  labelOf: (x: T) => string,
): { id: string; label: string; count: number }[] {
  const out: Record<string, { id: string; label: string; count: number }> = {};
  for (const a of arr) {
    const id = idOf(a);
    out[id] ??= { id, label: labelOf(a), count: 0 };
    out[id].count += 1;
  }
  return Object.values(out);
}

function pctOf(part: number, total: number): string {
  if (total === 0) return '0 %';
  return `${Math.round((part / total) * 100)} %`;
}

// fmtKES now imported from @/lib/currency — local stub removed.
