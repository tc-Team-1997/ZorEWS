import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        {/* Aurora accent bar — premium page-header treatment, decorative. */}
        <span
          aria-hidden="true"
          className="mt-1 h-7 w-1 shrink-0 rounded-full bg-gradient-to-b from-aurora-indigo to-aurora-violet"
        />
        <div>
          <h1 className="page-title tracking-tight">{title}</h1>
          {subtitle && <p className="caption mt-1">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
