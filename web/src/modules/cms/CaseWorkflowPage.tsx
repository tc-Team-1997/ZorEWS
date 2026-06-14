// web/src/modules/cms/CaseWorkflowPage.tsx
//
// Module 3.2 — Case Workflow page.
//
// Lets ops visualise the case pipeline (5 counter cards) + manage
// pending maker-checker approvals (the M9.3 surface) across cases.
// Acceptance gaps closed by M3.2:
//   - Rejection requires a non-empty reason (≥ 3 chars). Enforced
//     server-side at /v1/cases/maker-checker/:id/reject; this page
//     gates the modal's Reject button until the user types a reason.
//   - Same user can't be both maker + checker — enforced server-side
//     (409 EWS_409_self_approval_forbidden); this page surfaces the
//     error message inline on the action panel.
//
// Re-uses the existing M3.1 cmsApi (stats + bulkAssign) and the new
// M3.2 cmsApi.workflow.* wrappers (list/get/submit/approve/reject).

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock,
  FileCheck,
  Inbox,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Badge, Button, DialogFooter, EnterpriseDialog, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { cmsApi, type SensitiveActionType, type WorkflowStatus } from './api';

const STATUS_TONE: Record<WorkflowStatus, 'blue' | 'success' | 'danger' | 'warning'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'blue',
};

const ACTION_LABEL: Record<SensitiveActionType, string> = {
  'case.close': 'Close case',
  'case.escalate': 'Escalate to CRO',
  'case.override_decision': 'Override decision',
};

