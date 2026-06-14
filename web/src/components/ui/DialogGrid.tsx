// web/src/components/ui/DialogGrid.tsx
//
// Standard responsive form grid for dialog bodies: single column on small
// screens, two columns from md up. `DialogGrid.FullWidth` spans both columns
// for fields (or sections) that need the full row.

import type { ReactNode } from 'react';

export function DialogGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 ${className}`}>{children}</div>;
}

DialogGrid.FullWidth = function FullWidth({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`md:col-span-2 ${className}`}>{children}</div>;
};
