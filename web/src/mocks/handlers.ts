import { http, HttpResponse } from 'msw';
import {
  DEMO_USERS,
  alerts,
  caseDetails,
  caseSummariesFrom,
  customers,
  dashboardSummary,
  rules,
  type DemoUser,
} from './data';
import type {
  CaseActionKind,
  CaseDetail,
  CaseOutcome,
  CaseState,
  Severity,
} from '@/lib/api';
import { computeScore, dedupByCustomer, sortBy } from '@/lib/criticality';

// Mock state machine — mirrors services/regulatory-svc/cases/src/state_machine.ts.
// Returning null signals an illegal transition (handler responds with 409).
type Transition = 'assign' | 'logAction' | 'monitor' | 'close';
const TRANSITIONS: Record<CaseState, Partial<Record<Transition, CaseState>>> = {
  open: { assign: 'assigned', close: 'closed' },
  assigned: { logAction: 'in_action', close: 'closed' },
  in_action: { logAction: 'in_action', monitor: 'monitored', close: 'closed' },
  monitored: { logAction: 'in_action', close: 'closed' },
  closed: {},
};
const VALID_KINDS: CaseActionKind[] = ['call', 'visit', 'sms', 'email', 'note'];
const VALID_OUTCOMES: CaseOutcome[] = ['cured', 'cured_temp', 'defaulted'];

function findCase(id: string): CaseDetail | undefined {
  return caseDetails.find((c) => c.id === id);
}

function applyTransition(c: CaseDetail, t: Transition): CaseState | null {
  return TRANSITIONS[c.state][t] ?? null;
}

// Module-scoped reset-token store for the password-reset MSW flow.
const _resetTokens = new Map<string, { userId: string; expiresAtMs: number }>();

// Per-(IP+username) failure counter for the captcha gate. The mock
// can't see the real client IP, so we use just the username as the key
// — close enough for the SPA-side flow.
const _captchaFailures = new Map<string, number>();
// Issued captcha challenges, single-use, 5-min TTL.
const _captchaChallenges = new Map<string, { answer: number; expires_at_ms: number }>();
const CAPTCHA_THRESHOLD = 2;

// In-memory session list for the MSW mock backend. Mirrors auth-svc's
// SessionStore but flat — keyed only by id, since the only operations the
// SPA performs are "list mine" + "revoke one" + "revoke others".
interface MockSession {
  id: string;
  user_id: string;
  issued_at: string;
  last_seen_at: string;
  ip: string;
  user_agent: string;
  is_current: boolean;
}
const _mockSessions: MockSession[] = [];

// In-memory webhook subscriptions for the SPA's admin page. Mirrors the
// BFF's WebhookSubscriptionStore shape but without the actual outbound
// dispatcher — MSW dev mode has no external recipients to call, so the
// "test fire" handler just synthesises a successful delivery row.
interface MockWebhookSub {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  created_at: string;
  last_delivery_at: string | null;
  last_delivery_status: 'success' | 'failed' | null;
}
interface MockWebhookDelivery {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  status: 'success' | 'failed';
  response_status: number;
  response_body?: string;
  created_at: string;
  completed_at: string;
}
const _mockWebhookSubs: MockWebhookSub[] = [];
const _mockWebhookDeliveries: MockWebhookDelivery[] = [];
const _validWebhookEvents = [
  'alert.created',
  'alert.updated',
  'case.assigned',
  'case.closed',
  'scenario.run',
  'webhook.test',
];

// ── Tenants + service-clients (T4.24 Phase 12) ──────────────────────────
//
// Mirror the BFF tenant registry + auth-svc service-client store. The
// /v1/tenants handlers wrap responses in the bank-grade envelope to match
// production BFF; the /auth/service-clients handlers return raw shape to
// match auth-svc (which doesn't envelope).

interface MockTenant {
  tenant_id: string;
  name: string;
  vertical: 'banking' | 'insurance';
  channels_allowed: string[];
  active: boolean;
}
const _mockTenants: MockTenant[] = [
  {
    tenant_id: 'BANK_DEMO',
    name: 'APEX Bank (demo)',
    vertical: 'banking',
    channels_allowed: ['LOS', 'MOBILE', 'BRANCH', 'API'],
    active: true,
  },
  {
    tenant_id: 'BIL',
    name: 'Bhutan Insurance Limited',
    vertical: 'insurance',
    channels_allowed: ['BRANCH', 'AGENT_PORTAL', 'API'],
    active: true,
  },
];
const _SYSTEM_TENANTS = new Set(['BANK_DEMO']);

interface MockServiceClient {
  client_id: string;
  tenant_id: string;
  display_name: string;
  scopes: string[];
  active: boolean;
  created_at: string;
  last_used_at: string | null;
  // Stored only for the test-fire / round-trip scenarios; never returned.
  client_secret_plaintext?: string;
}
const _mockServiceClients: MockServiceClient[] = [
  {
    client_id: 'apex-mobile-bank-demo',
    tenant_id: 'BANK_DEMO',
    display_name: 'APEX Mobile (BANK_DEMO)',
    scopes: [],
    active: true,
    created_at: '2026-05-03T00:00:00.000Z',
    last_used_at: null,
  },
  {
    client_id: 'bil-los-stub',
    tenant_id: 'BIL',
    display_name: 'BIL LOS stub (BIL)',
    scopes: [],
    active: true,
    created_at: '2026-05-03T00:00:00.000Z',
    last_used_at: null,
  },
];

// ── User Access Override (BAC §3.1.6/§3.1.7) — MSW state ─────────────

interface MswOverride {
  override_id: string; tenant_id: string; user_id: string; module_path: string;
  override_type: 'GRANT' | 'REVOKE';
  permission_type: 'VIEW' | 'EDIT' | 'APPROVE' | 'FULL';
  effective_from: string; effective_till: string | null; reason: string;
  requires_approval: boolean;
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
  created_by: string; approved_by: string | null; rejected_by: string | null; revoked_by: string | null;
  rejection_reason: string | null; revocation_reason: string | null; approval_note: string | null;
  created_at: string; updated_at: string;
  approved_at: string | null; rejected_at: string | null; revoked_at: string | null;
}
interface MswOverrideAudit {
  audit_id: string; tenant_id: string;
  entity_type: 'user_access_override'; entity_id: string;
  action: 'create' | 'update' | 'approve' | 'reject' | 'revoke' | 'expire';
  actor_id: string; actor_role: string;
  before_state: unknown | null; after_state: unknown | null;
  reason: string | null;
  request_id: string | null; ip_address: string | null; user_agent: string | null;
  created_at: string;
}
interface MswCreateInput {
  user_id: string;
  module_paths: string[];
  override_type?: 'GRANT' | 'REVOKE';
  permission_type?: 'VIEW' | 'EDIT' | 'APPROVE' | 'FULL';
  effective_from?: string;
  effective_till?: string | null;
  reason: string;
  requires_approval?: boolean;
}
const mswOverrides: MswOverride[] = [
  {
    override_id: 'ov-seed-1',
    tenant_id: 'BANK_DEMO',
    user_id: 'u-002',
    module_path: 'admin.audit-log',
    override_type: 'GRANT',
    permission_type: 'VIEW',
    effective_from: '2026-05-01T00:00:00Z',
    effective_till: '2026-08-01T00:00:00Z',
    reason: 'Q2 audit support — temporary read access',
    requires_approval: true,
    status: 'ACTIVE',
    created_by: 'alice.admin',
    approved_by: 'sue.super',
    rejected_by: null,
    revoked_by: null,
    rejection_reason: null,
    revocation_reason: null,
    approval_note: 'Reviewed scope, approved',
    created_at: '2026-05-01T08:00:00Z',
    updated_at: '2026-05-01T09:00:00Z',
    approved_at: '2026-05-01T09:00:00Z',
    rejected_at: null,
    revoked_at: null,
  },
  {
    override_id: 'ov-seed-2',
    tenant_id: 'BANK_DEMO',
    user_id: 'u-004',
    module_path: 'cases.detail',
    override_type: 'GRANT',
    permission_type: 'EDIT',
    effective_from: '2026-05-06T00:00:00Z',
    effective_till: null,
    reason: 'Field officer needs case-edit on follow-up customers',
    requires_approval: true,
    status: 'PENDING_APPROVAL',
    created_by: 'alice.admin',
    approved_by: null,
    rejected_by: null,
    revoked_by: null,
    rejection_reason: null,
    revocation_reason: null,
    approval_note: null,
    created_at: '2026-05-06T11:00:00Z',
    updated_at: '2026-05-06T11:00:00Z',
    approved_at: null,
    rejected_at: null,
    revoked_at: null,
  },
];
const mswOverrideAudit: MswOverrideAudit[] = [
  {
    audit_id: 'aud-seed-1',
    tenant_id: 'BANK_DEMO',
    entity_type: 'user_access_override',
    entity_id: 'ov-seed-1',
    action: 'create',
    actor_id: 'alice.admin',
    actor_role: 'admin',
    before_state: null,
    after_state: { override_id: 'ov-seed-1', status: 'PENDING_APPROVAL' },
    reason: 'Q2 audit support — temporary read access',
    request_id: null,
    ip_address: null,
    user_agent: null,
    created_at: '2026-05-01T08:00:00Z',
  },
  {
    audit_id: 'aud-seed-2',
    tenant_id: 'BANK_DEMO',
    entity_type: 'user_access_override',
    entity_id: 'ov-seed-1',
    action: 'approve',
    actor_id: 'sue.super',
    actor_role: 'admin',
    before_state: { override_id: 'ov-seed-1', status: 'PENDING_APPROVAL' },
    after_state: { override_id: 'ov-seed-1', status: 'ACTIVE' },
    reason: 'Reviewed scope, approved',
    request_id: null,
    ip_address: null,
    user_agent: null,
    created_at: '2026-05-01T09:00:00Z',
  },
];

/** Mirror the BFF role_access.ts ACL — used by the offline effective-access mock. */
function mswMockRoleAcl(userId: string): { roles: string[]; modules: { module_path: string; permissions: string[]; source: string }[] } {
  const roles = userId.includes('admin')   ? ['admin']
              : userId.includes('super')   ? ['supervisor']
              : userId.includes('risk')    ? ['risk_analyst']
              : userId.includes('collect') ? ['collection_officer']
              : userId.includes('field')   ? ['field_officer']
              : ['risk_analyst'];
  const adminAcl: Record<string, string[]> = {
    'dashboard': ['VIEW'], 'alerts': ['VIEW','EDIT','APPROVE'], 'alerts.detail': ['VIEW','EDIT'],
    'customers': ['VIEW'], 'customers.detail': ['VIEW'],
    'rules': ['VIEW','EDIT','APPROVE','FULL'], 'rules.detail': ['VIEW','EDIT','APPROVE','FULL'],
    'cases': ['VIEW','EDIT','APPROVE'], 'cases.detail': ['VIEW','EDIT','APPROVE'],
    'cases.cms': ['VIEW','EDIT','APPROVE'], 'scenarios': ['VIEW','EDIT'],
    'reports': ['VIEW'], 'reports.snapshot': ['VIEW'],
    'admin.users': ['VIEW','EDIT','FULL'], 'admin.audit-log': ['VIEW'],
    'admin.user-access-override': ['VIEW','EDIT','APPROVE','FULL'],
    'profile.sessions': ['VIEW','EDIT'], 'profile.activity': ['VIEW'],
  };
  const riskAcl: Record<string, string[]> = {
    'dashboard': ['VIEW'], 'alerts': ['VIEW','EDIT'], 'alerts.detail': ['VIEW','EDIT'],
    'customers': ['VIEW'], 'customers.detail': ['VIEW'],
    'rules': ['VIEW','EDIT'], 'cases': ['VIEW','EDIT'], 'cases.detail': ['VIEW','EDIT'],
    'scenarios': ['VIEW','EDIT'], 'reports': ['VIEW'],
    'profile.sessions': ['VIEW','EDIT'], 'profile.activity': ['VIEW'],
  };
  const fieldAcl: Record<string, string[]> = {
    'dashboard': ['VIEW'], 'alerts': ['VIEW'], 'cases': ['VIEW','EDIT'], 'cases.detail': ['VIEW','EDIT'],
    'profile.sessions': ['VIEW','EDIT'], 'profile.activity': ['VIEW'],
  };
  const collectAcl: Record<string, string[]> = {
    'dashboard': ['VIEW'], 'alerts': ['VIEW'], 'cases': ['VIEW','EDIT'], 'cases.detail': ['VIEW','EDIT'],
    'cases.cms': ['VIEW','EDIT'], 'profile.sessions': ['VIEW','EDIT'], 'profile.activity': ['VIEW'],
  };
  const acl = roles[0] === 'admin' ? adminAcl
            : roles[0] === 'risk_analyst' ? riskAcl
            : roles[0] === 'collection_officer' ? collectAcl
            : roles[0] === 'field_officer' ? fieldAcl
            : adminAcl;
  const modules = Object.keys(acl).sort().map((p) => ({
    module_path: p, permissions: acl[p], source: 'role',
  }));
  return { roles, modules };
}

function envelope<T>(body: T, code = 'EWS_200', message = 'Processed Successfully') {
  return {
    header: {
      status: 'SUCCESS' as const,
      code,
      message,
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
    },
    body,
  };
}

function envelopeError(
  code: string,
  message: string,
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  detail?: Record<string, unknown>,
) {
  return {
    header: {
      status: 'FAILURE' as const,
      requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
    },
    error: { code, message, severity, ...(detail ? { detail } : {}) },
  };
}

// Read the current user's role from the auth store's localStorage shape.
// Returns null when no user is signed in. Used to gate the MSW admin
// endpoints since MSW doesn't decode JWTs the way auth-svc does.
function readPersistedRole(): string | null {
  try {
    const raw = localStorage.getItem('apex.ews.user');
    if (!raw) return null;
    const u = JSON.parse(raw) as { roles?: string[] };
    return u.roles?.[0] ?? null;
  } catch {
    return null;
  }
}

function readPersistedUsername(): string | null {
  try {
    const raw = localStorage.getItem('apex.ews.user');
    if (!raw) return null;
    const u = JSON.parse(raw) as { username?: string };
    return u.username ?? null;
  } catch {
    return null;
  }
}

function setLockedHandler(username: string, locked: boolean) {
  const callerRole = readPersistedRole();
  if (callerRole === null) return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
  if (callerRole !== 'admin') return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
  if (locked && username === readPersistedUsername()) {
    return HttpResponse.json({ error: 'cannot_lock_self' }, { status: 409 });
  }
  const target = DEMO_USERS.find((u) => u.username === username);
  if (!target) return HttpResponse.json({ error: 'user_not_found' }, { status: 404 });
  target.locked = locked;
  return HttpResponse.json({ ok: true, username: target.username, locked });
}

