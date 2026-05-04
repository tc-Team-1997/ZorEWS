import { cn } from '@/lib/cn';

/**
 * Time range options exposed by <TimeRangeSelector>. The "weeks" value
 * is what the chart uses to slice trailing data points off its series.
 *
 *   - 7d   → trailing 1 week of data points
 *   - 30d  → trailing ~4 weeks
 *   - 90d  → trailing ~12 weeks (the full mock window)
 *   - all  → no slice
 *
 * MTD/QTD/YTD/comparison-mode are intentionally NOT in the prototype —
 * see the dashboard sprint notes for the deferred list.
 */
export type TimeRangeKey = '7d' | '30d' | '90d' | 'all';

export const DEFAULT_RANGE: TimeRangeKey = '30d';

/** Trailing weeks to keep for each option. `null` means keep everything. */
export const RANGE_WEEKS: Record<TimeRangeKey, number | null> = {
  '7d': 1,
  '30d': 4,
  '90d': 12,
  all: null,
};

const OPTIONS: ReadonlyArray<{ key: TimeRangeKey; label: string }> = [
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: 'all', label: 'All' },
];

export function isTimeRangeKey(v: string | null): v is TimeRangeKey {
  return v === '7d' || v === '30d' || v === '90d' || v === 'all';
}

/**
 * Slice helper — keep the trailing N entries of a time-series array
 * based on the selected range. Centralised here so charts that share
 * a selector stay in sync.
 */
export function sliceForRange<T>(series: readonly T[], range: TimeRangeKey): T[] {
  const weeks = RANGE_WEEKS[range];
  if (weeks === null) return [...series];
  return series.slice(-weeks);
}

export function TimeRangeSelector({
  value,
  onChange,
  testId,
}: {
  value: TimeRangeKey;
  onChange: (next: TimeRangeKey) => void;
  testId?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Time range"
      data-testid={testId}
      className="inline-flex rounded-input border border-divider bg-surface overflow-hidden"
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.key;
        return (
          <button
            key={opt.key}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(opt.key)}
            data-testid={`time-range-${opt.key}`}
            className={cn(
              'px-2.5 py-1 text-[11px] font-medium tabular transition-colors focus:outline-none focus:ring-2 focus:ring-brand-blue/40 focus:relative',
              active
                ? 'bg-brand-blue text-white'
                : 'text-ink-sub hover:bg-brand-skyLight hover:text-brand-blue',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
