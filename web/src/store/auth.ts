import { create } from 'zustand';
import { http } from '@/lib/http';

// Mirrors services/auth-svc/src/users.ts → Role
export type Role =
  | 'admin'
  | 'risk_analyst'
  | 'supervisor'
  | 'collection_officer'
  | 'field_officer';

export interface AuthUser {
  id: string;
  username: string;
  roles: Role[];
  /** True when the backend has flagged the account for first-login
   *  password rotation. The router redirects to /first-login while this
   *  is set so the rest of the app stays inaccessible. */
  must_change_password?: boolean;
  /** ISO timestamp of T&C acceptance, or null when never accepted. */
  terms_accepted_at?: string | null;
  display_name?: string;
}

export type AuthStatus = 'idle' | 'authenticating' | 'authenticated' | 'error';

/** Phase 9 T8 — extended admin-collected profile / contact / address
 *  sections. All optional + soft-validated at the auth-svc end. Mirrors
 *  services/auth-svc/src/users.ts → UserProfileExtras. */
export type UserGender = 'male' | 'female' | 'other' | 'prefer_not_to_say';
export type EmploymentType = 'Permanent' | 'Contract' | 'Intern' | 'Consultant';

export interface UserProfileExtras {
  profile?: {
    date_of_birth?: string;
    gender?: UserGender;
    joining_date?: string;
    employment_type?: EmploymentType;
    reporting_manager?: string;
    secondary_skills?: string;
  };
  contact?: {
    alternate_email?: string;
    secondary_mobile?: string;
    emergency_contact_name?: string;
    emergency_contact_phone?: string;
  };
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    country?: string;
    postal_code?: string;
  };
}

export interface SignupInput {
  username: string;
  email: string;
  password: string;
  display_name: string;
  role: Role;
  /** Phase 9 T8 — optional. Only the admin-create flow populates this;
   *  self-signup keeps the existing minimal shape. */
  extras?: UserProfileExtras;
}

export interface SignupResult {
  user: { id: string; username: string; email: string; role: Role; display_name: string };
}

export interface PasswordResetRequestResult {
  ok: boolean;
  message: string;
  /** Test/dev only: present when AUTH_SVC_DEBUG_TOKENS=1 on the backend
   *  (or the MSW mock chooses to surface it). Lets the SPA show the
   *  reset link inline in MSW mode where there is no log file. */
  debug?: { token: string; reset_link: string; expires_at: string };
}

export interface PasswordResetConfirmResult {
  ok: boolean;
  username: string;
  message: string;
}

export interface AdminUserRow {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: Role;
  locked: boolean;
}

/** Mirror of services/auth-svc/src/sessions.ts → SessionView. */
export interface SessionRow {
  id: string;
  user_id: string;
  issued_at: string;
  last_seen_at: string;
  ip: string;
  user_agent: string;
  is_current?: boolean;
}

/** Phase 9 T2 — admin session governance: row decorated with user metadata
 *  + revoked flag so the SPA can render "alice.admin (admin) — sid-XXX —
 *  revoked 2026-05-29" without an N+1 join. */
export interface AdminSessionRow extends SessionRow {
  username: string | null;
  role: string | null;
  tenant_id: string | null;
  revoked: boolean;
}

export type AdminSessionStatus = 'active' | 'revoked' | 'all';

/** Mirror of services/auth-svc/src/audit_log.ts → AuthEventType. */
export type AuthEventType =
  | 'login_success'
  | 'login_failure'
  | 'login_rate_limited'
  | 'login_locked'
  | 'auto_lockout_triggered'
  | 'auto_lockout_released'
  | 'password_reset_request'
  | 'password_reset_request_unknown'
  | 'password_reset_request_rate_limited'
  | 'password_reset_complete'
  | 'admin_password_reset'
  | 'user_created'
  | 'user_deleted'
  | 'user_locked'
  | 'user_unlocked'
  /** Phase 9 T1-partial — admin lifecycle actions */
  | 'user_disabled'
  | 'user_enabled'
  | 'user_force_logout'
  /** M6.1 — admin changes a user's role */
  | 'user_role_changed'
  | 'register_success';

