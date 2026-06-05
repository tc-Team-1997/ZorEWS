// web/src/components/dashboard/AlertDeepDrilldown.tsx
//
// Multi-dimension drill-down panel. When a user clicks a bar/dot the
// section above passes us `{filter}` (e.g. severity=critical) and we
// compute distributions across the OTHER dimensions on that subset.
//
// No repetition rule: we deliberately DROP the filtered dimension from
// the sub-sections (showing "100% critical" inside a "drilling into
// critical" panel is useless). The spec calls for 7 axes; we render the
// 4 axes that have real data, and surface the 3 deferred axes
// (category / module / source) as empty-state callouts that explain
// why they're empty + what BFF extension would light them up.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { X, ExternalLink, Info } from 'lucide-react';
import {
  aggregate,
  aggregateTimeline,
  filterByDimension,
  topCustomers,
  type AlertDimension,
} from '@/lib/alertDimensions';
import type { Alert } from '@/lib/api';
import { Panel } from '@/components/ui';
import { AlertBarChart } from './charts/AlertBarChart';
import { AlertTrendChart } from './charts/AlertTrendChart';
import { fmtKES } from '@/lib/currency';

export interface DrillFilter {
  dimension: AlertDimension;
  value: string;
}

export interface AlertDeepDrilldownProps {
  alerts: readonly Alert[];
  filter: DrillFilter;
  onClose: () => void;
  /** When set, clicking a sub-section bar OPENS that drill instead of just
   *  filtering further (caller decides). Defaults to a no-op. */
  onSubDrill?: (next: DrillFilter) => void;
  testId?: string;
}

const HUMAN_DIMENSION_LABEL: Record<AlertDimension, string> = {
  severity: 'Severity',
  status: 'Status',
  risk_band: 'Risk band',
  category: 'Category',
  module: 'Module',
  source: 'Source',
};

const DEFERRED_DIMENSION_NOTE: Record<string, string> = {
  category: 'rule.category not exposed by BFF yet. Today every alert is "unclassified".',
  module: 'rule.module not exposed by BFF yet. Today every alert is "unclassified".',
  source: 'alert.source not exposed by BFF yet. Today every alert reports "rule_engine".',
};

// Which sub-sections to render, in display order. Filter the clicked
// dimension OUT so we don't repeat what the user already knows.
const ALL_SUB_DIMENSIONS: AlertDimension[] = [
  'severity',
  'status',
  'risk_band',
  'category',
  'module',
  'source',
];

