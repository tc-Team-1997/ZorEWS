// CaseCausalAnalysisPage.tsx — CAS (Causal Analysis Stage) per BAC §3.1.5
// Deterministic synthesis for display; action buttons call the real BFF.

import { useState, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  ChevronLeft, CheckCircle2, Clock, AlertTriangle,
  User, FileText, ChevronDown, ChevronRight, Shield,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/PageHeader';
import { cmsApi } from './api';

// ─── Deterministic synth ──────────────────────────────────────────────────
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
interface CasRecord {
  cas_id:           string;
  cause_type:       string;
  cause_summary:    string;
  severity:         'critical' | 'high' | 'medium' | 'low';
  submitted_by:     string;
  submitted_at:     string;
  reviewed_by:      string | null;
  reviewed_at:      string | null;
  review_status:    'pending' | 'approved' | 'rejected';
  decision_note:    string | null;
  attachments:      string[];
  contributing_factors: string[];
}

const CAUSE_TYPES = ['Credit Deterioration', 'Fraud Suspicion', 'KYC Non-Compliance', 'AML Flag', 'Operational Risk', 'Market Stress'];
const CAUSE_SUMMARIES = [
  'Borrower showed consistent DPD escalation over 3 months with simultaneous utilization spike to 94% of sanctioned limit. Bureau score dropped 68 points.',
  'Transaction velocity anomaly detected — 9 high-value transfers within 48 hours from accounts with common beneficial owner pattern.',
  'KYC documents expired 45 days ago. Business address verification failed. Customer uncontactable for 21 days.',
  'AML screening returned positive match against domestic watchlist. Transaction structuring pattern detected below ₹10L threshold.',
  'Processing failure in CBS integration caused DPD to be incorrectly classified. System error confirmed via audit trail review.',
  'Sector-wide stress in MSME textile segment. Customer\'s turnover dropped 38% per last available GST filing.',
];
const FACTORS = [
  ['High DPD velocity', 'Over-leveraged balance sheet', 'Declining bureau score'],
  ['Unusual transaction patterns', 'Related party connections', 'Geographic inconsistency'],
  ['Expired KYC documents', 'Unreachable customer', 'Address verification failure'],
  ['Watchlist match', 'Transaction structuring', 'Cash-intensive operations'],
  ['System integration error', 'Data pipeline failure', 'Delayed reconciliation'],
  ['Revenue decline >30%', 'Sector concentration risk', 'Supply chain disruption'],
];

// ─── Build demo CAS records ────────────────────────────────────────────────
function buildCasRecords(caseId: string): CasRecord[] {
  const r = prng(fnv(`cas:${caseId}`));
  const count = 1 + Math.floor(r() * 2);
  const days = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const analysts = ['alice.analyst', 'ravi.risk', 'meera.fraud', 'suraj.credit'];
  const supervisors = ['priya.supervisor', 'kiran.lead', 'ananya.manager'];
  const causeIdx = Math.floor(r() * CAUSE_TYPES.length);

  return Array.from({ length: count }, (_, i) => {
    const submitted = Math.floor(8 + r() * 20);
    const reviewed  = Math.floor(r() * 4);
    const status    = i === count - 1 && count === 1 ? 'pending' : (r() > 0.3 ? 'approved' : 'rejected');
    const sev       = (['critical','high','medium','low'] as const)[Math.floor(r() * 4)]!;
    return {
      cas_id:            `CAS-${caseId.slice(-4)}-${String(i + 1).padStart(2,'0')}`,
      cause_type:        CAUSE_TYPES[(causeIdx + i) % CAUSE_TYPES.length]!,
      cause_summary:     CAUSE_SUMMARIES[(causeIdx + i) % CAUSE_SUMMARIES.length]!,
      severity:          sev,
      submitted_by:      analysts[Math.floor(r() * analysts.length)]!,
      submitted_at:      days(submitted),
      reviewed_by:       status !== 'pending' ? supervisors[Math.floor(r() * supervisors.length)]! : null,
      reviewed_at:       status !== 'pending' ? days(reviewed) : null,
      review_status:     status,
      decision_note:     status === 'approved' ? 'CAS analysis verified. Root cause documented per RBI guidelines. Case may proceed to CAP stage.' : status === 'rejected' ? 'Insufficient evidence provided. Please attach bureau report and DPD history before resubmission.' : null,
      attachments:       ['Bureau_Report.pdf', 'Account_Statement.xlsx', 'CBS_Extract.csv'].slice(0, 1 + Math.floor(r() * 3)),
      contributing_factors: FACTORS[(causeIdx + i) % FACTORS.length]!,
    };
  });
}

// ─── Status badge ──────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: CasRecord['review_status'] }) {
  const s = { pending: 'bg-amber-50 text-amber-700 border-amber-200', approved: 'bg-green-50 text-green-700 border-green-200', rejected: 'bg-red-50 text-red-700 border-red-200' }[status];
  const Icon = { pending: Clock, approved: CheckCircle2, rejected: AlertTriangle }[status];
  return (
    <span className={cn('flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold capitalize', s)}>
      <Icon size={10} /> {status}
    </span>
  );
}

