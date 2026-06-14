import { useMemo, useState } from 'react';
import { Button, DialogFooter, EnterpriseDialog } from '@/components/ui';
import type { SlaConfigCreateInput, SlaConfigPriority, SlaConfigRow } from '@/lib/api';

const PRIORITIES: SlaConfigPriority[] = ['P1', 'P2', 'P3', 'P4'];

interface Props {
  /** Existing rows — used to populate the category combobox + warn on
   *  duplicate (category, priority, business_unit) at the client edge. */
  existing: ReadonlyArray<SlaConfigRow>;
  onClose: () => void;
  onSubmit: (input: SlaConfigCreateInput) => void;
  isPending: boolean;
  error: unknown;
}

export function CreateSlaConfigModal({ existing, onClose, onSubmit, isPending, error }: Props) {
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState<SlaConfigPriority>('P2');
  const [businessUnit, setBusinessUnit] = useState('');
  const [days, setDays] = useState('');
  const [notes, setNotes] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  // Build the autocomplete lists from existing rows so admins reuse
  // canonical category + BU names. Sorted; deduplicated; case_category
  // is free-form so the input still allows brand-new values.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of existing) set.add(r.case_category);
    return Array.from(set).sort();
  }, [existing]);

  const businessUnitOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of existing) if (r.business_unit) set.add(r.business_unit);
    return Array.from(set).sort();
  }, [existing]);

  const clientDup = useMemo(() => {
    const cat = category.trim();
    if (!cat || !priority) return null;
    const buNorm = businessUnit.trim() || null;
    // Only ACTIVE rows participate in the partial unique index. The
    // server enforces this too — this is a UX-only pre-check that
    // prevents an unnecessary 409 round-trip.
    return existing.find(
      (r) =>
        r.status === 'ACTIVE' &&
        r.case_category === cat &&
        r.priority === priority &&
        (r.business_unit ?? null) === buNorm,
    );
  }, [existing, category, priority, businessUnit]);

  const submit = () => {
    const cat = category.trim();
    if (!cat) {
      setValidation('Category is required');
      return;
    }
    const d = Number(days);
    if (!Number.isFinite(d) || d <= 0 || d > 365) {
      setValidation('SLA target must be a number in (0, 365] days');
      return;
    }
    if (clientDup) {
      setValidation(
        `An ACTIVE row already exists for ${cat}/${priority}/${businessUnit.trim() || '*'}. Edit that row instead, or pick a different combination.`,
      );
      return;
    }
    setValidation(null);
    onSubmit({
      case_category: cat,
      priority,
      business_unit: businessUnit.trim() || null,
      sla_target_days: d,
      notes: notes.trim() || null,
    });
  };

  const errorMsg = validation ?? (error instanceof Error ? error.message : null);

  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title="Add SLA target"
      size="md"
      closeOnBackdrop={false}
      testId="sla-create-dialog"
      footer={
        <DialogFooter
          onCancel={onClose}
          primary={
            <Button onClick={submit} disabled={isPending || !!clientDup} data-testid="sla-create-submit">
              {isPending ? 'Creating…' : 'Create'}
            </Button>
          }
        />
      }
    >
      <div className="space-y-4 text-sm">
        <div>
          <label className="text-xs font-medium text-muted block mb-1">Category *</label>
          <input
            type="text"
            list="sla-categories"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. credit_risk, aml_kyc, regulatory_returns"
            className="w-full border rounded-md px-3 py-2 text-sm font-mono"
            data-testid="sla-create-category"
          />
          <datalist id="sla-categories">
            {categoryOptions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div className="text-2xs text-muted mt-1">
            Free-form. Pick an existing one to add a missing priority, or invent a new one.
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-muted block mb-1">Priority *</label>
          <div className="flex gap-2">
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                className={`flex-1 border rounded-md px-3 py-2 text-sm font-mono ${
                  priority === p
                    ? 'border-blue-500 bg-blue-50 text-blue-800'
                    : 'border-slate-200 bg-white'
                }`}
                data-testid={`sla-create-priority-${p}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-muted block mb-1">
            Business unit
            <span className="ml-1 text-2xs text-muted">(blank = applies to all BUs)</span>
          </label>
          <input
            type="text"
            list="sla-business-units"
            value={businessUnit}
            onChange={(e) => setBusinessUnit(e.target.value)}
            placeholder="e.g. CORPORATE, RETAIL"
            className="w-full border rounded-md px-3 py-2 text-sm font-mono"
            data-testid="sla-create-bu"
          />
          <datalist id="sla-business-units">
            {businessUnitOptions.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
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
            placeholder="e.g. 0.5 for a 12-hour SLA"
            className="w-full border rounded-md px-3 py-2 text-sm"
            data-testid="sla-create-days"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted block mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="Why this target? (audit-logged)"
            data-testid="sla-create-notes"
          />
        </div>

        {/* Live duplicate warning — pre-empts the server's 409. */}
        {clientDup && (
          <div
            className="bg-amber-50 border border-amber-200 rounded p-2 text-2xs text-amber-800"
            data-testid="sla-create-dup-warn"
          >
            An ACTIVE row already exists for{' '}
            <span className="font-mono">
              {clientDup.case_category}/{clientDup.priority}/
              {clientDup.business_unit ?? '*'}
            </span>{' '}
            (target {clientDup.sla_target_days}d). Edit that row instead.
          </div>
        )}

        {errorMsg && (
          <div
            role="alert"
            className="bg-rose-50 border border-rose-200 text-rose-800 rounded-md px-3 py-2 text-xs"
            data-testid="sla-create-error"
          >
            {errorMsg}
          </div>
        )}
      </div>
    </EnterpriseDialog>
  );
}
