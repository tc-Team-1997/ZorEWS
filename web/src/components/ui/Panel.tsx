import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

export function Panel({
  title,
  action,
  children,
  className,
  'data-testid': testId,
}: {
  /** Accepts a plain string (legacy callers) or any ReactNode for richer
   *  headers (icon + count chip). Widening string → ReactNode is type-safe
   *  — every existing string call site still passes. */
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <section className={cn('card p-5', className)} data-testid={testId}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between">
          {title && <h2 className="section-title">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
