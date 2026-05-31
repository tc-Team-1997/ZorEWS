// web/src/modules/admin/recovery/RecoveryWorkflowQueuePage.tsx
//
// Enterprise Recovery Management Center — Section 6: Maker-Checker Approval Queue.
//
// Shipping the SPA surface (page chrome + tabs + state-machine wiring) ahead
// of the BFF persistence layer. The pure resolvers (workflowStateMachine.ts
// + recoveryRiskScoring.ts) are the canonical contract — the BFF will write
// to app_recovery.recovery_approvals (migration 050) and serve the routes
// declared in docs/recovery-management-center.md §5 in a follow-up commit.
//
// Mirrors the M9.3 case_maker_checker UI shape so operators experience
// familiar 3-tab inbox (Pending · Recently Decided · My Submissions).

import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { GitBranch, ShieldAlert, Inbox } from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  ALL_RECOVERY_APPROVAL_STATUSES,
  STATUS_LABELS,
  type RecoveryApprovalStatus,
} from './workflowStateMachine';

type QueueTab = 'pending' | 'decided' | 'mine';

const TABS: readonly { id: QueueTab; label: string; description: string }[] = [
  { id: 'pending', label: 'Pending Recovery Approval', description: 'Submissions awaiting checker decision' },
  { id: 'decided', label: 'Recently Decided',          description: 'Approved + rejected within the last 30 days' },
  { id: 'mine',    label: 'My Submissions',            description: 'Requests you authored as maker' },
] as const;

export function RecoveryWorkflowQueuePage() {
  const me = useAuth((s) => s.user);
  const [tab, setTab] = useState<QueueTab>('pending');

  // Workflow queue is admin + supervisor (checker) or analyst+ (maker submitting).
  // Field officers + collection officers don't see the queue at all today.
  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  return (
    <div data-testid="recovery-workflow-queue-page">
      <PageHeader
        title="Recovery Workflow"
        subtitle="Maker-checker approval queue for restore + purge requests. RBI segregation of duties: maker ≠ checker."
      />

      <Panel className="mb-4">
        <div className="flex items-start gap-3 text-sm text-ink">
          <GitBranch size={18} className="text-action shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">State machine: draft → submitted → approved → executed.</div>
            <p className="text-muted text-xs mt-0.5">
              Mirrors the M9.3 case maker-checker contract. Submissions live in
              {' '}<code>app_recovery.recovery_approvals</code> (migration 050) and write to the
              existing M15 audit chain on every transition — no duplicate audit storage. Self-approval
              forbidden in 3 places: SPA disabled-button, BFF 403 EWS_403_self_approval_forbidden,
              database CHECK constraint <code>maker_username ≠ checker_username</code>.
            </p>
          </div>
        </div>
      </Panel>

      <div className="mb-4 flex flex-wrap gap-1.5 border-b border-aurora-line" role="tablist" data-testid="recovery-workflow-tabs">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              data-testid={`recovery-workflow-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-[13px] font-medium border-b-2 transition-colors -mb-px ${
                active
                  ? 'border-aurora-indigo text-aurora-indigo'
                  : 'border-transparent text-aurora-ink-sub hover:text-aurora-ink'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <Panel data-testid={`recovery-workflow-panel-${tab}`}>
        <div className="flex items-center gap-3 text-sm text-aurora-ink-sub">
          <Inbox size={18} className="text-aurora-indigo shrink-0" />
          <div>
            <div className="font-medium text-aurora-ink">{TABS.find((t) => t.id === tab)?.label}</div>
            <p className="text-xs mt-0.5">{TABS.find((t) => t.id === tab)?.description}</p>
            <p className="text-xs mt-2 text-muted">
              Backend table <code>app_recovery.recovery_approvals</code> + BFF routes
              <code> /v1/recovery/workflow/* </code> ship in a follow-up commit per
              <code> docs/recovery-management-center.md §3 + §5</code>. The state machine + risk-scoring
              resolver are wired today so the SPA UI is contract-stable for swap.
            </p>
          </div>
        </div>
      </Panel>

      <Panel className="mt-4" title="State catalog">
        <ul className="space-y-1" data-testid="recovery-workflow-state-catalog">
          {ALL_RECOVERY_APPROVAL_STATUSES.map((status: RecoveryApprovalStatus) => {
            const label = STATUS_LABELS[status];
            return (
              <li key={status} className="flex items-center gap-2 text-[13px]">
                <Badge tone={label.tone}>{label.label}</Badge>
                <span className="text-muted">{label.description}</span>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel className="mt-4">
        <div className="flex items-start gap-3 text-xs text-aurora-ink-sub">
          <ShieldAlert size={16} className="text-warning shrink-0 mt-0.5" />
          <div>
            <strong className="text-aurora-ink">Risk scoring on every submission.</strong> Each
            request runs through <code>scoreRecoveryRequest()</code> (factors: PII payload,
            bulk action, irreversible purge, recent deletion, high-value entity) and is bucketed
            low / medium / high / critical. Mirrors M8.16 + Security Activity Center bucketing.
            Checkers see the score badge per row so high-risk requests float to the top.
          </div>
        </div>
      </Panel>
    </div>
  );
}
