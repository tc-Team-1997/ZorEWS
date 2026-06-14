// web/src/components/ui/Modal.tsx
//
// Reusable headless modal primitive. Standardises the overlay pattern
// every admin page currently re-implements:
//   - fixed inset-0 z-50 backdrop with blur
//   - centered content container with max-h + scroll
//   - backdrop click → onClose
//   - Escape key → onClose
//   - body-scroll lock while open (restored on unmount)
//   - focus moved into the modal on open + restored to the previous
//     active element on close
//   - role="dialog" + aria-modal="true" + aria-label/labelledby
//
// Headless by design: the modal does NOT impose a title bar or footer.
// Callers compose their own header/body/footer (or just drop a Panel
// inside). That keeps the primitive a drop-in for the 12 existing
// duplicated modal overlays without forcing a refactor of each one.

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';

const MAX_W_BY_SIZE: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
};

export interface ModalProps {
  /** Controlled — render nothing when false. */
  open: boolean;
  /** Called for: backdrop click, Escape key, top-right X click. */
  onClose: () => void;
  /** Accessibility name. Required. */
  ariaLabel: string;
  /** Optional. Default '2xl'. */
  size?: ModalSize;
  /** Optional Tailwind max-width class (e.g. `max-w-[720px]`). When set it
   *  overrides the `size`-derived width on the content container. Additive:
   *  callers that omit it keep the `size` default behaviour. */
  widthClass?: string;
  /** Default true. Set false when an in-progress form must not be
   *  discarded by an accidental backdrop click. */
  closeOnBackdrop?: boolean;
  /** Default true. */
  closeOnEsc?: boolean;
  /** Render the floating top-right X close button. Default true. */
  showCloseButton?: boolean;
  /** Optional data-testid on the backdrop container. The inner content
   *  container gets `${testId}-content`. */
  testId?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  ariaLabel,
  size = '2xl',
  widthClass,
  closeOnBackdrop = true,
  closeOnEsc = true,
  showCloseButton = true,
  testId,
  children,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Escape key + body-scroll lock + focus management while open.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKey = (e: KeyboardEvent) => {
      if (closeOnEsc && e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);

    // Focus the content container on the next tick so screen readers
    // pick up the dialog before any heading inside it.
    const t = window.setTimeout(() => {
      contentRef.current?.focus();
    }, 0);

    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(t);
      // Restore focus to the trigger so keyboard users land back where
      // they were. Wrap in try because the original element may have
      // unmounted (e.g. nav happened).
      try {
        previouslyFocused.current?.focus();
      } catch {
        /* noop */
      }
    };
  }, [open, onClose, closeOnEsc]);

  if (!open) return null;

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only treat clicks on the BACKDROP itself as close — clicks that
    // bubbled up from interactive content inside the modal stop at the
    // content container (see onClick={stopPropagation} below).
    if (!closeOnBackdrop) return;
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
    >
      <div
        ref={contentRef}
        tabIndex={-1}
        data-testid={testId ? `${testId}-content` : undefined}
        onClick={(e) => e.stopPropagation()}
        className={`relative ${widthClass ?? MAX_W_BY_SIZE[size]} w-full max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl outline-none`}
      >
        {showCloseButton && (
          <button
            type="button"
            onClick={onClose}
            data-testid={testId ? `${testId}-close` : 'modal-close'}
            aria-label="Close dialog"
            className="absolute right-3 top-3 z-10 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
