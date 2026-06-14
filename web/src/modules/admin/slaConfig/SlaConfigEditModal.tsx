import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Button, DialogFooter, EnterpriseDialog } from '@/components/ui';
import { api, type SlaConfigRow } from '@/lib/api';

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
  const [debouncedDays, setDebouncedDays] = useState(days);

  // Debounce the target value 400ms before asking the server for a
  // preview. Avoids hammering the resolver on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedDays(days), 400);
    return () => window.clearTimeout(id);
  }, [days]);

  const previewableTarget = useMemo(() => {
    const n = Number(debouncedDays);
    if (!Number.isFinite(n) || n <= 0 || n > 365) return null;
    if (n === row.sla_target_days) return null; // no-op
    return n;
  }, [debouncedDays, row.sla_target_days]);

  const previewQ = useQuery({
    queryKey: [
      'sla-config-preview',
      row.tenant_id,
      row.case_category,
      row.priority,
      row.business_unit,
      previewableTarget,
    ],
    queryFn: () =>
      api.slaBreachMatrixPreview([
        {
          case_category: row.case_category,
          priority: row.priority,
          business_unit: row.business_unit,
          sla_target_days: previewableTarget!,
        },
      ]),
    enabled: previewableTarget !== null,
    // Preview is decision support — don't burn auto-refresh on it
    refetchInterval: false,
    staleTime: 30_000,
  });

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
    <EnterpriseDialog
      open
      onClose={onClose}
      title="Edit SLA target"
      size="md"
      closeOnBackdrop={false}
      testId="sla-edit-dialog"
      footer={
        <DialogFooter
          onCancel={onClose}
          primary={
            <Button onClick={submit} disabled={isPending} data-testid="sla-save">
              {isPending ? 'Saving…' : 'Save (supersede)'}
            </Button>
          }
        />
      }
    >
      <div className="space-y-4 text-sm">
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
            {previewableTarget !== null && (
              <PreviewStrip
                isLoading={previewQ.isLoading}
                isError={previewQ.isError}
                deltaTotal={previewQ.data?.delta.breached_total ?? 0}
              />
            )}
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
    </EnterpriseDialog>
  );
}

function PreviewStrip({
  isLoading,
  isError,
  deltaTotal,
}: {
  isLoading: boolean;
  isError: boolean;
  deltaTotal: number;
}) {
  if (isLoading) {
    return (
      <div
        className="mt-2 text-2xs text-muted bg-slate-50 border border-slate-200 rounded px-2 py-1"
        data-testid="sla-preview-loading"
      >
        Computing breach impact…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="mt-2 text-2xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
        Could not compute breach impact (saving still works).
      </div>
    );
  }
  if (deltaTotal === 0) {
    return (
      <div
        className="mt-2 text-2xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1"
        data-testid="sla-preview-zero"
      >
        No open cases will change breach status.
      </div>
    );
  }
  if (deltaTotal > 0) {
    return (
      <div
        className="mt-2 text-2xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 flex items-center gap-1"
        data-testid="sla-preview-positive"
      >
        <TrendingUp className="w-3 h-3" />
        <strong>+{deltaTotal}</strong> case{deltaTotal === 1 ? '' : 's'} will move into breached after saving.
      </div>
    );
  }
  return (
    <div
      className="mt-2 text-2xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 flex items-center gap-1"
      data-testid="sla-preview-negative"
    >
      <TrendingDown className="w-3 h-3" />
      <strong>{deltaTotal}</strong> case{Math.abs(deltaTotal) === 1 ? '' : 's'} will recover from breached after saving.
    </div>
  );
}
