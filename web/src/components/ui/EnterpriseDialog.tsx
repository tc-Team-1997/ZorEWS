// web/src/components/ui/EnterpriseDialog.tsx
//
// Thin, opinionated wrapper over the headless `Modal` primitive. Gives every
// dialog in the SPA the same shape:
//   - sticky header (title + optional description) with a SINGLE close icon
//   - scrollable body
//   - optional fixed footer (action row, composed via DialogFooter)
//   - standard size → pixel-width mapping (480/720/960/1200) via Modal.widthClass
//
// Reuses Modal's esc/focus/scroll-lock/aria. Modal's own floating X is
// suppressed (showCloseButton={false}) so there is exactly one close control.

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Modal } from './Modal';

export type EnterpriseDialogSize = 'sm' | 'md' | 'lg' | 'xl';

const WIDTH: Record<EnterpriseDialogSize, string> = {
  sm: 'max-w-[480px]',
  md: 'max-w-[720px]',
  lg: 'max-w-[960px]',
  xl: 'max-w-[1200px]',
};

export interface EnterpriseDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: EnterpriseDialogSize;
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  testId?: string;
  children: ReactNode;
}

export function EnterpriseDialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  closeOnBackdrop,
  closeOnEsc,
  testId,
  children,
}: EnterpriseDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={title}
      widthClass={WIDTH[size]}
      showCloseButton={false}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEsc={closeOnEsc}
      testId={testId}
    >
      <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-aurora-line bg-white px-6 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-aurora-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid={testId ? `${testId}-close` : 'dialog-close'}
          aria-label="Close dialog"
          className="shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <X size={18} aria-hidden />
        </button>
      </header>
      <div className="px-6 py-6 break-words">{children}</div>
      {footer && (
        <footer className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-aurora-line bg-white px-6 py-3">
          {footer}
        </footer>
      )}
    </Modal>
  );
}
