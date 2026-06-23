import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Trash2, XCircle } from 'lucide-react';
import { api, type UserAccessOverride } from '@/lib/api';
import { Badge, Button, EnterpriseDialog, Panel } from '@/components/ui';
import { useAuth } from '@/store/auth';

interface Props {
  override: UserAccessOverride;
  onClose: () => void;
  onChange: () => void;
}

export function OverrideDetailPanel({ override, onClose, onChange }: Props) {
  const me = useAuth((s) => s.user?.username);
  const [reasonInput, setReasonInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const audit = useQuery({
    queryKey: ['uao', 'audit', override.override_id],
    queryFn: () => api.uaoAuditLog({ entity_id: override.override_id }),
  });

  const approve = useMutation({
    mutationFn: () => api.uaoApprove(override.override_id, reasonInput || undefined),
    onSuccess: onChange,
    onError: (e) => setErrorMsg(e instanceof Error ? e.message : 'Approve failed'),
  });
  const reject = useMutation({
    mutationFn: () => api.uaoReject(override.override_id, reasonInput),
    onSuccess: onChange,
    onError: (e) => setErrorMsg(e instanceof Error ? e.message : 'Reject failed'),
  });
  const revoke = useMutation({
    mutationFn: () => api.uaoRevoke(override.override_id, reasonInput),
    onSuccess: onChange,
    onError: (e) => setErrorMsg(e instanceof Error ? e.message : 'Revoke failed'),
  });

  const isMaker = me === override.created_by;
  const canApprove = override.status === 'PENDING_APPROVAL' && !isMaker;
  const canReject = override.status === 'PENDING_APPROVAL' && !isMaker;
  const canRevoke = override.status === 'ACTIVE';

  const guardReason = (label: string): boolean => {
    if (reasonInput.trim().length < 10) {
      setErrorMsg(`${label} requires a reason of at least 10 characters`);
      return false;
    }
    setErrorMsg(null);
    return true;
  };

  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title={`Override · ${override.override_id.slice(0, 8)}`}
      size="lg"
      testId="uao-detail-dialog"
    >
      <div className="space-y-4 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="User">{override.user_id}</Field>
            <Field label="Status">
              <Badge tone={statusTone(override.status)} className="uppercase">
                {override.status.replace('_', ' ').toLowerCase()}
              </Badge>
            </Field>
            <Field label="Module">
              <span className="font-mono">{override.module_path}</span>
            </Field>
            <Field label="Override">
              <Badge tone={override.override_type === 'GRANT' ? 'success' : 'danger'}>
                {override.override_type}
              </Badge>
              <span className="ml-2">{override.permission_type}</span>
            </Field>
            <Field label="Effective from">{new Date(override.effective_from).toLocaleString()}</Field>
            <Field label="Effective till">
              {override.effective_till
                ? new Date(override.effective_till).toLocaleString()
                : 'permanent'}
            </Field>
            <Field label="Maker">
              <span className="font-mono">{override.created_by}</span>
              <span className="ml-1 text-2xs text-muted">at {new Date(override.created_at).toLocaleString()}</span>
            </Field>
            <Field label="Checker">
              {override.approved_by ? (
                <>
                  <span className="font-mono">{override.approved_by}</span>
                  <span className="ml-1 text-2xs text-muted">approved</span>
                </>
              ) : override.rejected_by ? (
                <>
                  <span className="font-mono">{override.rejected_by}</span>
                  <span className="ml-1 text-2xs text-muted">rejected</span>
                </>
              ) : (
                <span className="text-muted">—</span>
              )}
            </Field>
          </div>

          <div>
            <div className="text-xs text-muted mb-1">Reason</div>
            <div className="bg-slate-50 border border-slate-200 rounded p-3 text-xs">
              {override.reason}
            </div>
          </div>

          {override.rejection_reason && (
            <div className="bg-rose-50 border border-rose-200 rounded p-3">
              <div className="text-xs font-medium text-rose-800 mb-1">Rejection reason</div>
              <div className="text-xs text-rose-700">{override.rejection_reason}</div>
            </div>
          )}
          {override.revocation_reason && (
            <div className="bg-slate-100 border border-slate-300 rounded p-3">
              <div className="text-xs font-medium text-slate-700 mb-1">Revocation reason</div>
              <div className="text-xs">{override.revocation_reason}</div>
            </div>
          )}

          {/* maker-checker actions */}
          {(canApprove || canRevoke) && (
            <Panel title="Actions">
              {isMaker && override.status === 'PENDING_APPROVAL' && (
                <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-800 mb-3">
                  You are the <strong>maker</strong> on this request — a different admin must approve or reject. (BAC §3.1.7 maker-checker.)
                </div>
              )}
              <textarea
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                placeholder={canApprove ? 'Approval note (optional) or rejection / revocation reason (≥ 10 chars)' : 'Revocation reason (≥ 10 chars)'}
                rows={2}
                className="w-full border rounded-md px-3 py-2 text-sm"
                data-testid="uao-action-reason"
              />
              <div className="flex gap-2 mt-2 flex-wrap">
                {canApprove && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setErrorMsg(null);
                      approve.mutate();
                    }}
                    disabled={approve.isPending}
                    data-testid="uao-approve"
                  >
                    <CheckCircle2 className="w-4 h-4 mr-1" />
                    Approve
                  </Button>
                )}
                {canReject && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (guardReason('Reject')) reject.mutate();
                    }}
                    disabled={reject.isPending}
                    data-testid="uao-reject"
                  >
                    <XCircle className="w-4 h-4 mr-1" />
                    Reject
                  </Button>
                )}
                {canRevoke && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (guardReason('Revoke')) revoke.mutate();
                    }}
                    disabled={revoke.isPending}
                    data-testid="uao-revoke"
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Revoke
                  </Button>
                )}
              </div>
              {errorMsg && (
                <div
                  className="bg-rose-50 border border-rose-200 text-rose-800 rounded-md px-3 py-2 text-xs mt-2"
                  role="alert"
                >
                  {errorMsg}
                </div>
              )}
            </Panel>
          )}

          <Panel title="Audit trail">
            {audit.isLoading ? (
              <div className="text-xs text-muted">Loading…</div>
            ) : (audit.data?.items.length ?? 0) === 0 ? (
              <div className="text-xs text-muted">No audit entries yet</div>
            ) : (
              <ul className="space-y-2">
                {audit.data?.items.map((a) => (
                  <li key={a.audit_id} className="border-l-2 border-slate-200 pl-3 py-1">
                    <div className="text-xs">
                      <strong>{a.action}</strong> by{' '}
                      <span className="font-mono">{a.actor_id}</span>{' '}
                      <span className="text-muted">({a.actor_role})</span>
                    </div>
                    <div className="text-2xs text-muted">
                      {new Date(a.created_at).toLocaleString()}
                    </div>
                    {a.reason && <div className="text-2xs italic mt-1">{a.reason}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
      </div>
    </EnterpriseDialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-muted">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function statusTone(s: UserAccessOverride['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (s) {
    case 'ACTIVE': return 'success';
    case 'PENDING_APPROVAL': return 'warning';
    case 'REJECTED': return 'danger';
    case 'REVOKED':
    case 'EXPIRED':
      return 'neutral';
  }
}
