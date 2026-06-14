import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  MODULE_PATH_TREE,
  type CreateOverrideInput,
  type OverrideType,
  type PermissionType,
  type UserAccessOverride,
} from '@/lib/api';
import { Badge, Button, DialogFooter, EnterpriseDialog } from '@/components/ui';
import { DEMO_USERS } from '@/mocks/data';

interface Props {
  mode: 'create' | 'edit';
  override?: UserAccessOverride; // populated when mode === 'edit'
  onClose: () => void;
  onSubmit: (input: CreateOverrideInput) => void;
  isPending: boolean;
  error: unknown;
}

const PERMISSION_OPTIONS: { value: PermissionType; label: string; help: string }[] = [
  { value: 'VIEW',    label: 'View',    help: 'Read-only on the module' },
  { value: 'EDIT',    label: 'Edit',    help: 'Create / update entities' },
  { value: 'APPROVE', label: 'Approve', help: 'Maker-checker approver authority' },
  { value: 'FULL',    label: 'Full',    help: 'View + Edit + Approve + delete' },
];

export function OverrideFormModal({
  mode,
  override,
  onClose,
  onSubmit,
  isPending,
  error,
}: Props) {
  const [userId, setUserId] = useState(override?.user_id ?? '');
  const [paths, setPaths] = useState<Set<string>>(
    new Set(override ? [override.module_path] : []),
  );
  const [overrideType, setOverrideType] = useState<OverrideType>(override?.override_type ?? 'GRANT');
  const [permission, setPermission] = useState<PermissionType>(override?.permission_type ?? 'VIEW');
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [from, setFrom] = useState(
    override ? override.effective_from.slice(0, 10) : today,
  );
  const [till, setTill] = useState(override?.effective_till?.slice(0, 10) ?? '');
  const [reason, setReason] = useState(override?.reason ?? '');
  const [requiresApproval, setRequiresApproval] = useState(override?.requires_approval ?? true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [validationError, setValidationError] = useState<string | null>(null);

  const togglePath = (p: string) => {
    setPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const toggleGroup = (group: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const validate = (): string | null => {
    if (!userId) return 'Select a user';
    if (paths.size === 0) return 'Pick at least one module';
    if (!from) return 'Effective from is required';
    if (till && Date.parse(till) <= Date.parse(from)) {
      return 'Effective till must be after Effective from';
    }
    if (till && Date.parse(till) <= Date.now()) {
      return 'Effective till cannot be in the past';
    }
    if (reason.trim().length < 10) return 'Reason must be at least 10 characters';
    return null;
  };

  const submit = () => {
    const err = validate();
    if (err) {
      setValidationError(err);
      return;
    }
    setValidationError(null);
    onSubmit({
      user_id: userId,
      module_paths: Array.from(paths),
      override_type: overrideType,
      permission_type: permission,
      effective_from: new Date(from).toISOString(),
      effective_till: till ? new Date(till).toISOString() : null,
      reason: reason.trim(),
      requires_approval: requiresApproval,
    });
  };

  const errorMsg =
    validationError ??
    (error instanceof Error ? error.message : null);

  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title={mode === 'create' ? 'Add access override' : 'Edit access override'}
      size="md"
      testId="uao-form-dialog"
      footer={
        <DialogFooter
          secondary={
            <Button variant="secondary" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
          }
          primary={
            <Button onClick={submit} disabled={isPending} data-testid="uao-submit">
              {isPending ? 'Saving…' : mode === 'create' ? 'Create override' : 'Save changes'}
            </Button>
          }
        />
      }
    >
      <div className="space-y-5">
        {/* user picker */}
        <div>
          <label className="text-xs font-medium text-muted block mb-1">User *</label>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={mode === 'edit'}
            className="w-full border rounded-md px-3 py-2 text-sm"
            data-testid="uao-user-picker"
          >
            <option value="">— Select user —</option>
            {DEMO_USERS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name} ({u.username}) · {u.roles[0]}
              </option>
            ))}
          </select>
        </div>

        {/* override type + permission */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-muted block mb-1">Override type *</label>
            <div className="flex gap-2">
              {(['GRANT', 'REVOKE'] as OverrideType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setOverrideType(t)}
                  className={`flex-1 border rounded-md px-3 py-2 text-sm ${
                    overrideType === t
                      ? t === 'GRANT'
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                        : 'border-rose-500 bg-rose-50 text-rose-800'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted block mb-1">Permission *</label>
            <div className="flex gap-1">
              {PERMISSION_OPTIONS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPermission(p.value)}
                  title={p.help}
                  className={`flex-1 border rounded-md px-2 py-2 text-xs ${
                    permission === p.value
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* multi-select module tree */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-muted">Modules / sub-menus *</label>
            <span className="text-2xs text-muted">{paths.size} selected</span>
          </div>
          <div
            className="border rounded-md p-3 max-h-64 overflow-y-auto bg-slate-50"
            data-testid="uao-module-tree"
          >
            {MODULE_PATH_TREE.map((g) => {
              const isCollapsed = collapsed.has(g.group);
              const groupSelectedCount = g.paths.filter((p) => paths.has(p.value)).length;
              return (
                <div key={g.group} className="mb-2 last:mb-0">
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.group)}
                    className="flex items-center gap-1 w-full text-left hover:bg-white rounded px-1 py-0.5"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="w-3 h-3" />
                    ) : (
                      <ChevronDown className="w-3 h-3" />
                    )}
                    <span className="text-xs font-semibold">{g.group}</span>
                    {groupSelectedCount > 0 && (
                      <Badge tone="blue" className="ml-1 text-2xs">
                        {groupSelectedCount}
                      </Badge>
                    )}
                  </button>
                  {!isCollapsed && (
                    <div className="ml-4 mt-1 space-y-1">
                      {g.paths.map((p) => (
                        <label
                          key={p.value}
                          className="flex items-center gap-2 text-xs hover:bg-white rounded px-1 py-0.5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={paths.has(p.value)}
                            onChange={() => togglePath(p.value)}
                            data-testid={`uao-path-${p.value}`}
                          />
                          <span>{p.label}</span>
                          <span className="font-mono text-2xs text-muted">{p.value}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* effective dates */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-muted block mb-1">Effective from *</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              min={today}
              className="w-full border rounded-md px-3 py-2 text-sm"
              data-testid="uao-from"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted block mb-1">
              Effective till{' '}
              <span className="text-2xs text-muted">(blank = permanent)</span>
            </label>
            <input
              type="date"
              value={till}
              min={from || today}
              onChange={(e) => setTill(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm"
              data-testid="uao-till"
            />
          </div>
        </div>

        {/* reason */}
        <div>
          <label className="text-xs font-medium text-muted block mb-1">
            Reason / justification *
            <span className="ml-1 text-2xs text-muted">(≥ 10 chars; audit-logged)</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full border rounded-md px-3 py-2 text-sm"
            placeholder="e.g. Quarterly audit support — needs read access to admin audit-log until 2026-08-01"
            data-testid="uao-reason"
          />
        </div>

        {/* requires-approval toggle */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={requiresApproval}
            onChange={(e) => setRequiresApproval(e.target.checked)}
            data-testid="uao-requires-approval"
          />
          <span>
            Requires approval (maker-checker)
            <span className="ml-1 text-2xs text-muted">
              — when on, override starts as PENDING_APPROVAL and a different admin must approve
            </span>
          </span>
        </label>

        {errorMsg && (
          <div
            className="bg-rose-50 border border-rose-200 text-rose-800 rounded-md px-3 py-2 text-xs"
            role="alert"
            data-testid="uao-error"
          >
            {errorMsg}
          </div>
        )}
      </div>
    </EnterpriseDialog>
  );
}