export interface AuthAuditEvent {
  id: string;
  ts: string;
  type: AuthEventType;
  target_username: string | null;
  actor_username: string | null;
  actor_role: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditLogQuery {
  type?: AuthEventType;
  target_username?: string;
  limit?: number;
}

/** Mirror of services/auth-svc/src/captcha.ts → CaptchaChallenge. */
export interface CaptchaChallenge {
  id: string;
  question: string;
  expires_at: string;
}

/** Optional CAPTCHA payload threaded into login() when the backend has
 *  asked for it. Both fields must be present together. */
export interface LoginCaptcha {
  id: string;
  answer: number;
}

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  token: string | null;
  login: (username: string, password: string, captcha?: LoginCaptcha) => Promise<AuthUser>;
  /** Anonymous: fetches a fresh math captcha from auth-svc. */
  fetchCaptcha: () => Promise<CaptchaChallenge>;
  signup: (input: SignupInput) => Promise<SignupResult>;
  /** Accepts either a username or an email — auto-detected by '@'. */
  requestPasswordReset: (usernameOrEmail: string) => Promise<PasswordResetRequestResult>;
  confirmPasswordReset: (token: string, password: string) => Promise<PasswordResetConfirmResult>;
  adminListUsers: () => Promise<AdminUserRow[]>;
  adminResetPassword: (username: string, newPassword: string) => Promise<void>;
  adminCreateUser: (input: SignupInput) => Promise<SignupResult>;
  adminDeleteUser: (username: string) => Promise<void>;
  adminSetLocked: (username: string, locked: boolean) => Promise<void>;
  /** Phase 9 T1 — admin disables a user. Backed by the same setLocked
   *  primitive as adminSetLocked, but emits the DISTINCT user_disabled
   *  audit event so compliance can tell "admin suspended this account"
   *  from "system locked after N failed logins". Optional reason is
   *  captured in the audit metadata. */
  adminDisableUser: (username: string, reason?: string) => Promise<{ locked: boolean }>;
  /** Phase 9 T1 — admin re-enables a previously disabled user. Audit
   *  type user_enabled. No self-guard (re-enabling yourself is harmless). */
  adminEnableUser: (username: string) => Promise<{ locked: boolean }>;
  /** Phase 9 T1 — admin force-logs-out every session for a user (e.g.
   *  on suspected credential exposure). Does NOT disable the account —
   *  the user can log in again immediately with valid credentials.
   *  Returns the count of sessions revoked. */
  adminForceLogout: (username: string, reason?: string) => Promise<{ revoked_count: number }>;
  /** M6.1 — Users & RBAC: admin changes a user's role. Returns the
   *  updated row. Combined with /auth/me's live-read, the change
   *  surfaces on the user's next request without forcing a logout. */
  adminSetRole: (username: string, role: string) => Promise<{ username: string; role: string; previous_role?: string }>;
  /** Fetches active sessions for the current user. */
  listMySessions: () => Promise<{ sessions: SessionRow[]; current_session_id: string | null }>;
  /** Phase 9 T2 — admin governance: list every session across users with
   *  optional user_id + status filters. Admin only. */
  adminListSessions: (filter?: {
    user_id?: string;
    status?: AdminSessionStatus;
    limit?: number;
  }) => Promise<{ sessions: AdminSessionRow[]; total: number }>;
  /** Phase 9 T2 — admin force-revoke of one specific session (single sid).
   *  Distinct from adminForceLogout (revokes EVERY session for a user). */
  adminRevokeSession: (sid: string, reason?: string) => Promise<{ revoked_sid: string }>;
  /** Revokes one session (must be the caller's). */
  revokeSession: (sid: string) => Promise<void>;
  /** Revokes all sessions for the caller; pass `keepCurrent=true` to preserve
   *  the current device. */
  revokeOtherSessions: (keepCurrent: boolean) => Promise<{ revoked_count: number }>;
  /** Completes the first-login wizard with a new password and T&C acceptance.
   *  On success clears must_change_password locally so the router stops
   *  redirecting to /first-login. */
  completeFirstLogin: (newPassword: string) => Promise<void>;
  /** Admin-only: fetches the auth-svc audit log with optional filters. */
  adminAuditLog: (query?: AuditLogQuery) => Promise<AuthAuditEvent[]>;
  /** Self-service: fetches the caller's own auth events. Open to every
   *  signed-in role; backend forces the filter to the caller's sub. */
  myActivity: (limit?: number) => Promise<AuthAuditEvent[]>;
  /** Per-role dashboard widget config (T4.23, BAC-A §3.1.9.1.4). Open
   *  to any signed-in user — analysts call this to render their own
   *  dashboard. Returns the configured widgets sorted by sort_order;
   *  empty array means "use catalogue defaults". */
  getDashboardWidgets: (role: Role) => Promise<DashboardWidgetConfig[]>;
  /** Admin-only: replace the role's full widget layout. */
  putDashboardWidgets: (
    role: Role,
    widgets: Array<{ widget_id: string; sort_order: number; is_visible: boolean }>,
  ) => Promise<DashboardWidgetConfig[]>;
  /** Admin-only (T4.24 Phase 12): list every OAuth service-client.
   *  Optional tenant filter; omit for the platform-admin view. */
  adminListServiceClients: (tenant_id?: string) => Promise<ServiceClientRow[]>;
  /** Admin-only: create a new OAuth client_credentials principal.
   *  Returns the plaintext secret ONCE — caller must persist or display
   *  it; subsequent reads never include it. */
  adminCreateServiceClient: (input: {
    tenant_id: string;
    client_id: string;
    display_name: string;
    scopes?: string[];
  }) => Promise<ServiceClientCreated>;
  /** Admin-only: delete a service-client by composite (tenant_id, client_id). */
  adminDeleteServiceClient: (tenant_id: string, client_id: string) => Promise<void>;
  logout: () => void;
  hydrate: () => void;
}

