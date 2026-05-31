// web/src/modules/admin/recovery/RecoveryHistoryPage.tsx
//
// Enterprise Recovery Management Center — Section 4: Recovery History.
//
// Read-only timeline pivot over the existing M15 audit chain. NEVER duplicates
// audit storage: queries auditTrailStore filtered to resource_type='recovery'
// and surfaces each event with its chain hash so the SPA can show a tamper-
// evidence badge per row.
//
// Today the SPA shows the contract + empty state; full wiring to
// GET /v1/recovery/history (which is GET /v1/audit/events filtered) lands in
// the BFF follow-up. The audit chain endpoint already exists — this page
// just needs a filter forwarding pass.

import { Link, Navigate } from 'react-router-dom';
import { History as HistoryIcon, ShieldCheck, ArrowRight } from 'lucide-react';
import { Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';

const RECOVERY_AUDIT_ACTIONS = [
  'recovery.restored',
  'recovery.purged',
  'recovery.approved',
  'recovery.rejected',
  'recovery.submitted',
  'recovery.cancelled',
] as const;

export function RecoveryHistoryPage() {
  const me = useAuth((s) => s.user);

  // History is admin + supervisor (compliance review needs full visibility).
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="recovery-history-page">
      <PageHeader
        title="Recovery History"
        subtitle="Cryptographically-chained timeline of every restore / purge / approval decision. Read-only pivot over M15 audit chain."
      />

      <Panel className="mb-4">
        <div className="flex items-start gap-3 text-sm text-ink">
          <HistoryIcon size={18} className="text-action shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Zero duplicate audit storage.</div>
            <p className="text-muted text-xs mt-0.5">
              Every recovery action fans out into the existing M15 hash-chain
              (<code>audit.event_log</code>) via the shared <code>auditTrailStore</code> interface.
              This page is a filtered view over that chain — never a parallel store. Compliance teams
              can verify integrity with the same <code>verifyChain()</code> primitive used by the
              Audit Center.
            </p>
          </div>
        </div>
      </Panel>

      <Panel className="mb-4" title="Recovery action verbs surfaced here">
        <ul className="space-y-1" data-testid="recovery-history-action-catalog">
          {RECOVERY_AUDIT_ACTIONS.map((action) => (
            <li key={action} className="flex items-center gap-2 text-[13px]">
              <code className="px-1.5 py-0.5 bg-aurora-tint rounded text-[11px] text-aurora-indigo">{action}</code>
              <span className="text-muted">
                {action === 'recovery.restored' && 'A soft-deleted row was re-inserted via an adapter.'}
                {action === 'recovery.purged' && 'A soft-deleted row was irreversibly destroyed.'}
                {action === 'recovery.approved' && 'A checker signed off on a maker submission.'}
                {action === 'recovery.rejected' && 'A checker rejected a submission with a rationale.'}
                {action === 'recovery.submitted' && 'A maker filed a restore / purge request.'}
                {action === 'recovery.cancelled' && 'A maker withdrew a submission before review.'}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel data-testid="recovery-history-empty">
        <div className="flex items-start gap-3 text-sm text-aurora-ink-sub">
          <ShieldCheck size={18} className="text-success shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-aurora-ink">Audit-chain query lands in the follow-up commit.</div>
            <p className="text-xs mt-0.5">
              The data source already exists at <code>GET /v1/audit/events?resource_type=recovery</code>.
              The recovery-specific filter shape (date range × tenant × domain × country × actor)
              is added as a forwarding pass on the existing M15 surface — no new table, no new
              endpoint. Until wired, deep-link straight into the existing surface:
            </p>
            <Link
              to="/admin/audit-trail?resource_type=recovery"
              className="inline-flex items-center gap-1 mt-2 text-action text-[13px] hover:underline"
              data-testid="recovery-history-deep-link"
            >
              Open Audit Trail filtered to recovery <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </Panel>
    </div>
  );
}