export function AlertDeepDrilldown({
  alerts,
  filter,
  onClose,
  onSubDrill,
  testId = 'alert-deep-drilldown',
}: AlertDeepDrilldownProps) {
  const subset = useMemo(
    () => filterByDimension(alerts, filter.dimension, filter.value),
    [alerts, filter.dimension, filter.value],
  );

  const subDimensions = useMemo(
    () => ALL_SUB_DIMENSIONS.filter((d) => d !== filter.dimension),
    [filter.dimension],
  );

  const timeline = useMemo(() => aggregateTimeline(subset), [subset]);
  const top5 = useMemo(() => topCustomers(subset, 5), [subset]);
  const totalExposure = subset.reduce((s, a) => s + (a.customer_exposure_kes ?? 0), 0);
  const meanCriticality = subset.length
    ? subset.reduce((s, a) => s + a.criticality_score, 0) / subset.length
    : 0;

  return (
    <Panel
      data-testid={testId}
      title={
        <span className="flex items-center gap-2 text-[13px]">
          <span className="text-muted">Drill-down ·</span>
          <span className="font-semibold capitalize text-ink">
            {HUMAN_DIMENSION_LABEL[filter.dimension]} = {filter.value}
          </span>
          <span className="text-muted">·</span>
          <span className="tabular text-ink">{subset.length.toLocaleString()} alerts</span>
        </span>
      }
      action={
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 text-[12px] text-muted hover:text-ink transition-colors"
          aria-label="Close drill-down"
          data-testid={`${testId}-close`}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Close
        </button>
      }
    >
      {subset.length === 0 ? (
        <div
          data-testid={`${testId}-empty`}
          className="py-8 text-center text-[12px] text-muted"
        >
          No alerts match this filter.
        </div>
      ) : (
        <>
          {/* ── Top stats strip — non-duplicate aggregates ── */}
          <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid={`${testId}-stats`}>
            <Stat label="Subset size" value={subset.length.toLocaleString()} />
            <Stat
              label="Mean criticality"
              value={meanCriticality.toFixed(2)}
              tone={meanCriticality >= 6 ? 'danger' : meanCriticality >= 3 ? 'warning' : 'muted'}
            />
            <Stat
              label="Distinct customers"
              value={new Set(subset.map((a) => a.customer?.id ?? '?')).size.toLocaleString()}
            />
            <Stat label="Total exposure (KES)" value={fmtKES(totalExposure)} />
          </div>

          {/* ── Timeline trend (always shown — the time axis is orthogonal) ── */}
          <div className="mb-4">
            <h4 className="text-[12px] font-semibold text-ink mb-1 uppercase tracking-wide">
              Timeline · {timeline.length} day{timeline.length === 1 ? '' : 's'}
            </h4>
            <AlertTrendChart
              alerts={subset}
              testId={`${testId}-timeline`}
              height={160}
            />
          </div>

          {/* ── Per-dimension breakdowns (drops the filtered dim) ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {subDimensions.map((dim) => (
              <SubDimensionCard
                key={dim}
                alerts={subset}
                dimension={dim}
                onSubDrill={onSubDrill}
                testId={`${testId}-sub-${dim}`}
              />
            ))}
          </div>

          {/* ── Top customers (the actionable rollup) ── */}
          <div>
            <h4 className="text-[12px] font-semibold text-ink mb-2 uppercase tracking-wide">
              Top {top5.length} affected customers
            </h4>
            <table className="w-full text-[12px]" data-testid={`${testId}-top-customers`}>
              <thead className="text-muted">
                <tr className="border-b border-divider">
                  <th className="text-left py-1.5 font-medium">Customer</th>
                  <th className="text-right py-1.5 font-medium">Alerts</th>
                  <th className="text-right py-1.5 font-medium">Exposure (KES)</th>
                  <th className="py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {top5.map((c) => (
                  <tr key={c.customer_id} className="border-b border-divider/40">
                    <td className="py-1.5 text-ink">{c.customer_name}</td>
                    <td className="py-1.5 text-right tabular text-ink">{c.count}</td>
                    <td className="py-1.5 text-right tabular text-ink">{fmtKES(c.total_exposure_kes)}</td>
                    <td className="py-1.5 text-right">
                      <Link
                        to={`/customers/${c.customer_id}`}
                        className="inline-flex items-center gap-1 text-[11px] text-action hover:underline"
                      >
                        Open <ExternalLink className="h-3 w-3" aria-hidden />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: string;
  tone?: 'muted' | 'warning' | 'danger';
}) {
  const valueClass =
    tone === 'danger'
      ? 'text-danger font-semibold'
      : tone === 'warning'
        ? 'text-warning font-semibold'
        : 'text-ink font-semibold';
  return (
    <div className="rounded-md border border-divider px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-[14px] tabular mt-0.5 ${valueClass}`}>{value}</div>
    </div>
  );
}

interface SubDimensionCardProps {
  alerts: readonly Alert[];
  dimension: AlertDimension;
  onSubDrill?: (next: DrillFilter) => void;
  testId: string;
}

function SubDimensionCard({ alerts, dimension, onSubDrill, testId }: SubDimensionCardProps) {
  const buckets = useMemo(() => aggregate(alerts, dimension), [alerts, dimension]);
  const hasRealData = buckets.length > 1 || (buckets.length === 1 && buckets[0].value !== 'unclassified' && buckets[0].value !== 'rule_engine');
  const deferredNote = DEFERRED_DIMENSION_NOTE[dimension];

  return (
    <div
      className="rounded-md border border-divider p-3"
      data-testid={testId}
    >
      <div className="mb-2 flex items-center justify-between">
        <h5 className="text-[11px] font-semibold uppercase tracking-wide text-ink">
          By {HUMAN_DIMENSION_LABEL[dimension].toLowerCase()}
        </h5>
        {deferredNote && !hasRealData && (
          <span
            className="text-[10px] text-muted inline-flex items-center gap-1"
            title={deferredNote}
            data-testid={`${testId}-deferred`}
          >
            <Info className="h-3 w-3" aria-hidden /> pending API
          </span>
        )}
      </div>
      {!hasRealData && deferredNote ? (
        <div className="text-[11px] text-muted leading-relaxed" data-testid={`${testId}-note`}>
          {deferredNote}
        </div>
      ) : (
        <AlertBarChart
          alerts={alerts}
          dimension={dimension}
          onSelect={(value) => {
            if (value && onSubDrill) onSubDrill({ dimension, value });
          }}
          testId={`${testId}-chart`}
          height={140}
        />
      )}
    </div>
  );
}

// fmtKES now imported from @/lib/currency — local stub removed.

