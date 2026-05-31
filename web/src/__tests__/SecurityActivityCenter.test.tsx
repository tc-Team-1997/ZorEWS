// Security Activity Center smoke tests + risk-scoring resolver invariants.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import {
  SecurityActivityCenterPage,
  SECURITY_CARDS,
} from '@/modules/admin/security/SecurityActivityCenterPage';
import {
  ALL_SECURITY_RISK_LEVELS,
  computeRiskScoreForActor,
  rollupActorRiskScores,
  summarizeSecurityActivity,
  SECURITY_RISK_THRESHOLDS,
} from '@/modules/admin/security/securityRiskScoring';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth, type AuthAuditEvent, type SessionRow } from '@/store/auth';

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

function evt(partial: Partial<AuthAuditEvent> = {}): AuthAuditEvent {
  return {
    id: partial.id ?? `evt-${Math.random()}`,
    ts: partial.ts ?? new Date().toISOString(),
    type: partial.type ?? 'login_success',
    actor_username: partial.actor_username ?? 'alice.admin',
    actor_role: partial.actor_role ?? 'admin',
    target_username: partial.target_username ?? null,
    ip: partial.ip ?? '10.0.0.1',
    metadata: partial.metadata ?? {},
  };
}

function sess(partial: Partial<SessionRow> = {}): SessionRow {
  return {
    id: partial.id ?? `sess-${Math.random()}`,
    user_id: partial.user_id ?? 'alice.admin',
    issued_at: partial.issued_at ?? new Date().toISOString(),
    last_seen_at: partial.last_seen_at ?? new Date().toISOString(),
    ip: partial.ip ?? '10.0.0.1',
    user_agent: partial.user_agent ?? 'jest',
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('SecurityActivityCenterPage', () => {
  it('admin sees the page + dashboard KPI strip', () => {
    setUser('admin');
    renderRoute('/admin/security', <SecurityActivityCenterPage />);
    expect(screen.getByTestId('security-activity-center-page')).toBeInTheDocument();
    expect(screen.getByTestId('security-dashboard-kpis')).toBeInTheDocument();
    expect(screen.getByTestId('security-kpi-active-users')).toBeInTheDocument();
    expect(screen.getByTestId('security-kpi-failed-logins')).toBeInTheDocument();
    expect(screen.getByTestId('security-kpi-suspicious')).toBeInTheDocument();
    expect(screen.getByTestId('security-kpi-locked')).toBeInTheDocument();
    expect(screen.getByTestId('security-kpi-critical')).toBeInTheDocument();
  });

  it('supervisor can see the page', () => {
    setUser('supervisor');
    renderRoute('/admin/security', <SecurityActivityCenterPage />);
    expect(screen.getByTestId('security-activity-center-page')).toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/security', <SecurityActivityCenterPage />);
    expect(screen.queryByTestId('security-activity-center-page')).not.toBeInTheDocument();
  });

  it('field_officer is bounced', () => {
    setUser('field_officer');
    renderRoute('/admin/security', <SecurityActivityCenterPage />);
    expect(screen.queryByTestId('security-activity-center-page')).not.toBeInTheDocument();
  });

  it('renders all 11 section cards in canonical brief order', () => {
    setUser('admin');
    renderRoute('/admin/security', <SecurityActivityCenterPage />);
    for (const card of SECURITY_CARDS) {
      expect(screen.getByTestId(`security-card-${card.id}`)).toBeInTheDocument();
    }
    expect(SECURITY_CARDS.map((c) => c.id)).toEqual([
      'user-visibility', 'login-security', 'device-intel', 'session-governance',
      'security-events', 'admin-monitoring', 'risk-scoring', 'response-actions',
      'reporting', 'dashboard', 'audit-integration',
    ]);
  });

  it('legacy-URL panel renders', () => {
    setUser('admin');
    renderRoute('/admin/security', <SecurityActivityCenterPage />);
    expect(screen.getByTestId('security-legacy-links')).toBeInTheDocument();
  });

  it('risk panel + top-admins panel both present', () => {
    setUser('admin');
    renderRoute('/admin/security', <SecurityActivityCenterPage />);
    expect(screen.getByTestId('security-risk-panel')).toBeInTheDocument();
    expect(screen.getByTestId('security-top-admins-panel')).toBeInTheDocument();
  });
});

describe('securityRiskScoring — closed enum', () => {
  it('ALL_SECURITY_RISK_LEVELS has the canonical 4 values', () => {
    expect(ALL_SECURITY_RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('exports tunable thresholds', () => {
    expect(SECURITY_RISK_THRESHOLDS.FAILED_LOGIN_THRESHOLD).toBe(3);
    expect(SECURITY_RISK_THRESHOLDS.BULK_MUTATION_THRESHOLD).toBe(5);
    expect(SECURITY_RISK_THRESHOLDS.REPEATED_DENIAL_THRESHOLD).toBe(2);
  });
});

describe('computeRiskScoreForActor', () => {
  it('returns low + zero score for an actor with no events', () => {
    const score = computeRiskScoreForActor('zero.actor', [], []);
    expect(score.level).toBe('low');
    expect(score.total_score).toBe(0);
    expect(score.event_count).toBe(0);
    expect(score.last_event_at).toBeNull();
  });

  it('flags multiple failed logins (>=3) → +2 weight', () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      evt({ type: 'login_failure', id: `f${i}`, actor_username: 'mal.user' }),
    );
    const score = computeRiskScoreForActor('mal.user', events, []);
    expect(score.factors.find((f) => f.id === 'failed_logins')?.triggered).toBe(true);
    expect(score.total_score).toBeGreaterThanOrEqual(2);
  });

  it('flags unusual location (≥2 distinct IPs)', () => {
    const events = [evt({ actor_username: 'roaming.user' })];
    const sessions = [
      sess({ user_id: 'roaming.user', ip: '10.0.0.1', id: 's1' }),
      sess({ user_id: 'roaming.user', ip: '192.168.1.50', id: 's2' }),
    ];
    const score = computeRiskScoreForActor('roaming.user', events, sessions);
    expect(score.factors.find((f) => f.id === 'unusual_location')?.triggered).toBe(true);
  });

  it('does NOT flag unusual location with single IP', () => {
    const events = [evt({ actor_username: 'stable.user' })];
    const sessions = [
      sess({ user_id: 'stable.user', ip: '10.0.0.1', id: 's1' }),
      sess({ user_id: 'stable.user', ip: '10.0.0.1', id: 's2' }),
    ];
    const score = computeRiskScoreForActor('stable.user', events, sessions);
    expect(score.factors.find((f) => f.id === 'unusual_location')?.triggered).toBe(false);
  });

  it('flags role change (privileged) → +2', () => {
    const events = [evt({ type: 'user_role_changed', actor_username: 'admin.user' })];
    const score = computeRiskScoreForActor('admin.user', events, []);
    expect(score.factors.find((f) => f.id === 'role_change')?.triggered).toBe(true);
  });

  it('flags bulk mutations (>=5) → +1', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      evt({ type: 'user_created', id: `c${i}`, actor_username: 'bulk.user' }),
    );
    const score = computeRiskScoreForActor('bulk.user', events, []);
    expect(score.factors.find((f) => f.id === 'bulk_modifications')?.triggered).toBe(true);
  });

  it('flags repeated denials (>=2 lockouts) → +2', () => {
    const events = [
      evt({ type: 'login_locked', actor_username: 'denied.user', id: 'd1' }),
      evt({ type: 'auto_lockout_triggered', actor_username: 'denied.user', id: 'd2' }),
    ];
    const score = computeRiskScoreForActor('denied.user', events, []);
    expect(score.factors.find((f) => f.id === 'repeated_denials')?.triggered).toBe(true);
  });

  it('escalates to critical when all 5 factors trigger', () => {
    const events: AuthAuditEvent[] = [
      ...Array.from({ length: 3 }, (_, i) => evt({ type: 'login_failure', id: `f${i}`, actor_username: 'omni.bad' })),
      evt({ type: 'user_role_changed', actor_username: 'omni.bad', id: 'r' }),
      ...Array.from({ length: 5 }, (_, i) => evt({ type: 'user_created', id: `c${i}`, actor_username: 'omni.bad' })),
      ...Array.from({ length: 2 }, (_, i) => evt({ type: 'login_locked', id: `l${i}`, actor_username: 'omni.bad' })),
    ];
    const sessions = [
      sess({ user_id: 'omni.bad', ip: '1.1.1.1', id: 'a' }),
      sess({ user_id: 'omni.bad', ip: '2.2.2.2', id: 'b' }),
    ];
    const score = computeRiskScoreForActor('omni.bad', events, sessions);
    expect(score.level).toBe('critical');
    expect(score.total_score).toBe(8);
  });
});

describe('rollupActorRiskScores', () => {
  it('returns empty array on empty input', () => {
    expect(rollupActorRiskScores([], [])).toEqual([]);
  });

  it('deduplicates actors across events', () => {
    const events = [
      evt({ actor_username: 'alice', id: 'e1' }),
      evt({ actor_username: 'alice', id: 'e2' }),
      evt({ actor_username: 'bob', id: 'e3' }),
    ];
    const scores = rollupActorRiskScores(events, []);
    expect(scores).toHaveLength(2);
  });

  it('sorts by score desc, recent activity desc, username asc', () => {
    const now = Date.now();
    const events = [
      // alice: 3 failed logins → score >= 2 (medium)
      ...Array.from({ length: 3 }, (_, i) => evt({
        type: 'login_failure',
        actor_username: 'alice',
        id: `a${i}`,
        ts: new Date(now - 10_000).toISOString(),
      })),
      // bob: 0 failures → score 0 (low)
      evt({ actor_username: 'bob', id: 'b', ts: new Date(now).toISOString() }),
    ];
    const scores = rollupActorRiskScores(events, []);
    expect(scores[0]?.actor_username).toBe('alice');
    expect(scores[1]?.actor_username).toBe('bob');
  });
});

describe('summarizeSecurityActivity', () => {
  it('returns zero counts on empty input', () => {
    const s = summarizeSecurityActivity([], []);
    expect(s.total_events).toBe(0);
    expect(s.failed_logins).toBe(0);
    expect(s.suspicious_actors).toBe(0);
  });

  it('counts failed_logins from login_failure + login_rate_limited', () => {
    const events = [
      evt({ type: 'login_failure', actor_username: 'a' }),
      evt({ type: 'login_rate_limited', actor_username: 'b' }),
      evt({ type: 'login_success', actor_username: 'c' }),
    ];
    const s = summarizeSecurityActivity(events, []);
    expect(s.failed_logins).toBe(2);
    expect(s.successful_logins).toBe(1);
  });

  it('surfaces critical actors in critical_actors + suspicious_actors counts', () => {
    const events: AuthAuditEvent[] = [
      ...Array.from({ length: 3 }, (_, i) => evt({ type: 'login_failure', id: `f${i}`, actor_username: 'omni.bad' })),
      evt({ type: 'user_role_changed', actor_username: 'omni.bad', id: 'r' }),
      ...Array.from({ length: 5 }, (_, i) => evt({ type: 'user_created', id: `c${i}`, actor_username: 'omni.bad' })),
      ...Array.from({ length: 2 }, (_, i) => evt({ type: 'login_locked', id: `l${i}`, actor_username: 'omni.bad' })),
    ];
    const sessions = [
      sess({ user_id: 'omni.bad', ip: '1.1.1.1', id: 'a' }),
      sess({ user_id: 'omni.bad', ip: '2.2.2.2', id: 'b' }),
    ];
    const s = summarizeSecurityActivity(events, sessions);
    expect(s.critical_actors).toBe(1);
    expect(s.suspicious_actors).toBeGreaterThanOrEqual(1);
  });
});
