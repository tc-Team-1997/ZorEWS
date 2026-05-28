import { cn } from '@/lib/cn';

// Reusable loading primitives — replace the ad-hoc "Loading…" text with
// content-shaped shimmer blocks. Pure CSS (animate-pulse), no deps. Used
// by widget containers + tables + cards while data is in flight.

/** A single shimmer block. Width/height via Tailwind classes. */
export function Skeleton({
  className,
  testId,
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId ?? 'skeleton'}
      aria-hidden="true"
      className={cn('animate-pulse rounded bg-divider', className)}
    />
  );
}

/** N stacked text-line skeletons of decreasing width — mimics a paragraph. */
export function SkeletonText({
  lines = 3,
  className,
  testId,
}: {
  lines?: number;
  className?: string;
  testId?: string;
}) {
  const widths = ['w-full', 'w-11/12', 'w-4/5', 'w-3/4', 'w-2/3'];
  return (
    <div
      data-testid={testId ?? 'skeleton-text'}
      aria-hidden="true"
      className={cn('space-y-2', className)}
    >
      {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3', widths[i % widths.length])} />
      ))}
    </div>
  );
}

/** A card-shaped skeleton — a title bar + a few text lines, sized for a
 *  widget body. Drop straight into a WidgetContainer's loading slot. */
export function SkeletonCard({
  className,
  testId,
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId ?? 'skeleton-card'} className={cn('space-y-3', className)}>
      <Skeleton className="h-4 w-1/3" />
      <SkeletonText lines={3} />
    </div>
  );
}