/** Service-client view shape returned by GET /auth/service-clients. */
export interface ServiceClientRow {
  client_id: string;
  tenant_id: string;
  display_name: string;
  scopes: string[];
  active: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** Returned by POST /auth/service-clients — plaintext secret exposed
 *  exactly once (see Phase 11 contract). */
export interface ServiceClientCreated extends ServiceClientRow {
  client_secret: string;
}

export interface DashboardWidgetConfig {
  widget_id: string;
  sort_order: number;
  is_visible: boolean;
  updated_at: string;
  updated_by: string | null;
}

const TOKEN_KEY = 'apex.ews.token';
const USER_KEY = 'apex.ews.user';

// Read localStorage at store-creation time so the very first render of
// RequireAuth sees the correct status. Without this, refreshing a deep
// link like /alerts races: RequireAuth → /login → LoginPage sees the
// (now-hydrated) auth state → Navigate to "/", losing the original URL.
function readPersistedAuth(): { status: AuthStatus; user: AuthUser | null; token: string | null } {
  const fallback = { status: 'idle' as AuthStatus, user: null, token: null };
  // localStorage may be missing (SSR), a stub that throws (jsdom before the
  // setup polyfill runs), or otherwise unusable. In any of those cases we
  // start unauthenticated and let the App-level hydrate() effect retry once
  // the real localStorage is installed.
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const token = localStorage.getItem(TOKEN_KEY);
    const userRaw = localStorage.getItem(USER_KEY);
    if (!token || !userRaw) return fallback;
    try {
      const user = JSON.parse(userRaw) as AuthUser;
      return { status: 'authenticated', user, token };
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      return fallback;
    }
  } catch {
    return fallback;
  }
}

