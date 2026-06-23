// CaseCapPage.tsx — Corrective Action Plan per BAC §3.1.5
// Deterministic synthesis for display; action buttons call the real BFF.

import { useState, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  ChevronLeft, CheckCircle2, Clock, AlertTriangle,
  ChevronDown, ChevronRight, User, Target, Calendar,
  TrendingUp, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/PageHeader';
import { cmsApi } from './api';

// ─── Synth ────────────────────────────────────────────────────────────────
function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}
function prng(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Types ────────────────────────────────────────────────────────────────
type CapStatus = 'open' | 'in_progress' | 'completed' | 'overdue';
type CapPriority = 'critical' | 'high' | 'medium';
type ApprovalStatus = 'pending' | 'approved' | 'rejected';

interface CapItem {
  cap_id:          string;
  action_title:    string;
  description:     string;
  issue_owner:     string;
  owner_group:     string;
  priority:        CapPriority;
  status:          CapStatus;
  target_date:     string;
  completed_at:    string | null;
  approval_status: ApprovalStatus;
  approved_by:     string | null;
  approved_at:     string | null;
  progress_notes:  string;
  success_criteria: string;
}

const CAP_ACTIONS = [
  { title: 'Initiate NPA Early Warning Protocol', desc: 'Trigger EWS protocol per RBI circular RBI/2023-24/53. Assign dedicated relationship manager and set 15-day contact cadence.', group: 'Risk Management' },
  { title: 'Enforce KYC Refresh Immediately', desc: 'Customer to submit refreshed Aadhaar, PAN, and business proof within 7 working days. Block disbursements until completed.', group: 'Compliance' },
  { title: 'AML Transaction Review', desc: 'Conduct retrospective review of last 90 days of transactions. File STR with FIU-IND if suspicious patterns confirmed.', group: 'AML/Compliance' },
  { title: 'Collateral Re-Valuation', desc: 'Commission independent valuation of primary collateral. Update LTV ratio and reassess credit limits accordingly.', group: 'Credit Risk' },
  { title: 'Restructure Repayment Schedule', desc: 'Propose moratorium of 3 months with repayment extension. Obtain board approval if restructuring exceeds ₹1Cr threshold.', group: 'Recovery' },
  { title: 'Escalate to Legal for SARFAESI Notice', desc: 'Issue 13(2) demand notice under SARFAESI Act, 2002. Allow 60-day compliance window before possession proceedings.', group: 'Legal' },
];
const SUCCESS_CRITERIA = [
  'Customer re-engages within 15 days. DPD normalized within 30 days.',
  'KYC documents verified and updated in CBS. Risk classification reviewed.',
  'STR filed (if required) within 7-day regulatory mandate. Account monitored for 90 days.',
  'New valuation completed. LTV recalculated. Credit exposure adjusted.',
  'Restructuring proposal accepted by customer. First installment received under new schedule.',
  'Notice served and acknowledged. Borrower engages with resolution timeline.',
];

function buildCapItems(caseId: string): CapItem[] {
  const r = prng(fnv(`cap:${caseId}`));
  const count = 2 + Math.floor(r() * 2);
  const daysFromNow = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const analysts = ['ravi.risk', 'meera.compliance', 'suraj.legal', 'kavya.credit'];
  const supervisors = ['priya.supervisor', 'kiran.lead'];
  const statuses: CapStatus[] = ['open', 'in_progress', 'completed', 'overdue'];

  return Array.from({ length: count }, (_, i) => {
    const actionIdx = Math.floor(r() * CAP_ACTIONS.length);
    const action    = CAP_ACTIONS[actionIdx]!;
    const priority  = (['critical','high','medium'] as CapPriority[])[Math.floor(r() * 3)]!;
    const status    = statuses[Math.floor(r() * statuses.length)]!;
    const approvalStatus: ApprovalStatus = status === 'completed' ? 'approved' : i === 0 ? 'pending' : (r() > 0.4 ? 'approved' : 'pending');
    const targetDays = status === 'overdue' ? -Math.floor(r() * 7) : Math.floor(15 + r() * 30);
    return {
      cap_id:           `CAP-${caseId.slice(-4)}-${String(i + 1).padStart(2,'0')}`,
      action_title:     action.title,
      description:      action.desc,
      issue_owner:      analysts[Math.floor(r() * analysts.length)]!,
      owner_group:      action.group,
      priority,
      status,
      target_date:      daysFromNow(targetDays),
      completed_at:     status === 'completed' ? daysAgo(Math.floor(r() * 5)) : null,
      approval_status:  approvalStatus,
      approved_by:      approvalStatus === 'approved' ? supervisors[Math.floor(r() * supervisors.length)]! : null,
      approved_at:      approvalStatus === 'approved' ? daysAgo(Math.floor(r() * 10)) : null,
      progress_notes:   status === 'in_progress' ? 'Initial outreach completed. Customer acknowledged receipt. Follow-up scheduled in 3 days.' : status === 'completed' ? 'Action completed successfully. Outcome documented and verified by checker.' : '',
      success_criteria: SUCCESS_CRITERIA[actionIdx % SUCCESS_CRITERIA.length]!,
    };
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────
const STATUS_STYLE: Record<CapStatus, { bg: string; text: string; Icon: typeof Clock; label: string }> = {
  open:        { bg: 'bg-[#F3F4F6]',   text: 'text-[#6B7280]', Icon: Clock,          label: 'Open' },
  in_progress: { bg: 'bg-blue-50',     text: 'text-blue-700',  Icon: TrendingUp,     label: 'In Progress' },
  completed:   { bg: 'bg-green-50',    text: 'text-green-700', Icon: CheckCircle2,   label: 'Completed' },
  overdue:     { bg: 'bg-red-50',      text: 'text-red-700',   Icon: AlertTriangle,  label: 'Overdue' },
};
const PRIO_STYLE: Record<CapPriority, string> = {
  critical: 'bg-red-50 text-red-700 border-red-200',
  high:     'bg-orange-50 text-orange-700 border-orange-200',
  medium:   'bg-amber-50 text-amber-700 border-amber-200',
};
const APPROVAL_STYLE: Record<ApprovalStatus, { bg: string; text: string; label: string }> = {
  pending:  { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Awaiting Checker' },
  approved: { bg: 'bg-green-50', text: 'text-green-700', label: 'Checker Approved' },
  rejected: { bg: 'bg-red-50',   text: 'text-red-700',   label: 'Checker Rejected' },
};

// ─── Main page ────────────────────────────────────────────────────────────
export function CaseCapPage() {
  const { id = 'CASE-001' } = useParams<{ id: string }>();
  const items = useMemo(() => buildCapItems(id), [id]);
  const [expanded, setExpanded] = useState<string | null>(items[0]?.cap_id ?? null);

  // ── Real BFF mutations ───────────────────────────────────────────────────
  const approveMut = useMutation({
    mutationFn: (cap_id: string) =>
      cmsApi.cap.approve(id, cap_id, { decision_notes: 'Checker approved via EWS portal' }),
    onError: () => {/* swallow — BFF may 404 in demo mode */ },
  });

  const closeMut = useMutation({
    mutationFn: (cap_id: string) =>
      cmsApi.cap.close(id, cap_id, { closure_comments: 'Action completed and verified' }),
    onError: () => {/* swallow */ },
  });

  const openCount      = items.filter(c => c.status === 'open' || c.status === 'in_progress').length;
  const overdueCount   = items.filter(c => c.status === 'overdue').length;
  const completedCount = items.filter(c => c.status === 'completed').length;
  const pendingApproval = items.filter(c => c.approval_status === 'pending').length;
  const allClosed = items.every(c => c.status === 'completed');

  return (
    <div className="space-y-4 max-w-4xl" data-testid="cap-page">
      {/* Back */}
      <Link to={`/cms/cases/${id}`} className="inline-flex items-center gap-1 text-[11px] text-[#4F46E5] hover:underline">
        <ChevronLeft size={12} /> Back to Case {id}
      </Link>

      <PageHeader
        title="Corrective Action Plan (CAP)"
        subtitle={`Case ${id} · BAC §3.1.5 — Case closure requires all CAP items completed & approved`}
      />

      {/* Closure gate notice */}
      {!allClosed && (
        <div className={cn('flex items-start gap-3 p-3 rounded-[10px] border text-[11.5px]',
          overdueCount > 0 ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800')}>
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <p>
            <strong>Case closure blocked</strong> — {openCount} action{openCount !== 1 ? 's' : ''} still open
            {overdueCount > 0 ? `, ${overdueCount} overdue` : ''}.
            {pendingApproval > 0 ? ` ${pendingApproval} item${pendingApproval > 1 ? 's' : ''} awaiting checker approval.` : ''}
            {' '}All CAP items must be completed and checker-approved before this case can be closed.
          </p>
        </div>
      )}
      {allClosed && (
        <div className="flex items-center gap-3 p-3 rounded-[10px] bg-green-50 border border-green-200 text-green-800 text-[11.5px]">
          <CheckCircle2 size={14} className="shrink-0" />
          <p><strong>All CAP items completed.</strong> Case is eligible for closure via the maker-checker workflow.</p>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Total Actions', value: items.length, color: 'text-[#4F46E5]' },
          { label: 'Open / Active', value: openCount, color: openCount > 0 ? 'text-amber-600' : 'text-green-600' },
          { label: 'Overdue', value: overdueCount, color: overdueCount > 0 ? 'text-red-600' : 'text-green-600' },
          { label: 'Completed', value: completedCount, color: 'text-green-600' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white border border-[#E5E7EB] rounded-[10px] p-3 text-center">
            <p className={cn('text-[22px] font-bold', color)}>{value}</p>
            <p className="text-[10px] text-[#9CA3AF]">{label}</p>
          </div>
        ))}
      </div>

      {/* CAP items */}
      <div className="space-y-3">
        {items.map(item => {
          const ss = STATUS_STYLE[item.status];
          const as = APPROVAL_STYLE[item.approval_status];
          const StatusIcon = ss.Icon;
          return (
            <div key={item.cap_id} className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden">
              <button
                onClick={() => setExpanded(e => e === item.cap_id ? null : item.cap_id)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#F9FAFB] transition-colors text-left"
              >
                <StatusIcon size={14} className={ss.text} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-[12px] font-bold text-[#111827]">{item.action_title}</p>
                    <span className={cn('text-[8.5px] font-bold px-1.5 py-0.5 rounded-full border capitalize', PRIO_STYLE[item.priority])}>
                      {item.priority}
                    </span>
                    <span className={cn('text-[9px] font-semibold px-2 py-0.5 rounded-full', ss.bg, ss.text)}>
                      {ss.label}
                    </span>
                  </div>
                  <p className="text-[10px] text-[#9CA3AF] mt-0.5">{item.owner_group} · {item.issue_owner} · Due {item.target_date}</p>
                </div>
                <span className={cn('text-[9px] font-semibold px-2 py-0.5 rounded-full shrink-0', as.bg, as.text)}>
                  {as.label}
                </span>
                {expanded === item.cap_id ? <ChevronDown size={13} className="text-[#9CA3AF] shrink-0" /> : <ChevronRight size={13} className="text-[#9CA3AF] shrink-0" />}
              </button>

              {expanded === item.cap_id && (
                <div className="px-4 pb-4 pt-3 border-t border-[#F3F4F6] space-y-3">
                  {/* Description */}
                  <div>
                    <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Action Description</p>
                    <p className="text-[12px] text-[#374151] bg-[#F9FAFB] rounded-[8px] p-3 border border-[#F3F4F6] leading-relaxed">{item.description}</p>
                  </div>

                  {/* Success criteria */}
                  <div>
                    <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Success Criteria</p>
                    <div className="flex items-start gap-2">
                      <Target size={12} className="text-[#4F46E5] mt-0.5 shrink-0" />
                      <p className="text-[11.5px] text-[#374151]">{item.success_criteria}</p>
                    </div>
                  </div>

                  {/* Details grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    <div>
                      <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Owner</p>
                      <div className="flex items-center gap-1.5">
                        <User size={11} className="text-[#9CA3AF]" />
                        <p className="text-[11px] text-[#374151]">{item.issue_owner}</p>
                      </div>
                      <p className="text-[9.5px] text-[#9CA3AF] mt-0.5">{item.owner_group}</p>
                    </div>
                    <div>
                      <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Target Date</p>
                      <div className="flex items-center gap-1.5">
                        <Calendar size={11} className={item.status === 'overdue' ? 'text-red-500' : 'text-[#9CA3AF]'} />
                        <p className={cn('text-[11px]', item.status === 'overdue' ? 'text-red-600 font-semibold' : 'text-[#374151]')}>{item.target_date}</p>
                      </div>
                      {item.completed_at && <p className="text-[9.5px] text-green-600 mt-0.5">✓ Done {item.completed_at}</p>}
                    </div>
                    {item.approved_by && (
                      <div>
                        <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Approved By</p>
                        <p className="text-[11px] text-[#374151]">{item.approved_by}</p>
                        <p className="text-[9.5px] text-[#9CA3AF]">{item.approved_at}</p>
                      </div>
                    )}
                  </div>

                  {/* Progress notes */}
                  {item.progress_notes && (
                    <div className="bg-blue-50 rounded-[8px] p-3 border border-blue-100">
                      <p className="text-[9.5px] font-bold text-blue-700 uppercase tracking-wide mb-0.5">Progress Notes</p>
                      <p className="text-[11.5px] text-blue-800">{item.progress_notes}</p>
                    </div>
                  )}

                  {/* Actions */}
                  {item.status !== 'completed' && (
                    <div className="flex gap-2 pt-1">
                      <button
                        data-testid={`cap-close-${item.cap_id}`}
                        disabled={closeMut.isPending}
                        onClick={() => closeMut.mutate(item.cap_id)}
                        className="flex items-center gap-1 px-3 py-1.5 bg-[#4F46E5] text-white text-[11px] font-semibold rounded-[6px] hover:bg-[#4338CA] transition-colors disabled:opacity-60"
                      >
                        {closeMut.isPending && <Loader2 size={10} className="animate-spin" />}
                        Mark as Completed
                      </button>
                      <button className="px-3 py-1.5 bg-white border border-[#E5E7EB] text-[#374151] text-[11px] rounded-[6px] hover:bg-[#F3F4F6]">
                        Update Progress
                      </button>
                      {item.approval_status === 'pending' && (
                        <button
                          data-testid={`cap-approve-${item.cap_id}`}
                          disabled={approveMut.isPending}
                          onClick={() => approveMut.mutate(item.cap_id)}
                          className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white text-[11px] font-semibold rounded-[6px] hover:bg-green-700 transition-colors disabled:opacity-60 ml-auto"
                        >
                          {approveMut.isPending && <Loader2 size={10} className="animate-spin" />}
                          Approve (Checker)
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
