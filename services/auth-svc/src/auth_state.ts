// services/auth-svc/src/auth_state.ts
//
// Factory + type aliases for the auth-svc backing stores. Picks between
// in-memory and Postgres-backed impls based on `AUTH_SVC_PG_URL`:
//
//   AUTH_SVC_PG_URL unset    → in-memory (the default — keeps `npm test`
//                               and the dev wizard hermetic)
//   AUTH_SVC_PG_URL = <dsn>  → PgUserStore + PgSessionStore + PgAuthAuditLog
//                               wired against app_iam.*
//
// The route layer (routes/auth.ts) talks to the union types below — both
// impls share the same method shape, so the routes don't branch on which
// backend is in play.

import { Pool } from "pg";
import { UserStore } from "./users.js";
import { SessionStore } from "./sessions.js";
import { AuthAuditLog } from "./audit_log.js";
import { PgUserStore } from "./pg_user_store.js";
import { PgSessionStore } from "./pg_session_store.js";
import { PgAuthAuditLog } from "./pg_audit_log.js";
import { InMemoryTeamStore, PgTeamStore, type ITeamStore } from "./teams.js";
import {
  InMemoryLeaveCoverStore,
  PgLeaveCoverStore,
  type ILeaveCoverStore,
} from "./leave_covers.js";
import {
  InMemoryDashboardWidgetsStore,
  PgDashboardWidgetsStore,
  type IDashboardWidgetsStore,
} from "./dashboard_widgets.js";

export type IUserStore = UserStore | PgUserStore;
export type ISessionStore = SessionStore | PgSessionStore;
export type IAuthAuditLog = AuthAuditLog | PgAuthAuditLog;

export interface AuthStores {
  users: IUserStore;
  sessions: ISessionStore;
  audit: IAuthAuditLog;
  /** Issue Owner Groups + branch teams (T4.21, BAC-A §3.1.7.1.5). */
  teams: ITeamStore;
  /** Leave-cover delegations (T4.22, BAC-A §3.1.9.1.3). */
  leaveCovers: ILeaveCoverStore;
  /** Per-role dashboard widget visibility + ordering (T4.23, BAC-A §3.1.9.1.4). */
  dashboardWidgets: IDashboardWidgetsStore;
  /** Set when the pg backend is in use; null otherwise. Exposed so tests
   *  and process-shutdown hooks can call .end(). */
  pool: Pool | null;
}

/**
 * Build the auth-svc backing stores based on env. When `AUTH_SVC_PG_URL`
 * is set, returns Pg-backed impls and runs init() on each. Otherwise
 * returns in-memory impls + seeds the demo accounts.
 */
export async function makeAuthStores(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthStores> {
  const url = env.AUTH_SVC_PG_URL;
  if (!url) {
    const users = new UserStore();
    await users.seed();
    return {
      users,
      sessions: new SessionStore(),
      audit: new AuthAuditLog(),
      teams: new InMemoryTeamStore(),
      leaveCovers: new InMemoryLeaveCoverStore(),
      dashboardWidgets: new InMemoryDashboardWidgetsStore(),
      pool: null,
    };
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  const users = new PgUserStore(pool);
  const sessions = new PgSessionStore(pool);
  const audit = new PgAuthAuditLog(pool);
  const teams = new PgTeamStore(pool);
  const leaveCovers = new PgLeaveCoverStore(pool);
  const dashboardWidgets = new PgDashboardWidgetsStore(pool);
  await users.init();
  await sessions.init();
  await audit.init();
  await teams.init();
  await leaveCovers.init();
  await dashboardWidgets.init();
  return { users, sessions, audit, teams, leaveCovers, dashboardWidgets, pool };
}

export { PgUserStore, PgSessionStore, PgAuthAuditLog };
