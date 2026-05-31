// web/src/modules/admin/security/SecurityActivityCenterPage.tsx
//
// Enterprise Security Activity Center.
//
// Same proven additive-overlay pattern (6th this week after Rule / Audit /
// AI Governance / IAM / Governance Centers). Transforms Admin Activity
// into a centralised operational security monitoring center with:
//
//   • Dashboard KPI strip (§10)         — Active users / sessions / failed
//                                          logins / suspicious / locked /
//                                          top active admins
//   • Risk-scored actor leaderboard (§7) — 4-level (low/medium/high/critical)
//                                          per actor with 5 factor signals
//   • 11 sub-section cards               — each links to the existing
//                                          surface that already covers it
//
// Zero new BFF route, zero duplicate audit storage. Reuses adminAuditLog()
// + adminListSessions() + the AuthEventType closed enum.

import { Navigate, Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  KeyRound,
  Monitor,
  AlertTriangle,
  Shield,
  ScrollText,
  Gauge,
  Zap,
  Download,
  LayoutDashboard,
  ShieldCheck,
  ArrowRight,
} from 'lucide-react';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import type { LucideIcon } from 'lucide-react';
import {
  rollupActorRiskScores,
  summarizeSecurityActivity,
  type SecurityRiskLevel,
} from './securityRiskScoring';

interface SecurityCard {
  id:
    | 'user-visibility'
    | 'login-security'
    | 'device-intel'
    | 'session-governance'
    | 'security-events'
    | 'admin-monitoring'
    | 'risk-scoring'
    | 'response-actions'
    | 'reporting'
    | 'dashboard'
    | 'audit-integration';
  label: string;
  description: string;
  to: string;
  legacyTo: string | null;
  icon: LucideIcon;
  tone: 'blue' | 'success' | 'warning' | 'danger' | 'neutral';
  reuses: string;
}

const SECURITY_CARDS: readonly SecurityCard[] = [
  {
    id: 'user-visibility',
    label: 'User Activity Visibility',
    description: 'Username + role + domain + country + tenant + branch + department per active user.',
    to: '/admin/users',
    legacyTo: '/admin/users',
    icon: Users,
    tone: 'blue',
    reuses: 'AdminUsersPage + IAM Access Review',
  },
  {
    id: 'login-security',
    label: 'Login Security',
    description: 'Login / logout / last-activity / session duration with 5-state status (success / failed / locked / suspicious / expired).',
    to: '/audit-center/login-audit',
    legacyTo: '/admin/sessions',
    icon: KeyRound,
    tone: 'warning',
    reuses: 'AdminSessionsPage + AuthEventType enum',
  },
  {
    id: 'device-intel',
    label: 'Device Intelligence',
    description: 'Browser / device / OS / IP / country / timezone with known / new / suspicious classification.',
    to: '/admin/sessions',
    legacyTo: '/admin/sessions',
    icon: Monitor,
    tone: 'neutral',
    reuses: 'AdminSessionsPage (IAM F3 enrichment: browser/device/country/login_at/logout_at)',
  },
  {
    id: 'session-governance',
    label: 'Session Governance',
    description: 'Active / concurrent / history with force-logout + logout-all + terminate actions.',
    to: '/admin/iam',
    legacyTo: '/admin/sessions',
    icon: Shield,
    tone: 'success',
    reuses: 'IAM Center Session Governance + AdminSessionsPage',
  },
  {
    id: 'security-events',
    label: 'Security Events',
    description: 'Failed logins / password resets / role + permission changes / suspensions / activations / tenant + domain switches.',
    to: '/admin/activity',
    legacyTo: '/admin/activity',
    icon: AlertTriangle,
    tone: 'warning',
    reuses: 'AdminActivityPage (20 AuthEventType closed enum)',
  },
  {
    id: 'admin-monitoring',
    label: 'Admin Action Monitoring',
    description: 'User CRUD / role assignment / access modification / rule edits / master-data changes / governance edits with full audit + impact scope.',
    to: '/audit-center/trail',
    legacyTo: '/admin/audit-trail',
    icon: ScrollText,
    tone: 'blue',
    reuses: 'AuditTrailPage (M15 hash-chained ledger) + IAM User Audit History',
  },
  {
    id: 'risk-scoring',
    label: 'Risk Scoring',
    description: '4-level (low / medium / high / critical) per actor via 5 factors: failed logins + unusual location + role changes + bulk mods + repeated denials.',
    to: '/admin/security',
    legacyTo: null,
    icon: Gauge,
    tone: 'danger',
    reuses: 'NEW client-side resolver over existing AuthAuditEvent + Session streams',
  },
  {
    id: 'response-actions',
    label: 'Response Actions',
    description: 'Force logout · suspend · lock · unlock · disable. All RBAC-gated and audit-logged.',
    to: '/admin/iam/lifecycle',
    legacyTo: '/admin/users',
    icon: Zap,
    tone: 'danger',
    reuses: 'IUserStore.lock/unlock + IAM Lifecycle bulk-update + sessions revoke',
  },
  {
    id: 'reporting',
    label: 'Security Reporting',
    description: 'PDF / Excel / CSV bulk export with SHA-256 manifest + pre-templated security activity / login / user-access packs.',
    to: '/audit-center/export',
    legacyTo: '/audit-center/compliance',
    icon: Download,
    tone: 'blue',
    reuses: 'AuditExportPage + Audit Center Compliance Reports',
  },
  {
    id: 'dashboard',
    label: 'Security Dashboard',
    description: 'Active users · active sessions · failed logins · suspicious activities · locked accounts · top active admins.',
    to: '/admin/security',
    legacyTo: null,
    icon: LayoutDashboard,
    tone: 'success',
    reuses: 'Embedded KPI strip on THIS page (see top)',
  },
  {
    id: 'audit-integration',
    label: 'Audit Integration',
    description: 'Fans out to Audit Trail (M15) + Governance Ledger + IAM Audit + Recovery Audit. Zero duplicate audit storage.',
    to: '/audit-center',
    legacyTo: '/audit-center',
    icon: ShieldCheck,
    tone: 'neutral',
    reuses: 'Audit Center + M15 hash-chain (existing fan-out via PgAuthAuditLog bridge)',
  },
] as const;

