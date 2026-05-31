// web/src/modules/admin/security/securityRiskScoring.ts
//
// Security Activity Center — risk-scoring resolver (pure function).
//
// Composes the existing AuthAuditEvent stream into a 4-level risk verdict
// (low / medium / high / critical) per actor over a window. Composes 5
// signals per the brief:
//   • Multiple failed logins                  (>=3 in window  ⇒ +2)
//   • Unusual login location (new country)    (NEW country    ⇒ +1)
//   • Privileged role changes                 (role_changed   ⇒ +2)
//   • Bulk user modifications                 (>=5 mutations  ⇒ +1)
//   • Repeated access denials / lockouts      (>=2 lockouts   ⇒ +2)
//
// Pure — no fetch, no store. Caller passes the already-fetched audit + session
// rows. Same shape pattern as the M7.11 deployment-age bucketing.

import type { AuthAuditEvent, SessionRow } from '@/store/auth';

export type SecurityRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const ALL_SECURITY_RISK_LEVELS: readonly SecurityRiskLevel[] = [
  'low', 'medium', 'high', 'critical',
] as const;

export interface RiskFactor {
  id:
    | 'failed_logins'
    | 'unusual_location'
    | 'role_change'
    | 'bulk_modifications'
    | 'repeated_denials';
  label: string;
  weight: number;
  triggered: boolean;
  detail: string;
}

export interface SecurityRiskScore {
  actor_username: string;
  total_score: number;
  level: SecurityRiskLevel;
  factors: RiskFactor[];
  event_count: number;
  last_event_at: string | null;
}

const FAILED_LOGIN_TYPES = new Set(['login_failure', 'login_rate_limited']);
const LOCKOUT_TYPES = new Set(['login_locked', 'auto_lockout_triggered', 'user_locked']);
const MUTATION_TYPES = new Set([
  'user_created', 'user_deleted', 'user_disabled', 'user_enabled',
  'user_role_changed', 'admin_password_reset', 'user_force_logout',
]);
const PRIVILEGE_CHANGE_TYPES = new Set(['user_role_changed']);

const FAILED_LOGIN_THRESHOLD = 3;
const BULK_MUTATION_THRESHOLD = 5;
const REPEATED_DENIAL_THRESHOLD = 2;

