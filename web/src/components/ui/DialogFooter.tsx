// web/src/components/ui/DialogFooter.tsx
//
// Standard dialog action row, dropped into EnterpriseDialog's `footer` slot.
// Order: [Cancel (ghost)] [secondary] [primary]. Cancel renders only when an
// `onCancel` handler is supplied. The `secondary`/`primary` slots accept any
// node (usually a Button) so callers control variant + label + click.

import type { ReactNode } from 'react';
import { Button } from './Button';

export function DialogFooter({
  onCancel,
  cancelLabel = 'Cancel',
  secondary,
  primary,
}: {
  onCancel?: () => void;
  cancelLabel?: string;
  secondary?: ReactNode;
  primary?: ReactNode;
}) {
  return (
    <>
      {onCancel && (
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
      )}
      {secondary}
      {primary}
    </>
  );
}