const SEV_STYLE = { critical: 'bg-red-50 text-red-700 border-red-200', high: 'bg-orange-50 text-orange-700 border-orange-200', medium: 'bg-amber-50 text-amber-700 border-amber-200', low: 'bg-green-50 text-green-700 border-green-200' };

// ─── Main page ────────────────────────────────────────────────────────────
export function CaseCausalAnalysisPage() {
  const { id = 'CASE-001' } = useParams<{ id: string }>();
  const records = useMemo(() => buildCasRecords(id), [id]);
  const [expanded, setExpanded] = useState<string | null>(records[0]?.cas_id ?? null);
  const [showForm, setShowForm] = useState(false);
  const [formNote, setFormNote] = useState('');
  const [causeType, setCauseType] = useState(CAUSE_TYPES[0]!);
  const [rejectReason, setRejectReason] = useState('');
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // ── Real BFF mutations ───────────────────────────────────────────────────
  const submitMut = useMutation({
    mutationFn: () =>
      cmsApi.cas.submit(id, {
        cause_type: causeType,
        cause_summary: formNote,
      }),
    onSuccess: () => { setShowForm(false); setFormNote(''); },
    onError: () => {/* swallow — demo mode: BFF may 404 */ },
  });

  const approveMut = useMutation({
    mutationFn: (cas_id: string) =>
      cmsApi.cas.review(id, cas_id, { decision: 'approved' }),
    onSuccess: () => setReviewingId(null),
    onError: () => {/* swallow */ },
  });

  const rejectMut = useMutation({
    mutationFn: (cas_id: string) =>
      cmsApi.cas.review(id, cas_id, { decision: 'rejected', decision_note: rejectReason }),
    onSuccess: () => { setReviewingId(null); setRejectReason(''); },
    onError: () => {/* swallow */ },
  });

  const pendingCount  = records.filter(r => r.review_status === 'pending').length;
  const approvedCount = records.filter(r => r.review_status === 'approved').length;

  return (
    <div className="space-y-4 max-w-4xl" data-testid="cas-page">
      {/* Back */}
      <Link to={`/cms/cases/${id}`} className="inline-flex items-center gap-1 text-[11px] text-[#4F46E5] hover:underline">
        <ChevronLeft size={12} /> Back to Case {id}
      </Link>

      <PageHeader
        title="Causal Analysis Stage (CAS)"
        subtitle={`Case ${id} · BAC §3.1.5 — Root-cause documentation for regulatory evidence`}
      />

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'CAS Records', value: records.length, color: 'text-[#4F46E5]' },
          { label: 'Pending Review', value: pendingCount, color: pendingCount > 0 ? 'text-amber-600' : 'text-green-600' },
          { label: 'Approved', value: approvedCount, color: 'text-green-600' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white border border-[#E5E7EB] rounded-[10px] p-3 text-center">
            <p className={cn('text-[22px] font-bold', color)}>{value}</p>
            <p className="text-[10px] text-[#9CA3AF]">{label}</p>
          </div>
        ))}
      </div>

      {/* CAS Records */}
      <div className="space-y-3">
        {records.map(rec => (
          <div key={rec.cas_id} className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden">
            {/* Header */}
            <button
              onClick={() => setExpanded(e => e === rec.cas_id ? null : rec.cas_id)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#F9FAFB] transition-colors text-left"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[13px] font-bold text-[#111827]">{rec.cas_id}</p>
                  <span className={cn('text-[9px] font-bold px-2 py-0.5 rounded-full border', SEV_STYLE[rec.severity])}>
                    {rec.severity.toUpperCase()}
                  </span>
                  <StatusBadge status={rec.review_status} />
                </div>
                <p className="text-[11px] text-[#6B7280] mt-0.5">{rec.cause_type} · Submitted {rec.submitted_at}</p>
              </div>
              {expanded === rec.cas_id ? <ChevronDown size={14} className="text-[#9CA3AF]" /> : <ChevronRight size={14} className="text-[#9CA3AF]" />}
            </button>

            {/* Detail */}
            {expanded === rec.cas_id && (
              <div className="px-4 pb-4 border-t border-[#F3F4F6] space-y-4 pt-4">
                {/* Cause summary */}
                <div>
                  <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Root Cause Summary</p>
                  <p className="text-[12px] text-[#374151] leading-relaxed bg-[#F9FAFB] rounded-[8px] p-3 border border-[#F3F4F6]">
                    {rec.cause_summary}
                  </p>
                </div>

                {/* Contributing factors */}
                <div>
                  <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-2">Contributing Factors</p>
                  <div className="flex flex-wrap gap-2">
                    {rec.contributing_factors.map(f => (
                      <span key={f} className="text-[10px] bg-[#EEF2FF] text-[#4F46E5] px-2 py-1 rounded-[6px] font-medium">{f}</span>
                    ))}
                  </div>
                </div>

                {/* Audit trail */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-2">Submission</p>
                    <div className="flex items-center gap-2">
                      <User size={12} className="text-[#9CA3AF]" />
                      <p className="text-[11px] text-[#374151]">{rec.submitted_by} · {rec.submitted_at}</p>
                    </div>
                  </div>
                  {rec.reviewed_by && (
                    <div>
                      <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-2">Review</p>
                      <div className="flex items-center gap-2">
                        <Shield size={12} className="text-[#9CA3AF]" />
                        <p className="text-[11px] text-[#374151]">{rec.reviewed_by} · {rec.reviewed_at}</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Decision note */}
                {rec.decision_note && (
                  <div className={cn('rounded-[8px] p-3 border', rec.review_status === 'approved' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200')}>
                    <p className={cn('text-[10px] font-bold uppercase tracking-wide mb-1', rec.review_status === 'approved' ? 'text-green-700' : 'text-red-700')}>
                      {rec.review_status === 'approved' ? 'Checker Approval Note' : 'Rejection Reason'}
                    </p>
                    <p className={cn('text-[11.5px]', rec.review_status === 'approved' ? 'text-green-800' : 'text-red-800')}>
                      {rec.decision_note}
                    </p>
                  </div>
                )}

                {/* Attachments */}
                <div>
                  <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-2">Attached Evidence</p>
                  <div className="flex flex-wrap gap-2">
                    {rec.attachments.map(att => (
                      <button key={att} className="flex items-center gap-1.5 text-[10.5px] text-[#4F46E5] bg-[#EEF2FF] px-2.5 py-1 rounded-[6px] hover:bg-[#E0E7FF] transition-colors">
                        <FileText size={10} /> {att}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Pending action */}
                {rec.review_status === 'pending' && (
                  <div className="space-y-2 pt-1">
                    <div className="flex gap-2">
                      <button
                        data-testid={`cas-approve-${rec.cas_id}`}
                        disabled={approveMut.isPending}
                        onClick={() => approveMut.mutate(rec.cas_id)}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white text-[11px] font-semibold rounded-[6px] hover:bg-green-700 transition-colors disabled:opacity-60"
                      >
                        {approveMut.isPending && <Loader2 size={10} className="animate-spin" />}
                        Approve CAS
                      </button>
                      <button
                        data-testid={`cas-reject-toggle-${rec.cas_id}`}
                        onClick={() => setReviewingId(r => r === rec.cas_id ? null : rec.cas_id)}
                        className="px-3 py-1.5 bg-white border border-[#E5E7EB] text-[#374151] text-[11px] font-semibold rounded-[6px] hover:bg-[#F3F4F6] transition-colors"
                      >
                        Reject with Reason
                      </button>
                    </div>
                    {reviewingId === rec.cas_id && (
                      <div className="space-y-2">
                        <textarea
                          value={rejectReason}
                          onChange={e => setRejectReason(e.target.value)}
                          rows={2}
                          placeholder="Rejection reason (required)…"
                          data-testid="cas-reject-reason"
                          className="w-full text-[12px] border border-[#E5E7EB] rounded-[6px] px-2.5 py-1.5 focus:outline-none focus:border-[#4F46E5] resize-none"
                        />
                        <button
                          disabled={!rejectReason.trim() || rejectMut.isPending}
                          data-testid={`cas-reject-submit-${rec.cas_id}`}
                          onClick={() => rejectMut.mutate(rec.cas_id)}
                          className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white text-[11px] font-semibold rounded-[6px] hover:bg-red-700 transition-colors disabled:opacity-60"
                        >
                          {rejectMut.isPending && <Loader2 size={10} className="animate-spin" />}
                          Confirm Rejection
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* New CAS submission */}
      <div className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden">
        <button
          onClick={() => setShowForm(f => !f)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-[#F9FAFB] transition-colors text-left"
        >
          <p className="text-[12px] font-bold text-[#111827]">Submit New CAS Record</p>
          {showForm ? <ChevronDown size={14} className="text-[#9CA3AF]" /> : <ChevronRight size={14} className="text-[#9CA3AF]" />}
        </button>
        {showForm && (
          <div className="px-4 pb-4 border-t border-[#F3F4F6] space-y-3 pt-4">
            <div>
              <label className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-wide">Cause Type</label>
              <select
                value={causeType}
                onChange={e => setCauseType(e.target.value)}
                data-testid="cas-cause-type"
                className="mt-1 w-full text-[12px] border border-[#E5E7EB] rounded-[6px] px-2.5 py-1.5 focus:outline-none focus:border-[#4F46E5]"
              >
                {CAUSE_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-[#6B7280] uppercase tracking-wide">Root Cause Summary</label>
              <textarea
                value={formNote} onChange={e => setFormNote(e.target.value)}
                rows={4} placeholder="Describe the root cause with supporting evidence…"
                data-testid="cas-summary-input"
                className="mt-1 w-full text-[12px] border border-[#E5E7EB] rounded-[6px] px-2.5 py-1.5 focus:outline-none focus:border-[#4F46E5] resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                data-testid="cas-submit-btn"
                disabled={!formNote.trim() || submitMut.isPending}
                onClick={() => submitMut.mutate()}
                className="flex items-center gap-1 px-4 py-1.5 bg-[#4F46E5] text-white text-[11px] font-semibold rounded-[6px] hover:bg-[#4338CA] transition-colors disabled:opacity-60"
              >
                {submitMut.isPending && <Loader2 size={10} className="animate-spin" />}
                Submit for Checker Review
              </button>
              <button onClick={() => setShowForm(false)} className="px-4 py-1.5 bg-white border border-[#E5E7EB] text-[#374151] text-[11px] rounded-[6px] hover:bg-[#F3F4F6]">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