// Shared register-user logic — used by both POST /auth/register (self)
// and POST /auth/users (admin). Returns the same SignupResult shape.
async function registerLikeHandler(request: Request, _by: 'self' | 'admin') {
  const body = (await request.json()) as {
    username?: string;
    email?: string;
    password?: string;
    display_name?: string;
    role?: string;
  };
  const username = body.username?.trim().toLowerCase();
  const email = body.email?.trim().toLowerCase();
  const display_name = body.display_name?.trim();
  const VALID_ROLES = ['admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer'];

  if (!username || !email || !body.password || !display_name || !body.role) {
    return HttpResponse.json(
      { error: 'username, email, password, display_name, role required' },
      { status: 400 },
    );
  }
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(username)) {
    return HttpResponse.json(
      { error: 'username_invalid', message: 'username must be 3–32 chars, lowercase, start with a letter, [a-z0-9._-]' },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return HttpResponse.json(
      { error: 'email_invalid', message: 'a valid email is required' },
      { status: 400 },
    );
  }
  if (!VALID_ROLES.includes(body.role)) {
    return HttpResponse.json(
      { error: 'role_invalid', message: `role must be one of ${VALID_ROLES.join(', ')}` },
      { status: 400 },
    );
  }
  if (
    body.password.length < 8 ||
    !/[a-z]/.test(body.password) ||
    !/[A-Z]/.test(body.password) ||
    !/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(body.password)
  ) {
    return HttpResponse.json(
      {
        error: 'password_too_weak',
        message: 'password must be ≥8 chars and include lower, upper, and a digit or symbol',
      },
      { status: 400 },
    );
  }
  if (DEMO_USERS.some((u) => u.username === username)) {
    return HttpResponse.json(
      { error: 'username_taken', message: `username ${username} already exists` },
      { status: 409 },
    );
  }
  if (DEMO_USERS.some((u) => u.email === email)) {
    return HttpResponse.json(
      { error: 'email_taken', message: `email ${email} already exists` },
      { status: 409 },
    );
  }

  const id = `u-${Math.random().toString(36).slice(2, 10)}`;
  DEMO_USERS.push({
    id,
    username,
    email,
    password: body.password,
    display_name,
    roles: [body.role as DemoUser['roles'][number]],
    locked: false,
  });

  return HttpResponse.json(
    {
      user: { id, username, email, role: body.role, display_name },
    },
    { status: 201 },
  );
}

function illegal(c: CaseDetail, attempted: Transition) {
  return HttpResponse.json(
    {
      error: `cannot ${attempted} a case in state ${c.state}`,
      current_state: c.state,
      attempted,
    },
    { status: 409 },
  );
}

