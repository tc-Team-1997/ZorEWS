import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('card p-5', className)}>
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