export const useAuth = create<AuthState>((set) => ({
  ...readPersistedAuth(),

  // Kept for the existing App.tsx call site and for tests that want to
  // re-read after manipulating localStorage. With the synchronous
  // initial-state read above, this is now a redundant top-up — it
  // re-applies the same logic so a logged-in user stays logged-in even
  // if hydrate() is called after a manual setState.
  hydrate: () => {
    const next = readPersistedAuth();
    if (next.status === 'authenticated') set(next);
  },

  login: async (username, password, captcha) => {
    set({ status: 'authenticating' });
    try {
      const { data } = await http.post<{
        access_token: string;
        user?: AuthUser;
        // Real auth-svc emits these top-level (not nested under `user`).
        // MSW mock + production both work here.
        must_change_password?: boolean;
        terms_accepted_at?: string | null;
        display_name?: string;
        role?: Role;
      }>('/auth/login', {
        username,
        password,
        captcha_id: captcha?.id,
        captcha_answer: captcha?.answer,
      });
      const user: AuthUser = data.user ?? {
        // Synthesize an AuthUser from the auth-svc response shape when the
        // `user` field isn't nested. id is unknown server-side here so we
        // fall back to the username; real production will key by sub.
        id: username,
        username,
        roles: data.role ? [data.role] : [],
        display_name: data.display_name,
      };
      const enriched: AuthUser = {
        ...user,
        must_change_password: data.must_change_password ?? user.must_change_password ?? false,
        terms_accepted_at: data.terms_accepted_at ?? user.terms_accepted_at ?? null,
      };
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(USER_KEY, JSON.stringify(enriched));
      set({ status: 'authenticated', token: data.access_token, user: enriched });
      return enriched;
    } catch (err) {
      set({ status: 'error' });
      throw err;
    }
  },

  signup: async (input) => {
    const { data } = await http.post<SignupResult>('/auth/register', input);
    return data;
  },

  fetchCaptcha: async () => {
    const { data } = await http.get<CaptchaChallenge>('/auth/captcha/challenge');
    return data;
  },

  requestPasswordReset: async (usernameOrEmail) => {
    // Detect whether the user typed an email or a username, and post
    // the right field. Backend accepts either; if neither is sent it 400s.
    const looksLikeEmail = usernameOrEmail.includes('@');
    const body = looksLikeEmail
      ? { email: usernameOrEmail.trim().toLowerCase() }
      : { username: usernameOrEmail.trim().toLowerCase() };
    const { data } = await http.post<PasswordResetRequestResult>(
      '/auth/password/reset-request',
      body,
    );
    return data;
  },

  confirmPasswordReset: async (token, password) => {
    const { data } = await http.post<PasswordResetConfirmResult>(
      '/auth/password/reset-confirm',
      { token, password },
    );
    return data;
  },

  adminListUsers: async () => {
    const { data } = await http.get<{ users: AdminUserRow[] }>('/auth/users');
    return data.users;
  },

  adminResetPassword: async (username, newPassword) => {
    await http.post('/auth/password/admin-reset', { username, password: newPassword });
  },

  adminCreateUser: async (input) => {
    const { data } = await http.post<SignupResult>('/auth/users', input);
    return data;
  },

  adminDeleteUser: async (username) => {
    await http.delete(`/auth/users/${encodeURIComponent(username)}`);
  },

  adminSetLocked: async (username, locked) => {
    const action = locked ? 'lock' : 'unlock';
    await http.post(`/auth/users/${encodeURIComponent(username)}/${action}`);
  },

  adminDisableUser: async (username, reason) => {
    const { data } = await http.post<{ ok: boolean; username: string; locked: boolean }>(
      `/auth/users/${encodeURIComponent(username)}/disable`,
      reason ? { reason } : {},
    );
    return { locked: data.locked };
  },

  adminEnableUser: async (username) => {
    const { data } = await http.post<{ ok: boolean; username: string; locked: boolean }>(
      `/auth/users/${encodeURIComponent(username)}/enable`,
    );
    return { locked: data.locked };
  },

  adminForceLogout: async (username, reason) => {
    const { data } = await http.post<{
      ok: boolean;
      username: string;
      revoked_count: number;
    }>(
      `/auth/users/${encodeURIComponent(username)}/force-logout`,
      reason ? { reason } : {},
    );
    return { revoked_count: data.revoked_count };
  },

  adminSetRole: async (username, role) => {
    const { data } = await http.post<{
      ok: boolean;
      username: string;
      role: string;
      previous_role?: string;
    }>(
      `/auth/users/${encodeURIComponent(username)}/role`,
      { role },
    );
    return { username: data.username, role: data.role, previous_role: data.previous_role };
  },

  adminListSessions: async (filter) => {
    const params: Record<string, string> = {};
    if (filter?.user_id) params.user_id = filter.user_id;
    if (filter?.status) params.status = filter.status;
    if (filter?.limit) params.limit = String(filter.limit);
    const { data } = await http.get<{ sessions: AdminSessionRow[]; total: number }>(
      '/auth/admin/sessions',
      { params },
    );
    return data;
  },

  adminRevokeSession: async (sid, reason) => {
    const { data } = await http.post<{ ok: boolean; revoked_sid: string }>(
      `/auth/admin/sessions/${encodeURIComponent(sid)}/revoke`,
      reason ? { reason } : {},
    );
    return { revoked_sid: data.revoked_sid };
  },

  listMySessions: async () => {
    const { data } = await http.get<{ sessions: SessionRow[]; current_session_id: string | null }>(
      '/auth/sessions',
    );
    return data;
  },

  revokeSession: async (sid: string) => {
    await http.delete(`/auth/sessions/${encodeURIComponent(sid)}`);
  },

  revokeOtherSessions: async (keepCurrent: boolean) => {
    const url = keepCurrent ? '/auth/sessions?except=current' : '/auth/sessions';
    const { data } = await http.delete<{ revoked_count: number }>(url);
    return data;
  },

  adminAuditLog: async (query) => {
    const params: Record<string, string> = {};
    if (query?.type) params.type = query.type;
    if (query?.target_username) params.target_username = query.target_username;
    if (query?.limit) params.limit = String(query.limit);
    const { data } = await http.get<{ events: AuthAuditEvent[] }>('/auth/audit-log', {
      params,
    });
    return data.events;
  },

  myActivity: async (limit) => {
    const params: Record<string, string> = {};
    if (limit) params.limit = String(limit);
    const { data } = await http.get<{ events: AuthAuditEvent[]; username: string }>(
      '/auth/me/activity',
      { params },
    );
    return data.events;
  },

  getDashboardWidgets: async (role) => {
    const { data } = await http.get<{ role: Role; widgets: DashboardWidgetConfig[] }>(
      `/auth/dashboard-widgets/${encodeURIComponent(role)}`,
    );
    return data.widgets;
  },

  putDashboardWidgets: async (role, widgets) => {
    const { data } = await http.put<{ role: Role; widgets: DashboardWidgetConfig[] }>(
      `/auth/dashboard-widgets/${encodeURIComponent(role)}`,
      { widgets },
    );
    return data.widgets;
  },

  adminListServiceClients: async (tenant_id) => {
    const url = tenant_id
      ? `/auth/service-clients?tenant_id=${encodeURIComponent(tenant_id)}`
      : '/auth/service-clients';
    const { data } = await http.get<{ items: ServiceClientRow[]; total: number }>(url);
    return data.items;
  },

  adminCreateServiceClient: async (input) => {
    const { data } = await http.post<ServiceClientCreated>('/auth/service-clients', input);
    return data;
  },

  adminDeleteServiceClient: async (tenant_id, client_id) => {
    await http.delete(
      `/auth/service-clients/${encodeURIComponent(tenant_id)}/${encodeURIComponent(client_id)}`,
    );
  },

  completeFirstLogin: async (newPassword) => {
    const { data } = await http.post<{ ok: true; terms_accepted_at: string | null }>(
      '/auth/first-login/complete',
      { new_password: newPassword, accept_terms: true },
    );
    // Lift the must_change_password flag in local state + storage so the
    // router stops redirecting. The user can finish the session without
    // a re-login round-trip.
    const current = useAuth.getState().user;
    if (current) {
      const next: AuthUser = {
        ...current,
        must_change_password: false,
        terms_accepted_at: data.terms_accepted_at,
      };
      localStorage.setItem(USER_KEY, JSON.stringify(next));
      set({ user: next });
    }
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    // Clear the 4-step onboarding state so the next sign-in walks the
    // user through country → domain → tenant selection again. Inlined
    // (rather than imported from useOnboardingContext) to avoid the
    // store taking a transitive dependency on the lib hook.
    try {
      localStorage.removeItem('zorews.country');
      localStorage.removeItem('zorews.domainChosen');
      localStorage.removeItem('zorews.tenantContext');
      window.dispatchEvent(new Event('zorews:country-changed'));
      window.dispatchEvent(new Event('zorews:tenant-context-changed'));
    } catch {
      /* best effort — private mode / SSR */
    }
    set({ status: 'idle', user: null, token: null });
  },
}));
