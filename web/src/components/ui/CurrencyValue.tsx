// web/src/components/ui/CurrencyValue.tsx
//
// Shared KPI currency value component.
// Displays compact monetary value with full-value tooltip.
// Enforces single-line overflow protection on all KPI cards.

import { fmtCompact, fmtFull, type FormatOptions } from '@/lib/currency';
import { cn } from '@/lib/cn';

interface CurrencyValueProps {
  /** Raw numeric value in KES. */
  value: number;
  /** Extra class names for the root span. */
  className?: string;
  /** Compact format options. */
  opts?: FormatOptions;
  /** Override the tooltip text (default: fmtFull(value)). */
  tooltip?: string;
  /** When true renders the full value without compacting. Use in exports/reports. */
  full?: boolean;
}

/**
 * Enterprise monetary KPI value.
 *
 * Renders a compact formatted value (e.g. "511.32Cr") with a native
 * browser tooltip containing the exact figure (e.g. "KES 5,11,32,20,000").
 * Enforces single-line overflow protection so KPI cards never break layout.
 *
 * @example
 * <CurrencyValue value={5_113_220_000} />  → "511.32Cr"  (tooltip: "KES 5,11,32,20,000")
 * <CurrencyValue value={125_000} />          → "1.25L"     (tooltip: "KES 1,25,000")
 */
export function CurrencyValue({ value, className, opts, tooltip, full = false }: CurrencyValueProps) {
  const displayText = full ? fmtFull(value) : fmtCompact(value, opts);
  const tooltipText = tooltip ?? fmtFull(value);

  return (
    <span
      title={tooltipText}
      aria-label={tooltipText}
      className={cn(
        // Overflow protection — never wraps, never overflows
        'inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap',
        // Tabular numbers for alignment in tables
        'tabular-nums',
        className,
      )}
    >
      {displayText}
    </span>
  );
}

/**
 * Compact row of label + currency value for detail panels.
 */
export function CurrencyRow({
  label,
  value,
  className,
  opts,
}: {
  label: string;
  value: number;
  className?: string;
  opts?: FormatOptions;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2 min-w-0', className)}>
      <span className="text-[11.5px] text-gray-500 truncate shrink">{label}</span>
      <CurrencyValue value={value} opts={opts} className="text-[12px] font-semibold text-gray-900 shrink-0" />
    </div>
  );
}