/** Closed-enum bucketing — same boundaries as the M8.16 / M7.15 pattern. */
function bucketScore(score: number): SecurityRiskLevel {
  if (score >= 6) return 'critical';
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

export function computeRiskScoreForActor(
  actor_username: string,
  events: readonly AuthAuditEvent[],
  sessions: readonly SessionRow[] = [],
): SecurityRiskScore {
  const actorEvents = events.filter((e) => e.actor_username === actor_username);
  const actorSessions = sessions.filter((s) => s.user_id === actor_username);

  const failed = actorEvents.filter((e) => FAILED_LOGIN_TYPES.has(e.type)).length;
  const lockouts = actorEvents.filter((e) => LOCKOUT_TYPES.has(e.type)).length;
  const mutations = actorEvents.filter((e) => MUTATION_TYPES.has(e.type)).length;
  const roleChanges = actorEvents.filter((e) => PRIVILEGE_CHANGE_TYPES.has(e.type)).length;

  // Unusual location heuristic: ≥ 2 distinct IPs across this actor's session
  // sample (the SessionRow shape carries `ip`). A single-IP actor is normal;
  // multi-IP suggests credential sharing OR new device login from a different
  // network, both of which warrant a +1.
  const distinctIps = new Set(actorSessions.map((s) => s.ip).filter(Boolean));
  const unusualLocation = distinctIps.size >= 2;

  const factors: RiskFactor[] = [
    {
      id: 'failed_logins',
      label: 'Multiple failed logins',
      weight: 2,
      triggered: failed >= FAILED_LOGIN_THRESHOLD,
      detail: `${failed} failed login${failed === 1 ? '' : 's'} in window (threshold ≥ ${FAILED_LOGIN_THRESHOLD})`,
    },
    {
      id: 'unusual_location',
      label: 'Unusual login location',
      weight: 1,
      triggered: unusualLocation,
      detail: unusualLocation
        ? `${distinctIps.size} distinct IP${distinctIps.size === 1 ? '' : 's'} observed`
        : 'Single-source IP — normal',
    },
    {
      id: 'role_change',
      label: 'Privileged role change',
      weight: 2,
      triggered: roleChanges > 0,
      detail: roleChanges > 0
        ? `${roleChanges} role change${roleChanges === 1 ? '' : 's'} attributed`
        : 'No role changes',
    },
    {
      id: 'bulk_modifications',
      label: 'Bulk user modifications',
      weight: 1,
      triggered: mutations >= BULK_MUTATION_THRESHOLD,
      detail: `${mutations} mutation${mutations === 1 ? '' : 's'} in window (threshold ≥ ${BULK_MUTATION_THRESHOLD})`,
    },
    {
      id: 'repeated_denials',
      label: 'Repeated access denials / lockouts',
      weight: 2,
      triggered: lockouts >= REPEATED_DENIAL_THRESHOLD,
      detail: `${lockouts} lockout/denial event${lockouts === 1 ? '' : 's'} (threshold ≥ ${REPEATED_DENIAL_THRESHOLD})`,
    },
  ];

  const total_score = factors.reduce((acc, f) => acc + (f.triggered ? f.weight : 0), 0);

  const sorted = [...actorEvents].sort((a, b) => b.ts.localeCompare(a.ts));
  const last_event_at = sorted[0]?.ts ?? null;

  return {
    actor_username,
    total_score,
    level: bucketScore(total_score),
    factors,
    event_count: actorEvents.length,
    last_event_at,
  };
}

export function rollupActorRiskScores(
  events: readonly AuthAuditEvent[],
  sessions: readonly SessionRow[] = [],
): SecurityRiskScore[] {
  const actors = new Set<string>();
  for (const e of events) {
    if (e.actor_username) actors.add(e.actor_username);
  }
  const scored: SecurityRiskScore[] = [];
  for (const a of actors) {
    scored.push(computeRiskScoreForActor(a, events, sessions));
  }
  // Sort by score desc, then by recent activity desc, then by username asc.
  return scored.sort((a, b) => {
    if (a.total_score !== b.total_score) return b.total_score - a.total_score;
    const aTs = a.last_event_at ?? '';
    const bTs = b.last_event_at ?? '';
    if (aTs !== bTs) return bTs.localeCompare(aTs);
    return a.actor_username.localeCompare(b.actor_username);
  });
}

export interface SecurityActivitySummary {
  total_events: number;
  total_actors: number;
  failed_logins: number;
  successful_logins: number;
  locked_accounts: number;
  suspicious_actors: number; // level === 'high' || 'critical'
  critical_actors: number;
}

export function summarizeSecurityActivity(
  events: readonly AuthAuditEvent[],
  sessions: readonly SessionRow[] = [],
): SecurityActivitySummary {
  const scores = rollupActorRiskScores(events, sessions);
  return {
    total_events: events.length,
    total_actors: scores.length,
    failed_logins: events.filter((e) => FAILED_LOGIN_TYPES.has(e.type)).length,
    successful_logins: events.filter((e) => e.type === 'login_success').length,
    locked_accounts: events.filter((e) => e.type === 'user_locked' || e.type === 'auto_lockout_triggered').length,
    suspicious_actors: scores.filter((s) => s.level === 'high' || s.level === 'critical').length,
    critical_actors: scores.filter((s) => s.level === 'critical').length,
  };
}

export const SECURITY_RISK_THRESHOLDS = {
  FAILED_LOGIN_THRESHOLD,
  BULK_MUTATION_THRESHOLD,
  REPEATED_DENIAL_THRESHOLD,
} as const;
