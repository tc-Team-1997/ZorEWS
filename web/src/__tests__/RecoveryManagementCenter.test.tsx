// Enterprise Recovery Management Center smoke tests + pure-function invariants.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import {
  RecoveryCenterPage,
  RECOVERY_CENTER_CARDS,
} from '@/modules/admin/recovery/RecoveryCenterPage';
import { RecoveryWorkflowQueuePage } from '@/modules/admin/recovery/RecoveryWorkflowQueuePage';
import { RecoveryHistoryPage } from '@/modules/admin/recovery/RecoveryHistoryPage';
import { RecoverySearchPage } from '@/modules/admin/recovery/RecoverySearchPage';
import { RecoveryPoliciesPage } from '@/modules/admin/recovery/RecoveryPoliciesPage';
import {
  ALL_RECOVERY_RISK_LEVELS,
  ALL_RECOVERY_ACTION_TYPES,
  scoreRecoveryRequest,
  RECOVERY_RISK_THRESHOLDS,
} from '@/modules/admin/recovery/recoveryRiskScoring';
import {
  ALL_RECOVERY_APPROVAL_STATUSES,
  TRANSITIONS,
  TERMINAL_STATUSES,
  canTransition,
  isTerminal,
  nextStatesFor,
  checkMakerNotChecker,
  STATUS_LABELS,
} from '@/modules/admin/recovery/workflowStateMachine';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setUser(role: 'admin' | 'supervisor' | 'risk_analyst' | 'field_officer') {
  const user = {
    id: 'u-001',
    username: `test.${role}`,
    roles: [role] as ('admin' | 'supervisor' | 'risk_analyst' | 'field_officer')[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderRoute(path: string, element: React.ReactElement) {
  return renderWithProviders(
    <Routes>
      <Route path={path} element={element} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: path },
  );
}

beforeEach(() => {
  localStorage.clear();
});

// ─── Landing page ───────────────────────────────────────────────────────

describe('RecoveryCenterPage — landing extension', () => {
  it('admin sees the page + KPI strip', () => {
    setUser('admin');
    renderRoute('/recovery-center', <RecoveryCenterPage />);
    expect(screen.getByTestId('recovery-center-page')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-kpi-strip')).toBeInTheDocument();
  });

  it('renders all 6 KPI tiles', () => {
    setUser('admin');
    renderRoute('/recovery-center', <RecoveryCenterPage />);
    for (const id of ['active', 'pending-approvals', 'restored-today', 'purges-pending', 'high-risk', 'chain-integrity']) {
      expect(screen.getByTestId(`recovery-kpi-${id}`)).toBeInTheDocument();
    }
  });

  it('non-admin bounced', () => {
    setUser('field_officer');
    renderRoute('/recovery-center', <RecoveryCenterPage />);
    expect(screen.queryByTestId('recovery-center-page')).not.toBeInTheDocument();
  });

  it('renders all 10 sections in canonical order', () => {
    setUser('admin');
    renderRoute('/recovery-center', <RecoveryCenterPage />);
    for (const card of RECOVERY_CENTER_CARDS) {
      expect(screen.getByTestId(`recovery-center-card-${card.id}`)).toBeInTheDocument();
    }
    expect(RECOVERY_CENTER_CARDS.map((c) => c.id)).toEqual([
      'deleted', 'restore', 'permanent-delete', 'analytics',
      'workflow', 'history', 'search', 'policies', 'rbac', 'governance',
    ]);
  });

  it('legacy URL panel still renders', () => {
    setUser('admin');
    renderRoute('/recovery-center', <RecoveryCenterPage />);
    expect(screen.getByTestId('recovery-center-legacy-links')).toBeInTheDocument();
  });
});

// ─── Workflow Queue page ────────────────────────────────────────────────

describe('RecoveryWorkflowQueuePage', () => {
  it('admin sees the queue with 3 tabs', () => {
    setUser('admin');
    renderRoute('/recovery-center/workflow', <RecoveryWorkflowQueuePage />);
    expect(screen.getByTestId('recovery-workflow-queue-page')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-workflow-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-workflow-tab-pending')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-workflow-tab-decided')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-workflow-tab-mine')).toBeInTheDocument();
  });

  it('analyst can see the workflow page (maker tier)', () => {
    setUser('risk_analyst');
    renderRoute('/recovery-center/workflow', <RecoveryWorkflowQueuePage />);
    expect(screen.getByTestId('recovery-workflow-queue-page')).toBeInTheDocument();
  });

  it('field_officer bounced from workflow page', () => {
    setUser('field_officer');
    renderRoute('/recovery-center/workflow', <RecoveryWorkflowQueuePage />);
    expect(screen.queryByTestId('recovery-workflow-queue-page')).not.toBeInTheDocument();
  });

  it('state catalog lists all 6 statuses', () => {
    setUser('admin');
    renderRoute('/recovery-center/workflow', <RecoveryWorkflowQueuePage />);
    expect(screen.getByTestId('recovery-workflow-state-catalog')).toBeInTheDocument();
  });
});

// ─── History page ───────────────────────────────────────────────────────

describe('RecoveryHistoryPage', () => {
  it('admin sees the history page with action catalog + deep-link', () => {
    setUser('admin');
    renderRoute('/recovery-center/history', <RecoveryHistoryPage />);
    expect(screen.getByTestId('recovery-history-page')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-history-action-catalog')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-history-deep-link')).toBeInTheDocument();
  });

  it('risk_analyst bounced — history is admin/supervisor only', () => {
    setUser('risk_analyst');
    renderRoute('/recovery-center/history', <RecoveryHistoryPage />);
    expect(screen.queryByTestId('recovery-history-page')).not.toBeInTheDocument();
  });

  it('supervisor sees history (compliance review)', () => {
    setUser('supervisor');
    renderRoute('/recovery-center/history', <RecoveryHistoryPage />);
    expect(screen.getByTestId('recovery-history-page')).toBeInTheDocument();
  });
});

// ─── Search page ────────────────────────────────────────────────────────

describe('RecoverySearchPage', () => {
  it('renders search form + empty state', () => {
    setUser('admin');
    renderRoute('/recovery-center/search', <RecoverySearchPage />);
    expect(screen.getByTestId('recovery-search-page')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-search-form')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-search-input')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-search-empty-state')).toBeInTheDocument();
  });

  it('non-allowed role bounced', () => {
    setUser('field_officer');
    renderRoute('/recovery-center/search', <RecoverySearchPage />);
    expect(screen.queryByTestId('recovery-search-page')).not.toBeInTheDocument();
  });
});

// ─── Policies page ──────────────────────────────────────────────────────

describe('RecoveryPoliciesPage', () => {
  it('admin sees policies + defaults table', () => {
    setUser('admin');
    renderRoute('/recovery-center/policies', <RecoveryPoliciesPage />);
    expect(screen.getByTestId('recovery-policies-page')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-policies-defaults-table')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-policies-rbi-note')).toBeInTheDocument();
  });

  it('non-admin bounced — policies are admin-only', () => {
    setUser('supervisor');
    renderRoute('/recovery-center/policies', <RecoveryPoliciesPage />);
    expect(screen.queryByTestId('recovery-policies-page')).not.toBeInTheDocument();
  });
});

// ─── Risk-scoring resolver ──────────────────────────────────────────────

describe('recoveryRiskScoring — closed enums', () => {
  it('ALL_RECOVERY_RISK_LEVELS has canonical 4 values', () => {
    expect(ALL_RECOVERY_RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('ALL_RECOVERY_ACTION_TYPES has 5 values', () => {
    expect(ALL_RECOVERY_ACTION_TYPES).toHaveLength(5);
    expect(ALL_RECOVERY_ACTION_TYPES).toContain('recovery.restore');
    expect(ALL_RECOVERY_ACTION_TYPES).toContain('recovery.purge');
    expect(ALL_RECOVERY_ACTION_TYPES).toContain('recovery.anonymize');
  });

  it('exports tunable thresholds', () => {
    expect(RECOVERY_RISK_THRESHOLDS.RECENT_DELETION_HOURS).toBe(168);
    expect(RECOVERY_RISK_THRESHOLDS.PURGE_WEIGHT).toBe(2);
  });
});

describe('scoreRecoveryRequest', () => {
  const baseDeleted = new Date('2026-05-15T00:00:00Z').toISOString();
  const now = new Date('2026-05-20T00:00:00Z'); // 5 days later

  it('low-risk: single restore of a webhook with no PII', () => {
    const score = scoreRecoveryRequest({
      action_type: 'recovery.restore',
      entity_type: 'webhook',
      deleted_at: baseDeleted,
      payload: { url: 'https://example.com', method: 'POST' },
    }, now);
    // recent (1) only = 1 → low
    expect(score.level).toBe('low');
    expect(score.total_score).toBe(1);
  });

  it('PII payload triggers +2', () => {
    const score = scoreRecoveryRequest({
      action_type: 'recovery.restore',
      entity_type: 'webhook',
      deleted_at: baseDeleted,
      payload: { email: 'a@b.com', phone: '+91xxx' },
    }, now);
    const piiFactor = score.factors.find((f) => f.id === 'pii_payload');
    expect(piiFactor?.triggered).toBe(true);
  });

  it('high-value entity triggers +2', () => {
    const score = scoreRecoveryRequest({
      action_type: 'recovery.restore',
      entity_type: 'tenant',
      deleted_at: baseDeleted,
    }, now);
    expect(score.factors.find((f) => f.id === 'high_value_entity')?.triggered).toBe(true);
  });

  it('bulk action triggers +1', () => {
    const score = scoreRecoveryRequest({
      action_type: 'recovery.bulk_restore',
      entity_type: 'webhook',
      deleted_at: baseDeleted,
    }, now);
    expect(score.factors.find((f) => f.id === 'bulk_action')?.triggered).toBe(true);
  });

  it('purge action triggers +2', () => {
    const score = scoreRecoveryRequest({
      action_type: 'recovery.purge',
      entity_type: 'webhook',
      deleted_at: baseDeleted,
    }, now);
    expect(score.factors.find((f) => f.id === 'purge_action')?.triggered).toBe(true);
  });

  it('recent deletion (< 7 days) triggers +1', () => {
    const score = scoreRecoveryRequest({
      action_type: 'recovery.restore',
      entity_type: 'webhook',
      deleted_at: baseDeleted,
    }, now);
    expect(score.factors.find((f) => f.id === 'recent_deletion')?.triggered).toBe(true);
  });

  it('old deletion (> 7 days) does NOT trigger recent_deletion', () => {
    const oldDeleted = new Date('2026-04-01T00:00:00Z').toISOString();
    const score = scoreRecoveryRequest({
      action_type: 'recovery.restore',
      entity_type: 'webhook',
      deleted_at: oldDeleted,
    }, now);
    expect(score.factors.find((f) => f.id === 'recent_deletion')?.triggered).toBe(false);
  });

  it('escalates to critical when all 5 factors trigger', () => {
    const score = scoreRecoveryRequest({
      action_type: 'recovery.bulk_purge',
      entity_type: 'customer',
      deleted_at: baseDeleted,
      payload: { name: 'Test', email: 'x@y.com', phone: '+91xxx' },
      record_count: 25,
    }, now);
    // PII 2 + bulk 1 + purge 2 + recent 1 + high_value 2 = 8 → critical
    expect(score.level).toBe('critical');
    expect(score.total_score).toBe(8);
  });

  it('medium-risk: restore of high-value entity (no PII, not recent)', () => {
    const oldDeleted = new Date('2026-04-01T00:00:00Z').toISOString();
    const score = scoreRecoveryRequest({
      action_type: 'recovery.restore',
      entity_type: 'case',
      deleted_at: oldDeleted,
    }, now);
    // high_value 2 only = 2 → medium
    expect(score.level).toBe('medium');
  });
});

// ─── Workflow state machine ─────────────────────────────────────────────

describe('workflowStateMachine — closed enums', () => {
  it('ALL_RECOVERY_APPROVAL_STATUSES has 6 canonical values', () => {
    expect(ALL_RECOVERY_APPROVAL_STATUSES).toEqual([
      'draft', 'submitted', 'approved', 'rejected', 'executed', 'cancelled',
    ]);
  });

  it('TERMINAL_STATUSES is the 3 end-states', () => {
    expect(TERMINAL_STATUSES).toEqual(['rejected', 'executed', 'cancelled']);
  });
});

describe('canTransition', () => {
  it('happy path: draft → submitted → approved → executed', () => {
    expect(canTransition('draft', 'submitted')).toBe(true);
    expect(canTransition('submitted', 'approved')).toBe(true);
    expect(canTransition('approved', 'executed')).toBe(true);
  });

  it('rejection path: submitted → rejected', () => {
    expect(canTransition('submitted', 'rejected')).toBe(true);
  });

  it('cancellation path: submitted → cancelled', () => {
    expect(canTransition('submitted', 'cancelled')).toBe(true);
  });

  it('rejects no-op self-transitions', () => {
    for (const s of ALL_RECOVERY_APPROVAL_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('terminal states have zero outbound transitions', () => {
    for (const t of TERMINAL_STATUSES) {
      expect(TRANSITIONS[t]).toEqual([]);
      expect(nextStatesFor(t)).toEqual([]);
    }
  });

  it('cannot rewind: executed → anything is false', () => {
    expect(canTransition('executed', 'submitted')).toBe(false);
    expect(canTransition('executed', 'approved')).toBe(false);
  });

  it('rejected cannot resurrect', () => {
    expect(canTransition('rejected', 'submitted')).toBe(false);
    expect(canTransition('rejected', 'approved')).toBe(false);
  });
});

describe('isTerminal', () => {
  it('flags every TERMINAL_STATUS as terminal', () => {
    for (const t of TERMINAL_STATUSES) expect(isTerminal(t)).toBe(true);
  });

  it('flags non-terminal states as non-terminal', () => {
    for (const s of ['draft', 'submitted', 'approved'] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe('checkMakerNotChecker — RBI segregation of duties', () => {
  it('rejects self-approval (maker === checker)', () => {
    const r = checkMakerNotChecker('alice.admin', 'alice.admin');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('self_approval_forbidden');
  });

  it('allows distinct maker + checker', () => {
    const r = checkMakerNotChecker('alice.admin', 'bob.admin');
    expect(r.allowed).toBe(true);
  });

  it('allows empty checker (pending decision)', () => {
    const r = checkMakerNotChecker('alice.admin', '');
    expect(r.allowed).toBe(true);
  });
});

describe('STATUS_LABELS', () => {
  it('has an entry for every status', () => {
    for (const s of ALL_RECOVERY_APPROVAL_STATUSES) {
      expect(STATUS_LABELS[s]).toBeDefined();
      expect(STATUS_LABELS[s].label.length).toBeGreaterThan(0);
    }
  });

  it('terminal states have appropriate tones', () => {
    expect(STATUS_LABELS.rejected.tone).toBe('danger');
    expect(STATUS_LABELS.executed.tone).toBe('blue');
    expect(STATUS_LABELS.submitted.tone).toBe('warning');
  });
});