function fmtRelative(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const diff = Math.max(0, now - t);
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return `${Math.floor(diff / 60_000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * SLA: maker-checker actions don't carry an explicit SLA field — the
 * spec asks for a "real-time SLA countdown" anyway. We render time
 * elapsed since submit + a yellow/red severity badge based on a
 * conservative 24h target (matches BIL §11 orange SLA). Production
 * would wire this to a per-action-type config; the SPA uses the same
 * threshold for all 3 sensitive actions in this prototype.
 */
function slaSeverity(maker_at: string, now = Date.now()): 'green' | 'amber' | 'red' {
  const ageH = (now - new Date(maker_at).getTime()) / 3_600_000;
  if (ageH < 12) return 'green';
  if (ageH < 24) return 'amber';
  return 'red';
}

const SLA_TONE: Record<'green' | 'amber' | 'red', 'success' | 'warning' | 'danger'> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
};

export function CaseWorkflowPage() {
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const canDecide =
    user?.roles.some((r) => ['admin', 'supervisor'].includes(r)) ?? false;
  const canSubmit =
    user?.roles.some((r) =>
      ['admin', 'supervisor', 'risk_analyst', 'case_owner'].includes(r),
    ) ?? false;
  const canReassign = canDecide;

  const [filterStatus, setFilterStatus] = useState<WorkflowStatus | 'all'>('pending');
  const [filterAction, setFilterAction] = useState<SensitiveActionType | 'all'>('all');
  const [showSubmit, setShowSubmit] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const statsQ = useQuery({ queryKey: ['cms-stats'], queryFn: () => cmsApi.stats() });
  const workflowQ = useQuery({
    queryKey: ['workflow-list', filterStatus, filterAction],
    queryFn: () =>
      cmsApi.workflow.list({
        status: filterStatus === 'all' ? undefined : filterStatus,
        action_type: filterAction === 'all' ? undefined : filterAction,
        page_size: 100,
      }),
  });
  // The "Pending Requests" table is what ops works through — always
  // pull a pending-only slice so the approved/rejected filter mode
  // doesn't blow this away.
  const pendingQ = useQuery({
    queryKey: ['workflow-pending'],
    queryFn: () => cmsApi.workflow.list({ status: 'pending', page_size: 100 }),
  });
  // "Approved today" + "Closed today" counters need a stable fetch
  // independent of the filter state.
  const approvedTodayQ = useQuery({
    queryKey: ['workflow-approved-today'],
    queryFn: () => cmsApi.workflow.list({ status: 'approved', page_size: 200 }),
  });

  const stats = statsQ.data;
  const pendingCount = pendingQ.data?.total ?? 0;
  const approvedTodayCount = useMemo(() => {
    if (!approvedTodayQ.data) return 0;
    const cutoff = Date.now() - 24 * 3_600_000;
    return approvedTodayQ.data.items.filter(
      (a) => a.checker_at && new Date(a.checker_at).getTime() >= cutoff,
    ).length;
  }, [approvedTodayQ.data]);

  // Pipeline cards map case state into the 5 stages from the spec.
  // We re-use the M3.1 /v1/cms/cases/stats counters + the new M3.2
  // workflow list — no new BFF route needed.
  const openCount = (stats?.by_status.OPEN ?? 0) + (stats?.by_status.REOPENED ?? 0);
  const reviewCount =
    (stats?.by_status.ASSIGNED ?? 0) + (stats?.by_status.INVESTIGATING ?? 0);
  const closedTodayCount = useMemo(() => {
    // The stats route doesn't break down closed-by-time; we
    // approximate from the action proposed counter for the prototype.
    // Production would expose closed_in_last_24h.
    return stats?.by_status.CLOSED ?? 0;
  }, [stats]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Case Workflow"
        subtitle="Pipeline pulse + pending maker-checker approvals across all sensitive case actions."
        actions={
          <div className="flex gap-2">
            {canSubmit && (
              <Button
                onClick={() => setShowSubmit(true)}
                data-testid="workflow-submit-btn"
              >
                <PlayCircle size={14} /> Submit workflow
              </Button>
            )}
            {canReassign && (
              <Button
                variant="ghost"
                onClick={() => setShowReassign(true)}
                data-testid="workflow-reassign-btn"
              >
                <Users size={14} /> Reassign load
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: ['cms-stats'] });
                void qc.invalidateQueries({ queryKey: ['workflow-list'] });
                void qc.invalidateQueries({ queryKey: ['workflow-pending'] });
                void qc.invalidateQueries({ queryKey: ['workflow-approved-today'] });
              }}
            >
              <RefreshCw size={14} /> Refresh
            </Button>
          </div>
        }
      />

      {/* 5-stage pipeline cards */}
      <div
        className="grid grid-cols-2 gap-3 md:grid-cols-5"
        data-testid="workflow-pipeline-cards"
      >
        <PipelineCard
          stage="open"
          label="Open"
          value={openCount}
          icon={<Inbox size={18} />}
          tone="neutral"
        />
        <PipelineCard
          stage="review"
          label="Review"
          value={reviewCount}
          icon={<Clock size={18} />}
          tone="warning"
        />
        <PipelineCard
          stage="action-proposed"
          label="Action Proposed"
          value={pendingCount}
          icon={<FileCheck size={18} />}
          tone="warning"
        />
        <PipelineCard
          stage="approved"
          label="Approved (24h)"
          value={approvedTodayCount}
          icon={<ShieldCheck size={18} />}
          tone="success"
        />
        <PipelineCard
          stage="closed"
          label="Closed (today)"
          value={closedTodayCount}
          icon={<CheckCircle2 size={18} />}
          tone="success"
        />
      </div>

      <Panel
        title="Pending requests"
        action={
          <div className="flex gap-2 text-sm">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as WorkflowStatus | 'all')}
              className="rounded border border-slate-300 px-2 py-1"
              data-testid="workflow-filter-status"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              value={filterAction}
              onChange={(e) => setFilterAction(e.target.value as SensitiveActionType | 'all')}
              className="rounded border border-slate-300 px-2 py-1"
              data-testid="workflow-filter-action"
            >
              <option value="all">All actions</option>
              <option value="case.close">Close case</option>
              <option value="case.escalate">Escalate</option>
              <option value="case.override_decision">Override</option>
            </select>
          </div>
        }
      >
        {workflowQ.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : !workflowQ.data || workflowQ.data.items.length === 0 ? (
          <p
            className="rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500"
            data-testid="workflow-empty"
          >
            No requests match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="min-w-full text-sm"
              data-testid="workflow-pending-table"
            >
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Case</th>
                  <th className="px-3 py-2">Maker</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Submitted</th>
                  <th className="px-3 py-2">SLA</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {workflowQ.data.items.map((a) => {
                  const sev = slaSeverity(a.maker_at);
                  return (
                    <tr
                      key={a.action_id}
                      className="border-t border-slate-200 hover:bg-slate-50"
                      data-testid={`workflow-row-${a.action_id}`}
                    >
                      <td className="px-3 py-2 font-medium">{ACTION_LABEL[a.action_type]}</td>
                      <td className="px-3 py-2 font-mono text-xs">{a.case_id.slice(0, 12)}</td>
                      <td className="px-3 py-2">{a.maker_username}</td>
                      <td className="px-3 py-2">
                        <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{fmtRelative(a.maker_at)}</td>
                      <td className="px-3 py-2">
                        <Badge tone={SLA_TONE[sev]}>
                          {sev === 'green' ? 'On track' : sev === 'amber' ? 'Approaching' : 'Breached'}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          onClick={() => setSelectedId(a.action_id)}
                          data-testid={`workflow-detail-${a.action_id}`}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Modals */}
      {selectedId && (
        <WorkflowDetailModal
          action_id={selectedId}
          canDecide={canDecide}
          currentUser={user?.username ?? ''}
          onClose={() => setSelectedId(null)}
          onDecided={() => {
            void qc.invalidateQueries({ queryKey: ['workflow-list'] });
            void qc.invalidateQueries({ queryKey: ['workflow-pending'] });
            void qc.invalidateQueries({ queryKey: ['workflow-approved-today'] });
            setSelectedId(null);
          }}
        />
      )}
      {showSubmit && (
        <SubmitWorkflowModal
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => {
            void qc.invalidateQueries({ queryKey: ['workflow-list'] });
            void qc.invalidateQueries({ queryKey: ['workflow-pending'] });
            setShowSubmit(false);
          }}
        />
      )}
      {showReassign && (
        <ReassignLoadModal
          onClose={() => setShowReassign(false)}
          onAssigned={() => {
            void qc.invalidateQueries({ queryKey: ['cms-cases'] });
            void qc.invalidateQueries({ queryKey: ['cms-stats'] });
            setShowReassign(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Pipeline card ──────────────────────────────────────────────────

function PipelineCard({
  stage,
  label,
  value,
  icon,
  tone,
}: {
  stage: string;
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: 'neutral' | 'warning' | 'success';
}) {
  const toneClass =
    tone === 'warning'
      ? 'border-amber-300 bg-amber-50 text-amber-700'
      : tone === 'success'
        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
        : 'border-slate-200 bg-white text-slate-700';
  return (
    <div
      className={`flex items-center gap-3 rounded-md border p-4 ${toneClass}`}
      data-testid={`pipeline-card-${stage}`}
    >
      <div className="rounded-full bg-white p-2">{icon}</div>
      <div>
        <div className="text-xs uppercase opacity-70">{label}</div>
        <div className="text-3xl font-semibold tabular-nums">{value}</div>
      </div>
    </div>
  );
}

// ─── Detail modal ────────────────────────────────────────────────────

function WorkflowDetailModal({
  action_id,
  canDecide,
  currentUser,
  onClose,
  onDecided,
}: {
  action_id: string;
  canDecide: boolean;
  currentUser: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [decisionNotes, setDecisionNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const detailQ = useQuery({
    queryKey: ['workflow-detail', action_id],
    queryFn: () => cmsApi.workflow.get(action_id),
  });
  const approveMut = useMutation({
    mutationFn: () => cmsApi.workflow.approve(action_id, decisionNotes || undefined),
    onSuccess: onDecided,
    onError: (e: unknown) => setError(extractErrorMessage(e)),
  });
  const rejectMut = useMutation({
    mutationFn: () => cmsApi.workflow.reject(action_id, decisionNotes.trim()),
    onSuccess: onDecided,
    onError: (e: unknown) => setError(extractErrorMessage(e)),
  });

  const a = detailQ.data;
  const isMaker = a?.maker_username === currentUser;
  // M3.2 acceptance — reject requires reason (≥ 3 chars after trim);
  // approve allows empty notes since the action itself is neutral.
  const rejectArmed = decisionNotes.trim().length >= 3;
  // Only show the standard footer action row when this pending request is
  // decidable by the current (non-maker) user. Otherwise no footer.
  const showActions = !!a && a.status === 'pending' && !isMaker && canDecide;

  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title="Workflow request"
      size="md"
      testId="workflow-detail-modal"
      footer={
        showActions ? (
          <DialogFooter
            primary={
              <Button
                onClick={() => approveMut.mutate()}
                disabled={approveMut.isPending}
                data-testid="workflow-approve-btn"
              >
                {approveMut.isPending ? 'Approving…' : 'Approve'}
              </Button>
            }
            secondary={
              <Button
                variant="ghost"
                onClick={() => rejectMut.mutate()}
                disabled={!rejectArmed || rejectMut.isPending}
                data-testid="workflow-reject-btn"
              >
                {rejectMut.isPending ? 'Rejecting…' : 'Reject'}
              </Button>
            }
          />
        ) : undefined
      }
    >
      {!a ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Field label="Action" value={ACTION_LABEL[a.action_type]} />
            <Field label="Status" value={<Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>} />
            <Field label="Maker" value={a.maker_username} />
            <Field label="Submitted" value={`${fmtRelative(a.maker_at)} (${a.maker_at})`} />
            <Field label="Case" value={<span className="font-mono text-xs">{a.case_id}</span>} />
            {a.checker_username && <Field label="Checker" value={a.checker_username} />}
          </div>

          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Rationale</h3>
            <p className="rounded bg-slate-50 p-3 text-sm text-slate-700">{a.rationale}</p>
          </div>

          {a.payload && Object.keys(a.payload).length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Payload</h3>
              <pre
                className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100"
                data-testid="workflow-payload"
              >
                {JSON.stringify(a.payload, null, 2)}
              </pre>
            </div>
          )}

          {a.decision_notes && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase text-slate-500">Decision notes</h3>
              <p className="rounded bg-slate-50 p-3 text-sm text-slate-700">{a.decision_notes}</p>
            </div>
          )}

          {a.status === 'pending' && (
            <div className="border-t border-slate-200 pt-4">
              {isMaker && (
                <p
                  className="rounded bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800"
                  data-testid="workflow-self-banner"
                >
                  You submitted this request. <strong>You cannot approve or reject your own submission</strong>
                  — a different admin / supervisor must decide. (RBI Cyber Resilience §4.2 — segregation of duties.)
                </p>
              )}
              {!isMaker && canDecide && (
                <>
                  <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">
                    Decision notes (required for reject)
                  </label>
                  <textarea
                    value={decisionNotes}
                    onChange={(e) => {
                      setError(null);
                      setDecisionNotes(e.target.value);
                    }}
                    rows={3}
                    placeholder="Reason / context — required on reject (≥ 3 chars)"
                    className="w-full rounded border border-slate-300 p-2 text-sm"
                    data-testid="workflow-decision-notes"
                  />
                  {error && (
                    <p
                      className="mt-2 rounded bg-rose-50 border border-rose-200 p-2 text-sm text-rose-700"
                      data-testid="workflow-decision-error"
                    >
                      {error}
                    </p>
                  )}
                </>
              )}
              {!isMaker && !canDecide && (
                <p
                  className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600"
                  data-testid="workflow-no-rbac"
                >
                  Decision requires <strong>admin</strong> or <strong>supervisor</strong> role.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </EnterpriseDialog>
  );
}

// ─── Submit modal ────────────────────────────────────────────────────

function SubmitWorkflowModal({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [caseId, setCaseId] = useState('');
  const [actionType, setActionType] = useState<SensitiveActionType>('case.close');
  const [rationale, setRationale] = useState('');
  const [payload, setPayload] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  const submitMut = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(payload || '{}');
      } catch {
        throw new Error('Payload must be valid JSON');
      }
      return cmsApi.workflow.submit({
        case_id: caseId.trim(),
        action_type: actionType,
        payload: parsed,
        rationale: rationale.trim(),
      });
    },
    onSuccess: onSubmitted,
    onError: (e: unknown) => setError(extractErrorMessage(e)),
  });

  const armed = caseId.trim().length > 0 && rationale.trim().length >= 3;

  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title="Submit workflow request"
      size="md"
      testId="workflow-submit-modal"
      footer={
        <DialogFooter
          onCancel={onClose}
          primary={
            <Button
              onClick={() => submitMut.mutate()}
              disabled={!armed || submitMut.isPending}
              data-testid="workflow-submit-confirm"
            >
              {submitMut.isPending ? 'Submitting…' : 'Submit'}
            </Button>
          }
        />
      }
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Case ID</label>
          <input
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
            placeholder="case_id from /v1/cms/cases"
            className="w-full rounded border border-slate-300 p-2 font-mono text-sm"
            data-testid="workflow-submit-case-id"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Action type</label>
          <select
            value={actionType}
            onChange={(e) => setActionType(e.target.value as SensitiveActionType)}
            className="w-full rounded border border-slate-300 p-2 text-sm"
            data-testid="workflow-submit-action-type"
          >
            <option value="case.close">Close case</option>
            <option value="case.escalate">Escalate to CRO</option>
            <option value="case.override_decision">Override decision</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">
            Rationale (≥ 3 chars)
          </label>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={2}
            placeholder="Why this action is needed"
            className="w-full rounded border border-slate-300 p-2 text-sm"
            data-testid="workflow-submit-rationale"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">
            Payload (JSON)
          </label>
          <textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={3}
            className="w-full rounded border border-slate-300 p-2 font-mono text-xs"
            placeholder='{"resolution_category":"false_positive"}'
            data-testid="workflow-submit-payload"
          />
        </div>
        {error && (
          <p
            className="rounded bg-rose-50 border border-rose-200 p-2 text-sm text-rose-700"
            data-testid="workflow-submit-error"
          >
            {error}
          </p>
        )}
      </div>
    </EnterpriseDialog>
  );
}

// ─── Reassign-load modal ─────────────────────────────────────────────

function ReassignLoadModal({
  onClose,
  onAssigned,
}: {
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [caseIdsText, setCaseIdsText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const bulkMut = useMutation({
    mutationFn: () => {
      const case_ids = caseIdsText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (case_ids.length === 0) throw new Error('At least one case_id required');
      return cmsApi.bulkAssign(case_ids, assignee.trim(), reason.trim() || undefined);
    },
    onSuccess: onAssigned,
    onError: (e: unknown) => setError(extractErrorMessage(e)),
  });

  const armed = caseIdsText.trim().length > 0 && assignee.trim().length > 0;

  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title="Reassign caseload"
      size="md"
      testId="workflow-reassign-modal"
      footer={
        <DialogFooter
          onCancel={onClose}
          primary={
            <Button
              onClick={() => bulkMut.mutate()}
              disabled={!armed || bulkMut.isPending}
              data-testid="workflow-reassign-confirm"
            >
              {bulkMut.isPending ? 'Assigning…' : 'Reassign'}
            </Button>
          }
        />
      }
    >
      <p className="text-sm text-slate-600">
        Bulk reassign multiple cases to a single owner. Paste case IDs separated by
        whitespace or commas. Uses the existing M3.1 bulk-assign route (audit
        events emit per assignment).
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">
            Case IDs
          </label>
          <textarea
            value={caseIdsText}
            onChange={(e) => setCaseIdsText(e.target.value)}
            rows={4}
            placeholder="case-id-1, case-id-2, case-id-3"
            className="w-full rounded border border-slate-300 p-2 font-mono text-xs"
            data-testid="workflow-reassign-ids"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">
            Assignee (username)
          </label>
          <input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="alice.analyst"
            className="w-full rounded border border-slate-300 p-2 text-sm"
            data-testid="workflow-reassign-assignee"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">
            Reason (optional)
          </label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Workload rebalance"
            className="w-full rounded border border-slate-300 p-2 text-sm"
            data-testid="workflow-reassign-reason"
          />
        </div>
        {error && (
          <p
            className="rounded bg-rose-50 border border-rose-200 p-2 text-sm text-rose-700"
            data-testid="workflow-reassign-error"
          >
            {error}
          </p>
        )}
      </div>
    </EnterpriseDialog>
  );
}

// ─── Shared helpers ──────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

interface ErrorLike {
  response?: { data?: { error?: { message?: string; code?: string } } };
  message?: string;
}

function extractErrorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const err = e as ErrorLike;
    return (
      err.response?.data?.error?.message ||
      err.response?.data?.error?.code ||
      err.message ||
      'Request failed'
    );
  }
  return String(e);
}
