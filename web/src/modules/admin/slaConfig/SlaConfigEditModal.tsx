import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
import type { SlaConfigRow } from '@/lib/api';

interface Props {
  row: SlaConfigRow;
  onClose: () => void;
  onSubmit: (patch: { sla_target_days?: number; notes?: string | null }) => void;
  isPending: boolean;
  error: unknown;
}

export function SlaConfigEditModal({ row, onClose, onSubmit, isPending, error }: Props) {
  const [days, setDays] = useState(String(row.sla_target_days));
  const [notes, setNotes] = useState(row.notes ?? '');
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    const d = Number(days);
    if (!Number.isFinite(d) || d <= 0 || d > 365) {
      setValidation('SLA target must be a number in (0, 365] days');
      return;
    }
    setValidation(null);
    const patch: { sla_target_days?: number; notes?: string | null } = {};
    if (d !== row.sla_target_days) patch.sla_target_days = d;
    if (notes !== (row.notes ?? '')) patch.notes = notes.trim() || null;
    if (!patch.sla_target_days && patch.notes === undefined) {
      setValidation('No changes to save');
      return;
    }
    onSubmit(patch);
  };

  const errorMsg =
    validation ?? (error instanceof Error ? error.message : null);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit SLA target"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-6"
    >
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-semibold">Edit SLA target</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm">
          <div className="bg-slate-50 border border-slate-200 rounded p-3 text-xs">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <div className="text-2xs uppercase text-muted">Category</div>
                <div className="font-mono text-xs">{row.case_category}</div>
              </div>
              <div>
                <div className="text-2xs uppercase text-muted">Priority</div>
                <div className="font-mono text-xs">{row.priority}</div>
              </div>
              <div>
                <div className="text-2xs uppercase text-muted">Business unit</div>
                <div className="font-mono text-xs">{row.business_unit ?? '(all)'}</div>
              </div>
            </div>
            <div className="text-2xs text-muted mt-2">
              Identity is locked. To change category / priority / BU, archive this row and create a new one.
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted block mb-1">SLA target (days) *</label>
            <input
              type="number"
              step="0.25"
              min="0.25"
              max="365"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm"
              data-testid="sla-target-input"
            />
            <div className="text-2xs text-muted mt-1">
              Half-day precision allowed (e.g. 0.5 = 12h). Range (0, 365].
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted block mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full border rounded-md px-3 py-2 text-sm"
              placeholder="Why this target? (audit-logged)"
              data-testid="sla-notes-input"
            />
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-2xs text-amber-800">
            Saving creates a new ACTIVE row and supersedes the current
            one. The old row stays in audit history with{' '}
            <span className="font-mono">superseded_by</span> pointing here.
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="bg-rose-50 border border-rose-200 text-rose-800 rounded-md px-3 py-2 text-xs"
              data-testid="sla-edit-error"
            >
              {errorMsg}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t bg-slate-50 rounded-b-lg">
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending} data-testid="sla-save">
            {isPending ? 'Saving…' : 'Save (supersede)'}
          </Button>
        </div>
      </div>
    </div>
  );
}