export const handlers = [
  // ── Auth ──────────────────────────────────────────────────────────
  http.post('/auth/login', async ({ request }) => {
    const body = (await request.json()) as {
      username?: string;
      password?: string;
      captcha_id?: string;
      captcha_answer?: number | string;
    };
    const username = (body.username ?? '').trim().toLowerCase();
    const failureKey = username; // mock can't see real client IP, single-tenant

    // Captcha gate fires after CAPTCHA_THRESHOLD failed attempts. Same
    // ordering as auth-svc: gate runs before the password check.
    if ((_captchaFailures.get(failureKey) ?? 0) >= CAPTCHA_THRESHOLD) {
      const ans =
        typeof body.captcha_answer === 'string'
          ? Number(body.captcha_answer)
          : body.captcha_answer;
      const cap = body.captcha_id ? _captchaChallenges.get(body.captcha_id) : undefined;
      if (body.captcha_id) _captchaChallenges.delete(body.captcha_id);
      if (!body.captcha_id || typeof ans !== 'number' || Number.isNaN(ans)) {
        return HttpResponse.json(
          {
            error: 'captcha_required',
            message: 'Too many failed attempts — please solve the CAPTCHA below.',
            failed_count: _captchaFailures.get(failureKey),
          },
          { status: 401 },
        );
      }
      if (!cap || cap.expires_at_ms < Date.now() || cap.answer !== ans) {
        return HttpResponse.json(
          {
            error: 'captcha_failed',
            message: 'CAPTCHA answer was wrong or expired. Try a new challenge.',
            failed_count: _captchaFailures.get(failureKey),
          },
          { status: 401 },
        );
      }
    }

    const match = DEMO_USERS.find(
      (u) => u.username === body.username && u.password === body.password,
    );
    if (!match) {
      _captchaFailures.set(failureKey, (_captchaFailures.get(failureKey) ?? 0) + 1);
      return HttpResponse.json(
        { error: 'invalid_credentials', message: 'Invalid credentials' },
        { status: 401 },
      );
    }
    if (match.locked) {
      return HttpResponse.json(
        { error: 'locked_account', message: 'Your account is locked. Contact your administrator.' },
        { status: 403 },
      );
    }
    // Successful login resets the captcha counter for this username.
    _captchaFailures.delete(failureKey);
    return HttpResponse.json({
      access_token: `mock.${match.id}.${Date.now()}`,
      user: {
        id: match.id,
        username: match.username,
        roles: match.roles,
        display_name: match.display_name,
      },
      must_change_password: match.must_change_password ?? false,
      terms_accepted_at: match.terms_accepted_at ?? new Date().toISOString(),
    });
  }),

  // Issue a math-CAPTCHA challenge. Anonymous endpoint — the SPA fetches
  // it after the backend returns captcha_required.
  http.get('/auth/captcha/challenge', () => {
    const a = 1 + Math.floor(Math.random() * 9);
    const b = 1 + Math.floor(Math.random() * 9);
    const id = `cap-${Math.random().toString(36).slice(2, 10)}`;
    const expires_at_ms = Date.now() + 5 * 60 * 1000;
    _captchaChallenges.set(id, { answer: a + b, expires_at_ms });
    return HttpResponse.json({
      id,
      question: `What is ${a} + ${b}?`,
      expires_at: new Date(expires_at_ms).toISOString(),
    });
  }),

  // First-login wizard — rotates the password and records T&C acceptance.
  // Mirrors auth-svc POST /auth/first-login/complete.
  http.post('/auth/first-login/complete', async ({ request }) => {
    const role = readPersistedRole();
    if (role === null) {
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    }
    const userRaw = (() => {
      try {
        return JSON.parse(localStorage.getItem('apex.ews.user') ?? '{}') as { id?: string };
      } catch {
        return {};
      }
    })();
    const target = DEMO_USERS.find((u) => u.id === userRaw.id);
    if (!target) {
      return HttpResponse.json({ error: 'invalid_token' }, { status: 401 });
    }
    if (!target.must_change_password) {
      return HttpResponse.json(
        { error: 'first_login_already_complete' },
        { status: 409 },
      );
    }
    const body = (await request.json()) as { new_password?: string; accept_terms?: boolean };
    if (body.accept_terms !== true) {
      return HttpResponse.json({ error: 'must_accept_terms' }, { status: 400 });
    }
    if (!body.new_password) {
      return HttpResponse.json({ error: 'new_password required' }, { status: 400 });
    }
    if (
      body.new_password.length < 8 ||
      !/[a-z]/.test(body.new_password) ||
      !/[A-Z]/.test(body.new_password) ||
      !/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(body.new_password)
    ) {
      return HttpResponse.json(
        {
          error: 'password_too_weak',
          message: 'password must be ≥8 chars and include lower, upper, and a digit or symbol',
        },
        { status: 400 },
      );
    }
    if (body.new_password === target.password) {
      return HttpResponse.json(
        { error: 'password_reused', message: 'choose a password different from the one you were given' },
        { status: 400 },
      );
    }
    target.password = body.new_password;
    target.must_change_password = false;
    target.terms_accepted_at = new Date().toISOString();
    return HttpResponse.json({
      ok: true,
      username: target.username,
      message: 'First-login complete. Welcome.',
      terms_accepted_at: target.terms_accepted_at,
    });
  }),

  // ── Auth: self-service signup (mirrors auth-svc POST /auth/register) ──
  http.post('/auth/register', async ({ request }) => registerLikeHandler(request, 'self')),

  // Admin variant of registration. Same validation; admin-only auth gate.
  http.post('/auth/users', async ({ request }) => {
    const role = readPersistedRole();
    if (role === null) return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    if (role !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    return registerLikeHandler(request, 'admin');
  }),

  http.delete('/auth/users/:username', ({ params }) => {
    const callerRole = readPersistedRole();
    if (callerRole === null) return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    if (callerRole !== 'admin') return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    const username = String(params.username).toLowerCase();
    const callerUsername = readPersistedUsername();
    if (username === callerUsername) {
      return HttpResponse.json({ error: 'cannot_delete_self' }, { status: 409 });
    }
    const idx = DEMO_USERS.findIndex((u) => u.username === username);
    if (idx === -1) return HttpResponse.json({ error: 'user_not_found' }, { status: 404 });
    DEMO_USERS.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('/auth/users/:username/lock', ({ params }) =>
    setLockedHandler(String(params.username).toLowerCase(), true),
  ),
  http.post('/auth/users/:username/unlock', ({ params }) =>
    setLockedHandler(String(params.username).toLowerCase(), false),
  ),

  // ── Per-role dashboard widgets (T4.23, BAC-A §3.1.9.1.4) ──────────
  // Stateful Map at module scope so the test setup can reset it between
  // tests via __resetMswDashboardWidgets().
  http.get('/auth/dashboard-widgets/:role', ({ params }) => {
    const role = String(params.role);
    const widgets = mswDashboardWidgets.get(role) ?? [];
    return HttpResponse.json({ role, widgets });
  }),
  http.put('/auth/dashboard-widgets/:role', async ({ params, request }) => {
    const role = String(params.role);
    const body = (await request.json().catch(() => ({}))) as {
      widgets?: Array<{ widget_id?: string; sort_order?: number; is_visible?: boolean }>;
    };
    if (!Array.isArray(body.widgets)) {
      return HttpResponse.json({ error: 'widgets array is required' }, { status: 400 });
    }
    const ts = new Date().toISOString();
    const stored = body.widgets
      .filter(
        (w): w is { widget_id: string; sort_order: number; is_visible: boolean } =>
          typeof w?.widget_id === 'string' &&
          typeof w?.sort_order === 'number' &&
          typeof w?.is_visible === 'boolean',
      )
      .map((w) => ({
        widget_id: w.widget_id,
        sort_order: w.sort_order,
        is_visible: w.is_visible,
        updated_at: ts,
        updated_by: 'msw-admin',
      }))
      .sort((a, b) => a.sort_order - b.sort_order);
    mswDashboardWidgets.set(role, stored);
    return HttpResponse.json({ role, widgets: stored });
  }),

  // ── Auth: password reset (mirrors auth-svc /auth/password/*) ──────
  // Stateful within an MSW session: tokens live in this module-scoped Map
  // until either consumed or 15-min TTL expires.
  http.post('/auth/password/reset-request', async ({ request }) => {
    const body = (await request.json()) as { username?: string; email?: string };
    const username = body.username?.trim().toLowerCase();
    const email = body.email?.trim().toLowerCase();
    if (!username && !email) {
      return HttpResponse.json({ error: 'username or email required' }, { status: 400 });
    }
    const user = email
      ? DEMO_USERS.find((u) => u.email === email)
      : DEMO_USERS.find((u) => u.username === username);
    let debug: { token: string; reset_link: string; expires_at: string } | undefined;
    if (user) {
      const token =
        Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const expiresAtMs = Date.now() + 15 * 60 * 1000;
      _resetTokens.set(token, { userId: user.id, expiresAtMs });
      debug = {
        token,
        reset_link: `${window.location.origin}/reset-password?token=${token}`,
        expires_at: new Date(expiresAtMs).toISOString(),
      };
    }
    return HttpResponse.json(
      {
        ok: true,
        message:
          'If an account with that username exists, a password-reset link has been generated. ' +
          'In MSW mode the link is shown below — in production it would be emailed.',
        debug,
      },
      { status: 202 },
    );
  }),

  // GET /auth/users — admin-only list (mirrors auth-svc).
  // We do NOT carry a real JWT through MSW — auth state lives in the
  // zustand store. So we authorize by reading the persisted user shape
  // from localStorage and checking its role. Only relevant in MSW mode.
  http.get('/auth/users', () => {
    const role = readPersistedRole();
    if (role === null) {
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    }
    if (role !== 'admin') {
      return HttpResponse.json(
        { error: 'forbidden', message: 'admin role required' },
        { status: 403 },
      );
    }
    const users = DEMO_USERS.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.roles[0],
      display_name: u.display_name,
      locked: u.locked,
    }));
    return HttpResponse.json({ users });
  }),

  // POST /auth/password/admin-reset — admin-only direct password change.
  http.post('/auth/password/admin-reset', async ({ request }) => {
    const role = readPersistedRole();
    if (role === null) {
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    }
    if (role !== 'admin') {
      return HttpResponse.json(
        { error: 'forbidden', message: 'admin role required' },
        { status: 403 },
      );
    }
    const body = (await request.json()) as { username?: string; password?: string };
    const username = body.username?.trim().toLowerCase();
    if (!username || !body.password) {
      return HttpResponse.json({ error: 'username and password required' }, { status: 400 });
    }
    const target = DEMO_USERS.find((u) => u.username === username);
    if (!target) {
      return HttpResponse.json({ error: 'user_not_found' }, { status: 404 });
    }
    if (
      body.password.length < 8 ||
      !/[a-z]/.test(body.password) ||
      !/[A-Z]/.test(body.password) ||
      !/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(body.password)
    ) {
      return HttpResponse.json(
        {
          error: 'password_too_weak',
          message: 'password must be ≥8 chars and include lower, upper, and a digit or symbol',
        },
        { status: 400 },
      );
    }
    target.password = body.password;
    return HttpResponse.json({
      ok: true,
      username: target.username,
      message: `Password for ${target.username} has been reset.`,
    });
  }),

  // ── Auth: self-service activity (mirrors auth-svc GET /auth/me/activity) ──
  http.get('/auth/me/activity', ({ request }) => {
    const role = readPersistedRole();
    if (role === null) {
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    }
    let username = 'unknown';
    try {
      const parsed = JSON.parse(localStorage.getItem('apex.ews.user') ?? '{}') as {
        username?: string;
      };
      username = parsed.username ?? 'unknown';
    } catch {
      // ignore — falls back to "unknown" so the response is still well-shaped
    }
    const url = new URL(request.url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const now = Date.now();
    // Synthesize a plausible per-user activity stream so the SPA renders
    // realistic content in dev. Real backend pulls from the audit-log
    // ring buffer filtered by target_username.
    const seed: Array<{
      id: string;
      ts: string;
      type: string;
      target_username: string;
      actor_username: string | null;
      actor_role: string | null;
      ip: string | null;
      metadata: Record<string, unknown>;
    }> = [
      // Most-recent entries first
      { id: 'me-1', ts: new Date(now - 2 * 60 * 1000).toISOString(), type: 'login_success', target_username: username, actor_username: username, actor_role: role, ip: '127.0.0.1', metadata: { device: 'this device' } },
      { id: 'me-2', ts: new Date(now - 6 * 3600 * 1000).toISOString(), type: 'login_success', target_username: username, actor_username: username, actor_role: role, ip: '10.0.12.42', metadata: { device: 'Safari on iPhone' } },
      { id: 'me-3', ts: new Date(now - 25 * 3600 * 1000).toISOString(), type: 'login_failure', target_username: username, actor_username: null, actor_role: null, ip: '198.51.100.7', metadata: { reason: 'wrong_password' } },
      { id: 'me-4', ts: new Date(now - 28 * 3600 * 1000).toISOString(), type: 'login_failure', target_username: username, actor_username: null, actor_role: null, ip: '198.51.100.7', metadata: { reason: 'wrong_password' } },
      { id: 'me-5', ts: new Date(now - 30 * 3600 * 1000).toISOString(), type: 'login_success', target_username: username, actor_username: username, actor_role: role, ip: '127.0.0.1', metadata: {} },
      { id: 'me-6', ts: new Date(now - 3 * 24 * 3600 * 1000).toISOString(), type: 'password_reset_complete', target_username: username, actor_username: username, actor_role: role, ip: '127.0.0.1', metadata: {} },
      { id: 'me-7', ts: new Date(now - 5 * 24 * 3600 * 1000).toISOString(), type: 'login_success', target_username: username, actor_username: username, actor_role: role, ip: '127.0.0.1', metadata: {} },
    ];
    return HttpResponse.json({ events: seed.slice(0, limit), username });
  }),

  // ── Auth: audit log (mirrors auth-svc GET /auth/audit-log) ────────
  http.get('/auth/audit-log', ({ request }) => {
    const role = readPersistedRole();
    if (role === null) {
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    }
    if (role !== 'admin' && role !== 'supervisor') {
      return HttpResponse.json(
        { error: 'forbidden', message: 'admin role required' },
        { status: 403 },
      );
    }
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const target = url.searchParams.get('target_username');
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));

    // Synthesize a plausible audit log when the SPA-mode buffer is empty
    // — gives the page something to render in dev. Real backend persists
    // events as they happen.
    const seed = (() => {
      const now = Date.now();
      const events: Array<{
        id: string;
        ts: string;
        type: string;
        target_username: string | null;
        actor_username: string | null;
        actor_role: string | null;
        ip: string | null;
        metadata: Record<string, unknown>;
      }> = [];
      const types: Array<[string, string | null, string | null]> = [
        ['login_success', 'alice.admin', 'admin'],
        ['login_failure', 'sue.super', null],
        ['login_success', 'ravi.risk', 'risk_analyst'],
        ['password_reset_request', 'fiona.field', null],
        ['password_reset_complete', 'fiona.field', null],
        ['user_created', 'tina.test', null],
        ['login_rate_limited', 'mallory.brute', null],
        ['auto_lockout_triggered', 'mallory.brute', null],
        ['user_locked', 'mallory.brute', null],
        ['admin_password_reset', 'carl.collect', 'admin'],
        ['user_unlocked', 'mallory.brute', null],
        ['login_success', 'sue.super', 'supervisor'],
      ];
      for (let i = 0; i < types.length; i++) {
        const [t, target_username, actor_role] = types[i]!;
        events.push({
          id: `ae-${i.toString(36)}-mock`,
          ts: new Date(now - (i + 1) * 1000 * 60 * 7).toISOString(),
          type: t,
          target_username,
          actor_username: actor_role ? target_username : null,
          actor_role,
          ip: i % 3 === 0 ? '10.0.12.42' : '127.0.0.1',
          metadata: {},
        });
      }
      return events;
    })();

    let filtered = seed;
    if (type) filtered = filtered.filter((e) => e.type === type);
    if (target) filtered = filtered.filter((e) => e.target_username === target);
    return HttpResponse.json({ events: filtered.slice(0, limit) });
  }),

  // ── Auth: active sessions (mirrors auth-svc /auth/sessions) ───────
  // Mock backend keeps a per-user session list; handlers below give the
  // SPA something to render in dev. The "current" session is whichever
  // one was last created for the user — auth-svc would derive this from
  // the JWT sid claim, but MSW doesn't decode JWTs.
  http.get('/auth/sessions', () => {
    const role = readPersistedRole();
    if (role === null) {
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    }
    const userRaw = (() => {
      try {
        return JSON.parse(localStorage.getItem('apex.ews.user') ?? '{}') as {
          id?: string;
        };
      } catch {
        return {};
      }
    })();
    const userId = userRaw.id ?? 'u-unknown';
    let list = _mockSessions.filter((s) => s.user_id === userId);
    if (list.length === 0) {
      // Seed a single "current" session so the page doesn't render empty
      // on a fresh dev login.
      list = [
        {
          id: `sid-${Date.now().toString(36)}`,
          user_id: userId,
          issued_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
          last_seen_at: new Date().toISOString(),
          ip: '127.0.0.1',
          user_agent: 'Chrome on macOS · this device',
          is_current: true,
        },
        {
          id: `sid-other-${Date.now().toString(36)}`,
          user_id: userId,
          issued_at: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
          last_seen_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
          ip: '10.0.12.42',
          user_agent: 'Safari on iPhone',
          is_current: false,
        },
      ];
      _mockSessions.push(...list);
    }
    const current = list.find((s) => s.is_current);
    return HttpResponse.json({
      sessions: list,
      current_session_id: current?.id ?? null,
    });
  }),

  http.delete('/auth/sessions/:sid', ({ params }) => {
    const role = readPersistedRole();
    if (role === null) {
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    }
    const sid = String(params.sid ?? '');
    const idx = _mockSessions.findIndex((s) => s.id === sid);
    if (idx === -1) {
      return HttpResponse.json({ error: 'session_not_found' }, { status: 404 });
    }
    _mockSessions.splice(idx, 1);
    return HttpResponse.json({ ok: true, revoked_sid: sid });
  }),

  http.delete('/auth/sessions', ({ request }) => {
    const role = readPersistedRole();
    if (role === null) {
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    }
    const userRaw = (() => {
      try {
        return JSON.parse(localStorage.getItem('apex.ews.user') ?? '{}') as { id?: string };
      } catch {
        return {};
      }
    })();
    const userId = userRaw.id ?? 'u-unknown';
    const url = new URL(request.url);
    const except = url.searchParams.get('except') === 'current';
    let revoked = 0;
    for (let i = _mockSessions.length - 1; i >= 0; i--) {
      const s = _mockSessions[i]!;
      if (s.user_id !== userId) continue;
      if (except && s.is_current) continue;
      _mockSessions.splice(i, 1);
      revoked++;
    }
    return HttpResponse.json({ ok: true, revoked_count: revoked });
  }),

  http.post('/auth/password/reset-confirm', async ({ request }) => {
    const body = (await request.json()) as { token?: string; password?: string };
    const { token, password } = body;
    if (!token || !password) {
      return HttpResponse.json(
        { error: 'token and password required' },
        { status: 400 },
      );
    }
    const entry = _resetTokens.get(token);
    if (entry) _resetTokens.delete(token);
    if (!entry || entry.expiresAtMs < Date.now()) {
      return HttpResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 });
    }
    if (
      password.length < 8 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)
    ) {
      return HttpResponse.json(
        {
          error: 'password_too_weak',
          message: 'password must be ≥8 chars and include lower, upper, and a digit or symbol',
        },
        { status: 400 },
      );
    }
    const user = DEMO_USERS.find((u) => u.id === entry.userId);
    if (!user) return HttpResponse.json({ error: 'invalid_or_expired_token' }, { status: 400 });
    user.password = password;
    return HttpResponse.json({
      ok: true,
      username: user.username,
      message: 'Password updated. Sign in with your new password.',
    });
  }),

  // ── Copilot chat (mirrors services/bff /v1/copilot/chat) ──────────
  http.post('/v1/copilot/chat', async ({ request }) => {
    const body = (await request.json()) as {
      message?: string;
      context?: {
        page?: string;
        entity?: { type?: string; id?: string; label?: string; facts?: Record<string, unknown> };
      };
    };
    const message = (body.message ?? '').trim();
    if (!message) return HttpResponse.json({ error: 'message is required' }, { status: 400 });
    if (message.length > 2000)
      return HttpResponse.json({ error: 'message exceeds 2000 chars' }, { status: 400 });

    const lower = message.toLowerCase();
    const ctx = body.context ?? {};
    const entity = ctx.entity;
    const page = (ctx.page as string) ?? 'unknown';

    const fmtPct = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : null;
    const fmtNum = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v)
        ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v)
        : null;
    const entityLabel = entity ? (entity.label ? `${entity.label} (${entity.id})` : entity.id) : null;

    let intent:
      | 'greeting'
      | 'help'
      | 'risk_score'
      | 'why_high'
      | 'recommend_action'
      | 'summary'
      | 'thanks'
      | 'fallback' = 'fallback';
    if (/^\s*(hi|hello|hey|hola|namaste|jambo|good (morning|afternoon|evening))\b/.test(lower))
      intent = 'greeting';
    else if (/\b(help|what can you do|capabilities|how do you work)\b/.test(lower)) intent = 'help';
    else if (/\b(thank|thanks|thx|cheers|appreciate)\b/.test(lower)) intent = 'thanks';
    else if (/\b(why|reason|explain|driver|cause|because|how come)\b/.test(lower)) intent = 'why_high';
    else if (/\b(pd|probability|risk score|score|risk level)\b/.test(lower)) intent = 'risk_score';
    else if (/\b(action|next|recommend|do|step|what should|advice)\b/.test(lower))
      intent = 'recommend_action';
    else if (/\b(summary|summarise|summarize|overview|tl;?dr|brief)\b/.test(lower))
      intent = 'summary';

    let reply = '';
    switch (intent) {
      case 'greeting':
        reply = `Hi! I'm the APEX EWS copilot. ${
          entityLabel ? `I can see you're looking at ${entityLabel}.` : `What can I help you with on the ${page === 'unknown' ? 'current page' : page} screen?`
        }`;
        break;
      case 'help':
        reply =
          "I'm the APEX EWS copilot — a context-aware assistant for risk operations.\n\nI can:\n  • Explain a customer's PD and the top SHAP drivers\n  • Summarise an alert, case, or the dashboard\n  • Recommend next actions tailored to your role\n  • Help you triage queues by severity\n\nMy answers are templated and grounded in what's on the page you're looking at — not a free-form LLM (yet).";
        break;
      case 'thanks':
        reply = 'Anytime. Ping me whenever a number on the page needs unpacking.';
        break;
      case 'risk_score': {
        if (!entity) {
          reply = 'Open a customer or case and I can give you the PD with the SHAP drivers.';
          break;
        }
        const facts = entity.facts ?? {};
        const pd = fmtPct(facts.pd);
        const level = typeof facts.level === 'string' ? (facts.level as string) : null;
        const dpd = fmtNum(facts.dpd_max_90d ?? facts.worst_dpd);
        const exposure = fmtNum(facts.exposure ?? facts.total_outstanding);
        const lines: string[] = [];
        if (pd && level) lines.push(`${entityLabel} has a current PD of ${pd} (${level} risk).`);
        else if (pd) lines.push(`${entityLabel} has a current PD of ${pd}.`);
        else if (level) lines.push(`${entityLabel} is at ${level} risk.`);
        else lines.push(`I don't have a numeric PD for ${entityLabel} on this screen.`);
        if (dpd) lines.push(`Worst DPD over the last 90d: ${dpd} days.`);
        if (exposure) lines.push(`Outstanding exposure: ${exposure}.`);
        reply = lines.join(' ');
        break;
      }
      case 'why_high': {
        if (!entity) {
          reply = "Open a customer profile and I'll walk you through the SHAP drivers.";
          break;
        }
        const reasons = entity.facts?.top_reasons as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(reasons) && reasons.length > 0) {
          const bullets = reasons
            .slice(0, 3)
            .map((r, i) => {
              const dir = r.direction === 'protective' ? '↓' : '↑';
              return `  ${i + 1}. ${dir} ${String(r.feature ?? r.name ?? `factor ${i + 1}`)}`;
            })
            .join('\n');
          reply = `Top SHAP drivers for ${entityLabel}:\n${bullets}\n\nUpward arrows raise PD, downward arrows are protective.`;
        } else {
          reply = `For ${entityLabel} the page doesn't expose SHAP reasons, but the usual drivers are recent DPD, utilisation spikes, drops in inflow, and bureau-score deterioration. Open the customer's Risk Profile for the SHAP top-5.`;
        }
        break;
      }
      case 'recommend_action': {
        if (!entity) {
          reply =
            "Tell me which customer, case, or alert you mean and I'll suggest a next step.";
          break;
        }
        if (entity.type === 'customer') {
          reply = [
            `For ${entityLabel} the next step depends on severity:`,
            '  • If PD ≥ 60% — escalate to a case and assign to a Collection officer.',
            '  • If PD 30–60% — open a soft-touch outreach (SMS or call) and monitor for 14 days.',
            '  • If PD < 30% — keep on watch list; re-score at next refresh.',
          ].join('\n');
        } else if (entity.type === 'case') {
          reply = `For case ${entityLabel}: check the action log, attempt outreach (call → SMS → visit), and only close once outcome is known (cured / cured_temp / defaulted). If the case is in 'monitored' for >14 days without contact, log a follow-up to re-engage.`;
        } else if (entity.type === 'alert') {
          reply = `For alert ${entityLabel}: open the customer profile, review the SHAP drivers, then either acknowledge (if false-positive) or open a case (if action is warranted).`;
        } else {
          reply = 'Open the affected entity to see specific recommendations.';
        }
        break;
      }
      case 'summary': {
        if (entity?.type === 'customer') {
          const facts = entity.facts ?? {};
          const bits: string[] = [`${entityLabel} —`];
          const pd = fmtPct(facts.pd);
          if (pd) bits.push(`PD ${pd}.`);
          const dpd = fmtNum(facts.dpd_max_90d ?? facts.worst_dpd);
          if (dpd) bits.push(`Worst DPD ${dpd}d.`);
          const exposure = fmtNum(facts.exposure ?? facts.total_outstanding);
          if (exposure) bits.push(`Exposure ${exposure}.`);
          reply = bits.join(' ');
        } else if (entity?.type === 'case') {
          const facts = entity.facts ?? {};
          const state = (facts.state as string) ?? 'unknown';
          const severity = (facts.severity as string) ?? 'unknown';
          const actions = fmtNum(facts.action_count);
          reply = `${entityLabel} — state: ${state}, severity: ${severity}${
            actions ? `, ${actions} actions logged` : ''
          }.`;
        } else if (entity?.type === 'alert') {
          const facts = entity.facts ?? {};
          const sev = (facts.severity as string) ?? 'unknown';
          reply = `${entityLabel} — severity ${sev}.${
            facts.indicators ? ` Triggered indicators: ${String(facts.indicators)}.` : ''
          }`;
        } else if (page === 'dashboard') {
          reply =
            'On the dashboard you can see customers monitored, high-risk count, active alerts, open cases, an 8-week PD trend, and the alerts-by-severity split. Click a metric to drill in.';
        } else if (page === 'alerts') {
          reply =
            'The alert list shows newest-first, sortable by severity. Critical/high need triage today; medium can wait 24–48h; low is FYI.';
        } else if (page === 'cases') {
          reply =
            'The case list shows everything open across the team. Filter by state (open / assigned / in_action / monitored) to find what needs your attention.';
        } else {
          reply =
            "I don't have a specific summary for this page yet — try asking about an alert, case, or customer.";
        }
        break;
      }
      default:
        reply =
          'I don\'t have a templated answer for that yet. Try one of the suggestions below — or ask "help" for what I can do.';
    }

    const SUG: Record<string, string[]> = {
      customer: [
        'Why is this customer high risk?',
        'What actions should I take?',
        'Summarise this customer',
        'Explain the SHAP drivers',
      ],
      case: [
        'What is the case status?',
        'Suggest a next action',
        'Why is this case high severity?',
        'Summarise the action log',
      ],
      dashboard: [
        "Summarise today's risk posture",
        "What's driving the trend?",
        'Top risk segments',
        'How are alerts split by severity?',
      ],
      alerts: [
        'Which alerts need urgent attention?',
        'What is driving the critical alerts?',
        'How do I triage this list?',
        'Summarise the queue',
      ],
      cases: [
        'How many cases are open?',
        'Which cases are stuck?',
        'Suggest a triage order',
      ],
      rules: [
        'Which rules fire most often?',
        'How is the FP rate looking?',
        'Help me draft a new rule',
      ],
      scenario: [
        'How do I run a what-if?',
        'What does shifting threshold X do?',
        'Summarise the last scenario',
      ],
    };
    const suggestions =
      entity?.type === 'customer'
        ? SUG.customer
        : entity?.type === 'case'
          ? SUG.case
          : SUG[page] ?? ['What can you do?', 'Summarise the dashboard', 'Walk me through an alert'];

    return HttpResponse.json({
      reply,
      suggestions,
      used_context: { page, entity_id: entity?.id, matched_intent: intent },
    });
  }),

  // ── Dashboard ─────────────────────────────────────────────────────
  http.get('/api/dashboard/summary', () => HttpResponse.json(dashboardSummary)),

  // ── Alerts ────────────────────────────────────────────────────────
  // Filters + sort + dedup. Criticality is computed at request time so
  // the formula in web/src/lib/criticality.ts stays the single source
  // of truth (mirrored in production by the BFF mapping pipeline).
  http.get('/api/alerts', ({ request }) => {
    const url = new URL(request.url);
    const severity = url.searchParams.get('severity') as Severity | null;
    const assignee = url.searchParams.get('assignee');
    const sortParam = url.searchParams.get('sort') ?? 'criticality';
    // dedup defaults to TRUE — the customer-merge view is the prioritized
    // queue's value-add. Pass ?dedup=false to see every individual alert.
    const dedupParam = url.searchParams.get('dedup');
    const dedupOn = dedupParam === null ? true : dedupParam === 'true';

    const customerId = url.searchParams.get('customer_id');
    let items = alerts.map((a) => ({
      ...a,
      criticality_score: computeScore(a),
      linked_alert_ids: [] as string[],
    }));
    if (severity) items = items.filter((a) => a.severity === severity);
    if (assignee) items = items.filter((a) => a.assignee === assignee);
    if (customerId) items = items.filter((a) => a.customer.id === customerId);
    if (dedupOn) items = dedupByCustomer(items);
    const sortKey: 'criticality' | 'severity' | 'age' =
      sortParam === 'severity' || sortParam === 'age' ? sortParam : 'criticality';
    items = sortBy(items, sortKey);
    return HttpResponse.json({ items, total: items.length });
  }),

  // ── Customer list ────────────────────────────────────────────────
  // Filters mirror the URL params produced by the dashboard KPI cards:
  //   - level=High         → only "High" risk band
  //   - level=High,Medium  → comma-separated subset
  //   - pdMin=0.5          → numeric PD floor; 0.5 is the "high-risk" cutoff
  // No filter = full list. Sorted by PD desc so risky customers float to top.
  http.get('/api/customers', ({ request }) => {
    const url = new URL(request.url);
    const levelParam = url.searchParams.get('level');
    const pdMinParam = url.searchParams.get('pdMin');
    const allowedLevels = levelParam
      ? new Set(levelParam.split(',').map((s) => s.trim()))
      : null;
    const pdMin = pdMinParam !== null ? Number(pdMinParam) : null;
    const items = Object.values(customers)
      .filter((c) => (allowedLevels ? allowedLevels.has(c.level) : true))
      .filter((c) => (pdMin !== null && !Number.isNaN(pdMin) ? c.pd >= pdMin : true))
      .map(({ id, name, pd, level, exposure, dpd }) => ({ id, name, pd, level, exposure, dpd }))
      .sort((a, b) => b.pd - a.pd);
    return HttpResponse.json({ items, total: items.length });
  }),

  // ── Customer risk ────────────────────────────────────────────────
  http.get('/api/customers/:id/risk', ({ params }) => {
    const id = params.id as string;
    const c = customers[id] ?? customers['c-101'];
    return HttpResponse.json({ ...c, id });
  }),

  // ── Rules ────────────────────────────────────────────────────────
  http.get('/api/rules', () => HttpResponse.json({ items: rules })),

  // ── Cases ────────────────────────────────────────────────────────
  // Filters mirror dashboard KPI deep-links:
  //   - state=open,assigned    → CaseState whitelist
  //   - sla=breached,approaching → SLA bucket whitelist (sla_status field)
  http.get('/api/cases', ({ request }) => {
    const url = new URL(request.url);
    const stateParam = url.searchParams.get('state');
    const slaParam = url.searchParams.get('sla');
    const customerIdParam = url.searchParams.get('customer_id');
    const stateAllow = stateParam ? new Set(stateParam.split(',').map((s) => s.trim())) : null;
    const slaAllow = slaParam ? new Set(slaParam.split(',').map((s) => s.trim())) : null;
    const items = caseSummariesFrom().filter((c) => {
      if (stateAllow && !stateAllow.has(c.state)) return false;
      if (slaAllow && !slaAllow.has(c.sla_status ?? 'on_track')) return false;
      if (customerIdParam && c.customer.id !== customerIdParam) return false;
      return true;
    });
    return HttpResponse.json({ items });
  }),

  http.get('/api/cases/:id', ({ params }) => {
    const c = findCase(params.id as string);
    if (!c) return HttpResponse.json({ error: `case ${params.id} not found` }, { status: 404 });
    return HttpResponse.json(c);
  }),

  http.post('/api/cases/:id/assign', async ({ params, request }) => {
    const c = findCase(params.id as string);
    if (!c) return HttpResponse.json({ error: 'not found' }, { status: 404 });
    const body = (await request.json()) as { user_id?: string };
    if (!body.user_id) {
      return HttpResponse.json({ error: 'user_id is required' }, { status: 400 });
    }
    const next = applyTransition(c, 'assign');
    if (!next) return illegal(c, 'assign');
    c.state = next;
    c.assignee = body.user_id;
    c.updated_at = new Date().toISOString();
    return HttpResponse.json(c);
  }),

  http.post('/api/cases/:id/actions', async ({ params, request }) => {
    const c = findCase(params.id as string);
    if (!c) return HttpResponse.json({ error: 'not found' }, { status: 404 });
    const body = (await request.json()) as {
      kind?: string;
      officer_id?: string;
      outcome_note?: string | null;
      gps?: { lat?: number; lng?: number; accuracy_m?: number | null } | null;
    };
    if (!body.kind || !VALID_KINDS.includes(body.kind as CaseActionKind)) {
      return HttpResponse.json(
        { error: `kind must be one of ${VALID_KINDS.join(',')}` },
        { status: 400 },
      );
    }
    if (!body.officer_id) {
      return HttpResponse.json({ error: 'officer_id is required' }, { status: 400 });
    }
    let gps: CaseDetail['actions'][number]['gps'] = null;
    if (body.gps) {
      if (typeof body.gps.lat !== 'number' || typeof body.gps.lng !== 'number') {
        return HttpResponse.json(
          { error: 'gps.lat and gps.lng must be numbers' },
          { status: 400 },
        );
      }
      gps = { lat: body.gps.lat, lng: body.gps.lng, accuracy_m: body.gps.accuracy_m ?? null };
    }
    const next = applyTransition(c, 'logAction');
    if (!next) return illegal(c, 'logAction');
    const ts = new Date().toISOString();
    c.state = next;
    c.updated_at = ts;
    c.actions.push({
      action_id: `act-${c.id}-${c.actions.length + 1}`,
      ts,
      kind: body.kind as CaseActionKind,
      officer_id: body.officer_id,
      outcome_note: body.outcome_note ?? null,
      gps,
    });
    return HttpResponse.json(c, { status: 201 });
  }),

  http.post('/api/cases/:id/monitor', ({ params }) => {
    const c = findCase(params.id as string);
    if (!c) return HttpResponse.json({ error: 'not found' }, { status: 404 });
    const next = applyTransition(c, 'monitor');
    if (!next) return illegal(c, 'monitor');
    c.state = next;
    c.updated_at = new Date().toISOString();
    return HttpResponse.json(c);
  }),

  http.post('/api/cases/:id/close', async ({ params, request }) => {
    const c = findCase(params.id as string);
    if (!c) return HttpResponse.json({ error: 'not found' }, { status: 404 });
    const body = (await request.json()) as { outcome?: string; note?: string | null };
    if (!body.outcome || !VALID_OUTCOMES.includes(body.outcome as CaseOutcome)) {
      return HttpResponse.json(
        { error: `outcome must be one of ${VALID_OUTCOMES.join(',')}` },
        { status: 400 },
      );
    }
    const next = applyTransition(c, 'close');
    if (!next) return illegal(c, 'close');
    const ts = new Date().toISOString();
    c.state = next;
    c.outcome = body.outcome as CaseOutcome;
    c.updated_at = ts;
    c.closed_at = ts;
    return HttpResponse.json(c);
  }),

  // Rules v2 — mirrors /v1/rules/* from BFF. Hand-tuned fixtures so the
  // SPA renders maker-checker / backtest / performance views without the
  // backend running.
  http.get('/v1/rules/variables', () => HttpResponse.json({ categories: rulesV2Variables() })),

  http.get('/v1/rules', ({ request }) => {
    const url = new URL(request.url);
    const stateF = url.searchParams.get('state');
    const productF = url.searchParams.get('product');
    let envelopes = rulesV2Seed();
    if (stateF) envelopes = envelopes.filter((e) => e.rule.state === stateF);
    if (productF) {
      envelopes = envelopes.filter(
        (e) =>
          e.rule.applicable_products.length === 0 ||
          e.rule.applicable_products.includes(productF),
      );
    }
    // Flatten the envelope into the {…rule, performance, legal_transitions}
    // shape that /v1/rules returns from the BFF.
    const items = envelopes.map((e) => ({
      ...e.rule,
      performance: e.performance,
      legal_transitions: e.legal_transitions,
    }));
    return HttpResponse.json({ items, total: items.length });
  }),

  http.get('/v1/rules/:id', ({ params }) => {
    const r = rulesV2Seed().find((x) => x.rule.id === params.id);
    if (!r) return HttpResponse.json({ error: 'rule_not_found' }, { status: 404 });
    return HttpResponse.json(r);
  }),

  http.post('/v1/rules/:id/transition', async ({ params, request }) => {
    const seed = rulesV2Seed().find((x) => x.rule.id === params.id);
    if (!seed) return HttpResponse.json({ error: 'rule_not_found' }, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as { transition?: string; comment?: string };
    const t = body.transition;
    if (!['submit', 'approve', 'reject', 'activate', 'deprecate', 'edit'].includes(t ?? '')) {
      return HttpResponse.json({ error: 'invalid transition' }, { status: 400 });
    }
    if (t === 'reject' && !body.comment) {
      return HttpResponse.json({ error: 'invalid_payload', message: 'comment required' }, { status: 400 });
    }
    if (!seed.legal_transitions.includes(t as never)) {
      return HttpResponse.json(
        { error: 'illegal_transition', current_state: seed.rule.state },
        { status: 409 },
      );
    }
    const nextState =
      t === 'submit' ? 'pending_review'
      : t === 'approve' ? 'approved'
      : t === 'reject' ? 'draft'
      : t === 'activate' ? 'active'
      : t === 'deprecate' ? 'deprecated'
      : seed.rule.state;
    const nextRule = {
      ...seed.rule,
      state: nextState as never,
      updated_at: new Date().toISOString(),
      audit: [
        ...seed.rule.audit,
        {
          ts: new Date().toISOString(),
          actor_id: 'demo.actor',
          actor_role: 'demo',
          kind: t === 'submit' ? 'submitted'
            : t === 'approve' ? 'approved'
            : t === 'reject' ? 'rejected'
            : t === 'activate' ? 'activated'
            : t === 'deprecate' ? 'deprecated'
            : 'edited',
          to_state: nextState,
          comment: body.comment,
          version: seed.rule.version,
        },
      ],
    };
    return HttpResponse.json({
      rule: nextRule,
      performance: seed.performance,
      legal_transitions: legalTransitionsFor(nextState),
    });
  }),

  http.post('/v1/rules/:id/backtest', ({ params }) => {
    const id = String(params.id);
    return HttpResponse.json(rulesV2Backtest(id));
  }),

  http.get('/v1/rules/:id/performance', ({ params }) => {
    const id = String(params.id);
    const seed = rulesV2Seed().find((x) => x.rule.id === id);
    if (!seed) return HttpResponse.json({ error: 'rule_not_found' }, { status: 404 });
    return HttpResponse.json(seed.performance);
  }),

  // SLA summary — mirrors GET /v1/cases/sla-summary from BFF. Hand-tuned
  // counts so the SPA renders a realistic spread (some on-track, some
  // approaching, some breached, a couple closed).
  http.get('/v1/cases/sla-summary', () => {
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
    return HttpResponse.json({
      generated_at: now.toISOString(),
      by_severity: [
        { severity: 'critical', on_track: 1, approaching: 1, breached: 2, closed: 1, total: 5 },
        { severity: 'high',     on_track: 3, approaching: 1, breached: 1, closed: 0, total: 5 },
        { severity: 'medium',   on_track: 3, approaching: 1, breached: 1, closed: 0, total: 5 },
        { severity: 'low',      on_track: 3, approaching: 0, breached: 1, closed: 0, total: 4 },
      ],
      totals: { on_track: 10, approaching: 3, breached: 5, closed: 1, total: 19 },
      breached_cases: [
        {
          case_id: 'case-1003',
          severity: 'critical',
          stage: 'ack',
          deadline_at: minutesAgo(-30),
          minutes_remaining: -30,
          status: 'breached',
        },
        {
          case_id: 'case-1004',
          severity: 'critical',
          stage: 'close',
          deadline_at: minutesAgo(-70),
          minutes_remaining: -70,
          status: 'breached',
        },
        {
          case_id: 'case-2003',
          severity: 'high',
          stage: 'ack',
          deadline_at: minutesAgo(-60),
          minutes_remaining: -60,
          status: 'breached',
        },
        {
          case_id: 'case-3003',
          severity: 'medium',
          stage: 'ack',
          deadline_at: minutesAgo(-70),
          minutes_remaining: -70,
          status: 'breached',
        },
        {
          case_id: 'case-4003',
          severity: 'low',
          stage: 'ack',
          deadline_at: minutesAgo(-60),
          minutes_remaining: -60,
          status: 'breached',
        },
      ],
    });
  }),

  // ── Webhooks (admin-managed outbound delivery) ────────────────────
  //
  // MSW dev mode has no external recipients to call, so the "test fire"
  // handler synthesises a successful delivery row instead of actually
  // POSTing. The admin UI flow + delivery log behave identically — only
  // the wire send is stubbed.

  http.get('/v1/webhooks', () => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const items = _mockWebhookSubs.map(({ secret: _secret, ...rest }) => rest);
    return HttpResponse.json({ items });
  }),

  http.post('/v1/webhooks', async ({ request }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      url?: unknown;
      events?: unknown;
    };
    const errs: string[] = [];
    if (typeof body?.name !== 'string' || !body.name.trim()) errs.push('name is required');
    if (typeof body?.url !== 'string' || !/^https?:\/\//.test(body.url)) {
      errs.push('url must start with http:// or https://');
    }
    if (!Array.isArray(body?.events) || body.events.length === 0) {
      errs.push('events must be a non-empty array');
    } else {
      for (const e of body.events) {
        if (typeof e !== 'string' || !_validWebhookEvents.includes(e)) {
          errs.push(`unknown event type: ${String(e)}`);
        }
      }
    }
    if (errs.length > 0) return HttpResponse.json({ error: errs.join('; ') }, { status: 400 });

    // 64-char hex secret — same shape the BFF generates with crypto.randomBytes(32).
    const secret = Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
    const sub: MockWebhookSub = {
      id: `wh-${Math.random().toString(36).slice(2, 10)}`,
      name: (body.name as string).trim(),
      url: (body.url as string).trim(),
      secret,
      events: body.events as string[],
      active: true,
      created_at: new Date().toISOString(),
      last_delivery_at: null,
      last_delivery_status: null,
    };
    _mockWebhookSubs.unshift(sub);
    return HttpResponse.json(sub, { status: 201 });
  }),

  http.delete('/v1/webhooks/:id', ({ params }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const idx = _mockWebhookSubs.findIndex((s) => s.id === params.id);
    if (idx === -1) return HttpResponse.json({ error: 'subscription not found' }, { status: 404 });
    _mockWebhookSubs.splice(idx, 1);
    // Also drop the deliveries log for the removed subscription.
    for (let i = _mockWebhookDeliveries.length - 1; i >= 0; i--) {
      if (_mockWebhookDeliveries[i].subscription_id === params.id) {
        _mockWebhookDeliveries.splice(i, 1);
      }
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/v1/webhooks/:id/deliveries', ({ params }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const sub = _mockWebhookSubs.find((s) => s.id === params.id);
    if (!sub) return HttpResponse.json({ error: 'subscription not found' }, { status: 404 });
    const items = _mockWebhookDeliveries
      .filter((d) => d.subscription_id === params.id)
      .reverse();
    return HttpResponse.json({ items });
  }),

  http.post('/v1/webhooks/:id/test', ({ params }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const sub = _mockWebhookSubs.find((s) => s.id === params.id);
    if (!sub) return HttpResponse.json({ error: 'subscription not found' }, { status: 404 });
    const ts = new Date().toISOString();
    const delivery: MockWebhookDelivery = {
      id: `wd-${Math.random().toString(36).slice(2, 10)}`,
      subscription_id: sub.id,
      event_type: 'webhook.test',
      payload: { message: 'APEX EWS webhook test event', subscription_id: sub.id, sent_at: ts },
      attempts: 1,
      status: 'success',
      response_status: 200,
      response_body: 'ok',
      created_at: ts,
      completed_at: ts,
    };
    _mockWebhookDeliveries.push(delivery);
    sub.last_delivery_at = ts;
    sub.last_delivery_status = 'success';
    return HttpResponse.json(delivery);
  }),

  // Integrations health — mirrors GET /v1/integrations/health from BFF.
  // Returns 4 upstreams; flips one to "down" so the SPA renders both
  // states. Latencies are random within realistic bands so the UI feels
  // alive on refresh.
  http.get('/v1/integrations/health', () => {
    const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));
    return HttpResponse.json({
      base_url: 'http://localhost:8091',
      generated_at: new Date().toISOString(),
      integrations: [
        {
          id: 'cbs',
          label: 'Core Banking System',
          probe_url: '/cbs/loans?page=1&page_size=1',
          latency_ms: rand(40, 130),
          status: 'up',
          http_status: 200,
        },
        {
          id: 'aml',
          label: 'AML Hub',
          probe_url: '/aml/outbound?limit=1',
          latency_ms: rand(90, 320),
          status: 'up',
          http_status: 200,
        },
        {
          id: 'ifrs9',
          label: 'IFRS 9 Engine',
          probe_url: '/ifrs9/stages/c-1001',
          latency_ms: rand(2000, 2100),
          status: 'down',
          http_status: 0,
          message: 'request timed out after 2000ms',
        },
        {
          id: 'collection',
          label: 'Collection System',
          probe_url: '/healthz',
          latency_ms: rand(40, 180),
          status: 'up',
          http_status: 200,
        },
      ],
    });
  }),

  // Reports — mirrors services/bff/src/reports/compute.ts at the wire
  // level (same payload shapes). MSW returns hand-tuned fixtures rather
  // than recomputing — the real BFF generates dynamic data, but the SPA
  // only needs the shape to render.
  http.get('/v1/reports/:type', ({ params, request }) => {
    const type = params.type as 'snapshot' | 'alerts' | 'cases' | 'rbi';
    const url = new URL(request.url);
    const period = (url.searchParams.get('period') ?? 'month') as
      | 'week'
      | 'month'
      | 'quarter';
    const format = url.searchParams.get('format') ?? 'json';

    if (!['snapshot', 'alerts', 'cases', 'rbi'].includes(type)) {
      return HttpResponse.json({ error: 'unknown report type' }, { status: 400 });
    }
    if (!['week', 'month', 'quarter'].includes(period)) {
      return HttpResponse.json({ error: 'unknown period' }, { status: 400 });
    }
    const payload = mockReport(type, period);
    if (format === 'csv') {
      const body = `metric,value\nreport_type,${type}\nperiod,${period}\ngenerated_at,${payload.generated_at}\n`;
      return new HttpResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${type}-${period}.csv"`,
        },
      });
    }
    return HttpResponse.json(payload);
  }),

  // Scenario engine — mirrors services/bff/src/scenario/engine.ts. The MSW
  // path uses a tiny portfolio (8 accounts, 3 products) so test runs stay
  // fast; the real BFF runs the same compute against 240 accounts.
  http.post('/v1/scenario/run', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      gdp?: unknown;
      rate?: unknown;
      fx?: unknown;
    };
    const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!isNum(body.gdp) || !isNum(body.rate) || !isNum(body.fx)) {
      return HttpResponse.json(
        { error: 'gdp, rate, fx must all be finite numbers' },
        { status: 400 },
      );
    }
    if (body.gdp < -8 || body.gdp > 4) {
      return HttpResponse.json({ error: 'gdp must be between -8 and 4' }, { status: 400 });
    }
    if (body.rate < -200 || body.rate > 400) {
      return HttpResponse.json({ error: 'rate must be between -200 and 400' }, { status: 400 });
    }
    if (body.fx < -10 || body.fx > 20) {
      return HttpResponse.json({ error: 'fx must be between -10 and 20' }, { status: 400 });
    }
    return HttpResponse.json(runMockScenario({ gdp: body.gdp, rate: body.rate, fx: body.fx }));
  }),

  // Saved-scenario endpoints — mirror services/bff/src/scenario/store.ts
  // (T4.18). MSW state lives in a Map so tests + the dev SPA can save,
  // list, and delete without hitting a real BFF. Reset between tests via
  // setupTests.ts (which calls server.resetHandlers()).
  http.get('/v1/scenarios', () => {
    const items = Array.from(mswScenarios.values()).sort((a, b) =>
      a.saved_at < b.saved_at ? 1 : a.saved_at > b.saved_at ? -1 : 0,
    );
    return HttpResponse.json({ items, total: items.length });
  }),
  http.post('/v1/scenarios', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      inputs?: { gdp?: number; rate?: number; fx?: number };
      result?: unknown;
    };
    if (!body.name?.trim()) {
      return HttpResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (
      !body.inputs ||
      typeof body.inputs.gdp !== 'number' ||
      typeof body.inputs.rate !== 'number' ||
      typeof body.inputs.fx !== 'number'
    ) {
      return HttpResponse.json(
        { error: 'inputs.{gdp,rate,fx} must all be numbers' },
        { status: 400 },
      );
    }
    // Honor the SPA's client-supplied id (T4.18) so the SPA's cache and
    // the server's row stay in lock-step. Fall back to a server-assigned
    // id if the client didn't pass one.
    const saved = {
      id: body.id ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: body.name.trim(),
      saved_by: 'msw-user',
      saved_at: new Date().toISOString(),
      inputs: body.inputs,
      result: body.result,
    };
    mswScenarios.set(saved.id, saved as MswSavedScenario);
    return HttpResponse.json(saved, { status: 201 });
  }),
  http.delete('/v1/scenarios/:id', ({ params }) => {
    const id = params.id as string;
    const ok = mswScenarios.delete(id);
    return ok ? new HttpResponse(null, { status: 204 }) : HttpResponse.json({ error: 'not found' }, { status: 404 });
  }),

  // ── Tenants (T4.24 Phase 12) — admin-managed multi-tenant registry ──
  // Returns enveloped responses to match the production BFF.
  http.get('/v1/tenants/me', () => {
    // SPA dev: assume the caller is in BANK_DEMO unless they've opted into
    // BIL via X-Tenant-ID header. (MSW doesn't actually route by header,
    // so this is a coarse approximation good enough for local demo.)
    const me = _mockTenants.find((t) => t.tenant_id === 'BANK_DEMO')!;
    return HttpResponse.json(envelope(me));
  }),
  http.get('/v1/tenants', () => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json(
        envelopeError('EWS_403', 'admin role required', 'HIGH'),
        { status: 403 },
      );
    }
    return HttpResponse.json(
      envelope({ items: _mockTenants.slice(), total: _mockTenants.length }),
    );
  }),
  http.post('/v1/tenants', async ({ request }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json(
        envelopeError('EWS_403', 'admin role required', 'HIGH'),
        { status: 403 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Partial<MockTenant>;
    const errs: string[] = [];
    if (!body.tenant_id || !/^[A-Z][A-Z0-9_]{1,31}$/.test(body.tenant_id)) {
      errs.push('tenant_id must match ^[A-Z][A-Z0-9_]{1,31}$');
    }
    if (!body.name || !body.name.trim()) errs.push('name is required');
    if (body.vertical !== 'banking' && body.vertical !== 'insurance') {
      errs.push("vertical must be 'banking' or 'insurance'");
    }
    if (
      !Array.isArray(body.channels_allowed) ||
      body.channels_allowed.length === 0
    ) {
      errs.push('channels_allowed must be a non-empty array');
    }
    if (errs.length) {
      return HttpResponse.json(
        envelopeError('EWS_400', errs.join('; '), 'MEDIUM'),
        { status: 400 },
      );
    }
    if (_mockTenants.some((t) => t.tenant_id === body.tenant_id)) {
      return HttpResponse.json(
        envelopeError(
          'EWS_409',
          `tenant '${body.tenant_id}' already exists`,
          'MEDIUM',
          { tenant_id: body.tenant_id },
        ),
        { status: 409 },
      );
    }
    const created: MockTenant = {
      tenant_id: body.tenant_id!,
      name: body.name!,
      vertical: body.vertical as 'banking' | 'insurance',
      channels_allowed: body.channels_allowed!,
      active: body.active ?? true,
    };
    _mockTenants.push(created);
    return HttpResponse.json(envelope(created, 'EWS_201', 'Created'), { status: 201 });
  }),
  http.patch('/v1/tenants/:tenant_id', async ({ params, request }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json(
        envelopeError('EWS_403', 'admin role required', 'HIGH'),
        { status: 403 },
      );
    }
    const idx = _mockTenants.findIndex((t) => t.tenant_id === params.tenant_id);
    if (idx < 0) {
      return HttpResponse.json(
        envelopeError('EWS_404', `tenant '${params.tenant_id}' not found`, 'LOW'),
        { status: 404 },
      );
    }
    const patch = (await request.json().catch(() => ({}))) as Partial<MockTenant>;
    const t = _mockTenants[idx]!;
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.channels_allowed !== undefined) t.channels_allowed = patch.channels_allowed;
    if (patch.active !== undefined) t.active = patch.active;
    return HttpResponse.json(envelope(t));
  }),
  http.delete('/v1/tenants/:tenant_id', ({ params }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json(
        envelopeError('EWS_403', 'admin role required', 'HIGH'),
        { status: 403 },
      );
    }
    const id = params.tenant_id as string;
    if (_SYSTEM_TENANTS.has(id)) {
      return HttpResponse.json(
        envelopeError(
          'EWS_409',
          `tenant '${id}' is system-protected and cannot be deleted`,
          'MEDIUM',
        ),
        { status: 409 },
      );
    }
    const idx = _mockTenants.findIndex((t) => t.tenant_id === id);
    if (idx < 0) {
      return HttpResponse.json(
        envelopeError('EWS_404', `tenant '${id}' not found`, 'LOW'),
        { status: 404 },
      );
    }
    _mockTenants.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // ── Service-clients (T4.24 Phase 12) — admin-managed OAuth principals ──
  // Mirrors auth-svc raw shape (no envelope — auth-svc routes pre-date the
  // envelope migration). The plaintext secret is exposed exactly once on
  // create; subsequent reads strip it.
  http.get('/auth/service-clients', ({ request }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const url = new URL(request.url);
    const tenant = url.searchParams.get('tenant_id');
    const items = _mockServiceClients
      .filter((c) => !tenant || c.tenant_id === tenant)
      .map(({ client_secret_plaintext: _s, ...rest }) => rest);
    return HttpResponse.json({ items, total: items.length });
  }),
  http.post('/auth/service-clients', async ({ request }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as Partial<MockServiceClient>;
    const errs: string[] = [];
    if (!body.tenant_id || typeof body.tenant_id !== 'string') {
      errs.push('tenant_id is required');
    }
    if (
      !body.client_id ||
      typeof body.client_id !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(body.client_id)
    ) {
      errs.push('client_id must match ^[a-z0-9][a-z0-9._-]{2,63}$');
    }
    if (!body.display_name || typeof body.display_name !== 'string') {
      errs.push('display_name is required');
    }
    if (errs.length) {
      return HttpResponse.json(
        { error: 'invalid_request', message: errs.join('; ') },
        { status: 400 },
      );
    }
    if (
      _mockServiceClients.some(
        (c) => c.tenant_id === body.tenant_id && c.client_id === body.client_id,
      )
    ) {
      return HttpResponse.json(
        {
          error: 'client_exists',
          message: `service client '${body.client_id}' already exists for tenant '${body.tenant_id}'`,
          tenant_id: body.tenant_id,
          client_id: body.client_id,
        },
        { status: 409 },
      );
    }
    // 32 bytes hex — same length the auth-svc store uses.
    const secret = Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
    const created: MockServiceClient = {
      client_id: body.client_id!,
      tenant_id: body.tenant_id!,
      display_name: body.display_name!,
      scopes: Array.isArray(body.scopes) ? body.scopes : [],
      active: true,
      created_at: new Date().toISOString(),
      last_used_at: null,
      client_secret_plaintext: secret,
    };
    _mockServiceClients.push(created);
    const { client_secret_plaintext: _s, ...rest } = created;
    return HttpResponse.json({ ...rest, client_secret: secret }, { status: 201 });
  }),
  http.delete('/auth/service-clients/:tenant_id/:client_id', ({ params }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const idx = _mockServiceClients.findIndex(
      (c) =>
        c.tenant_id === params.tenant_id && c.client_id === params.client_id,
    );
    if (idx < 0) {
      return HttpResponse.json({ error: 'client_not_found' }, { status: 404 });
    }
    _mockServiceClients.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // ── User Access Override (BAC §3.1.6/§3.1.7) ────────────────────────

  http.get('/v1/admin/user-access-overrides', ({ request }) => {
    const url = new URL(request.url);
    const userId = url.searchParams.get('user_id');
    const status = url.searchParams.get('status');
    const modulePath = url.searchParams.get('module_path');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? 50)));
    let rows = mswOverrides.slice();
    if (userId) rows = rows.filter((o) => o.user_id === userId);
    if (status) {
      const set = new Set(status.split(',').map((s) => s.trim()));
      rows = rows.filter((o) => set.has(o.status));
    }
    if (modulePath) rows = rows.filter((o) => o.module_path === modulePath);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const start = (page - 1) * pageSize;
    return HttpResponse.json(
      envelope({ items: rows.slice(start, start + pageSize), total: rows.length, page, page_size: pageSize }),
    );
  }),

  http.get('/v1/admin/user-access-overrides/:id', ({ params }) => {
    const row = mswOverrides.find((o) => o.override_id === params.id);
    if (!row) return HttpResponse.json(envelopeError('EWS_404_not_found', `override ${params.id} not found`, 'LOW'), { status: 404 });
    return HttpResponse.json(envelope(row));
  }),

  // Note: bulk-revoke comes BEFORE the /:id handlers so MSW doesn't
  // route the literal "bulk-revoke" path segment as an :id.
  http.post('/v1/admin/user-access-overrides/bulk-revoke', async ({ request }) => {
    const body = (await request.json()) as { user_id?: string; revocation_reason?: string };
    if (!body.user_id) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'user_id required', 'MEDIUM'), { status: 400 });
    }
    const reason = (body.revocation_reason ?? '').trim();
    if (reason.length < 10) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'reason ≥ 10 chars required for bulk-revoke', 'MEDIUM'),
        { status: 400 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const revoked: MswOverride[] = [];
    for (let i = 0; i < mswOverrides.length; i++) {
      const before = mswOverrides[i];
      if (before.user_id !== body.user_id) continue;
      if (before.status !== 'ACTIVE') continue;
      const after: MswOverride = {
        ...before,
        status: 'REVOKED',
        revoked_by: actor,
        revoked_at: now,
        revocation_reason: reason,
        updated_at: now,
      };
      mswOverrides[i] = after;
      mswOverrideAudit.push({
        audit_id: `aud-${Date.now()}-${i}`,
        tenant_id: 'BANK_DEMO',
        entity_type: 'user_access_override',
        entity_id: before.override_id,
        action: 'revoke',
        actor_id: actor,
        actor_role: 'admin',
        before_state: before,
        after_state: after,
        reason,
        request_id: null,
        ip_address: null,
        user_agent: null,
        created_at: now,
      });
      revoked.push(after);
    }
    return HttpResponse.json(envelope({ revoked, count: revoked.length }));
  }),

  http.post('/v1/admin/user-access-overrides', async ({ request }) => {
    const body = (await request.json()) as MswCreateInput;
    const actor = readPersistedRole() ? 'alice.admin' : 'alice.admin';
    const now = new Date().toISOString();
    // Validation
    if (!body.user_id || !Array.isArray(body.module_paths) || body.module_paths.length === 0) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'user_id + non-empty module_paths required', 'MEDIUM'), { status: 400 });
    }
    if (!body.reason || body.reason.trim().length < 10) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'reason ≥ 10 chars required', 'MEDIUM'), { status: 400 });
    }
    if (body.effective_till && Date.parse(body.effective_till) <= Date.now()) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'effective_till cannot be in the past', 'MEDIUM'), { status: 400 });
    }
    // Duplicate check
    for (const path of body.module_paths) {
      const dup = mswOverrides.find(
        (o) =>
          o.user_id === body.user_id &&
          o.module_path === path &&
          o.permission_type === body.permission_type &&
          (o.status === 'ACTIVE' || o.status === 'PENDING_APPROVAL'),
      );
      if (dup) {
        return HttpResponse.json(
          envelopeError(
            'EWS_409_duplicate_active_override',
            `${body.user_id} already has ${dup.status.toLowerCase()} override on ${path}/${body.permission_type}`,
            'MEDIUM',
          ),
          { status: 409 },
        );
      }
    }
    const created: MswOverride[] = [];
    for (const path of body.module_paths) {
      const requiresApproval = body.requires_approval !== false;
      const row: MswOverride = {
        override_id: `ov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tenant_id: 'BANK_DEMO',
        user_id: body.user_id,
        module_path: path,
        override_type: body.override_type ?? 'GRANT',
        permission_type: body.permission_type ?? 'VIEW',
        effective_from: body.effective_from ?? now,
        effective_till: body.effective_till ?? null,
        reason: body.reason,
        requires_approval: requiresApproval,
        status: requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE',
        created_by: actor,
        approved_by: null,
        rejected_by: null,
        revoked_by: null,
        rejection_reason: null,
        revocation_reason: null,
        approval_note: null,
        created_at: now,
        updated_at: now,
        approved_at: null,
        rejected_at: null,
        revoked_at: null,
      };
      mswOverrides.push(row);
      mswOverrideAudit.push({
        audit_id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tenant_id: 'BANK_DEMO',
        entity_type: 'user_access_override',
        entity_id: row.override_id,
        action: 'create',
        actor_id: actor,
        actor_role: 'admin',
        before_state: null,
        after_state: row,
        reason: body.reason,
        request_id: null,
        ip_address: null,
        user_agent: null,
        created_at: now,
      });
      created.push(row);
    }
    return HttpResponse.json(envelope({ overrides: created, created: created.length }, 'EWS_201_created', 'Created'), { status: 201 });
  }),

  http.put('/v1/admin/user-access-overrides/:id', async ({ params, request }) => {
    const idx = mswOverrides.findIndex((o) => o.override_id === params.id);
    if (idx < 0) return HttpResponse.json(envelopeError('EWS_404_not_found', `override ${params.id} not found`, 'LOW'), { status: 404 });
    const before = mswOverrides[idx];
    if (before.status !== 'PENDING_APPROVAL') {
      return HttpResponse.json(envelopeError('EWS_409_invalid_state', `cannot edit override in status ${before.status}`, 'MEDIUM'), { status: 409 });
    }
    const patch = (await request.json()) as Partial<MswCreateInput>;
    const now = new Date().toISOString();
    const after: MswOverride = {
      ...before,
      override_type: patch.override_type ?? before.override_type,
      permission_type: patch.permission_type ?? before.permission_type,
      effective_from: patch.effective_from ?? before.effective_from,
      effective_till: patch.effective_till === undefined ? before.effective_till : patch.effective_till,
      reason: patch.reason ?? before.reason,
      module_path: (patch.module_paths && patch.module_paths[0]) ?? before.module_path,
      updated_at: now,
    };
    mswOverrides[idx] = after;
    return HttpResponse.json(envelope(after));
  }),

  http.post('/v1/admin/user-access-overrides/:id/approve', async ({ params, request }) => {
    const idx = mswOverrides.findIndex((o) => o.override_id === params.id);
    if (idx < 0) return HttpResponse.json(envelopeError('EWS_404_not_found', `override ${params.id} not found`, 'LOW'), { status: 404 });
    const before = mswOverrides[idx];
    if (before.status !== 'PENDING_APPROVAL') {
      return HttpResponse.json(envelopeError('EWS_409_invalid_state', `not pending`, 'MEDIUM'), { status: 409 });
    }
    const actor = readPersistedRole() === 'admin' ? readPersistedUsername() ?? 'sue.super' : 'sue.super';
    if (actor === before.created_by) {
      return HttpResponse.json(envelopeError('EWS_403_self_approval', 'maker cannot be checker', 'HIGH'), { status: 403 });
    }
    const note = ((await request.json().catch(() => ({}))) as { approval_note?: string }).approval_note ?? null;
    const now = new Date().toISOString();
    const after: MswOverride = { ...before, status: 'ACTIVE', approved_by: actor, approved_at: now, approval_note: note, updated_at: now };
    mswOverrides[idx] = after;
    mswOverrideAudit.push({
      audit_id: `aud-${Date.now()}`,
      tenant_id: 'BANK_DEMO', entity_type: 'user_access_override', entity_id: params.id as string,
      action: 'approve', actor_id: actor, actor_role: 'admin',
      before_state: before, after_state: after, reason: note, request_id: null, ip_address: null, user_agent: null, created_at: now,
    });
    return HttpResponse.json(envelope(after));
  }),

  http.post('/v1/admin/user-access-overrides/:id/reject', async ({ params, request }) => {
    const idx = mswOverrides.findIndex((o) => o.override_id === params.id);
    if (idx < 0) return HttpResponse.json(envelopeError('EWS_404_not_found', `override ${params.id} not found`, 'LOW'), { status: 404 });
    const before = mswOverrides[idx];
    if (before.status !== 'PENDING_APPROVAL') {
      return HttpResponse.json(envelopeError('EWS_409_invalid_state', `not pending`, 'MEDIUM'), { status: 409 });
    }
    const reason = ((await request.json()) as { rejection_reason?: string }).rejection_reason ?? '';
    if (reason.trim().length < 10) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'rejection_reason ≥ 10 chars required', 'MEDIUM'), { status: 400 });
    }
    const actor = readPersistedUsername() ?? 'sue.super';
    if (actor === before.created_by) {
      return HttpResponse.json(envelopeError('EWS_403_self_approval', 'maker cannot reject own request', 'HIGH'), { status: 403 });
    }
    const now = new Date().toISOString();
    const after: MswOverride = { ...before, status: 'REJECTED', rejected_by: actor, rejected_at: now, rejection_reason: reason, updated_at: now };
    mswOverrides[idx] = after;
    mswOverrideAudit.push({
      audit_id: `aud-${Date.now()}`,
      tenant_id: 'BANK_DEMO', entity_type: 'user_access_override', entity_id: params.id as string,
      action: 'reject', actor_id: actor, actor_role: 'admin',
      before_state: before, after_state: after, reason, request_id: null, ip_address: null, user_agent: null, created_at: now,
    });
    return HttpResponse.json(envelope(after));
  }),

  http.post('/v1/admin/user-access-overrides/:id/revoke', async ({ params, request }) => {
    const idx = mswOverrides.findIndex((o) => o.override_id === params.id);
    if (idx < 0) return HttpResponse.json(envelopeError('EWS_404_not_found', `override ${params.id} not found`, 'LOW'), { status: 404 });
    const before = mswOverrides[idx];
    if (before.status !== 'ACTIVE') {
      return HttpResponse.json(envelopeError('EWS_409_invalid_state', `only ACTIVE can be revoked`, 'MEDIUM'), { status: 409 });
    }
    const reason = ((await request.json()) as { revocation_reason?: string }).revocation_reason ?? '';
    if (reason.trim().length < 10) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'revocation_reason ≥ 10 chars required', 'MEDIUM'), { status: 400 });
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const after: MswOverride = { ...before, status: 'REVOKED', revoked_by: actor, revoked_at: now, revocation_reason: reason, updated_at: now };
    mswOverrides[idx] = after;
    mswOverrideAudit.push({
      audit_id: `aud-${Date.now()}`,
      tenant_id: 'BANK_DEMO', entity_type: 'user_access_override', entity_id: params.id as string,
      action: 'revoke', actor_id: actor, actor_role: 'admin',
      before_state: before, after_state: after, reason, request_id: null, ip_address: null, user_agent: null, created_at: now,
    });
    return HttpResponse.json(envelope(after));
  }),

  http.get('/v1/admin/users/:user_id/effective-access', ({ params }) => {
    const userId = params.user_id as string;
    // Mirror the BFF resolver: union role ACL + ACTIVE+in-force overrides.
    const roleAcl = mswMockRoleAcl(userId);
    const now = Date.now();
    const inForce = mswOverrides.filter((o) => {
      if (o.user_id !== userId) return false;
      if (o.status !== 'ACTIVE') return false;
      if (Date.parse(o.effective_from) > now) return false;
      if (o.effective_till && Date.parse(o.effective_till) <= now) return false;
      return true;
    });
    const merged = new Map<string, Set<string>>();
    const sources = new Map<string, Set<string>>();
    for (const r of roleAcl.modules) {
      merged.set(r.module_path, new Set(r.permissions));
      sources.set(r.module_path, new Set(['role']));
    }
    for (const o of inForce) {
      const cur = merged.get(o.module_path) ?? new Set<string>();
      const src = sources.get(o.module_path) ?? new Set<string>();
      if (o.override_type === 'GRANT') {
        cur.add(o.permission_type);
        src.add(`override:${o.override_id}`);
      } else if (o.permission_type === 'FULL') {
        cur.clear();
      } else {
        cur.delete(o.permission_type);
      }
      if (cur.size === 0) {
        merged.delete(o.module_path);
      } else {
        merged.set(o.module_path, cur);
        sources.set(o.module_path, src);
      }
    }
    const ORDER = ['VIEW', 'EDIT', 'APPROVE', 'FULL'];
    const effective = Array.from(merged.entries()).map(([path, perms]) => ({
      module_path: path,
      permissions: ORDER.filter((p) => perms.has(p)),
      source: Array.from(sources.get(path) ?? ['role']).sort().join(','),
    })).sort((a, b) => a.module_path.localeCompare(b.module_path));
    return HttpResponse.json(
      envelope({
        user_id: userId,
        computed_at: new Date().toISOString(),
        role_access: roleAcl,
        overrides_applied: inForce,
        effective,
      }),
    );
  }),

  http.get('/v1/admin/admin-audit-log', ({ request }) => {
    const url = new URL(request.url);
    const entityId = url.searchParams.get('entity_id');
    const actorId = url.searchParams.get('actor_id');
    let rows = mswOverrideAudit.slice();
    if (entityId) rows = rows.filter((a) => a.entity_id === entityId);
    if (actorId) rows = rows.filter((a) => a.actor_id === actorId);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return HttpResponse.json(envelope({ items: rows, total: rows.length, page: 1, page_size: 50 }));
  }),
];

// MSW state for the saved-scenario endpoints. Lives at module scope so
// tests across files don't accidentally share data — setupTests.ts
// resets it via the exported helper below.
interface MswSavedScenario {
  id: string;
  name: string;
  saved_by: string;
  saved_at: string;
  inputs: { gdp: number; rate: number; fx: number };
  result: unknown;
}
const mswScenarios = new Map<string, MswSavedScenario>();
export function __resetMswSavedScenarios(): void {
  mswScenarios.clear();
}

// MSW state for the per-role dashboard widget config (T4.23). Mirrors
// the auth-svc store shape — one entry per role, each value is an array
// of widget config rows. Reset between tests via __resetMswDashboardWidgets.
interface MswDashboardWidget {
  widget_id: string;
  sort_order: number;
  is_visible: boolean;
  updated_at: string;
  updated_by: string;
}
const mswDashboardWidgets = new Map<string, MswDashboardWidget[]>();
export function __resetMswDashboardWidgets(): void {
  mswDashboardWidgets.clear();
}

// ── Scenario mock compute ───────────────────────────────────────────────
//
// Smaller, hand-tuned portfolio for MSW. The real BFF stress engine has 240
// accounts and segment-specific elasticities; here we keep enough variety
// that the SPA renders all four product rows in the heatmap.

interface MockAccount {
  customer_id: string;
  name: string;
  product: 'mortgage' | 'auto' | 'personal' | 'sme';
  ead_kes: number;
  lgd: number;
  baseline_pd: number;
  income_band: 'low' | 'mid' | 'high';
  fx_exposed: boolean;
  tenure_months: number;
}

const MOCK_PORTFOLIO: MockAccount[] = [
  { customer_id: 'c-101', name: 'Achieng Otieno', product: 'mortgage', ead_kes: 5_000_000, lgd: 0.25, baseline_pd: 0.04, income_band: 'high', fx_exposed: false, tenure_months: 180 },
  { customer_id: 'c-102', name: 'Brian Kamau',    product: 'auto',     ead_kes: 1_200_000, lgd: 0.35, baseline_pd: 0.08, income_band: 'mid',  fx_exposed: false, tenure_months: 36 },
  { customer_id: 'c-103', name: 'Cynthia Mwangi', product: 'personal', ead_kes: 250_000,   lgd: 0.65, baseline_pd: 0.18, income_band: 'low',  fx_exposed: false, tenure_months: 18 },
  { customer_id: 'c-104', name: 'Daniel Wanjiku', product: 'sme',      ead_kes: 3_500_000, lgd: 0.5,  baseline_pd: 0.12, income_band: 'mid',  fx_exposed: true,  tenure_months: 36 },
  { customer_id: 'c-105', name: 'Esther Njeri',   product: 'personal', ead_kes: 400_000,   lgd: 0.65, baseline_pd: 0.22, income_band: 'low',  fx_exposed: false, tenure_months: 24 },
  { customer_id: 'c-106', name: 'Faisal Hussein', product: 'sme',      ead_kes: 2_500_000, lgd: 0.5,  baseline_pd: 0.15, income_band: 'mid',  fx_exposed: true,  tenure_months: 24 },
  { customer_id: 'c-107', name: 'Grace Mutua',    product: 'mortgage', ead_kes: 7_500_000, lgd: 0.25, baseline_pd: 0.05, income_band: 'high', fx_exposed: false, tenure_months: 240 },
  { customer_id: 'c-108', name: 'Hassan Owino',   product: 'auto',     ead_kes: 1_800_000, lgd: 0.35, baseline_pd: 0.10, income_band: 'mid',  fx_exposed: false, tenure_months: 48 },
];

function stressMockPd(a: MockAccount, s: { gdp: number; rate: number; fx: number }): number {
  const incomeElast = { low: 0.045, mid: 0.028, high: 0.015 }[a.income_band];
  const productSens = { mortgage: 0.00018, auto: 0.0004, personal: 0.00075, sme: 0.00055 }[a.product];
  const tenor = Math.min(1, a.tenure_months / 36);
  const mult =
    1 +
    -s.gdp * incomeElast +
    s.rate * productSens * tenor +
    (a.fx_exposed ? s.fx * 0.012 : 0);
  return Math.min(0.95, a.baseline_pd * Math.max(0.1, mult));
}

function bandFor(pd: number): 'low' | 'medium' | 'high' {
  if (pd < 0.05) return 'low';
  if (pd < 0.2) return 'medium';
  return 'high';
}

// IFRS 9 stage from PD — must mirror services/bff/src/scenario/engine.ts
// stageFromPd(). Cutoffs intentionally match bandFor() in the prototype.
function stageFromPd(pd: number): 1 | 2 | 3 {
  if (pd < 0.05) return 1;
  if (pd < 0.2) return 2;
  return 3;
}

function runMockScenario(s: { gdp: number; rate: number; fx: number }) {
  const scored = MOCK_PORTFOLIO.map((a) => {
    const stressed_pd = stressMockPd(a, s);
    return {
      a,
      baseline_pd: a.baseline_pd,
      stressed_pd,
      baseline_ecl: a.ead_kes * a.baseline_pd * a.lgd,
      stressed_ecl: a.ead_kes * stressed_pd * a.lgd,
    };
  });
  const baseline_bands = { low: 0, medium: 0, high: 0 };
  const stressed_bands = { low: 0, medium: 0, high: 0 };
  const baseline_stages = { stage_1: 0, stage_2: 0, stage_3: 0 };
  const stressed_stages = { stage_1: 0, stage_2: 0, stage_3: 0 };
  const stage_migration = {
    s1: { s1: 0, s2: 0, s3: 0 },
    s2: { s1: 0, s2: 0, s3: 0 },
    s3: { s1: 0, s2: 0, s3: 0 },
  };
  const segmentRiskBuckets = new Map<
    string,
    { baseline: { low: number; medium: number; high: number }; stressed: { low: number; medium: number; high: number } }
  >();
  for (const x of scored) {
    baseline_bands[bandFor(x.baseline_pd)]++;
    stressed_bands[bandFor(x.stressed_pd)]++;
    const fromStage = stageFromPd(x.baseline_pd);
    const toStage = stageFromPd(x.stressed_pd);
    baseline_stages[`stage_${fromStage}` as const]++;
    stressed_stages[`stage_${toStage}` as const]++;
    stage_migration[`s${fromStage}` as 's1' | 's2' | 's3'][`s${toStage}` as 's1' | 's2' | 's3']++;
    const cell = segmentRiskBuckets.get(x.a.product) ?? {
      baseline: { low: 0, medium: 0, high: 0 },
      stressed: { low: 0, medium: 0, high: 0 },
    };
    cell.baseline[bandFor(x.baseline_pd)]++;
    cell.stressed[bandFor(x.stressed_pd)]++;
    segmentRiskBuckets.set(x.a.product, cell);
  }
  const segment_risk_matrix = Array.from(segmentRiskBuckets.entries())
    .map(([segment, { baseline, stressed }]) => ({ segment, baseline, stressed }))
    .sort((a, b) => b.stressed.high - a.stressed.high);

  const totalEad = scored.reduce((acc, x) => acc + x.a.ead_kes, 0);
  const baselineEcl = scored.reduce((acc, x) => acc + x.baseline_ecl, 0);
  const stressedEcl = scored.reduce((acc, x) => acc + x.stressed_ecl, 0);

  // EAD-weighted portfolio PD + count-based NPA share. Mirrors engine.ts.
  const safeEad = Math.max(1, totalEad);
  const baseline_portfolio_pd =
    Math.round(
      (scored.reduce((acc, x) => acc + x.baseline_pd * x.a.ead_kes, 0) / safeEad) * 10000,
    ) / 10000;
  const stressed_portfolio_pd =
    Math.round(
      (scored.reduce((acc, x) => acc + x.stressed_pd * x.a.ead_kes, 0) / safeEad) * 10000,
    ) / 10000;
  const baseline_npa_pct =
    Math.round((baseline_stages.stage_3 / Math.max(1, MOCK_PORTFOLIO.length)) * 10000) / 10000;
  const stressed_npa_pct =
    Math.round((stressed_stages.stage_3 / Math.max(1, MOCK_PORTFOLIO.length)) * 10000) / 10000;

  const productMap = new Map<string, typeof scored>();
  for (const x of scored) {
    const arr = productMap.get(x.a.product) ?? [];
    arr.push(x);
    productMap.set(x.a.product, arr);
  }
  const segments = Array.from(productMap.entries())
    .map(([segment, arr]) => {
      const segEad = arr.reduce((acc, x) => acc + x.a.ead_kes, 0);
      const wB =
        arr.reduce((acc, x) => acc + x.baseline_pd * x.a.ead_kes, 0) / Math.max(1, segEad);
      const wS =
        arr.reduce((acc, x) => acc + x.stressed_pd * x.a.ead_kes, 0) / Math.max(1, segEad);
      const ecl = arr.reduce((acc, x) => acc + (x.stressed_ecl - x.baseline_ecl), 0);
      return {
        segment,
        accounts: arr.length,
        baseline_pd: Math.round(wB * 10000) / 10000,
        stressed_pd: Math.round(wS * 10000) / 10000,
        pd_delta_pp: Math.round((wS - wB) * 10000) / 100,
        ecl_delta_kes: Math.round(ecl),
      };
    })
    .sort((a, b) => Math.abs(b.ecl_delta_kes) - Math.abs(a.ecl_delta_kes));

  const top_affected = [...scored]
    .sort((a, b) => Math.abs(b.stressed_pd - b.baseline_pd) - Math.abs(a.stressed_pd - a.baseline_pd))
    .slice(0, 10)
    .map((x) => ({
      customer_id: x.a.customer_id,
      name: x.a.name,
      product: x.a.product,
      baseline_pd: Math.round(x.baseline_pd * 10000) / 10000,
      stressed_pd: Math.round(x.stressed_pd * 10000) / 10000,
      pd_delta_pp: Math.round((x.stressed_pd - x.baseline_pd) * 10000) / 100,
      ead_kes: x.a.ead_kes,
      ecl_delta_kes: Math.round(x.stressed_ecl - x.baseline_ecl),
    }));

  return {
    inputs: s,
    portfolio_size: MOCK_PORTFOLIO.length,
    total_ead_kes: Math.round(totalEad),
    baseline_ecl_kes: Math.round(baselineEcl),
    stressed_ecl_kes: Math.round(stressedEcl),
    ecl_delta_kes: Math.round(stressedEcl - baselineEcl),
    baseline_bands,
    stressed_bands,
    baseline_stages,
    stressed_stages,
    stage_migration,
    segments,
    segment_risk_matrix,
    baseline_portfolio_pd,
    stressed_portfolio_pd,
    baseline_npa_pct,
    stressed_npa_pct,
    top_affected,
    computed_at: new Date().toISOString(),
  };
}

// ── Reports mock fixtures ───────────────────────────────────────────────
//
// One fixed payload per report type. Real BFF generates dynamic data; for
// MSW we hand-tune values that exercise every section the SPA renders.

function reportMeta(type: string, period: 'week' | 'month' | 'quarter') {
  const now = new Date();
  const start = new Date(now);
  if (period === 'week') start.setUTCDate(start.getUTCDate() - 7);
  else if (period === 'month') start.setUTCMonth(start.getUTCMonth() - 1);
  else start.setUTCMonth(start.getUTCMonth() - 3);
  return {
    type,
    period,
    generated_at: now.toISOString(),
    period_start: start.toISOString(),
    period_end: now.toISOString(),
  };
}

function mockReport(
  type: 'snapshot' | 'alerts' | 'cases' | 'rbi',
  period: 'week' | 'month' | 'quarter',
) {
  const meta = reportMeta(type, period);
  if (type === 'snapshot') {
    return {
      ...meta,
      customers_monitored: 240,
      high_risk_customers: 28,
      high_risk_pct: 11.7,
      total_exposure_kes: 1_245_800_000,
      alerts_open: 14,
      cases_in_progress: 9,
      stage_distribution: { stage_1: 184, stage_2: 38, stage_3: 18 },
      expected_credit_loss_kes: 22_400_000,
      npa_pct: 7.5,
    };
  }
  if (type === 'alerts') {
    return {
      ...meta,
      raised_by_severity: { critical: 6, high: 18, medium: 41, low: 65 },
      raised_total: 130,
      closed_total: 112,
      avg_minutes_to_ack: 42.5,
      avg_minutes_to_close: 1340.2,
      top_rules: [
        { rule_id: 'r-22', rule_name: 'Salary inflow stopped 60d', firings: 28 },
        { rule_id: 'r-09', rule_name: 'DPD ≥ 30 + utilisation > 95%', firings: 21 },
        { rule_id: 'r-14', rule_name: 'Cheque return 2× in 30d', firings: 18 },
        { rule_id: 'r-15', rule_name: 'Net flow drop 30d > 40%', firings: 14 },
        { rule_id: 'r-03', rule_name: 'Bureau score drop > 50 pts', firings: 11 },
      ],
      open_at_end: 18,
    };
  }
  if (type === 'cases') {
    return {
      ...meta,
      cases_opened: 42,
      cases_closed: 38,
      outcomes: { cured: 22, cured_temp: 9, defaulted: 7 },
      avg_days_to_close: 11.3,
      top_officers: [
        { officer_id: 'officer.alpha', cases_closed: 12 },
        { officer_id: 'officer.beta', cases_closed: 9 },
        { officer_id: 'officer.gamma', cases_closed: 8 },
        { officer_id: 'officer.delta', cases_closed: 5 },
        { officer_id: 'officer.epsilon', cases_closed: 4 },
      ],
      product_breakdown: [
        { product: 'personal', cases_closed: 14 },
        { product: 'sme', cases_closed: 11 },
        { product: 'auto', cases_closed: 8 },
        { product: 'mortgage', cases_closed: 5 },
      ],
    };
  }
  // rbi
  return {
    ...meta,
    sector_exposure: [
      { sector: 'mortgage', exposure_kes: 620_000_000, share_pct: 49.8 },
      { sector: 'sme', exposure_kes: 320_000_000, share_pct: 25.7 },
      { sector: 'auto', exposure_kes: 215_000_000, share_pct: 17.3 },
      { sector: 'personal', exposure_kes: 90_800_000, share_pct: 7.2 },
    ],
    risk_band_distribution: [
      { band: 'low', accounts: 168, share_pct: 70.0 },
      { band: 'medium', accounts: 54, share_pct: 22.5 },
      { band: 'high', accounts: 18, share_pct: 7.5 },
    ],
    ecl_kes: 22_400_000,
    ecl_qoq_delta_kes: -896_000,
    npa_pct: 7.5,
    top_concentrations: [
      { customer_id: 'c-1107', name: 'Grace Mutua', exposure_kes: 11_900_000 },
      { customer_id: 'c-1023', name: 'Faisal Hussein', exposure_kes: 9_200_000 },
      { customer_id: 'c-1052', name: 'Daniel Wanjiku', exposure_kes: 8_400_000 },
      { customer_id: 'c-1089', name: 'Brian Kamau', exposure_kes: 7_300_000 },
      { customer_id: 'c-1041', name: 'Achieng Otieno', exposure_kes: 6_500_000 },
    ],
  };
}

// ── Rules v2 mock fixtures ──────────────────────────────────────────────
//
// Hand-tuned to mirror the BFF seed in services/bff/src/rules/seed.ts —
// every state in the maker-checker lifecycle + at least three product
// scopes so the SPA filters/badges have something to render.

interface MockBankingVariable {
  id: string;
  category: 'account' | 'loan' | 'customer' | 'transaction' | 'external';
  label: string;
  description: string;
  type: 'number' | 'percent' | 'count' | 'days' | 'amount_kes' | 'flag' | 'enum';
  enum_values?: string[];
  refresh: 'realtime' | 'daily' | 'monthly' | 'quarterly';
  unit?: string;
}

const MOCK_VAR_LIBRARY: MockBankingVariable[] = [
  { id: 'avg_monthly_balance', category: 'account', label: 'Average monthly balance', description: 'Mean EOD balance across the month.', type: 'amount_kes', refresh: 'daily', unit: 'KES' },
  { id: 'salary_credit_consistency', category: 'account', label: 'Salary credit consistency', description: 'Share of expected salary credits within ±2 days.', type: 'percent', refresh: 'monthly' },
  { id: 'balance_drop_30d_pct', category: 'account', label: 'Balance drop 30d %', description: 'Percentage decline in EOD balance over the last 30 days.', type: 'percent', refresh: 'daily' },
  { id: 'current_dpd', category: 'loan', label: 'Current DPD', description: 'Days past due on any active EMI.', type: 'days', refresh: 'daily' },
  { id: 'utilization', category: 'loan', label: 'Utilisation', description: 'For revolving credit — drawn ÷ approved limit.', type: 'percent', refresh: 'daily' },
  { id: 'emi_bounce_count_90d', category: 'loan', label: 'EMI bounce count (90d)', description: 'EMIs returned unpaid in the last 90 days.', type: 'count', refresh: 'daily' },
  { id: 'bureau_score', category: 'customer', label: 'Bureau score (current)', description: 'Latest CIBIL/Experian score.', type: 'number', refresh: 'monthly' },
  { id: 'enquiries_30d', category: 'customer', label: 'Bureau enquiries (30d)', description: 'Credit enquiries pulled by other lenders.', type: 'count', refresh: 'daily' },
  { id: 'cheque_return_count_30d', category: 'transaction', label: 'Cheque returns (30d)', description: 'Presented cheques returned unpaid.', type: 'count', refresh: 'daily' },
  { id: 'cash_withdrawal_pct_income', category: 'transaction', label: 'Cash withdrawal % of income', description: 'Cash + ATM withdrawals as a share of monthly income.', type: 'percent', refresh: 'daily' },
  { id: 'industry_risk_grade', category: 'external', label: 'Industry risk grade (MSME)', description: 'A–E grade by sector.', type: 'enum', enum_values: ['A', 'B', 'C', 'D', 'E'], refresh: 'quarterly' },
  { id: 'gst_filing_regularity', category: 'external', label: 'GST filing regularity', description: 'Share of expected GSTR-3B filings on time.', type: 'percent', refresh: 'monthly' },
];

function rulesV2Variables() {
  const grouped: Record<string, MockBankingVariable[]> = {
    account: [], loan: [], customer: [], transaction: [], external: [],
  };
  for (const v of MOCK_VAR_LIBRARY) grouped[v.category].push(v);
  return grouped;
}

interface MockRule {
  id: string;
  name: string;
  family: 'Financial' | 'Behavioural' | 'Transaction' | 'Credit';
  applicable_products: string[];
  state: 'draft' | 'pending_review' | 'approved' | 'active' | 'rejected' | 'deprecated';
  version: string;
  owner_id: string;
  submitted_by?: string | null;
  approved_by?: string | null;
  conditions: unknown;
  outcome: { severity: string; alert_priority: string; notify_roles: string[]; reason_template?: string };
  regulatory_ref?: string;
  created_at: string;
  updated_at: string;
  audit: Array<{ ts: string; actor_id: string; actor_role: string; kind: string; to_state: string; comment?: string; version?: string }>;
}

interface MockRuleEnvelope {
  rule: MockRule;
  performance: {
    rule_id: string;
    triggers_today: number;
    triggers_week: number;
    triggers_month: number;
    true_positive_rate: number;
    false_positive_rate: number;
    avg_days_to_default: number;
    officer_useful_pct: number;
    status: 'performing' | 'underperforming' | 'deprecated' | 'no_data';
  };
  legal_transitions: string[];
}

function legalTransitionsFor(state: string): string[] {
  switch (state) {
    case 'draft': return ['edit', 'submit'];
    case 'pending_review': return ['approve', 'reject'];
    case 'approved': return ['activate', 'deprecate'];
    case 'active': return ['deprecate', 'edit'];
    default: return [];
  }
}

function rulesV2Seed(): MockRuleEnvelope[] {
  return [
    {
      rule: {
        id: 'r-22', name: 'Salary inflow stopped 60d', family: 'Behavioural',
        applicable_products: ['personal_loan', 'credit_card'], state: 'active', version: '2.1.0',
        owner_id: 'risk.maker.alpha', submitted_by: 'risk.maker.alpha', approved_by: 'risk.checker.delta',
        conditions: { kind: 'group', op: 'AND', children: [
          { kind: 'leaf', condition: { variable_id: 'salary_credit_consistency', op: '<', value: 0.2, window_days: 60 } },
        ] },
        outcome: { severity: 'critical', alert_priority: 'P1', notify_roles: ['risk_analyst', 'branch_manager'], reason_template: 'Salary inflow gap > 60d' },
        regulatory_ref: 'Internal SOP §4.2',
        created_at: '2026-01-12T08:00:00Z', updated_at: '2026-04-22T11:30:00Z',
        audit: [
          { ts: '2026-01-12T08:00:00Z', actor_id: 'risk.maker.alpha', actor_role: 'risk_analyst', kind: 'created', to_state: 'draft', version: '1.0.0' },
          { ts: '2026-01-13T09:15:00Z', actor_id: 'risk.checker.delta', actor_role: 'supervisor', kind: 'approved', to_state: 'approved' },
          { ts: '2026-01-13T11:00:00Z', actor_id: 'cro.kumar', actor_role: 'admin', kind: 'activated', to_state: 'active' },
        ],
      },
      performance: { rule_id: 'r-22', triggers_today: 1, triggers_week: 6, triggers_month: 24, true_positive_rate: 78, false_positive_rate: 22, avg_days_to_default: 18, officer_useful_pct: 82, status: 'performing' },
      legal_transitions: legalTransitionsFor('active'),
    },
    {
      rule: {
        id: 'r-09', name: 'DPD ≥ 30 + utilisation > 95%', family: 'Financial',
        applicable_products: ['credit_card'], state: 'active', version: '1.4.0',
        owner_id: 'risk.maker.beta', submitted_by: 'risk.maker.beta', approved_by: 'risk.checker.delta',
        conditions: { kind: 'group', op: 'AND', children: [
          { kind: 'leaf', condition: { variable_id: 'current_dpd', op: '>=', value: 30 } },
          { kind: 'leaf', condition: { variable_id: 'utilization', op: '>', value: 0.95 } },
        ] },
        outcome: { severity: 'high', alert_priority: 'P2', notify_roles: ['collection_officer', 'supervisor'] },
        regulatory_ref: 'RBI Master Circular on Credit Card Operations',
        created_at: '2026-02-01T08:00:00Z', updated_at: '2026-04-18T14:20:00Z',
        audit: [
          { ts: '2026-02-01T08:00:00Z', actor_id: 'risk.maker.beta', actor_role: 'risk_analyst', kind: 'created', to_state: 'draft' },
          { ts: '2026-02-02T16:00:00Z', actor_id: 'cro.kumar', actor_role: 'admin', kind: 'activated', to_state: 'active' },
        ],
      },
      performance: { rule_id: 'r-09', triggers_today: 2, triggers_week: 13, triggers_month: 48, true_positive_rate: 62, false_positive_rate: 38, avg_days_to_default: 22, officer_useful_pct: 71, status: 'performing' },
      legal_transitions: legalTransitionsFor('active'),
    },
    {
      rule: {
        id: 'r-14', name: 'Cheque return 2× in 30d', family: 'Transaction',
        applicable_products: ['msme'], state: 'pending_review', version: '0.9.0',
        owner_id: 'fraud.maker.gamma', submitted_by: 'fraud.maker.gamma', approved_by: null,
        conditions: { kind: 'group', op: 'AND', children: [
          { kind: 'leaf', condition: { variable_id: 'cheque_return_count_30d', op: '>=', value: 2, window_days: 30 } },
        ] },
        outcome: { severity: 'medium', alert_priority: 'P3', notify_roles: ['risk_analyst'] },
        created_at: '2026-04-25T09:00:00Z', updated_at: '2026-04-26T15:30:00Z',
        audit: [
          { ts: '2026-04-25T09:00:00Z', actor_id: 'fraud.maker.gamma', actor_role: 'risk_analyst', kind: 'created', to_state: 'draft' },
          { ts: '2026-04-26T15:30:00Z', actor_id: 'fraud.maker.gamma', actor_role: 'risk_analyst', kind: 'submitted', to_state: 'pending_review' },
        ],
      },
      performance: { rule_id: 'r-14', triggers_today: 0, triggers_week: 0, triggers_month: 0, true_positive_rate: 0, false_positive_rate: 0, avg_days_to_default: 0, officer_useful_pct: 0, status: 'no_data' },
      legal_transitions: legalTransitionsFor('pending_review'),
    },
    {
      rule: {
        id: 'r-03', name: 'Bureau enquiry surge', family: 'Credit',
        applicable_products: [], state: 'draft', version: '0.2.0',
        owner_id: 'risk.maker.alpha',
        conditions: { kind: 'group', op: 'AND', children: [
          { kind: 'leaf', condition: { variable_id: 'enquiries_30d', op: '>=', value: 3 } },
        ] },
        outcome: { severity: 'low', alert_priority: 'P4', notify_roles: ['risk_analyst'] },
        created_at: '2026-04-26T11:00:00Z', updated_at: '2026-04-28T08:00:00Z',
        audit: [
          { ts: '2026-04-26T11:00:00Z', actor_id: 'risk.maker.alpha', actor_role: 'risk_analyst', kind: 'created', to_state: 'draft' },
        ],
      },
      performance: { rule_id: 'r-03', triggers_today: 0, triggers_week: 0, triggers_month: 0, true_positive_rate: 0, false_positive_rate: 0, avg_days_to_default: 0, officer_useful_pct: 0, status: 'no_data' },
      legal_transitions: legalTransitionsFor('draft'),
    },
    {
      rule: {
        id: 'r-18', name: 'Sudden cash withdrawal pattern', family: 'Transaction',
        applicable_products: ['personal_loan', 'credit_card'], state: 'approved', version: '1.0.1',
        owner_id: 'aml.maker.kappa', submitted_by: 'aml.maker.kappa', approved_by: 'risk.checker.delta',
        conditions: { kind: 'group', op: 'OR', children: [
          { kind: 'leaf', condition: { variable_id: 'cash_withdrawal_pct_income', op: '>', value: 0.6 } },
        ] },
        outcome: { severity: 'high', alert_priority: 'P2', notify_roles: ['supervisor', 'collection_officer'] },
        regulatory_ref: 'AML monitoring SOP §3.1',
        created_at: '2026-04-15T08:00:00Z', updated_at: '2026-04-27T12:00:00Z',
        audit: [
          { ts: '2026-04-15T08:00:00Z', actor_id: 'aml.maker.kappa', actor_role: 'risk_analyst', kind: 'created', to_state: 'draft' },
          { ts: '2026-04-27T12:00:00Z', actor_id: 'risk.checker.delta', actor_role: 'supervisor', kind: 'approved', to_state: 'approved' },
        ],
      },
      performance: { rule_id: 'r-18', triggers_today: 0, triggers_week: 0, triggers_month: 0, true_positive_rate: 0, false_positive_rate: 0, avg_days_to_default: 0, officer_useful_pct: 0, status: 'no_data' },
      legal_transitions: legalTransitionsFor('approved'),
    },
    {
      rule: {
        id: 'r-25', name: 'Multi-bureau delinquency confirmed', family: 'Credit',
        applicable_products: [], state: 'deprecated', version: '0.5.0',
        owner_id: 'risk.maker.beta', submitted_by: 'risk.maker.beta', approved_by: 'risk.checker.delta',
        conditions: { kind: 'group', op: 'AND', children: [
          { kind: 'leaf', condition: { variable_id: 'bureau_score', op: '<', value: 580 } },
        ] },
        outcome: { severity: 'critical', alert_priority: 'P1', notify_roles: ['supervisor', 'branch_manager'] },
        created_at: '2025-09-10T08:00:00Z', updated_at: '2026-03-30T16:00:00Z',
        audit: [
          { ts: '2025-09-10T08:00:00Z', actor_id: 'risk.maker.beta', actor_role: 'risk_analyst', kind: 'created', to_state: 'draft' },
          { ts: '2026-03-30T16:00:00Z', actor_id: 'cro.kumar', actor_role: 'admin', kind: 'deprecated', to_state: 'deprecated', comment: 'Replaced by r-09' },
        ],
      },
      performance: { rule_id: 'r-25', triggers_today: 0, triggers_week: 0, triggers_month: 0, true_positive_rate: 0, false_positive_rate: 0, avg_days_to_default: 0, officer_useful_pct: 0, status: 'deprecated' },
      legal_transitions: [],
    },
  ];
}

function rulesV2Backtest(ruleId: string) {
  const now = new Date();
  const monthly: { month: string; count: number }[] = [];
  let total = 0;
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - i);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const count = 8 + ((i * 7 + ruleId.length) % 25);
    monthly.push({ month, count }); total += count;
  }
  const tp = Math.round(total * 0.62);
  return {
    rule_id: ruleId,
    window_start: new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10),
    window_end: now.toISOString().slice(0, 10),
    total_alerts: total,
    true_positives: tp,
    false_positives: total - tp,
    coverage_pct: 28.4,
    precision_pct: 62.0,
    avg_days_to_default: 22,
    monthly_volume: monthly,
  };
}