const RISK_TONE: Record<SecurityRiskLevel, 'success' | 'warning' | 'danger' | 'neutral'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};

export function SecurityActivityCenterPage() {
  const me = useAuth((s) => s.user);
  const adminAuditLog = useAuth((s) => s.adminAuditLog);
  const adminListSessions = useAuth((s) => s.adminListSessions);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  const eventsQ = useQuery({ queryKey: ['security.audit'], queryFn: () => adminAuditLog() });
  const sessionsQ = useQuery({ queryKey: ['security.sessions'], queryFn: () => adminListSessions() });

  const events = eventsQ.data ?? [];
  // adminListSessions returns `{sessions: AdminSessionRow[], total: number}` —
  // peel the envelope before passing into the SessionRow-typed resolvers.
  const sessions = sessionsQ.data?.sessions ?? [];

  const summary = useMemo(() => summarizeSecurityActivity(events, sessions), [events, sessions]);
  const riskScores = useMemo(() => rollupActorRiskScores(events, sessions), [events, sessions]);
  const topAdmins = useMemo(() => {
    const byActor = new Map<string, number>();
    for (const e of events) {
      if (!e.actor_username) continue;
      byActor.set(e.actor_username, (byActor.get(e.actor_username) ?? 0) + 1);
    }
    return [...byActor.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5);
  }, [events]);

  const activeSessions = sessions.filter((s) => !s.revoked).length;

  return (
    <div data-testid="security-activity-center-page">
      <PageHeader
        title="Security Activity Center"
        subtitle="Operational security monitoring — 11 sections layered over the existing Admin Activity / Audit Trail / IAM / Sessions surface."
      />

      <Panel className="mb-4">
        <div className="flex items-center gap-3 text-sm text-ink">
          <ShieldCheck size={18} className="text-action shrink-0" />
          <div>
            <div className="font-medium">Layered security view — zero duplicate audit storage.</div>
            <p className="text-muted text-xs mt-0.5">
              Every legacy URL still works (/admin/activity, /admin/sessions, /admin/audit-trail,
              /admin/audit-log, /admin/users, /admin/iam, /audit-center/*). This page reuses the
              M15 hash-chain + IAM audit + governance ledger + recovery audit — additive
              navigation + risk scoring only.
            </p>
          </div>
        </div>
      </Panel>

      {/* §10 Dashboard widgets */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4" data-testid="security-dashboard-kpis">
        <MetricCard label="Active users" value={String(summary.total_actors)} testId="security-kpi-active-users" />
        <MetricCard label="Active sessions" value={String(activeSessions)} testId="security-kpi-active-sessions" />
        <MetricCard
          label="Failed logins"
          value={String(summary.failed_logins)}
          tone={summary.failed_logins > 0 ? 'warning' : 'neutral'}
          testId="security-kpi-failed-logins"
        />
        <MetricCard
          label="Suspicious actors"
          value={String(summary.suspicious_actors)}
          tone={summary.suspicious_actors > 0 ? 'danger' : 'neutral'}
          testId="security-kpi-suspicious"
        />
        <MetricCard
          label="Locked accounts"
          value={String(summary.locked_accounts)}
          tone={summary.locked_accounts > 0 ? 'warning' : 'neutral'}
          testId="security-kpi-locked"
        />
        <MetricCard
          label="Critical risk actors"
          value={String(summary.critical_actors)}
          tone={summary.critical_actors > 0 ? 'danger' : 'neutral'}
          testId="security-kpi-critical"
        />
      </div>

      {/* §7 Risk-scored actor leaderboard */}
      <Panel className="mb-4" title="Top risk-scored actors (last window)" data-testid="security-risk-panel">
        {eventsQ.isLoading ? (
          <p className="text-sm text-muted">Loading risk signals…</p>
        ) : riskScores.length === 0 ? (
          <p className="text-sm text-muted flex items-center gap-2">
            <Gauge size={14} /> No security activity in the current window.
          </p>
        ) : (
          <ul className="text-[12px] divide-y divide-divider" data-testid="security-risk-list">
            {riskScores.slice(0, 8).map((r) => {
              const triggered = r.factors.filter((f) => f.triggered);
              return (
                <li
                  key={r.actor_username}
                  className="py-2 flex flex-wrap items-center justify-between gap-2"
                  data-testid={`security-risk-row-${r.actor_username}`}
                >
                  <div>
                    <div className="font-medium text-ink flex items-center gap-2">
                      {r.actor_username}
                      <Badge tone={RISK_TONE[r.level]}>{r.level.toUpperCase()}</Badge>
                      <span className="text-[10.5px] text-muted">score {r.total_score}</span>
                    </div>
                    {triggered.length > 0 && (
                      <div className="text-[11px] text-muted mt-0.5">
                        Triggers: {triggered.map((f) => f.label).join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="text-[10.5px] text-muted">
                    {r.event_count} event{r.event_count === 1 ? '' : 's'}{' '}
                    {r.last_event_at && `· last ${new Date(r.last_event_at).toISOString().slice(0, 19).replace('T', ' ')}`}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* §10 (cont) Top active admins */}
      <Panel className="mb-4" title="Top active admins" data-testid="security-top-admins-panel">
        {topAdmins.length === 0 ? (
          <p className="text-sm text-muted">No admin actions observed yet.</p>
        ) : (
          <ul className="text-[12px] divide-y divide-divider" data-testid="security-top-admins-list">
            {topAdmins.map(([username, count]) => (
              <li key={username} className="py-1.5 flex items-center justify-between">
                <span className="font-medium text-ink">{username}</span>
                <Badge tone="blue">{count} action{count === 1 ? '' : 's'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 11 sub-section cards */}
      <Panel title="Security workflows" className="mb-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="security-sections">
          {SECURITY_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <Link
                key={card.id}
                to={card.to}
                className="block group"
                data-testid={`security-card-${card.id}`}
              >
                <Panel className="hover:border-action transition-colors h-full">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center">
                      <Icon size={18} className="text-aurora-indigo" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-display text-[14px] font-semibold text-ink flex items-center gap-2">
                        {card.label}
                        <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity text-action" />
                      </h3>
                      <p className="text-[11.5px] text-muted mt-0.5 leading-snug">{card.description}</p>
                      <div className="mt-2 flex items-center gap-2 text-[11px]">
                        <Badge tone={card.tone}>reuses {card.reuses}</Badge>
                      </div>
                    </div>
                  </div>
                </Panel>
              </Link>
            );
          })}
        </div>
      </Panel>

      <Panel title="Backwards compatibility">
        <p className="caption">
          Every existing audit / activity / session URL keeps working. The Security Activity
          Center is purely additive — one new landing page + a client-side risk-scoring resolver
          over existing audit + session streams. Zero new BFF route, zero duplicate audit storage.
        </p>
        <ul className="caption mt-2 space-y-0.5" data-testid="security-legacy-links">
          {SECURITY_CARDS.map((card) => (
            <li key={card.id} className="text-xs">
              <span className="text-ink font-medium">{card.label}</span>:{' '}
              <Link to={card.to} className="text-action underline-offset-2 hover:underline">
                {card.to}
              </Link>
              {card.legacyTo && card.legacyTo !== card.to && (
                <>
                  {' '}↔{' '}
                  <Link to={card.legacyTo} className="text-muted underline-offset-2 hover:underline">
                    {card.legacyTo}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

export { SECURITY_CARDS };
