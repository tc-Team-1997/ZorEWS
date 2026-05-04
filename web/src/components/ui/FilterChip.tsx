import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

/**
 * Pill button used by list pages to switch a single filter dimension.
 * Active state = "this is the currently-selected option for this dimension".
 *
 * For a removable filter summary (e.g. "Filtered by: PD ≥ 0.5  ✕"),
 * use <ActiveFilterChip> below — same visual language but with an X
 * affordance and a different aria-label semantic.
 */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-badge px-2.5 py-1 text-[11px] font-medium capitalize transition-colors',
        active
          ? 'bg-brand-blue text-white'
          : 'bg-divider text-ink-sub hover:bg-brand-skyLight hover:text-brand-blue',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Removable summary chip — shown above a list when a filter is applied
 * via URL params (e.g. dashboard KPI deep-link). Click X to clear and
 * fall back to the unfiltered view.
 */
export function ActiveFilterChip({
  label,
  onClear,
  testId,
}: {
  label: string;
  onClear: () => void;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-badge bg-brand-skyLight text-brand-blue px-2.5 py-1 text-[11px] font-medium"
    >
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear filter: ${label}`}
        className="inline-flex items-center justify-center w-4 h-4 rounded hover:bg-brand-blue/15"
      >
        <X size={11} strokeWidth={2.5} />
      </button>
    </span>
  );
}
