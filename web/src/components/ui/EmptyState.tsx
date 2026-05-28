import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Reusable empty-state primitive — replaces the ad-hoc inline
// "no rows" / "nothing here" markup scattered across pages with one
// consistent, token-styled surface. Used by widget containers, tables,
// list pages, and dashboards.

interface Props {
  /** Optional leading icon (e.g. a lucide icon element). */
  icon?: ReactNode;
  /** Short headline — what's empty. */
  title: string;
  /** Optional one-line explanation / next step. */
  description?: string;
  /** Optional call-to-action (button/link). */
  action?: ReactNode;
  /** Tighter padding for use inside small widget bodies. */
  compact?: boolean;
  className?: string;
  testId?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  className,
  testId,
}: Props) {
  return (
    <div
      role="status"
      data-testid={testId ?? 'empty-state'}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-6 px-3 gap-1.5' : 'py-12 px-6 gap-2',
        className,
      )}
    >
      {icon && (
        <div className="text-muted/70 mb-1" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {description && <p className="text-[12px] text-muted max-w-[280px]">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
