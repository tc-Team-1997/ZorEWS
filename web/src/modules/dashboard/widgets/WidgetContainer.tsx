import type { ReactNode } from 'react';
import { Panel, EmptyState, SkeletonCard } from '@/components/ui';

// Phase 3 — Dashboard Foundation: the standard widget chrome.
//
// Thin, reuse-first wrapper over the existing <Panel>. Every dashboard
// widget renders inside one so they share identical chrome, spacing, and
// loading/empty/error behaviour — the "module container" of the brief.
// State precedence: error > loading > empty > children. Reuses the
// existing Panel + the new EmptyState/Skeleton primitives; introduces no
// new visual language.

interface Props {
  title: ReactNode;
  /** Optional header action (link / menu / time-range chip). */
  action?: ReactNode;
  loading?: boolean;
  /** When true (and not loading/error), render the empty state. */
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Error message — takes precedence over loading/empty. */
  error?: string | null;
  children?: ReactNode;
  className?: string;
  testId?: string;
}

export function WidgetContainer({
  title,
  action,
  loading,
  empty,
  emptyTitle = 'Nothing to show',
  emptyDescription,
  error,
  children,
  className,
  testId,
}: Props) {
  return (
    <Panel title={title} action={action} className={className} data-testid={testId ?? 'widget'}>
      {error ? (
        <EmptyState
          compact
          title="Couldn't load this widget"
          description={error}
          testId="widget-error"
        />
      ) : loading ? (
        <SkeletonCard testId="widget-loading" />
      ) : empty ? (
        <EmptyState
          compact
          title={emptyTitle}
          description={emptyDescription}
          testId="widget-empty"
        />
      ) : (
        children
      )}
    </Panel>
  );
}
