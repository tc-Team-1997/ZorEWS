import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
import { api, type SlaConfigRow } from '@/lib/api';

interface Props {
  caseId: string;
  caseNumber: string;
  currentCategory: string | null;
  onClose: () => void;
  onSubmit: (case_category: string | null, reason: string | null) => void;
  isPending: boolean;
  error: unknown;
}

export function SetCategoryModal({
  caseNumber,
  currentCategory,
  onClose,
  onSubmit,
  isPending,
  error,
}: Props) {
  const [category, setCategory] = useState(currentCategory ?? '');
  const [reason, setReason] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  // Pull active categories from sla_config so the combobox suggests
  // canonical names (matches the create-modal pattern).
  const slaConfigs = useQuery({
    queryKey: ['sla-config', 'ACTIVE', 'for-categories'],
    queryFn: () => api.slaConfigList({ status: 'ACTIVE', page_size: 200 }),
  });
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of (slaConfigs.data?.items ?? []) as SlaConfigRow[]) {
      // Skip the default_fallback synthetic so it doesn't show up
      // as a manual choice — falling-through is what NULL does.
      if (r.case_category !== 'default_fallback') set.add(r.case_category);
    }
    return Array.from(set).sort();
  }, [slaConfigs.data?.items]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    const trimmed = category.trim();
    if (trimmed.length > 64) {
      setValidation('Category must be ≤ 64 characters');
      return;
    }
    if (trimmed === (currentCategory ?? '')) {
      setValidation('No change to save');
      return;
    }
    setValidation(null);
    onSubmit(trimmed || null, reason.trim() || null);
  };

  const errorMsg =
    validation ?? (error instanceof Error ? error.message : null);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Re-categorise case"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-6"
    >
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-semibold">
            Re-categorise <span className="font-mono text-xs">{caseNumber}</span>
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm">
          <div className="bg-slate-50 border border-slate-200 rounded p-3 text-2xs">
            <div className="text-muted">Current category</div>
            <div className="font-mono text-xs mt-0.5">
              {currentCategory ?? <em>(none — falls through to default_fallback)</em>}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted block mb-1">New category</label>
            <input
              type="text"
              list="cms-set-category-options"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Pick from sla_config or invent a new one"
              className="w-full border rounded-md px-3 py-2 text-sm font-mono"
              data-testid="set-category-input"
            />
            <datalist id="cms-set-category-options">
              {categoryOptions.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <div className="text-2xs text-muted mt-1">
              Leave blank to clear → resolver falls through to{' '}
              <span className="font-mono">default_fallback</span>.
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted block mb-1">Reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full border rounded-md px-3 py-2 text-sm"
              placeholder="Why this re-categorisation? (audit-logged)"
              data-testid="set-category-reason"
            />
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-2xs text-amber-800">
            Saving will move this case under the new category's SLA target
            on the next dashboard refresh. The change is audit-logged with
            actor + reason in the case history.
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="bg-rose-50 border border-rose-200 text-rose-800 rounded-md px-3 py-2 text-xs"
              data-testid="set-category-error"
            >
              {errorMsg}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t bg-slate-50 rounded-b-lg">
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending} data-testid="set-category-save">
            {isPending ? 'Saving…' : 'Save category'}
          </Button>
        </div>
      </div>
    </div>
  );
}
