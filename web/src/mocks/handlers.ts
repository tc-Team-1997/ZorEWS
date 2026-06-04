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
  Alert,
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

// Recovery Center mock state. Seeded with 2 examples so the SPA renders
// out of the box; deletion paths in MSW for webhooks/scenarios push new
// records here (see http.delete('/v1/webhooks/:id') etc.).
interface MockDeletedRecord {
  recovery_id: string;
  tenant_id: string;
  module: 'bff' | 'auth-svc' | 'cases-svc' | 'alerts-svc' | 'rules-svc';
  entity_type: string;
  original_id: string;
  original_table: string;
  payload: Record<string, unknown>;
  deleted_by: string;
  deleted_at: string;
  deletion_reason: string | null;
  source_action: string | null;
  prior_status: string | null;
  restored_at: string | null;
  restored_by: string | null;
  purged_at: string | null;
  purged_by: string | null;
  status: 'archived' | 'restored' | 'purged';
}
const _mockDeletedRecords: MockDeletedRecord[] = [
  {
    recovery_id: 'rec-seed-1',
    tenant_id: 'BANK_DEMO',
    module: 'bff',
    entity_type: 'webhook_subscription',
    original_id: 'wh-demo01',
    original_table: 'app_bff.webhook_subscriptions',
    payload: {
      id: 'wh-demo01',
      name: 'Slack #risk-alerts (deprecated)',
      url: 'https://hooks.slack.com/services/T0000/B0000/old',
      events: ['alert.created'],
      active: false,
    },
    deleted_by: 'alice.admin',
    deleted_at: new Date(Date.now() - 86400 * 1000 * 2).toISOString(),
    deletion_reason: 'replaced by PagerDuty integration',
    source_action: 'user_initiated',
    prior_status: 'inactive',
    restored_at: null,
    restored_by: null,
    purged_at: null,
    purged_by: null,
    status: 'archived',
  },
  {
    recovery_id: 'rec-seed-2',
    tenant_id: 'BANK_DEMO',
    module: 'bff',
    entity_type: 'saved_scenario',
    original_id: 's-2026-q1-stress',
    original_table: 'app_scenario.saved_scenarios',
    payload: {
      id: 's-2026-q1-stress',
      name: 'Q1 stress test (legacy)',
      inputs: { gdp: -2, rate: 200, fx: 8 },
      result: { portfolio_pd: 0.08 },
    },
    deleted_by: 'ravi.risk',
    deleted_at: new Date(Date.now() - 86400 * 1000 * 5).toISOString(),
    deletion_reason: null,
    source_action: 'user_initiated',
    prior_status: null,
    restored_at: null,
    restored_by: null,
    purged_at: null,
    purged_by: null,
    status: 'archived',
  },
];
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
  /** Multi-source per the BFF type union: user_access_override (the
   *  legacy seed), report_export (BAC §3.1.8), ews_rule_version (RP-1). */
  entity_type: 'user_access_override' | 'report_export' | 'ews_rule_version';
  entity_id: string;
  action: 'create' | 'update' | 'approve' | 'reject' | 'revoke' | 'expire' | 'export' | 'view' | 'revert';
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

// Extra audit seeds for the AdminActivityPage demo: a couple of report
// exports + a rule revert. These are read-only — never appended to.
const mswExtraAuditSeeds: MswOverrideAudit[] = [
  {
    audit_id: 'aud-export-1',
    tenant_id: 'BANK_DEMO',
    entity_type: 'report_export',
    entity_id: 'cases:detail',
    action: 'export',
    actor_id: 'taniya',
    actor_role: 'admin',
    before_state: null,
    after_state: { format: 'csv', rows: 8, bytes: 1506, duration_ms: 31, filters: { ageBucket: '8-30d' } },
    reason: null,
    request_id: null,
    ip_address: '127.0.0.1',
    user_agent: 'Mozilla/5.0 (smoke)',
    created_at: '2026-05-08T16:11:03.284Z',
  },
  {
    audit_id: 'aud-export-2',
    tenant_id: 'BANK_DEMO',
    entity_type: 'report_export',
    entity_id: 'cases:detail',
    action: 'export',
    actor_id: 'taniya',
    actor_role: 'admin',
    before_state: null,
    after_state: { format: 'pdf', rows: 8, bytes: 2551, duration_ms: 84 },
    reason: null,
    request_id: null,
    ip_address: '127.0.0.1',
    user_agent: 'Mozilla/5.0 (smoke)',
    created_at: '2026-05-08T16:11:03.249Z',
  },
  {
    audit_id: 'aud-revert-1',
    tenant_id: 'BANK_DEMO',
    entity_type: 'ews_rule_version',
    entity_id: 'rule-version-uuid-1',
    action: 'revert',
    actor_id: 'alice',
    actor_role: 'admin',
    before_state: null,
    after_state: {
      rule_id: 'RULE_CREDIT_001',
      reverted_to_semver: '1.0.0',
      new_semver: '1.2.1',
      new_version_id: 'rule-version-uuid-1',
      reason: 'production caused regression — rollback',
    },
    reason: null,
    request_id: null,
    ip_address: '127.0.0.1',
    user_agent: 'Mozilla/5.0 (smoke)',
    created_at: '2026-05-09T10:30:00.000Z',
  },
];

// SLA Config admin (BAC §3.1.6) — MSW state -----------------------

interface MswSlaConfig {
  sla_config_id: string;
  tenant_id: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  business_unit: string | null;
  sla_target_days: number;
  status: 'ACTIVE' | 'SUPERSEDED' | 'ARCHIVED';
  effective_from: string;
  effective_till: string | null;
  notes: string | null;
  created_by: string;
  updated_by: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}
interface MswSlaCreateInput {
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  business_unit?: string | null;
  sla_target_days: number;
  notes?: string | null;
}

// Mirrors data/schema/018_sla_config.sql seed for the offline demo path.
function _mkSla(
  cat: string,
  prio: 'P1' | 'P2' | 'P3' | 'P4',
  bu: string | null,
  days: number,
  notes: string,
): MswSlaConfig {
  const now = '2026-05-01T08:00:00Z';
  return {
    sla_config_id: `sla-seed-${cat}-${prio}-${bu ?? 'all'}`,
    tenant_id: 'BANK_DEMO',
    case_category: cat,
    priority: prio,
    business_unit: bu,
    sla_target_days: days,
    status: 'ACTIVE',
    effective_from: now,
    effective_till: null,
    notes,
    created_by: 'system:seed',
    updated_by: null,
    superseded_by: null,
    created_at: now,
    updated_at: now,
  };
}
// ── Notification Templates fixture (M14.16/M14.19) ──────────────────

interface MswNotificationTemplate {
  template_id: string;
  tenant_id: string;
  name: string;
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  subject: string | null;
  body: string;
  locale: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface MswNotificationTemplateCreateInput {
  name: string;
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  subject?: string | null;
  body: string;
  locale?: string;
}

// ── M14.24 dispatch log fixtures ────────────────────────────────────

interface MswDispatchEntry {
  dispatch_id: string;
  tenant_id: string;
  template_id: string;
  template_name: string;
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  recipient: string;
  trigger: 'admin_test_fire' | 'case_create_pipeline' | 'escalation_worker';
  reference: string | null;
  rendered_subject: string | null;
  rendered_body: string;
  missing_vars: string[];
  status: 'sent' | 'preview' | 'failed';
  status_reason: string | null;
  performed_by: string;
  performed_at: string;
}

const mswDispatchLog: MswDispatchEntry[] = [];

// Snapshot taken AFTER seedSampleDispatches() runs at the bottom of
// this module so __resetMswDispatchLog() restores realistic demo data
// between tests rather than dropping back to an empty list.
let _seedDispatchSnapshot: MswDispatchEntry[] = [];

export function __resetMswDispatchLog(): void {
  mswDispatchLog.length = 0;
  for (const seed of _seedDispatchSnapshot) {
    mswDispatchLog.push({ ...seed, missing_vars: [...seed.missing_vars] });
  }
}

interface MswRenderResult {
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  subject: string | null;
  body: string;
  missing_vars: string[];
  used_vars: string[];
}

const _RENDER_TOKEN_RE =
  /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*default:\s*"([^"]*)"\s*)?\}\}/g;

function _renderField(
  template: string,
  vars: Record<string, unknown>,
  used: Set<string>,
  missing: Set<string>,
): string {
  return template.replace(_RENDER_TOKEN_RE, (full, name: string, def?: string) => {
    used.add(name);
    const v = vars[name];
    const present = v !== null && v !== undefined && !(typeof v === 'string' && v.length === 0);
    if (present) return String(v);
    if (def !== undefined) return def;
    missing.add(name);
    return full;
  });
}

function _renderTemplate(
  tpl: MswNotificationTemplate,
  vars: Record<string, unknown>,
): MswRenderResult {
  const used = new Set<string>();
  const missing = new Set<string>();
  const subject =
    tpl.subject !== null ? _renderField(tpl.subject, vars, used, missing) : null;
  const body = _renderField(tpl.body, vars, used, missing);
  return {
    channel: tpl.channel,
    subject,
    body,
    missing_vars: [...missing].sort(),
    used_vars: [...used].sort(),
  };
}

// ── M14.25 escalation worker resolver (mirrors the BFF) ──────────────

interface MswEscalationOpenCase {
  case_id: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  opened_at: string;
  context_vars?: Record<string, unknown>;
}

interface MswEscalationDueRow {
  case_id: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  level: 1 | 2 | 3;
  role: string;
  after_minutes: number;
  case_age_minutes: number;
  scenario_id: string;
  escalation_id: string;
  template_id: string | null;
  template_name: string;
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  rendered_subject: string | null;
  rendered_body: string;
  missing_vars: string[];
}

interface MswEscalationPayload {
  due: MswEscalationDueRow[];
  cases_inspected: number;
  cases_with_no_scenario: number;
  cases_with_archived_escalation: number;
  already_dispatched_count: number;
}

function _validateOpenCase(raw: unknown, idx: number): MswEscalationOpenCase | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: `open_cases[${idx}] must be an object` };
  const r = raw as Record<string, unknown>;
  if (typeof r.case_id !== 'string' || !r.case_id.trim()) return { error: `open_cases[${idx}].case_id required` };
  if (typeof r.case_category !== 'string' || !r.case_category.trim()) return { error: `open_cases[${idx}].case_category required` };
  if (typeof r.priority !== 'string' || !['P1', 'P2', 'P3', 'P4'].includes(r.priority)) {
    return { error: `open_cases[${idx}].priority must be P1..P4` };
  }
  if (typeof r.opened_at !== 'string' || !Number.isFinite(new Date(r.opened_at).getTime())) {
    return { error: `open_cases[${idx}].opened_at must be ISO 8601` };
  }
  return {
    case_id: r.case_id.trim(),
    case_category: r.case_category.trim(),
    priority: r.priority as MswEscalationOpenCase['priority'],
    opened_at: r.opened_at,
    context_vars:
      r.context_vars && typeof r.context_vars === 'object' && !Array.isArray(r.context_vars)
        ? (r.context_vars as Record<string, unknown>)
        : undefined,
  };
}

function _computeEscalationsForRequest(
  tenant: string,
  raw_open_cases: unknown,
  now: Date,
): { payload: MswEscalationPayload } | { error: string } {
  if (!Array.isArray(raw_open_cases)) return { error: 'open_cases must be an array' };
  if (raw_open_cases.length > 1000) return { error: 'open_cases max 1000 per request' };
  const cases: MswEscalationOpenCase[] = [];
  for (let i = 0; i < raw_open_cases.length; i++) {
    const v = _validateOpenCase(raw_open_cases[i], i);
    if ('error' in v) return v;
    cases.push(v);
  }

  const due: MswEscalationDueRow[] = [];
  let no_scenario = 0;
  let archived_esc = 0;
  const nowMs = now.getTime();

  // Pre-filter scenarios + escalation rules to this tenant.
  const tenantScenarios = mswCaseScenarios.filter(
    (s) => s.tenant_id === tenant && s.deleted_at === null && s.status === 'ACTIVE',
  );

  for (const c of cases) {
    const matches = tenantScenarios
      .filter((s) => s.case_category === c.case_category && s.priority === c.priority)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (matches.length === 0) {
      no_scenario++;
      continue;
    }
    const scenario = matches[0]!;
    const rule = mswEscalationRules.find(
      (r) => r.tenant_id === tenant && r.escalation_id === scenario.default_escalation_id,
    );
    if (!rule || rule.status !== 'ACTIVE') {
      archived_esc++;
      continue;
    }
    const tpl = scenario.notification_template_id
      ? mswNotificationTemplates.find(
          (t) => t.tenant_id === tenant && t.template_id === scenario.notification_template_id,
        )
      : null;
    const tplActive = tpl && tpl.deleted_at === null && tpl.status === 'ACTIVE';
    const ageMinutes = Math.floor((nowMs - new Date(c.opened_at).getTime()) / 60_000);

    const renderVars: Record<string, unknown> = {
      case_id: c.case_id,
      case_number: c.case_id,
      case_category: c.case_category,
      priority: c.priority,
      case_age_minutes: ageMinutes,
      ...(c.context_vars ?? {}),
    };

    const levels: Array<{ level: 1 | 2 | 3; after: number; role: string | null }> = [
      { level: 1, after: rule.level_1_after_minutes, role: rule.level_1_role },
      { level: 2, after: rule.level_2_after_minutes ?? -1, role: rule.level_2_role },
      { level: 3, after: rule.level_3_after_minutes ?? -1, role: rule.level_3_role },
    ];

    for (const lv of levels) {
      if (lv.after < 0 || lv.role === null) continue;
      if (ageMinutes < lv.after) continue;

      let channel: 'EMAIL' | 'SMS' | 'IN_APP' = 'IN_APP';
      let template_name = '(no template)';
      let rendered_subject: string | null = '(no template configured for scenario)';
      let rendered_body = `Case ${c.case_id} reached escalation L${lv.level} (${lv.after}m) → role ${lv.role}`;
      let missing_vars: string[] = [];
      if (tplActive && tpl) {
        channel = tpl.channel;
        template_name = tpl.name;
        const r = _renderTemplate(tpl, {
          ...renderVars,
          escalation_role: lv.role,
          escalation_level: lv.level,
        });
        rendered_subject = r.subject;
        rendered_body = r.body;
        missing_vars = r.missing_vars;
      }

      due.push({
        case_id: c.case_id,
        case_category: c.case_category,
        priority: c.priority,
        level: lv.level,
        role: lv.role,
        after_minutes: lv.after,
        case_age_minutes: ageMinutes,
        scenario_id: scenario.scenario_id,
        escalation_id: rule.escalation_id,
        template_id: tplActive ? scenario.notification_template_id : null,
        template_name,
        channel,
        rendered_subject,
        rendered_body,
        missing_vars,
      });
    }
  }

  // Idempotency filter — drop rows already present in mswDispatchLog
  // for this tenant under reference=case:<id>:lvl:<n>+trigger=escalation_worker.
  const fired = new Set(
    mswDispatchLog
      .filter(
        (e) =>
          e.tenant_id === tenant &&
          e.trigger === 'escalation_worker' &&
          e.reference !== null,
      )
      .map((e) => e.reference!),
  );
  const total_due = due.length;
  const filtered = due.filter((d) => !fired.has(`case:${d.case_id}:lvl:${d.level}`));
  return {
    payload: {
      due: filtered,
      cases_inspected: cases.length,
      cases_with_no_scenario: no_scenario,
      cases_with_archived_escalation: archived_esc,
      already_dispatched_count: total_due - filtered.length,
    },
  };
}

function _mkTemplate(
  tenant_id: string,
  name: string,
  channel: 'EMAIL' | 'SMS' | 'IN_APP',
  subject: string | null,
  body: string,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
): MswNotificationTemplate {
  const now = new Date('2026-05-09T08:00:00.000Z').toISOString();
  return {
    template_id: `tpl-seed-${tenant_id.toLowerCase()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
    tenant_id,
    name,
    channel,
    subject,
    body,
    locale: 'en-IN',
    status,
    created_by: 'system:seed',
    updated_by: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

// ── Escalation Matrix fixture (M14.17/M14.20) ───────────────────────

interface MswEscalationRule {
  escalation_id: string;
  tenant_id: string;
  name: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  level_1_after_minutes: number;
  level_1_role: string;
  level_2_after_minutes: number | null;
  level_2_role: string | null;
  level_3_after_minutes: number | null;
  level_3_role: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface MswEscalationCreateInput {
  name: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  level_1_after_minutes: number;
  level_1_role: string;
  level_2_after_minutes?: number | null;
  level_2_role?: string | null;
  level_3_after_minutes?: number | null;
  level_3_role?: string | null;
}

const ESC_ROLES = ['admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer'];

function _mkEsc(
  tenant_id: string,
  name: string,
  case_category: string,
  priority: 'P1' | 'P2' | 'P3' | 'P4',
  l1m: number, l1r: string,
  l2m: number | null = null, l2r: string | null = null,
  l3m: number | null = null, l3r: string | null = null,
): MswEscalationRule {
  const now = new Date('2026-05-09T08:00:00.000Z').toISOString();
  return {
    escalation_id: `esc-seed-${tenant_id.toLowerCase()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
    tenant_id,
    name,
    case_category,
    priority,
    level_1_after_minutes: l1m,
    level_1_role: l1r,
    level_2_after_minutes: l2m,
    level_2_role: l2r,
    level_3_after_minutes: l3m,
    level_3_role: l3r,
    status: 'ACTIVE',
    created_by: 'system:seed',
    updated_by: null,
    created_at: now,
    updated_at: now,
  };
}

// ── Case Scenarios fixture (M14.18/M14.21) ──────────────────────────

interface MswCaseScenarioChecklistItem {
  title: string;
  required: boolean;
}
interface MswCaseScenario {
  scenario_id: string;
  tenant_id: string;
  name: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  trigger_indicator_id: string | null;
  trigger_threshold: number | null;
  default_escalation_id: string;
  notification_template_id: string | null;
  checklist: MswCaseScenarioChecklistItem[];
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
interface MswCaseScenarioCreateInput {
  name: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  trigger_indicator_id?: string | null;
  trigger_threshold?: number | null;
  default_escalation_id: string;
  notification_template_id?: string | null;
  checklist?: MswCaseScenarioChecklistItem[];
}
type MswScenarioDiffOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown };
interface MswCaseScenarioHistoryEntry {
  history_id: number;
  scenario_id: string;
  tenant_id: string;
  action: 'create' | 'update' | 'activate' | 'archive' | 'restore';
  diff: MswScenarioDiffOp[];
  after_state: Record<string, unknown>;
  performed_by: string;
  performed_at: string;
}

const mswCaseScenarios: MswCaseScenario[] = [];
const mswCaseScenarioHistory: MswCaseScenarioHistoryEntry[] = [];
let mswScenarioHistoryNextId = 1;

const SCENARIO_TRACKED_FIELDS = [
  'name',
  'case_category',
  'priority',
  'trigger_indicator_id',
  'trigger_threshold',
  'default_escalation_id',
  'notification_template_id',
  'checklist',
  'status',
] as const;

function _scenarioDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): MswScenarioDiffOp[] {
  const out: MswScenarioDiffOp[] = [];
  for (const f of SCENARIO_TRACKED_FIELDS) {
    const a = before?.[f];
    const b = after?.[f];
    const aHas = before !== null && a !== undefined && a !== null;
    const bHas = after !== null && b !== undefined && b !== null;
    if (!aHas && !bHas) continue;
    if (!aHas && bHas) { out.push({ op: 'add', path: `/${f}`, value: b }); continue; }
    if (aHas && !bHas) { out.push({ op: 'remove', path: `/${f}` }); continue; }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ op: 'replace', path: `/${f}`, value: b });
    }
  }
  return out;
}

function _appendScenarioHistory(
  tenant_id: string,
  scenario_id: string,
  action: 'create' | 'update' | 'activate' | 'archive' | 'restore',
  before: MswCaseScenario | null,
  after: MswCaseScenario,
  performed_by: string,
  performed_at: string,
): void {
  mswCaseScenarioHistory.push({
    history_id: mswScenarioHistoryNextId++,
    scenario_id,
    tenant_id,
    action,
    diff: _scenarioDiff(
      before as Record<string, unknown> | null,
      after as unknown as Record<string, unknown>,
    ),
    after_state: { ...(after as unknown as Record<string, unknown>) },
    performed_by,
    performed_at,
  });
}

/** FK validation against the live MSW template + escalation stores —
 *  matches the BFF resolver shape (returns null = ok, else error msg). */
function _validateScenarioFKs(
  tenant_id: string,
  escalation_id: string,
  template_id: string | null | undefined,
): string | null {
  const esc = mswEscalationRules.find(
    (r) => r.escalation_id === escalation_id && r.tenant_id === tenant_id,
  );
  if (!esc) return `escalation_id ${escalation_id} not found in tenant ${tenant_id}`;
  if (esc.status !== 'ACTIVE') return `escalation_id ${escalation_id} is ${esc.status}; only ACTIVE rules can back a scenario`;
  if (template_id) {
    const tpl = mswNotificationTemplates.find(
      (r) => r.template_id === template_id && r.tenant_id === tenant_id,
    );
    if (!tpl) return `notification_template_id ${template_id} not found in tenant ${tenant_id}`;
    if (tpl.deleted_at !== null || tpl.status === 'ARCHIVED') {
      return `notification_template_id ${template_id} is archived/deleted`;
    }
  }
  return null;
}

const mswEscalationRules: MswEscalationRule[] = [
  // ── BANK_DEMO escalation rules (banking-flavoured) ──
  _mkEsc('BANK_DEMO', 'BANK Fraud P1 fast-escalate', 'fraud', 'P1', 15, 'supervisor', 60, 'risk_analyst', 240, 'admin'),
  _mkEsc('BANK_DEMO', 'BANK Credit P2 standard',     'credit_risk', 'P2', 60, 'supervisor', 240, 'risk_analyst'),
  _mkEsc('BANK_DEMO', 'BANK KYC P3 reminder',        'kyc', 'P3', 480, 'supervisor'),
  _mkEsc('BANK_DEMO', 'BANK Compliance P1 fast',     'compliance', 'P1', 30, 'risk_analyst', 120, 'admin'),
  _mkEsc('BANK_DEMO', 'BANK Default P3 fallback',    'default_fallback', 'P3', 1440, 'supervisor'),
  _mkEsc('BANK_DEMO', 'BANK AML P1 high-risk',       'aml', 'P1', 20, 'risk_analyst', 60, 'admin'),
  _mkEsc('BANK_DEMO', 'BANK Operations P4 routine',  'operations', 'P4', 2880, 'supervisor'),
  // ── BIL escalation rules (insurance-flavoured) ──
  _mkEsc('BIL', 'BIL Lapse P1 agent-first',           'lapse', 'P1', 30, 'collection_officer', 180, 'supervisor', 720, 'admin'),
  _mkEsc('BIL', 'BIL Claim Fraud P1',                 'fraud', 'P1', 20, 'risk_analyst', 90, 'supervisor', 360, 'admin'),
  _mkEsc('BIL', 'BIL Compliance P2 IRDAI',            'compliance', 'P2', 180, 'supervisor', 720, 'risk_analyst'),
  _mkEsc('BIL', 'BIL Underwriting P2 standard',       'underwriting', 'P2', 240, 'supervisor', 1440, 'risk_analyst'),
  _mkEsc('BIL', 'BIL Claim Settlement P3 routine',    'claims', 'P3', 720, 'supervisor'),
  _mkEsc('BIL', 'BIL Default P3 fallback',            'default_fallback', 'P3', 1440, 'supervisor'),
  // ── Additional sample rules so the matrix renders varied coverage ──
  _mkEsc('BANK_DEMO', 'BANK Recovery P2 standard',    'recovery', 'P2', 120, 'collection_officer', 480, 'supervisor', 1440, 'admin'),
  _mkEsc('BANK_DEMO', 'BANK Repayment P3 reminder',   'repayment', 'P3', 360, 'collection_officer', 1440, 'supervisor'),
  _mkEsc('BANK_DEMO', 'BANK Field-Visit P2 standard', 'field_visit', 'P2', 240, 'field_officer', 720, 'supervisor'),
  _mkEsc('BIL', 'BIL Surrender P2 escalation',        'surrender', 'P2', 180, 'supervisor', 720, 'risk_analyst', 1440, 'admin'),
  _mkEsc('BIL', 'BIL Renewal P3 reminder',            'renewal', 'P3', 720, 'collection_officer', 1440, 'supervisor'),
];

// Deep snapshot of the seeded escalation rules so the array can be
// restored between tests without re-running _mkEsc (which captures
// timestamps). Mirrors the pattern used for notification templates.
const _seedEscalationRulesSnapshot: MswEscalationRule[] =
  mswEscalationRules.map((r) => ({ ...r }));

export function __resetMswEscalationRules(): void {
  mswEscalationRules.length = 0;
  for (const seed of _seedEscalationRulesSnapshot) {
    mswEscalationRules.push({ ...seed });
  }
}

function _validateEscChain(
  l1m: number,
  l2m: number | null, l2r: string | null,
  l3m: number | null, l3r: string | null,
): string | null {
  if (!Number.isInteger(l1m) || l1m < 0) return 'level_1_after_minutes must be a non-negative integer';
  const l2set = l2m !== null && l2m !== undefined;
  const l2rset = l2r !== null && l2r !== undefined;
  if (l2set !== l2rset) return 'level_2_after_minutes and level_2_role must be set together';
  if (l2set && (l2m as number) <= l1m) return 'level_2_after_minutes must be greater than level_1_after_minutes';
  const l3set = l3m !== null && l3m !== undefined;
  const l3rset = l3r !== null && l3r !== undefined;
  if (l3set !== l3rset) return 'level_3_after_minutes and level_3_role must be set together';
  if (l3set && !l2set) return 'level_3 cannot be set without level_2';
  if (l3set && (l3m as number) <= (l2m as number)) return 'level_3_after_minutes must be greater than level_2_after_minutes';
  return null;
}

const mswNotificationTemplates: MswNotificationTemplate[] = [
  // ── BANK_DEMO templates (banking) ──
  _mkTemplate(
    'BANK_DEMO',
    'Case Opened — RM email',
    'EMAIL',
    'New case {{case_number}} assigned to you',
    'Hi {{rm_name}},\n\nA new {{priority}} case ({{case_number}}) has been opened for {{customer_name}}.\nCategory: {{case_category}}\n\nPlease action within {{sla_target_days}} day(s).\n\n— ZorEWS',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'Case SLA breach warning — RM SMS',
    'SMS',
    null,
    'ZorEWS: Case {{case_number}} is at {{progress_pct}}% of SLA. Action ASAP.',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'Escalation L1 — Supervisor in-app',
    'IN_APP',
    'Case {{case_number}} escalated to you',
    'Case {{case_number}} ({{priority}} {{case_category}}) was not actioned within {{escalated_after_minutes}} minutes.',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'Customer KYC reminder — SMS',
    'SMS',
    null,
    'ZorEWS: Hi {{customer_name}}, please update your KYC by {{kyc_due_date}} to avoid service disruption.',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'Case Closed — RM email',
    'EMAIL',
    'Case {{case_number}} closed: {{resolution_category}}',
    'Hi {{rm_name}},\n\nCase {{case_number}} for {{customer_name}} has been closed.\nResolution: {{resolution_category}}\nNotes: {{resolution_notes}}',
    'DRAFT',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'Fraud alert — Customer SMS',
    'SMS',
    null,
    'ZorEWS Alert: A {{txn_type}} of {{amount}} was attempted on your account. If this was not you, call {{support_phone}} immediately.',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'Loan default warning — Customer email',
    'EMAIL',
    'Loan {{loan_id}} payment overdue',
    'Dear {{customer_name}},\n\nYour loan ({{loan_id}}) payment of {{amount}} is overdue by {{days_overdue}} day(s).\nPay before {{cutoff_date | default: "30 days"}} to avoid further action.\n\n— ZorEWS Collections',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'AML hit — Compliance team in-app',
    'IN_APP',
    'AML watchlist hit on customer {{customer_id}}',
    'Customer {{customer_name}} ({{customer_id}}) matched against {{watchlist_name}} watchlist with confidence {{confidence_pct}}%. Review and disposition within 4 hours.',
  ),
  // ── BIL templates (insurance) ──
  _mkTemplate(
    'BIL',
    'Claim case opened — Underwriter email',
    'EMAIL',
    'New {{priority}} claim case {{case_number}}',
    'Hello {{uw_name}},\n\nA new {{priority}} claim case ({{case_number}}) has been opened for policy {{policy_number}}.\nCategory: {{case_category}}\nReason: {{trigger_reason}}\n\nPlease review and decision within {{sla_target_days}} day(s).\n\n— ZorEWS',
  ),
  _mkTemplate(
    'BIL',
    'Lapse warning — Agent SMS',
    'SMS',
    null,
    'ZorEWS: Policy {{policy_number}} approaches lapse. Contact {{customer_name}} on {{customer_phone}}.',
  ),
  _mkTemplate(
    'BIL',
    'Claim approval — Customer email',
    'EMAIL',
    'Claim {{claim_number}} approved',
    'Dear {{customer_name}},\n\nWe are pleased to inform you that your claim {{claim_number}} for policy {{policy_number}} has been approved.\nAmount payable: {{paid_amount_kes}} KES\nExpected credit: T+{{settlement_days | default: "2"}} working days.\n\nRegards,\nBIL Claims',
  ),
  _mkTemplate(
    'BIL',
    'Premium reminder — Customer SMS',
    'SMS',
    null,
    'BIL: Hi {{customer_name}}, your premium of {{premium_amount}} for policy {{policy_number}} is due on {{due_date}}. Pay via {{payment_link | default: "your usual channel"}}.',
  ),
  _mkTemplate(
    'BIL',
    'Claim follow-up — Underwriter SMS',
    'SMS',
    null,
    'ZorEWS: Claim {{claim_number}} pending docs since {{pending_since_days}}d. Contact UW desk.',
  ),
  _mkTemplate(
    'BIL',
    'Escalation L3 — Admin in-app',
    'IN_APP',
    'Case {{case_number}} escalated to admin',
    'Case {{case_number}} ({{priority}} {{case_category}}) reached escalation level 3 — admin attention required.',
  ),
  _mkTemplate(
    'BIL',
    'Renewal reminder — Customer email',
    'EMAIL',
    'Policy {{policy_number}} renewal due in {{days_to_renewal}} days',
    'Dear {{customer_name}},\n\nYour policy {{policy_number}} is up for renewal on {{renewal_date}}.\nNew premium: {{renewal_premium}}\nClick {{renewal_link | default: "the BIL portal"}} to renew.\n\nThank you for choosing BIL.',
    'DRAFT',
  ),
  // ── Additional sample templates so the page renders varied content ──
  _mkTemplate(
    'BANK_DEMO',
    'Loan disbursement — Customer email',
    'EMAIL',
    'Loan {{loan_id}} disbursement confirmed',
    'Hi {{customer_name}},\n\nYour loan {{loan_id}} for {{amount}} has been disbursed to account {{account_number}}.\nFirst EMI date: {{emi_start_date}}.\n\n— ZorEWS',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'Repayment overdue — Customer SMS',
    'SMS',
    null,
    'Bank: Hi {{customer_name}}, EMI of {{amount}} for loan {{loan_id}} is overdue. Pay by {{due_date}} to avoid late fee.',
  ),
  _mkTemplate(
    'BANK_DEMO',
    'Compliance review — Audit team email',
    'EMAIL',
    'Compliance review pending — Case {{case_id}}',
    'Audit Team,\n\nCase {{case_id}} for customer {{customer_name}} requires compliance review.\nFlag: {{flag_reason}}\nDue: {{review_deadline}}.\n\n— ZorEWS',
    'DRAFT',
  ),
  _mkTemplate(
    'BIL',
    'Surrender request — Underwriter in-app',
    'IN_APP',
    'Surrender request received — Policy {{policy_number}}',
    '{{customer_name}} submitted a surrender request for policy {{policy_number}}.\nSurrender value: {{surrender_value}}\nReason: {{surrender_reason}}.',
  ),
  _mkTemplate(
    'BIL',
    'Investigation summary — Risk team email',
    'EMAIL',
    'Investigation summary — Case {{case_number}}',
    'Risk Team,\n\nInvestigation on case {{case_number}} (policy {{policy_number}}) is complete.\nOutcome: {{outcome}}\nNext step: {{next_step}}.\n\n— ZorEWS Investigations',
  ),
  _mkTemplate(
    'BIL',
    'Settlement delayed — Customer SMS',
    'SMS',
    null,
    'BIL: Hi {{customer_name}}, claim {{claim_number}} settlement is delayed by {{delay_days}} days due to {{delay_reason}}. We apologise for the inconvenience.',
  ),
];

// Deep snapshot of the seeded templates so __resetMswNotificationTemplates()
// can restore the array between tests without re-running the _mkTemplate
// builder (which captures a `now` timestamp). Each template is JSON-cloned
// so per-row mutations on `status` / `deleted_at` / `subject` / `body`
// don't bleed into the snapshot.
const _seedNotificationTemplatesSnapshot: MswNotificationTemplate[] =
  mswNotificationTemplates.map((t) => ({ ...t }));

export function __resetMswNotificationTemplates(): void {
  mswNotificationTemplates.length = 0;
  for (const seed of _seedNotificationTemplatesSnapshot) {
    mswNotificationTemplates.push({ ...seed });
  }
}

// ── Sample dispatch log seed ────────────────────────────────────────
// Populated immediately below so the Notification Dispatches admin
// page renders meaningful data the moment vite dev boots. Without
// this seed the page reads "No dispatches" until ops manually fires
// a test-fire — bad first impression for demos.
function _mkDispatch(
  tenant_id: string,
  template_id: string,
  template_name: string,
  channel: 'EMAIL' | 'SMS' | 'IN_APP',
  recipient: string,
  trigger: 'admin_test_fire' | 'case_create_pipeline' | 'escalation_worker',
  reference: string | null,
  rendered_subject: string | null,
  rendered_body: string,
  status: 'sent' | 'preview' | 'failed',
  hoursAgo: number,
  performed_by = 'alice.admin',
  status_reason: string | null = null,
  missing_vars: string[] = [],
): MswDispatchEntry {
  const ts = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    dispatch_id: `disp-seed-${tenant_id.toLowerCase()}-${template_id.slice(-12)}-${Math.round(hoursAgo * 10)}`,
    tenant_id,
    template_id,
    template_name,
    channel,
    recipient,
    trigger,
    reference,
    rendered_subject,
    rendered_body,
    missing_vars,
    status,
    status_reason,
    performed_by,
    performed_at: ts,
  };
}

// 25 dispatches spread across both tenants, 3 statuses, 3 triggers.
// hoursAgo values stagger so newest-first ordering shows recent
// activity at the top.
mswDispatchLog.push(
  // ── BANK_DEMO — escalation_worker trigger (fired automatically) ──
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-escalation-l1-supervisor',
    'Escalation L1 — Supervisor in-app',
    'IN_APP',
    'role:supervisor',
    'escalation_worker',
    'case:c-001:lvl:1',
    'Case c-001 escalated to you',
    'Case c-001 (P1 fraud) was not actioned within 15 minutes.',
    'sent',
    0.5,
    'system:escalation-worker',
  ),
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-escalation-l1-supervisor',
    'Escalation L1 — Supervisor in-app',
    'IN_APP',
    'role:supervisor',
    'escalation_worker',
    'case:c-014:lvl:1',
    'Case c-014 escalated to you',
    'Case c-014 (P2 credit_risk) was not actioned within 60 minutes.',
    'sent',
    1.2,
    'system:escalation-worker',
  ),
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-case-sla-breach-warning-',
    'Case SLA breach warning — RM SMS',
    'SMS',
    '+91-98765-43210',
    'escalation_worker',
    'case:c-007:lvl:1',
    null,
    'ZorEWS: Case CMS-007 is at 75% of SLA. Action ASAP.',
    'sent',
    2.0,
    'system:escalation-worker',
  ),
  // ── BANK_DEMO — case_create_pipeline (fires on every new case) ──
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-case-opened-rm-email',
    'Case Opened — RM email',
    'EMAIL',
    'ravi.rm@bankdemo.test',
    'case_create_pipeline',
    'case:c-023',
    'New case CMS-023 assigned to you',
    'Hi Ravi,\n\nA new P1 case (CMS-023) has been opened for ABC Traders Pvt Ltd.\nCategory: fraud\n\nPlease action within 1 day(s).\n\n— ZorEWS',
    'sent',
    3.5,
    'system:case-pipeline',
  ),
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-case-opened-rm-email',
    'Case Opened — RM email',
    'EMAIL',
    'sneha.rm@bankdemo.test',
    'case_create_pipeline',
    'case:c-024',
    'New case CMS-024 assigned to you',
    'Hi Sneha,\n\nA new P2 case (CMS-024) has been opened for Mehta Industries.\nCategory: credit_risk\n\nPlease action within 3 day(s).\n\n— ZorEWS',
    'sent',
    4.8,
    'system:case-pipeline',
  ),
  // ── BANK_DEMO — admin_test_fire (alice tests templates manually) ──
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-fraud-suspicion-alert-ri',
    'Fraud suspicion alert — Risk team email',
    'EMAIL',
    'risk-team@bankdemo.test',
    'admin_test_fire',
    null,
    'Suspected fraud on customer C-1024',
    'Customer C-1024 matched against PEP_GLOBAL watchlist with confidence 92%. Review and disposition within 4 hours.',
    'sent',
    6.0,
  ),
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-aml-watchlist-hit-risk-t',
    'AML watchlist hit — Risk team in-app',
    'IN_APP',
    'role:risk_analyst',
    'admin_test_fire',
    null,
    'PEP match: TEST_VENDOR_PTE',
    'Customer TEST_VENDOR_PTE (CUST-9001) matched against PEP_INDIA watchlist with confidence 88%. Review and disposition within 4 hours.',
    'sent',
    8.5,
  ),
  // ── BANK_DEMO — failed dispatch (SMS gateway rejected) ──
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-case-sla-breach-warning-',
    'Case SLA breach warning — RM SMS',
    'SMS',
    '+91-INVALID',
    'escalation_worker',
    'case:c-019:lvl:2',
    null,
    'ZorEWS: Case CMS-019 is at 95% of SLA. Action ASAP.',
    'failed',
    10.0,
    'system:escalation-worker',
    'SMS gateway rejected: invalid phone number format',
  ),
  // ── BANK_DEMO — preview (no real send, ops just rendered to check) ──
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-customer-kyc-reminder-sm',
    'Customer KYC reminder — SMS',
    'SMS',
    '+91-PREVIEW',
    'admin_test_fire',
    null,
    null,
    'ZorEWS: Hi {{customer_name}}, your KYC documents expire on 2026-06-15. Please update at any branch.',
    'preview',
    12.3,
    'alice.admin',
    null,
    ['customer_name'],
  ),
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-case-opened-rm-email',
    'Case Opened — RM email',
    'EMAIL',
    'rm-test@bankdemo.test',
    'admin_test_fire',
    null,
    'New case TEST-001 assigned to you',
    'Hi RM,\n\nA new P3 case (TEST-001) has been opened for TEST_CUSTOMER.\nCategory: kyc\n\nPlease action within 7 day(s).\n\n— ZorEWS',
    'sent',
    15.0,
  ),
  // ── BIL — escalation_worker (insurance escalations) ──
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-lapse-warning-agent-sms',
    'Lapse warning — Agent SMS',
    'SMS',
    '+975-17-555-101',
    'escalation_worker',
    'case:p-BIL-004:lvl:1',
    null,
    'ZorEWS: Policy POL-BIL-9001 approaches lapse. Contact Tashi Wangmo on +975-17-200-101.',
    'sent',
    0.8,
    'system:escalation-worker',
  ),
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-lapse-warning-agent-sms',
    'Lapse warning — Agent SMS',
    'SMS',
    '+975-17-555-203',
    'escalation_worker',
    'case:p-BIL-011:lvl:2',
    null,
    'ZorEWS: Policy POL-BIL-9015 approaches lapse. Contact Karma Dorji on +975-17-300-415.',
    'sent',
    2.7,
    'system:escalation-worker',
  ),
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-claim-follow-up-underwri',
    'Claim follow-up — Underwriter SMS',
    'SMS',
    '+975-17-555-310',
    'escalation_worker',
    'case:c-BIL-022:lvl:1',
    null,
    'ZorEWS: Claim CLM-BIL-2014 awaiting UW decision >12h. Open in console.',
    'sent',
    4.1,
    'system:escalation-worker',
  ),
  // ── BIL — case_create_pipeline ──
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-claim-case-opened-underw',
    'Claim case opened — Underwriter email',
    'EMAIL',
    'uw1@bil.test',
    'case_create_pipeline',
    'case:c-BIL-030',
    'New P1 claim case CLM-BIL-2030',
    'Hello Sonam Choden,\n\nA new P1 claim case (CLM-BIL-2030) has been opened for policy POL-BIL-9042.\nCategory: fraud\nReason: third-party investigation flagged irregular hospital invoice\n\nPlease review and decision within 1 day(s).\n\n— ZorEWS',
    'sent',
    1.8,
    'system:case-pipeline',
  ),
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-claim-case-opened-underw',
    'Claim case opened — Underwriter email',
    'EMAIL',
    'uw2@bil.test',
    'case_create_pipeline',
    'case:c-BIL-031',
    'New P3 claim case CLM-BIL-2031',
    'Hello Dechen Pelden,\n\nA new P3 claim case (CLM-BIL-2031) has been opened for policy POL-BIL-9055.\nCategory: claims\nReason: routine motor claim under USD 500\n\nPlease review and decision within 7 day(s).\n\n— ZorEWS',
    'sent',
    5.4,
    'system:case-pipeline',
  ),
  // ── BIL — admin_test_fire ──
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-claim-approval-customer-',
    'Claim approval — Customer email',
    'EMAIL',
    'customer-test@bil.test',
    'admin_test_fire',
    null,
    'Claim CLM-BIL-TEST approved',
    'Dear Test Customer,\n\nWe are pleased to inform you that your claim CLM-BIL-TEST for policy POL-BIL-TEST has been approved.\nAmount payable: 125000 KES\nExpected credit: T+2 working days.\n\nRegards,\nBIL Claims',
    'sent',
    7.2,
  ),
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-premium-reminder-custome',
    'Premium reminder — Customer SMS',
    'SMS',
    '+975-17-PREVIEW',
    'admin_test_fire',
    null,
    null,
    'BIL: Hi {{customer_name}}, your premium of {{premium_amount}} for policy POL-BIL-9001 is due on 2026-05-25. Pay via BIL portal.',
    'preview',
    9.0,
    'fiona.field',
    null,
    ['customer_name', 'premium_amount'],
  ),
  // ── BIL — failed (provider outage) ──
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-premium-reminder-custome',
    'Premium reminder — Customer SMS',
    'SMS',
    '+975-17-555-999',
    'case_create_pipeline',
    'case:p-BIL-099',
    null,
    'BIL: Hi Dorji Tshering, your premium of 45000 for policy POL-BIL-9099 is due on 2026-05-30. Pay via BIL portal.',
    'failed',
    11.5,
    'system:case-pipeline',
    'SMS provider returned 503 (gateway temporarily unavailable)',
  ),
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-claim-follow-up-underwri',
    'Claim follow-up — Underwriter SMS',
    'SMS',
    '+975-17-INVALID',
    'escalation_worker',
    'case:c-BIL-018:lvl:3',
    null,
    'ZorEWS: Claim CLM-BIL-2018 awaiting UW decision >12h. Open in console.',
    'failed',
    14.0,
    'system:escalation-worker',
    'SMS gateway rejected: number formatted incorrectly',
  ),
  // ── Older entries (>1 day ago) to fill the timeline ──
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-case-opened-rm-email',
    'Case Opened — RM email',
    'EMAIL',
    'ravi.rm@bankdemo.test',
    'case_create_pipeline',
    'case:c-016',
    'New case CMS-016 assigned to you',
    'Hi Ravi,\n\nA new P2 case (CMS-016) has been opened for Sharma Holdings.\nCategory: credit_risk\n\nPlease action within 3 day(s).\n\n— ZorEWS',
    'sent',
    26.5,
    'system:case-pipeline',
  ),
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-escalation-l1-supervisor',
    'Escalation L1 — Supervisor in-app',
    'IN_APP',
    'role:supervisor',
    'escalation_worker',
    'case:c-016:lvl:1',
    'Case c-016 escalated to you',
    'Case c-016 (P2 credit_risk) was not actioned within 60 minutes.',
    'sent',
    25.2,
    'system:escalation-worker',
  ),
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-lapse-warning-agent-sms',
    'Lapse warning — Agent SMS',
    'SMS',
    '+975-17-555-088',
    'escalation_worker',
    'case:p-BIL-008:lvl:1',
    null,
    'ZorEWS: Policy POL-BIL-9008 approaches lapse. Contact Pema Lhamo on +975-17-200-088.',
    'sent',
    27.8,
    'system:escalation-worker',
  ),
  _mkDispatch(
    'BANK_DEMO',
    'tpl-seed-bank_demo-aml-watchlist-hit-risk-t',
    'AML watchlist hit — Risk team in-app',
    'IN_APP',
    'role:risk_analyst',
    'case_create_pipeline',
    'case:c-aml-005',
    'OFAC match: GLOBAL_VENDOR_LTD',
    'Customer GLOBAL_VENDOR_LTD (CUST-7755) matched against OFAC_SDN watchlist with confidence 95%. Review and disposition within 4 hours.',
    'sent',
    29.0,
    'system:case-pipeline',
  ),
  _mkDispatch(
    'BIL',
    'tpl-seed-bil-claim-approval-customer-',
    'Claim approval — Customer email',
    'EMAIL',
    'dorji@customer.test',
    'admin_test_fire',
    null,
    'Claim CLM-BIL-1998 approved',
    'Dear Dorji Tshering,\n\nWe are pleased to inform you that your claim CLM-BIL-1998 for policy POL-BIL-8722 has been approved.\nAmount payable: 80000 KES\nExpected credit: T+2 working days.\n\nRegards,\nBIL Claims',
    'sent',
    32.5,
    'sue.super',
  ),
);

// Freeze the seed-state snapshot so __resetMswDispatchLog() restores
// these rows between tests instead of leaving the page empty.
_seedDispatchSnapshot = mswDispatchLog.map((d) => ({
  ...d,
  missing_vars: [...d.missing_vars],
}));

const mswSlaConfigs: MswSlaConfig[] = [
  _mkSla('credit_risk', 'P1', null, 1.0,  'Critical credit incident'),
  _mkSla('credit_risk', 'P2', null, 3.0,  'High credit risk — RM follow-up'),
  _mkSla('credit_risk', 'P3', null, 7.0,  'Routine credit triage'),
  _mkSla('credit_risk', 'P4', null, 14.0, 'Low-priority credit hygiene'),
  _mkSla('credit_risk', 'P1', 'CORPORATE', 0.5, 'Corporate banking: tighter than retail'),
  _mkSla('fraud',       'P1', null, 0.5,  'Active fraud — 12h cutoff'),
  _mkSla('fraud',       'P2', null, 1.0,  'Suspicious pattern — 24h'),
  _mkSla('fraud',       'P3', null, 3.0,  'Anomaly review'),
  _mkSla('fraud',       'P4', null, 7.0,  'Low-confidence flag'),
  _mkSla('kyc',         'P1', null, 2.0,  'Expired-doc + active loan — 48h'),
  _mkSla('kyc',         'P2', null, 5.0,  'KYC refresh due'),
  _mkSla('kyc',         'P3', null, 10.0, 'Address mismatch (low-risk)'),
  _mkSla('kyc',         'P4', null, 15.0, 'Doc-quality review'),
  _mkSla('lapse',       'P1', null, 1.0,  'Imminent lapse — same-day agent contact'),
  _mkSla('lapse',       'P2', null, 2.0,  'Premium overdue 15+ days'),
  _mkSla('lapse',       'P3', null, 5.0,  'Grace-period reminder'),
  _mkSla('lapse',       'P4', null, 10.0, 'Routine lapse follow-up'),
  _mkSla('compliance',  'P1', null, 1.0,  'Regulator-driven escalation'),
  _mkSla('compliance',  'P2', null, 3.0,  'Internal compliance breach'),
  _mkSla('compliance',  'P3', null, 7.0,  'Routine compliance review'),
  _mkSla('compliance',  'P4', null, 14.0, 'Process audit follow-up'),
  _mkSla('default_fallback', 'P1', null, 2.0,  'Fallback when no category-specific row matches'),
  _mkSla('default_fallback', 'P2', null, 5.0,  'Fallback'),
  _mkSla('default_fallback', 'P3', null, 10.0, 'Fallback'),
  _mkSla('default_fallback', 'P4', null, 20.0, 'Fallback'),
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

/**
 * Resolve the requesting tenant from the X-Tenant-ID request header.
 * The SPA's http interceptor sends both X-Tenant-ID + x-tenant-id, and
 * the proxy/MSW preserves header casing. Falls back to BANK_DEMO so
 * tests + early-load requests (before localStorage hydrates) keep
 * working with the seeded bank fixtures.
 */
function readTenantFromReq(request: Request): string {
  return (
    request.headers.get('X-Tenant-ID') ??
    request.headers.get('x-tenant-id') ??
    'BANK_DEMO'
  );
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

// M6.1 — Users & RBAC: change a user's role (admin-only). Mirrors
// auth-svc POST /auth/users/:username/role.
const M6_VALID_ROLES = [
  'admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer',
] as const;
async function setRoleHandler(request: Request, username: string) {
  const callerRole = readPersistedRole();
  if (callerRole === null) return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
  if (callerRole !== 'admin') return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
  const target = DEMO_USERS.find((u) => u.username === username);
  if (!target) return HttpResponse.json({ error: 'user_not_found' }, { status: 404 });
  if (username === readPersistedUsername()) {
    return HttpResponse.json({ error: 'cannot_change_own_role' }, { status: 409 });
  }
  const body = (await request.json()) as { role?: string };
  const newRole = body.role;
  if (!newRole || !M6_VALID_ROLES.includes(newRole as typeof M6_VALID_ROLES[number])) {
    return HttpResponse.json({ error: 'invalid_role' }, { status: 400 });
  }
  // DEMO_USERS carries roles[] (multi-role aware); the GET /auth/users
  // handler projects roles[0] into the SPA's expected `role` field. Mirror
  // that here — overwrite roles[0] so the next GET returns the new role.
  const previousRole = target.roles[0];
  target.roles = [newRole as typeof target.roles[number]];
  return HttpResponse.json({
    ok: true,
    username: target.username,
    role: newRole,
    previous_role: previousRole,
    unchanged: previousRole === newRole,
  });
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
    // Phase 9 T8 — optional extras envelope
    extras?: Record<string, Record<string, unknown> | undefined>;
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

  // Phase 9 T8 — echo the extras envelope when provided. The MSW handler
  // doesn't run the auth-svc validator, but it does mirror the response
  // shape so tests can assert that extras round-trip through the form.
  return HttpResponse.json(
    {
      user: {
        id,
        username,
        email,
        role: body.role,
        display_name,
        ...(body.extras && Object.keys(body.extras).length > 0
          ? { extras: body.extras }
          : {}),
      },
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

// Seed demo case scenarios across both tenants. Placed after every
// fixture array so the FK-validator helpers see them as resolvable on
// first access.
(function _seedScenarios() {
  const seedTs = new Date('2026-05-09T08:30:00.000Z').toISOString();

  // ── BANK_DEMO scenarios ──
  const bankFraudEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'BANK Fraud P1 fast-escalate',
  );
  const bankKycEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'BANK KYC P3 reminder',
  );
  const bankCreditEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'BANK Credit P2 standard',
  );
  const bankEmailTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'Case Opened — RM email',
  );
  const bankKycTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'Customer KYC reminder — SMS',
  );
  const bankFraudTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'Fraud alert — Customer SMS',
  );

  if (bankFraudEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bank-fraud-p1-sudden-dpd',
      tenant_id: 'BANK_DEMO',
      name: 'Fraud P1 sudden DPD spike',
      case_category: 'fraud',
      priority: 'P1',
      trigger_indicator_id: 'FRD-001',
      trigger_threshold: 0.85,
      default_escalation_id: bankFraudEsc.escalation_id,
      notification_template_id: bankEmailTpl?.template_id ?? null,
      checklist: [
        { title: 'Verify recent transactions with customer', required: true },
        { title: 'Freeze card if confirmed', required: true },
        { title: 'File RBI fraud report (FMR-1)', required: true },
      ],
      status: 'ACTIVE', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BANK_DEMO', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }
  if (bankKycEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bank-kyc-p3-doc-expired',
      tenant_id: 'BANK_DEMO',
      name: 'KYC document expired (P3)',
      case_category: 'kyc',
      priority: 'P3',
      trigger_indicator_id: 'KYC-001',
      trigger_threshold: 1,
      default_escalation_id: bankKycEsc.escalation_id,
      notification_template_id: bankKycTpl?.template_id ?? null,
      checklist: [
        { title: 'SMS customer with KYC reminder', required: true },
        { title: 'Block new account openings if expired > 90d', required: false },
      ],
      status: 'DRAFT', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BANK_DEMO', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }
  if (bankCreditEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bank-credit-p2-dpd-warning',
      tenant_id: 'BANK_DEMO',
      name: 'Credit P2 DPD trending up',
      case_category: 'credit_risk',
      priority: 'P2',
      trigger_indicator_id: 'CR-DPD-30',
      trigger_threshold: 30,
      default_escalation_id: bankCreditEsc.escalation_id,
      notification_template_id: bankFraudTpl?.template_id ?? null,
      checklist: [
        { title: 'Pull last 6 months repayment history', required: true },
        { title: 'Contact RM for next steps', required: true },
        { title: 'Check collateral valuation', required: false },
      ],
      status: 'ACTIVE', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BANK_DEMO', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }

  // ── BIL scenarios ──
  const bilLapseEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'BIL Lapse P1 agent-first',
  );
  const bilFraudEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'BIL Claim Fraud P1',
  );
  const bilUwEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'BIL Underwriting P2 standard',
  );
  const bilLapseTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'Lapse warning — Agent SMS',
  );
  const bilUwTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'Claim case opened — Underwriter email',
  );
  const bilFraudTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'Claim follow-up — Underwriter SMS',
  );

  if (bilLapseEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bil-lapse-p1-15d-overdue',
      tenant_id: 'BIL',
      name: 'Premium overdue 15+ days → lapse P1',
      case_category: 'lapse',
      priority: 'P1',
      trigger_indicator_id: 'LAP-002',
      trigger_threshold: 15,
      default_escalation_id: bilLapseEsc.escalation_id,
      notification_template_id: bilLapseTpl?.template_id ?? null,
      checklist: [
        { title: 'Contact customer via SMS + call', required: true },
        { title: 'Confirm payment intent + ETA', required: true },
        { title: 'Offer grace-period extension if eligible', required: false },
      ],
      status: 'ACTIVE', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BIL', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }
  if (bilFraudEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bil-claim-fraud-p1',
      tenant_id: 'BIL',
      name: 'Claim suspicious pattern → fraud P1',
      case_category: 'fraud',
      priority: 'P1',
      trigger_indicator_id: 'FRD-003',
      trigger_threshold: 0.9,
      default_escalation_id: bilFraudEsc.escalation_id,
      notification_template_id: bilFraudTpl?.template_id ?? null,
      checklist: [
        { title: 'Pull last 12 months claim history', required: true },
        { title: 'Cross-check provider against AML watchlist', required: true },
        { title: 'Hold payout until investigation completes', required: true },
      ],
      status: 'ACTIVE', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BIL', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }
  if (bilUwEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bil-uw-p2-pending-docs',
      tenant_id: 'BIL',
      name: 'Underwriting docs pending > 5d',
      case_category: 'underwriting',
      priority: 'P2',
      trigger_indicator_id: 'UW-PEND-5D',
      trigger_threshold: 5,
      default_escalation_id: bilUwEsc.escalation_id,
      notification_template_id: bilUwTpl?.template_id ?? null,
      checklist: [
        { title: 'Send doc reminder to customer', required: true },
        { title: 'Notify originating agent', required: true },
        { title: 'Auto-decline at 14d if no response', required: false },
      ],
      status: 'DRAFT', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BIL', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }

  // ── Additional sample scenarios using the new escalation rules ──
  const bankRecoveryEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'BANK Recovery P2 standard',
  );
  const bankRepaymentEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'BANK Repayment P3 reminder',
  );
  const bilSurrenderEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'BIL Surrender P2 escalation',
  );
  const bilRenewalEsc = mswEscalationRules.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'BIL Renewal P3 reminder',
  );
  const bankRepaymentTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BANK_DEMO' && r.name === 'Repayment overdue — Customer SMS',
  );
  const bilRenewalTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'Renewal reminder — Customer email',
  );
  const bilSurrenderTpl = mswNotificationTemplates.find(
    (r) => r.tenant_id === 'BIL' && r.name === 'Surrender request — Underwriter in-app',
  );

  if (bankRecoveryEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bank-recovery-p2-90dpd',
      tenant_id: 'BANK_DEMO',
      name: 'Recovery P2 — 90+ DPD allocation',
      case_category: 'recovery',
      priority: 'P2',
      trigger_indicator_id: 'COLL-DPD90',
      trigger_threshold: 90,
      default_escalation_id: bankRecoveryEsc.escalation_id,
      notification_template_id: bankRepaymentTpl?.template_id ?? null,
      checklist: [
        { title: 'Allocate to recovery agent within 24h', required: true },
        { title: 'Issue legal-notice draft', required: true },
        { title: 'Document settlement-offer terms', required: false },
      ],
      status: 'ACTIVE', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BANK_DEMO', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }

  if (bankRepaymentEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bank-repayment-p3-30dpd',
      tenant_id: 'BANK_DEMO',
      name: 'Repayment P3 — 30 DPD reminder',
      case_category: 'repayment',
      priority: 'P3',
      trigger_indicator_id: 'COLL-DPD30',
      trigger_threshold: 30,
      default_escalation_id: bankRepaymentEsc.escalation_id,
      notification_template_id: bankRepaymentTpl?.template_id ?? null,
      checklist: [
        { title: 'Send SMS reminder', required: true },
        { title: 'Schedule 7-day follow-up', required: true },
      ],
      status: 'ACTIVE', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BANK_DEMO', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }

  if (bilSurrenderEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bil-surrender-p2-request',
      tenant_id: 'BIL',
      name: 'Surrender P2 — Customer-initiated',
      case_category: 'surrender',
      priority: 'P2',
      trigger_indicator_id: 'BIL-SUR-REQ',
      trigger_threshold: 1,
      default_escalation_id: bilSurrenderEsc.escalation_id,
      notification_template_id: bilSurrenderTpl?.template_id ?? null,
      checklist: [
        { title: 'Acknowledge request within 24h', required: true },
        { title: 'Compute surrender value', required: true },
        { title: 'Schedule customer call for retention offer', required: false },
        { title: 'Notify originating agent', required: true },
      ],
      status: 'ACTIVE', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BIL', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }

  if (bilRenewalEsc) {
    const r: MswCaseScenario = {
      scenario_id: 'sc-seed-bil-renewal-p3-30d',
      tenant_id: 'BIL',
      name: 'Renewal P3 — 30 days before due',
      case_category: 'renewal',
      priority: 'P3',
      trigger_indicator_id: 'BIL-RNW-30D',
      trigger_threshold: 30,
      default_escalation_id: bilRenewalEsc.escalation_id,
      notification_template_id: bilRenewalTpl?.template_id ?? null,
      checklist: [
        { title: 'Email customer with renewal premium', required: true },
        { title: 'Assign to retention agent', required: false },
      ],
      status: 'ACTIVE', created_by: 'system:seed', updated_by: null,
      created_at: seedTs, updated_at: seedTs, deleted_at: null,
    };
    mswCaseScenarios.push(r);
    _appendScenarioHistory('BIL', r.scenario_id, 'create', null, r, 'system:seed', seedTs);
  }
})();

// ── T4.6.5 — Report builder MSW (in-memory) ──────────────────────────
//
// Each handler responds with the bank-grade envelope used by the BFF
// post-T4.24. Source catalog is platform-static (mirror of the BFF
// builder_catalog.ts file). Saved-report store is per-module mutable.

interface _MswSavedReport {
  report_id: string;
  tenant_id: string;
  name: string;
  description: string;
  definition: unknown;
  created_by: string;
  created_at: string;
  updated_at: string;
  visibility: 'private' | 'role' | 'tenant';
  visible_to_roles: string[];
  tags: string[];
}

const _mswReportSources = [
  {
    source_id: 'mart.customer_360',
    display_name: 'Customer 360',
    description: 'One row per customer with risk band, PD score, utilization, exposure, KYC + bureau snapshot.',
    schema: 'mart',
    table: 'customer_360',
    fields: [
      { name: 'customer_id', display_name: 'Customer ID', type: 'string', filterable: true, groupable: true, aggregatable: false, pii: true },
      { name: 'risk_level', display_name: 'Risk Level', type: 'enum', enum_values: ['Low', 'Medium', 'High'], filterable: true, groupable: true, aggregatable: false, pii: false },
      { name: 'pd_score', display_name: 'PD Score', type: 'number', filterable: true, groupable: false, aggregatable: true, pii: false },
      { name: 'utilization', display_name: 'Utilization', type: 'number', filterable: true, groupable: false, aggregatable: true, pii: false },
      { name: 'has_npa', display_name: 'Has NPA', type: 'boolean', filterable: true, groupable: true, aggregatable: false, pii: false },
    ],
    default_filter_fields: ['risk_level', 'has_npa'],
    drill_targets: [
      { to_source_id: 'mart.loan_360', via_field: 'customer_id', display_name: 'Loans' },
    ],
    tenant_scoped: true,
    required_role: 'customers:read_risk_profile',
  },
  {
    source_id: 'mart.loan_360',
    display_name: 'Loan 360',
    description: 'Loan-level facts joined to repayment aggregates.',
    schema: 'mart',
    table: 'loan_360',
    fields: [
      { name: 'loan_id', display_name: 'Loan ID', type: 'string', filterable: true, groupable: true, aggregatable: false, pii: false },
      { name: 'customer_id', display_name: 'Customer ID', type: 'string', filterable: true, groupable: true, aggregatable: false, pii: true },
      { name: 'product_code', display_name: 'Product', type: 'enum', enum_values: ['PL_RET', 'AUTO_RET', 'INV_SME', 'WC_SME', 'CORP_TL'], filterable: true, groupable: true, aggregatable: false, pii: false },
      { name: 'outstanding_balance', display_name: 'Outstanding', type: 'number', filterable: true, groupable: false, aggregatable: true, pii: false },
      { name: 'worst_dpd', display_name: 'Worst DPD', type: 'integer', filterable: true, groupable: true, aggregatable: true, pii: false },
    ],
    default_filter_fields: ['product_code', 'worst_dpd'],
    drill_targets: [
      { to_source_id: 'mart.customer_360', via_field: 'customer_id', display_name: 'Customer' },
    ],
    tenant_scoped: true,
    required_role: 'customers:read_risk_profile',
  },
] as const;

const _mswSavedReports: _MswSavedReport[] = [];
let _mswSavedSeq = 0;

export function __resetMswReportsBuilder(): void {
  _mswSavedReports.length = 0;
  _mswSavedSeq = 0;
}

function _mswSynthRow(idx: number, source: typeof _mswReportSources[number]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of source.fields) {
    const name = f.name;
    const type = f.type as string;
    if (type === 'string') {
      row[name] = `${name.slice(0, 3).toUpperCase()}-${String(idx + 1).padStart(5, '0')}`;
    } else if (type === 'integer') {
      row[name] = (idx * 7) % 180;
    } else if (type === 'number') {
      row[name] = Math.round(((idx * 0.137) % 1) * 100) / 100;
    } else if (type === 'boolean') {
      row[name] = idx % 2 === 0;
    } else if (type === 'enum') {
      const values = (f as { enum_values?: readonly string[] }).enum_values ?? [];
      row[name] = values[idx % Math.max(1, values.length)] ?? '';
    } else {
      row[name] = '';
    }
  }
  return row;
}

const _mswReportBuilderHandlers = [
  http.get('/v1/reports/builder/sources', () => {
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        generated_at: new Date().toISOString(),
        total_sources: _mswReportSources.length,
        sources: _mswReportSources,
      }),
    );
  }),

  http.get('/v1/reports/builder/sources/:source_id', ({ params }) => {
    const src = _mswReportSources.find((s) => s.source_id === params.source_id);
    if (!src) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_source', `unknown source: ${params.source_id}`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(src));
  }),

  http.post('/v1/reports/builder/preview', async ({ request }) => {
    const body = (await request.json()) as { source_id?: string };
    const src = _mswReportSources.find((s) => s.source_id === body.source_id);
    if (!src) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_source', `unknown: ${body.source_id}`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(
      envelope({
        source_id: src.source_id,
        sql: `SELECT ${src.fields.map((f) => f.name).join(', ')}\nFROM ${src.schema}.${src.table}\nWHERE tenant_id = :tenant_id\nLIMIT :limit`,
        params: { tenant_id: 'BIL', limit: 100 },
        projection: src.fields.map((f) => f.name),
        param_count: 2,
        is_aggregate: false,
      }),
    );
  }),

  http.post('/v1/reports/builder/run', async ({ request }) => {
    const body = (await request.json()) as { source_id?: string; limit?: number };
    const src = _mswReportSources.find((s) => s.source_id === body.source_id);
    if (!src) {
      return HttpResponse.json(
        envelopeError('EWS_400_unknown_source', `unknown: ${body.source_id}`, 'MEDIUM'),
        { status: 400 },
      );
    }
    const limit = Math.min(body.limit ?? 100, 1000);
    const rows = Array.from({ length: Math.min(limit, 25) }, (_, i) => _mswSynthRow(i, src));
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        generated_at: new Date().toISOString(),
        source_id: src.source_id,
        is_aggregate: false,
        rows,
        aggregates: {},
        total_rows: rows.length,
        candidate_rows: limit,
        projection: src.fields.map((f) => f.name),
        duration_ms: 5,
      }),
    );
  }),

  http.post('/v1/reports/builder/export.csv', async ({ request }) => {
    const body = (await request.json()) as { source_id?: string };
    const src = _mswReportSources.find((s) => s.source_id === body.source_id);
    if (!src) {
      return HttpResponse.json(
        envelopeError('EWS_400_unknown_source', `unknown: ${body.source_id}`, 'MEDIUM'),
        { status: 400 },
      );
    }
    const header = src.fields.map((f) => f.name).join(',');
    const row = src.fields.map((f) => _mswSynthRow(0, src)[f.name]).join(',');
    const csv = `${header}\r\n${row}\r\n`;
    return new HttpResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="report-${src.source_id.replace(/\W+/g, '_')}.csv"`,
      },
    });
  }),

  http.get('/v1/reports/builder/saved', ({ request }) => {
    const url = new URL(request.url);
    const visibility = url.searchParams.get('visibility');
    let rows = _mswSavedReports.filter((r) => r.tenant_id === 'BIL');
    if (visibility) rows = rows.filter((r) => r.visibility === visibility);
    return HttpResponse.json(
      envelope({ tenant_id: 'BIL', total: rows.length, reports: rows }),
    );
  }),

  http.get('/v1/reports/builder/saved/:id', ({ params }) => {
    const r = _mswSavedReports.find((x) => x.report_id === params.id && x.tenant_id === 'BIL');
    if (!r) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_report', `unknown: ${params.id}`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/reports/builder/saved', async ({ request }) => {
    const body = (await request.json()) as {
      name?: string;
      description?: string;
      definition?: unknown;
      visibility?: 'private' | 'role' | 'tenant';
      visible_to_roles?: string[];
      tags?: string[];
    };
    if (!body.name) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'name required', 'MEDIUM'),
        { status: 400 },
      );
    }
    _mswSavedSeq++;
    const r: _MswSavedReport = {
      report_id: `rpt-BIL-${Date.now()}-${_mswSavedSeq}`,
      tenant_id: 'BIL',
      name: body.name.trim(),
      description: body.description ?? '',
      definition: body.definition ?? {},
      created_by: 'alice',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      visibility: body.visibility ?? 'private',
      visible_to_roles: body.visible_to_roles ?? [],
      tags: body.tags ?? [],
    };
    _mswSavedReports.push(r);
    return HttpResponse.json(envelope(r, 'EWS_201'), { status: 201 });
  }),

  http.patch('/v1/reports/builder/saved/:id', async ({ params, request }) => {
    const r = _mswSavedReports.find((x) => x.report_id === params.id && x.tenant_id === 'BIL');
    if (!r) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_report', `unknown: ${params.id}`, 'LOW'),
        { status: 404 },
      );
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.name === 'string') r.name = body.name.trim();
    if (typeof body.description === 'string') r.description = body.description.trim();
    if (body.visibility === 'private' || body.visibility === 'role' || body.visibility === 'tenant') {
      r.visibility = body.visibility;
    }
    r.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(r));
  }),

  http.delete('/v1/reports/builder/saved/:id', ({ params }) => {
    const idx = _mswSavedReports.findIndex(
      (x) => x.report_id === params.id && x.tenant_id === 'BIL',
    );
    if (idx === -1) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_report', `unknown: ${params.id}`, 'LOW'),
        { status: 404 },
      );
    }
    _mswSavedReports.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('/v1/reports/builder/saved/:id/run', ({ params }) => {
    const r = _mswSavedReports.find((x) => x.report_id === params.id && x.tenant_id === 'BIL');
    if (!r) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_report', `unknown: ${params.id}`, 'LOW'),
        { status: 404 },
      );
    }
    const def = r.definition as { source_id?: string };
    const src = _mswReportSources.find((s) => s.source_id === def.source_id);
    if (!src) {
      return HttpResponse.json(
        envelopeError('EWS_400_unknown_source', `unknown: ${def.source_id}`, 'MEDIUM'),
        { status: 400 },
      );
    }
    const rows = Array.from({ length: 5 }, (_, i) => _mswSynthRow(i, src));
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        generated_at: new Date().toISOString(),
        source_id: src.source_id,
        is_aggregate: false,
        rows,
        aggregates: {},
        total_rows: rows.length,
        candidate_rows: 100,
        projection: src.fields.map((f) => f.name),
        duration_ms: 3,
      }),
    );
  }),
];

// ── T2.1.2 — Feature store explorer MSW handlers ────────────────────

const _mswFeatureCatalog = [
  { name: 'utilization', display_name: 'Exposure-to-income utilization', description: 'Credit exposure / monthly income, clamped to [0, 1.5].', value_type: 'number' as const, range: [0, 1.5], enum_labels: [], risk_polarity: 'higher_is_worse' as const },
  { name: 'dpd_max_90d', display_name: 'Max DPD (90d)', description: 'Worst days-past-due in trailing 90 days.', value_type: 'integer' as const, range: [0, 180], enum_labels: [], risk_polarity: 'higher_is_worse' as const },
  { name: 'bureau_score', display_name: 'Bureau score', description: 'Credit bureau score (300..900 typical band).', value_type: 'integer' as const, range: [300, 900], enum_labels: [], risk_polarity: 'lower_is_worse' as const },
  { name: 'repayment_delay_streak', display_name: 'Repayment delay streak', description: 'Consecutive months with late payment.', value_type: 'integer' as const, range: [0, 24], enum_labels: [], risk_polarity: 'higher_is_worse' as const },
  { name: 'txn_volume_zscore_90d', display_name: 'Transaction-volume z-score (90d)', description: 'Z-score of monthly txn volume vs 90d.', value_type: 'number' as const, range: [-3, 3], enum_labels: [], risk_polarity: 'lower_is_worse' as const },
  { name: 'tenure_months', display_name: 'Tenure months', description: 'Months since customer onboarding.', value_type: 'integer' as const, range: [0, 240], enum_labels: [], risk_polarity: 'lower_is_worse' as const },
  { name: 'product_level', display_name: 'Product type (encoded)', description: 'Categorical encoding of the loan product family.', value_type: 'enum' as const, range: [0, 4], enum_labels: ['PL_RET', 'AUTO_RET', 'INV_SME', 'WC_SME', 'CORP_TL'], risk_polarity: 'neutral' as const },
  { name: 'income_level', display_name: 'Income band (encoded)', description: 'Categorical encoding of monthly income band.', value_type: 'enum' as const, range: [0, 4], enum_labels: ['<25k', '25-50k', '50-100k', '100-250k', '250k+'], risk_polarity: 'neutral' as const },
];

function _mswFeatureValueAt(customer_id: string, name: string, at: Date, range: number[]) {
  // Cheap deterministic synth — matches the BFF contract shape.
  const seed = (customer_id + name + at.toISOString().slice(0, 10))
    .split('')
    .reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const norm = (Math.abs(seed) % 1000) / 1000;
  const v = range[0] + norm * (range[1] - range[0]);
  return Number.isInteger(range[0]) && Number.isInteger(range[1])
    ? Math.round(v)
    : Math.round(v * 1000) / 1000;
}

const _mswFeatureStoreHandlers = [
  // ── AML ↔ EWS correlation (T3.3) ────────────────────────────────────
  http.get('/v1/integrations/aml/matches', ({ request }) => {
    const url = new URL(request.url);
    const cid = url.searchParams.get('customer_id') ?? '';
    // Deterministic dev fixture: c-101 has one open sanctions match.
    const matches =
      cid === 'c-101'
        ? [
            {
              match_id: 'aml-m-101',
              customer_id: cid,
              match_type: 'sanctions' as const,
              severity: 'high' as const,
              list_name: 'OFAC SDN',
              list_entity_id: 'E-9001',
              list_entity_name: 'Sample Watchlist Entity',
              confidence_score: 0.88,
              status: 'open' as const,
              status_changed_at: null,
              status_changed_by: null,
              detected_at: new Date().toISOString(),
            },
          ]
        : [];
    return HttpResponse.json(envelope({ customer_id: cid, matches }));
  }),

  http.post('/v1/aml/correlate/:match_id', ({ params }) => {
    const match_id = String(params.match_id ?? '');
    if (match_id !== 'aml-m-101') {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_match', `unknown AML match: ${match_id}`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        generated_at: new Date().toISOString(),
        aml_match: {
          match_id,
          customer_id: 'c-101',
          match_type: 'sanctions' as const,
          severity: 'high' as const,
          list_name: 'OFAC SDN',
          list_entity_id: 'E-9001',
          list_entity_name: 'Sample Watchlist Entity',
          confidence_score: 0.88,
          status: 'open' as const,
          status_changed_at: null,
          status_changed_by: null,
          detected_at: new Date().toISOString(),
        },
        linked_alerts: [],
        linked_cases: [],
        linked_investigations: [],
        peak_alert_severity: null,
        bidirectional_high_flag: false,
        recommended_action: 'open_investigation' as const,
      }),
    );
  }),

  http.post('/v1/aml/correlate/by-alert/:alert_id', ({ params }) => {
    const alert_id = String(params.alert_id ?? '');
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        generated_at: new Date().toISOString(),
        alert: {
          id: alert_id,
          customer_id: 'c-101',
          severity: 'high' as const,
          created_at: new Date().toISOString(),
        },
        aml_matches: [],
        peak_aml_severity: null,
        open_aml_high_flag: false,
        recommended_action: 'no_action' as const,
      }),
    );
  }),

  http.get('/v1/feature-store/catalog', () => {
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        total_features: _mswFeatureCatalog.length,
        features: _mswFeatureCatalog,
      }),
    );
  }),

  http.get('/v1/feature-store/coverage', () => {
    const now = new Date();
    const earliest = new Date(now.getTime() - 744 * 86_400_000);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        generated_at: now.toISOString(),
        catalog_size: _mswFeatureCatalog.length,
        earliest_observed_at: earliest.toISOString(),
        latest_observed_at: now.toISOString(),
        window_days: 744,
        total_entities_seeded: 'unbounded_synthetic',
        features: _mswFeatureCatalog,
      }),
    );
  }),

  http.get('/v1/feature-store/customers/:customer_id/snapshot', ({ params, request }) => {
    const url = new URL(request.url);
    const atRaw = url.searchParams.get('at');
    if (atRaw && !/^\d{4}-\d{2}-\d{2}T/.test(atRaw)) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_date', 'malformed ISO-8601', 'MEDIUM'),
        { status: 400 },
      );
    }
    const at = atRaw ? new Date(atRaw) : new Date();
    const features: Record<string, number> = {};
    for (const def of _mswFeatureCatalog) {
      features[def.name] = _mswFeatureValueAt(
        params.customer_id as string,
        def.name,
        at,
        def.range,
      );
    }
    return HttpResponse.json(
      envelope({
        entity_id: params.customer_id as string,
        observed_at: at.toISOString(),
        features,
      }),
    );
  }),

  http.get('/v1/feature-store/customers/:customer_id/history', ({ params, request }) => {
    const url = new URL(request.url);
    const feature_name = url.searchParams.get('feature_name');
    const def = _mswFeatureCatalog.find((f) => f.name === feature_name);
    if (!def) {
      return HttpResponse.json(
        envelopeError('EWS_400_unknown_feature', 'unknown feature_name', 'MEDIUM'),
        { status: 400 },
      );
    }
    const now = new Date();
    const until = url.searchParams.get('until')
      ? new Date(url.searchParams.get('until')!)
      : now;
    const since = url.searchParams.get('since')
      ? new Date(url.searchParams.get('since')!)
      : new Date(until.getTime() - 90 * 86_400_000);
    const days = Math.floor((until.getTime() - since.getTime()) / 86_400_000);
    if (days > 744) {
      return HttpResponse.json(
        envelopeError('EWS_400_window_too_long', 'window exceeds 24mo', 'MEDIUM'),
        { status: 400 },
      );
    }
    const points: Array<{ observed_at: string; value: number }> = [];
    const values: number[] = [];
    for (let t = since.getTime(); t <= until.getTime(); t += 86_400_000) {
      const at = new Date(t);
      const v = _mswFeatureValueAt(params.customer_id as string, def.name, at, def.range);
      points.push({ observed_at: at.toISOString(), value: v });
      values.push(v);
    }
    const min = values.length ? Math.min(...values) : null;
    const max = values.length ? Math.max(...values) : null;
    const mean = values.length
      ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 1_000_000) / 1_000_000
      : null;
    const first_value = points[0]?.value ?? null;
    const last_value = points[points.length - 1]?.value ?? null;
    let trend: 'rising' | 'falling' | 'flat' | null = null;
    if (first_value !== null && last_value !== null) {
      if (def.value_type === 'enum') trend = 'flat';
      else {
        const abs = Math.abs(first_value);
        const delta = last_value - first_value;
        const rel = abs > 0 ? delta / abs : delta;
        if (rel > 0.05) trend = 'rising';
        else if (rel < -0.05) trend = 'falling';
        else trend = 'flat';
      }
    }
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        entity_id: params.customer_id as string,
        feature_name: def.name,
        since: since.toISOString(),
        until: until.toISOString(),
        count: points.length,
        points,
        min,
        max,
        mean,
        first_value,
        last_value,
        trend,
      }),
    );
  }),
];

// ── T2.12.1.SPA — Streaming Latency dashboard MSW handlers ──────────

// Seed 24 synthetic records — mix of healthy (under-60s) and a slow
// tail so the SLO banner + by_indicator rollup render meaningfully.
const _mswStreamingRecords = (function buildSeed() {
  const now = Date.now();
  const records = [];
  const indicators = ['FIN-001', 'BEH-002', 'TXN-001', 'CRD-003'];
  for (let i = 0; i < 24; i++) {
    const ind = indicators[i % indicators.length];
    // 20 fast + 4 slow distribution.
    const total = i < 20 ? 800 + (i % 5) * 1200 : 65_000 + (i % 4) * 8_000;
    const processed = now - i * 4_000;
    records.push({
      event_id: `sie-BIL-${now}-${i + 1}`,
      tenant_id: 'BIL',
      indicator_id: ind,
      customer_id: `CUST-${100 + (i % 8)}`,
      observed_at: new Date(processed - total).toISOString(),
      received_at: new Date(processed - Math.floor(total / 2)).toISOString(),
      processed_at: new Date(processed).toISOString(),
      ingest_latency_ms: Math.floor(total / 2),
      processing_latency_ms: Math.floor(total / 2),
      total_latency_ms: total,
      fired_alert_ids: [],
      fired_rule_ids: [],
    });
  }
  return records;
})();

function _mswPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function _mswStreamingSummary() {
  const records = _mswStreamingRecords;
  const totals = records.map((r) => r.total_latency_ms);
  const procs = records.map((r) => r.processing_latency_ms);
  const sortedTotals = [...totals].sort((a, b) => a - b);
  const sortedProcs = [...procs].sort((a, b) => a - b);
  const mean = (arr: number[]) =>
    arr.length ? Math.round(arr.reduce((s, n) => s + n, 0) / arr.length) : null;
  const under = totals.filter((t) => t < 60_000).length;

  // by_indicator
  const groups = new Map<string, number[]>();
  for (const r of records) {
    const arr = groups.get(r.indicator_id);
    if (arr) arr.push(r.total_latency_ms);
    else groups.set(r.indicator_id, [r.total_latency_ms]);
  }
  const by_indicator = Array.from(groups.entries())
    .map(([indicator_id, ts]) => {
      const s = [...ts].sort((a, b) => a - b);
      const u = ts.filter((t) => t < 60_000).length;
      return {
        indicator_id,
        count: ts.length,
        mean_total_ms: mean(ts) ?? 0,
        median_total_ms: _mswPercentile(s, 0.5),
        p95_total_ms: _mswPercentile(s, 0.95),
        max_total_ms: s[s.length - 1],
        count_under_60s: u,
        percentage_under_60s: Math.round((u / ts.length) * 10_000) / 10_000,
      };
    })
    .sort((a, b) => b.count - a.count || a.indicator_id.localeCompare(b.indicator_id));

  const newestAt = records.reduce((acc, r) => (r.processed_at > acc ? r.processed_at : acc), records[0]?.processed_at ?? '');
  const oldestAt = records.reduce((acc, r) => (r.processed_at < acc ? r.processed_at : acc), records[0]?.processed_at ?? '');

  return {
    tenant_id: 'BIL',
    generated_at: new Date().toISOString(),
    sample_size: records.length,
    mean_total_ms: mean(totals),
    median_total_ms: _mswPercentile(sortedTotals, 0.5),
    p95_total_ms: _mswPercentile(sortedTotals, 0.95),
    max_total_ms: sortedTotals[sortedTotals.length - 1],
    min_total_ms: sortedTotals[0],
    mean_processing_ms: mean(procs),
    p95_processing_ms: _mswPercentile(sortedProcs, 0.95),
    count_under_60s: under,
    count_over_60s: records.length - under,
    percentage_under_60s: Math.round((under / records.length) * 10_000) / 10_000,
    target_p95_60s_met: _mswPercentile(sortedTotals, 0.95) < 60_000,
    by_indicator,
    total_indicators: groups.size,
    most_recent_at: newestAt || null,
    oldest_at: oldestAt || null,
  };
}

const _mswStreamingLatencyHandlers = [
  http.get('/v1/streaming/latency', () => {
    return HttpResponse.json(envelope(_mswStreamingSummary()));
  }),
  http.get('/v1/streaming/events', ({ request }) => {
    const url = new URL(request.url);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    // Newest-first.
    const newestFirst = [..._mswStreamingRecords].sort((a, b) =>
      b.processed_at.localeCompare(a.processed_at),
    );
    return HttpResponse.json(
      envelope({
        tenant_id: 'BIL',
        total: Math.min(limit, newestFirst.length),
        events: newestFirst.slice(0, limit),
      }),
    );
  }),
];

// ── Insurance EWS · Module 1 — Policy Lapse Risk (dev/test mock) ───────
const _lapseBands = ['low', 'medium', 'high', 'critical'] as const;
const _lapseChannels = ['agent', 'broker', 'bancassurance', 'direct', 'online'] as const;
const _lapseRegions = ['North', 'South', 'East', 'West', 'Central'];
function _lapseBand(p: number): (typeof _lapseBands)[number] {
  if (p >= 0.75) return 'critical';
  if (p >= 0.5) return 'high';
  if (p >= 0.25) return 'medium';
  return 'low';
}
function _lapsePolicies() {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const prob = Math.round((((i * 37) % 100) / 100) ** 1.2 * 10000) / 10000;
    const band = _lapseBand(prob);
    const gwp = 5000 + ((i * 7919) % 95000);
    rows.push({
      policy_id: `POL-BANK_DEMO-${100000 + i}`,
      customer_id: `CUST-BANK_DEMO-${200000 + i}`,
      customer_name: `Customer ${i + 1}`,
      product_code: ['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'HEALTH', 'MOTOR'][i % 5],
      channel: _lapseChannels[i % 5],
      region: _lapseRegions[i % 5],
      gwp_kes: gwp,
      lapse_probability: prob,
      renewal_probability: Math.max(0, Math.round((1 - prob) * 10000) / 10000),
      horizon_days: [30, 60, 90][i % 3],
      retention_risk_band: band,
      days_since_last_payment: 10 + ((i * 13) % 120),
      missed_instalments_12m: i % 6,
      top_drivers: [
        { feature: 'missed_instalments_12m', contribution: 0.12 },
        { feature: 'days_since_last_payment', contribution: 0.08 },
      ],
      recommended_action:
        band === 'critical' || band === 'high'
          ? 'Priority outbound retention call'
          : 'Automated renewal reminder',
      model_version: 'lapse-stub-v1',
      scored_at: new Date().toISOString(),
    });
  }
  return rows;
}
const _mswInsurancePolicyLapseHandlers = [
  http.get('/v1/insurance/policy-lapse/dashboard', () => {
    const book = _lapsePolicies();
    const atRisk = book.filter((p) => p.retention_risk_band === 'high' || p.retention_risk_band === 'critical');
    const critical = book.filter((p) => p.retention_risk_band === 'critical');
    const high = book.filter((p) => p.retention_risk_band === 'high');
    const gwpAtRisk = Math.round(atRisk.reduce((a, p) => a + p.gwp_kes, 0) * 100) / 100;
    const highRisk = [...book].sort((a, b) => b.lapse_probability - a.lapse_probability).slice(0, 10);
    const trend = Array.from({ length: 12 }, (_, w) => ({
      date: new Date(Date.now() + (w + 1) * 7 * 86400000).toISOString().slice(0, 10),
      expected_lapses: Math.round(atRisk.length * (0.05 + (w % 5) * 0.01)),
      gwp_at_risk_kes: Math.round(gwpAtRisk * 0.05),
    }));
    const channel_lapse_risk = _lapseChannels.map((ch) => {
      const r = atRisk.filter((p) => p.channel === ch);
      return {
        channel: ch,
        policies_at_risk: r.length,
        mean_lapse_probability: r.length ? r.reduce((a, p) => a + p.lapse_probability, 0) / r.length : 0,
        gwp_at_risk_kes: r.reduce((a, p) => a + p.gwp_kes, 0),
      };
    });
    const region_lapse_risk = _lapseRegions.map((rg) => {
      const r = atRisk.filter((p) => p.region === rg);
      return {
        region: rg,
        policies_at_risk: r.length,
        mean_lapse_probability: r.length ? r.reduce((a, p) => a + p.lapse_probability, 0) / r.length : 0,
        gwp_at_risk_kes: r.reduce((a, p) => a + p.gwp_kes, 0),
      };
    });
    const top_retention_opportunities = [...atRisk]
      .sort((a, b) => b.gwp_kes * b.lapse_probability - a.gwp_kes * a.lapse_probability)
      .slice(0, 5)
      .map((p) => ({
        policy_id: p.policy_id,
        customer_name: p.customer_name,
        gwp_kes: p.gwp_kes,
        lapse_probability: p.lapse_probability,
        renewal_probability: p.renewal_probability,
        recommended_action: p.recommended_action,
        expected_gwp_saved_kes: Math.round(p.gwp_kes * p.lapse_probability * 0.55 * 100) / 100,
      }));
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        totals: {
          in_force_policies: book.length,
          at_risk_policies: atRisk.length,
          critical_count: critical.length,
          high_count: high.length,
          gwp_at_risk_kes: gwpAtRisk,
          mean_lapse_probability:
            Math.round((book.reduce((a, p) => a + p.lapse_probability, 0) / book.length) * 10000) / 10000,
        },
        high_risk_policies: highRisk,
        upcoming_lapse_trend: trend,
        channel_lapse_risk,
        region_lapse_risk,
        top_retention_opportunities,
        model_version: 'lapse-stub-v1',
      }),
    );
  }),
  http.get('/v1/insurance/policy-lapse/high-risk', ({ request }) => {
    const url = new URL(request.url);
    const band = url.searchParams.get('band');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    let rows = _lapsePolicies().filter((p) => p.retention_risk_band === 'high' || p.retention_risk_band === 'critical');
    if (band && band !== 'all') rows = rows.filter((p) => p.retention_risk_band === band);
    rows.sort((a, b) => b.lapse_probability - a.lapse_probability);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        horizon_days: 30,
        band_filter: band ?? 'all',
        total: rows.length,
        policies: rows.slice(0, limit),
      }),
    );
  }),
  http.post('/v1/insurance/policy-lapse/predict', async ({ request }) => {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'body' in raw ? raw.body : raw) as Record<string, unknown>;
    if (!body || !body.customer_id) {
      return HttpResponse.json(
        {
          header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() },
          error: { code: 'EWS_400_invalid_input', message: 'customer_id required', severity: 'MEDIUM' },
        },
        { status: 400 },
      );
    }
    const missed = Number(body.missed_instalments_12m ?? 0);
    const daysSince = Number(body.days_since_last_payment ?? 30);
    const prob = Math.max(0, Math.min(1, Math.round((0.12 + missed * 0.09 + Math.min(0.3, daysSince / 365)) * 10000) / 10000));
    const band = _lapseBand(prob);
    return HttpResponse.json(
      envelope({
        customer_id: body.customer_id,
        policy_id: body.policy_id ?? `POL-${body.customer_id}`,
        horizon_days: body.horizon_days ?? 30,
        lapse_probability: prob,
        renewal_probability: Math.round((1 - prob) * 10000) / 10000,
        retention_risk_band: band,
        top_drivers: [
          { feature: 'missed_instalments_12m', contribution: Math.round(missed * 0.09 * 10000) / 10000 },
          { feature: 'days_since_last_payment', contribution: Math.round(Math.min(0.3, daysSince / 365) * 10000) / 10000 },
        ],
        recommended_action: band === 'critical' || band === 'high' ? 'Priority outbound retention call' : 'Automated renewal reminder',
        model_version: 'lapse-stub-v1',
        scored_at: new Date().toISOString(),
      }),
    );
  }),
];

// ── Insurance EWS · Module 2 — Claims Anomaly (dev/test mock) ──────────
const _claimReasons = ['frequency_spike', 'amount_spike', 'signature_mismatch', 'duplicate_claim', 'rapid_refile', 'off_template'];
const _claimTypes = ['health', 'motor', 'life', 'property', 'travel'];
const _claimRegions = ['North', 'South', 'East', 'West', 'Central'];
function _anomSeverity(s: number): 'low' | 'medium' | 'high' | 'critical' {
  if (s >= 0.75) return 'critical';
  if (s >= 0.5) return 'high';
  if (s >= 0.25) return 'medium';
  return 'low';
}
function _claimBook() {
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const score = Math.round((((i * 41) % 100) / 100) ** 1.3 * 10000) / 10000;
    const sev = _anomSeverity(score);
    const n = sev === 'critical' ? 3 : sev === 'high' ? 2 : sev === 'medium' ? 1 : 0;
    rows.push({
      claim_id: `CLM-BANK_DEMO-${300000 + i}`,
      policy_id: `POL-BANK_DEMO-${100000 + i}`,
      customer_id: `CUST-BANK_DEMO-${200000 + i}`,
      customer_name: `Customer ${i + 1}`,
      claim_type: _claimTypes[i % 5],
      region: _claimRegions[(i * 3) % 5],
      claim_amount_kes: 20000 + ((i * 7919) % 480000),
      anomaly_score: score,
      severity: sev,
      anomaly_reasons: _claimReasons.slice(0, n),
      fraud_probability: Math.min(1, Math.round((score * 0.9 + 0.05) * 10000) / 10000),
      cluster_id: score >= 0.5 ? `CLUSTER-BANK_DEMO-${i % 6}` : null,
      status: sev === 'high' || sev === 'critical' ? 'siu_queued' : 'open',
      filed_at: new Date(Date.now() - (i % 30) * 86400000).toISOString(),
      model_version: 'claim-anomaly-stub-v1',
    });
  }
  return rows;
}
const _mswInsuranceClaimsAnomalyHandlers = [
  http.get('/v1/insurance/claims-anomaly/dashboard', () => {
    const book = _claimBook();
    const suspicious = book.filter((c) => c.severity === 'high' || c.severity === 'critical');
    const buckets = [
      { range: '0.0–0.2', min: 0, max: 0.2, count: 0 },
      { range: '0.2–0.4', min: 0.2, max: 0.4, count: 0 },
      { range: '0.4–0.6', min: 0.4, max: 0.6, count: 0 },
      { range: '0.6–0.8', min: 0.6, max: 0.8, count: 0 },
      { range: '0.8–1.0', min: 0.8, max: 1.0001, count: 0 },
    ];
    for (const c of book) {
      const b = buckets.find((bk) => c.fraud_probability >= bk.min && c.fraud_probability < bk.max);
      if (b) b.count++;
    }
    const heatmap = [];
    for (const ct of _claimTypes) {
      for (const rg of _claimRegions) {
        const cell = suspicious.filter((c) => c.claim_type === ct && c.region === rg);
        heatmap.push({
          claim_type: ct,
          region: rg,
          suspicious_count: cell.length,
          mean_anomaly_score: cell.length ? cell.reduce((a, c) => a + c.anomaly_score, 0) / cell.length : 0,
        });
      }
    }
    const siu = suspicious
      .map((c, i) => ({
        siu_case_id: `SIU-BANK_DEMO-${400000 + i}`,
        claim_id: c.claim_id,
        priority: c.severity,
        state: ['queued', 'investigating', 'escalated'][i % 3],
        assigned_to: ['siu.alice', 'siu.bob', null][i % 3],
        fraud_probability: c.fraud_probability,
        opened_at: c.filed_at,
      }))
      .sort((a, b) => b.fraud_probability - a.fraud_probability)
      .slice(0, 12);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        totals: {
          claims_scored: book.length,
          suspicious_claims: suspicious.length,
          critical_count: book.filter((c) => c.severity === 'critical').length,
          high_count: book.filter((c) => c.severity === 'high').length,
          siu_open_cases: suspicious.length,
          suspicious_amount_kes: suspicious.reduce((a, c) => a + c.claim_amount_kes, 0),
          mean_anomaly_score: Math.round((book.reduce((a, c) => a + c.anomaly_score, 0) / book.length) * 10000) / 10000,
        },
        suspicious_claims_queue: [...book].sort((a, b) => b.anomaly_score - a.anomaly_score).slice(0, 10),
        fraud_score_distribution: buckets,
        claims_heatmap: heatmap,
        siu_investigation_queue: siu,
        model_version: 'claim-anomaly-stub-v1',
      }),
    );
  }),
  http.get('/v1/insurance/claims-anomaly/suspicious', ({ request }) => {
    const url = new URL(request.url);
    const severity = url.searchParams.get('severity');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    let rows = _claimBook().filter((c) => c.severity === 'high' || c.severity === 'critical');
    if (severity && severity !== 'all') rows = rows.filter((c) => c.severity === severity);
    rows.sort((a, b) => b.anomaly_score - a.anomaly_score);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        severity_filter: severity ?? 'all',
        total: rows.length,
        claims: rows.slice(0, limit),
      }),
    );
  }),
  http.post('/v1/insurance/claims-anomaly/analyze', async ({ request }) => {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'body' in raw ? raw.body : raw) as Record<string, unknown>;
    if (!body || !body.customer_id) {
      return HttpResponse.json(
        {
          header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() },
          error: { code: 'EWS_400_invalid_input', message: 'customer_id required', severity: 'MEDIUM' },
        },
        { status: 400 },
      );
    }
    const claims90 = Number(body.claims_in_90d ?? 1);
    const ratio = Number(body.amount_vs_policy_avg ?? 1);
    const isDup = body.is_duplicate === true;
    const score = Math.max(
      0,
      Math.min(1, Math.round((0.05 + Math.max(0, (claims90 - 2) * 0.08) + Math.max(0, (ratio - 1) * 0.25) + (isDup ? 0.3 : 0)) * 10000) / 10000),
    );
    const sev = _anomSeverity(score);
    const reasons = [];
    if (claims90 > 2) reasons.push('frequency_spike');
    if (ratio > 1) reasons.push('amount_spike');
    if (isDup) reasons.push('duplicate_claim');
    return HttpResponse.json(
      envelope({
        claim_id: body.claim_id ?? `CLM-${body.customer_id}`,
        customer_id: body.customer_id,
        anomaly_score: score,
        severity: sev,
        fraud_probability: Math.min(1, Math.round((score * 0.9 + (isDup ? 0.1 : 0)) * 10000) / 10000),
        anomaly_reasons: reasons,
        siu_recommended: sev === 'high' || sev === 'critical',
        drivers: reasons.map((s) => ({ signal: s, contribution: 0.1 })),
        recommended_action:
          sev === 'high' || sev === 'critical' ? 'Queue to SIU — freeze payout pending investigation' : 'Proceed — within normal parameters',
        model_version: 'claim-anomaly-stub-v1',
        scored_at: new Date().toISOString(),
      }),
    );
  }),
];

// ── Insurance EWS · Module 3 — Fraud Detection (dev/test mock) ─────────
const _fraudEntityTypes = ['customer', 'provider', 'agent', 'garage', 'hospital', 'bank_account'];
const _fraudLinkTypes = ['shared_account', 'co_claim', 'referral', 'address', 'phone'];
function _fraudSeverity(s: number): 'low' | 'medium' | 'high' | 'critical' {
  if (s >= 0.75) return 'critical';
  if (s >= 0.5) return 'high';
  if (s >= 0.25) return 'medium';
  return 'low';
}
function _fraudEntities() {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const type = _fraudEntityTypes[i % 6];
    const risk = Math.round((((i * 29) % 100) / 100) ** 1.3 * 10000) / 10000;
    rows.push({
      entity_id: `ENT-BANK_DEMO-${500000 + i}`,
      entity_type: type,
      display_name: type === 'customer' ? `Customer ${i + 1}` : `${type}-${500000 + i}`,
      risk_score: risk,
      flagged: risk >= 0.5,
    });
  }
  return rows;
}
const _mswInsuranceFraudHandlers = [
  http.get('/v1/insurance/fraud/dashboard', () => {
    const entities = _fraudEntities();
    const flagged = entities.filter((e) => e.flagged);
    const rings = [];
    const ringCount = Math.max(2, Math.round(flagged.length / 8));
    for (let i = 0; i < ringCount; i++) {
      const risk = Math.round((0.55 + ((i * 13) % 40) / 100) * 10000) / 10000;
      rings.push({
        network_id: `NET-BANK_DEMO-${600000 + i}`,
        label: `Ring #${i + 1} — ${['staged-accident', 'provider-collusion', 'identity', 'claim-padding'][i % 4]} cluster`,
        entity_count: 4 + (i % 9),
        edge_count: 6 + (i % 9),
        ring_risk_score: risk,
        estimated_exposure_kes: Math.round((500000 + i * 350000) * (1 + risk)),
        detection_method: i % 2 ? 'community_detection' : 'shared_attribute_clustering',
        status: ['detected', 'investigating', 'confirmed', 'dismissed'][i % 4],
        detected_at: new Date(Date.now() - (i % 21) * 86400000).toISOString(),
      });
    }
    rings.sort((a, b) => b.ring_risk_score - a.ring_risk_score);
    // Expand top ring into a node/edge graph.
    const top = rings[0];
    const graphNodes = flagged.slice(0, top ? top.entity_count : 0);
    const graphEdges = [];
    for (let e = 0; e < (top ? top.edge_count : 0) && graphNodes.length >= 2; e++) {
      const a = graphNodes[e % graphNodes.length];
      const b = graphNodes[(e + 1) % graphNodes.length];
      if (a.entity_id === b.entity_id) continue;
      graphEdges.push({
        source_entity_id: a.entity_id,
        target_entity_id: b.entity_id,
        link_type: _fraudLinkTypes[e % 5],
        weight: Math.round((0.3 + (e % 7) / 10) * 10000) / 10000,
        shared_claim_count: 1 + (e % 6),
      });
    }
    const providers = entities
      .filter((e) => ['provider', 'hospital', 'garage'].includes(e.entity_type))
      .sort((a, b) => b.risk_score - a.risk_score)
      .slice(0, 10)
      .map((e, i) => ({
        entity_id: e.entity_id,
        display_name: e.display_name,
        entity_type: e.entity_type,
        risk_score: e.risk_score,
        linked_claims: 3 + (i * 5),
        linked_entities: 2 + i,
        estimated_exposure_kes: Math.round((200000 + i * 250000) * (1 + e.risk_score)),
        rank: i + 1,
      }));
    const identity = entities
      .filter((e) => e.entity_type === 'customer')
      .map((e) => {
        const idScore = Math.min(1, Math.round((e.risk_score * 0.7 + 0.2) * 10000) / 10000);
        const sev = _fraudSeverity(idScore);
        const n = sev === 'critical' ? 3 : sev === 'high' ? 2 : sev === 'medium' ? 1 : 0;
        return {
          customer_id: e.entity_id,
          customer_name: e.display_name,
          identity_risk_score: idScore,
          signals: ['shared_pan', 'duplicate_kyc', 'synthetic_identity'].slice(0, n),
          shared_accounts: 1,
          severity: sev,
        };
      })
      .sort((a, b) => b.identity_risk_score - a.identity_risk_score)
      .slice(0, 10);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        totals: {
          entities_tracked: entities.length,
          flagged_entities: flagged.length,
          fraud_rings: rings.length,
          open_fraud_cases: rings.filter((r) => r.status === 'detected' || r.status === 'investigating').length,
          estimated_exposure_kes: rings.reduce((a, r) => a + r.estimated_exposure_kes, 0),
          high_risk_providers: providers.length,
        },
        fraud_network_graph: top
          ? { network_id: top.network_id, label: top.label, nodes: graphNodes, edges: graphEdges }
          : { network_id: 'NONE', label: 'No ring detected', nodes: [], edges: [] },
        high_risk_providers: providers,
        fraud_ring_detection: rings,
        identity_risk_analysis: identity,
        model_version: 'fraud-stub-v1',
      }),
    );
  }),
  http.get('/v1/insurance/fraud/high-risk', ({ request }) => {
    const url = new URL(request.url);
    const type = url.searchParams.get('entity_type');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    let rows = _fraudEntities().filter((e) => e.flagged);
    if (type && type !== 'all') rows = rows.filter((e) => e.entity_type === type);
    rows.sort((a, b) => b.risk_score - a.risk_score);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        entity_type_filter: type ?? 'all',
        total: rows.length,
        entities: rows.slice(0, limit).map((e, i) => ({
          entity_id: e.entity_id,
          display_name: e.display_name,
          entity_type: e.entity_type,
          risk_score: e.risk_score,
          linked_claims: 1 + i,
          linked_entities: 1 + i,
          estimated_exposure_kes: Math.round((100000 + i * 200000) * (1 + e.risk_score)),
          rank: i + 1,
        })),
      }),
    );
  }),
  http.post('/v1/insurance/fraud/analyze', async ({ request }) => {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'body' in raw ? raw.body : raw) as Record<string, unknown>;
    if (!body || !body.customer_id) {
      return HttpResponse.json(
        {
          header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() },
          error: { code: 'EWS_400_invalid_input', message: 'customer_id required', severity: 'MEDIUM' },
        },
        { status: 400 },
      );
    }
    const shared = Number(body.shared_bank_accounts ?? 0);
    const coClaim = Number(body.co_claim_count ?? 0);
    const referral = Number(body.provider_referral_count ?? 0);
    const idMismatch = Number(body.identity_mismatch_score ?? 0);
    const prior = body.prior_confirmed_fraud === true;
    const relationship = Math.min(0.25, shared * 0.08) + Math.min(0.25, coClaim * 0.05) + Math.min(0.2, referral * 0.03);
    const raw2 = 0.05 + relationship + idMismatch * 0.3 + (prior ? 0.25 : 0);
    const fraud = Math.max(0, Math.min(1, Math.round(raw2 * 10000) / 10000));
    const ring = Math.max(0, Math.min(1, Math.round((relationship / 0.7) * 10000) / 10000));
    const sev = _fraudSeverity(fraud);
    let type = 'claim_padding';
    if (idMismatch * 0.3 >= 0.18) type = 'identity';
    else if (referral * 0.03 >= 0.12) type = 'provider_collusion';
    if (ring >= 0.6) type = 'ring';
    return HttpResponse.json(
      envelope({
        entity_id: body.entity_id ?? `ENT-${body.customer_id}`,
        customer_id: body.customer_id,
        fraud_probability: fraud,
        severity: sev,
        likely_fraud_type: type,
        ring_membership_likelihood: ring,
        signals: [{ signal: 'co_claim_count', contribution: 0.1 }],
        recommended_action: sev === 'high' || sev === 'critical' ? 'Queue to SIU' : 'Monitor',
        model_version: 'fraud-stub-v1',
        scored_at: new Date().toISOString(),
      }),
    );
  }),
];

// ── Insurance EWS · Module 4 — Solvency Watch (dev/test mock) ──────────
function _solvencyStatus(r: number): 'compliant' | 'watch' | 'breach' {
  if (r < 1.5) return 'breach';
  if (r < 1.6) return 'watch';
  return 'compliant';
}
const _mswInsuranceSolvencyHandlers = [
  http.get('/v1/insurance/solvency/dashboard', () => {
    const ratio = 1.78;
    const rsm = 5_000_000_000;
    const asm = Math.round(rsm * ratio);
    const trend = [];
    for (let m = 12; m >= 1; m--) {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() - m);
      const r = Math.round((ratio + ((m % 5) - 2) * 0.04) * 10000) / 10000;
      trend.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, solvency_ratio: r, status: _solvencyStatus(r), is_forecast: false });
    }
    const nowM = new Date();
    trend.push({ date: `${nowM.getUTCFullYear()}-${String(nowM.getUTCMonth() + 1).padStart(2, '0')}`, solvency_ratio: ratio, status: _solvencyStatus(ratio), is_forecast: false });
    for (let m = 1; m <= 3; m++) {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() + m);
      const r = Math.round((ratio - m * 0.06) * 10000) / 10000;
      trend.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, solvency_ratio: r, status: _solvencyStatus(r), is_forecast: true });
    }
    const stress = [
      { scenario: 'baseline', growth: 0.05 },
      { scenario: 'adverse', growth: 0.2 },
      { scenario: 'severe', growth: 0.4 },
    ].map(({ scenario, growth }) => {
      const projected = Math.round(Math.max(0.5, ratio * (1 - growth * 0.6)) * 10000) / 10000;
      return {
        scenario,
        claims_growth_pct: growth,
        projected_ratio: projected,
        status: _solvencyStatus(projected),
        breach_probability: Math.max(0, Math.min(1, Math.round(((1.5 - projected) / 0.5 + 0.1 * growth) * 10000) / 10000)),
        capital_shortfall_kes: projected < 1.5 ? Math.round(rsm * 1.5 - asm * (1 - growth * 0.6)) : 0,
      };
    });
    const fwd = trend.filter((p) => p.is_forecast);
    const firstBreach = fwd.findIndex((p) => p.status === 'breach');
    const alerts = [];
    const fwdBreach = fwd.find((p) => p.status === 'breach');
    if (fwdBreach) {
      alerts.push({ alert_id: 'CMP-BANK_DEMO-700001', regulator: 'IRDAI', rule_code: 'FORECAST_BREACH', severity: 'critical', message: `Forecast solvency ${fwdBreach.solvency_ratio} projected to breach by ${fwdBreach.date}`, metric_value: fwdBreach.solvency_ratio, threshold_value: 1.5, status: 'open', raised_at: new Date().toISOString() });
    }
    const fwdWatch = fwd.find((p) => p.status === 'watch');
    if (fwdWatch && !fwdBreach) {
      alerts.push({ alert_id: 'CMP-BANK_DEMO-700002', regulator: 'IRDAI', rule_code: 'FORECAST_BUFFER', severity: 'warning', message: `Forecast solvency ${fwdWatch.solvency_ratio} entering watch band by ${fwdWatch.date}`, metric_value: fwdWatch.solvency_ratio, threshold_value: 1.6, status: 'open', raised_at: new Date().toISOString() });
    }
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        current: {
          as_of: new Date().toISOString().slice(0, 10),
          available_solvency_margin_kes: asm,
          required_solvency_margin_kes: rsm,
          solvency_ratio: ratio,
          control_level: 1.5,
          capital_adequacy_pct: Math.round(Math.min(1, ratio / 2.5) * 10000) / 10000,
          status: _solvencyStatus(ratio),
        },
        forecast_trend: trend,
        capital_stress_simulation: stress,
        compliance_alerts: alerts,
        totals: {
          open_alerts: alerts.length,
          critical_alerts: alerts.filter((a) => a.severity === 'critical').length,
          min_forecast_ratio: Math.min(...fwd.map((p) => p.solvency_ratio)),
          breach_horizon_days: firstBreach >= 0 ? (firstBreach + 1) * 30 : null,
        },
        model_version: 'solvency-stub-v1',
      }),
    );
  }),
  http.post('/v1/insurance/solvency/forecast', async ({ request }) => {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'body' in raw ? raw.body : raw) as Record<string, unknown>;
    const baseline = Number(body.current_ratio ?? 1.7);
    const claims = Number(body.claims_growth_pct ?? 0);
    const scenario = (body.scenario as string) ?? 'baseline';
    const horizon = Number(body.horizon_days ?? 30);
    const mult = scenario === 'severe' ? 1.5 : scenario === 'adverse' ? 1.2 : 1.0;
    const hmult = horizon === 90 ? 1.0 : horizon === 60 ? 0.7 : 0.4;
    const projected = Math.round(Math.max(0.3, baseline * (1 - claims * 0.6 * mult * hmult)) * 10000) / 10000;
    return HttpResponse.json(
      envelope({
        horizon_days: horizon,
        scenario,
        baseline_ratio: baseline,
        projected_ratio: projected,
        claims_growth_pct: claims,
        premium_growth_pct: Number(body.premium_growth_pct ?? 0),
        breach_probability: Math.max(0, Math.min(1, Math.round(((1.5 - projected) / 0.5 + 0.05) * 10000) / 10000)),
        status: _solvencyStatus(projected),
        capital_shortfall_kes: null,
        drivers: [{ signal: 'claims_growth', contribution: -claims }],
        model_version: 'solvency-stub-v1',
        scored_at: new Date().toISOString(),
      }),
    );
  }),
  http.get('/v1/insurance/solvency/compliance', ({ request }) => {
    const url = new URL(request.url);
    const severity = url.searchParams.get('severity');
    let alerts = [
      { alert_id: 'CMP-BANK_DEMO-700001', regulator: 'IRDAI', rule_code: 'SOLVENCY_RATIO_BUFFER', severity: 'warning', message: 'Solvency within thin buffer of control level', metric_value: 1.55, threshold_value: 1.6, status: 'open', raised_at: new Date().toISOString() },
      { alert_id: 'CMP-BANK_DEMO-700003', regulator: 'IRDAI', rule_code: 'CAPITAL_ADEQUACY', severity: 'info', message: 'Capital adequacy at 71%', metric_value: 0.71, threshold_value: 0.6, status: 'resolved', raised_at: new Date().toISOString() },
    ];
    if (severity && severity !== 'all') alerts = alerts.filter((a) => a.severity === severity);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        severity_filter: severity ?? 'all',
        status_filter: 'all',
        total: alerts.length,
        alerts,
      }),
    );
  }),
];

// ── Insurance EWS · Module 5 — Persistency Watch (dev/test mock) ───────
const _pstTargets: Record<number, number> = { 13: 0.85, 25: 0.75, 37: 0.68, 49: 0.62, 61: 0.55 };
function _pstBand(shortfall: number): 'healthy' | 'watch' | 'concern' | 'critical' {
  if (shortfall <= 0) return 'healthy';
  if (shortfall < 0.05) return 'watch';
  if (shortfall < 0.12) return 'concern';
  return 'critical';
}
function _pstDimRows(values: string[]): Array<{
  dimension_value: string;
  persistency_pct: number;
  target_pct: number;
  shortfall: number;
  band: ReturnType<typeof _pstBand>;
  policies_in_force: number;
}> {
  const target = _pstTargets[13];
  return values
    .map((v, i) => {
      const pct = Math.round(Math.max(0.4, target - ((i * 7) % 30) / 100) * 10000) / 10000;
      const shortfall = Math.round(Math.max(0, target - pct) * 10000) / 10000;
      return {
        dimension_value: v,
        persistency_pct: pct,
        target_pct: target,
        shortfall,
        band: _pstBand(target - pct),
        policies_in_force: 3000 + i * 2500,
      };
    })
    .sort((a, b) => b.shortfall - a.shortfall);
}
const _mswInsurancePersistencyHandlers = [
  http.get('/v1/insurance/persistency/dashboard', () => {
    const trend = [13, 25, 37, 49, 61].map((p) => {
      const target = _pstTargets[p];
      const pct = Math.round(Math.max(0.3, target - 0.03) * 10000) / 10000;
      return { period_month: p, persistency_pct: pct, target_pct: target, shortfall: Math.round(Math.max(0, target - pct) * 10000) / 10000, band: _pstBand(target - pct) };
    });
    const products = _pstDimRows(['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'HEALTH', 'PENSION']);
    const channels = _pstDimRows(['agent', 'broker', 'bancassurance', 'direct', 'online']);
    const regions = _pstDimRows(['North', 'South', 'East', 'West', 'Central']);
    const all = [
      ...products.map((r) => ({ ...r, dimension: 'product' })),
      ...channels.map((r) => ({ ...r, dimension: 'channel' })),
      ...regions.map((r) => ({ ...r, dimension: 'region' })),
    ];
    const below = all.filter((c) => c.shortfall > 0);
    const worst = [...below].sort((a, b) => b.shortfall - a.shortfall)[0];
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        totals: {
          headline_13m_pct: trend[0].persistency_pct,
          headline_61m_pct: trend[4].persistency_pct,
          cohorts_below_target: below.length,
          open_alerts: all.filter((c) => c.shortfall > 0.05).length,
          worst_dimension: worst ? `${worst.dimension}:${worst.dimension_value}` : null,
        },
        persistency_trend: trend,
        product_retention: products,
        channel_risk: channels,
        location_persistency: regions,
        model_version: 'persistency-stub-v1',
      }),
    );
  }),
  http.post('/v1/insurance/persistency/analyze', async ({ request }) => {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'body' in raw ? raw.body : raw) as Record<string, unknown>;
    const dims = ['product', 'channel', 'region'];
    if (!body || !dims.includes(body.dimension as string)) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_dimension', message: 'dimension must be product | channel | region', severity: 'MEDIUM' } },
        { status: 400 },
      );
    }
    const period = Number(body.period_month ?? 13);
    const target = _pstTargets[period] ?? 0.85;
    const pct = Number(body.persistency_pct ?? target - 0.1);
    const shortfall = Math.round(Math.max(0, target - pct) * 10000) / 10000;
    const autoDebit = Number(body.auto_debit_share ?? 0.6);
    const attrition = Number(body.agent_attrition_rate ?? 0.1);
    const raw1 = (1 - autoDebit) * 0.4;
    const raw2 = attrition * 0.5;
    const tot = raw1 + raw2 + 0.0001;
    const causes = [
      { cause: 'low_auto_debit_adoption', weight: Math.round((raw1 / tot) * 10000) / 10000, detail: `Auto-debit share ${(autoDebit * 100).toFixed(0)}%` },
      { cause: 'agent_attrition', weight: Math.round((raw2 / tot) * 10000) / 10000, detail: `Attrition ${(attrition * 100).toFixed(0)}%` },
    ].sort((a, b) => b.weight - a.weight);
    return HttpResponse.json(
      envelope({
        dimension: body.dimension,
        dimension_value: body.dimension_value ?? 'cohort',
        period_month: period,
        persistency_pct: Math.round(pct * 10000) / 10000,
        target_pct: target,
        shortfall,
        band: _pstBand(target - pct),
        root_causes: causes,
        recommendation: 'Run an auto-debit enrolment drive for this cohort',
        model_version: 'persistency-stub-v1',
        analyzed_at: new Date().toISOString(),
      }),
    );
  }),
  http.get('/v1/insurance/persistency/alerts', ({ request }) => {
    const url = new URL(request.url);
    const severity = url.searchParams.get('severity');
    const products = _pstDimRows(['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'HEALTH', 'PENSION']);
    const channels = _pstDimRows(['agent', 'broker', 'bancassurance', 'direct', 'online']);
    let seq = 0;
    let alerts = [...products.map((r) => ({ ...r, dimension: 'product' })), ...channels.map((r) => ({ ...r, dimension: 'channel' }))]
      .filter((c) => c.shortfall > 0.05)
      .map((c) => ({
        alert_id: `PST-BANK_DEMO-${800000 + seq++}`,
        dimension: c.dimension,
        dimension_value: c.dimension_value,
        period_month: 13,
        persistency_pct: c.persistency_pct,
        threshold_pct: c.target_pct,
        shortfall: c.shortfall,
        severity: c.band === 'critical' ? 'critical' : c.band === 'concern' ? 'warning' : 'info',
        status: 'open',
        raised_at: new Date().toISOString(),
      }))
      .sort((a, b) => b.shortfall - a.shortfall);
    if (severity && severity !== 'all') alerts = alerts.filter((a) => a.severity === severity);
    return HttpResponse.json(
      envelope({ tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), severity_filter: severity ?? 'all', total: alerts.length, alerts }),
    );
  }),
];

// ── Insurance EWS · Module 6 — Underwriting Deviation (dev/test mock) ──
const _uwDeviationTypes = ['premium', 'medical_waiver', 'sum_assured', 'rule_violation'] as const;
const _uwChannels = ['agent', 'broker', 'bancassurance', 'direct', 'online'] as const;
const _uwNames = ['R. Sharma', 'P. Iyer', 'A. Khan', 'M. Nair', 'S. Reddy', 'V. Mehta', 'K. Das', 'N. Gupta'];
const _uwRuleCodes: Record<string, string> = {
  premium: 'PREMIUM_BELOW_GUIDELINE',
  medical_waiver: 'MEDICAL_WAIVER_GRANTED',
  sum_assured: 'SUM_ASSURED_OVER_LIMIT',
  rule_violation: 'MANUAL_RULE_OVERRIDE',
};
function _uwSeverity(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}
function _uwBook(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 42; i++) {
    const dt = _uwDeviationTypes[i % _uwDeviationTypes.length];
    const ch = _uwChannels[i % _uwChannels.length];
    const uwIdx = i % _uwNames.length;
    const score = Math.round(Math.min(1, (((i * 37) % 100) / 100) ** 1.3) * 10000) / 10000;
    const severity = _uwSeverity(score);
    const expected = dt === 'premium' ? 120000 : dt === 'sum_assured' ? 8000000 : 0;
    const actual = dt === 'premium' ? 84000 : dt === 'sum_assured' ? 11200000 : 1;
    const deviation_pct = expected !== 0 ? Math.round(((actual - expected) / expected) * 10000) / 10000 : 1;
    out.push({
      deviation_id: `UWD-BANK_DEMO-${900000 + i}`,
      policy_id: `POL-BANK_DEMO-${100000 + i}`,
      underwriter_id: `UW-BANK_DEMO-${10 + uwIdx}`,
      underwriter_name: _uwNames[uwIdx],
      channel: ch,
      deviation_type: dt,
      rule_code: _uwRuleCodes[dt],
      expected_value: expected,
      actual_value: actual,
      deviation_pct,
      severity,
      status: i % 5 === 0 ? 'reviewed' : i % 7 === 0 ? 'accepted' : 'open',
      detected_at: new Date(Date.now() - (i % 60) * 86400000).toISOString(),
    });
  }
  return out;
}
const _mswInsuranceUnderwritingHandlers = [
  http.get('/v1/insurance/underwriting/dashboard', () => {
    const book = _uwBook();
    const byUw = new Map<string, Array<Record<string, unknown>>>();
    for (const d of book) {
      const id = d.underwriter_id as string;
      if (!byUw.has(id)) byUw.set(id, []);
      byUw.get(id)!.push(d);
    }
    const high_risk_underwriters = [...byUw.entries()]
      .map(([uwId, rows]) => {
        const critHigh = rows.filter((d) => d.severity === 'high' || d.severity === 'critical').length;
        const policies = 30 + (parseInt(uwId.slice(-2), 10) % 9) * 12;
        const risk = Math.round(Math.min(1, rows.length * 0.05 + critHigh * 0.12) * 10000) / 10000;
        return {
          underwriter_id: uwId,
          underwriter_name: rows[0].underwriter_name as string,
          risk_score: risk,
          deviation_count_90d: rows.length,
          policies_underwritten: policies,
          deviation_rate: Math.round((rows.length / policies) * 10000) / 10000,
          rank: 0,
        };
      })
      .sort((a, b) => b.risk_score - a.risk_score || a.underwriter_id.localeCompare(b.underwriter_id))
      .slice(0, 10)
      .map((u, i) => ({ ...u, rank: i + 1 }));
    const deviation_heatmap: Array<Record<string, unknown>> = [];
    for (const dt of _uwDeviationTypes) {
      for (const ch of _uwChannels) {
        const cell = book.filter((d) => d.deviation_type === dt && d.channel === ch);
        deviation_heatmap.push({
          deviation_type: dt,
          channel: ch,
          count: cell.length,
          mean_deviation_pct: cell.length
            ? Math.round((cell.reduce((a, d) => a + Math.abs(d.deviation_pct as number), 0) / cell.length) * 10000) / 10000
            : 0,
        });
      }
    }
    const waivers = book.filter((d) => d.deviation_type === 'medical_waiver');
    const medical_waiver_analysis = ['under_35', '35_50', 'over_50'].map((band, idx) => {
      const granted = Math.round((waivers.length / 3) * (0.8 + idx * 0.2));
      return {
        band,
        waivers_granted: granted,
        waiver_rate: Math.round((granted / 267) * 10000) / 10000,
        high_sum_assured_waivers: Math.round(granted * (0.1 + idx * 0.12)),
      };
    });
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
    const rule_violation_alerts = book
      .filter((d) => d.status === 'open')
      .sort((a, b) => rank[a.severity as string] - rank[b.severity as string] || (a.deviation_id as string).localeCompare(b.deviation_id as string))
      .slice(0, 12);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        totals: {
          proposals_reviewed: 800,
          total_deviations: book.length,
          open_deviations: book.filter((d) => d.status === 'open').length,
          critical_deviations: book.filter((d) => d.severity === 'critical').length,
          medical_waivers: waivers.length,
          high_risk_underwriters: high_risk_underwriters.filter((u) => u.risk_score >= 0.5).length,
        },
        high_risk_underwriters,
        deviation_heatmap,
        medical_waiver_analysis,
        rule_violation_alerts,
        model_version: 'underwriting-stub-v1',
      }),
    );
  }),
  http.post('/v1/insurance/underwriting/analyze', async ({ request }) => {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'body' in raw ? raw.body : raw) as Record<string, unknown>;
    const premiumRatio = Number(body?.premium_vs_guideline_ratio ?? 1);
    const sumRatio = Number(body?.sum_assured_vs_limit_ratio ?? 1);
    const waiver = body?.medical_waiver_granted === true;
    const age = Number(body?.applicant_age ?? 40);
    const overrides = Number(body?.rule_overrides ?? 0);
    const deviations: Array<Record<string, unknown>> = [];
    const dPremium = premiumRatio < 0.9 ? Math.min(0.35, (0.9 - premiumRatio) * 1.2) : 0;
    if (dPremium > 0) deviations.push({ deviation_type: 'premium', rule_code: _uwRuleCodes.premium, detail: `Premium at ${(premiumRatio * 100).toFixed(0)}% of guideline`, contribution: Math.round(dPremium * 10000) / 10000 });
    const dSum = sumRatio > 1.0 ? Math.min(0.35, (sumRatio - 1.0) * 0.7) : 0;
    if (dSum > 0) deviations.push({ deviation_type: 'sum_assured', rule_code: _uwRuleCodes.sum_assured, detail: `Sum assured at ${(sumRatio * 100).toFixed(0)}% of limit`, contribution: Math.round(dSum * 10000) / 10000 });
    const dWaiver = waiver ? Math.min(0.3, 0.12 + Math.max(0, (age - 45) / 100)) : 0;
    if (dWaiver > 0) deviations.push({ deviation_type: 'medical_waiver', rule_code: _uwRuleCodes.medical_waiver, detail: `Medical waiver granted at age ${age}`, contribution: Math.round(dWaiver * 10000) / 10000 });
    const dOverride = Math.min(0.3, overrides * 0.1);
    if (dOverride > 0) deviations.push({ deviation_type: 'rule_violation', rule_code: _uwRuleCodes.rule_violation, detail: `${overrides} manual rule override(s)`, contribution: Math.round(dOverride * 10000) / 10000 });
    const score = Math.round(Math.max(0, Math.min(1, deviations.reduce((a, d) => a + (d.contribution as number), 0))) * 10000) / 10000;
    const severity = _uwSeverity(score);
    deviations.sort((a, b) => (b.contribution as number) - (a.contribution as number));
    return HttpResponse.json(
      envelope({
        policy_id: body?.policy_id ?? 'POL-ADHOC',
        underwriter_id: body?.underwriter_id ?? 'UW-ADHOC',
        deviation_score: score,
        severity,
        deviations,
        requires_exception_approval: severity === 'high' || severity === 'critical',
        recommended_action:
          severity === 'critical'
            ? 'Block issuance — route to senior UW + compliance for exception approval'
            : severity === 'high'
              ? 'Route to approval-exception workflow before issuance'
              : severity === 'medium'
                ? 'Flag for UW supervisor review'
                : 'Within underwriting tolerance — proceed',
        model_version: 'underwriting-stub-v1',
        analyzed_at: new Date().toISOString(),
      }),
    );
  }),
  http.get('/v1/insurance/underwriting/deviations', ({ request }) => {
    const url = new URL(request.url);
    const typeFilter = url.searchParams.get('deviation_type');
    const statusFilter = url.searchParams.get('status');
    let rows = _uwBook();
    if (typeFilter && typeFilter !== 'all') rows = rows.filter((d) => d.deviation_type === typeFilter);
    if (statusFilter && statusFilter !== 'all') rows = rows.filter((d) => d.status === statusFilter);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
    rows.sort((a, b) => rank[a.severity as string] - rank[b.severity as string] || (a.deviation_id as string).localeCompare(b.deviation_id as string));
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        type_filter: typeFilter ?? 'all',
        status_filter: statusFilter ?? 'all',
        total: rows.length,
        deviations: rows.slice(0, 50),
      }),
    );
  }),
];

// ── Insurance EWS · Module 7 — Channel Risk (dev/test mock) ───────────
const _chrChannels = ['agent', 'broker', 'bancassurance', 'direct', 'online'] as const;
const _chrIndicators = ['free_look_cancellation', 'early_surrender', 'suitability_mismatch', 'churning'] as const;
const _chrComplaintCats = ['mis_selling', 'claim_dispute', 'servicing_delay', 'premium_dispute', 'unauthorised_transaction'] as const;
const _chrNames = [
  'A. Bhattacharya', 'S. Pillai', 'R. Verma', 'M. Kulkarni', 'J. Thomas',
  'D. Saxena', 'P. Banerjee', 'N. Krishnan', 'V. Chauhan', 'K. Patel',
];
const _chrW = { persistency: 0.25, fraud: 0.3, complaint: 0.15, mis_selling: 0.3 };
function _chrBand(score: number): 'healthy' | 'watch' | 'elevated' | 'critical' {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'elevated';
  if (score >= 0.25) return 'watch';
  return 'healthy';
}
function _chrSev(band: string): 'info' | 'warning' | 'critical' {
  if (band === 'critical') return 'critical';
  if (band === 'elevated') return 'warning';
  return 'info';
}
function _chrAgents(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 40; i++) {
    const channel = _chrChannels[i % _chrChannels.length];
    const nameIdx = i % _chrNames.length;
    const persistency13m = Math.round((0.5 + ((i * 11) % 45) / 100) * 10000) / 10000;
    const sub = {
      persistency: Math.round(Math.max(0, 1 - persistency13m) * 10000) / 10000,
      fraud: Math.round(((i * 13) % 100 / 100) ** 2.2 * 10000) / 10000,
      complaint: Math.round(((i * 17) % 100 / 100) ** 1.6 * 10000) / 10000,
      mis_selling: Math.round(((i * 23) % 100 / 100) ** 1.8 * 10000) / 10000,
    };
    const composite =
      Math.round(
        Math.max(0, Math.min(1, sub.persistency * _chrW.persistency + sub.fraud * _chrW.fraud + sub.complaint * _chrW.complaint + sub.mis_selling * _chrW.mis_selling)) * 10000,
      ) / 10000;
    out.push({
      agent_id: `AGT-BANK_DEMO-${50000 + i}`,
      agent_name: _chrNames[nameIdx],
      channel,
      composite_risk: composite,
      sub_scores: sub,
      policies_sold_90d: 10 + ((i * 7) % 140),
      persistency_13m: persistency13m,
      band: _chrBand(composite),
      rank: 0,
    });
  }
  return out
    .sort((a, b) => (b.composite_risk as number) - (a.composite_risk as number) || (a.agent_id as string).localeCompare(b.agent_id as string))
    .map((a, i) => ({ ...a, rank: i + 1 }));
}
const _mswInsuranceChannelRiskHandlers = [
  http.get('/v1/insurance/channel-risk/dashboard', () => {
    const agents = _chrAgents();
    const channel_health = _chrChannels
      .map((ch) => {
        const inCh = agents.filter((a) => a.channel === ch);
        const n = inCh.length || 1;
        const mean = (sel: (a: Record<string, unknown>) => number) => Math.round((inCh.reduce((acc, a) => acc + sel(a), 0) / n) * 10000) / 10000;
        const meanRisk = mean((a) => a.composite_risk as number);
        return {
          channel: ch,
          agent_count: inCh.length,
          mean_risk: meanRisk,
          high_risk_agents: inCh.filter((a) => (a.composite_risk as number) >= 0.5).length,
          persistency_13m: mean((a) => a.persistency_13m as number),
          complaint_rate: mean((a) => (a.sub_scores as Record<string, number>).complaint),
          mis_selling_rate: mean((a) => (a.sub_scores as Record<string, number>).mis_selling),
          band: _chrBand(meanRisk),
        };
      })
      .sort((a, b) => b.mean_risk - a.mean_risk || a.channel.localeCompare(b.channel));
    let seq = 0;
    const mis_selling_alerts = agents
      .filter((a) => (a.sub_scores as Record<string, number>).mis_selling >= 0.4)
      .map((a) => {
        const ms = (a.sub_scores as Record<string, number>).mis_selling;
        const band = _chrBand(ms);
        return {
          alert_id: `MSL-BANK_DEMO-${700000 + seq++}`,
          agent_id: a.agent_id,
          agent_name: a.agent_name,
          channel: a.channel,
          indicator: _chrIndicators[seq % _chrIndicators.length],
          count_30d: 1 + (seq % 12),
          severity: _chrSev(band),
          status: 'open',
          raised_at: new Date().toISOString(),
        };
      })
      .sort((a, b) => {
        const rank = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
        return rank[a.severity] - rank[b.severity] || b.count_30d - a.count_30d || a.alert_id.localeCompare(b.alert_id);
      });
    const complaint_analytics = _chrComplaintCats
      .map((cat, i) => {
        const count = 30 + i * 18;
        const resolved = Math.round(count * 0.7);
        return {
          category: cat,
          count_30d: count,
          resolved,
          pending: count - resolved,
          mean_resolution_days: Math.round((5 + i * 3) * 10000) / 10000,
          trend: i % 3 === 0 ? 'up' : i % 3 === 1 ? 'flat' : 'down',
        };
      })
      .sort((a, b) => b.count_30d - a.count_30d || a.category.localeCompare(b.category));
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        totals: {
          agents_scored: agents.length,
          high_risk_agents: agents.filter((a) => (a.composite_risk as number) >= 0.5).length,
          critical_agents: agents.filter((a) => a.band === 'critical').length,
          open_mis_selling_alerts: mis_selling_alerts.length,
          complaints_30d: complaint_analytics.reduce((acc, c) => acc + c.count_30d, 0),
          worst_channel: channel_health[0]?.channel ?? null,
        },
        channel_risk_leaderboard: agents.slice(0, 10),
        channel_health,
        mis_selling_alerts: mis_selling_alerts.slice(0, 12),
        complaint_analytics,
        model_version: 'channel-risk-stub-v1',
      }),
    );
  }),
  http.post('/v1/insurance/channel-risk/analyze', async ({ request }) => {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'body' in raw ? raw.body : raw) as Record<string, unknown>;
    const persistency13m = Number(body?.persistency_13m ?? 0.8);
    const fraudFlags = Number(body?.fraud_flag_count ?? 0);
    const complaintRate = Number(body?.complaint_rate ?? 0.05);
    const freeLook = Number(body?.free_look_cancellation_rate ?? 0.05);
    const earlySurrender = Number(body?.early_surrender_rate ?? 0.05);
    const suitability = Number(body?.suitability_mismatch_rate ?? 0.05);
    const sub = {
      persistency: Math.round(Math.max(0, Math.min(1, 1 - persistency13m)) * 10000) / 10000,
      fraud: Math.round(Math.min(1, fraudFlags * 0.2) * 10000) / 10000,
      complaint: Math.round(Math.min(1, complaintRate * 2) * 10000) / 10000,
      mis_selling: Math.round(Math.min(1, freeLook * 0.4 + earlySurrender * 0.35 + suitability * 0.5) * 10000) / 10000,
    };
    const composite =
      Math.round(
        Math.max(0, Math.min(1, sub.persistency * _chrW.persistency + sub.fraud * _chrW.fraud + sub.complaint * _chrW.complaint + sub.mis_selling * _chrW.mis_selling)) * 10000,
      ) / 10000;
    const band = _chrBand(composite);
    const drivers = [
      { driver: 'persistency', sub_score: sub.persistency, weight: Math.round(sub.persistency * _chrW.persistency * 10000) / 10000, detail: `13-month persistency ${(persistency13m * 100).toFixed(0)}%` },
      { driver: 'fraud', sub_score: sub.fraud, weight: Math.round(sub.fraud * _chrW.fraud * 10000) / 10000, detail: `${fraudFlags} open fraud flag(s)` },
      { driver: 'complaint', sub_score: sub.complaint, weight: Math.round(sub.complaint * _chrW.complaint * 10000) / 10000, detail: `Complaint rate ${(complaintRate * 100).toFixed(1)}%` },
      { driver: 'mis_selling', sub_score: sub.mis_selling, weight: Math.round(sub.mis_selling * _chrW.mis_selling * 10000) / 10000, detail: `Free-look ${(freeLook * 100).toFixed(0)}% · early-surrender ${(earlySurrender * 100).toFixed(0)}% · suitability-mismatch ${(suitability * 100).toFixed(0)}%` },
    ].sort((a, b) => b.weight - a.weight);
    return HttpResponse.json(
      envelope({
        agent_id: body?.agent_id ?? 'AGT-ADHOC',
        channel: body?.channel ?? 'agent',
        composite_risk: composite,
        band,
        sub_scores: sub,
        drivers,
        requires_action: band === 'elevated' || band === 'critical',
        recommended_action:
          band === 'critical'
            ? 'Suspend agent code + conduct-risk review before reinstatement'
            : band === 'elevated'
              ? 'Escalate to channel-compliance for targeted review'
              : band === 'watch'
                ? 'Add to watch-list — sample 10% of policies for QA call-back'
                : 'Within tolerance — no action',
        model_version: 'channel-risk-stub-v1',
        analyzed_at: new Date().toISOString(),
      }),
    );
  }),
  http.get('/v1/insurance/channel-risk/high-risk', ({ request }) => {
    const url = new URL(request.url);
    const channel = url.searchParams.get('channel');
    const band = url.searchParams.get('band');
    let rows = _chrAgents();
    if (channel && channel !== 'all') rows = rows.filter((a) => a.channel === channel);
    if (band && band !== 'all') rows = rows.filter((a) => a.band === band);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        channel_filter: channel ?? 'all',
        band_filter: band ?? 'all',
        total: rows.length,
        agents: rows.slice(0, 50),
      }),
    );
  }),
];

// Phase 4 — Alert Center acknowledgement state. In-memory set of acked
// alert ids; mutated by POST /api/alerts/ack and reflected on GET
// /api/alerts. Reset between tests via __resetMswAlertAcks().
const acknowledgedAlertIds = new Set<string>();
export function __resetMswAlertAcks(): void {
  acknowledgedAlertIds.clear();
}

export const handlers = [
  ..._mswReportBuilderHandlers,
  ..._mswFeatureStoreHandlers,
  ..._mswStreamingLatencyHandlers,
  ..._mswInsurancePolicyLapseHandlers,
  ..._mswInsuranceClaimsAnomalyHandlers,
  ..._mswInsuranceFraudHandlers,
  ..._mswInsuranceSolvencyHandlers,
  ..._mswInsurancePersistencyHandlers,
  ..._mswInsuranceUnderwritingHandlers,
  ..._mswInsuranceChannelRiskHandlers,
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

  // Phase 9 T1 — admin user lifecycle: disable, enable, force-logout.
  // disable + enable map to the same setLocked backend as lock/unlock,
  // but the SPA uses the distinct verbs so the audit chain preserves
  // operator intent. Force-logout doesn't touch the user row — it just
  // marks every prior session invalid in the mock. self-action 409
  // guard mirrors the real auth-svc; missing-user 404 + non-admin 403
  // mirror setLockedHandler.
  http.post('/auth/users/:username/disable', ({ params }) =>
    setLockedHandler(String(params.username).toLowerCase(), true),
  ),
  http.post('/auth/users/:username/enable', ({ params }) =>
    setLockedHandler(String(params.username).toLowerCase(), false),
  ),
  http.post('/auth/users/:username/force-logout', ({ params }) => {
    const username = String(params.username).toLowerCase();
    const callerRole = readPersistedRole();
    if (callerRole === null)
      return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    if (callerRole !== 'admin')
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    if (username === readPersistedUsername()) {
      return HttpResponse.json({ error: 'cannot_force_logout_self' }, { status: 409 });
    }
    const target = DEMO_USERS.find((u) => u.username === username);
    if (!target) return HttpResponse.json({ error: 'user_not_found' }, { status: 404 });
    // Synthesise a plausible revoked_count from prior session activity —
    // the dev MSW doesn't track sessions, so we return a small constant
    // matching what a single-device user would have outstanding.
    return HttpResponse.json({ ok: true, username: target.username, revoked_count: 1 });
  }),

  // M6.1 — Users & RBAC: role change endpoint
  http.post('/auth/users/:username/role', ({ params, request }) =>
    setRoleHandler(request, String(params.username).toLowerCase()),
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
        // Phase 9 T1-partial + T1-full — admin lifecycle actions so the
        // AdminActivityPage unified timeline has rows to render in dev.
        ['user_disabled', 'eve.eve', 'admin'],
        ['user_force_logout', 'mallory.brute', 'admin'],
        ['user_enabled', 'eve.eve', 'admin'],
        ['user_role_changed', 'ravi.risk', 'admin'],
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

  // Phase 9 T2 — admin fleet session governance. Mirror of the auth-svc
  // /auth/admin/sessions surface. Reads from the same _mockSessions array
  // used by /auth/sessions so the SPA sees a consistent fleet.
  http.get('/auth/admin/sessions', ({ request }) => {
    const role = readPersistedRole();
    if (role === null) return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    if (role !== 'admin') return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    const url = new URL(request.url);
    const status = url.searchParams.get('status') ?? 'active';
    const userIdFilter = url.searchParams.get('user_id');
    // Seed at least one cross-user session so the page renders in dev.
    if (_mockSessions.length < 2) {
      const stamp = Date.now().toString(36);
      _mockSessions.push(
        {
          id: `sid-bob-${stamp}`,
          user_id: 'u-002',
          issued_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
          last_seen_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
          ip: '10.0.30.7',
          user_agent: 'Firefox on Windows',
          is_current: false,
        },
        {
          id: `sid-carol-${stamp}`,
          user_id: 'u-003',
          issued_at: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
          last_seen_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
          ip: '10.0.30.18',
          user_agent: 'Safari on iPad',
          is_current: false,
        },
      );
    }
    // Synthesise decorated rows. The mock has no real notion of revoked,
    // so for status=revoked we return an empty array (no revoked rows
    // exist until the SPA fires a revoke). status=active returns all.
    if (status === 'revoked') {
      return HttpResponse.json({ sessions: [], total: 0, filter: { status, limit: 200 } });
    }
    const users: Array<{ id: string; username: string; role: string; tenant_id: string }> = [
      { id: 'u-001', username: 'alice.admin', role: 'admin', tenant_id: 'BANK_DEMO' },
      { id: 'u-002', username: 'ravi.risk', role: 'risk_analyst', tenant_id: 'BANK_DEMO' },
      { id: 'u-003', username: 'sara.supervisor', role: 'supervisor', tenant_id: 'BANK_DEMO' },
    ];
    const decorated = _mockSessions
      .filter((s) => (userIdFilter ? s.user_id === userIdFilter : true))
      .map((s) => {
        const u = users.find((x) => x.id === s.user_id);
        return {
          ...s,
          username: u?.username ?? null,
          role: u?.role ?? null,
          tenant_id: u?.tenant_id ?? null,
          revoked: false,
        };
      });
    return HttpResponse.json({
      sessions: decorated,
      total: decorated.length,
      filter: { status, limit: 200 },
    });
  }),

  http.post('/auth/admin/sessions/:sid/revoke', ({ params }) => {
    const role = readPersistedRole();
    if (role === null) return HttpResponse.json({ error: 'missing_token' }, { status: 401 });
    if (role !== 'admin') return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    const sid = String(params.sid);
    const idx = _mockSessions.findIndex((s) => s.id === sid);
    if (idx < 0) return HttpResponse.json({ error: 'session_not_found' }, { status: 404 });
    const target = _mockSessions[idx]!;
    _mockSessions.splice(idx, 1);
    return HttpResponse.json({
      ok: true,
      revoked_sid: sid,
      target_user_id: target.user_id,
    });
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
        reply = `Hi! I'm the ZorEWS copilot. ${
          entityLabel ? `I can see you're looking at ${entityLabel}.` : `What can I help you with on the ${page === 'unknown' ? 'current page' : page} screen?`
        }`;
        break;
      case 'help':
        reply =
          "I'm the ZorEWS copilot — a context-aware assistant for risk operations.\n\nI can:\n  • Explain a customer's PD and the top SHAP drivers\n  • Summarise an alert, case, or the dashboard\n  • Recommend next actions tailored to your role\n  • Help you triage queues by severity\n\nMy answers are templated and grounded in what's on the page you're looking at — not a free-form LLM (yet).";
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
    const statusParam = url.searchParams.get('status'); // open | acknowledged
    let items: Alert[] = alerts.map((a) => ({
      ...a,
      criticality_score: computeScore(a),
      linked_alert_ids: [] as string[],
      acknowledged: acknowledgedAlertIds.has(a.id),
    }));
    if (severity) items = items.filter((a) => a.severity === severity);
    if (assignee) items = items.filter((a) => a.assignee === assignee);
    if (customerId) items = items.filter((a) => a.customer.id === customerId);
    if (statusParam === 'open') items = items.filter((a) => !a.acknowledged);
    else if (statusParam === 'acknowledged') items = items.filter((a) => a.acknowledged);
    if (dedupOn) items = dedupByCustomer(items);
    const sortKey: 'criticality' | 'severity' | 'age' =
      sortParam === 'severity' || sortParam === 'age' ? sortParam : 'criticality';
    items = sortBy(items, sortKey);
    return HttpResponse.json({ items, total: items.length });
  }),

  // ── Acknowledge alerts (Phase 4 — single + bulk) ─────────────────
  http.post('/api/alerts/ack', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === 'string')
      : [];
    for (const id of ids) acknowledgedAlertIds.add(id);
    return HttpResponse.json({ acknowledged: ids });
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

  // Phase 9 T10 — synth fleet-wide rule engine report. Built from rulesV2Seed
  // by joining each envelope's rule + performance into the RuleEngineReportRow
  // shape + computing cohort tallies + a deterministic monthly volume series
  // from a fixed seed-per-rule. Mounted BEFORE /v1/rules/:id so the literal
  // /reports/engine-summary segment isn't captured by the param wildcard.
  http.get('/v1/rules/reports/engine-summary', () => {
    const envelopes = rulesV2Seed();
    const byState: Record<string, number> = {
      draft: 0,
      pending_review: 0,
      approved: 0,
      active: 0,
      rejected: 0,
      deprecated: 0,
    };
    const byFamily: Record<string, number> = {
      Financial: 0,
      Behavioural: 0,
      Transaction: 0,
      Credit: 0,
      Fraud: 0,
    };
    const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    const byPerf: Record<string, number> = {
      performing: 0,
      underperforming: 0,
      deprecated: 0,
      no_data: 0,
    };
    const rows = envelopes.map((e, idx) => {
      const r = e.rule;
      const perf = e.performance;
      byState[r.state] = (byState[r.state] ?? 0) + 1;
      byFamily[r.family] = (byFamily[r.family] ?? 0) + 1;
      bySeverity[r.outcome.severity] = (bySeverity[r.outcome.severity] ?? 0) + 1;
      byPerf[perf.status] = (byPerf[perf.status] ?? 0) + 1;
      const total12 = Math.round(perf.triggers_month * 11.5 + (idx % 7) * 4);
      return {
        rule_id: r.id,
        name: r.name,
        family: r.family,
        state: r.state,
        severity: r.outcome.severity,
        version: r.version,
        applicable_products: r.applicable_products,
        total_alerts_12mo: total12,
        triggers_month: perf.triggers_month,
        triggers_today: perf.triggers_today,
        triggers_week: perf.triggers_week,
        precision_pct: 100 - perf.false_positive_rate,
        coverage_pct: Math.min(95, Math.round((total12 / 220) * 1000) / 10),
        false_positive_rate: perf.false_positive_rate,
        officer_useful_pct: perf.officer_useful_pct,
        avg_days_to_default: perf.avg_days_to_default,
        status: perf.status,
        last_modified_at: r.updated_at,
      };
    });
    const active = rows.filter((r) => r.state === 'active');
    rows.sort((a, b) =>
      b.total_alerts_12mo !== a.total_alerts_12mo
        ? b.total_alerts_12mo - a.total_alerts_12mo
        : a.rule_id < b.rule_id ? -1 : 1,
    );
    const total_alerts_12mo = active.reduce((acc, r) => acc + r.total_alerts_12mo, 0);
    const triggers_month_total = active.reduce((acc, r) => acc + r.triggers_month, 0);
    const monthly_volume: Array<{
      month: string;
      total_alerts: number;
      by_family: Record<string, number>;
    }> = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - i);
      const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const fams: Record<string, number> = {
        Financial: 0,
        Behavioural: 0,
        Transaction: 0,
        Credit: 0,
        Fraud: 0,
      };
      let total = 0;
      for (const r of active) {
        const v = Math.max(0, Math.round((r.total_alerts_12mo / 12) * (0.75 + ((i + 1) % 4) * 0.15)));
        fams[r.family] = (fams[r.family] ?? 0) + v;
        total += v;
      }
      monthly_volume.push({ month: m, total_alerts: total, by_family: fams });
    }
    const mean = (acc: number, len: number) => (len === 0 ? null : Math.round((acc / len) * 10) / 10);
    return HttpResponse.json({
      header: {
        status: 200,
        code: 'EWS_200',
        message: 'ok',
        requestId: `req-${Date.now()}`,
        timestamp: new Date().toISOString(),
      },
      body: {
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        total_rules: rows.length,
        total_active_rules: active.length,
        by_state: byState,
        by_family: byFamily,
        by_severity: bySeverity,
        by_performance_status: byPerf,
        total_alerts_12mo,
        triggers_month_total,
        mean_precision_pct: mean(
          active.reduce((a, r) => a + r.precision_pct, 0),
          active.length,
        ),
        mean_coverage_pct: mean(
          active.reduce((a, r) => a + r.coverage_pct, 0),
          active.length,
        ),
        mean_false_positive_rate: mean(
          active.reduce((a, r) => a + r.false_positive_rate, 0),
          active.length,
        ),
        monthly_volume,
        rows,
        top_firing: rows.slice(0, 10),
        underperforming: rows
          .filter((r) => r.state === 'active' && r.status === 'underperforming')
          .sort((a, b) => b.false_positive_rate - a.false_positive_rate),
        silent_rules: rows
          .filter((r) => r.state === 'active' && r.total_alerts_12mo === 0)
          .sort((a, b) => (a.rule_id < b.rule_id ? -1 : 1)),
      },
    });
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

  // ── Recovery Center (Phase 1) — in-memory MSW mocks ─────────────
  // Mirrors /v1/recovery* on the real BFF. Production envelope-wraps
  // every response; tests + MSW use the body directly via api.ts wrappers.

  http.get('/v1/recovery', ({ request }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const url = new URL(request.url);
    const status = (url.searchParams.get('status') ?? 'archived') as 'archived' | 'restored' | 'purged';
    const module = url.searchParams.get('module');
    const entity_type = url.searchParams.get('entity_type');
    const items = _mockDeletedRecords
      .filter((r) => r.status === status)
      .filter((r) => !module || r.module === module)
      .filter((r) => !entity_type || r.entity_type === entity_type)
      .sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : -1));
    return HttpResponse.json({
      header: { status: 'SUCCESS', requestId: 'r-mock', timestamp: new Date().toISOString() },
      body: { items, total: items.length },
    });
  }),

  http.get('/v1/recovery/stats', () => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const by_status = { archived: 0, restored: 0, purged: 0 };
    const by_module: Record<string, number> = {};
    const by_entity_type: Record<string, number> = {};
    let most_recent_at: string | null = null;
    for (const r of _mockDeletedRecords) {
      by_status[r.status] += 1;
      by_module[r.module] = (by_module[r.module] ?? 0) + 1;
      by_entity_type[r.entity_type] = (by_entity_type[r.entity_type] ?? 0) + 1;
      if (!most_recent_at || r.deleted_at > most_recent_at) most_recent_at = r.deleted_at;
    }
    return HttpResponse.json({
      header: { status: 'SUCCESS', requestId: 'r-mock', timestamp: new Date().toISOString() },
      body: {
        total: _mockDeletedRecords.length,
        by_status,
        by_module,
        by_entity_type,
        most_recent_at,
        // Phase 2 wired all 10 adopters (5 BFF-local + 5 cross-service
        // via auth-svc). Listed in the same order as recovery-center.md
        // so dev-mode UX matches production exactly.
        adapters: [
          // BFF-local
          { entity_type: 'webhook_subscription', display_name: 'Webhook subscription', module: 'bff' },
          { entity_type: 'saved_scenario', display_name: 'Saved scenario', module: 'bff' },
          { entity_type: 'saved_report_filter', display_name: 'Saved report filter', module: 'bff' },
          { entity_type: 'cms_case_attachment', display_name: 'CMS case attachment', module: 'bff' },
          { entity_type: 'tenant', display_name: 'Tenant', module: 'bff' },
          // Cross-service (auth-svc, via the BFF→auth-svc shared-secret restore endpoint)
          { entity_type: 'user_team', display_name: 'Team (Issue Owner Group)', module: 'auth-svc' },
          { entity_type: 'user_team_member', display_name: 'Team member', module: 'auth-svc' },
          { entity_type: 'role_dashboard_widget', display_name: 'Dashboard widget layout (per role)', module: 'auth-svc' },
          { entity_type: 'service_client', display_name: 'OAuth service client', module: 'auth-svc' },
          { entity_type: 'user', display_name: 'User account', module: 'auth-svc' },
        ],
      },
    });
  }),

  // Phase 3 — operator analytics. Returns a representative fixture
  // computed from the in-memory _mockDeletedRecords array, but with
  // some synthetic numbers for the time-to-restore distribution +
  // top_actors so the SPA charts render meaningfully in dev mode.
  http.get('/v1/recovery/analytics', ({ request }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const url = new URL(request.url);
    const days = Math.max(1, Math.min(365, Number.parseInt(url.searchParams.get('days') ?? '30', 10) || 30));
    const now = new Date();
    const windowStart = new Date(now.getTime() - days * 86400 * 1000);

    // Per-day timeline (always exactly `days` buckets, oldest first).
    const by_day: Array<{
      date: string;
      total: number;
      by_status: { archived: number; restored: number; purged: number };
    }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400 * 1000);
      by_day.push({
        date: d.toISOString().slice(0, 10),
        total: 0,
        by_status: { archived: 0, restored: 0, purged: 0 },
      });
    }
    const dayIndex = new Map(by_day.map((b, i) => [b.date, i]));

    const archivedInWindow: typeof _mockDeletedRecords = [];
    const restoredInWindow: typeof _mockDeletedRecords = [];
    const purgedInWindow: typeof _mockDeletedRecords = [];
    const inWindow = (iso: string | null): boolean => {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return t >= windowStart.getTime() && t <= now.getTime();
    };

    for (const r of _mockDeletedRecords) {
      if (inWindow(r.deleted_at)) {
        archivedInWindow.push(r);
        const idx = dayIndex.get(new Date(r.deleted_at).toISOString().slice(0, 10));
        if (idx !== undefined) {
          by_day[idx].total += 1;
          by_day[idx].by_status.archived += 1;
        }
      }
      if (r.restored_at && inWindow(r.restored_at)) {
        restoredInWindow.push(r);
        const idx = dayIndex.get(new Date(r.restored_at).toISOString().slice(0, 10));
        if (idx !== undefined) {
          by_day[idx].total += 1;
          by_day[idx].by_status.restored += 1;
        }
      }
      if (r.purged_at && inWindow(r.purged_at)) {
        purgedInWindow.push(r);
        const idx = dayIndex.get(new Date(r.purged_at).toISOString().slice(0, 10));
        if (idx !== undefined) {
          by_day[idx].total += 1;
          by_day[idx].by_status.purged += 1;
        }
      }
    }

    // top_actors (capped 10, sorted desc by total ops with username asc tie-break).
    const actorMap = new Map<
      string,
      {
        actor_username: string;
        total_archives: number;
        total_restores: number;
        total_purges: number;
        most_recent_at: string;
      }
    >();
    function bumpActor(
      u: string | null,
      field: 'total_archives' | 'total_restores' | 'total_purges',
      ts: string,
    ) {
      if (!u) return;
      let row = actorMap.get(u);
      if (!row) {
        row = { actor_username: u, total_archives: 0, total_restores: 0, total_purges: 0, most_recent_at: ts };
        actorMap.set(u, row);
      }
      row[field] += 1;
      if (ts > row.most_recent_at) row.most_recent_at = ts;
    }
    for (const r of archivedInWindow) bumpActor(r.deleted_by, 'total_archives', r.deleted_at);
    for (const r of restoredInWindow) bumpActor(r.restored_by, 'total_restores', r.restored_at!);
    for (const r of purgedInWindow) bumpActor(r.purged_by, 'total_purges', r.purged_at!);
    const top_actors = [...actorMap.values()]
      .sort((a, b) => {
        const ta = a.total_archives + a.total_restores + a.total_purges;
        const tb = b.total_archives + b.total_restores + b.total_purges;
        if (tb !== ta) return tb - ta;
        return a.actor_username.localeCompare(b.actor_username);
      })
      .slice(0, 10);

    // by_entity_type (capped 20).
    const entityMap = new Map<
      string,
      { entity_type: string; total_archives: number; total_restores: number; total_purges: number; outstanding_delta: number }
    >();
    function ensureEntity(et: string) {
      let row = entityMap.get(et);
      if (!row) {
        row = { entity_type: et, total_archives: 0, total_restores: 0, total_purges: 0, outstanding_delta: 0 };
        entityMap.set(et, row);
      }
      return row;
    }
    for (const r of archivedInWindow) ensureEntity(r.entity_type).total_archives += 1;
    for (const r of restoredInWindow) ensureEntity(r.entity_type).total_restores += 1;
    for (const r of purgedInWindow) ensureEntity(r.entity_type).total_purges += 1;
    for (const row of entityMap.values()) row.outstanding_delta = row.total_archives - row.total_restores;
    const by_entity_type = [...entityMap.values()]
      .sort((a, b) => b.total_archives - a.total_archives || a.entity_type.localeCompare(b.entity_type))
      .slice(0, 20);

    // by_module (capped 10).
    const moduleMap = new Map<string, { module: string; total_archives: number; total_restores: number; total_purges: number }>();
    function ensureModule(m: string) {
      let row = moduleMap.get(m);
      if (!row) {
        row = { module: m, total_archives: 0, total_restores: 0, total_purges: 0 };
        moduleMap.set(m, row);
      }
      return row;
    }
    for (const r of archivedInWindow) ensureModule(r.module).total_archives += 1;
    for (const r of restoredInWindow) ensureModule(r.module).total_restores += 1;
    for (const r of purgedInWindow) ensureModule(r.module).total_purges += 1;
    const by_module = [...moduleMap.values()]
      .sort((a, b) => b.total_archives - a.total_archives || a.module.localeCompare(b.module))
      .slice(0, 10);

    // Cohort rates.
    const cohortRestored = archivedInWindow.filter((r) => r.restored_at !== null).length;
    const cohortPurged = archivedInWindow.filter((r) => r.purged_at !== null).length;
    const cohortSize = archivedInWindow.length;
    const restore_rate = cohortSize > 0 ? Math.round((cohortRestored / cohortSize) * 1000) / 1000 : null;
    const purge_rate = cohortSize > 0 ? Math.round((cohortPurged / cohortSize) * 1000) / 1000 : null;

    // Time-to-restore (synthetic since MSW seeds don't restore in the
    // window). When no restores: nulls. Otherwise a representative
    // distribution.
    const ttrSamples: number[] = [];
    for (const r of restoredInWindow) {
      const archivedAt = new Date(r.deleted_at).getTime();
      const restoredAt = new Date(r.restored_at!).getTime();
      if (restoredAt > archivedAt) ttrSamples.push((restoredAt - archivedAt) / (1000 * 60 * 60));
    }
    ttrSamples.sort((a, b) => a - b);
    function pct(arr: number[], p: number): number {
      const rank = (p / 100) * (arr.length - 1);
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      if (lo === hi) return arr[lo];
      return arr[lo] + (rank - lo) * (arr[hi] - arr[lo]);
    }
    const mean_time_to_restore_hours =
      ttrSamples.length === 0
        ? null
        : Math.round((ttrSamples.reduce((a, b) => a + b, 0) / ttrSamples.length) * 10) / 10;
    const p50_time_to_restore_hours =
      ttrSamples.length < 2 ? null : Math.round(pct(ttrSamples, 50) * 10) / 10;
    const p95_time_to_restore_hours =
      ttrSamples.length < 2 ? null : Math.round(pct(ttrSamples, 95) * 10) / 10;

    return HttpResponse.json({
      header: { status: 'SUCCESS', requestId: 'r-mock', timestamp: now.toISOString() },
      body: {
        tenant_id: 'BANK_DEMO',
        generated_at: now.toISOString(),
        days,
        window_start: windowStart.toISOString(),
        window_end: now.toISOString(),
        total_archives_in_window: archivedInWindow.length,
        total_restores_in_window: restoredInWindow.length,
        total_purges_in_window: purgedInWindow.length,
        by_day,
        top_actors,
        by_entity_type,
        by_module,
        restore_rate,
        purge_rate,
        mean_time_to_restore_hours,
        p50_time_to_restore_hours,
        p95_time_to_restore_hours,
      },
    });
  }),

  http.get('/v1/recovery/:id', ({ params }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const r = _mockDeletedRecords.find((x) => x.recovery_id === params.id);
    if (!r) {
      return HttpResponse.json(
        { error: { code: 'EWS_404', message: 'not found' } },
        { status: 404 },
      );
    }
    return HttpResponse.json({
      header: { status: 'SUCCESS', requestId: 'r-mock', timestamp: new Date().toISOString() },
      body: r,
    });
  }),

  http.post('/v1/recovery/:id/restore', ({ params }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const idx = _mockDeletedRecords.findIndex((x) => x.recovery_id === params.id);
    if (idx < 0) return HttpResponse.json({ error: { code: 'EWS_404' } }, { status: 404 });
    const r = _mockDeletedRecords[idx];
    if (r.status !== 'archived') {
      return HttpResponse.json(
        { error: { code: `EWS_409_already_${r.status}`, message: `already ${r.status}` } },
        { status: 409 },
      );
    }
    _mockDeletedRecords[idx] = {
      ...r,
      restored_at: new Date().toISOString(),
      restored_by: 'admin',
      status: 'restored',
    };
    return HttpResponse.json({
      header: { status: 'SUCCESS', requestId: 'r-mock', timestamp: new Date().toISOString() },
      body: _mockDeletedRecords[idx],
    });
  }),

  http.delete('/v1/recovery/:id', ({ params }) => {
    if (readPersistedRole() !== 'admin') {
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const idx = _mockDeletedRecords.findIndex((x) => x.recovery_id === params.id);
    if (idx < 0) return HttpResponse.json({ error: { code: 'EWS_404' } }, { status: 404 });
    const r = _mockDeletedRecords[idx];
    if (r.status === 'restored') {
      return HttpResponse.json(
        { error: { code: 'EWS_409_invalid_status_transition' } },
        { status: 409 },
      );
    }
    _mockDeletedRecords[idx] = {
      ...r,
      purged_at: new Date().toISOString(),
      purged_by: 'admin',
      status: 'purged',
    };
    return new HttpResponse(null, { status: 204 });
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
      payload: { message: 'ZorEWS webhook test event', subscription_id: sub.id, sent_at: ts },
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
    const entityType = url.searchParams.get('entity_type');
    const VALID_ENTITY_TYPES = ['user_access_override', 'report_export', 'ews_rule_version'];
    if (entityType && !VALID_ENTITY_TYPES.includes(entityType)) {
      return HttpResponse.json(
        envelopeError(
          'EWS_400_invalid_input',
          `entity_type must be one of ${VALID_ENTITY_TYPES.join(',')}`,
          'MEDIUM',
        ),
        { status: 400 },
      );
    }
    let rows = [...mswOverrideAudit, ...mswExtraAuditSeeds];
    if (entityType) rows = rows.filter((a) => a.entity_type === entityType);
    if (entityId) rows = rows.filter((a) => a.entity_id === entityId);
    if (actorId) rows = rows.filter((a) => a.actor_id === actorId);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return HttpResponse.json(envelope({ items: rows, total: rows.length, page: 1, page_size: 50 }));
  }),

  // ── SLA Config admin (BAC §3.1.6) ──────────────────────────────────

  http.get('/v1/admin/sla-config', ({ request }) => {
    const url = new URL(request.url);
    const cat = url.searchParams.get('case_category');
    const prio = url.searchParams.get('priority');
    const bu = url.searchParams.get('business_unit');
    const status = url.searchParams.get('status');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? 100)));
    let rows = mswSlaConfigs.slice();
    if (cat) rows = rows.filter((r) => r.case_category === cat);
    if (prio) rows = rows.filter((r) => r.priority === prio);
    if (bu !== null) {
      const isAll = bu === '*' || bu === '';
      rows = rows.filter((r) => (isAll ? r.business_unit === null : r.business_unit === bu));
    }
    if (status) {
      const set = new Set(status.split(',').map((s) => s.trim()));
      rows = rows.filter((r) => set.has(r.status));
    }
    rows.sort((a, b) => {
      if (a.case_category !== b.case_category) return a.case_category.localeCompare(b.case_category);
      if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
      return b.created_at.localeCompare(a.created_at);
    });
    const start = (page - 1) * pageSize;
    return HttpResponse.json(
      envelope({
        items: rows.slice(start, start + pageSize),
        total: rows.length,
        page,
        page_size: pageSize,
      }),
    );
  }),

  http.get('/v1/admin/sla-config/:id', ({ params }) => {
    const r = mswSlaConfigs.find((x) => x.sla_config_id === params.id);
    if (!r) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `sla_config ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/admin/sla-config', async ({ request }) => {
    const body = (await request.json()) as MswSlaCreateInput;
    if (!body.case_category || !body.priority) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'case_category + priority required', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (!Number.isFinite(body.sla_target_days) || body.sla_target_days <= 0 || body.sla_target_days > 365) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'sla_target_days must be in (0, 365]', 'MEDIUM'),
        { status: 400 },
      );
    }
    const dup = mswSlaConfigs.find(
      (r) =>
        r.tenant_id === 'BANK_DEMO' &&
        r.case_category === body.case_category &&
        r.priority === body.priority &&
        (r.business_unit ?? null) === (body.business_unit ?? null) &&
        r.status === 'ACTIVE',
    );
    if (dup) {
      return HttpResponse.json(
        envelopeError(
          'EWS_409_duplicate_active_sla_config',
          `${body.case_category}/${body.priority}/${body.business_unit ?? '*'} already ACTIVE`,
          'MEDIUM',
        ),
        { status: 409 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const row: MswSlaConfig = {
      sla_config_id: `sla-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenant_id: 'BANK_DEMO',
      case_category: body.case_category,
      priority: body.priority,
      business_unit: body.business_unit ?? null,
      sla_target_days: Math.round(body.sla_target_days * 100) / 100,
      status: 'ACTIVE',
      effective_from: now,
      effective_till: null,
      notes: body.notes ?? null,
      created_by: actor,
      updated_by: null,
      superseded_by: null,
      created_at: now,
      updated_at: now,
    };
    mswSlaConfigs.push(row);
    return HttpResponse.json(envelope(row, 'EWS_201_created', 'Created'), { status: 201 });
  }),

  http.put('/v1/admin/sla-config/:id', async ({ params, request }) => {
    const idx = mswSlaConfigs.findIndex((x) => x.sla_config_id === params.id);
    if (idx < 0) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `sla_config ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    const old = mswSlaConfigs[idx];
    if (old.status !== 'ACTIVE') {
      return HttpResponse.json(
        envelopeError('EWS_409_invalid_state', `only ACTIVE rows can be edited`, 'MEDIUM'),
        { status: 409 },
      );
    }
    const patch = (await request.json()) as { sla_target_days?: number; notes?: string | null };
    if (
      patch.sla_target_days !== undefined &&
      (!Number.isFinite(patch.sla_target_days) || patch.sla_target_days <= 0 || patch.sla_target_days > 365)
    ) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'sla_target_days out of range', 'MEDIUM'),
        { status: 400 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const newId = `sla-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next: MswSlaConfig = {
      ...old,
      sla_config_id: newId,
      sla_target_days:
        patch.sla_target_days !== undefined
          ? Math.round(patch.sla_target_days * 100) / 100
          : old.sla_target_days,
      notes: patch.notes !== undefined ? patch.notes : old.notes,
      effective_from: now,
      effective_till: null,
      created_by: actor,
      updated_by: null,
      superseded_by: null,
      created_at: now,
      updated_at: now,
      status: 'ACTIVE',
    };
    mswSlaConfigs[idx] = {
      ...old,
      status: 'SUPERSEDED',
      effective_till: now,
      superseded_by: newId,
      updated_by: actor,
      updated_at: now,
    };
    mswSlaConfigs.push(next);
    return HttpResponse.json(envelope(next));
  }),

  http.delete('/v1/admin/sla-config/:id', ({ params }) => {
    const idx = mswSlaConfigs.findIndex((x) => x.sla_config_id === params.id);
    if (idx < 0) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `sla_config ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    const old = mswSlaConfigs[idx];
    if (old.status === 'ARCHIVED') return HttpResponse.json(envelope(old));
    if (old.status !== 'ACTIVE') {
      return HttpResponse.json(
        envelopeError('EWS_409_invalid_state', `cannot archive a ${old.status} row`, 'MEDIUM'),
        { status: 409 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const next: MswSlaConfig = {
      ...old,
      status: 'ARCHIVED',
      effective_till: now,
      updated_by: actor,
      updated_at: now,
    };
    mswSlaConfigs[idx] = next;
    return HttpResponse.json(envelope(next));
  }),

  // ── Notification Templates admin (T6 M14.16/M14.19) ────────────────

  http.get('/v1/admin/notification-templates', ({ request }) => {
    const tenant = readTenantFromReq(request);
    const url = new URL(request.url);
    const channel = url.searchParams.get('channel');
    const status = url.searchParams.get('status');
    const includeDeleted = url.searchParams.get('include_deleted') === 'true';
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? 100)));
    let rows = mswNotificationTemplates.filter((r) => r.tenant_id === tenant);
    if (!includeDeleted) rows = rows.filter((r) => r.deleted_at === null);
    if (channel) rows = rows.filter((r) => r.channel === channel);
    if (status) {
      const set = new Set(status.split(',').map((s) => s.trim()));
      rows = rows.filter((r) => set.has(r.status));
    }
    rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const start = (page - 1) * pageSize;
    return HttpResponse.json(
      envelope({
        items: rows.slice(start, start + pageSize),
        total: rows.length,
        page,
        page_size: pageSize,
      }),
    );
  }),

  // M14.24 GET /dispatches declared BEFORE GET /:id so the literal
  // /dispatches doesn't match :id="dispatches" first.
  http.get('/v1/admin/notification-templates/dispatches', ({ request }) => {
    const tenant = readTenantFromReq(request);
    const url = new URL(request.url);
    const template_id = url.searchParams.get('template_id');
    const reference = url.searchParams.get('reference');
    const trigger = url.searchParams.get('trigger');
    const status = url.searchParams.get('status');
    const since = url.searchParams.get('since');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? 100)));
    let rows = mswDispatchLog.filter((r) => r.tenant_id === tenant);
    if (template_id) rows = rows.filter((r) => r.template_id === template_id);
    if (reference) rows = rows.filter((r) => r.reference === reference);
    if (trigger) rows = rows.filter((r) => r.trigger === trigger);
    if (status) {
      const set = new Set(status.split(',').map((s) => s.trim()));
      rows = rows.filter((r) => set.has(r.status));
    }
    if (since) {
      const sinceMs = new Date(since).getTime();
      if (Number.isFinite(sinceMs)) {
        rows = rows.filter((r) => new Date(r.performed_at).getTime() >= sinceMs);
      }
    }
    rows.sort((a, b) => b.performed_at.localeCompare(a.performed_at));
    const start = (page - 1) * pageSize;
    return HttpResponse.json(
      envelope({
        items: rows.slice(start, start + pageSize),
        total: rows.length,
        page,
        page_size: pageSize,
      }),
    );
  }),

  http.get('/v1/admin/notification-templates/:id', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const r = mswNotificationTemplates.find(
      (x) => x.template_id === params.id && x.tenant_id === tenant,
    );
    if (!r) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `template ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/admin/notification-templates', async ({ request }) => {
    const tenant = readTenantFromReq(request);
    const body = (await request.json()) as MswNotificationTemplateCreateInput;
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'name required', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (body.channel !== 'EMAIL' && body.channel !== 'SMS' && body.channel !== 'IN_APP') {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'channel must be EMAIL/SMS/IN_APP', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (body.channel === 'SMS' && body.subject !== null && body.subject !== undefined && body.subject !== '') {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'subject must be null for SMS channel', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (body.channel !== 'SMS' && (!body.subject || body.subject.trim().length === 0)) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', `subject required for ${body.channel} channel`, 'MEDIUM'),
        { status: 400 },
      );
    }
    if (typeof body.body !== 'string' || body.body.length === 0 || body.body.length > 10000) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'body length must be 1..10000', 'MEDIUM'),
        { status: 400 },
      );
    }
    const locale = body.locale ?? 'en-IN';
    const dup = mswNotificationTemplates.find(
      (r) =>
        r.tenant_id === tenant &&
        r.deleted_at === null &&
        r.name.toLowerCase() === body.name.trim().toLowerCase() &&
        r.locale === locale,
    );
    if (dup) {
      return HttpResponse.json(
        envelopeError(
          'EWS_409_duplicate_template_name',
          `template "${body.name}" already used in locale ${locale}`,
          'MEDIUM',
        ),
        { status: 409 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const row: MswNotificationTemplate = {
      template_id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenant_id: tenant,
      name: body.name.trim(),
      channel: body.channel,
      subject: body.channel === 'SMS' ? null : (body.subject as string).trim(),
      body: body.body,
      locale,
      status: 'DRAFT',
      created_by: actor,
      updated_by: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    mswNotificationTemplates.push(row);
    return HttpResponse.json(envelope(row, 'EWS_201_created', 'Created'), { status: 201 });
  }),

  http.patch('/v1/admin/notification-templates/:id', async ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswNotificationTemplates.findIndex(
      (x) => x.template_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `template ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    const old = mswNotificationTemplates[idx];
    if (old.deleted_at !== null) {
      return HttpResponse.json(
        envelopeError('EWS_409_invalid_state', 'cannot update an archived template', 'MEDIUM'),
        { status: 409 },
      );
    }
    const patch = (await request.json()) as {
      name?: string;
      subject?: string | null;
      body?: string;
      locale?: string;
    };
    if (patch.subject !== undefined && patch.subject !== null) {
      if (old.channel === 'SMS') {
        return HttpResponse.json(
          envelopeError('EWS_400_invalid_input', 'subject must be null for SMS channel', 'MEDIUM'),
          { status: 400 },
        );
      }
    }
    if (patch.body !== undefined && (patch.body.length === 0 || patch.body.length > 10000)) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'body length must be 1..10000', 'MEDIUM'),
        { status: 400 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswNotificationTemplate = {
      ...old,
      name: patch.name ?? old.name,
      subject: patch.subject !== undefined ? patch.subject : old.subject,
      body: patch.body ?? old.body,
      locale: patch.locale ?? old.locale,
      updated_by: actor,
      updated_at: now,
    };
    mswNotificationTemplates[idx] = updated;
    return HttpResponse.json(envelope(updated));
  }),

  http.post('/v1/admin/notification-templates/:id/activate', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswNotificationTemplates.findIndex(
      (x) => x.template_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `template ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    const old = mswNotificationTemplates[idx];
    if (old.deleted_at !== null || old.status === 'ARCHIVED') {
      return HttpResponse.json(
        envelopeError('EWS_409_invalid_state', 'cannot activate an archived template', 'MEDIUM'),
        { status: 409 },
      );
    }
    if (old.status === 'ACTIVE') return HttpResponse.json(envelope(old));
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswNotificationTemplate = { ...old, status: 'ACTIVE', updated_by: actor, updated_at: now };
    mswNotificationTemplates[idx] = updated;
    return HttpResponse.json(envelope(updated));
  }),

  http.delete('/v1/admin/notification-templates/:id', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswNotificationTemplates.findIndex(
      (x) => x.template_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `template ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    const old = mswNotificationTemplates[idx];
    if (old.deleted_at !== null) return HttpResponse.json(envelope(old));
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswNotificationTemplate = {
      ...old,
      status: 'ARCHIVED',
      deleted_at: now,
      updated_by: actor,
      updated_at: now,
    };
    mswNotificationTemplates[idx] = updated;
    return HttpResponse.json(envelope(updated));
  }),

  // M14.24 preview + test-fire (GET /dispatches lives further up so
  // it doesn't get shadowed by GET /:id).

  http.post('/v1/admin/notification-templates/:id/preview', async ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const tpl = mswNotificationTemplates.find(
      (x) => x.template_id === params.id && x.tenant_id === tenant,
    );
    if (!tpl) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `template ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    const body = (await request.json()) as { vars?: unknown };
    if (body.vars !== undefined && body.vars !== null && typeof body.vars !== 'object') {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'vars must be an object', 'MEDIUM'),
        { status: 400 },
      );
    }
    const rendered = _renderTemplate(tpl, (body.vars as Record<string, unknown>) ?? {});
    return HttpResponse.json(envelope(rendered));
  }),

  // ── M14.25 escalation worker (preview + tick) ──────────────────────

  http.post('/v1/admin/escalations/preview', async ({ request }) => {
    const tenant = readTenantFromReq(request);
    const body = (await request.json()) as { open_cases?: unknown };
    const result = _computeEscalationsForRequest(tenant, body.open_cases, new Date());
    if ('error' in result) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', result.error, 'MEDIUM'),
        { status: 400 },
      );
    }
    return HttpResponse.json(envelope(result.payload));
  }),

  // ── M14.25b worker status ─────────────────────────────────────────
  // The cron only runs server-side under ESCALATION_WORKER_INTERVAL_SEC,
  // so the MSW mock returns cron_wired=false + zeros — same shape so
  // the SPA renders the disabled state uniformly.
  http.get('/v1/admin/escalations/worker/status', () =>
    HttpResponse.json(
      envelope({
        running: false,
        interval_ms: 0,
        tenants: [] as string[],
        total_runs: 0,
        last_run_at: null,
        last_run_dispatched: 0,
        last_run_inspected: 0,
        last_error: null,
        cron_wired: false,
      }),
    ),
  ),

  http.post('/v1/admin/escalations/tick', async ({ request }) => {
    const tenant = readTenantFromReq(request);
    const body = (await request.json()) as { open_cases?: unknown };
    const now = new Date();
    const result = _computeEscalationsForRequest(tenant, body.open_cases, now);
    if ('error' in result) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', result.error, 'MEDIUM'),
        { status: 400 },
      );
    }
    const actor = readPersistedUsername() ?? 'admin';
    const dispatched: MswDispatchEntry[] = [];
    for (const d of result.payload.due) {
      const entry: MswDispatchEntry = {
        dispatch_id: `disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tenant_id: tenant,
        template_id: d.template_id ?? '00000000-0000-0000-0000-000000000000',
        template_name: d.template_name,
        channel: d.channel,
        recipient: `role:${d.role}`,
        trigger: 'escalation_worker',
        reference: `case:${d.case_id}:lvl:${d.level}`,
        rendered_subject: d.rendered_subject,
        rendered_body: d.rendered_body,
        missing_vars: d.missing_vars,
        status: 'sent',
        status_reason:
          d.missing_vars.length > 0
            ? `dispatched with ${d.missing_vars.length} missing var(s)`
            : null,
        performed_by: actor,
        performed_at: now.toISOString(),
      };
      mswDispatchLog.push(entry);
      while (mswDispatchLog.length > 500) mswDispatchLog.shift();
      dispatched.push(entry);
    }
    return HttpResponse.json(envelope({ ...result.payload, dispatched }));
  }),

  http.post('/v1/admin/notification-templates/:id/test-fire', async ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const tpl = mswNotificationTemplates.find(
      (x) => x.template_id === params.id && x.tenant_id === tenant,
    );
    if (!tpl) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `template ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    if (tpl.deleted_at !== null || tpl.status === 'ARCHIVED') {
      return HttpResponse.json(
        envelopeError('EWS_409_invalid_state', 'cannot test-fire an archived template', 'MEDIUM'),
        { status: 409 },
      );
    }
    const body = (await request.json()) as {
      vars?: unknown;
      recipient?: unknown;
      reference?: unknown;
      refuse_when_missing?: unknown;
    };
    if (typeof body.recipient !== 'string' || !body.recipient.trim()) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'recipient required (string)', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (body.recipient.length > 200) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'recipient max 200 chars', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (body.vars !== null && body.vars !== undefined && (typeof body.vars !== 'object' || Array.isArray(body.vars))) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'vars must be an object', 'MEDIUM'),
        { status: 400 },
      );
    }
    const vars = (body.vars as Record<string, unknown> | undefined) ?? {};
    const refuseMissing = body.refuse_when_missing === true;
    const reference =
      typeof body.reference === 'string' && body.reference.trim()
        ? body.reference.trim().slice(0, 200)
        : null;
    const rendered = _renderTemplate(tpl, vars);
    if (refuseMissing && rendered.missing_vars.length > 0) {
      return HttpResponse.json(
        envelopeError(
          'EWS_422_missing_template_vars',
          `refuse_when_missing: template references unset vars: ${rendered.missing_vars.join(', ')}`,
          'MEDIUM',
        ),
        { status: 422 },
      );
    }
    const actor = readPersistedUsername() ?? 'admin';
    const now = new Date().toISOString();
    const dispatch: MswDispatchEntry = {
      dispatch_id: `disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenant_id: tenant,
      template_id: tpl.template_id,
      template_name: tpl.name,
      channel: tpl.channel,
      recipient: body.recipient.trim(),
      trigger: 'admin_test_fire',
      reference,
      rendered_subject: rendered.subject,
      rendered_body: rendered.body,
      missing_vars: rendered.missing_vars,
      status: 'sent',
      status_reason:
        rendered.missing_vars.length > 0
          ? `dispatched with ${rendered.missing_vars.length} missing var(s)`
          : null,
      performed_by: actor,
      performed_at: now,
    };
    mswDispatchLog.push(dispatch);
    while (mswDispatchLog.length > 500) mswDispatchLog.shift();
    return HttpResponse.json(envelope({ rendered, dispatch }));
  }),

  // ── Escalation Matrix admin (T6 M14.17/M14.20) ──────────────────────

  // /resolve declared BEFORE /:id so the literal doesn't get shadowed.
  http.get('/v1/admin/escalation-matrix/resolve', ({ request }) => {
    const tenant = readTenantFromReq(request);
    const url = new URL(request.url);
    const cat = url.searchParams.get('case_category');
    const prio = url.searchParams.get('priority');
    if (!cat || !prio) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'case_category + priority required', 'MEDIUM'),
        { status: 400 },
      );
    }
    const matches = mswEscalationRules
      .filter((r) => r.tenant_id === tenant && r.status === 'ACTIVE' && r.case_category === cat && r.priority === prio)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return HttpResponse.json(envelope({ rule: matches[0] ?? null }));
  }),

  http.get('/v1/admin/escalation-matrix', ({ request }) => {
    const tenant = readTenantFromReq(request);
    const url = new URL(request.url);
    const cat = url.searchParams.get('case_category');
    const prio = url.searchParams.get('priority');
    const status = url.searchParams.get('status');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? 100)));
    let rows = mswEscalationRules.filter((r) => r.tenant_id === tenant);
    if (cat) rows = rows.filter((r) => r.case_category === cat);
    if (prio) rows = rows.filter((r) => r.priority === prio);
    if (status) {
      const set = new Set(status.split(',').map((s) => s.trim()));
      rows = rows.filter((r) => set.has(r.status));
    }
    rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const start = (page - 1) * pageSize;
    return HttpResponse.json(
      envelope({
        items: rows.slice(start, start + pageSize),
        total: rows.length,
        page,
        page_size: pageSize,
      }),
    );
  }),

  http.get('/v1/admin/escalation-matrix/:id', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const r = mswEscalationRules.find(
      (x) => x.escalation_id === params.id && x.tenant_id === tenant,
    );
    if (!r) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `escalation rule ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/admin/escalation-matrix', async ({ request }) => {
    const tenant = readTenantFromReq(request);
    const body = (await request.json()) as MswEscalationCreateInput;
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'name required', 'MEDIUM'), { status: 400 });
    }
    if (!ESC_ROLES.includes(body.level_1_role)) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', `level_1_role must be one of ${ESC_ROLES.join('|')}`, 'MEDIUM'), { status: 400 });
    }
    if (body.level_2_role !== null && body.level_2_role !== undefined && !ESC_ROLES.includes(body.level_2_role)) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', `level_2_role must be one of ${ESC_ROLES.join('|')}`, 'MEDIUM'), { status: 400 });
    }
    if (body.level_3_role !== null && body.level_3_role !== undefined && !ESC_ROLES.includes(body.level_3_role)) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', `level_3_role must be one of ${ESC_ROLES.join('|')}`, 'MEDIUM'), { status: 400 });
    }
    const chainErr = _validateEscChain(
      body.level_1_after_minutes,
      body.level_2_after_minutes ?? null, body.level_2_role ?? null,
      body.level_3_after_minutes ?? null, body.level_3_role ?? null,
    );
    if (chainErr) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', chainErr, 'MEDIUM'), { status: 400 });
    }
    const dup = mswEscalationRules.find(
      (r) => r.tenant_id === tenant && r.name.toLowerCase() === body.name.trim().toLowerCase(),
    );
    if (dup) {
      return HttpResponse.json(
        envelopeError('EWS_409_duplicate_escalation_name', `escalation "${body.name}" already used`, 'MEDIUM'),
        { status: 409 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const row: MswEscalationRule = {
      escalation_id: `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenant_id: tenant,
      name: body.name.trim(),
      case_category: body.case_category,
      priority: body.priority,
      level_1_after_minutes: body.level_1_after_minutes,
      level_1_role: body.level_1_role,
      level_2_after_minutes: body.level_2_after_minutes ?? null,
      level_2_role: body.level_2_role ?? null,
      level_3_after_minutes: body.level_3_after_minutes ?? null,
      level_3_role: body.level_3_role ?? null,
      status: 'ACTIVE',
      created_by: actor,
      updated_by: null,
      created_at: now,
      updated_at: now,
    };
    mswEscalationRules.push(row);
    return HttpResponse.json(envelope(row, 'EWS_201_created', 'Created'), { status: 201 });
  }),

  http.patch('/v1/admin/escalation-matrix/:id', async ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswEscalationRules.findIndex(
      (x) => x.escalation_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_not_found', `escalation rule ${params.id} not found`, 'LOW'), { status: 404 });
    }
    const old = mswEscalationRules[idx];
    if (old.status === 'ARCHIVED') {
      return HttpResponse.json(envelopeError('EWS_409_invalid_state', 'cannot update an archived rule', 'MEDIUM'), { status: 409 });
    }
    const patch = (await request.json()) as Partial<MswEscalationCreateInput>;
    const merged = {
      level_1_after_minutes: patch.level_1_after_minutes ?? old.level_1_after_minutes,
      level_1_role: patch.level_1_role ?? old.level_1_role,
      level_2_after_minutes: patch.level_2_after_minutes !== undefined ? patch.level_2_after_minutes : old.level_2_after_minutes,
      level_2_role: patch.level_2_role !== undefined ? patch.level_2_role : old.level_2_role,
      level_3_after_minutes: patch.level_3_after_minutes !== undefined ? patch.level_3_after_minutes : old.level_3_after_minutes,
      level_3_role: patch.level_3_role !== undefined ? patch.level_3_role : old.level_3_role,
    };
    if (!ESC_ROLES.includes(merged.level_1_role)) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', `level_1_role must be one of ${ESC_ROLES.join('|')}`, 'MEDIUM'), { status: 400 });
    }
    const chainErr = _validateEscChain(
      merged.level_1_after_minutes,
      merged.level_2_after_minutes, merged.level_2_role,
      merged.level_3_after_minutes, merged.level_3_role,
    );
    if (chainErr) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', chainErr, 'MEDIUM'), { status: 400 });
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswEscalationRule = {
      ...old,
      name: patch.name ?? old.name,
      ...merged,
      updated_by: actor,
      updated_at: now,
    };
    mswEscalationRules[idx] = updated;
    return HttpResponse.json(envelope(updated));
  }),

  http.delete('/v1/admin/escalation-matrix/:id', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswEscalationRules.findIndex(
      (x) => x.escalation_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_not_found', `escalation rule ${params.id} not found`, 'LOW'), { status: 404 });
    }
    const old = mswEscalationRules[idx];
    if (old.status === 'ARCHIVED') return HttpResponse.json(envelope(old));
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswEscalationRule = { ...old, status: 'ARCHIVED', updated_by: actor, updated_at: now };
    mswEscalationRules[idx] = updated;
    return HttpResponse.json(envelope(updated));
  }),

  // ── Case Scenarios admin (T6 M14.18/M14.21) ─────────────────────────

  // /:id/history declared BEFORE /:id so the literal /history doesn't get
  // mistaken for an id segment.
  http.get('/v1/admin/case-scenarios/:id/history', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const id = String(params.id);
    const sc = mswCaseScenarios.find(
      (x) => x.scenario_id === id && x.tenant_id === tenant,
    );
    if (!sc) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `scenario ${id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    const items = mswCaseScenarioHistory
      .filter((r) => r.scenario_id === id && r.tenant_id === tenant)
      .sort((a, b) => b.history_id - a.history_id);
    return HttpResponse.json(
      envelope({ items, total: items.length, page: 1, page_size: 100 }),
    );
  }),

  http.get('/v1/admin/case-scenarios', ({ request }) => {
    const tenant = readTenantFromReq(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const cat = url.searchParams.get('case_category');
    const prio = url.searchParams.get('priority');
    const trigger = url.searchParams.get('trigger_indicator_id');
    const includeDeleted = url.searchParams.get('include_deleted') === 'true';
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('page_size') ?? 100)));
    let rows = mswCaseScenarios.filter((r) => r.tenant_id === tenant);
    if (!includeDeleted) rows = rows.filter((r) => r.deleted_at === null);
    if (cat) rows = rows.filter((r) => r.case_category === cat);
    if (prio) rows = rows.filter((r) => r.priority === prio);
    if (trigger) rows = rows.filter((r) => r.trigger_indicator_id === trigger);
    if (status) {
      const set = new Set(status.split(',').map((s) => s.trim()));
      rows = rows.filter((r) => set.has(r.status));
    }
    rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const start = (page - 1) * pageSize;
    return HttpResponse.json(
      envelope({
        items: rows.slice(start, start + pageSize),
        total: rows.length,
        page,
        page_size: pageSize,
      }),
    );
  }),

  http.get('/v1/admin/case-scenarios/:id', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const r = mswCaseScenarios.find(
      (x) => x.scenario_id === params.id && x.tenant_id === tenant,
    );
    if (!r) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', `scenario ${params.id} not found`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/admin/case-scenarios', async ({ request }) => {
    const tenant = readTenantFromReq(request);
    const body = (await request.json()) as MswCaseScenarioCreateInput;
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'name required', 'MEDIUM'), { status: 400 });
    }
    const fkErr = _validateScenarioFKs(tenant, body.default_escalation_id, body.notification_template_id ?? null);
    if (fkErr) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_fk', fkErr, 'MEDIUM'), { status: 400 });
    }
    if (
      (body.trigger_indicator_id != null) !==
      (body.trigger_threshold != null)
    ) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'trigger_indicator_id and trigger_threshold must be set together', 'MEDIUM'),
        { status: 400 },
      );
    }
    const dup = mswCaseScenarios.find(
      (r) =>
        r.tenant_id === tenant &&
        r.deleted_at === null &&
        r.name.toLowerCase() === body.name.trim().toLowerCase(),
    );
    if (dup) {
      return HttpResponse.json(
        envelopeError('EWS_409_duplicate_scenario_name', `scenario "${body.name}" already used`, 'MEDIUM'),
        { status: 409 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const row: MswCaseScenario = {
      scenario_id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenant_id: tenant,
      name: body.name.trim(),
      case_category: body.case_category,
      priority: body.priority,
      trigger_indicator_id: body.trigger_indicator_id ?? null,
      trigger_threshold: body.trigger_threshold ?? null,
      default_escalation_id: body.default_escalation_id,
      notification_template_id: body.notification_template_id ?? null,
      checklist: body.checklist ?? [],
      status: 'DRAFT',
      created_by: actor,
      updated_by: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    mswCaseScenarios.push(row);
    _appendScenarioHistory(tenant, row.scenario_id, 'create', null, row, actor, now);
    return HttpResponse.json(envelope(row, 'EWS_201_created', 'Created'), { status: 201 });
  }),

  http.patch('/v1/admin/case-scenarios/:id', async ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswCaseScenarios.findIndex(
      (x) => x.scenario_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_not_found', `scenario ${params.id} not found`, 'LOW'), { status: 404 });
    }
    const old = mswCaseScenarios[idx];
    if (old.deleted_at !== null) {
      return HttpResponse.json(envelopeError('EWS_409_invalid_state', 'cannot update an archived scenario', 'MEDIUM'), { status: 409 });
    }
    const patch = (await request.json()) as Partial<MswCaseScenarioCreateInput>;
    const mergedTriggerId = patch.trigger_indicator_id !== undefined ? patch.trigger_indicator_id : old.trigger_indicator_id;
    const mergedTriggerTh = patch.trigger_threshold !== undefined ? patch.trigger_threshold : old.trigger_threshold;
    if ((mergedTriggerId != null) !== (mergedTriggerTh != null)) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'trigger_indicator_id and trigger_threshold must be set together', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (patch.default_escalation_id || patch.notification_template_id !== undefined) {
      const fkErr = _validateScenarioFKs(
        tenant,
        patch.default_escalation_id ?? old.default_escalation_id,
        patch.notification_template_id !== undefined ? patch.notification_template_id : old.notification_template_id,
      );
      if (fkErr) {
        return HttpResponse.json(envelopeError('EWS_400_invalid_fk', fkErr, 'MEDIUM'), { status: 400 });
      }
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswCaseScenario = {
      ...old,
      name: patch.name ?? old.name,
      case_category: patch.case_category ?? old.case_category,
      priority: patch.priority ?? old.priority,
      trigger_indicator_id: mergedTriggerId,
      trigger_threshold: mergedTriggerTh,
      default_escalation_id: patch.default_escalation_id ?? old.default_escalation_id,
      notification_template_id:
        patch.notification_template_id !== undefined
          ? patch.notification_template_id
          : old.notification_template_id,
      checklist: patch.checklist ?? old.checklist,
      updated_by: actor,
      updated_at: now,
    };
    mswCaseScenarios[idx] = updated;
    _appendScenarioHistory(tenant, updated.scenario_id, 'update', old, updated, actor, now);
    return HttpResponse.json(envelope(updated));
  }),

  http.post('/v1/admin/case-scenarios/:id/activate', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswCaseScenarios.findIndex(
      (x) => x.scenario_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_not_found', `scenario ${params.id} not found`, 'LOW'), { status: 404 });
    }
    const old = mswCaseScenarios[idx];
    if (old.deleted_at !== null || old.status === 'ARCHIVED') {
      return HttpResponse.json(envelopeError('EWS_409_invalid_state', 'cannot activate an archived scenario', 'MEDIUM'), { status: 409 });
    }
    if (old.status === 'ACTIVE') return HttpResponse.json(envelope(old));
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswCaseScenario = { ...old, status: 'ACTIVE', updated_by: actor, updated_at: now };
    mswCaseScenarios[idx] = updated;
    _appendScenarioHistory(tenant, updated.scenario_id, 'activate', old, updated, actor, now);
    return HttpResponse.json(envelope(updated));
  }),

  http.post('/v1/admin/case-scenarios/:id/restore', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswCaseScenarios.findIndex(
      (x) => x.scenario_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_not_found', `scenario ${params.id} not found`, 'LOW'), { status: 404 });
    }
    const old = mswCaseScenarios[idx];
    if (old.deleted_at === null) {
      return HttpResponse.json(envelopeError('EWS_409_invalid_state', 'scenario is not archived', 'MEDIUM'), { status: 409 });
    }
    const dup = mswCaseScenarios.find(
      (r) =>
        r.tenant_id === tenant &&
        r.scenario_id !== old.scenario_id &&
        r.deleted_at === null &&
        r.name.toLowerCase() === old.name.toLowerCase(),
    );
    if (dup) {
      return HttpResponse.json(
        envelopeError(
          'EWS_409_duplicate_scenario_name',
          `name "${old.name}" was reused while archived; rename before restore`,
          'MEDIUM',
        ),
        { status: 409 },
      );
    }
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswCaseScenario = {
      ...old,
      status: 'DRAFT',
      deleted_at: null,
      updated_by: actor,
      updated_at: now,
    };
    mswCaseScenarios[idx] = updated;
    _appendScenarioHistory(tenant, updated.scenario_id, 'restore', old, updated, actor, now);
    return HttpResponse.json(envelope(updated));
  }),

  http.delete('/v1/admin/case-scenarios/:id', ({ params, request }) => {
    const tenant = readTenantFromReq(request);
    const idx = mswCaseScenarios.findIndex(
      (x) => x.scenario_id === params.id && x.tenant_id === tenant,
    );
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_not_found', `scenario ${params.id} not found`, 'LOW'), { status: 404 });
    }
    const old = mswCaseScenarios[idx];
    if (old.deleted_at !== null) return HttpResponse.json(envelope(old));
    const actor = readPersistedUsername() ?? 'alice.admin';
    const now = new Date().toISOString();
    const updated: MswCaseScenario = {
      ...old,
      status: 'ARCHIVED',
      deleted_at: now,
      updated_by: actor,
      updated_at: now,
    };
    mswCaseScenarios[idx] = updated;
    _appendScenarioHistory(tenant, updated.scenario_id, 'archive', old, updated, actor, now);
    return HttpResponse.json(envelope(updated));
  }),

  // ── Dashboard SLA Breach Matrix preview (BAC §3.1.9.1.4) ────────────
  // Offline simulation: take the same fixture the GET handler returns
  // as "current", then derive a "patched" version where the patched
  // bucket gains/loses breaches in proportion to how much the target
  // tightens / loosens. Just needs to be plausible — real math is on
  // the server when MSW is off.
  http.post('/v1/dashboard/sla-breach-matrix/preview', async ({ request }) => {
    const body = (await request.json()) as { patches?: Array<{ case_category?: string; priority?: string; sla_target_days?: number }> };
    if (!Array.isArray(body.patches) || body.patches.length === 0) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'patches required', 'MEDIUM'),
        { status: 400 },
      );
    }
    const now = new Date().toISOString();
    const baseBuckets = [
      { label: '0-7 days',   min_days: 0,  max_days: 7,    total_open: 18, breached: 2,  breach_pct: 11.1, severity_split: { high: 1, medium: 1, low: 0 } },
      { label: '8-30 days',  min_days: 8,  max_days: 30,   total_open: 12, breached: 6,  breach_pct: 50,   severity_split: { high: 3, medium: 2, low: 1 } },
      { label: '31-90 days', min_days: 31, max_days: 90,   total_open: 7,  breached: 6,  breach_pct: 85.7, severity_split: { high: 4, medium: 1, low: 1 } },
      { label: '90+ days',   min_days: 91, max_days: null, total_open: 3,  breached: 3,  breach_pct: 100,  severity_split: { high: 2, medium: 1, low: 0 } },
    ];
    // Heuristic: tighter target → more breaches in the 0-7 bucket;
    // looser → fewer breaches in 8-30. Pick the dominant patch.
    const p = body.patches[0];
    const target = Number(p?.sla_target_days);
    const isTighter = Number.isFinite(target) && target < 1;
    const patchedBuckets = baseBuckets.map((b) => ({ ...b, severity_split: { ...b.severity_split } }));
    if (isTighter) {
      patchedBuckets[0].breached += 3;
      patchedBuckets[0].breach_pct = Math.round((patchedBuckets[0].breached / patchedBuckets[0].total_open) * 1000) / 10;
    } else {
      patchedBuckets[1].breached = Math.max(0, patchedBuckets[1].breached - 2);
      patchedBuckets[1].breach_pct = Math.round((patchedBuckets[1].breached / patchedBuckets[1].total_open) * 1000) / 10;
    }
    const filters = { tenant_id: 'BANK_DEMO' };
    const current = { buckets: baseBuckets, generatedAt: now, filters, uncategorised_count: 4, unresolved_count: 0 };
    const patched = { buckets: patchedBuckets, generatedAt: now, filters, uncategorised_count: 4, unresolved_count: 0 };
    const currentTotal = baseBuckets.reduce((s, b) => s + b.breached, 0);
    const patchedTotal = patchedBuckets.reduce((s, b) => s + b.breached, 0);
    return HttpResponse.json(
      envelope({
        current,
        patched,
        delta: {
          breached_total: patchedTotal - currentTotal,
          by_bucket: baseBuckets.map((cb, i) => ({
            label: cb.label,
            current_breached: cb.breached,
            patched_breached: patchedBuckets[i].breached,
            delta: patchedBuckets[i].breached - cb.breached,
          })),
        },
        patches: body.patches,
      }),
    );
  }),

  // ── Dashboard SLA Breach Matrix (BAC §3.1.6 / §3.1.9.1.4) ───────────
  // Static-ish offline shape that surfaces enough signal to demo all
  // four buckets + breach %, severity split, fallback counts.
  http.get('/v1/dashboard/sla-breach-matrix', ({ request }) => {
    const url = new URL(request.url);
    const businessUnit = url.searchParams.get('business_unit');
    const asOf = url.searchParams.get('as_of') ?? new Date().toISOString();
    // Deterministic fixture; small enough to be auditable but covers
    // every visual state (zero, partial breach, fully breached).
    const buckets = [
      { label: '0-7 days',   min_days: 0,  max_days: 7,    total_open: 18, breached: 2,  breach_pct: 11.1, severity_split: { high: 1, medium: 1, low: 0 } },
      { label: '8-30 days',  min_days: 8,  max_days: 30,   total_open: 12, breached: 6,  breach_pct: 50,   severity_split: { high: 3, medium: 2, low: 1 } },
      { label: '31-90 days', min_days: 31, max_days: 90,   total_open: 7,  breached: 6,  breach_pct: 85.7, severity_split: { high: 4, medium: 1, low: 1 } },
      { label: '90+ days',   min_days: 91, max_days: null, total_open: 3,  breached: 3,  breach_pct: 100,  severity_split: { high: 2, medium: 1, low: 0 } },
    ];
    // Optional BU filter — show fewer cases when CORPORATE selected.
    if (businessUnit === 'CORPORATE') {
      for (const b of buckets) {
        b.total_open = Math.floor(b.total_open / 2);
        b.breached = Math.floor(b.breached / 2);
        b.breach_pct = b.total_open === 0 ? 0 : Math.round((b.breached / b.total_open) * 1000) / 10;
        b.severity_split = {
          high: Math.floor(b.severity_split.high / 2),
          medium: Math.floor(b.severity_split.medium / 2),
          low: Math.floor(b.severity_split.low / 2),
        };
      }
    }
    return HttpResponse.json(
      envelope({
        buckets,
        generatedAt: asOf,
        filters: {
          tenant_id: 'BANK_DEMO',
          ...(businessUnit ? { business_unit: businessUnit } : {}),
          ...(url.searchParams.get('branch') ? { branch: url.searchParams.get('branch')! } : {}),
        },
        uncategorised_count: 4,
        unresolved_count: 0,
      }),
    );
  }),

  // ── Cases Report — row-level detail (BAC §3.1.8) ─────────────────────

  http.get('/v1/reports/cases/detail', ({ request }) => {
    const url = new URL(request.url);
    const fmt = (url.searchParams.get('format') ?? 'json') as
      | 'json' | 'csv' | 'xlsx' | 'pdf';

    const filter = {
      ageBucket: url.searchParams.get('ageBucket') ?? null,
      breached: url.searchParams.get('breached') === 'true',
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      branch: url.searchParams.get('branch'),
      status: url.searchParams.get('status')?.split(',').filter(Boolean) ?? null,
      severity: url.searchParams.get('severity')?.split(',').filter(Boolean) ?? null,
      q: url.searchParams.get('q')?.toLowerCase() ?? null,
      sort: url.searchParams.get('sort') ?? 'created_at',
      dir: (url.searchParams.get('dir') ?? 'desc') as 'asc' | 'desc',
      page: Math.max(1, Number(url.searchParams.get('page') ?? 1)),
      page_size: Math.min(500, Math.max(1, Number(url.searchParams.get('page_size') ?? 50))),
    };

    let rows = mswCasesDetailRows();
    if (filter.ageBucket && filter.ageBucket !== 'ALL') {
      rows = rows.filter((r) => r.age_bucket === filter.ageBucket);
    }
    if (filter.breached) rows = rows.filter((r) => r.is_breached);
    if (filter.from) rows = rows.filter((r) => r.created_at >= filter.from!);
    if (filter.to) rows = rows.filter((r) => r.created_at <= filter.to!);
    if (filter.branch) rows = rows.filter((r) => r.branch === filter.branch);
    if (filter.status) rows = rows.filter((r) => filter.status!.includes(r.status));
    if (filter.severity) rows = rows.filter((r) => filter.severity!.includes(r.severity));
    if (filter.q) {
      const q = filter.q;
      rows = rows.filter((r) =>
        `${r.case_number} ${r.borrower.name ?? ''}`.toLowerCase().includes(q),
      );
    }

    const dirMul = filter.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = mswSortKey(a, filter.sort);
      const bv = mswSortKey(b, filter.sort);
      if (av < bv) return -1 * dirMul;
      if (av > bv) return 1 * dirMul;
      return 0;
    });

    const total = rows.length;

    if (fmt === 'csv') {
      const header = [
        'Case ID','Case Number','Borrower ID','Borrower','Product','Created Date',
        'Age (days)','Age Bucket','SLA Target','Breached','Severity','Priority',
        'Status','Assigned To','Assignee Name','Branch','Alert ID',
      ].join(',');
      const lines = rows.map((r) =>
        [
          r.case_id, r.case_number, r.borrower.id ?? '', r.borrower.name ?? '',
          r.product ?? '', r.created_at, r.age_days, r.age_bucket,
          r.sla_target_days ?? '', r.is_breached, r.severity, r.priority,
          r.status, r.assigned_to ?? '', r.assignee_display_name ?? '',
          r.branch ?? '', r.alert_id ?? '',
        ].map(mswCsvEscape).join(','),
      );
      const body = [header, ...lines].join('\r\n') + '\r\n';
      return new HttpResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="cases-report-mock.csv"`,
          'X-Row-Count': String(rows.length),
        },
      });
    }
    if (fmt === 'xlsx' || fmt === 'pdf') {
      // Return a small placeholder Blob with the right MIME — enough for the
      // SPA download flow to fire. The real export shapes are covered by
      // the BFF Jest suite.
      const ct =
        fmt === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf';
      const head = fmt === 'xlsx' ? 'PK' : '%PDF-1.3';
      return new HttpResponse(`${head} mock(${rows.length} rows)`, {
        status: 200,
        headers: {
          'Content-Type': ct,
          'Content-Disposition': `attachment; filename="cases-report-mock.${fmt}"`,
          'X-Row-Count': String(rows.length),
        },
      });
    }

    const start = (filter.page - 1) * filter.page_size;
    const slice = rows.slice(start, start + filter.page_size);
    return HttpResponse.json(
      envelope({
        items: slice,
        total,
        page: filter.page,
        page_size: filter.page_size,
        filters_applied: Object.fromEntries(
          Object.entries(filter).filter(([, v]) => v !== null && v !== undefined),
        ),
        generated_at: new Date().toISOString(),
        tenant_id: 'BANK_DEMO',
      }),
    );
  }),

  http.get('/v1/reports/cases/filters', () => {
    const owner = readPersistedUsername() ?? 'taniya';
    const items = Array.from(mswSavedFilters.values()).filter(
      (f) => f.owner_id === owner || f.is_shared,
    );
    return HttpResponse.json(envelope({ items, total: items.length }));
  }),

  http.post('/v1/reports/cases/filters', async ({ request }) => {
    const body = (await request.json()) as {
      name?: string;
      filters?: Record<string, unknown>;
      is_shared?: boolean;
      is_default?: boolean;
    };
    const name = (body.name ?? '').trim();
    if (!name || name.length > 80) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'name must be 1-80 chars', 'MEDIUM'),
        { status: 400 },
      );
    }
    const owner = readPersistedUsername() ?? 'taniya';
    if (body.is_default) {
      // Only one default per (owner, report_type) — clear the others.
      for (const f of mswSavedFilters.values()) {
        if (f.owner_id === owner && f.report_type === 'cases') f.is_default = false;
      }
    }
    const id = `flt-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const row = {
      filter_id: id,
      tenant_id: 'BANK_DEMO',
      owner_id: owner,
      report_type: 'cases' as const,
      name,
      filters: body.filters ?? {},
      is_shared: !!body.is_shared,
      is_default: !!body.is_default,
      created_at: now,
      updated_at: now,
    };
    mswSavedFilters.set(id, row);
    return HttpResponse.json(envelope(row), { status: 201 });
  }),

  http.put('/v1/reports/cases/filters/:id', async ({ params, request }) => {
    const id = String(params.id);
    const row = mswSavedFilters.get(id);
    if (!row) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', 'saved filter not found', 'LOW'),
        { status: 404 },
      );
    }
    const patch = (await request.json()) as Partial<typeof row>;
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n || n.length > 80) {
        return HttpResponse.json(
          envelopeError('EWS_400_invalid_input', 'name must be 1-80 chars', 'MEDIUM'),
          { status: 400 },
        );
      }
      row.name = n;
    }
    if (patch.filters !== undefined) row.filters = patch.filters as typeof row.filters;
    if (patch.is_shared !== undefined) row.is_shared = !!patch.is_shared;
    if (patch.is_default !== undefined) {
      if (patch.is_default) {
        for (const f of mswSavedFilters.values()) {
          if (f.owner_id === row.owner_id && f.report_type === 'cases' && f !== row) {
            f.is_default = false;
          }
        }
      }
      row.is_default = !!patch.is_default;
    }
    row.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(row));
  }),

  http.delete('/v1/reports/cases/filters/:id', ({ params }) => {
    const id = String(params.id);
    if (!mswSavedFilters.has(id)) {
      return HttpResponse.json(
        envelopeError('EWS_404_not_found', 'saved filter not found', 'LOW'),
        { status: 404 },
      );
    }
    mswSavedFilters.delete(id);
    return HttpResponse.json(envelope({ deleted: true }));
  }),

  // ── Analytics — Stage Migration (T4.1 4d) ────────────────────────────

  http.get('/v1/analytics/stage-migration', ({ request }) => {
    const url = new URL(request.url);
    for (const k of ['as_of', 'prior_as_of'] as const) {
      const v = url.searchParams.get(k);
      if (v && Number.isNaN(Date.parse(v))) {
        return HttpResponse.json(
          envelopeError('EWS_400_invalid_input', `${k} must be ISO 8601`, 'MEDIUM'),
          { status: 400 },
        );
      }
    }
    // Vary the prior snapshot by the prior_as_of distance — different
    // compare-to dropdowns produce different transition counts.
    const priorAsOf = url.searchParams.get('prior_as_of');
    const days = priorAsOf
      ? Math.max(0, Math.round((Date.now() - Date.parse(priorAsOf)) / 86_400_000))
      : 30;

    const { current, prior } = mswStageMigrationSeed(days);
    const STAGES: ('stage_1' | 'stage_2' | 'stage_3')[] = ['stage_1', 'stage_2', 'stage_3'];
    const curMap = new Map(current.map((r) => [r.customer_id, r.stage]));
    const priorMap = new Map(prior.map((r) => [r.customer_id, r.stage]));

    const matrix: { from: string; to: string; count: number }[] = [];
    for (const from of STAGES) for (const to of STAGES) matrix.push({ from, to, count: 0 });
    let upgrades = 0, downgrades = 0, stationary = 0, newCust = 0, exited = 0;
    const allIds = new Set<string>([...curMap.keys(), ...priorMap.keys()]);
    for (const id of allIds) {
      const from = priorMap.get(id);
      const to = curMap.get(id);
      if (!from && to) { newCust += 1; continue; }
      if (from && !to) { exited += 1; continue; }
      if (!from || !to) continue;
      const cell = matrix.find((c) => c.from === from && c.to === to)!;
      cell.count += 1;
      const fi = STAGES.indexOf(from);
      const ti = STAGES.indexOf(to);
      if (ti > fi) upgrades += 1;
      else if (ti < fi) downgrades += 1;
      else stationary += 1;
    }
    const totals = STAGES.map((stage) => {
      const cur = current.filter((r) => r.stage === stage).length;
      const pri = prior.filter((r) => r.stage === stage).length;
      return { stage, current: cur, prior: pri, delta: cur - pri };
    });
    return HttpResponse.json(
      envelope({
        matrix,
        totals,
        upgrades_count: upgrades,
        downgrades_count: downgrades,
        stationary_count: stationary,
        new_customers_count: newCust,
        exited_customers_count: exited,
        generated_at: new Date().toISOString(),
        tenant_id: 'BANK_DEMO',
        filters_applied: priorAsOf ? { prior_as_of: priorAsOf } : {},
      }),
    );
  }),

  // ── Analytics — PD Distribution (T4.1 4c) ────────────────────────────

  http.get('/v1/analytics/pd-distribution', ({ request }) => {
    const url = new URL(request.url);
    for (const k of ['as_of', 'prior_as_of'] as const) {
      const v = url.searchParams.get(k);
      if (v && Number.isNaN(Date.parse(v))) {
        return HttpResponse.json(
          envelopeError('EWS_400_invalid_input', `${k} must be ISO 8601`, 'MEDIUM'),
          { status: 400 },
        );
      }
    }
    const priorAsOf = url.searchParams.get('prior_as_of');
    const seed = mswPdDistributionSnapshot();
    const prior = priorAsOf ? mswPdDistributionPriorSnapshot() : null;

    const range = { lower: 0, upper: 10, bins: 10 };
    const binWidth = (range.upper - range.lower) / range.bins;
    const tally = (rows: typeof seed) => {
      const counts = new Array<number>(range.bins).fill(0);
      for (const r of rows) {
        if (!Number.isFinite(r.pd_proxy)) continue;
        let idx: number;
        if (r.pd_proxy < range.lower) idx = 0;
        else if (r.pd_proxy >= range.upper) idx = range.bins - 1;
        else idx = Math.floor((r.pd_proxy - range.lower) / binWidth);
        counts[idx] += 1;
      }
      return counts;
    };

    const curCounts = tally(seed);
    const priorCounts = prior ? tally(prior) : null;
    const bins = curCounts.map((count, i) => {
      const lower = range.lower + i * binWidth;
      const upper = i === range.bins - 1 ? range.upper : range.lower + (i + 1) * binWidth;
      const pc = priorCounts ? priorCounts[i] : null;
      return {
        lower,
        upper,
        label: `${lower.toFixed(1)}–${upper.toFixed(1)}`,
        count,
        prior_count: pc,
        delta: pc == null ? null : count - pc,
      };
    });

    const bands = [
      { band: 'low' as const,    lower: 0, upper: 3,  count: 0 },
      { band: 'medium' as const, lower: 3, upper: 5,  count: 0 },
      { band: 'high' as const,   lower: 5, upper: 10, count: 0 },
    ];
    for (const r of seed) {
      const b =
        r.pd_proxy < 3 ? bands[0] :
        r.pd_proxy < 5 ? bands[1] :
        bands[2];
      b.count += 1;
    }

    const sum = seed.reduce((a, r) => a + r.pd_proxy, 0);
    const high = bands[2].count;

    return HttpResponse.json(
      envelope({
        bins,
        bands,
        totals: {
          customer_count: seed.length,
          prior_customer_count: prior ? prior.length : null,
          mean_pd_proxy: seed.length === 0 ? null : Math.round((sum / seed.length) * 100) / 100,
          high_band_share: seed.length === 0 ? 0 : Math.round((high / seed.length) * 10000) / 10000,
        },
        range: { lower: range.lower, upper: range.upper, bin_count: range.bins },
        generated_at: new Date().toISOString(),
        tenant_id: 'BANK_DEMO',
        filters_applied: priorAsOf ? { prior_as_of: priorAsOf } : {},
      }),
    );
  }),

  // ── Analytics — Risk Trend (T4.1 4b) ─────────────────────────────────

  http.get('/v1/analytics/risk-trend', ({ request }) => {
    const url = new URL(request.url);
    const fromRaw = url.searchParams.get('from');
    if (fromRaw && Number.isNaN(Date.parse(fromRaw))) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'from must be ISO 8601', 'MEDIUM'),
        { status: 400 },
      );
    }
    const fromMs = fromRaw ? Date.parse(fromRaw) : Number.NEGATIVE_INFINITY;
    const seed = mswRiskTrendSeed();
    const filtered = seed.filter((r) => Date.parse(r.created_at) >= fromMs);

    type Bucket = {
      week: string;
      week_start: string;
      total: number;
      by_severity: Record<'critical' | 'high' | 'medium' | 'low', number>;
      _sumCrit: number;
    };
    const isoWeek = (d: Date) => {
      const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dayNum = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - dayNum);
      const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      const wk = Math.ceil(((t.getTime() - ys.getTime()) / 86_400_000 + 1) / 7);
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const adj = monday.getUTCDay() || 7;
      monday.setUTCDate(monday.getUTCDate() - (adj - 1));
      monday.setUTCHours(0, 0, 0, 0);
      return { label: `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`, monday };
    };
    const map = new Map<string, Bucket>();
    let sumCritAll = 0, hiCritAll = 0;
    for (const r of filtered) {
      const { label, monday } = isoWeek(new Date(r.created_at));
      const b = map.get(label) ?? {
        week: label,
        week_start: monday.toISOString(),
        total: 0,
        by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
        _sumCrit: 0,
      };
      b.total += 1;
      b.by_severity[r.severity] += 1;
      b._sumCrit += r.criticality_score;
      map.set(label, b);
      sumCritAll += r.criticality_score;
      if (r.severity === 'critical' || r.severity === 'high') hiCritAll += 1;
    }
    const buckets = [...map.values()]
      .sort((a, b) => a.week.localeCompare(b.week))
      .map((b) => ({
        week: b.week,
        week_start: b.week_start,
        total: b.total,
        by_severity: b.by_severity,
        avg_criticality: b.total === 0 ? null : Math.round((b._sumCrit / b.total) * 100) / 100,
        high_critical_share:
          b.total === 0
            ? 0
            : Math.round(((b.by_severity.critical + b.by_severity.high) / b.total) * 10000) / 10000,
      }));

    return HttpResponse.json(
      envelope({
        buckets,
        totals: {
          alert_count: filtered.length,
          avg_criticality:
            filtered.length === 0 ? null : Math.round((sumCritAll / filtered.length) * 100) / 100,
          high_critical_share:
            filtered.length === 0 ? 0 : Math.round((hiCritAll / filtered.length) * 10000) / 10000,
        },
        generated_at: new Date().toISOString(),
        tenant_id: 'BANK_DEMO',
        filters_applied: fromRaw ? { from: fromRaw } : {},
      }),
    );
  }),

  // ── Analytics — Alert Resolution (T4.1, EWS.docx §5.5 / §8) ─────────

  http.get('/v1/analytics/alert-resolution', ({ request }) => {
    const url = new URL(request.url);
    const sevRaw = url.searchParams.get('severity');
    const VALID_SEV = ['critical', 'high', 'medium', 'low', 'all'];
    if (sevRaw && !VALID_SEV.includes(sevRaw)) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', `severity must be one of ${VALID_SEV.join(',')}`, 'MEDIUM'),
        { status: 400 },
      );
    }
    const severity = sevRaw && sevRaw !== 'all' ? sevRaw : null;

    // Demo seed: 200 alerts spread over the past 4 weeks. Reasonable
    // ack/close rates so the funnel + percentile chart show variation.
    const seed = mswAnalyticsSeed();
    const rows = severity ? seed.filter((r) => r.severity === severity) : seed;

    const created = rows.length;
    const acked = rows.filter((r) => r.acked_at).length;
    const investigated = rows.filter((r) => {
      if (!r.acked_at) return false;
      if (!r.closed_at) return true;
      return Date.parse(r.closed_at) - Date.parse(r.acked_at) >= 5 * 60_000;
    }).length;
    const closed = rows.filter((r) => r.closed_at).length;
    const ratio = (n: number) =>
      created === 0 ? 0 : Math.round((n / created) * 10000) / 10000;

    const ackDur = rows
      .filter((r) => r.acked_at)
      .map((r) => (Date.parse(r.acked_at!) - Date.parse(r.created_at)) / 1000);
    const closeDur = rows
      .filter((r) => r.closed_at)
      .map((r) => (Date.parse(r.closed_at!) - Date.parse(r.created_at)) / 1000);

    const trend = mswWeeklyTrend(rows);

    return HttpResponse.json(
      envelope({
        funnel: [
          { stage: 'created',      count: created,      ratio: ratio(created) },
          { stage: 'acked',        count: acked,        ratio: ratio(acked) },
          { stage: 'investigated', count: investigated, ratio: ratio(investigated) },
          { stage: 'closed',       count: closed,       ratio: ratio(closed) },
        ],
        ack_duration: mswPercentile(ackDur),
        close_duration: mswPercentile(closeDur),
        trend,
        generated_at: new Date().toISOString(),
        tenant_id: 'BANK_DEMO',
        filters_applied: severity ? { severity } : {},
      }),
    );
  }),

  // ── EWS Rules versioning + revert (RP-1 + diff-page) ─────────────────
  http.get('/v1/ews/rules/:rule_id/versions', ({ params }) => {
    const items = mswEwsRuleVersions(String(params.rule_id));
    return HttpResponse.json(
      envelope({
        items,
        total: items.length,
        rule_id: params.rule_id,
        latest_semver: items[0]?.semver ?? null,
      }),
    );
  }),

  http.get('/v1/ews/rules/:rule_id/versions/:semver', ({ params }) => {
    const v = mswEwsRuleVersions(String(params.rule_id)).find(
      (x) => x.semver === String(params.semver),
    );
    if (!v) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_version', `version not found`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(v));
  }),

  http.post('/v1/ews/rules/:rule_id/versions/diff', async ({ request, params }) => {
    const body = (await request.json()) as { from?: string; to?: string; format?: string };
    if (!body.from || !body.to) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'from + to required', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (body.format && body.format !== 'fields' && body.format !== 'snapshots') {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'format must be fields|snapshots', 'MEDIUM'),
        { status: 400 },
      );
    }
    const versions = mswEwsRuleVersions(String(params.rule_id));
    const A = versions.find((v) => v.semver === body.from);
    const B = versions.find((v) => v.semver === body.to);
    if (!A || !B) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_version', `version not found`, 'LOW'),
        { status: 404 },
      );
    }
    const diff = mswDiffSnapshots(A.snapshot, B.snapshot);
    const out: Record<string, unknown> = {
      rule_id: params.rule_id,
      from: body.from,
      to: body.to,
      diff,
      change_count: diff.length,
    };
    if (body.format === 'snapshots') {
      out.from_snapshot = A;
      out.to_snapshot = B;
    }
    return HttpResponse.json(envelope(out));
  }),

  http.post(
    '/v1/ews/rules/:rule_id/versions/:semver/revert',
    async ({ request, params }) => {
      const body = (await request.json().catch(() => ({}))) as { reason?: string };
      const versions = mswEwsRuleVersions(String(params.rule_id));
      const target = versions.find((v) => v.semver === String(params.semver));
      if (!target) {
        return HttpResponse.json(
          envelopeError('EWS_404_unknown_version', `version not found`, 'LOW'),
          { status: 404 },
        );
      }
      const latest = versions[0]?.semver ?? '0.1.0';
      const [maj, min, pat] = latest.split('.').map(Number);
      const newSemver = `${maj}.${min}.${pat + 1}`;
      const snap = {
        version_id: `mock-rev-${Date.now()}`,
        rule_id: String(params.rule_id),
        tenant_id: 'BANK_DEMO',
        semver: newSemver,
        snapshot: target.snapshot,
        created_by: 'msw-actor',
        created_at: new Date().toISOString(),
        reason: body.reason ?? `Reverted to v${target.semver} by msw-actor`,
      };
      __mswEwsRuleRevertedVersions.set(snap.version_id, snap);
      return HttpResponse.json(envelope(snap), { status: 201 });
    },
  ),

  // G2 — M15.1 audit trail MSW handlers (Monday Playbook H9)
  http.get('/v1/audit/events', ({ request }) => {
    const url = new URL(request.url);
    const filters = {
      actor_username: url.searchParams.get('actor_username') || undefined,
      action: url.searchParams.get('action') || undefined,
      resource_type: url.searchParams.get('resource_type') || undefined,
      resource_id: url.searchParams.get('resource_id') || undefined,
      correlation_id: url.searchParams.get('correlation_id') || undefined,
      outcome: url.searchParams.get('outcome') || undefined,
      severity: url.searchParams.get('severity') || undefined,
    };
    const page = Number(url.searchParams.get('page') ?? '1');
    const page_size = Number(url.searchParams.get('page_size') ?? '25');
    const all = __mswAuditEvents();
    const filtered = all.filter((e) => {
      if (filters.actor_username && !e.actor_username.toLowerCase().includes(filters.actor_username.toLowerCase())) return false;
      if (filters.action && !e.action.toLowerCase().includes(filters.action.toLowerCase())) return false;
      if (filters.resource_type && e.resource_type !== filters.resource_type) return false;
      if (filters.resource_id && e.resource_id !== filters.resource_id) return false;
      if (filters.correlation_id && e.correlation_id !== filters.correlation_id) return false;
      if (filters.outcome && e.outcome !== filters.outcome) return false;
      if (filters.severity && e.severity !== filters.severity) return false;
      return true;
    });
    const start = (page - 1) * page_size;
    const items = filtered.slice(start, start + page_size);
    return HttpResponse.json(envelope({ items, page, page_size, total: filtered.length }));
  }),

  http.get('/v1/audit/events/:event_id', ({ params }) => {
    const all = __mswAuditEvents();
    const ev = all.find((e) => e.event_id === params.event_id);
    if (!ev) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_404', message: 'unknown_event', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_event', message: 'event not found', severity: 'LOW' } },
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(ev));
  }),

  http.get('/v1/audit/summary', () => {
    const all = __mswAuditEvents();
    const by_outcome = { success: 0, failure: 0, denied: 0 } as Record<string, number>;
    const by_severity = { info: 0, warning: 0, critical: 0 } as Record<string, number>;
    const actionCount = new Map<string, number>();
    const rtCount = new Map<string, number>();
    for (const e of all) {
      by_outcome[e.outcome] = (by_outcome[e.outcome] ?? 0) + 1;
      by_severity[e.severity] = (by_severity[e.severity] ?? 0) + 1;
      actionCount.set(e.action, (actionCount.get(e.action) ?? 0) + 1);
      rtCount.set(e.resource_type, (rtCount.get(e.resource_type) ?? 0) + 1);
    }
    return HttpResponse.json(
      envelope({
        since: new Date(Date.now() - 30 * 86400000).toISOString(),
        until: new Date().toISOString(),
        total: all.length,
        by_outcome,
        by_severity,
        by_action: [...actionCount.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
        by_resource_type: [...rtCount.entries()].map(([resource_type, count]) => ({ resource_type, count })).sort((a, b) => b.count - a.count),
      }),
    );
  }),

  // G3 — Dashboard widgets MSW handlers (Playbook H2)
  // M2.7 SW-4 — sector cells with in-memory watchlist round-trip for add/remove
  ...(() => {
    const KNOWN = ['Power', 'Real_Estate', 'Manufacturing', 'Retail_Trade', 'IT_Services'] as const;
    const watchlist = new Set<string>(['Real_Estate']);
    const baseCells = (): Array<{
      sector: string;
      npa_ratio_pct: number;
      total_customers: number;
      total_outstanding_kes: number;
      delta_30d_pct: number;
      heat_level: 'critical' | 'high' | 'medium' | 'low';
    }> => [
      { sector: 'Power', npa_ratio_pct: 10.49, total_customers: 59, total_outstanding_kes: 3_727_254_105, delta_30d_pct: -1.4, heat_level: 'critical' },
      { sector: 'Real_Estate', npa_ratio_pct: 8.21, total_customers: 84, total_outstanding_kes: 5_113_220_000, delta_30d_pct: 1.8, heat_level: 'critical' },
      { sector: 'Manufacturing', npa_ratio_pct: 5.6, total_customers: 142, total_outstanding_kes: 8_900_000_000, delta_30d_pct: 0.3, heat_level: 'high' },
      { sector: 'Retail_Trade', npa_ratio_pct: 3.8, total_customers: 220, total_outstanding_kes: 1_450_000_000, delta_30d_pct: -0.4, heat_level: 'medium' },
      { sector: 'IT_Services', npa_ratio_pct: 1.2, total_customers: 91, total_outstanding_kes: 2_300_000_000, delta_30d_pct: -0.6, heat_level: 'low' },
    ];
    const annotate = () =>
      baseCells().map((c) => ({ ...c, is_watchlisted: watchlist.has(c.sector) }));
    const fail = (code: string, status: number, msg: string) =>
      HttpResponse.json(
        {
          header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() },
          error: { code, message: msg, severity: 'MEDIUM' },
        },
        { status },
      );
    return [
      http.get('/v1/banking/sectors/heatmap', () =>
        HttpResponse.json(
          envelope({
            tenant_id: 'BANK_DEMO',
            generated_at: new Date().toISOString(),
            total_sectors: 5,
            by_heat_level: { critical: 2, high: 1, medium: 1, low: 1 },
            cells: annotate(),
          }),
        ),
      ),
      http.get('/v1/banking/sectors/watchlist', () =>
        HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', watchlist: Array.from(watchlist).sort() })),
      ),
      http.post('/v1/banking/sectors/watchlist', async ({ request }) => {
        const body = (await request.json().catch(() => null)) as { sector?: string } | null;
        const sector = body?.sector ?? '';
        if (!KNOWN.includes(sector as (typeof KNOWN)[number]))
          return fail('EWS_404_unknown_sector', 404, `unknown sector ${sector}`);
        watchlist.add(sector);
        return HttpResponse.json(
          envelope({ tenant_id: 'BANK_DEMO', watchlist: Array.from(watchlist).sort() }),
          { status: 201 },
        );
      }),
      http.delete('/v1/banking/sectors/watchlist/:sector_id', ({ params }) => {
        watchlist.delete(String(params.sector_id));
        return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', watchlist: Array.from(watchlist).sort() }));
      }),
      // M2.7 — bare /:sector_id summary
      http.get('/v1/banking/sectors/:sector_id/deep-dive', ({ params }) => {
        const sid = String(params.sector_id);
        if (!KNOWN.includes(sid as (typeof KNOWN)[number]))
          return fail('EWS_404_unknown_sector', 404, `unknown sector ${sid}`);
        const cell = baseCells().find((c) => c.sector === sid)!;
        const months = Array.from({ length: 12 }, (_, i) => {
          const d = new Date();
          d.setUTCMonth(d.getUTCMonth() - (11 - i));
          const base = Math.max(0.5, cell.npa_ratio_pct - 3 + i * 0.18 + (i % 3) * 0.4);
          return { month: d.toISOString().slice(0, 7), npa_pct: Math.round(base * 100) / 100 };
        });
        months[months.length - 1].npa_pct = cell.npa_ratio_pct;
        return HttpResponse.json(
          envelope({
            tenant_id: 'BANK_DEMO',
            sector: sid,
            generated_at: new Date().toISOString(),
            npa_ratio_pct: cell.npa_ratio_pct,
            total_customers: cell.total_customers,
            total_outstanding_kes: cell.total_outstanding_kes,
            heat_level: cell.heat_level,
            npa_trend_12m: months,
            top_at_risk_customers: [
              { customer_id: 'c-200001', name: 'Alice Patel', pd: 0.87, outstanding_kes: 42_000_000 },
              { customer_id: 'c-200002', name: 'Rajesh Kumar', pd: 0.76, outstanding_kes: 31_500_000 },
              { customer_id: 'c-200003', name: 'Priya Sharma', pd: 0.61, outstanding_kes: 18_900_000 },
              { customer_id: 'c-200004', name: 'Mohan Singh', pd: 0.55, outstanding_kes: 14_200_000 },
              { customer_id: 'c-200005', name: 'Meera Nair', pd: 0.49, outstanding_kes: 11_750_000 },
            ],
            contributing_rules: [
              { rule_id: 'R-100', rule_name: 'DPD-cliff-30d', firings_30d: 38 },
              { rule_id: 'R-101', rule_name: 'EMI-bounce-3-in-30', firings_30d: 27 },
              { rule_id: 'R-102', rule_name: 'Cash-velocity-spike', firings_30d: 19 },
              { rule_id: 'R-103', rule_name: 'Stock-statement-overdue', firings_30d: 14 },
              { rule_id: 'R-104', rule_name: 'Sector-overexposure', firings_30d: 9 },
            ],
          }),
        );
      }),
      http.get('/v1/banking/sectors/:sector_id', ({ params }) => {
        const sid = String(params.sector_id);
        if (!KNOWN.includes(sid as (typeof KNOWN)[number]))
          return fail('EWS_404_unknown_sector', 404, `unknown sector ${sid}`);
        const cell = annotate().find((c) => c.sector === sid)!;
        return HttpResponse.json(envelope({ ...cell, generated_at: new Date().toISOString() }));
      }),
    ];
  })(),

  // Module 1.2 — Data Profiling MSW handlers
  http.get('/v1/dq/profile/:source_id/columns', ({ params }) => {
    const sid = String(params.source_id);
    return HttpResponse.json(envelope(__mswDqProfile(sid)));
  }),

  http.get('/v1/dq/profile/:source_id/column/:col', ({ params }) => {
    const sid = String(params.source_id);
    const col = String(params.col);
    const profile = __mswDqProfile(sid);
    const found = profile.columns.find((c: { column: string }) => c.column === col);
    if (!found) {
      return HttpResponse.json(
        {
          header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() },
          error: { code: 'EWS_404_unknown_column', message: `unknown column ${col}`, severity: 'LOW' },
        },
        { status: 404 },
      );
    }
    return HttpResponse.json(
      envelope({ tenant_id: 'BANK_DEMO', source_id: sid, generated_at: new Date().toISOString(), column: found }),
    );
  }),

  http.get('/v1/dq/profile/:source_id/columns/:column/distribution', ({ params }) => {
    const sid = String(params.source_id);
    const col = String(params.column);
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      bucket: `${i * 10}-${(i + 1) * 10}`,
      count: 1200 - i * 80 + Math.floor(Math.random() * 50),
      pct: Math.round(((10 - i) / 55) * 1000) / 1000,
    }));
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', source_id: sid, column: col, generated_at: new Date().toISOString(), total_rows: 12_000, buckets, has_drift: false }));
  }),

  http.post('/v1/dq/profile/:source_id/suggest-rules', ({ params }) => {
    const sid = String(params.source_id);
    const rules = [
      { rule_id: `dq-msw-${sid}-loan_id-nn`, source_id: sid, column: 'loan_id', rule_type: 'not_null', rule_def: { allow_null: false }, rationale: 'Observed null rate <0.1%; enforce NOT NULL.', confidence: 0.92, status: 'suggested' },
      { rule_id: `dq-msw-${sid}-customer_id-regex`, source_id: sid, column: 'customer_id', rule_type: 'regex', rule_def: { pattern: '^c-\\d{6}$', format: 'numeric_id', sample: 'c-100012' }, rationale: '≥80% of values match c-NNNNNN pattern; enforce regex.', confidence: 0.9, status: 'suggested' },
      { rule_id: `dq-msw-${sid}-worst_dpd-range`, source_id: sid, column: 'worst_dpd', rule_type: 'range', rule_def: { min: 0, max: 720 }, rationale: 'Observed min=0, max=540; suggest bound [0, 720].', confidence: 0.78, status: 'suggested' },
    ];
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', source_id: sid, count: rules.length, rules }));
  }),

  http.post('/v1/dq/profile/promote-rule', async ({ request }) => {
    const body = (await request.json().catch(() => null)) as { rule_id?: string } | null;
    if (!body?.rule_id) {
      return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'rule_id required in body', severity: 'MEDIUM' } }, { status: 400 });
    }
    return HttpResponse.json(envelope({ rule_id: body.rule_id, source_id: 'cbs_loans', column: 'loan_id', rule_type: 'not_null', rule_def: { allow_null: false }, rationale: 'promoted', confidence: 0.92, status: 'promoted' }));
  }),

  // Module 1.1 — Data Ingestion MSW handlers
  http.get('/v1/ingestion/connectors', () => HttpResponse.json(envelope({ items: __mswConnectors(), total: __mswConnectors().length }))),

  http.post('/v1/ingestion/connectors', async ({ request }) => {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'body required', severity: 'MEDIUM' } }, { status: 400 });
    }
    const ID_RE = /^[a-z][a-z0-9_]{2,63}$/;
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) {
      return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_id', message: 'id must match ^[a-z][a-z0-9_]{2,63}$', severity: 'MEDIUM' } }, { status: 400 });
    }
    const list = __mswConnectors();
    if (list.find((c) => c.id === body.id)) {
      return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_409_id_in_use', message: `connector id already in use: ${body.id}`, severity: 'MEDIUM' } }, { status: 409 });
    }
    const created = {
      id: String(body.id),
      name: String(body.name ?? ''),
      source_system: String(body.source_system ?? ''),
      type: (body.type as string) || 'rest_api',
      schedule: String(body.schedule ?? ''),
      description: String(body.description ?? ''),
      default_status: 'healthy',
      status: 'healthy',
      last_run_at: null,
      last_run_status: null,
      last_run_records: 1100,
      average_lag_seconds: 12,
      paused_at: null,
      owner_user_id: (body.owner_user_id as string | null) ?? null,
      is_custom: true,
    };
    __mswCustomConnectors.push(created as never);
    return HttpResponse.json(envelope(created), { status: 201 });
  }),

  http.patch('/v1/ingestion/connectors/:id', async ({ params, request }) => {
    const all = __mswConnectors();
    const target = all.find((c) => c.id === params.id);
    if (!target) {
      return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_connector', message: `unknown connector: ${params.id}`, severity: 'LOW' } }, { status: 404 });
    }
    const patch = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (patch) {
      Object.assign(target as Record<string, unknown>, patch);
    }
    return HttpResponse.json(envelope(target));
  }),

  http.get('/v1/ingestion/connectors/schema-drift', () => {
    const rows = __mswConnectors().map((c) => ({
      connector_id: c.id,
      name: c.name,
      source_system: c.source_system,
      type: c.type,
      status: c.status,
      schema_version: '1.0.0',
      platform_fields_count: 10,
      tenant_added_fields: c.id === 'cbs_loan_book' ? ['custom_field_a', 'custom_field_b'] : [],
      overrides_count: c.id === 'cbs_loan_book' ? 2 : 0,
      has_drift: c.id === 'cbs_loan_book',
    }));
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        total_connectors: rows.length,
        drifted_count: rows.filter((r) => r.has_drift).length,
        clean_count: rows.filter((r) => !r.has_drift).length,
        rows,
        drifted_rows: rows.filter((r) => r.has_drift),
      }),
    );
  }),

  http.get('/v1/ingestion/connectors/:id/runs', ({ params, request }) => {
    const url = new URL(request.url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
    const cid = String(params.id);
    const runs = Array.from({ length: 5 }, (_, i) => ({
      run_id: `run-${cid}-${i}`,
      connector_id: cid,
      started_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      finished_at: new Date(Date.now() - (i + 1) * 3_600_000 + 60_000).toISOString(),
      status: (i === 1 ? 'failure' : i === 3 ? 'partial' : 'success') as 'success' | 'failure' | 'partial' | 'running',
      records_processed: 12_000 - i * 100,
      records_failed: i === 1 ? 12_000 : i === 3 ? 230 : 0,
      error_message: i === 1 ? 'connection timeout after 30s' : i === 3 ? 'schema mismatch on column "amount"' : null,
      triggered_manually: i === 0,
    })).slice(0, limit);
    return HttpResponse.json(envelope({ items: runs, total: runs.length, connector_id: cid, limit }));
  }),

  http.post('/v1/ingestion/connectors/:id/run', ({ params }) => {
    const cid = String(params.id);
    const run = {
      run_id: `run-${cid}-now`,
      connector_id: cid,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      status: 'success' as const,
      records_processed: 12_500,
      records_failed: 0,
      error_message: null,
      triggered_manually: true,
    };
    return HttpResponse.json(envelope(run), { status: 201 });
  }),

  http.post('/v1/ingestion/connectors/:id/pause', ({ params }) => {
    const all = __mswConnectors();
    const target = all.find((c) => c.id === params.id);
    if (!target) return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_connector', message: 'unknown', severity: 'LOW' } }, { status: 404 });
    (target as Record<string, unknown>).status = 'paused';
    (target as Record<string, unknown>).paused_at = new Date().toISOString();
    return HttpResponse.json(envelope(target));
  }),

  http.post('/v1/ingestion/connectors/:id/resume', ({ params }) => {
    const all = __mswConnectors();
    const target = all.find((c) => c.id === params.id);
    if (!target) return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_connector', message: 'unknown', severity: 'LOW' } }, { status: 404 });
    (target as Record<string, unknown>).status = 'healthy';
    (target as Record<string, unknown>).paused_at = null;
    return HttpResponse.json(envelope(target));
  }),

  http.get('/v1/ingestion/health', () =>
    HttpResponse.json(
      envelope({
        total_connectors: 10,
        by_status: { healthy: 9, degraded: 1, failing: 0, paused: 0 },
        attention_required: [
          { id: 'agent_productivity', name: 'Agent Productivity', source_system: 'AGENT', type: 'batch_csv', schedule: 'daily 03:00', status: 'degraded', last_run_at: null, last_run_status: null, last_run_records: 5880, average_lag_seconds: 32, paused_at: null },
        ],
        fleet_records_last_run: 248_910,
      }),
    ),
  ),

  http.get('/v1/ai/models', ({ request }) => {
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const status = url.searchParams.get('status');
    let pool = __mswAiModels();
    if (status === 'deployed') {
      pool = pool.filter((m) => m.status === 'production' || m.status === 'shadow');
    } else if (status) {
      pool = pool.filter((m) => m.status === status);
    }
    if (type) pool = pool.filter((m) => m.type === type);
    return HttpResponse.json(envelope({ items: pool, total: pool.length }));
  }),
  http.post('/v1/ai/models', async ({ request }) => {
    const raw = (await request.json()) as Record<string, unknown>;
    const body =
      raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
        ? (raw.body as Record<string, unknown>)
        : raw;
    const status = (body.status as string | undefined) ?? 'experimental';
    if (status === 'production') {
      return HttpResponse.json(
        envelopeError('EWS_409_protected_status_change', 'cannot create at production', 'MEDIUM'),
        { status: 409 },
      );
    }
    if (__mswAiModels().some((m) => m.model_id === body.model_id)) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'duplicate', 'MEDIUM'), { status: 400 });
    }
    const created = {
      model_id: String(body.model_id),
      name: String(body.name),
      type: String(body.type),
      version: String(body.version),
      framework: String(body.framework),
      status,
      metrics: (body.metrics as Record<string, unknown> | undefined) ?? { auc: null },
      trained_at: new Date().toISOString(),
      deployed_at: null,
    };
    __mswAiModelsCustom.push(created);
    return HttpResponse.json(envelope(created), { status: 201 });
  }),
  http.put('/v1/ai/models/:model_id', async ({ request, params }) => {
    const id = String(params.model_id);
    const raw = (await request.json()) as Record<string, unknown>;
    const patch =
      raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
        ? (raw.body as Record<string, unknown>)
        : raw;
    if ('status' in patch) {
      return HttpResponse.json(
        envelopeError('EWS_409_protected_status_change', 'status not editable here', 'MEDIUM'),
        { status: 409 },
      );
    }
    const idx = __mswAiModelsCustom.findIndex((m) => m.model_id === id);
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_model', `unknown: ${id}`, 'LOW'), { status: 404 });
    }
    __mswAiModelsCustom[idx] = { ...__mswAiModelsCustom[idx], ...patch };
    return HttpResponse.json(envelope(__mswAiModelsCustom[idx]));
  }),
  http.delete('/v1/ai/models/:model_id', ({ request, params }) => {
    const id = String(params.model_id);
    const url = new URL(request.url);
    const force = url.searchParams.get('force') === 'true';
    const idx = __mswAiModelsCustom.findIndex((m) => m.model_id === id);
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_model', `unknown: ${id}`, 'LOW'), { status: 404 });
    }
    const cur = __mswAiModelsCustom[idx];
    if (cur.status === 'retired') {
      return HttpResponse.json(envelopeError('EWS_409_already_retired', 'already retired', 'LOW'), { status: 409 });
    }
    if (cur.status === 'production' && !force) {
      return HttpResponse.json(
        envelopeError('EWS_409_protected_production_retire', 'force=true required', 'MEDIUM'),
        { status: 409 },
      );
    }
    __mswAiModelsCustom[idx] = { ...cur, status: 'retired', retired_at: new Date().toISOString() };
    return HttpResponse.json(envelope(__mswAiModelsCustom[idx]));
  }),

  // M5.3 — Thresholds & Limits MSW handlers. Drives dev mode without
  // a BFF; the real BFF routes are unchanged. We seed 4 indicator
  // thresholds + the where-needed envelopes for effective + drift.
  http.get('/v1/indicators/thresholds', () =>
    HttpResponse.json(envelope({
      items: __mswThresholds().map((t) => ({ ...t, source: 'platform_default' })),
      total: __mswThresholds().length,
    })),
  ),
  http.get('/v1/indicators/thresholds/effective', () => {
    const eff = __mswThresholds().map((t) => {
      const ov = __mswThresholdOverrides.get(t.indicator_id);
      return {
        indicator_id: t.indicator_id,
        name: t.name,
        vertical: t.vertical,
        source: ov ? 'tenant_override' : 'platform_default',
        effective: ov ?? { yellow_at: t.yellow_at, orange_at: t.orange_at, red_at: t.red_at },
        library_default: { yellow_at: t.yellow_at, orange_at: t.orange_at, red_at: t.red_at },
        override: ov ?? null,
      };
    });
    return HttpResponse.json(envelope({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      entries: eff,
      total: eff.length,
      override_count: eff.filter((e) => e.source === 'tenant_override').length,
      library_count: eff.length,
    }));
  }),
  http.get('/v1/indicators/thresholds/drift', () => {
    const indicators = __mswThresholds()
      .filter((t) => __mswThresholdOverrides.has(t.indicator_id))
      .map((t) => {
        const ov = __mswThresholdOverrides.get(t.indicator_id)!;
        return {
          indicator_id: t.indicator_id,
          name: t.name,
          vertical: t.vertical,
          yellow_at: { default_value: t.yellow_at, effective_value: ov.yellow_at, delta_abs: ov.yellow_at - t.yellow_at, delta_rel: t.yellow_at ? Math.abs((ov.yellow_at - t.yellow_at) / t.yellow_at) : null },
          orange_at: { default_value: t.orange_at, effective_value: ov.orange_at, delta_abs: ov.orange_at - t.orange_at, delta_rel: t.orange_at ? Math.abs((ov.orange_at - t.orange_at) / t.orange_at) : null },
          red_at: { default_value: t.red_at, effective_value: ov.red_at, delta_abs: ov.red_at - t.red_at, delta_rel: t.red_at ? Math.abs((ov.red_at - t.red_at) / t.red_at) : null },
          drift_score: 0.15,
          peak_band_drift: 0.18,
          peak_band: 'red' as const,
        };
      });
    return HttpResponse.json(envelope({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      total_overrides: indicators.length,
      total_with_drift: indicators.length,
      total_zero_drift: 0,
      mean_drift_score: indicators.length > 0 ? 0.15 : null,
      most_drifted_indicator: indicators[0] ? { indicator_id: indicators[0].indicator_id, drift_score: 0.18 } : null,
      indicators,
    }));
  }),
  http.get('/v1/indicators/thresholds/:indicator_id', ({ params }) => {
    const id = String(params.indicator_id);
    const t = __mswThresholds().find((x) => x.indicator_id === id);
    if (!t) return HttpResponse.json(envelopeError('EWS_404_unknown_indicator', `unknown ${id}`, 'LOW'), { status: 404 });
    const ov = __mswThresholdOverrides.get(id);
    return HttpResponse.json(envelope({
      indicator_id: id,
      name: t.name,
      vertical: t.vertical,
      yellow_at: (ov ?? t).yellow_at,
      orange_at: (ov ?? t).orange_at,
      red_at: (ov ?? t).red_at,
      source: ov ? 'tenant_override' : 'platform_default',
    }));
  }),
  http.put('/v1/indicators/thresholds/:indicator_id', async ({ params, request }) => {
    const id = String(params.indicator_id);
    const t = __mswThresholds().find((x) => x.indicator_id === id);
    if (!t) return HttpResponse.json(envelopeError('EWS_404_unknown_indicator', `unknown ${id}`, 'LOW'), { status: 404 });
    const raw = (await request.json()) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
      ? (raw.body as Record<string, unknown>)
      : raw) as { yellow_at?: number; orange_at?: number; red_at?: number };
    if (typeof body.yellow_at !== 'number' || typeof body.orange_at !== 'number' || typeof body.red_at !== 'number') {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'yellow_at + orange_at + red_at required', 'MEDIUM'), { status: 400 });
    }
    if (!(body.yellow_at <= body.orange_at && body.orange_at <= body.red_at)) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_monotonic', 'yellow ≤ orange ≤ red required', 'MEDIUM'), { status: 400 });
    }
    __mswThresholdOverrides.set(id, { yellow_at: body.yellow_at, orange_at: body.orange_at, red_at: body.red_at });
    return HttpResponse.json(envelope({
      indicator_id: id,
      name: t.name,
      vertical: t.vertical,
      yellow_at: body.yellow_at,
      orange_at: body.orange_at,
      red_at: body.red_at,
      source: 'tenant_override',
    }));
  }),
  http.delete('/v1/indicators/thresholds/:indicator_id', ({ params }) => {
    const id = String(params.indicator_id);
    if (!__mswThresholdOverrides.has(id)) {
      return HttpResponse.json(envelopeError('EWS_404_no_override', `no override for ${id}`, 'LOW'), { status: 404 });
    }
    __mswThresholdOverrides.delete(id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/v1/indicators/thresholds/:indicator_id/suggest', async ({ params, request }) => {
    const id = String(params.indicator_id);
    const raw = (await request.json()) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
      ? (raw.body as Record<string, unknown>)
      : raw) as { values?: number[]; polarity?: 'higher_is_worse' | 'lower_is_worse' };
    const values = Array.isArray(body.values) ? body.values.filter((v) => Number.isFinite(v)) : [];
    if (values.length < 5) {
      return HttpResponse.json(envelope({
        indicator_id: id,
        suggested: null,
        sample_size: values.length,
        polarity: body.polarity ?? 'higher_is_worse',
        sample_min: values.length > 0 ? Math.min(...values) : null,
        sample_max: values.length > 0 ? Math.max(...values) : null,
        insufficient_reason: 'too_few_samples',
      }));
    }
    const sorted = [...values].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.floor((sorted.length - 1) * p)]!;
    const polarity = body.polarity ?? 'higher_is_worse';
    const suggested = polarity === 'higher_is_worse'
      ? { yellow_at: pct(0.5), orange_at: pct(0.75), red_at: pct(0.95) }
      : { yellow_at: pct(0.5), orange_at: pct(0.25), red_at: pct(0.05) };
    return HttpResponse.json(envelope({
      indicator_id: id,
      suggested,
      sample_size: values.length,
      polarity,
      sample_min: sorted[0]!,
      sample_max: sorted[sorted.length - 1]!,
      insufficient_reason: null,
    }));
  }),
  http.post('/v1/indicators/thresholds/check', async ({ request }) => {
    const raw = (await request.json()) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
      ? (raw.body as Record<string, unknown>)
      : raw) as { indicator_id?: string; value?: number };
    const id = body.indicator_id ?? '';
    const t = __mswThresholds().find((x) => x.indicator_id === id);
    if (!t || typeof body.value !== 'number') {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'indicator_id + value required', 'MEDIUM'), { status: 400 });
    }
    const v = body.value;
    const eff = __mswThresholdOverrides.get(id) ?? t;
    const band =
      v >= eff.red_at ? 'red'
      : v >= eff.orange_at ? 'orange'
      : v >= eff.yellow_at ? 'yellow'
      : 'green';
    return HttpResponse.json(envelope({
      band,
      threshold: { indicator_id: id, ...eff, source: __mswThresholdOverrides.has(id) ? 'tenant_override' : 'platform_default' },
    }));
  }),

  // M5.2 — Rules Engine MSW handlers. Spec routes mostly already exist
  // in the BFF; these stubs cover dev mode so the SPA page renders.
  http.get('/v1/rules/templates/categories', () =>
    HttpResponse.json(envelope({
      items: ['risk_monitoring', 'fraud_detection', 'compliance', 'operational', 'underwriting'],
      total: 5,
    })),
  ),
  http.get('/v1/rules/templates', ({ request }) => {
    const url = new URL(request.url);
    const vertical = url.searchParams.get('vertical');
    const category = url.searchParams.get('category');
    const all = [
      { id: 'tpl_dpd_30_60', name: 'DPD 30-60 watch list', category: 'risk_monitoring', vertical: 'banking', recommended_severity: 'high', recommended_actions: ['open_case'], supporting_indicators: ['FIN-001', 'FIN-002'], condition_pseudocode: 'dpd_max_90d in [30,60]', source_doc: 'RBI master direction' },
      { id: 'tpl_repeat_claim_180d', name: 'Repeat claim in 180 days', category: 'fraud_detection', vertical: 'insurance', recommended_severity: 'critical', recommended_actions: ['open_case', 'flag_for_review'], supporting_indicators: ['CLM-002', 'CLM-005'], condition_pseudocode: 'claim_count_180d > 2', source_doc: 'IRDAI claim fraud guide' },
      { id: 'tpl_velocity_24h', name: 'High velocity in 24h', category: 'fraud_detection', vertical: 'banking', recommended_severity: 'critical', recommended_actions: ['pause_disbursement', 'flag_for_review'], supporting_indicators: ['TXN-001'], condition_pseudocode: 'txn_count_24h > 25', source_doc: 'BIL §11' },
      { id: 'tpl_aml_high_severity_open', name: 'AML high-severity open', category: 'compliance', vertical: 'both', recommended_severity: 'critical', recommended_actions: ['open_case', 'notify_supervisor'], supporting_indicators: ['FIN-005'], condition_pseudocode: 'open_aml_high_count > 0', source_doc: 'AML KYC framework' },
      { id: 'tpl_kyc_expired', name: 'KYC expired', category: 'compliance', vertical: 'both', recommended_severity: 'high', recommended_actions: ['request_documents'], supporting_indicators: ['CUS-001'], condition_pseudocode: 'kyc_expires_at < today', source_doc: 'AML KYC framework' },
    ];
    const filtered = all.filter((t) =>
      (!vertical || t.vertical === vertical || t.vertical === 'both') &&
      (!category || t.category === category),
    );
    return HttpResponse.json(envelope({ items: filtered, total: filtered.length }));
  }),
  http.get('/v1/rules/templates/custom', () =>
    HttpResponse.json(envelope({ items: __mswCustomRuleTemplates, total: __mswCustomRuleTemplates.length })),
  ),
  http.post('/v1/rules/templates/custom/clone-from-library', async ({ request }) => {
    const raw = (await request.json()) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
      ? (raw.body as Record<string, unknown>)
      : raw) as { source_template_id?: string; name?: string };
    if (!body.source_template_id) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'source_template_id required', 'MEDIUM'), { status: 400 });
    }
    const created = {
      custom_template_id: `ctpl-${Date.now()}`,
      id: `ctpl-${Date.now()}`,
      tenant_id: 'BANK_DEMO',
      cloned_from: body.source_template_id,
      name: body.name ?? `Copy of ${body.source_template_id}`,
      category: 'risk_monitoring',
      vertical: 'banking',
      recommended_severity: 'high',
      recommended_actions: ['open_case'],
      supporting_indicators: ['FIN-001'],
      condition_pseudocode: '<cloned>',
      source_doc: 'cloned from library',
      created_at: new Date().toISOString(),
      created_by: 'alice.admin',
    };
    __mswCustomRuleTemplates.push(created);
    return HttpResponse.json(envelope(created), { status: 201 });
  }),
  http.post('/v1/rules/simulate', async ({ request }) => {
    const raw = (await request.json()) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
      ? (raw.body as Record<string, unknown>)
      : raw) as { rule_template_id?: string; scenario_preset_id?: string; customer_count?: number };
    if (!body.rule_template_id || !body.scenario_preset_id) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'rule_template_id + scenario_preset_id required', 'MEDIUM'), { status: 400 });
    }
    const total = Number(body.customer_count ?? 500);
    const fired = Math.round(total * 0.18); // ~18% fire rate for demo
    return HttpResponse.json(envelope({
      rule_template_id: body.rule_template_id,
      rule_name: 'Demo template',
      rule_category: 'risk_monitoring',
      recommended_severity: 'high',
      scenario_preset_id: body.scenario_preset_id,
      scenario_name: 'Demo scenario',
      customer_count: total,
      fired_count: fired,
      pass_count: fired,
      fail_count: total - fired,
      fire_rate: fired / total,
      baseline_fire_rate: 0.05,
      amplification: 3.6,
      by_severity: { critical: Math.round(fired * 0.15), high: Math.round(fired * 0.6), medium: Math.round(fired * 0.2), low: Math.round(fired * 0.05) },
      sample_matched_records: Array.from({ length: Math.min(10, fired) }).map((_, i) => ({
        customer_id: `c-sim-${(10000 + i).toString().padStart(5, '0')}`,
        segment: (['RETAIL', 'SME', 'CORPORATE', 'NBFC'] as const)[i % 4],
        contribution: Math.round((0.92 - i * 0.06) * 100) / 100,
      })),
      projected_alert_volume_per_day: Math.round((fired / 14) * 10) / 10,
      simulated_at: new Date().toISOString(),
    }));
  }),
  http.get('/v1/scenarios/library', () =>
    HttpResponse.json(envelope({
      items: [
        { id: 'rbi_baseline', name: 'RBI Baseline Stress', category: 'regulatory', regulator: 'RBI', severity: 'mild', shocks: { gdp: -0.5, rate: 50, fx: 2 } },
        { id: 'rbi_adverse', name: 'RBI Adverse Stress', category: 'regulatory', regulator: 'RBI', severity: 'moderate', shocks: { gdp: -2, rate: 150, fx: 5 } },
        { id: 'rbi_severely_adverse', name: 'RBI Severely Adverse', category: 'regulatory', regulator: 'RBI', severity: 'severe', shocks: { gdp: -5, rate: 300, fx: 12 } },
        { id: 'irdai_solvency', name: 'IRDAI Solvency Stress', category: 'regulatory', regulator: 'IRDAI', severity: 'moderate', shocks: { gdp: -2.5, rate: 100, fx: 4 } },
        { id: 'pandemic_v2', name: 'Pandemic stress (v2)', category: 'black_swan', regulator: 'INTERNAL', severity: 'severe', shocks: { gdp: -7, rate: -100, fx: 8 } },
        { id: 'baseline_zero', name: 'Baseline (no shock)', category: 'baseline', regulator: 'INTERNAL', severity: 'mild', shocks: { gdp: 0, rate: 0, fx: 0 } },
      ],
      total: 6,
    })),
  ),
  http.get('/v1/ews/rules/indicators', () =>
    HttpResponse.json(envelope({
      items: [
        { id: 'EWS-001', name: 'Days Past Due (max 90d)', family: 'credit', description: 'Worst DPD in trailing 90 days', unit: 'days' },
        { id: 'EWS-002', name: 'Credit utilisation %', family: 'credit', description: 'Outstanding / sanctioned limit', unit: 'percent' },
        { id: 'EWS-003', name: 'Bureau score', family: 'credit', description: 'CIBIL/Experian score (latest pull)', unit: 'score' },
        { id: 'EWS-004', name: 'Cheque bounce rate (180d)', family: 'behavioural', description: 'Bounces / total in last 180 days' },
        { id: 'EWS-005', name: 'Cash withdrawal velocity', family: 'transaction', description: 'Cash withdrawal z-score', unit: 'σ' },
        { id: 'EWS-006', name: 'AML high-severity open', family: 'fraud', description: 'Count of open high-severity AML matches' },
      ],
    })),
  ),

  // M5.1 — Master Setup MSW handlers. Generic in-memory CRUD over an
  // open master_type. Special record_id 'inuse-xx' surfaces 12 fake
  // usages so the SPA can demonstrate the 409 EWS_409_in_use guard.
  http.get('/v1/master/:master_type', ({ request, params }) => {
    const type = String(params.master_type);
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.toLowerCase();
    const rows = __mswMasterByType(type);
    const filtered = q
      ? rows.filter((r) => String(r.code).toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q))
      : rows;
    return HttpResponse.json(envelope({ master_type: type, records: filtered }));
  }),
  http.post('/v1/master/:master_type', async ({ request, params }) => {
    const type = String(params.master_type);
    const raw = (await request.json()) as Record<string, unknown>;
    const body = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
      ? (raw.body as Record<string, unknown>)
      : raw) as { code?: string; name?: string; description?: string; attributes?: Record<string, string | number | boolean>; enabled?: boolean };
    if (!body.code || !body.name) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'code + name required', 'MEDIUM'), { status: 400 });
    }
    const rows = __mswMasterByType(type);
    if (rows.some((r) => r.code === body.code)) {
      return HttpResponse.json(envelopeError('EWS_409_duplicate_code', 'duplicate code', 'MEDIUM'), { status: 409 });
    }
    const now = new Date().toISOString();
    const created = {
      record_id: `m-${type}-BANK_DEMO-${String(rows.length + 1).padStart(6, '0')}`,
      tenant_id: 'BANK_DEMO',
      master_type: type,
      code: body.code,
      name: body.name,
      description: body.description ?? '',
      attributes: body.attributes ?? {},
      enabled: body.enabled !== false,
      created_at: now,
      updated_at: now,
      created_by: 'alice.admin',
    };
    rows.push(created);
    return HttpResponse.json(envelope(created), { status: 201 });
  }),
  http.patch('/v1/master/:master_type/:record_id', async ({ request, params }) => {
    const type = String(params.master_type);
    const id = String(params.record_id);
    const raw = (await request.json()) as Record<string, unknown>;
    const patch = (raw && typeof raw === 'object' && 'header' in raw && 'body' in raw
      ? (raw.body as Record<string, unknown>)
      : raw) as { name?: string; description?: string; attributes?: Record<string, string | number | boolean>; enabled?: boolean };
    const rows = __mswMasterByType(type);
    const idx = rows.findIndex((r) => r.record_id === id);
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_record', `unknown ${id}`, 'LOW'), { status: 404 });
    }
    const next = { ...rows[idx]!, ...patch, updated_at: new Date().toISOString() };
    rows[idx] = next;
    return HttpResponse.json(envelope(next));
  }),
  http.get('/v1/master/:master_type/:record_id/where-used', ({ params }) => {
    const type = String(params.master_type);
    const id = String(params.record_id);
    const rows = __mswMasterByType(type);
    const row = rows.find((r) => r.record_id === id);
    if (!row) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_record', `unknown ${id}`, 'LOW'), { status: 404 });
    }
    // 'inuse-xx' in code triggers the demo in-use path
    if (String(row.code).toUpperCase().includes('INUSE')) {
      return HttpResponse.json(envelope({
        master_type: type,
        record_id: id,
        code: row.code,
        total_references: 12,
        references: Array.from({ length: 12 }).map((_, i) => ({
          resource_type: i < 8 ? 'loan' : 'transaction',
          resource_id: i < 8 ? `L-100${i}` : `T-200${i}`,
          description: i === 0 ? 'Earliest reference (loan disbursal 2025-Q1)' : undefined,
        })),
      }));
    }
    return HttpResponse.json(envelope({
      master_type: type,
      record_id: id,
      code: row.code,
      total_references: 0,
      references: [],
    }));
  }),
  http.delete('/v1/master/:master_type/:record_id', ({ params }) => {
    const type = String(params.master_type);
    const id = String(params.record_id);
    const rows = __mswMasterByType(type);
    const idx = rows.findIndex((r) => r.record_id === id);
    if (idx < 0) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_record', `unknown ${id}`, 'LOW'), { status: 404 });
    }
    if (String(rows[idx]!.code).toUpperCase().includes('INUSE')) {
      return HttpResponse.json(
        {
          ...envelopeError('EWS_409_in_use', 'in use by 12 record(s)', 'MEDIUM'),
          error: {
            ...envelopeError('EWS_409_in_use', 'in use by 12 record(s)', 'MEDIUM').error,
            detail: {
              total_references: 12,
              references: [
                { resource_type: 'loan', resource_id: 'L-1000' },
                { resource_type: 'loan', resource_id: 'L-1001' },
              ],
            },
          },
        },
        { status: 409 },
      );
    }
    rows.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // M4.3 — Explainability MSW handlers. Deterministic synth so dev mode
  // renders without a BFF. Special prediction_ids drive the gate UI:
  // 'expired-xx' → 410, 'missing-xx' → 404.
  http.get('/v1/ai/predictions/:prediction_id/explanation', ({ params }) => {
    const pid = String(params.prediction_id);
    if (pid === 'expired-xx') {
      return HttpResponse.json(envelopeError('EWS_410_explanation_expired', 'too old', 'MEDIUM'), { status: 410 });
    }
    if (pid === 'missing-xx') {
      return HttpResponse.json(envelopeError('EWS_404_unknown_prediction', 'not found', 'LOW'), { status: 404 });
    }
    const features = [
      { feature_name: 'dpd_max_90d', display_name: 'Max DPD (90d)', weight: 0.31, base_value: 0.08, observed_value: '45 days', direction: 'up' as const, group: 'credit' as const },
      { feature_name: 'utilization_pct', display_name: 'Utilization', weight: 0.22, base_value: 0.08, observed_value: '92%', direction: 'up' as const, group: 'credit' as const },
      { feature_name: 'bureau_score', display_name: 'Bureau Score', weight: -0.14, base_value: 0.08, observed_value: '612', direction: 'down' as const, group: 'credit' as const },
      { feature_name: 'cash_withdrawal_velocity', display_name: 'Cash withdrawal velocity', weight: 0.18, base_value: 0.08, observed_value: '+2.4σ', direction: 'up' as const, group: 'behavioural' as const },
      { feature_name: 'cheque_bounce_rate', display_name: 'Cheque bounce rate (180d)', weight: 0.12, base_value: 0.08, observed_value: '3 of 12', direction: 'up' as const, group: 'behavioural' as const },
    ];
    return HttpResponse.json(envelope({
      tenant_id: 'BANK_DEMO',
      prediction_id: pid,
      generated_at: new Date().toISOString(),
      model_id: 'pd-xgb-prod',
      model_version: 'v3.2.0',
      pd: 0.72,
      band: 'high',
      base_pd_population: 0.082,
      top_features: features,
      counterfactual: {
        description: 'If Max DPD (90d) dropped from 45 days to baseline, PD would fall ~0.31',
        change_feature: 'dpd_max_90d',
        required_value: 'baseline (≤ population mean)',
        resulting_pd: 0.41,
        resulting_band: 'medium',
      },
      feature_group_summary: [
        { group: 'credit', contribution: 0.39, pct_of_total: 0.41 },
        { group: 'behavioural', contribution: 0.30, pct_of_total: 0.32 },
      ],
    }));
  }),
  http.get('/v1/ai/predictions/:prediction_id/feature-importance', ({ params }) => {
    const pid = String(params.prediction_id);
    if (pid === 'expired-xx') {
      return HttpResponse.json(envelopeError('EWS_410_explanation_expired', 'too old', 'MEDIUM'), { status: 410 });
    }
    const pool = [
      { name: 'dpd_max_90d', display: 'Max DPD (90d)', group: 'credit', sample: '45 days', w: 0.31 },
      { name: 'utilization_pct', display: 'Utilization', group: 'credit', sample: '92%', w: 0.22 },
      { name: 'cash_withdrawal_velocity', display: 'Cash withdrawal velocity', group: 'behavioural', sample: '+2.4σ', w: 0.18 },
      { name: 'bureau_score', display: 'Bureau Score', group: 'credit', sample: '612', w: -0.14 },
      { name: 'cheque_bounce_rate', display: 'Cheque bounce rate (180d)', group: 'behavioural', sample: '3 of 12', w: 0.12 },
      { name: 'monthly_credit_zscore', display: 'Monthly credit z-score', group: 'transaction', sample: '-1.8σ', w: -0.09 },
      { name: 'txn_concentration_top5', display: 'Counterparty concentration', group: 'transaction', sample: '78%', w: 0.08 },
      { name: 'collateral_coverage_ratio', display: 'Collateral coverage', group: 'collateral', sample: '0.72', w: -0.06 },
      { name: 'sector_npa_ratio', display: 'Sector NPA ratio', group: 'macro', sample: '6.8%', w: 0.04 },
    ];
    const totalAbs = pool.reduce((s, p) => s + Math.abs(p.w), 0);
    const features = pool.map((p, i) => ({
      rank: i + 1,
      feature_name: p.name,
      display_name: p.display,
      group: p.group,
      weight: p.w,
      abs_weight: Math.abs(p.w),
      direction: p.w >= 0 ? 'up' : 'down',
      pct_of_total: Math.abs(p.w) / totalAbs,
      observed_value: p.sample,
    }));
    return HttpResponse.json(envelope({
      tenant_id: 'BANK_DEMO',
      prediction_id: pid,
      generated_at: new Date().toISOString(),
      model_id: 'pd-xgb-prod',
      model_version: 'v3.2.0',
      total_features: features.length,
      features,
      by_group: [
        { group: 'credit', total_abs_weight: 0.67, share: 0.54 },
        { group: 'behavioural', total_abs_weight: 0.30, share: 0.24 },
        { group: 'transaction', total_abs_weight: 0.17, share: 0.14 },
        { group: 'collateral', total_abs_weight: 0.06, share: 0.05 },
        { group: 'macro', total_abs_weight: 0.04, share: 0.03 },
      ],
    }));
  }),
  http.get('/v1/ai/predictions/:prediction_id/trust-signals', ({ params }) => {
    const pid = String(params.prediction_id);
    if (pid === 'expired-xx') {
      return HttpResponse.json(envelopeError('EWS_410_explanation_expired', 'too old', 'MEDIUM'), { status: 410 });
    }
    return HttpResponse.json(envelope({
      tenant_id: 'BANK_DEMO',
      prediction_id: pid,
      generated_at: new Date().toISOString(),
      overall: 'amber',
      signals: [
        { signal: 'feature_drift_psi', status: 'amber', value: '0.18', threshold: '<0.10 green / <0.25 amber', description: 'PSI across model features' },
        { signal: 'calibration_coverage', status: 'green', value: '0.92', threshold: '>0.90 green', description: '90% prediction interval calibration' },
        { signal: 'training_cohort_size', status: 'green', value: '180,000', threshold: '>100k green', description: 'Training cohort size' },
        { signal: 'feature_freshness_days', status: 'green', value: '3 days', threshold: '<7d green', description: 'Feature refresh recency' },
        { signal: 'training_freshness_days', status: 'amber', value: '85 days', threshold: '<60d green / <120d amber', description: 'Days since last retraining' },
      ],
    }));
  }),

  http.get('/v1/audit/integrity', () => {
    const all = __mswAuditEvents();
    const last = all[0]; // newest-first; last appended = head
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        total_events: all.length,
        valid: true,
        last_hash: last?.hash ?? 'GENESIS',
      }),
    );
  }),

  // ── M6.2 — Audit Trail: evidence packages + retention + correlations ──
  http.get('/v1/audit/correlations', () => {
    const all = __mswAuditEvents();
    const byId = new Map<string, ReturnType<typeof __mswAuditEvents>[number][]>();
    for (const ev of all) {
      const cid = ev.correlation_id;
      if (!cid) continue;
      const arr = byId.get(cid) ?? [];
      arr.push(ev);
      byId.set(cid, arr);
    }
    const correlations = Array.from(byId.entries()).map(([cid, evs]) => ({
      correlation_id: cid,
      total_events: evs.length,
      first_ts: evs[evs.length - 1]!.ts,
      last_ts: evs[0]!.ts,
      actors: Array.from(new Set(evs.map((e) => e.actor_username))).sort(),
      actions: Array.from(new Set(evs.map((e) => e.action))).sort(),
      resource_types: Array.from(new Set(evs.map((e) => e.resource_type))).sort(),
      event_ids: evs.map((e) => e.event_id),
    }));
    return HttpResponse.json(envelope({ correlations }));
  }),

  http.get('/v1/audit/evidence', () => {
    return HttpResponse.json(envelope({ items: __mswEvidencePackages, total: __mswEvidencePackages.length }));
  }),

  http.post('/v1/audit/evidence', async ({ request }) => {
    const raw = (await request.json()) as Record<string, unknown>;
    const inner =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    const all = __mswAuditEvents();
    const filters = inner as { actor_username?: string; action?: string; resource_type?: string; outcome?: string; severity?: string };
    const matching = all.filter((e) => {
      if (filters.actor_username && e.actor_username !== filters.actor_username) return false;
      if (filters.action && e.action !== filters.action) return false;
      if (filters.resource_type && e.resource_type !== filters.resource_type) return false;
      if (filters.outcome && e.outcome !== filters.outcome) return false;
      if (filters.severity && e.severity !== filters.severity) return false;
      return true;
    });
    __mswEvidenceSeq++;
    const pkg = {
      package_id: `EVD-BANK_DEMO-${String(__mswEvidenceSeq).padStart(5, '0')}`,
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      generated_by: 'alice.admin',
      filters: filters,
      event_count: matching.length,
      size_bytes: JSON.stringify(matching).length,
      integrity: {
        chain_verified: true,
        chain_last_hash: matching[0]?.hash ?? 'GENESIS',
        first_event_hash: matching.length ? matching[matching.length - 1]!.hash : null,
        last_event_hash: matching[0]?.hash ?? null,
      },
      events: matching,
    };
    __mswEvidencePackages.unshift(pkg);
    return HttpResponse.json(envelope(pkg), { status: 201 });
  }),

  http.get('/v1/audit/evidence/:package_id', ({ params }) => {
    const id = String(params.package_id);
    const found = __mswEvidencePackages.find((p) => p.package_id === id);
    if (!found) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_package', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(found));
  }),

  http.get('/v1/admin/audit-retention/strategies', () => {
    return HttpResponse.json(envelope({
      strategies: ['count_cap', 'time_window', 'never_purge'],
      scopes: ['audit_trail'],
    }));
  }),

  http.get('/v1/admin/audit-retention', () => {
    return HttpResponse.json(envelope({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      total: __mswRetentionPolicies.length,
      items: __mswRetentionPolicies,
    }));
  }),

  http.post('/v1/admin/audit-retention', async ({ request }) => {
    const raw = (await request.json()) as Record<string, unknown>;
    const inner =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    const policy_id = String(inner.policy_id ?? '');
    if (!policy_id) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_policy_id', 'policy_id required', 'MEDIUM'),
        { status: 400 },
      );
    }
    if (__mswRetentionPolicies.some((p) => p.policy_id === policy_id)) {
      return HttpResponse.json(
        envelopeError('EWS_409_duplicate_policy_id', `policy_id ${policy_id} already exists`, 'MEDIUM'),
        { status: 409 },
      );
    }
    const entry = {
      policy_id,
      tenant_id: 'BANK_DEMO',
      scope: String(inner.scope ?? 'audit_trail'),
      strategy: String(inner.strategy ?? 'time_window'),
      retention_days: (inner.retention_days as number | null) ?? null,
      max_events: (inner.max_events as number | null) ?? null,
      notes: (inner.notes as string | null) ?? null,
      active: inner.active !== false,
      created_at: new Date().toISOString(),
      created_by: 'alice.admin',
      updated_at: new Date().toISOString(),
    };
    __mswRetentionPolicies.push(entry);
    return HttpResponse.json(envelope(entry), { status: 201 });
  }),

  http.delete('/v1/admin/audit-retention/:policy_id', ({ params }) => {
    const id = String(params.policy_id);
    const idx = __mswRetentionPolicies.findIndex((p) => p.policy_id === id);
    if (idx === -1) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_policy', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    }
    __mswRetentionPolicies.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // ── Enterprise IAM (additive — mirrors services/auth-svc IUserLifecycle /
  //                   IPasswordGovernance / IUserApproval / IUserAudit stores).

  http.get('/auth/users/lifecycle/by-status', () =>
    HttpResponse.json({
      items: [
        { user_id: 'u-001', status: 'active' },
        { user_id: 'u-002', status: 'active' },
        { user_id: 'u-003', status: 'suspended' },
        { user_id: 'u-004', status: 'pending_approval' },
        { user_id: 'u-005', status: 'locked' },
      ],
    }),
  ),

  http.get('/auth/users/:user_id/status-history', ({ params }) =>
    HttpResponse.json({
      items: [
        {
          history_id: `ush_${params.user_id}_2`,
          user_id: String(params.user_id),
          tenant_id: 'BANK_DEMO',
          prev_status: 'active',
          new_status: 'suspended',
          changed_at: new Date(Date.now() - 86_400_000).toISOString(),
          changed_by: 'alice.admin',
          reason: 'Quarterly access review — temporarily suspended pending re-verification.',
          correlation_id: null,
          created_at: new Date(Date.now() - 86_400_000).toISOString(),
        },
        {
          history_id: `ush_${params.user_id}_1`,
          user_id: String(params.user_id),
          tenant_id: 'BANK_DEMO',
          prev_status: null,
          new_status: 'active',
          changed_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
          changed_by: 'system',
          reason: null,
          correlation_id: null,
          created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        },
      ],
    }),
  ),

  http.post('/auth/users/lifecycle/bulk-update', async ({ request }) => {
    const body = (await request.json()) as { user_ids?: string[]; new_status?: string };
    const ids = body?.user_ids ?? [];
    return HttpResponse.json({
      updated: ids.length,
      failed: [],
      correlation_id: `bulk_${Date.now().toString(36)}`,
    });
  }),

  http.get('/auth/users/:username/access-review', ({ params }) =>
    HttpResponse.json({
      user_id: `u-${params.username}`,
      username: String(params.username),
      display_name: String(params.username),
      status: 'active',
      country: 'IN',
      domain: 'banking',
      tenant_id: 'BANK_DEMO',
      branch_id: 'BR-MUM-001',
      department: 'Risk Operations',
      roles: ['risk_analyst'],
      last_login_at: new Date(Date.now() - 3600_000).toISOString(),
      last_logout_at: new Date(Date.now() - 86_400_000).toISOString(),
      active_session_count: 1,
      rbac_modules: [
        { module_id: 'user_management', granted_actions: ['view'] },
        { module_id: 'alert_management', granted_actions: ['view', 'edit', 'approve'] },
        { module_id: 'case_management', granted_actions: ['view', 'create', 'edit'] },
        { module_id: 'rule_engine', granted_actions: ['view', 'edit'] },
        { module_id: 'ai_workbench', granted_actions: ['view'] },
        { module_id: 'audit', granted_actions: ['view', 'export'] },
      ],
    }),
  ),

  http.get('/auth/password-policy/me', () =>
    HttpResponse.json({
      tenant_id: 'BANK_DEMO',
      min_len: 12,
      require_upper: true,
      require_lower: true,
      require_digit: true,
      require_symbol: true,
      expiry_days: 90,
      history_count: 5,
      lockout_threshold: 5,
      lockout_window_min: 15,
      reminder_days_before_expiry: 7,
      updated_at: '1970-01-01T00:00:00.000Z',
      updated_by: null,
    }),
  ),

  http.put('/auth/password-policy/me', async ({ request }) => {
    const patch = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      tenant_id: 'BANK_DEMO',
      min_len: 12,
      require_upper: true,
      require_lower: true,
      require_digit: true,
      require_symbol: true,
      expiry_days: 90,
      history_count: 5,
      lockout_threshold: 5,
      lockout_window_min: 15,
      reminder_days_before_expiry: 7,
      ...patch,
      updated_at: new Date().toISOString(),
      updated_by: 'alice.admin',
    });
  }),

  http.get('/auth/users/password-governance/expiring', () =>
    HttpResponse.json({
      within_days: 7,
      users: [
        { user_id: 'u-003', expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), days_remaining: 2 },
        { user_id: 'u-007', expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), days_remaining: 5 },
      ],
    }),
  ),

  http.get('/auth/users/approvals/summary', () =>
    HttpResponse.json({
      tenant_id: 'BANK_DEMO',
      by_status: { pending: 2, approved: 12, rejected: 1, cancelled: 0, expired: 0 },
      by_action_type: {
        user_create: 1, user_role_change: 1, user_status_change: 0,
        user_delete: 0, user_access_grant: 0, password_force_reset: 0,
      },
      oldest_pending_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
    }),
  ),

  http.get('/auth/users/approvals', ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') ?? 'pending';
    const allItems = [
      {
        approval_id: 'appr_1',
        user_id: 'u-new-001',
        tenant_id: 'BANK_DEMO',
        action_type: 'user_create' as const,
        status: 'pending' as const,
        payload: { username: 'new.user', role: 'risk_analyst', tenant_id: 'BANK_DEMO' },
        requested_by: 'bob.supervisor',
        requested_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
        request_comments: 'Onboarding new risk analyst for Mumbai branch.',
        approver: null,
        approval_date: null,
        decision_comments: null,
        expires_at: null,
      },
      {
        approval_id: 'appr_2',
        user_id: 'u-002',
        tenant_id: 'BANK_DEMO',
        action_type: 'user_role_change' as const,
        status: 'pending' as const,
        payload: { from_role: 'risk_analyst', to_role: 'supervisor' },
        requested_by: 'carol.admin',
        requested_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        request_comments: 'Promotion approved by HR.',
        approver: null,
        approval_date: null,
        decision_comments: null,
        expires_at: null,
      },
    ];
    const filtered = status ? allItems.filter((r) => r.status === status) : allItems;
    return HttpResponse.json({ items: filtered, total: filtered.length, page: 1, page_size: 50 });
  }),

  http.post('/auth/users/approvals/:approval_id/approve', async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as { decision_comments?: string };
    return HttpResponse.json({
      approval_id: String(params.approval_id),
      user_id: 'u-001',
      tenant_id: 'BANK_DEMO',
      action_type: 'user_create',
      status: 'approved',
      payload: {},
      requested_by: 'bob.supervisor',
      requested_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
      request_comments: null,
      approver: 'alice.admin',
      approval_date: new Date().toISOString(),
      decision_comments: body.decision_comments ?? null,
      expires_at: null,
    });
  }),

  http.post('/auth/users/approvals/:approval_id/reject', async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as { decision_comments?: string };
    return HttpResponse.json({
      approval_id: String(params.approval_id),
      user_id: 'u-001',
      tenant_id: 'BANK_DEMO',
      action_type: 'user_create',
      status: 'rejected',
      payload: {},
      requested_by: 'bob.supervisor',
      requested_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
      request_comments: null,
      approver: 'alice.admin',
      approval_date: new Date().toISOString(),
      decision_comments: body.decision_comments ?? null,
      expires_at: null,
    });
  }),

  http.get('/auth/users/:user_id/audit-history', ({ params }) =>
    HttpResponse.json({
      items: [
        {
          audit_id: 'uah_2',
          user_id: String(params.user_id),
          tenant_id: 'BANK_DEMO',
          event_type: 'role_changed',
          before_state: { role: 'risk_analyst' },
          after_state: { role: 'supervisor' },
          actor: 'alice.admin',
          occurred_at: new Date(Date.now() - 3600_000).toISOString(),
          comments: 'Promoted per HR ticket #4127.',
          correlation_id: null,
          ip_address: '10.0.0.42',
        },
        {
          audit_id: 'uah_1',
          user_id: String(params.user_id),
          tenant_id: 'BANK_DEMO',
          event_type: 'user_created',
          before_state: null,
          after_state: { username: String(params.user_id), role: 'risk_analyst' },
          actor: 'system',
          occurred_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
          comments: null,
          correlation_id: null,
          ip_address: null,
        },
      ],
      total: 2,
      page: 1,
      page_size: 50,
    }),
  ),

  http.get('/auth/users/audit-history/by-tenant', () =>
    HttpResponse.json({
      items: [
        {
          audit_id: 'uah_3',
          user_id: 'u-001',
          tenant_id: 'BANK_DEMO',
          event_type: 'status_changed',
          before_state: { status: 'active' },
          after_state: { status: 'suspended' },
          actor: 'alice.admin',
          occurred_at: new Date(Date.now() - 1800_000).toISOString(),
          comments: 'Quarterly review hold.',
          correlation_id: null,
          ip_address: null,
        },
      ],
      total: 1,
      page: 1,
      page_size: 50,
    }),
  ),

];

// M6.2 — Audit Trail: in-memory state for evidence packages + retention.
// Resettable so tests can start clean.
type MswEvidencePackage = {
  package_id: string;
  tenant_id: string;
  generated_at: string;
  generated_by: string;
  filters: Record<string, unknown>;
  event_count: number;
  size_bytes: number;
  integrity: {
    chain_verified: boolean;
    chain_last_hash: string;
    first_event_hash: string | null;
    last_event_hash: string | null;
  };
  events: ReturnType<typeof __mswAuditEvents>;
};
const __mswEvidencePackages: MswEvidencePackage[] = [];
let __mswEvidenceSeq = 0;

type MswRetentionPolicy = {
  policy_id: string;
  tenant_id: string;
  scope: string;
  strategy: string;
  retention_days: number | null;
  max_events: number | null;
  notes: string | null;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
};
const __mswRetentionPolicies: MswRetentionPolicy[] = [];

export function __resetMswM62() {
  __mswEvidencePackages.length = 0;
  __mswEvidenceSeq = 0;
  __mswRetentionPolicies.length = 0;
}
// Module 1.5 — Anomaly Detection handlers are appended after declaration
// further down the file. The append happens at module-eval time, so
// MSW's handler array contains them by the time the worker reads it.

// MSW seed for /v1/audit/* — deterministic small set so test-runs are stable.
// Module 1.2 — Data Profiling MSW seed
function __mswDqProfile(source_id: string) {
  const columns = [
    { column: 'loan_id', type: 'string', null_count: 12, null_pct: 0.001, distinct_count: 9_120, min: null, max: null, mean: null, p50: null, p95: null, std_dev: null, anomaly_score: 0.1, has_drift: false, top_values: [{ value: 'LN-100012', count: 18, pct: 0.0015 }, { value: 'LN-100013', count: 14, pct: 0.0012 }], format_detected: null },
    { column: 'customer_id', type: 'string', null_count: 0, null_pct: 0, distinct_count: 7_840, min: null, max: null, mean: null, p50: null, p95: null, std_dev: null, anomaly_score: 0.08, has_drift: false, top_values: [{ value: 'c-100012', count: 4500, pct: 0.18 }, { value: 'c-100020', count: 2800, pct: 0.15 }, { value: 'c-100015', count: 2400, pct: 0.13 }], format_detected: 'numeric_id' },
    { column: 'pan', type: 'string', null_count: 240, null_pct: 0.02, distinct_count: 9_120, min: null, max: null, mean: null, p50: null, p95: null, std_dev: null, anomaly_score: 0.05, has_drift: false, top_values: [{ value: 'AAAPL1234C', count: 12, pct: 0.001 }], format_detected: 'pan' },
    { column: 'sanctioned_amount', type: 'number', null_count: 0, null_pct: 0, distinct_count: 7_120, min: 50_000, max: 25_000_000, mean: 850_000, p50: 750_000, p95: 4_500_000, std_dev: 1_200_000, anomaly_score: 0.12, has_drift: false, top_values: [{ value: '500000', count: 320, pct: 0.027 }], format_detected: null },
    { column: 'worst_dpd', type: 'integer', null_count: 0, null_pct: 0, distinct_count: 540, min: 0, max: 540, mean: 32, p50: 12, p95: 180, std_dev: 64, anomaly_score: 0.45, has_drift: true, top_values: [{ value: '0', count: 8400, pct: 0.7 }, { value: '30', count: 1100, pct: 0.092 }], format_detected: null },
  ];
  return { tenant_id: 'BANK_DEMO', source_id, generated_at: new Date().toISOString(), total_rows: 12_000, columns };
}

// M5.2 — custom rule templates in-memory store
const __mswCustomRuleTemplates: Array<Record<string, unknown>> = [];

// M5.3 — Thresholds & Limits in-memory seed + override store.
const __mswThresholdOverrides = new Map<string, { yellow_at: number; orange_at: number; red_at: number }>();
function __mswThresholds() {
  return [
    { indicator_id: 'FIN-001', name: 'DPD max (90d)', vertical: 'banking', yellow_at: 0.3, orange_at: 0.55, red_at: 0.8 },
    { indicator_id: 'FIN-002', name: 'Credit utilisation %', vertical: 'banking', yellow_at: 0.6, orange_at: 0.8, red_at: 0.95 },
    { indicator_id: 'BEH-002', name: 'Cheque bounce rate (180d)', vertical: 'banking', yellow_at: 0.2, orange_at: 0.4, red_at: 0.7 },
    { indicator_id: 'INS-CLM-001', name: 'Repeat claim count (180d)', vertical: 'insurance', yellow_at: 0.3, orange_at: 0.6, red_at: 0.85 },
  ];
}

// M5.1 — Master Setup MSW seed. One row per tab so the SPA renders
// non-empty by default; 'INUSE_*' codes demonstrate the 409 EWS_409_in_use
// guard path.
const __mswMasterStore = new Map<string, Array<Record<string, unknown>> & { __seeded?: boolean }>();
function __mswMasterByType(type: string): Array<Record<string, string | number | boolean | Record<string, string | number | boolean>>> {
  let arr = __mswMasterStore.get(type) as Array<Record<string, string | number | boolean | Record<string, string | number | boolean>>> | undefined;
  if (!arr) {
    arr = [] as Array<Record<string, string | number | boolean | Record<string, string | number | boolean>>>;
    __mswMasterStore.set(type, arr as never);
  }
  // Lazy seed once
  if (!(arr as { __seeded?: boolean }).__seeded) {
    (arr as { __seeded?: boolean }).__seeded = true;
    const now = new Date().toISOString();
    const seed = __mswMasterSeed(type);
    for (const row of seed) arr.push({ ...row, created_at: now, updated_at: now, created_by: 'alice.admin' } as never);
  }
  return arr;
}
function __mswMasterSeed(type: string): Array<Record<string, unknown>> {
  const baseFor = (code: string, name: string, attributes: Record<string, string | number | boolean> = {}, desc = ''): Record<string, unknown> => ({
    record_id: `m-${type}-BANK_DEMO-seed-${code}`,
    tenant_id: 'BANK_DEMO',
    master_type: type,
    code,
    name,
    description: desc,
    attributes,
    enabled: true,
  });
  switch (type) {
    case 'currencies':
      return [
        baseFor('INR', 'Indian Rupee', { symbol: '₹', decimals: 2 }),
        baseFor('USD', 'US Dollar', { symbol: '$', decimals: 2 }),
        baseFor('INUSE_KES', 'Kenyan Shilling (referenced)', { symbol: 'KES', decimals: 2 }, 'Demo row — delete is refused via 409'),
      ];
    case 'severity_levels':
      return [
        baseFor('S1', 'Critical', { rank: 1, colour: '#dc2626' }),
        baseFor('S2', 'High', { rank: 2, colour: '#f59e0b' }),
        baseFor('S3', 'Medium', { rank: 3, colour: '#eab308' }),
      ];
    case 'regulators':
      return [
        baseFor('RBI', 'Reserve Bank of India', { country: 'IN', framework: 'SMA' }),
        baseFor('IRDAI', 'Insurance Regulatory and Development Authority', { country: 'IN', framework: 'IRDAI-Form-K' }),
        baseFor('RMA', 'Royal Monetary Authority of Bhutan', { country: 'BT', framework: 'RMA' }),
      ];
    case 'borrower_segments':
      return [
        baseFor('RETAIL', 'Retail', {}),
        baseFor('SME', 'Small + Medium Enterprises', {}),
        baseFor('CORP', 'Corporate', {}),
        baseFor('LARGE_CORP', 'Large Corporate', {}),
        baseFor('NBFC', 'NBFC', {}),
      ];
    case 'review_cadences':
      return [
        baseFor('DAILY', 'Daily', { interval_days: 1 }),
        baseFor('WEEKLY', 'Weekly', { interval_days: 7 }),
        baseFor('MONTHLY', 'Monthly', { interval_days: 30 }),
      ];
    case 'ai_models':
      return [
        baseFor('PD_XGB_V3', 'PD XGBoost v3 defaults', { model_type: 'pd', score_threshold: 0.7 }),
        baseFor('FRAUD_LGBM_V1', 'Fraud LightGBM v1', { model_type: 'fraud', score_threshold: 0.85 }),
      ];
    case 'reassign_teams':
      return [
        baseFor('CREDIT_MUMBAI', 'Credit Mumbai', { team_lead: 'alice.admin' }),
        baseFor('FRAUD_DESK', 'Fraud Desk', { team_lead: 'ravi.risk' }),
      ];
    case 'schedule_frequencies':
      return [
        baseFor('HOURLY', 'Hourly', { interval_days: 0 }),
        baseFor('DAILY', 'Daily', { interval_days: 1 }),
      ];
    case 'rule_categories':
      return [
        baseFor('RISK_MON', 'Risk Monitoring', {}),
        baseFor('FRAUD', 'Fraud Detection', {}),
      ];
    default:
      return [];
  }
}

// M4.2 — AI model registry seed (4 models covering each status)
const __mswAiModelsCustom: Array<Record<string, unknown>> = [
  { model_id: 'pd_xgb_v3', name: 'PD XGBoost', version: '3.2.1', type: 'pd', framework: 'xgboost', status: 'production', metrics: { auc: 0.847, ks: 0.61 }, trained_at: '2026-04-15T00:00:00Z', deployed_at: '2026-04-20T00:00:00Z' },
  { model_id: 'pd_xgb_v2', name: 'PD XGBoost', version: '2.4.0', type: 'pd', framework: 'xgboost', status: 'retired', metrics: { auc: 0.812 }, trained_at: '2026-01-10T00:00:00Z', deployed_at: null, retired_at: '2026-04-15T00:00:00Z' },
  { model_id: 'fraud_lgbm_v1', name: 'Fraud LightGBM', version: '1.0.0', type: 'fraud', framework: 'lightgbm', status: 'shadow', metrics: { auc: 0.78 }, trained_at: '2026-05-01T00:00:00Z', deployed_at: '2026-05-05T00:00:00Z' },
  { model_id: 'churn_sklearn_v1', name: 'Churn baseline', version: '0.4.0', type: 'churn', framework: 'sklearn', status: 'staging', metrics: { auc: 0.71 }, trained_at: '2026-05-10T00:00:00Z', deployed_at: null },
];
function __mswAiModels(): Array<Record<string, unknown>> {
  return [...__mswAiModelsCustom];
}

// Module 1.1 — Data Ingestion MSW seed
const __mswCustomConnectors: Array<Record<string, unknown>> = [];
function __mswConnectors() {
  const seed = [
    { id: 'cbs_loan_book', name: 'Core Banking Loan Book', source_system: 'CBS', type: 'kafka_stream', schedule: 'continuous', description: 'Streams loan + repayment events', default_status: 'healthy', status: 'healthy', last_run_at: new Date(Date.now() - 5 * 60_000).toISOString(), last_run_status: 'success', last_run_records: 52_400, average_lag_seconds: 8, paused_at: null, owner_user_id: 'ravi.risk', is_custom: false },
    { id: 'agent_productivity', name: 'Agent Productivity', source_system: 'AGENT', type: 'batch_csv', schedule: 'daily 03:00', description: 'Daily agent KPI rollup', default_status: 'degraded', status: 'degraded', last_run_at: new Date(Date.now() - 90 * 60_000).toISOString(), last_run_status: 'partial', last_run_records: 5_880, average_lag_seconds: 32, paused_at: null, owner_user_id: 'sue.super', is_custom: false },
    { id: 'aml_watchlist', name: 'AML Watchlist Sync', source_system: 'AML', type: 'rest_api', schedule: 'hourly', description: 'Pulls sanctions + PEP updates', default_status: 'healthy', status: 'healthy', last_run_at: new Date(Date.now() - 30 * 60_000).toISOString(), last_run_status: 'success', last_run_records: 412, average_lag_seconds: 4, paused_at: null, owner_user_id: null, is_custom: false },
  ];
  return [...__mswCustomConnectors, ...seed] as Array<Record<string, unknown>> as never[];
}

function __mswAuditEvents() {
  const NOW = Date.now();
  // newest-first sorted, mirrors backend behaviour
  return [
    { event_id: 'aud-msw-001', ts: new Date(NOW - 30 * 60_000).toISOString(), tenant_id: 'BANK_DEMO', actor_username: 'system', actor_role: 'system', action: 'user.access.review', resource_type: 'user' as const, resource_id: 'ravi.risk', outcome: 'denied' as const, severity: 'critical' as const, correlation_id: null, ip_address: null, metadata: { reason: 'dormant_90d_check' }, prev_hash: '47cf9e32', hash: '2df32923' },
    { event_id: 'aud-msw-002', ts: new Date(NOW - 60 * 60_000).toISOString(), tenant_id: 'BANK_DEMO', actor_username: 'fiona.field', actor_role: 'field_officer', action: 'auth.login', resource_type: 'session' as const, resource_id: 'sid-004', outcome: 'success' as const, severity: 'info' as const, correlation_id: null, ip_address: null, metadata: {}, prev_hash: '2df32923', hash: 'aa11bb22' },
    { event_id: 'aud-msw-003', ts: new Date(NOW - 2 * 3_600_000).toISOString(), tenant_id: 'BANK_DEMO', actor_username: 'fiona.field', actor_role: 'field_officer', action: 'auth.login', resource_type: 'session' as const, resource_id: 'sid-003', outcome: 'failure' as const, severity: 'warning' as const, correlation_id: null, ip_address: null, metadata: { reason: 'wrong_password' }, prev_hash: 'aa11bb22', hash: 'cc33dd44' },
    { event_id: 'aud-msw-004', ts: new Date(NOW - 4 * 3_600_000).toISOString(), tenant_id: 'BANK_DEMO', actor_username: 'alice.admin', actor_role: 'admin', action: 'config.update', resource_type: 'config' as const, resource_id: 'alerts.red_sla_hours', outcome: 'success' as const, severity: 'warning' as const, correlation_id: 'corr-c-115', ip_address: '127.0.0.1', metadata: { previous_value: 4, new_value: 2 }, prev_hash: 'cc33dd44', hash: 'ee55ff66' },
    { event_id: 'aud-msw-005', ts: new Date(NOW - 6 * 3_600_000).toISOString(), tenant_id: 'BANK_DEMO', actor_username: 'system', actor_role: 'system', action: 'alert.created', resource_type: 'alert' as const, resource_id: 'a-1009', outcome: 'success' as const, severity: 'critical' as const, correlation_id: 'corr-c-115', ip_address: null, metadata: { customer_id: 'c-115', class: 'red' }, prev_hash: 'ee55ff66', hash: '77aabb88' },
    { event_id: 'aud-msw-006', ts: new Date(NOW - 8 * 3_600_000).toISOString(), tenant_id: 'BANK_DEMO', actor_username: 'ravi.risk', actor_role: 'risk_analyst', action: 'alert.ack', resource_type: 'alert' as const, resource_id: 'a-1009', outcome: 'success' as const, severity: 'info' as const, correlation_id: 'corr-c-115', ip_address: null, metadata: {}, prev_hash: '77aabb88', hash: '99cc11dd' },
    { event_id: 'aud-msw-007', ts: new Date(NOW - 10 * 3_600_000).toISOString(), tenant_id: 'BANK_DEMO', actor_username: 'alice.admin', actor_role: 'admin', action: 'report.run', resource_type: 'report' as const, resource_id: 'portfolio_snapshot_daily', outcome: 'success' as const, severity: 'info' as const, correlation_id: null, ip_address: null, metadata: { format: 'pdf' }, prev_hash: '99cc11dd', hash: '22ee33ff' },
  ];
}

// ── EWS Rules versions seed (RP-1 + diff-page) ───────────────────────

interface MswEwsRuleVersion {
  version_id: string;
  rule_id: string;
  tenant_id: string;
  semver: string;
  snapshot: Record<string, unknown>;
  created_by: string;
  created_at: string;
  reason: string | null;
}

// Per-test additions live here so a revert in one test doesn't leak
// into another. Reset via __resetMswEwsRuleVersions() in setup.ts.
const __mswEwsRuleRevertedVersions = new Map<string, MswEwsRuleVersion>();
export function __resetMswEwsRuleVersions(): void {
  __mswEwsRuleRevertedVersions.clear();
}

// Static seed: 3 versions per rule_id, sorted descending by semver.
function mswEwsRuleVersions(rule_id: string): MswEwsRuleVersion[] {
  const seed: MswEwsRuleVersion[] = [
    {
      version_id: `${rule_id}-v3`,
      rule_id,
      tenant_id: 'BANK_DEMO',
      semver: '1.2.0',
      snapshot: {
        rule_id,
        name: 'High EMI Bounce Risk',
        description: '3+ EMI bounces in 90 days · refined threshold',
        action: { alert_severity: 'RED', weight: 30 },
      },
      created_by: 'jane.maker',
      created_at: '2026-05-08T10:00:00.000Z',
      reason: 'tightened weight 25→30 after FP review',
    },
    {
      version_id: `${rule_id}-v2`,
      rule_id,
      tenant_id: 'BANK_DEMO',
      semver: '1.1.0',
      snapshot: {
        rule_id,
        name: 'High EMI Bounce Risk',
        description: '3+ EMI bounces in 90 days',
        action: { alert_severity: 'RED', weight: 25 },
      },
      created_by: 'jane.maker',
      created_at: '2026-05-05T14:30:00.000Z',
      reason: 'first activation',
    },
    {
      version_id: `${rule_id}-v1`,
      rule_id,
      tenant_id: 'BANK_DEMO',
      semver: '0.1.0',
      snapshot: {
        rule_id,
        name: 'EMI Bounce Risk (draft)',
        description: 'placeholder',
        action: { alert_severity: 'ORANGE', weight: 15 },
      },
      created_by: 'jane.maker',
      created_at: '2026-05-01T09:00:00.000Z',
      reason: null,
    },
  ];
  // Append any reverts created during the current test session
  const reverted = Array.from(__mswEwsRuleRevertedVersions.values()).filter(
    (v) => v.rule_id === rule_id,
  );
  return [...reverted, ...seed].sort((a, b) => b.semver.localeCompare(a.semver));
}

function mswDiffSnapshots(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Array<{ field: string; before: unknown; after: unknown; kind: 'added' | 'removed' | 'changed' }> {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Array<{
    field: string;
    before: unknown;
    after: unknown;
    kind: 'added' | 'removed' | 'changed';
  }> = [];
  for (const f of fields) {
    if (!(f in a) && f in b) out.push({ field: f, before: undefined, after: b[f], kind: 'added' });
    else if (f in a && !(f in b))
      out.push({ field: f, before: a[f], after: undefined, kind: 'removed' });
    else if (JSON.stringify(a[f]) !== JSON.stringify(b[f]))
      out.push({ field: f, before: a[f], after: b[f], kind: 'changed' });
  }
  return out;
}

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

// ── Cases Report (BAC §3.1.8) — MSW state ─────────────────────────────

interface MswCaseRow {
  case_id: string;
  case_number: string;
  borrower: { id: string | null; name: string | null };
  product: string | null;
  case_category: string | null;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  severity: 'high' | 'medium' | 'low';
  status: string;
  created_at: string;
  age_days: number;
  age_bucket: '0-7d' | '8-30d' | '31-90d' | '90+d';
  sla_target_days: number | null;
  is_breached: boolean;
  assigned_to: string | null;
  assignee_display_name: string | null;
  branch: string | null;
  alert_id: string | null;
  tags: string[];
}

interface MswSavedFilter {
  filter_id: string;
  tenant_id: string;
  owner_id: string;
  report_type: 'cases';
  name: string;
  filters: Record<string, unknown>;
  is_shared: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

const mswSavedFilters = new Map<string, MswSavedFilter>();

export function __resetMswSavedReportFilters(): void {
  mswSavedFilters.clear();
}

function mswBucketFor(ageDays: number): MswCaseRow['age_bucket'] {
  if (ageDays <= 7) return '0-7d';
  if (ageDays <= 30) return '8-30d';
  if (ageDays <= 90) return '31-90d';
  return '90+d';
}

function mswCsvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function mswSortKey(r: MswCaseRow, col: string): string | number {
  if (col === 'age_days') return r.age_days;
  if (col === 'sla_target_days') return r.sla_target_days ?? Number.POSITIVE_INFINITY;
  if (col === 'priority') return r.priority;
  if (col === 'status') return r.status;
  if (col === 'case_number') return r.case_number;
  if (col === 'severity') return r.severity;
  return r.created_at;
}

// ── Analytics — Alert Resolution helpers ───────────────────────────────

interface MswAnalyticsRow {
  alert_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  created_at: string;
  acked_at: string | null;
  closed_at: string | null;
}

function mswPercentile(samples: number[]): {
  n: number;
  p50_sec: number | null;
  p95_sec: number | null;
  mean_sec: number | null;
} {
  if (samples.length === 0) return { n: 0, p50_sec: null, p95_sec: null, mean_sec: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50_sec: Math.round(pick(0.5)),
    p95_sec: Math.round(pick(0.95)),
    mean_sec: Math.round(sum / sorted.length),
  };
}

function mswWeeklyTrend(
  rows: MswAnalyticsRow[],
): { week: string; created: number; acked: number; closed: number }[] {
  const map = new Map<string, { week: string; created: number; acked: number; closed: number }>();
  const isoWeek = (d: Date) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  };
  const bump = (week: string, key: 'created' | 'acked' | 'closed') => {
    const b = map.get(week) ?? { week, created: 0, acked: 0, closed: 0 };
    b[key] += 1;
    map.set(week, b);
  };
  for (const r of rows) {
    bump(isoWeek(new Date(r.created_at)), 'created');
    if (r.acked_at) bump(isoWeek(new Date(r.acked_at)), 'acked');
    if (r.closed_at) bump(isoWeek(new Date(r.closed_at)), 'closed');
  }
  return [...map.values()].sort((a, b) => a.week.localeCompare(b.week));
}

// Stage-migration seed — 300 customers, with deterministic stage rotation
// based on the comparison window so different `compare` values produce
// visibly different upgrade/downgrade counts in the SPA.
function mswStageMigrationSeed(compareDays: number): {
  current: { customer_id: string; stage: 'stage_1' | 'stage_2' | 'stage_3' }[];
  prior: { customer_id: string; stage: 'stage_1' | 'stage_2' | 'stage_3' }[];
} {
  const stages: ('stage_1' | 'stage_2' | 'stage_3')[] = ['stage_1', 'stage_2', 'stage_3'];
  const cur: { customer_id: string; stage: 'stage_1' | 'stage_2' | 'stage_3' }[] = [];
  const prior: { customer_id: string; stage: 'stage_1' | 'stage_2' | 'stage_3' }[] = [];
  for (let i = 0; i < 300; i++) {
    const id = `cust-${i + 1}`;
    const curIdx = (i * 7) % 3;
    // Wider compare window → more rotation between prior + current
    const shift = compareDays >= 30 ? 1 : compareDays >= 7 ? 0 : 0;
    const priorIdx = (curIdx - shift - ((i * 5) % 3 === 0 ? 1 : 0) + 3) % 3;
    cur.push({ customer_id: id, stage: stages[curIdx] });
    if (i % 11 !== 0) prior.push({ customer_id: id, stage: stages[priorIdx] });
    // Skip a few to create "new" customer count > 0
  }
  return { current: cur, prior };
}

// PD-distribution seed — 300 customers with criticality_score values
// pseudo-randomly distributed across [0, 10]. Bell-ish around 4 with a
// long right tail so the histogram looks realistic.
function mswPdDistributionSnapshot(): { customer_id: string; pd_proxy: number }[] {
  const out = [];
  for (let i = 0; i < 300; i++) {
    // Triangular-ish distribution centred near 4, capped to [0, 10]
    const r1 = ((i * 47) % 1000) / 1000;
    const r2 = ((i * 53 + 17) % 1000) / 1000;
    const v = Math.max(0, Math.min(10, (r1 + r2) * 5)); // [0, 10]
    out.push({ customer_id: `cust-${i + 1}`, pd_proxy: Number(v.toFixed(2)) });
  }
  return out;
}
function mswPdDistributionPriorSnapshot(): { customer_id: string; pd_proxy: number }[] {
  // Slightly improved (lower) prior — to show the delta line moving right.
  return mswPdDistributionSnapshot().map((r) => ({
    customer_id: r.customer_id,
    pd_proxy: Math.max(0, r.pd_proxy - 0.5),
  }));
}

// Risk-trend seed — same shape as the alert-resolution seed but adds
// a criticality_score field. 200 rows spanning ~4 weeks.
function mswRiskTrendSeed(): {
  alert_id: string;
  customer_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  criticality_score: number;
  created_at: string;
}[] {
  const sevs: ('critical' | 'high' | 'medium' | 'low')[] = ['critical', 'high', 'medium', 'low'];
  const sevWeight = { critical: 8, high: 5, medium: 3, low: 1 };
  const now = Date.now();
  const out = [];
  for (let i = 0; i < 200; i++) {
    const ageMin = (i * 217) % (28 * 24 * 60);
    const sev = sevs[i % sevs.length];
    out.push({
      alert_id: `a-${i + 1}`,
      customer_id: `cust-${(i % 50) + 1}`,
      severity: sev,
      // criticality_score in [1, 10] — weighted by severity + slight noise
      criticality_score:
        sevWeight[sev] + ((i % 7) - 3) * 0.2,
      created_at: new Date(now - ageMin * 60_000).toISOString(),
    });
  }
  return out;
}

// Deterministic 200-row seed spanning ~4 weeks. Each alert has a
// realistic ack-rate (~70%) + close-rate (~40%) so the funnel + p50/p95
// chart show variation; severity is round-robin so the filter exercises.
function mswAnalyticsSeed(): MswAnalyticsRow[] {
  const sevs: MswAnalyticsRow['severity'][] = ['critical', 'high', 'medium', 'low'];
  const now = Date.now();
  const out: MswAnalyticsRow[] = [];
  for (let i = 0; i < 200; i++) {
    const ageMin = (i * 217) % (28 * 24 * 60); // up to 28 days back, deterministic
    const created = now - ageMin * 60_000;
    // Pseudo-random ack/close decisions
    const r1 = (i * 7 + 3) % 10;          // 0-9 — ack if < 7
    const r2 = (i * 13 + 5) % 10;         // 0-9 — close if < 4
    const ackDelayMin = ((i * 23 + 1) % 360) + 5;          // 5-365 min
    const closeDelayMin = ((i * 31 + 17) % 1440) + 60;     // 1-25h
    const ackedAt = r1 < 7 ? created + ackDelayMin * 60_000 : null;
    const closedAt =
      ackedAt != null && r2 < 4 ? ackedAt + closeDelayMin * 60_000 : null;
    out.push({
      alert_id: `a-${i + 1}`,
      severity: sevs[i % sevs.length],
      created_at: new Date(created).toISOString(),
      acked_at: ackedAt ? new Date(ackedAt).toISOString() : null,
      closed_at: closedAt ? new Date(closedAt).toISOString() : null,
    });
  }
  return out;
}

// 12-row demo set spanning all 4 buckets, breach + non-breach, multiple
// branches/severities/statuses. The SPA never sees the real Pg fixture
// in offline mode, so this is what shows in the grid + powers tests.
function mswCasesDetailRows(): MswCaseRow[] {
  const now = Date.now();
  const ageISO = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const mk = (
    n: number,
    over: Partial<MswCaseRow> & { age: number; target: number | null },
  ): MswCaseRow => {
    const breach =
      over.target != null && over.age > over.target && over.status !== 'CLOSED';
    return {
      case_id: `c-${String(n).padStart(3, '0')}`,
      case_number: `EWS-2026-${String(n).padStart(5, '0')}`,
      borrower: over.borrower ?? { id: `cust-${n}`, name: `Borrower ${n}` },
      product: over.product ?? 'credit_risk',
      case_category: over.case_category ?? over.product ?? 'credit_risk',
      priority: over.priority ?? 'P2',
      severity: over.severity ?? 'medium',
      status: over.status ?? 'OPEN',
      created_at: ageISO(over.age),
      age_days: over.age,
      age_bucket: mswBucketFor(over.age),
      sla_target_days: over.target,
      is_breached: breach,
      assigned_to: over.assigned_to ?? 'sue.super',
      assignee_display_name: over.assignee_display_name ?? 'Sue Wanjiru',
      branch: over.branch ?? 'BR-NRB-01',
      alert_id: over.alert_id ?? `a-${1000 + n}`,
      tags: over.tags ?? [],
    };
  };
  return [
    mk(1,  { age: 1,   target: 1,   priority: 'P1', severity: 'high',   borrower: { id: 'cust-1', name: 'Acme Co' } }),
    mk(2,  { age: 5,   target: 3,   priority: 'P2', severity: 'medium' }),
    mk(3,  { age: 7,   target: 7,   priority: 'P3', severity: 'medium', branch: 'BR-NRB-02' }),
    mk(4,  { age: 10,  target: 3,   priority: 'P2', severity: 'medium', status: 'INVESTIGATING' }),
    mk(5,  { age: 15,  target: 5,   priority: 'P2', severity: 'medium', branch: 'BR-NRB-02' }),
    mk(6,  { age: 28,  target: null, priority: 'P3', severity: 'medium', status: 'ASSIGNED' }),
    mk(7,  { age: 35,  target: 10,  priority: 'P3', severity: 'medium', branch: 'BR-NRB-03' }),
    mk(8,  { age: 50,  target: 0.5, priority: 'P1', severity: 'high',   product: 'fraud' }),
    mk(9,  { age: 75,  target: 14,  priority: 'P4', severity: 'low' }),
    mk(10, { age: 91,  target: 7,   priority: 'P3', severity: 'medium', status: 'PENDING_APPROVAL' }),
    mk(11, { age: 120, target: 10,  priority: 'P3', severity: 'medium', status: 'CLOSED' }),
    mk(12, { age: 200, target: 14,  priority: 'P4', severity: 'low',    branch: 'BR-NRB-03' }),
  ];
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
  family: 'Financial' | 'Behavioural' | 'Transaction' | 'Credit' | 'Fraud';
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

// ── Module 1.5 — Anomaly Detection (AI) — MSW handlers ────────────────
// Mirrors services/bff/src/anomaly_detection.ts. Per-tenant in-memory
// store keyed off `X-Tenant-ID` request header (defaults to BANK_DEMO).
// 12-item baseline per tenant + injected spikes survive across calls.

type _MswAnomaly = {
  anomaly_id: string;
  tenant_id: string;
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';
  source_id: string;
  detected_at: string;
  anomaly_score: number;
  affected_records: number;
  description: string;
  customer_id: string | null;
  metadata: Record<string, unknown>;
  case_id?: string | null;
  status_updates?: Array<{ status: string; actor_username: string; notes: string | null; changed_at: string }>;
  injected?: boolean;
};

const __mswAnomalyStore = new Map<string, Map<string, _MswAnomaly>>();
const __mswAnomalyPatternCfg = new Map<string, Array<{ pattern: string; enabled: boolean; threshold: number }>>();
const __mswAnomalyPatterns = [
  'txn_volume_spike',
  'geo_velocity',
  'channel_shift',
  'amount_outlier',
  'frequency_outlier',
  'schema_drift',
  'pipeline_lag',
  'duplicate_burst',
];
const __mswAnomalySources = ['cbs_loans', 'cbs_repayments', 'cbs_txns', 'mart_customer_360', 'mart_loan_360', 'bureau_score'];

function __mswAnomalySev(score: number): _MswAnomaly['severity'] {
  if (score >= 0.9) return 'critical';
  if (score >= 0.75) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

function __mswAnomalyBaseline(tenant_id: string): Map<string, _MswAnomaly> {
  if (__mswAnomalyStore.has(tenant_id)) return __mswAnomalyStore.get(tenant_id)!;
  const m = new Map<string, _MswAnomaly>();
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    const id = `anm-${tenant_id}-${String(i).padStart(5, '0')}`;
    const score = Math.round((0.45 + (i % 10) * 0.05) * 100) / 100;
    const sev = __mswAnomalySev(score);
    const pattern = __mswAnomalyPatterns[i % __mswAnomalyPatterns.length];
    const source = __mswAnomalySources[i % __mswAnomalySources.length];
    m.set(id, {
      anomaly_id: id,
      tenant_id,
      pattern,
      severity: sev,
      status: 'open',
      source_id: source,
      detected_at: new Date(now - i * 3_600_000).toISOString(),
      anomaly_score: score,
      affected_records: 500 + i * 250,
      description: `Pattern ${pattern} on ${source} (score ${Math.round(score * 100)})`,
      customer_id: i % 3 === 0 ? `c-1000${String(i).padStart(2, '0')}` : null,
      metadata: { seeded: true },
      case_id: null,
      status_updates: [],
      injected: false,
    });
  }
  __mswAnomalyStore.set(tenant_id, m);
  return m;
}

function __mswAnomalyPatternConfig(tenant_id: string): Array<{ pattern: string; enabled: boolean; threshold: number }> {
  if (__mswAnomalyPatternCfg.has(tenant_id)) return __mswAnomalyPatternCfg.get(tenant_id)!;
  const cfg = __mswAnomalyPatterns.map((p) => ({ pattern: p, enabled: true, threshold: 0.7 }));
  __mswAnomalyPatternCfg.set(tenant_id, cfg);
  return cfg;
}

const __mswAnomalyHandlers = [
  http.get('/v1/anomalies', ({ request }) => {
    const url = new URL(request.url);
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const store = __mswAnomalyBaseline(tenant_id);
    const windowParam = url.searchParams.get('window');
    let since: string | undefined;
    if (windowParam) {
      const m = /^(\d+)([hd])$/.exec(windowParam);
      if (m) {
        const ms = m[2] === 'h' ? Number(m[1]) * 3_600_000 : Number(m[1]) * 86_400_000;
        since = new Date(Date.now() - ms).toISOString();
      }
    }
    const pattern = url.searchParams.get('pattern');
    const sev = url.searchParams.get('severity');
    const status = url.searchParams.get('status');
    const source = url.searchParams.get('source_id');
    const minScoreRaw = url.searchParams.get('min_score');
    let minScore: number | undefined;
    if (minScoreRaw) {
      const v = Number(minScoreRaw);
      if (Number.isFinite(v)) minScore = v > 1 ? v / 100 : v;
    }
    const all = Array.from(store.values()).filter((a) => {
      if (pattern && a.pattern !== pattern) return false;
      if (sev && a.severity !== sev) return false;
      if (status && a.status !== status) return false;
      if (source && a.source_id !== source) return false;
      if (minScore !== undefined && a.anomaly_score < minScore) return false;
      if (since && a.detected_at < since) return false;
      return true;
    });
    const sevRank: Record<_MswAnomaly['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
    all.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.anomaly_score - a.anomaly_score);
    const by_severity = { low: 0, medium: 0, high: 0, critical: 0 } as Record<string, number>;
    const by_status: Record<string, number> = { open: 0, acknowledged: 0, investigating: 0, resolved: 0, false_positive: 0 };
    const by_pattern: Record<string, number> = {};
    for (const a of all) {
      by_severity[a.severity] = (by_severity[a.severity] ?? 0) + 1;
      by_status[a.status] = (by_status[a.status] ?? 0) + 1;
      by_pattern[a.pattern] = (by_pattern[a.pattern] ?? 0) + 1;
    }
    return HttpResponse.json(
      envelope({
        tenant_id,
        generated_at: new Date().toISOString(),
        total: all.length,
        by_severity,
        by_pattern,
        by_status,
        anomalies: all,
      }),
    );
  }),

  http.get('/v1/anomalies/patterns/config', ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    return HttpResponse.json(envelope({ tenant_id, patterns: __mswAnomalyPatternConfig(tenant_id) }));
  }),

  http.post('/v1/anomalies/patterns/config', async ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const body = (await request.json()) as { updates?: Array<{ pattern: string; enabled?: boolean; threshold?: number }> };
    if (!body.updates || !Array.isArray(body.updates)) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_400', message: 'updates[] required', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'updates[] required', severity: 'MEDIUM' } },
        { status: 400 },
      );
    }
    const cfg = __mswAnomalyPatternConfig(tenant_id);
    for (const u of body.updates) {
      const r = cfg.find((c) => c.pattern === u.pattern);
      if (!r) continue;
      if (u.enabled !== undefined) r.enabled = u.enabled;
      if (u.threshold !== undefined) r.threshold = u.threshold;
    }
    return HttpResponse.json(envelope({ tenant_id, patterns: cfg }));
  }),

  http.post('/v1/anomalies/rerun', ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    return HttpResponse.json(
      envelope({
        tenant_id,
        run_id: `run-${tenant_id}-${Date.now()}`,
        triggered_by: actor,
        triggered_at: new Date().toISOString(),
        scanned_records: 142_500,
        patterns_evaluated: __mswAnomalyPatterns.length,
        new_anomalies: 3,
        duration_ms: 2400,
      }),
      { status: 201 },
    );
  }),

  http.post('/v1/anomalies/inject-spike', async ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const body = (await request.json().catch(() => ({}))) as { source_id?: string; multiplier?: number; pattern?: string };
    const store = __mswAnomalyBaseline(tenant_id);
    const multiplier = Math.max(2, Math.min(100, body.multiplier ?? 10));
    const score = Math.round(Math.max(0.80, Math.min(0.99, 0.50 + multiplier * 0.035)) * 100) / 100;
    const id = `anm-${tenant_id}-${Date.now()}-spike`;
    const source_id = body.source_id ?? 'cbs_txns';
    const pattern = (body.pattern as string | undefined) ?? 'txn_volume_spike';
    const a: _MswAnomaly = {
      anomaly_id: id,
      tenant_id,
      pattern,
      severity: __mswAnomalySev(score),
      status: 'open',
      source_id,
      detected_at: new Date().toISOString(),
      anomaly_score: score,
      affected_records: 1000 * multiplier,
      description: `Injected ${multiplier}× spike on ${source_id} (score ${Math.round(score * 100)})`,
      customer_id: null,
      metadata: { injected: true, multiplier, injected_by: actor },
      case_id: null,
      status_updates: [{ status: 'open', actor_username: actor, notes: `Injected ${multiplier}× spike`, changed_at: new Date().toISOString() }],
      injected: true,
    };
    store.set(id, a);
    return HttpResponse.json(envelope(a), { status: 201 });
  }),

  http.post('/v1/anomalies/:anomaly_id/investigate', async ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const store = __mswAnomalyBaseline(tenant_id);
    const id = String(params.anomaly_id ?? '');
    const a = store.get(id);
    if (!a) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_404', message: 'not found', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_anomaly', message: `unknown ${id}`, severity: 'MEDIUM' } },
        { status: 404 },
      );
    }
    if (a.status === 'investigating') {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_409', message: 'already investigating', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_409_already_investigating', message: 'already investigating', severity: 'MEDIUM' } },
        { status: 409 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as { case_id?: string; notes?: string };
    const case_id = body.case_id && body.case_id.trim() !== '' ? body.case_id : `case-anom-${id}`;
    a.status = 'investigating';
    a.case_id = case_id;
    a.status_updates = [...(a.status_updates ?? []), { status: 'investigating', actor_username: actor, notes: body.notes ?? null, changed_at: new Date().toISOString() }];
    return HttpResponse.json(envelope(a));
  }),

  http.post('/v1/anomalies/:anomaly_id/dismiss', async ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const store = __mswAnomalyBaseline(tenant_id);
    const id = String(params.anomaly_id ?? '');
    const a = store.get(id);
    if (!a) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_404', message: 'not found', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_anomaly', message: `unknown ${id}`, severity: 'MEDIUM' } },
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    if (!body.reason || !body.reason.trim()) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_400', message: 'reason required', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'reason required', severity: 'MEDIUM' } },
        { status: 400 },
      );
    }
    a.status = 'false_positive';
    a.status_updates = [...(a.status_updates ?? []), { status: 'false_positive', actor_username: actor, notes: body.reason, changed_at: new Date().toISOString() }];
    return HttpResponse.json(envelope(a));
  }),

  http.get('/v1/anomalies/:anomaly_id', ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const store = __mswAnomalyBaseline(tenant_id);
    const id = String(params.anomaly_id ?? '');
    const a = store.get(id);
    if (!a) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_404', message: 'not found', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_anomaly', message: `unknown ${id}`, severity: 'MEDIUM' } },
        { status: 404 },
      );
    }
    // Synthesise a 24-hour time series ending at detected_at.
    const detected = new Date(a.detected_at).getTime();
    const baseline = Math.max(1, Math.round(a.affected_records / (1 + a.anomaly_score * 9)));
    const time_series = Array.from({ length: 24 }, (_, idx) => {
      const h = 23 - idx;
      const ts = new Date(detected - h * 3_600_000).toISOString();
      const isOut = h === 0;
      return { ts, value: isOut ? a.affected_records : Math.round(baseline * (0.9 + (idx % 5) * 0.04)), is_outlier: isOut };
    });
    return HttpResponse.json(envelope({ ...a, time_series, score_100: Math.round(a.anomaly_score * 100) }));
  }),
];

export function __resetMswAnomalyStore() {
  __mswAnomalyStore.clear();
  __mswAnomalyPatternCfg.clear();
}

// Module 1.5 — register the anomaly handlers with the exported `handlers`
// array. Done as a side-effect to avoid the TDZ that would result from
// spreading them inline before their `const __mswAnomalyHandlers = [...]`
// declaration further up the file.
handlers.push(...__mswAnomalyHandlers);

// ── Module 1.6 — Reconciliation MSW handlers ──────────────────────────
type _MswReconDef = {
  recon_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  source_label: string;
  target_label: string;
  kind: string;
  key_field: string;
  amount_field: string | null;
  amount_tolerance: number;
  severity: string;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
};
type _MswReconRun = {
  run_id: string;
  tenant_id: string;
  recon_id: string;
  recon_kind: string;
  recon_severity: string;
  source_label: string;
  target_label: string;
  started_at: string;
  finished_at: string;
  status: string;
  source_count: number;
  target_count: number;
  matched_count: number;
  source_only_count: number;
  target_only_count: number;
  amount_mismatch_count: number;
  source_total: number | null;
  target_total: number | null;
  difference: number | null;
  sample_breaks: Array<{ key: string; kind: string; source_amount: number | null; target_amount: number | null; delta: number | null }>;
  error_message: string | null;
  triggered_by: string;
  accepted_at?: string | null;
  accepted_by?: string | null;
  accepted_reason?: string | null;
};

const __mswReconDefs = new Map<string, Map<string, _MswReconDef>>();
const __mswReconRuns = new Map<string, _MswReconRun[]>();
const __mswReconDrops = new Map<string, Map<string, string[]>>(); // tenant → recon_id → keys

function __mswReconSeed(tenant_id: string): Map<string, _MswReconDef> {
  if (__mswReconDefs.has(tenant_id)) return __mswReconDefs.get(tenant_id)!;
  const m = new Map<string, _MswReconDef>();
  const now = new Date().toISOString();
  const seeds: Array<Partial<_MswReconDef>> = [
    { recon_id: 'rcn_loans_to_staging', name: 'CBS Loans → Staging', source_label: 'cbs.loan_book', target_label: 'staging.loans', kind: 'count_only', key_field: 'loan_id', severity: 'high' },
    { recon_id: 'rcn_staging_to_mart', name: 'Staging Loans → Warehouse', source_label: 'staging.loans', target_label: 'mart.loan_360', kind: 'count_only', key_field: 'loan_id', severity: 'high' },
    { recon_id: 'rcn_txns_amounts', name: 'CBS Txns Amount Match', source_label: 'cbs.txns', target_label: 'mart.txn_features', kind: 'amount_match', key_field: 'txn_id', amount_field: 'amount', severity: 'medium' },
  ];
  for (const s of seeds) {
    const d: _MswReconDef = {
      recon_id: s.recon_id!,
      tenant_id,
      name: s.name!,
      description: null,
      source_label: s.source_label!,
      target_label: s.target_label!,
      kind: s.kind!,
      key_field: s.key_field!,
      amount_field: s.amount_field ?? null,
      amount_tolerance: 0,
      severity: s.severity ?? 'medium',
      active: true,
      created_at: now,
      created_by: 'system',
      updated_at: now,
      updated_by: 'system',
      deleted_at: null,
      deleted_by: null,
    };
    m.set(d.recon_id, d);
  }
  __mswReconDefs.set(tenant_id, m);
  return m;
}

function __mswReconRunsBucket(tenant_id: string): _MswReconRun[] {
  if (!__mswReconRuns.has(tenant_id)) __mswReconRuns.set(tenant_id, []);
  return __mswReconRuns.get(tenant_id)!;
}

function __mswReconDropBucket(tenant_id: string): Map<string, string[]> {
  if (!__mswReconDropsHas(tenant_id)) __mswReconDrops.set(tenant_id, new Map());
  return __mswReconDrops.get(tenant_id)!;
}
function __mswReconDropsHas(tenant_id: string): boolean {
  return __mswReconDrops.has(tenant_id);
}

const __mswReconHandlers = [
  http.get('/v1/recon/definitions', ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const defs = Array.from(__mswReconSeed(tenant_id).values()).filter((d) => !d.deleted_at);
    return HttpResponse.json(envelope({ items: defs, total: defs.length }));
  }),

  http.post('/v1/recon/definitions', async ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const body = (await request.json()) as Partial<_MswReconDef>;
    if (!body.recon_id || !body.name || !body.source_label || !body.target_label || !body.kind || !body.key_field) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_400', message: 'missing fields', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'required field missing', severity: 'MEDIUM' } },
        { status: 400 },
      );
    }
    const store = __mswReconSeed(tenant_id);
    if (store.has(body.recon_id)) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_409', message: 'duplicate', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_409_duplicate_recon_id', message: `duplicate recon_id: ${body.recon_id}`, severity: 'MEDIUM' } },
        { status: 409 },
      );
    }
    const now = new Date().toISOString();
    const d: _MswReconDef = {
      recon_id: body.recon_id,
      tenant_id,
      name: body.name,
      description: body.description ?? null,
      source_label: body.source_label,
      target_label: body.target_label,
      kind: body.kind,
      key_field: body.key_field,
      amount_field: body.amount_field ?? null,
      amount_tolerance: body.amount_tolerance ?? 0,
      severity: body.severity ?? 'medium',
      active: body.active ?? true,
      created_at: now,
      created_by: actor,
      updated_at: now,
      updated_by: actor,
      deleted_at: null,
      deleted_by: null,
    };
    store.set(d.recon_id, d);
    return HttpResponse.json(envelope(d), { status: 201 });
  }),

  http.get('/v1/recon/definitions/:recon_id', ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const id = String(params.recon_id ?? '');
    const d = __mswReconSeed(tenant_id).get(id);
    if (!d || d.deleted_at) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', code: 'EWS_404', message: 'not found', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_recon', message: `unknown ${id}`, severity: 'LOW' } },
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(d));
  }),

  http.patch('/v1/recon/definitions/:recon_id', async ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const id = String(params.recon_id ?? '');
    const d = __mswReconSeed(tenant_id).get(id);
    if (!d) return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_recon', message: 'not found', severity: 'LOW' } }, { status: 404 });
    const patch = (await request.json()) as Partial<_MswReconDef>;
    const next: _MswReconDef = { ...d, ...patch, recon_id: d.recon_id, tenant_id: d.tenant_id, updated_at: new Date().toISOString(), updated_by: actor };
    __mswReconSeed(tenant_id).set(id, next);
    return HttpResponse.json(envelope(next));
  }),

  http.delete('/v1/recon/definitions/:recon_id', ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const id = String(params.recon_id ?? '');
    const d = __mswReconSeed(tenant_id).get(id);
    if (!d) return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_recon', message: 'not found', severity: 'LOW' } }, { status: 404 });
    const now = new Date().toISOString();
    d.deleted_at = now;
    d.deleted_by = actor;
    return HttpResponse.json(envelope(d));
  }),

  http.post('/v1/recon/definitions/:recon_id/run', async ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const id = String(params.recon_id ?? '');
    const d = __mswReconSeed(tenant_id).get(id);
    if (!d || d.deleted_at) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_recon', message: 'not found', severity: 'LOW' } }, { status: 404 });
    }
    const dropped = __mswReconDropBucket(tenant_id).get(id) ?? [];
    const sourceCount = 1000;
    const targetCount = sourceCount - dropped.length;
    const status = dropped.length === 0 ? 'balanced' : 'breaks_found';
    const now = new Date();
    const run: _MswReconRun = {
      run_id: `rcn-msw-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      tenant_id,
      recon_id: id,
      recon_kind: d.kind,
      recon_severity: d.severity,
      source_label: d.source_label,
      target_label: d.target_label,
      started_at: now.toISOString(),
      finished_at: new Date(now.getTime() + 100).toISOString(),
      status,
      source_count: sourceCount,
      target_count: targetCount,
      matched_count: targetCount,
      source_only_count: dropped.length,
      target_only_count: 0,
      amount_mismatch_count: 0,
      source_total: null,
      target_total: null,
      difference: null,
      sample_breaks: dropped.map((k) => ({ key: k, kind: 'source_only', source_amount: null, target_amount: null, delta: null })),
      error_message: null,
      triggered_by: actor,
      accepted_at: null,
      accepted_by: null,
      accepted_reason: null,
    };
    __mswReconRunsBucket(tenant_id).unshift(run);
    return HttpResponse.json(envelope(run));
  }),

  http.get('/v1/recon/runs', ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const url = new URL(request.url);
    const recon_id = url.searchParams.get('recon_id');
    const status = url.searchParams.get('status');
    let runs = __mswReconRunsBucket(tenant_id);
    if (recon_id) runs = runs.filter((r) => r.recon_id === recon_id);
    if (status) runs = runs.filter((r) => r.status === status);
    return HttpResponse.json(envelope({ tenant_id, generated_at: new Date().toISOString(), total: runs.length, items: runs }));
  }),

  http.get('/v1/recon/runs/:run_id', ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const id = String(params.run_id ?? '');
    const r = __mswReconRunsBucket(tenant_id).find((x) => x.run_id === id);
    if (!r) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_run', message: `unknown ${id}`, severity: 'LOW' } }, { status: 404 });
    }
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/recon/runs/:run_id/accept', async ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const id = String(params.run_id ?? '');
    const r = __mswReconRunsBucket(tenant_id).find((x) => x.run_id === id);
    if (!r) return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_run', message: 'not found', severity: 'LOW' } }, { status: 404 });
    const body = (await request.json()) as { reason?: string };
    if (!body.reason || !body.reason.trim()) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_400', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_reason', message: 'reason required', severity: 'MEDIUM' } }, { status: 400 });
    }
    if (r.accepted_at) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_409', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_409_already_accepted', message: 'already accepted', severity: 'MEDIUM' } }, { status: 409 });
    }
    r.accepted_at = new Date().toISOString();
    r.accepted_by = actor;
    r.accepted_reason = body.reason;
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/recon/definitions/:recon_id/inject-drop', async ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const id = String(params.recon_id ?? '');
    const d = __mswReconSeed(tenant_id).get(id);
    if (!d) return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_recon', message: 'not found', severity: 'LOW' } }, { status: 404 });
    const body = (await request.json()) as { row_key?: string; leg?: string };
    if (!body.row_key || !body.row_key.trim()) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_400', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'row_key required', severity: 'MEDIUM' } }, { status: 400 });
    }
    const drops = __mswReconDropBucket(tenant_id);
    const list = drops.get(id) ?? [];
    if (!list.includes(body.row_key)) list.push(body.row_key);
    drops.set(id, list);
    return HttpResponse.json(envelope({ recon_id: id, tenant_id, row_key: body.row_key, leg: body.leg ?? 'staging', staging_dropped: list, warehouse_dropped: [], registered_at: new Date().toISOString(), registered_by: actor }), { status: 201 });
  }),

  http.get('/v1/recon/dashboard', ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const defs = Array.from(__mswReconSeed(tenant_id).values()).filter((d) => !d.deleted_at);
    const runs = __mswReconRunsBucket(tenant_id);
    const total_breaks_24h = runs.filter((r) => r.status === 'breaks_found').length;
    return HttpResponse.json(envelope({
      tenant_id,
      generated_at: new Date().toISOString(),
      total_definitions: defs.length,
      active_definitions: defs.filter((d) => d.active).length,
      total_runs: runs.length,
      total_balanced: runs.filter((r) => r.status === 'balanced').length,
      total_breaks_found: runs.filter((r) => r.status === 'breaks_found').length,
      total_error: runs.filter((r) => r.status === 'error').length,
      total_breaks_24h,
      by_severity: { high: { definitions: 0, runs: 0, breaks_24h: 0 }, medium: { definitions: 0, runs: 0, breaks_24h: 0 }, low: { definitions: 0, runs: 0, breaks_24h: 0 } },
      by_kind: { count_only: { definitions: 0, runs: 0 }, amount_match: { definitions: 0, runs: 0 }, set_diff: { definitions: 0, runs: 0 } },
      definitions_status: defs.map((d) => ({
        recon_id: d.recon_id, name: d.name, kind: d.kind, severity: d.severity,
        latest_status: runs.find((r) => r.recon_id === d.recon_id)?.status ?? null,
        latest_breaks: runs.find((r) => r.recon_id === d.recon_id)?.source_only_count ?? null,
        latest_difference: null,
        latest_at: runs.find((r) => r.recon_id === d.recon_id)?.finished_at ?? null,
        runs_total: runs.filter((r) => r.recon_id === d.recon_id).length,
        breaks_24h: runs.filter((r) => r.recon_id === d.recon_id && r.status === 'breaks_found').length,
      })),
    }));
  }),
];

handlers.push(...__mswReconHandlers);

export function __resetMswReconStore() {
  __mswReconDefs.clear();
  __mswReconRuns.clear();
  __mswReconDrops.clear();
}

// ── Module 1.7 — Data Quality Score MSW handlers ──────────────────────
const __mswDqWeights = new Map<string, Record<string, number>>(); // tenant → weights
const __mswDqDefaultWeights: Record<string, number> = {
  completeness: 0.30, validity: 0.30, consistency: 0.15, uniqueness: 0.15, timeliness: 0.10,
};
const __mswDqSources = ['cbs_loans', 'cbs_repayments', 'cbs_txns', 'mart_customer_360', 'mart_loan_360', 'bureau_score'];
const __mswDqDimensions = ['completeness', 'validity', 'consistency', 'uniqueness', 'timeliness'] as const;
const __mswDqAttrsBySource: Record<string, Array<{ name: string; format?: string | null }>> = {
  cbs_loans: [
    { name: 'loan_id' }, { name: 'customer_id', format: 'numeric_id' }, { name: 'product_code' },
    { name: 'sanctioned_amount' }, { name: 'outstanding' }, { name: 'worst_dpd' },
    { name: 'onboarded_at', format: 'iso_date' }, { name: 'has_npa' },
  ],
  cbs_repayments: [{ name: 'repayment_id' }, { name: 'loan_id' }, { name: 'paid_at', format: 'iso_date' }, { name: 'amount' }, { name: 'dpd_at_payment' }],
  cbs_txns: [{ name: 'txn_id' }, { name: 'account_id' }, { name: 'txn_at', format: 'iso_datetime' }, { name: 'amount' }, { name: 'channel' }],
  mart_customer_360: [{ name: 'customer_id' }, { name: 'pan', format: 'pan' }, { name: 'phone', format: 'phone_in' }, { name: 'email', format: 'email' }, { name: 'risk_rating' }, { name: 'monthly_income' }],
  mart_loan_360: [{ name: 'loan_id' }, { name: 'customer_id' }, { name: 'product_code' }, { name: 'outstanding' }, { name: 'worst_dpd' }, { name: 'has_npa' }],
  bureau_score: [{ name: 'customer_id' }, { name: 'score' }, { name: 'reported_at', format: 'iso_date' }],
};

function __mswDqHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function __mswDqRng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
function __mswDqBaseline(source: string): { center: number; spread: number } {
  if (source.startsWith('mart_')) return { center: 93, spread: 6 };
  if (source.startsWith('cbs_')) return { center: 88, spread: 8 };
  return { center: 80, spread: 10 };
}
function __mswDqScoreInBand(rng: () => number, source: string): number {
  const { center, spread } = __mswDqBaseline(source);
  const raw = center + (rng() - 0.5) * 2 * spread;
  return Math.round(Math.max(60, Math.min(99, raw)) * 10) / 10;
}
function __mswDqCompose(scores: Record<string, number>, weights: Record<string, number>): number {
  let sum = 0, w = 0;
  for (const d of __mswDqDimensions) {
    const ww = Math.max(0, weights[d] ?? 0);
    if (ww === 0) continue;
    sum += (scores[d] ?? 0) * ww;
    w += ww;
  }
  if (w === 0) return 0;
  return Math.round((sum / w) * 10) / 10;
}
function __mswDqGetWeights(tenant_id: string): Record<string, number> {
  return __mswDqWeights.get(tenant_id) ?? __mswDqDefaultWeights;
}
function __mswDqSourceScore(tenant_id: string, source: string, weights: Record<string, number>, day: string) {
  const raw: Record<string, { score: number; samples: number }> = {};
  for (const d of __mswDqDimensions) {
    const rng = __mswDqRng(__mswDqHash(`${tenant_id}|${source}|${d}|${day}`));
    raw[d] = { score: __mswDqScoreInBand(rng, source), samples: Math.round(10000 + rng() * 90000) };
  }
  const scoresOnly: Record<string, number> = {};
  for (const d of __mswDqDimensions) scoresOnly[d] = raw[d].score;
  return {
    source_id: source,
    composite_score: __mswDqCompose(scoresOnly, weights),
    dimensions: __mswDqDimensions.map((d) => ({ dimension: d, score: raw[d].score, weight: weights[d], samples: raw[d].samples })),
    attributes: (__mswDqAttrsBySource[source] ?? []).length,
    last_evaluated_at: new Date().toISOString(),
    rows_evaluated: __mswDqDimensions.reduce((acc, d) => acc + raw[d].samples, 0),
  };
}

const __mswDqHandlers = [
  http.get('/v1/dq/dashboard', ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const weights = __mswDqGetWeights(tenant_id);
    const day = new Date().toISOString().slice(0, 10);
    const by_source = __mswDqSources.map((s) => __mswDqSourceScore(tenant_id, s, weights, day));
    let wSum = 0, weighted = 0;
    for (const s of by_source) { wSum += s.attributes; weighted += s.composite_score * s.attributes; }
    const fleet = wSum === 0 ? 0 : Math.round((weighted / wSum) * 10) / 10;
    let worst: { source_id: string; composite_score: number } | null = null;
    let best: { source_id: string; composite_score: number } | null = null;
    for (const s of by_source) {
      if (!worst || s.composite_score < worst.composite_score) worst = { source_id: s.source_id, composite_score: s.composite_score };
      if (!best || s.composite_score > best.composite_score) best = { source_id: s.source_id, composite_score: s.composite_score };
    }
    return HttpResponse.json(envelope({
      tenant_id,
      generated_at: new Date().toISOString(),
      total_rules: 12,
      active_rules: 10,
      total_executions: 250,
      total_passed: 234,
      total_failed: 14,
      total_error: 2,
      rules_status: [],
      score_overlay: {
        tenant_id,
        generated_at: new Date().toISOString(),
        weights,
        by_source,
        fleet_composite_score: fleet,
        worst_source: worst,
        best_source: best,
      },
    }));
  }),

  http.get('/v1/dq/by-source/:source_id', ({ request, params }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const source = String(params.source_id ?? '');
    if (!__mswDqSources.includes(source)) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_source', message: `unknown source: ${source}`, severity: 'LOW' } }, { status: 404 });
    }
    const url = new URL(request.url);
    const windowParam = url.searchParams.get('window');
    const window = windowParam ? Number(windowParam) : 30;
    if (windowParam !== null && (!Number.isFinite(window) || window < 1 || window > 90)) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_400', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_window', message: 'window must be in [1, 90]', severity: 'MEDIUM' } }, { status: 400 });
    }
    const weights = __mswDqGetWeights(tenant_id);
    const today = new Date();
    const day = today.toISOString().slice(0, 10);
    const score = __mswDqSourceScore(tenant_id, source, weights, day);
    const days = Math.max(1, Math.min(90, Math.floor(window)));
    const start = new Date(today.getTime() - (days - 1) * 86_400_000);
    const trend = Array.from({ length: days }, (_, i) => {
      const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const raw: Record<string, { score: number; samples: number }> = {};
      for (const dim of __mswDqDimensions) {
        const rng = __mswDqRng(__mswDqHash(`${tenant_id}|${source}|${dim}|${d}`));
        raw[dim] = { score: __mswDqScoreInBand(rng, source), samples: 0 };
      }
      const dimsOnly: Record<string, number> = {};
      for (const dim of __mswDqDimensions) dimsOnly[dim] = raw[dim].score;
      return { date: d, composite_score: __mswDqCompose(dimsOnly, weights), dimensions: dimsOnly };
    });
    return HttpResponse.json(envelope({
      tenant_id,
      generated_at: today.toISOString(),
      weights,
      score,
      trend: { source_id: source, window_days: days, trend, start_date: start.toISOString().slice(0, 10), end_date: today.toISOString().slice(0, 10) },
    }));
  }),

  http.get('/v1/dq/by-attribute', ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const url = new URL(request.url);
    const source = url.searchParams.get('source_id') ?? '';
    const attribute = url.searchParams.get('attribute');
    if (!source) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_400', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'source_id required', severity: 'MEDIUM' } }, { status: 400 });
    }
    if (!__mswDqSources.includes(source)) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_source', message: `unknown source: ${source}`, severity: 'LOW' } }, { status: 404 });
    }
    const weights = __mswDqGetWeights(tenant_id);
    const day = new Date().toISOString().slice(0, 10);
    const attrs = __mswDqAttrsBySource[source] ?? [];
    const items = attrs.map((a) => {
      const raw: Record<string, { score: number; samples: number }> = {};
      for (const dim of __mswDqDimensions) {
        const rng = __mswDqRng(__mswDqHash(`${tenant_id}|${source}|${a.name}|${dim}|${day}`));
        raw[dim] = { score: __mswDqScoreInBand(rng, source), samples: Math.round(1000 + rng() * 9000) };
      }
      const dimsOnly: Record<string, number> = {};
      for (const dim of __mswDqDimensions) dimsOnly[dim] = raw[dim].score;
      return {
        source_id: source,
        attribute: a.name,
        composite_score: __mswDqCompose(dimsOnly, weights),
        dimensions: __mswDqDimensions.map((d) => ({ dimension: d, score: raw[d].score, weight: weights[d], samples: raw[d].samples })),
        last_evaluated_at: new Date().toISOString(),
        format_detected: a.format ?? null,
      };
    });
    const filtered = attribute ? items.filter((i) => i.attribute === attribute) : items;
    if (attribute && filtered.length === 0) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_attribute', message: `unknown attribute: ${attribute}`, severity: 'LOW' } }, { status: 404 });
    }
    return HttpResponse.json(envelope({
      tenant_id, source_id: source, attribute: attribute ?? null,
      generated_at: new Date().toISOString(), weights, total: filtered.length, items: filtered,
    }));
  }),

  http.get('/v1/dq/executions', ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const now = new Date();
    const items = Array.from({ length: 6 }, (_, i) => ({
      execution_id: `exec-${tenant_id}-${String(i).padStart(4, '0')}`,
      rule_id: `dq-rule-${(i % 3) + 1}`,
      rule_name: `Rule ${(i % 3) + 1}`,
      rule_kind: ['not_null', 'unique', 'range'][i % 3],
      rule_severity: ['high', 'medium', 'low'][i % 3],
      started_at: new Date(now.getTime() - i * 3_600_000).toISOString(),
      finished_at: new Date(now.getTime() - i * 3_600_000 + 1000).toISOString(),
      status: i % 4 === 0 ? 'failed' : 'passed',
      total_records: 10000,
      passed_records: i % 4 === 0 ? 9500 : 10000,
      failed_records: i % 4 === 0 ? 500 : 0,
      triggered_by: 'system',
    }));
    return HttpResponse.json(envelope({ tenant_id, generated_at: now.toISOString(), total: items.length, items }));
  }),
];

handlers.push(...__mswDqHandlers);

export function __resetMswDqWeights() {
  __mswDqWeights.clear();
}

// ── Module 2.1 — Borrower Watch MSW handlers ──────────────────────────
type _MswBorrower = {
  borrower_id: string;
  name: string;
  sector: string;
  segment: string;
  region: string;
  exposure_inr: number;
  pd: number;
  ews_score: number;
  severity: 'S1' | 'S2' | 'S3';
  top_signal: string;
  last_alert_at: string | null;
  watchlist_tag: string | null;
  dpd: number;
};

const __mswBwSectors = ['manufacturing', 'services', 'retail', 'agriculture', 'real_estate', 'msme', 'corporate', 'consumer'];
const __mswBwSegments = ['retail', 'sme', 'corporate', 'priority_sector'];
const __mswBwRegions = ['north', 'south', 'east', 'west', 'central', 'northeast'];
const __mswBwSignals = [
  'DPD 30+ in last 60 days', 'EMI bounce streak (3 of last 5)', 'Account dormancy detected',
  'Bureau score dropped 50+ pts', 'Utilisation crossed 95%', 'Geographic risk flag',
  'High-velocity withdrawals', 'Sector exposure concentration', 'Repeat overdraft requests',
  'Salary credit ceased',
];
const __mswBwFirstNames = ['Aarav', 'Ananya', 'Vikram', 'Priya', 'Rohan', 'Meera', 'Karan', 'Neha'];
const __mswBwLastNames = ['Sharma', 'Patel', 'Reddy', 'Kumar', 'Iyer', 'Banerjee', 'Singh', 'Mehta'];

function __mswBwHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function __mswBwRng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function __mswBwSeverity(score: number): 'S1' | 'S2' | 'S3' {
  if (score >= 75) return 'S1';
  if (score >= 50) return 'S2';
  return 'S3';
}

const __mswBwBaseline: _MswBorrower[] = (() => {
  // 30 deterministic borrowers — same seed each render so SPA tests are stable.
  const out: _MswBorrower[] = [];
  for (let i = 0; i < 30; i++) {
    const id = `c-${String(100 + i)}`;
    const rng = __mswBwRng(__mswBwHash(`BANK_DEMO|${id}|borrower_watch`));
    const pd = Math.round(rng() * 100) / 100;
    const dpd = Math.floor(rng() * 180);
    const ews = Math.round((Math.max(0, Math.min(1, pd)) * 70 + Math.min(180, dpd) / 180 * 30) * 10) / 10;
    out.push({
      borrower_id: id,
      name: `${__mswBwFirstNames[Math.floor(rng() * __mswBwFirstNames.length)]} ${__mswBwLastNames[Math.floor(rng() * __mswBwLastNames.length)]}`,
      sector: __mswBwSectors[Math.floor(rng() * __mswBwSectors.length)],
      segment: __mswBwSegments[Math.floor(rng() * __mswBwSegments.length)],
      region: __mswBwRegions[Math.floor(rng() * __mswBwRegions.length)],
      exposure_inr: Math.round((500_000 + rng() * 4_500_000) / 1000) * 1000,
      pd,
      ews_score: ews,
      severity: __mswBwSeverity(ews),
      top_signal: __mswBwSignals[Math.floor(rng() * __mswBwSignals.length)],
      last_alert_at: rng() < 0.3 ? null : new Date(Date.now() - Math.floor(rng() * 60 * 86_400_000)).toISOString(),
      watchlist_tag: null,
      dpd,
    });
  }
  return out;
})();

const __mswBwHandlers = [
  http.get('/v1/customers', ({ request }) => {
    const url = new URL(request.url);
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const mode = (url.searchParams.get('mode') === 'all' ? 'all' : 'stressed') as 'all' | 'stressed';
    let items = [...__mswBwBaseline];

    // Defensive validation — mirror BFF 400 envelopes.
    const sector = url.searchParams.get('sector');
    const segment = url.searchParams.get('segment');
    const region = url.searchParams.get('region');
    const severity = url.searchParams.get('severity');
    const search = url.searchParams.get('search');
    const watchlist_only = url.searchParams.get('watchlist_only') === 'true';
    const minEws = url.searchParams.get('min_ews');
    const maxEws = url.searchParams.get('max_ews');
    const sortKey = url.searchParams.get('sort') ?? 'ews_score';
    const order = url.searchParams.get('order') ?? 'desc';

    if (sector && !__mswBwSectors.includes(sector)) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_400', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_sector', message: `unknown ${sector}`, severity: 'MEDIUM' } }, { status: 400 });
    }
    if (severity && !['S1', 'S2', 'S3'].includes(severity)) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_400', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_severity', message: `unknown ${severity}`, severity: 'MEDIUM' } }, { status: 400 });
    }

    const total_unfiltered = items.length;
    if (mode === 'stressed') items = items.filter((r) => r.severity === 'S1' || r.severity === 'S2');
    if (sector) items = items.filter((r) => r.sector === sector);
    if (segment) items = items.filter((r) => r.segment === segment);
    if (region) items = items.filter((r) => r.region === region);
    if (severity) items = items.filter((r) => r.severity === severity);
    if (watchlist_only) items = items.filter((r) => r.watchlist_tag !== null);
    if (minEws) {
      const lo = Number(minEws);
      if (Number.isFinite(lo)) items = items.filter((r) => r.ews_score >= lo);
    }
    if (maxEws) {
      const hi = Number(maxEws);
      if (Number.isFinite(hi)) items = items.filter((r) => r.ews_score <= hi);
    }
    if (search) {
      const q = search.toLowerCase();
      items = items.filter((r) => r.borrower_id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    }
    // Server-side sort.
    const mul = order === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      const ak = (a as Record<string, unknown>)[sortKey];
      const bk = (b as Record<string, unknown>)[sortKey];
      if (typeof ak === 'number' && typeof bk === 'number') return (ak - bk) * mul;
      if (typeof ak === 'string' && typeof bk === 'string') return ak.localeCompare(bk) * mul;
      return 0;
    });
    const by_severity: Record<string, number> = { S1: 0, S2: 0, S3: 0 };
    const by_sector: Record<string, number> = {};
    for (const r of items) {
      by_severity[r.severity]++;
      by_sector[r.sector] = (by_sector[r.sector] ?? 0) + 1;
    }
    return HttpResponse.json(envelope({
      tenant_id,
      generated_at: new Date().toISOString(),
      mode,
      total: items.length,
      total_unfiltered,
      sort: { key: sortKey, order },
      by_severity,
      by_sector,
      items,
    }));
  }),

  http.post('/v1/banking/cohort/cma-pack', async ({ request }) => {
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const actor = request.headers.get('x-apex-user') ?? 'admin';
    const body = (await request.json()) as { cohort_ids?: string[] };
    const cohortIds = (body.cohort_ids ?? []).filter((x) => typeof x === 'string');
    if (cohortIds.length === 0) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_400', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'cohort_ids required', severity: 'MEDIUM' } }, { status: 400 });
    }
    const unique = Array.from(new Set(cohortIds));
    const rowsById = new Map(__mswBwBaseline.map((r) => [r.borrower_id, r]));
    const missing = unique.filter((id) => !rowsById.has(id));
    if (missing.length > 0) {
      return HttpResponse.json({ header: { status: 'FAILURE', code: 'EWS_404', message: '', requestId: 'msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_borrower', message: `unknown: ${missing.slice(0, 3).join(', ')}`, severity: 'MEDIUM' } }, { status: 404 });
    }
    const found = unique.map((id) => rowsById.get(id)!);
    let exposureSum = 0, ewsSum = 0;
    const by_severity: Record<string, number> = { S1: 0, S2: 0, S3: 0 };
    const by_sector: Record<string, number> = {};
    for (const r of found) {
      exposureSum += r.exposure_inr;
      ewsSum += r.ews_score;
      by_severity[r.severity]++;
      by_sector[r.sector] = (by_sector[r.sector] ?? 0) + 1;
    }
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return HttpResponse.json(envelope({
      pack_id: `cma-${tenant_id}-${day}-msw`,
      tenant_id,
      generated_at: new Date().toISOString(),
      generated_by: actor,
      cohort_size: found.length,
      borrowers: found.map((r) => ({ borrower_id: r.borrower_id, name: r.name, sector: r.sector, exposure_inr: r.exposure_inr, ews_score: r.ews_score, severity: r.severity })),
      totals: {
        exposure_inr: exposureSum,
        mean_ews_score: Math.round((ewsSum / found.length) * 10) / 10,
        by_severity,
        by_sector,
      },
      download_filename: `cma-pack-${tenant_id}-${day}.xlsx`,
    }), { status: 201 });
  }),
];

handlers.push(...__mswBwHandlers);

// ── M2.2 — Account Behaviour ────────────────────────────────────────
//
// In-memory dev fixtures. Mirror the BFF deterministic synth at a small
// scale (6 fake signals on 4 customers) — enough for the SPA page tests +
// the dev-mode interactions. Real BFF is wired via vite proxy.

const __mswAbSignals: Array<{
  signal_id: string;
  account_id: string;
  customer_id: string;
  customer_name: string;
  signal_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  score: number;
  observed_at: string;
  description: string;
  is_watchlisted: boolean;
  status: 'new' | 'reviewed' | 'dismissed';
  reviewed_by: string | null;
  reviewed_at: string | null;
}> = [
  { signal_id: 'sig-BANK_DEMO-c-101-0-2026-05-24', account_id: 'a-101-00', customer_id: 'c-101', customer_name: 'Alice Patel', signal_type: 'cash_flow_drop_mom', severity: 'critical', score: 0.92, observed_at: '2026-05-23T08:12:00.000Z', description: 'Net cash-flow dropped 38% MoM vs trailing 6-month mean (score 92).', is_watchlisted: true, status: 'new', reviewed_by: null, reviewed_at: null },
  { signal_id: 'sig-BANK_DEMO-c-101-1-2026-05-24', account_id: 'a-101-01', customer_id: 'c-101', customer_name: 'Alice Patel', signal_type: 'salary_disappeared', severity: 'high', score: 0.78, observed_at: '2026-05-22T11:30:00.000Z', description: 'Salary credit missing for 2 consecutive months (anomaly score 78).', is_watchlisted: true, status: 'new', reviewed_by: null, reviewed_at: null },
  { signal_id: 'sig-BANK_DEMO-c-106-0-2026-05-24', account_id: 'a-106-00', customer_id: 'c-106', customer_name: 'Rajesh Kumar', signal_type: 'large_unusual_debit', severity: 'high', score: 0.74, observed_at: '2026-05-23T14:45:00.000Z', description: 'Single debit 6.1× 90-day average outflow (score 74).', is_watchlisted: false, status: 'new', reviewed_by: null, reviewed_at: null },
  { signal_id: 'sig-BANK_DEMO-c-115-0-2026-05-24', account_id: 'a-115-00', customer_id: 'c-115', customer_name: 'Priya Sharma', signal_type: 'od_frequency_high', severity: 'medium', score: 0.61, observed_at: '2026-05-23T09:15:00.000Z', description: 'Overdraft frequency 4.3σ above 90-day baseline (score 61).', is_watchlisted: true, status: 'new', reviewed_by: null, reviewed_at: null },
  { signal_id: 'sig-BANK_DEMO-c-115-1-2026-05-24', account_id: 'a-115-01', customer_id: 'c-115', customer_name: 'Priya Sharma', signal_type: 'eod_balance_trend_negative', severity: 'medium', score: 0.55, observed_at: '2026-05-22T16:00:00.000Z', description: 'EOD balance trending -22% over rolling 30d window (score 55).', is_watchlisted: true, status: 'new', reviewed_by: null, reviewed_at: null },
  { signal_id: 'sig-BANK_DEMO-c-118-0-2026-05-24', account_id: 'a-118-00', customer_id: 'c-118', customer_name: 'Mohan Singh', signal_type: 'cheque_bounce_repeated', severity: 'low', score: 0.42, observed_at: '2026-05-21T10:20:00.000Z', description: 'Cheque return ratio 12% over 60 days (score 42).', is_watchlisted: false, status: 'new', reviewed_by: null, reviewed_at: null },
];

const __mswAbBlockReqs: Array<{ request_id: string; account_id: string; status: 'pending' | 'approved' | 'rejected'; requested_by: string; reason: string }> = [];
let __mswAbBlockSeq = 0;

function __mswAbWrap(body: unknown, status = 200) {
  return HttpResponse.json(
    {
      header: { status: 'success', code: status === 201 ? 'EWS_201' : 'EWS_200', message: 'ok', requestId: `req-msw-${Date.now()}`, timestamp: new Date().toISOString() },
      body,
    },
    { status },
  );
}

const __mswAbHandlers = [
  http.get('/v1/banking/accounts/signals', ({ request }) => {
    const u = new URL(request.url);
    const customer_id = u.searchParams.get('customer_id');
    const watchlist_only = u.searchParams.get('watchlist_only') === 'true';
    const status = u.searchParams.get('status') as 'new' | 'reviewed' | 'dismissed' | null;
    let filtered = __mswAbSignals.slice();
    if (customer_id) filtered = filtered.filter((s) => s.customer_id === customer_id);
    if (watchlist_only) filtered = filtered.filter((s) => s.is_watchlisted);
    if (status) filtered = filtered.filter((s) => s.status === status);
    const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    filtered.sort((a, b) => (sevRank[a.severity] - sevRank[b.severity]) || (b.score - a.score));
    const bySev = { low: 0, medium: 0, high: 0, critical: 0 };
    const byStatus = { new: 0, reviewed: 0, dismissed: 0 };
    const byType: Record<string, number> = {};
    for (const s of filtered) {
      bySev[s.severity]++;
      byStatus[s.status]++;
      byType[s.signal_type] = (byType[s.signal_type] ?? 0) + 1;
    }
    return __mswAbWrap({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      customer_id: customer_id ?? null,
      watchlist_only,
      status_filter: status,
      total: filtered.length,
      by_severity: bySev,
      by_status: byStatus,
      by_type: byType,
      signals: filtered,
    });
  }),

  http.get('/v1/banking/accounts/:account_id/patterns', ({ params }) => {
    const account_id = String(params.account_id);
    const m = account_id.match(/^a-(\d+)-\d+$/);
    const customer_id = m ? `c-${m[1]}` : 'c-unknown';
    const series = (mult: number, base: number) => Array.from({ length: 12 }, (_, i) => ({
      date: new Date(Date.now() - (11 - i) * 30 * 86_400_000).toISOString().slice(0, 10),
      value: Math.round(base * mult * (0.85 + (i / 11) * 0.4)),
    }));
    return __mswAbWrap({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      account_id,
      customer_id,
      patterns: [
        { pattern_type: 'monthly_balance', label: 'Monthly average balance (₹)', series: series(1, 150000), anomaly_score: 0.42 },
        { pattern_type: 'channel_mix', label: 'Mobile channel usage (% txns)', series: series(0.001, 700), anomaly_score: 0.18 },
        { pattern_type: 'txn_velocity', label: 'Daily transaction count', series: series(0.01, 1200), anomaly_score: 0.55 },
        { pattern_type: 'cheque_returns', label: 'Cheque returns per 30 days', series: series(0.0005, 6000), anomaly_score: 0.31 },
      ],
    });
  }),

  http.get('/v1/banking/accounts/:account_id/transactions', ({ params, request }) => {
    const account_id = String(params.account_id);
    const u = new URL(request.url);
    const page = Number(u.searchParams.get('page') ?? '1');
    const page_size = Number(u.searchParams.get('page_size') ?? '50');
    const entries = Array.from({ length: Math.min(page_size, 24) }, (_, i) => {
      const days = i + 1;
      const debit = i % 3 === 0;
      return {
        entry_id: `le-${account_id}-${String(i).padStart(4, '0')}`,
        account_id,
        type: (debit ? 'debit' : 'credit') as 'debit' | 'credit',
        amount_kes: debit ? 12_500 + i * 1100 : 45_000 - i * 350,
        currency: 'INR',
        narrative: debit ? `UPI debit txn #${i}` : `Salary/Credit txn #${i}`,
        posted_at: new Date(Date.now() - days * 86_400_000).toISOString(),
        balance_kes_after: 250_000 - i * 1200,
      };
    });
    return __mswAbWrap({
      tenant_id: 'BANK_DEMO',
      account_id,
      total: 24,
      page,
      page_size,
      items: entries,
    });
  }),

  http.post('/v1/banking/accounts/signals/:signal_id/dismiss', ({ params }) => {
    const id = String(params.signal_id);
    const sig = __mswAbSignals.find((s) => s.signal_id === id);
    if (!sig) {
      return HttpResponse.json(
        { header: { status: 'error', code: 'EWS_404_unknown_signal', message: 'signal not found', requestId: 'req-msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_signal', message: 'signal not found', severity: 'LOW' } },
        { status: 404 },
      );
    }
    sig.status = 'dismissed';
    sig.reviewed_by = 'admin';
    sig.reviewed_at = new Date().toISOString();
    return __mswAbWrap({ signal_id: id, tenant_id: 'BANK_DEMO', status: 'dismissed', reviewed_by: 'admin', reviewed_at: sig.reviewed_at });
  }),

  http.post('/v1/banking/accounts/signals/:signal_id/review', ({ params }) => {
    const id = String(params.signal_id);
    const sig = __mswAbSignals.find((s) => s.signal_id === id);
    if (!sig) {
      return HttpResponse.json(
        { header: { status: 'error', code: 'EWS_404_unknown_signal', message: 'signal not found', requestId: 'req-msw', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_signal', message: 'signal not found', severity: 'LOW' } },
        { status: 404 },
      );
    }
    sig.status = 'reviewed';
    sig.reviewed_by = 'admin';
    sig.reviewed_at = new Date().toISOString();
    return __mswAbWrap({ signal_id: id, tenant_id: 'BANK_DEMO', status: 'reviewed', reviewed_by: 'admin', reviewed_at: sig.reviewed_at });
  }),

  http.post('/v1/banking/accounts/:account_id/block', async ({ params, request }) => {
    const account_id = String(params.account_id);
    const body = (await request.json()) as { reason?: string; request_id?: string; decision?: 'approve' | 'reject' };
    if (body.request_id && body.decision) {
      const req = __mswAbBlockReqs.find((r) => r.request_id === body.request_id);
      if (!req) return HttpResponse.json({ error: { code: 'EWS_404_unknown_request' } }, { status: 404 });
      req.status = body.decision === 'approve' ? 'approved' : 'rejected';
      return __mswAbWrap({ ...req, reviewed_by: 'admin', reviewed_at: new Date().toISOString() });
    }
    __mswAbBlockSeq++;
    const entry = {
      request_id: `blk-BANK_DEMO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(__mswAbBlockSeq).padStart(4, '0')}`,
      account_id,
      status: 'pending' as const,
      requested_by: 'admin',
      reason: body.reason ?? '',
    };
    __mswAbBlockReqs.push(entry);
    return __mswAbWrap({ ...entry, tenant_id: 'BANK_DEMO', customer_id: 'c-unknown', requested_at: new Date().toISOString(), reviewed_by: null, reviewed_at: null }, 201);
  }),
];

handlers.push(...__mswAbHandlers);

// ── M2.3 — Financial Ratios ─────────────────────────────────────────
//
// Dev-mode fixtures mirror the BFF semantics at a small scale. The real
// BFF (re-uses M14.7 + RBI sectoral lending deterministic synth) is wired
// via vite proxy in dev.

const __mswFrRatios = [
  { code: 'DSCR', name: 'Debt Service Coverage Ratio', formula: 'EBITDA / (Interest + Principal)', unit: '×', polarity: 'higher_is_better', default_warning: 1.5, default_critical: 1.2, description: '' },
  { code: 'ICR', name: 'Interest Coverage Ratio', formula: 'EBIT / Interest Expense', unit: '×', polarity: 'higher_is_better', default_warning: 2.0, default_critical: 1.5, description: '' },
  { code: 'CR', name: 'Current Ratio', formula: 'Current Assets / Current Liabilities', unit: '×', polarity: 'higher_is_better', default_warning: 1.5, default_critical: 1.2, description: '' },
  { code: 'QR', name: 'Quick Ratio', formula: '(CA – Inventory) / CL', unit: '×', polarity: 'higher_is_better', default_warning: 1.0, default_critical: 0.8, description: '' },
  { code: 'DER', name: 'Debt-to-Equity', formula: 'Total Debt / Net Worth', unit: '×', polarity: 'lower_is_better', default_warning: 2.0, default_critical: 3.0, description: '' },
  { code: 'TOL_TNW', name: 'TOL / TNW', formula: 'Total Outside Liab / Tangible Net Worth', unit: '×', polarity: 'lower_is_better', default_warning: 2.5, default_critical: 4.0, description: '' },
  { code: 'STK_TO', name: 'Stock Turnover', formula: 'COGS / Avg Inventory', unit: 'days', polarity: 'lower_is_better', default_warning: 90, default_critical: 120, description: '' },
  { code: 'DBT_TO', name: 'Debtor Turnover', formula: 'Sales / Avg Receivables', unit: 'days', polarity: 'lower_is_better', default_warning: 75, default_critical: 105, description: '' },
] as const;

const __mswFrThresholds: Record<string, { warning: number; critical: number; updated_by: string; updated_at: string }> = {};
const __mswFrNotes: Array<{ note_id: string; tenant_id: string; customer_id: string; ratio_code: string; body: string; author: string; created_at: string }> = [];
let __mswFrNoteSeq = 0;

function __mswFrWrap(b: unknown, status = 200) {
  return HttpResponse.json({ header: { status: 'success', code: status === 201 ? 'EWS_201' : 'EWS_200', message: 'ok', requestId: `req-msw-${Date.now()}`, timestamp: new Date().toISOString() }, body: b }, { status });
}

function __mswFrSeed(cid: string, code: string) {
  // Tiny deterministic per (cid, code) value within the ratio's range.
  let h = 0x811c9dc5;
  for (const c of `${cid}|${code}`) {
    h ^= c.charCodeAt(0);
    h = (h * 0x01000193) >>> 0;
  }
  const r = (h % 10000) / 10000;
  switch (code) {
    case 'DSCR': return Math.round((1 + r * 1.5) * 100) / 100;
    case 'ICR': return Math.round((1 + r * 4) * 100) / 100;
    case 'CR': return Math.round((0.8 + r * 1.8) * 100) / 100;
    case 'QR': return Math.round((0.5 + r * 1.4) * 100) / 100;
    case 'DER': return Math.round((0.5 + r * 3.5) * 100) / 100;
    case 'TOL_TNW': return Math.round((1 + r * 4.5) * 100) / 100;
    case 'STK_TO': return Math.round(30 + r * 150);
    case 'DBT_TO': return Math.round(30 + r * 120);
  }
  return 1;
}

function __mswFrBand(code: string, v: number): 'green' | 'amber' | 'red' {
  const r = __mswFrRatios.find((x) => x.code === code)!;
  const ovr = __mswFrThresholds[code];
  const warning = ovr?.warning ?? r.default_warning;
  const critical = ovr?.critical ?? r.default_critical;
  if (r.polarity === 'higher_is_better') {
    if (v < critical) return 'red';
    if (v < warning) return 'amber';
    return 'green';
  }
  if (v > critical) return 'red';
  if (v > warning) return 'amber';
  return 'green';
}

const __mswFrHandlers = [
  http.get('/v1/banking/ratios/master', () => __mswFrWrap({ total: __mswFrRatios.length, ratios: __mswFrRatios })),

  http.get('/v1/banking/ratios/thresholds', () => {
    const entries = Object.entries(__mswFrThresholds).map(([code, v]) => ({
      tenant_id: 'BANK_DEMO', code, warning: v.warning, critical: v.critical, source: 'tenant_override', updated_by: v.updated_by, updated_at: v.updated_at,
    }));
    return __mswFrWrap({ tenant_id: 'BANK_DEMO', total: entries.length, entries });
  }),

  http.put('/v1/banking/ratios/thresholds/:code', async ({ params, request }) => {
    const code = String(params.code).toUpperCase();
    const body = (await request.json()) as { warning?: number; critical?: number };
    __mswFrThresholds[code] = {
      warning: Number(body.warning),
      critical: Number(body.critical),
      updated_by: 'admin',
      updated_at: new Date().toISOString(),
    };
    return __mswFrWrap({ tenant_id: 'BANK_DEMO', code, ...__mswFrThresholds[code], source: 'tenant_override' });
  }),

  http.delete('/v1/banking/ratios/thresholds/:code', ({ params }) => {
    const code = String(params.code).toUpperCase();
    delete __mswFrThresholds[code];
    const def = __mswFrRatios.find((r) => r.code === code)!;
    return __mswFrWrap({ tenant_id: 'BANK_DEMO', code, warning: def.default_warning, critical: def.default_critical, source: 'platform_default', updated_by: null, updated_at: null });
  }),

  http.get('/v1/banking/ratios/customer/:customer_id/history', ({ params, request }) => {
    const cid = String(params.customer_id);
    const u = new URL(request.url);
    const code = (u.searchParams.get('ratio_code') ?? '').toUpperCase();
    const def = __mswFrRatios.find((r) => r.code === code);
    if (!def) return __mswFrWrap({ error: 'invalid_ratio_code' }, 400);
    const value = __mswFrSeed(cid, code);
    const band = __mswFrBand(code, value);
    const median = __mswFrSeed(`sector|${cid}`, code);
    const history = Array.from({ length: 12 }, (_, i) => {
      const days = (11 - i) * 30;
      const v = Math.round((value * (0.9 + (i / 11) * 0.2)) * 100) / 100;
      return { date: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), value: v, band: __mswFrBand(code, v) };
    });
    const trend = Math.abs(value - median) / Math.max(1e-9, Math.abs(median)) < 0.05
      ? 'on_par'
      : def.polarity === 'higher_is_better'
        ? value > median ? 'better' : 'worse'
        : value < median ? 'better' : 'worse';
    return __mswFrWrap({
      tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), customer_id: cid, customer_name: `Borrower ${cid}`, sector: 'Manufacturing',
      ratio_code: code, ratio_def: def,
      current: { code, value, band, warning_threshold: def.default_warning, critical_threshold: def.default_critical, threshold_source: 'platform_default' },
      history,
      sector_benchmark: { p25: Math.round(median * 0.8 * 100) / 100, median, p75: Math.round(median * 1.2 * 100) / 100, internal_median: median },
      trend_vs_sector: trend,
      threshold: { warning: def.default_warning, critical: def.default_critical, source: 'platform_default' },
    });
  }),

  http.get('/v1/banking/ratios/customer/:customer_id', ({ params }) => {
    const cid = String(params.customer_id);
    const current: Record<string, unknown> = {};
    const history: Record<string, unknown> = {};
    let worst: 'green' | 'amber' | 'red' = 'green';
    const worstRatios: string[] = [];
    for (const r of __mswFrRatios) {
      const v = __mswFrSeed(cid, r.code);
      const band = __mswFrBand(r.code, v);
      current[r.code] = { code: r.code, value: v, band, warning_threshold: r.default_warning, critical_threshold: r.default_critical, threshold_source: 'platform_default' };
      history[r.code] = Array.from({ length: 12 }, (_, i) => ({
        date: new Date(Date.now() - (11 - i) * 30 * 86_400_000).toISOString().slice(0, 10),
        value: Math.round(v * (0.9 + (i / 11) * 0.2) * 100) / 100,
        band: __mswFrBand(r.code, Math.round(v * (0.9 + (i / 11) * 0.2) * 100) / 100),
      }));
      if (band === 'red') { worst = 'red'; worstRatios.push(r.code); }
      else if (band === 'amber' && worst === 'green') { worst = 'amber'; worstRatios.push(r.code); }
    }
    return __mswFrWrap({
      tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), customer_id: cid,
      customer_name: `Borrower ${cid}`, sector: 'Manufacturing',
      current, history, worst_band: worst, worst_ratios: worstRatios,
    });
  }),

  http.get('/v1/banking/ratios/sector-benchmark', ({ request }) => {
    const u = new URL(request.url);
    const sector = u.searchParams.get('sector') ?? 'Manufacturing';
    return __mswFrWrap({
      tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), sector, as_of_quarter: '2026-Q1',
      ratios: __mswFrRatios.map((r) => {
        const m = __mswFrSeed(`bench|${sector}`, r.code);
        return { code: r.code, name: r.name, rbi_quartile_25: Math.round(m * 0.8 * 100) / 100, rbi_median: m, rbi_quartile_75: Math.round(m * 1.2 * 100) / 100, internal_median: m, sample_size: 250 };
      }),
    });
  }),

  http.get('/v1/banking/ratios/notes', ({ request }) => {
    const u = new URL(request.url);
    const cid = u.searchParams.get('customer_id') ?? undefined;
    const code = u.searchParams.get('ratio_code')?.toUpperCase() ?? undefined;
    const out = __mswFrNotes
      .filter((n) => !cid || n.customer_id === cid)
      .filter((n) => !code || n.ratio_code === code)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return __mswFrWrap({ tenant_id: 'BANK_DEMO', total: out.length, notes: out });
  }),

  http.post('/v1/banking/ratios/notes', async ({ request }) => {
    const b = (await request.json()) as { customer_id?: string; ratio_code?: string; body?: string };
    __mswFrNoteSeq++;
    const note = {
      note_id: `rnote-BANK_DEMO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(__mswFrNoteSeq).padStart(4, '0')}`,
      tenant_id: 'BANK_DEMO',
      customer_id: b.customer_id ?? 'unknown',
      ratio_code: (b.ratio_code ?? '').toUpperCase(),
      body: (b.body ?? '').trim(),
      author: 'admin',
      created_at: new Date().toISOString(),
    };
    __mswFrNotes.push(note);
    return __mswFrWrap(note, 201);
  }),

  http.post('/v1/banking/cma/pack', async ({ request }) => {
    const b = (await request.json()) as { cohort?: string[]; forms?: string[] };
    const cohort = b.cohort ?? [];
    const forms = (b.forms ?? ['II', 'III', 'IV', 'V']) as ('II' | 'III' | 'IV' | 'V')[];
    const html = `<!doctype html><html><body><h1>CMA Pack — ${cohort.length} borrower(s)</h1>${cohort.map((c) => `<article><h2>${c}</h2>${forms.map((f) => `<section><h3>Form ${f}</h3></section>`).join('')}</article>`).join('')}</body></html>`;
    return __mswFrWrap({
      pack_id: `cma-BANK_DEMO-${Date.now()}`,
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      generated_by: 'admin',
      cohort_size: cohort.length,
      cohort,
      forms,
      html,
      size_bytes: html.length,
    }, 201);
  }),
];

handlers.push(...__mswFrHandlers);

// ── M2.4 — SMA Classification ──────────────────────────────────────────
//
// Dev-mode fixtures mirror the BFF semantics at a small scale. Real BFF
// (`services/bff/src/banking_sma.ts`) is wired via vite proxy in dev.

const __mswSmaFrameworks = [
  { code: 'RBI', regulator: 'Reserve Bank of India', country: 'India', description: 'RBI IRACP — SMA-0 1-30d, SMA-1 31-60d, SMA-2 61-90d, NPA ≥ 91d.', sma1_min: 31, sma2_min: 61, npa_min: 91 },
  { code: 'RMA', regulator: 'Royal Monetary Authority', country: 'Bhutan', description: 'RMA Bhutan — aligned with RBI bands.', sma1_min: 31, sma2_min: 61, npa_min: 91 },
  { code: 'CBK', regulator: 'Central Bank of Kenya', country: 'Kenya', description: 'CBK PG/04 — Watch 1-30d, Substandard 31-90d, Doubtful 91-180d, Loss ≥ 181d.', sma1_min: 31, sma2_min: 91, npa_min: 181 },
] as const;

function __mswSmaWrap(b: unknown, status = 200) {
  return HttpResponse.json(
    {
      header: {
        status: 'success',
        code: status === 201 ? 'EWS_201' : 'EWS_200',
        message: 'ok',
        requestId: `req-msw-${Date.now()}`,
        timestamp: new Date().toISOString(),
      },
      body: b,
    },
    { status },
  );
}

function __mswSmaMovements(framework: string) {
  return {
    tenant_id: 'BANK_DEMO',
    generated_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    framework,
    total_movements: 6,
    by_category_count: { 'SMA-0': 4, 'SMA-1': 1, 'SMA-2': 0, NPA: 1 },
    deteriorations: 4,
    improvements: 1,
    unchanged: 1,
    total_exposure_at_risk_kes: 17_500_000,
    movements: [
      { customer_id: 'c-101', customer_name: 'Alice Patel', from_category: 'CURRENT', to_category: 'SMA-0', dpd: 12, outstanding_kes: 250_000, sector: 'Manufacturing', framework, movement_at: new Date().toISOString(), direction: 'deterioration' },
      { customer_id: 'c-106', customer_name: 'Rajesh Kumar', from_category: 'SMA-0', to_category: 'SMA-1', dpd: 35, outstanding_kes: 1_300_000, sector: 'Trade', framework, movement_at: new Date().toISOString(), direction: 'deterioration' },
      { customer_id: 'c-115', customer_name: 'Priya Sharma', from_category: 'SMA-2', to_category: 'NPA', dpd: 95, outstanding_kes: 8_200_000, sector: 'Real Estate', framework, movement_at: new Date().toISOString(), direction: 'deterioration' },
      { customer_id: 'c-118', customer_name: 'Mohan Singh', from_category: 'SMA-1', to_category: 'SMA-0', dpd: 22, outstanding_kes: 540_000, sector: 'Trade', framework, movement_at: new Date().toISOString(), direction: 'improvement' },
      { customer_id: 'c-120', customer_name: 'Kavya Iyer', from_category: 'CURRENT', to_category: 'SMA-0', dpd: 8, outstanding_kes: 180_000, sector: 'Pharma', framework, movement_at: new Date().toISOString(), direction: 'deterioration' },
      { customer_id: 'c-105', customer_name: 'Vikram Reddy', from_category: 'CURRENT', to_category: 'SMA-0', dpd: 5, outstanding_kes: 320_000, sector: 'IT Services', framework, movement_at: new Date().toISOString(), direction: 'deterioration' },
    ],
  };
}

const __mswSmaHandlers = [
  http.get('/v1/banking/sma/framework', ({ request }) => {
    const u = new URL(request.url);
    const active = (u.searchParams.get('framework') ?? 'RBI').toUpperCase();
    const def = __mswSmaFrameworks.find((f) => f.code === active) ?? __mswSmaFrameworks[0];
    return __mswSmaWrap({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      active_framework: def.code,
      active_definition: def,
      frameworks: __mswSmaFrameworks,
    });
  }),

  http.get('/v1/banking/sma/movements', ({ request }) => {
    const u = new URL(request.url);
    const framework = (u.searchParams.get('framework') ?? 'RBI').toUpperCase();
    return __mswSmaWrap(__mswSmaMovements(framework));
  }),

  http.get('/v1/banking/sma/drill', ({ request }) => {
    const u = new URL(request.url);
    const framework = (u.searchParams.get('framework') ?? 'RBI').toUpperCase();
    const from = u.searchParams.get('from') ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const to = u.searchParams.get('to') ?? new Date().toISOString().slice(0, 10);
    const base = __mswSmaMovements(framework).movements;
    const rows = base.map((m) => ({
      ...m,
      reason:
        m.to_category === 'NPA' ? `Crossed ${m.dpd}d (≥ NPA threshold)`
          : m.to_category === 'SMA-1' ? `Crossed 30 dpd today`
          : m.direction === 'improvement' ? 'Improved by partial payment'
          : 'New DPD observation',
    }));
    return __mswSmaWrap({ tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), from, until: to, framework, total: rows.length, rows });
  }),

  http.get('/v1/banking/sma/sector-view', ({ request }) => {
    const u = new URL(request.url);
    const framework = (u.searchParams.get('framework') ?? 'RBI').toUpperCase();
    const sectors = ['Manufacturing', 'Trade', 'Real Estate', 'IT Services', 'Pharma'].map((sector, i) => ({
      sector,
      total_customers: 30 + i * 8,
      by_category: { 'SMA-0': 18 + i, 'SMA-1': 6 + i, 'SMA-2': 3, NPA: 1 + Math.max(0, i - 1) },
      total_outstanding_kes: (35 + i * 12) * 1_000_000,
      npa_outstanding_kes: (3 + i) * 1_000_000,
      npa_ratio_pct: 3 + i * 1.5,
      worst_category: i >= 3 ? 'NPA' : 'SMA-2',
    }));
    return __mswSmaWrap({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      framework,
      total_sectors: sectors.length,
      total_customers: sectors.reduce((a, s) => a + s.total_customers, 0),
      total_outstanding_kes: sectors.reduce((a, s) => a + s.total_outstanding_kes, 0),
      sectors,
    });
  }),

  http.get('/v1/banking/sma/trend', ({ request }) => {
    const u = new URL(request.url);
    const customer_id = u.searchParams.get('customer_id') ?? 'c-101';
    const framework = (u.searchParams.get('framework') ?? 'RBI').toUpperCase();
    const points = Array.from({ length: 30 }, (_, i) => {
      const dpd = Math.max(0, Math.round(i * 2 + (i % 7 === 0 ? -5 : 0)));
      const category = dpd >= 91 ? 'NPA' : dpd >= 61 ? 'SMA-2' : dpd >= 31 ? 'SMA-1' : 'SMA-0';
      return { date: new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10), category, dpd };
    });
    const current = points[points.length - 1]?.category ?? 'SMA-0';
    const worst = points.reduce((acc, p) => {
      const order = { 'SMA-0': 0, 'SMA-1': 1, 'SMA-2': 2, NPA: 3 } as const;
      return order[p.category as keyof typeof order] > order[acc as keyof typeof order] ? p.category : acc;
    }, 'SMA-0' as string);
    const first = points[0]?.dpd ?? 0;
    const last = points[points.length - 1]?.dpd ?? 0;
    const trend_direction = last > first + 5 ? 'deteriorating' : last < first - 5 ? 'improving' : 'stable';
    return __mswSmaWrap({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      customer_id,
      framework,
      point_count: points.length,
      series: points.map((p) => ({ ...p, outstanding_kes: 250_000 })),
      current_category: current,
      worst_category: worst,
      trend_direction,
    });
  }),

  http.post('/v1/banking/sma/run-classification', ({ request }) => {
    const u = new URL(request.url);
    const framework = (u.searchParams.get('framework') ?? 'RBI').toUpperCase();
    const n = Number(u.searchParams.get('customer_count') ?? '200');
    return __mswSmaWrap({
      tenant_id: 'BANK_DEMO',
      generated_at: new Date().toISOString(),
      framework,
      triggered_by: 'admin',
      run_id: `sma-BANK_DEMO-${Date.now()}`,
      customers_evaluated: n,
      customers_changed: Math.round(n * 0.04),
      by_category_count: { 'SMA-0': Math.round(n * 0.6), 'SMA-1': Math.round(n * 0.18), 'SMA-2': Math.round(n * 0.08), NPA: Math.round(n * 0.04) },
      duration_ms: Math.max(8, Math.round(n / 250)),
    }, 201);
  }),
];

handlers.push(...__mswSmaHandlers);

// ── M2.5 — NPA Prediction (all 5 NPA endpoints stubbed for MSW dev/test mode) ──
//
// Previously only /predictions/:account_id was stubbed; /high-risk and
// /portfolio-drivers were missing, so they bypassed MSW and tried the real
// BFF. When the BFF is not running the connection is refused → React Query
// surfaces this as an error state → "HTTP 500" in the UI.
//
// All 5 NPA endpoints are now stubbed here:
//   GET /v1/banking/npa/high-risk?horizon=N          ← WAS MISSING (root cause)
//   GET /v1/banking/npa/portfolio-drivers?horizon=N  ← WAS MISSING (root cause)
//   GET /v1/banking/npa/predictions/:account_id      ← already existed
//   GET /v1/banking/npa/predictions/:id/why          ← already existed (vite proxy fallback)
//   GET /v1/banking/npa/backtest/latest              ← now stubbed here too
//
// Synthesis uses FNV-1a + mulberry32 with a stable anchor date so output is
// deterministic across dev sessions — the same approach as the BFF engine.

// Stable anchor: 2026-06-04
const __NPA_BASE_MS = 1749081600000;
const __NPA_DAY = '2026-06-04';

function __npaMul32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
function __npaFnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const __NPA_SECTORS = ['Manufacturing', 'Power', 'Construction', 'Real_Estate', 'Textiles', 'Auto_Components', 'Pharma', 'IT_Services', 'Hospitality', 'Logistics'];
const __NPA_FIRST = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya'];
const __NPA_LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Mehta'];

function __buildNpaHighRiskMsw(tenant_id: string, horizon: number) {
  const cap = tenant_id.toUpperCase() === 'BIL' ? 120 : 200;
  const scale = tenant_id.toUpperCase() === 'BIL' ? 0.6 : 1.0;
  const rows: Record<string, unknown>[] = [];
  let totalExp = 0; let totalCritical = 0;
  for (let i = 0; i < cap; i++) {
    const cid = `c-${String(100000 + i).slice(-6)}`;
    const rng = __npaMul32(__npaFnv(`${tenant_id}|${cid}|${__NPA_DAY}|${horizon}`));
    const pd = rng();
    if (pd < 0.6) continue;
    const band = pd >= 0.85 ? 'critical' : 'high';
    if (band === 'critical') totalCritical++;
    const exposure = Math.round((1_000_000 + rng() * 50_000_000) * scale);
    totalExp += exposure;
    rows.push({
      prediction_id: `pred-${tenant_id}-${cid}-${__NPA_DAY}-${horizon}`,
      customer_id: cid,
      customer_name: `${__NPA_FIRST[Math.floor(rng() * __NPA_FIRST.length)]} ${__NPA_LAST[Math.floor(rng() * __NPA_LAST.length)]}`,
      pd: Math.round(pd * 1000) / 1000, band,
      predicted_at: new Date(__NPA_BASE_MS).toISOString(),
      horizon_days: horizon, outstanding_kes: exposure,
      sector: __NPA_SECTORS[Math.floor(rng() * __NPA_SECTORS.length)],
      current_dpd: Math.floor(rng() * 90),
    });
  }
  rows.sort((a, b) => (b.pd as number) - (a.pd as number));
  return {
    tenant_id, generated_at: new Date(__NPA_BASE_MS).toISOString(),
    horizon_days: horizon, total_high_risk: rows.length,
    total_critical: totalCritical, total_exposure_kes: totalExp,
    rows: rows.slice(0, 200),
  };
}

function __buildPortfolioDriversMsw(tenant_id: string, horizon: number) {
  const FEATURE_POOL = [
    'dpd_max_90d', 'utilization_pct', 'emi_bounce_rate_180d',
    'cash_withdrawal_velocity', 'bureau_score',
  ];
  let grandTotal = 0;
  const drivers = FEATURE_POOL.map((feature_name) => {
    const rng = __npaMul32(__npaFnv(`${tenant_id}|${feature_name}|${__NPA_DAY}|${horizon}`));
    const affected = Math.round(30 + rng() * 60);
    const total_contribution = Math.round((0.5 + rng() * 2.5) * 10000) / 10000;
    grandTotal += total_contribution;
    const up_count = Math.round(affected * (0.5 + rng() * 0.4));
    const bySector: Record<string, number> = {};
    __NPA_SECTORS.slice(0, 4).forEach(s => { bySector[s] = Math.round(1 + rng() * 8); });
    return { feature_name, total_contribution, affected_predictions: affected,
      avg_weight: Math.round((total_contribution / Math.max(1, affected)) * 10000) / 10000,
      direction_split: { up: up_count, down: Math.max(0, affected - up_count) },
      by_sector: bySector, pct_of_total: 0 };
  });
  drivers.forEach(d => { d.pct_of_total = grandTotal > 0 ? Math.round((d.total_contribution / grandTotal) * 10000) / 10000 : 0; });
  drivers.sort((a, b) => b.total_contribution - a.total_contribution || a.feature_name.localeCompare(b.feature_name));
  const mostUniversal = drivers.length > 0
    ? drivers.reduce((best, d) => d.affected_predictions > best.affected_predictions ? d : best, drivers[0])
    : null;
  return {
    tenant_id, generated_at: new Date(__NPA_BASE_MS).toISOString(),
    horizon_days: horizon,
    total_predictions_analyzed: Math.max(...drivers.map(d => d.affected_predictions), 0),
    total_drivers: drivers.length, drivers,
    most_universal_driver: mostUniversal
      ? { feature_name: mostUniversal.feature_name, affected_predictions: mostUniversal.affected_predictions }
      : null,
  };
}

function __mswNpaWrap(b: unknown, status = 200) {
  return HttpResponse.json(
    {
      header: {
        status: 'success',
        code: status === 201 ? 'EWS_201' : 'EWS_200',
        message: 'ok',
        requestId: `req-msw-${Date.now()}`,
        timestamp: new Date().toISOString(),
      },
      body: b,
    },
    { status },
  );
}

const __mswNpaHandlers = [
  http.get('/v1/banking/npa/predictions/:account_id', ({ params }) => {
    const account_id = String(params.account_id);
    return __mswNpaWrap({
      tenant_id: 'BANK_DEMO',
      account_id,
      customer_id: account_id.startsWith('a-') ? `c-${account_id.split('-')[1]}` : 'c-unknown',
      generated_at: new Date().toISOString(),
      model_id: 'pd-xgb-prod',
      model_version: 'v3.2.0',
      pd_30d: 0.42,
      pd_60d: 0.61,
      pd_90d: 0.78,
      current_band: 'high',
      recommended_actions: [
        'Notify supervisor + watchlist',
        'Request fresh stock statement (covenant due)',
        'Review with relationship manager within 5 days',
      ],
    });
  }),

  http.get('/v1/ai/models/:model_id', ({ params }) => {
    const model_id = String(params.model_id);
    return __mswNpaWrap({
      model_id,
      type: 'pd',
      name: 'NPA Prediction XGBoost',
      version: 'v3.2.0',
      framework: 'xgboost',
      status: 'production',
      trained_at: '2026-04-15T00:00:00.000Z',
      deployed_at: '2026-04-22T00:00:00.000Z',
      metrics: {
        auc: 0.847,
        training_rows: 124_500,
        evaluated_at: '2026-04-20T00:00:00.000Z',
      },
      key_features: [
        'dpd_max_90d',
        'utilization_pct',
        'emi_bounce_rate_180d',
        'bureau_score',
        'cash_withdrawal_velocity',
        'account_age_months',
      ],
    });
  }),

  http.get('/v1/metadata/lineage/datasets/:dataset_id', ({ params }) => {
    const dataset_id = String(params.dataset_id);
    return __mswNpaWrap({
      dataset_id,
      name: dataset_id,
      schema: 'mart',
      description: 'Daily NPA predictions per account — written by the pd-xgb-prod model batch.',
      owner: 'agent-ai',
      pii: false,
      retention_days: 365 * 7,
      source_system: 'mart.npa_predictions',
      upstream_dataset_ids: [
        'mart.customer_360',
        'mart.loan_360',
        'mart.txn_features',
        'mart.indicator_values',
      ],
      downstream_dataset_ids: [
        'apex.regulatory.events',
        'app_alerts.alerts',
      ],
      tags: ['npa', 'pd', 'ai'],
    });
  }),

  // ── FIX: GET /v1/banking/npa/high-risk — was missing, caused HTTP 500 ──
  http.get('/v1/banking/npa/high-risk', ({ request }) => {
    const url = new URL(request.url);
    const tenant = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO');
    const h = parseInt(url.searchParams.get('horizon') ?? '90', 10);
    const horizon = [30, 60, 90, 180].includes(h) ? h : 90;
    return __mswNpaWrap(__buildNpaHighRiskMsw(tenant, horizon));
  }),

  // ── FIX: GET /v1/banking/npa/portfolio-drivers — was missing, caused HTTP 500 ──
  http.get('/v1/banking/npa/portfolio-drivers', ({ request }) => {
    const url = new URL(request.url);
    const tenant = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO');
    const h = parseInt(url.searchParams.get('horizon') ?? '90', 10);
    const horizon = [30, 60, 90, 180].includes(h) ? h : 90;
    return __mswNpaWrap(__buildPortfolioDriversMsw(tenant, horizon));
  }),

  // ── GET /v1/banking/npa/backtest/latest — stub so SPA works fully offline ──
  http.get('/v1/banking/npa/backtest/latest', ({ request }) => {
    const tenant = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO');
    const scale = tenant.toUpperCase() === 'BIL' ? 0.6 : 1.0;
    const rng = __npaMul32(__npaFnv(`${tenant}|${__NPA_DAY}|backtest`));
    const cohort = Math.round((4000 + rng() * 3000) * scale);
    const auc = Math.round((0.82 + rng() * 0.1) * 1000) / 1000;
    return __mswNpaWrap({
      tenant_id: tenant,
      generated_at: new Date(__NPA_BASE_MS).toISOString(),
      model_id: 'pd-xgb-prod', model_version: 'v3.2.0',
      back_to: '2026-03-05',
      cohort_size: cohort, auc, ks: Math.round((auc - 0.3) * 1000) / 1000,
      precision_at_top_decile: 0.71, recall_at_top_decile: 0.58,
      confusion: { tp: Math.round(cohort * 0.04), fp: Math.round(cohort * 0.02),
        tn: Math.round(cohort * 0.9), fn: Math.round(cohort * 0.04) },
      by_segment: ['Retail', 'SME', 'Corporate', 'Agriculture'].map(seg => ({
        segment: seg,
        auc: Math.round((0.79 + __npaMul32(__npaFnv(`${tenant}|${seg}|bt`))() * 0.11) * 1000) / 1000,
        cohort_size: Math.round(cohort / 4),
      })),
    });
  }),

  // ── GET /v1/banking/npa/predictions/:prediction_id/why — stub for offline ──
  http.get('/v1/banking/npa/predictions/:prediction_id/why', ({ params }) => {
    const prediction_id = String(params.prediction_id);
    const tenant = 'BANK_DEMO';
    const rng = __npaMul32(__npaFnv(`${tenant}|${prediction_id}|why`));
    const pd = 0.55 + rng() * 0.4;
    const band = pd >= 0.85 ? 'critical' : pd >= 0.7 ? 'high' : 'medium';
    return __mswNpaWrap({
      tenant_id: tenant, account_id: prediction_id,
      customer_id: `c-${String(Math.floor(100000 + rng() * 9999)).slice(-6)}`,
      generated_at: new Date(__NPA_BASE_MS).toISOString(),
      pd: Math.round(pd * 1000) / 1000, band,
      model_id: 'pd-xgb-prod', model_version: 'v3.2.0',
      top_features: [
        { feature_name: 'dpd_max_90d', weight: 0.32, direction: 'up', value: '45 days' },
        { feature_name: 'utilization_pct', weight: 0.18, direction: 'up', value: '92%' },
        { feature_name: 'emi_bounce_rate_180d', weight: 0.21, direction: 'up', value: '3 of 12' },
        { feature_name: 'cash_withdrawal_velocity', weight: 0.12, direction: 'up', value: '+2.4σ' },
        { feature_name: 'bureau_score', weight: -0.15, direction: 'down', value: '612 (Subprime)' },
      ],
      comparable_customers: [
        { customer_id: 'c-301234', pd: Math.round(pd * 0.95 * 1000) / 1000, outcome: 'npa' },
        { customer_id: 'c-302567', pd: Math.round(pd * 0.88 * 1000) / 1000, outcome: 'cured' },
        { customer_id: 'c-303890', pd: Math.round(pd * 1.05 * 1000) / 1000, outcome: 'pending' },
      ],
      recommended_actions: [
        band === 'critical' ? 'Escalate to head_of_risk + initiate covenant breach review' : 'Notify supervisor + watchlist',
        'Request fresh stock statement (covenant due)',
        'Review with relationship manager within 5 days',
      ],
    });
  }),
];

handlers.push(...__mswNpaHandlers);

// ── M2.6 — Fraud Signals (8 endpoints; pre-existing BFF surface served
//    via vite proxy in dev, but we mirror them here for offline/test mode)

interface MswFraudCase {
  case_id: string;
  tenant_id: string;
  customer_id: string | null;
  account_id: string | null;
  category: string;
  priority: string;
  status: string;
  amount_kes: number;
  description: string;
  detected_at: string;
  assignee: string | null;
  opened_by: string;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  sar_id: string | null;
  vigilance_ref: string | null;
  rule_id: string | null;
}

const __mswFraudCases: MswFraudCase[] = [
  {
    case_id: 'fc-BANK_DEMO-20260524-0001',
    tenant_id: 'BANK_DEMO', customer_id: 'c-101', account_id: 'a-100101-00',
    category: 'cheque_fraud', priority: 'critical', status: 'open',
    amount_kes: 4_500_000,
    description: 'Cheque kiting cluster across 3 branches — 8 cheques in 5d, distinct beneficiaries, balance roundtripped.',
    detected_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    assignee: null, opened_by: 'admin',
    opened_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 86_400_000).toISOString(),
    closed_at: null, sar_id: null, vigilance_ref: null, rule_id: null,
  },
  {
    case_id: 'fc-BANK_DEMO-20260524-0002',
    tenant_id: 'BANK_DEMO', customer_id: 'c-106', account_id: 'a-100106-00',
    category: 'account_takeover', priority: 'high', status: 'investigating',
    amount_kes: 1_250_000,
    description: 'Session token replay from 3 distinct ASNs in 4h, OTP suppressed via reset abuse.',
    detected_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    assignee: 'bob.supervisor', opened_by: 'admin',
    opened_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 86_400_000).toISOString(),
    closed_at: null, sar_id: null, vigilance_ref: null, rule_id: null,
  },
  {
    case_id: 'fc-BANK_DEMO-20260524-0003',
    tenant_id: 'BANK_DEMO', customer_id: 'c-115', account_id: 'a-100115-00',
    category: 'identity_theft', priority: 'medium', status: 'reported',
    amount_kes: 850_000,
    description: 'PAN/Aadhaar mismatch on KYC re-verify + address change request from new device.',
    detected_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    assignee: 'alice.admin', opened_by: 'admin',
    opened_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    closed_at: null,
    sar_id: 'sar-BANK_DEMO-20260520-0001', vigilance_ref: null, rule_id: null,
  },
];

interface MswFraudRule {
  rule_id: string; tenant_id: string; name: string; category: string;
  condition_pseudocode: string; threshold: number; enabled: boolean;
  created_at: string; updated_at: string; created_by: string;
}

const __mswFraudRules: MswFraudRule[] = [
  {
    rule_id: 'fr-BANK_DEMO-001', tenant_id: 'BANK_DEMO',
    name: 'Cheque kiting cluster', category: 'cheque_fraud',
    condition_pseudocode: 'distinct_branches_5d ≥ 3 AND roundtripped_amount_ratio > 0.6',
    threshold: 0.75, enabled: true,
    created_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    created_by: 'admin',
  },
  {
    rule_id: 'fr-BANK_DEMO-002', tenant_id: 'BANK_DEMO',
    name: 'Session token replay', category: 'account_takeover',
    condition_pseudocode: 'distinct_asn_4h ≥ 3 AND otp_suppressed = true',
    threshold: 0.85, enabled: true,
    created_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    created_by: 'admin',
  },
];

let __mswFraudCaseSeq = __mswFraudCases.length;
let __mswFraudRuleSeq = __mswFraudRules.length;
let __mswFraudSarSeq = 1;
let __mswFraudVigSeq = 0;

function __mswFraudWrap(b: unknown, status = 200) {
  return HttpResponse.json(
    {
      header: {
        status: 'success',
        code: status === 201 ? 'EWS_201' : 'EWS_200',
        message: 'ok',
        requestId: `req-msw-${Date.now()}`,
        timestamp: new Date().toISOString(),
      },
      body: b,
    },
    { status },
  );
}

function __mswFraudErr(code: string, message: string, status = 400) {
  return HttpResponse.json(
    {
      header: { status: 'error', code, message, requestId: 'req-msw', timestamp: new Date().toISOString() },
      error: { code, message, severity: status >= 500 ? 'HIGH' : 'MEDIUM' },
    },
    { status },
  );
}

const __mswFraudHandlers = [
  http.get('/v1/fraud/cases', ({ request }) => {
    const u = new URL(request.url);
    const status = u.searchParams.get('status');
    const priority = u.searchParams.get('priority');
    let rows = __mswFraudCases.slice();
    if (status) rows = rows.filter((r) => r.status === status);
    if (priority) rows = rows.filter((r) => r.priority === priority);
    return __mswFraudWrap({ tenant_id: 'BANK_DEMO', cases: rows });
  }),

  http.get('/v1/fraud/cases/:case_id', ({ params }) => {
    const c = __mswFraudCases.find((r) => r.case_id === String(params.case_id));
    if (!c) return __mswFraudErr('EWS_404_unknown_case', `unknown ${params.case_id}`, 404);
    return __mswFraudWrap(c);
  }),

  http.post('/v1/fraud/cases', async ({ request }) => {
    const body = (await request.json()) as { description?: string; category?: string };
    if (!body.description || !body.category) {
      return __mswFraudErr('EWS_400_invalid_input', 'description + category required', 400);
    }
    __mswFraudCaseSeq++;
    const now = new Date().toISOString();
    const c: MswFraudCase = {
      case_id: `fc-BANK_DEMO-20260524-${String(__mswFraudCaseSeq).padStart(4, '0')}`,
      tenant_id: 'BANK_DEMO',
      customer_id: null, account_id: null,
      category: body.category,
      priority: 'medium',
      status: 'open',
      amount_kes: 0,
      description: body.description,
      detected_at: now,
      assignee: null,
      opened_by: 'admin',
      opened_at: now,
      updated_at: now,
      closed_at: null,
      sar_id: null,
      vigilance_ref: null,
      rule_id: null,
      ...(body as object),
    };
    __mswFraudCases.unshift(c);
    return __mswFraudWrap(c, 201);
  }),

  http.patch('/v1/fraud/cases/:case_id', async ({ params, request }) => {
    const c = __mswFraudCases.find((r) => r.case_id === String(params.case_id));
    if (!c) return __mswFraudErr('EWS_404_unknown_case', 'unknown case', 404);
    const patch = (await request.json()) as Partial<MswFraudCase>;
    Object.assign(c, patch, { updated_at: new Date().toISOString() });
    return __mswFraudWrap(c);
  }),

  http.get('/v1/fraud/rules', ({ request }) => {
    const u = new URL(request.url);
    const enabledOnly = u.searchParams.get('enabled_only') === 'true';
    return __mswFraudWrap({
      rules: enabledOnly ? __mswFraudRules.filter((r) => r.enabled) : __mswFraudRules,
    });
  }),

  http.post('/v1/fraud/rules', async ({ request }) => {
    const body = (await request.json()) as MswFraudRule;
    __mswFraudRuleSeq++;
    const now = new Date().toISOString();
    const r: MswFraudRule = {
      rule_id: `fr-BANK_DEMO-${String(__mswFraudRuleSeq).padStart(3, '0')}`,
      tenant_id: 'BANK_DEMO',
      created_at: now,
      updated_at: now,
      created_by: 'admin',
      enabled: true,
      threshold: 0.75,
      ...body,
    };
    __mswFraudRules.push(r);
    return __mswFraudWrap(r, 201);
  }),

  http.post('/v1/fraud/cases/:case_id/sar', async ({ params, request }) => {
    const c = __mswFraudCases.find((r) => r.case_id === String(params.case_id));
    if (!c) return __mswFraudErr('EWS_404_unknown_case', 'unknown case', 404);
    if (c.sar_id) {
      return __mswFraudErr('EWS_409_sar_already_submitted', `SAR already on file: ${c.sar_id}`, 409);
    }
    const body = (await request.json()) as { summary?: string };
    if (!body.summary || body.summary.trim().length < 20) {
      return __mswFraudErr('EWS_400_invalid_input', 'summary ≥ 20 chars', 400);
    }
    __mswFraudSarSeq++;
    const now = new Date().toISOString();
    const sar_id = `sar-BANK_DEMO-20260524-${String(__mswFraudSarSeq).padStart(4, '0')}`;
    c.sar_id = sar_id;
    c.status = 'reported';
    c.updated_at = now;
    return __mswFraudWrap(
      {
        sar_id,
        case_id: c.case_id,
        submitted_by: 'admin',
        submitted_at: now,
        fiu_reference: `FIU-IND-202605-${String(__mswFraudSarSeq).padStart(6, '0')}`,
        summary: body.summary.trim(),
      },
      201,
    );
  }),

  http.post('/v1/fraud/cases/:case_id/vigilance', async ({ params, request }) => {
    const c = __mswFraudCases.find((r) => r.case_id === String(params.case_id));
    if (!c) return __mswFraudErr('EWS_404_unknown_case', 'unknown case', 404);
    if (c.vigilance_ref) {
      return __mswFraudErr('EWS_409_vigilance_already_referred', `already referred: ${c.vigilance_ref}`, 409);
    }
    const body = (await request.json()) as { reason?: string };
    if (!body.reason || body.reason.trim().length < 10) {
      return __mswFraudErr('EWS_400_invalid_input', 'reason ≥ 10 chars', 400);
    }
    __mswFraudVigSeq++;
    const vigilance_ref = `vig-BANK_DEMO-20260524-${String(__mswFraudVigSeq).padStart(4, '0')}`;
    c.vigilance_ref = vigilance_ref;
    c.updated_at = new Date().toISOString();
    return __mswFraudWrap(
      {
        vigilance_ref,
        case_id: c.case_id,
        referred_by: 'admin',
        referred_at: c.updated_at,
        reason: body.reason.trim(),
      },
      201,
    );
  }),
];

handlers.push(...__mswFraudHandlers);

// ──────────────────────────────────────────────────────────────────────
// §2.1.7 — Collections Risk / Recovery desk handlers (deterministic
// synthetic book + in-memory PTP + contact-log overlays).
// ──────────────────────────────────────────────────────────────────────

type MswCollDpdBucket = 'dpd_1_30' | 'dpd_31_60' | 'dpd_61_90' | 'dpd_90_plus';
type MswCollStage =
  | 'soft_reminder'
  | 'hard_reminder'
  | 'field_visit'
  | 'legal_notice'
  | 'settlement_offer';
type MswCollPtp = 'none' | 'active' | 'kept' | 'broken';

interface MswCollAccount {
  account_id: string;
  customer_id: string;
  customer_name: string;
  sector: string;
  dpd: number;
  dpd_bucket: MswCollDpdBucket;
  outstanding_kes: number;
  overdue_kes: number;
  recovery_stage: MswCollStage;
  recovery_probability: number;
  expected_recovery_kes: number;
  ptp_status: MswCollPtp;
  ptp_amount_kes: number | null;
  ptp_date: string | null;
  assigned_collector: string;
  last_contact_at: string | null;
  contact_attempts_30d: number;
}

const __mswCollSeed: MswCollAccount[] = [
  { account_id: 'acc-bd-700000', customer_id: 'c-200000', customer_name: 'Rajesh Kumar', sector: 'Real_Estate', dpd: 212, dpd_bucket: 'dpd_90_plus', outstanding_kes: 64_500_000, overdue_kes: 52_300_000, recovery_stage: 'legal_notice', recovery_probability: 0.14, expected_recovery_kes: 7_322_000, ptp_status: 'broken', ptp_amount_kes: 18_000_000, ptp_date: '2026-05-12', assigned_collector: 'nina.legal', last_contact_at: '2026-05-26T09:00:00.000Z', contact_attempts_30d: 6 },
  { account_id: 'acc-bd-700001', customer_id: 'c-200001', customer_name: 'Priya Sharma', sector: 'Hospitality', dpd: 134, dpd_bucket: 'dpd_90_plus', outstanding_kes: 41_200_000, overdue_kes: 33_900_000, recovery_stage: 'settlement_offer', recovery_probability: 0.22, expected_recovery_kes: 7_458_000, ptp_status: 'active', ptp_amount_kes: 12_000_000, ptp_date: '2026-06-08', assigned_collector: 'sara.recovery', last_contact_at: '2026-05-27T11:30:00.000Z', contact_attempts_30d: 4 },
  { account_id: 'acc-bd-700002', customer_id: 'c-200002', customer_name: 'Mohan Singh', sector: 'Manufacturing', dpd: 74, dpd_bucket: 'dpd_61_90', outstanding_kes: 28_700_000, overdue_kes: 15_400_000, recovery_stage: 'field_visit', recovery_probability: 0.41, expected_recovery_kes: 6_314_000, ptp_status: 'none', ptp_amount_kes: null, ptp_date: null, assigned_collector: 'amit.field', last_contact_at: '2026-05-24T14:00:00.000Z', contact_attempts_30d: 3 },
  { account_id: 'acc-bd-700003', customer_id: 'c-200003', customer_name: 'Meera Nair', sector: 'Retail_Trade', dpd: 48, dpd_bucket: 'dpd_31_60', outstanding_kes: 9_300_000, overdue_kes: 4_100_000, recovery_stage: 'hard_reminder', recovery_probability: 0.62, expected_recovery_kes: 2_542_000, ptp_status: 'kept', ptp_amount_kes: 2_000_000, ptp_date: '2026-05-15', assigned_collector: 'ravi.collector', last_contact_at: '2026-05-25T10:00:00.000Z', contact_attempts_30d: 2 },
  { account_id: 'acc-bd-700004', customer_id: 'c-200004', customer_name: 'Vikram Patel', sector: 'Logistics', dpd: 19, dpd_bucket: 'dpd_1_30', outstanding_kes: 6_800_000, overdue_kes: 1_900_000, recovery_stage: 'soft_reminder', recovery_probability: 0.81, expected_recovery_kes: 1_539_000, ptp_status: 'active', ptp_amount_kes: 1_500_000, ptp_date: '2026-06-02', assigned_collector: 'ravi.collector', last_contact_at: '2026-05-27T08:00:00.000Z', contact_attempts_30d: 1 },
  { account_id: 'acc-bd-700005', customer_id: 'c-200005', customer_name: 'Kavya Reddy', sector: 'Agro_Processing', dpd: 9, dpd_bucket: 'dpd_1_30', outstanding_kes: 4_200_000, overdue_kes: 800_000, recovery_stage: 'soft_reminder', recovery_probability: 0.88, expected_recovery_kes: 704_000, ptp_status: 'none', ptp_amount_kes: null, ptp_date: null, assigned_collector: 'ravi.collector', last_contact_at: null, contact_attempts_30d: 0 },
  { account_id: 'acc-bd-700006', customer_id: 'c-200006', customer_name: 'Arjun Iyer', sector: 'Textiles', dpd: 88, dpd_bucket: 'dpd_61_90', outstanding_kes: 22_100_000, overdue_kes: 12_900_000, recovery_stage: 'legal_notice', recovery_probability: 0.33, expected_recovery_kes: 4_257_000, ptp_status: 'none', ptp_amount_kes: null, ptp_date: null, assigned_collector: 'nina.legal', last_contact_at: '2026-05-23T16:00:00.000Z', contact_attempts_30d: 5 },
];

const __mswCollPtpOverlay = new Map<string, Array<{ recorded_at: string; recorded_by: string; amount_kes: number; promised_date: string; status: MswCollPtp; notes: string | null }>>();
const __mswCollContactOverlay = new Map<string, Array<{ contacted_at: string; contacted_by: string; channel: string; outcome: string; notes: string | null }>>();

export function __resetMswCollections() {
  __mswCollPtpOverlay.clear();
  __mswCollContactOverlay.clear();
}

const __mswCollFail = (code: string, status: number, msg: string) =>
  HttpResponse.json(
    { header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } },
    { status },
  );

const __mswCollHandlers = [
  http.get('/v1/banking/collections/summary', () => {
    const byBucket: Record<MswCollDpdBucket, { count: number; overdue_kes: number }> = {
      dpd_1_30: { count: 0, overdue_kes: 0 },
      dpd_31_60: { count: 0, overdue_kes: 0 },
      dpd_61_90: { count: 0, overdue_kes: 0 },
      dpd_90_plus: { count: 0, overdue_kes: 0 },
    };
    const byStage: Record<MswCollStage, number> = { soft_reminder: 0, hard_reminder: 0, field_visit: 0, legal_notice: 0, settlement_offer: 0 };
    let overdue = 0, expected = 0, ptpActive = 0, ptpKept = 0, ptpBroken = 0, highRisk = 0;
    for (const a of __mswCollSeed) {
      byBucket[a.dpd_bucket].count++;
      byBucket[a.dpd_bucket].overdue_kes += a.overdue_kes;
      byStage[a.recovery_stage]++;
      overdue += a.overdue_kes;
      expected += a.expected_recovery_kes;
      if (a.ptp_status === 'active') ptpActive++;
      if (a.ptp_status === 'kept') ptpKept++;
      if (a.ptp_status === 'broken') ptpBroken++;
      if (a.dpd_bucket === 'dpd_90_plus' && a.recovery_probability < 0.3) highRisk++;
    }
    const resolved = ptpKept + ptpBroken;
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        total_accounts: __mswCollSeed.length,
        total_overdue_kes: overdue,
        total_expected_recovery_kes: expected,
        recovery_rate_pct: overdue > 0 ? Math.round((expected / overdue) * 1000) / 10 : 0,
        by_dpd_bucket: byBucket,
        by_stage: byStage,
        ptp_active_count: ptpActive,
        ptp_kept_rate_pct: resolved > 0 ? Math.round((ptpKept / resolved) * 1000) / 10 : 0,
        high_risk_count: highRisk,
      }),
    );
  }),

  http.get('/v1/banking/collections/queue', ({ request }) => {
    const u = new URL(request.url);
    const dpd_bucket = u.searchParams.get('dpd_bucket');
    const stage = u.searchParams.get('stage');
    const ptp_status = u.searchParams.get('ptp_status');
    const collector = u.searchParams.get('collector');
    let rows = __mswCollSeed.slice();
    if (dpd_bucket) rows = rows.filter((a) => a.dpd_bucket === dpd_bucket);
    if (stage) rows = rows.filter((a) => a.recovery_stage === stage);
    if (ptp_status) rows = rows.filter((a) => a.ptp_status === ptp_status);
    if (collector) rows = rows.filter((a) => a.assigned_collector === collector);
    const priority = (a: MswCollAccount) => a.overdue_kes * (1 - a.recovery_probability);
    rows.sort((a, b) => priority(b) - priority(a) || b.dpd - a.dpd || a.account_id.localeCompare(b.account_id));
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        total: rows.length,
        filters_applied: { dpd_bucket: dpd_bucket ?? null, stage: stage ?? null, ptp_status: ptp_status ?? null, collector: collector ?? null },
        accounts: rows,
      }),
    );
  }),

  http.post('/v1/banking/collections/:account_id/ptp', async ({ params, request }) => {
    const id = String(params.account_id);
    if (!__mswCollSeed.some((a) => a.account_id === id)) return __mswCollFail('EWS_404_unknown_account', 404, `unknown account ${id}`);
    const b = (await request.json().catch(() => null)) as { amount_kes?: number; promised_date?: string; notes?: string } | null;
    if (!b || !Number.isFinite(b.amount_kes) || (b.amount_kes ?? 0) <= 0) return __mswCollFail('EWS_400_invalid_amount', 400, 'amount_kes must be positive');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.promised_date ?? ''))) return __mswCollFail('EWS_400_invalid_date', 400, 'promised_date must be YYYY-MM-DD');
    const entry = { recorded_at: new Date().toISOString(), recorded_by: 'admin', amount_kes: Math.round(b.amount_kes as number), promised_date: String(b.promised_date), status: 'active' as MswCollPtp, notes: b.notes?.trim() || null };
    if (!__mswCollPtpOverlay.has(id)) __mswCollPtpOverlay.set(id, []);
    __mswCollPtpOverlay.get(id)!.unshift(entry);
    return HttpResponse.json(envelope({ account_id: id, ptp: entry }), { status: 201 });
  }),

  http.post('/v1/banking/collections/:account_id/log-contact', async ({ params, request }) => {
    const id = String(params.account_id);
    if (!__mswCollSeed.some((a) => a.account_id === id)) return __mswCollFail('EWS_404_unknown_account', 404, `unknown account ${id}`);
    const b = (await request.json().catch(() => null)) as { channel?: string; outcome?: string; notes?: string } | null;
    const channels = ['call', 'sms', 'email', 'field_visit'];
    if (!b || !channels.includes(String(b.channel))) return __mswCollFail('EWS_400_invalid_channel', 400, `unknown channel ${b?.channel}`);
    if (!b.outcome || b.outcome.trim().length === 0) return __mswCollFail('EWS_400_invalid_input', 400, 'outcome required');
    const entry = { contacted_at: new Date().toISOString(), contacted_by: 'admin', channel: String(b.channel), outcome: b.outcome.trim(), notes: b.notes?.trim() || null };
    if (!__mswCollContactOverlay.has(id)) __mswCollContactOverlay.set(id, []);
    __mswCollContactOverlay.get(id)!.unshift(entry);
    return HttpResponse.json(envelope({ account_id: id, contact: entry }), { status: 201 });
  }),

  http.get('/v1/banking/collections/:account_id', ({ params }) => {
    const id = String(params.account_id);
    const base = __mswCollSeed.find((a) => a.account_id === id);
    if (!base) return __mswCollFail('EWS_404_unknown_account', 404, `unknown account ${id}`);
    const seededContacts = Array.from({ length: base.contact_attempts_30d }, (_, i) => ({
      contacted_at: new Date(Date.now() - (i * 3 + 1) * 86_400_000).toISOString(),
      contacted_by: base.assigned_collector,
      channel: ['call', 'sms', 'email', 'field_visit'][i % 4],
      outcome: ['no_answer', 'promised_payment', 'disputed', 'reachable_followup'][i % 4],
      notes: null as string | null,
    }));
    const seededPtp = base.ptp_status !== 'none' && base.ptp_amount_kes != null && base.ptp_date != null
      ? [{ recorded_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), recorded_by: base.assigned_collector, amount_kes: base.ptp_amount_kes, promised_date: base.ptp_date, status: base.ptp_status, notes: null as string | null }]
      : [];
    const ptp_history = [...(__mswCollPtpOverlay.get(id) ?? []), ...seededPtp].sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime());
    const contact_history = [...(__mswCollContactOverlay.get(id) ?? []), ...seededContacts].sort((a, b) => new Date(b.contacted_at).getTime() - new Date(a.contacted_at).getTime());
    return HttpResponse.json(
      envelope({
        ...base,
        ptp_history,
        contact_history,
        recovery_factors: [
          { factor: `DPD ${base.dpd} days (${base.dpd_bucket.replace(/_/g, ' ')})`, weight: Math.round((base.dpd / 360) * 100) / 100, direction: 'negative' },
          { factor: base.ptp_status === 'kept' ? 'PTP kept previously' : base.ptp_status === 'broken' ? 'PTP broken' : 'No active PTP', weight: base.ptp_status === 'kept' ? 0.35 : base.ptp_status === 'broken' ? 0.4 : 0.1, direction: base.ptp_status === 'kept' ? 'positive' : 'negative' },
          { factor: `${base.contact_attempts_30d} contact attempts (30d)`, weight: Math.min(0.3, base.contact_attempts_30d * 0.04), direction: base.contact_attempts_30d >= 3 ? 'positive' : 'negative' },
          { factor: `Sector: ${base.sector.replace(/_/g, ' ')}`, weight: 0.15, direction: base.sector === 'Real_Estate' || base.sector === 'Hospitality' ? 'negative' : 'positive' },
        ],
      }),
    );
  }),
];

handlers.push(...__mswCollHandlers);

// ──────────────────────────────────────────────────────────────────────
// §2.1.9 — Borrower Timeline handler (deterministic per-borrower journey).
// ──────────────────────────────────────────────────────────────────────

type MswTlType =
  | 'account_opened' | 'repayment' | 'dpd_change' | 'sma_reclassification'
  | 'rule_fired' | 'alert_raised' | 'ratio_breach' | 'bureau_update'
  | 'limit_change' | 'restructuring' | 'case_opened' | 'case_closed';
type MswTlSev = 'info' | 'warning' | 'critical';
const __MSW_TL_TYPES: MswTlType[] = ['account_opened', 'repayment', 'dpd_change', 'sma_reclassification', 'rule_fired', 'alert_raised', 'ratio_breach', 'bureau_update', 'limit_change', 'restructuring', 'case_opened', 'case_closed'];

function __mswTlHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function __mswTlRng(seed: number): () => number {
  let a = seed;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 0x100000000; };
}
const __MSW_TL_FIRST = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya'];
const __MSW_TL_LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair'];
const DAY = 86_400_000;

function __mswBuildTimeline(customer_id: string) {
  const rng = __mswTlRng(__mswTlHash(`BANK_DEMO|${customer_id}|timeline`));
  const events: Array<{ event_id: string; occurred_at: string; event_type: MswTlType; severity: MswTlSev; title: string; description: string; linked_ref: string | null; metadata: Record<string, string | number> }> = [];
  let seq = 0;
  const now = Date.now();
  const mk = (daysAgo: number, et: MswTlType, sev: MswTlSev, title: string, description: string, metadata: Record<string, string | number> = {}, linked_ref: string | null = null) => {
    events.push({ event_id: `tl-${customer_id}-${String(seq).padStart(3, '0')}`, occurred_at: new Date(now - daysAgo * DAY).toISOString(), event_type: et, severity: sev, title, description, linked_ref, metadata });
    seq++;
  };
  mk(540, 'account_opened', 'info', 'Account opened', 'Working-capital facility sanctioned.', { facility_kes: Math.round(5_000_000 + rng() * 40_000_000) });
  let dpd = 0;
  for (let m = 17; m >= 0; m--) {
    const daysAgo = m * 30 + Math.floor(rng() * 6);
    const stress = m <= 8 ? (8 - m) / 8 : 0;
    if (rng() < 0.15 + stress * 0.5) {
      dpd = Math.min(180, dpd + Math.round(10 + stress * 40 + rng() * 20));
      mk(daysAgo, 'repayment', dpd >= 60 ? 'critical' : 'warning', `Repayment delayed (${dpd} DPD)`, `EMI received late; days-past-due now ${dpd}.`, { dpd, amount_kes: Math.round(200_000 + rng() * 2_000_000) });
    } else {
      dpd = Math.max(0, dpd - Math.round(rng() * 15));
      mk(daysAgo, 'repayment', 'info', 'Repayment on time', 'EMI received on schedule.', { dpd, amount_kes: Math.round(200_000 + rng() * 2_000_000) });
    }
    if (m % 3 === 0) {
      const score = Math.round(820 - stress * 260 + (rng() - 0.5) * 40);
      mk(daysAgo + 1, 'bureau_update', 'info', 'Bureau score refreshed', `New bureau score ${score}.`, { bureau_score: score });
    }
  }
  const peak = dpd;
  if (peak >= 30) {
    mk(60, 'dpd_change', peak >= 90 ? 'critical' : 'warning', `DPD crossed ${peak >= 90 ? 90 : 30}`, `Days-past-due reached ${peak}.`, { dpd: peak });
    const stage = peak >= 90 ? 'SMA-2' : peak >= 60 ? 'SMA-1' : 'SMA-0';
    mk(58, 'sma_reclassification', 'warning', `Reclassified ${stage}`, `Account moved to ${stage} per RBI norms.`, { sma_stage: stage, dpd: peak });
    mk(72, 'ratio_breach', 'warning', 'DSCR breach', 'DSCR fell below covenant threshold.', { ratio: 'DSCR' });
    mk(45, 'rule_fired', peak >= 90 ? 'critical' : 'warning', 'Rule fired: DPD-cliff-30d', 'Indicator rule triggered.', { rule: 'DPD-cliff-30d' }, 'R-101');
    mk(40, 'alert_raised', peak >= 90 ? 'critical' : 'warning', 'EWS alert raised', 'Early-warning alert generated for review.', { severity_in: peak >= 90 ? 'CRITICAL' : 'HIGH' }, `a-${Math.floor(700000 + rng() * 9999)}`);
  }
  if (peak >= 60) mk(30, 'limit_change', 'warning', 'Credit limit reduced', 'Sanctioned limit cut precautionarily.', { delta_pct: -(10 + Math.floor(rng() * 30)) });
  if (peak >= 90) {
    mk(22, 'restructuring', 'warning', 'Restructuring proposed', 'Workout / restructuring under negotiation.', {});
    mk(14, 'case_opened', 'critical', 'Recovery case opened', 'Collections case opened for active recovery.', {}, `case-${Math.floor(600000 + rng() * 9999)}`);
  }
  events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  return { events, peak };
}

const __mswTimelineHandlers = [
  http.get('/v1/banking/borrowers/:customer_id/timeline', ({ params, request }) => {
    const customer_id = String(params.customer_id);
    const u = new URL(request.url);
    const eventType = u.searchParams.get('event_type');
    const since = u.searchParams.get('since');
    const limitRaw = u.searchParams.get('limit');
    if (eventType && !__MSW_TL_TYPES.includes(eventType as MswTlType)) {
      return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_event_type', message: `unknown event_type ${eventType}`, severity: 'MEDIUM' } }, { status: 400 });
    }
    const rng = __mswTlRng(__mswTlHash(`BANK_DEMO|${customer_id}|name`));
    const customer_name = `${__MSW_TL_FIRST[Math.floor(rng() * __MSW_TL_FIRST.length)]} ${__MSW_TL_LAST[Math.floor(rng() * __MSW_TL_LAST.length)]}`;
    const { events, peak } = __mswBuildTimeline(customer_id);
    const by_type = Object.fromEntries(__MSW_TL_TYPES.map((t) => [t, 0])) as Record<MswTlType, number>;
    const by_severity: Record<MswTlSev, number> = { info: 0, warning: 0, critical: 0 };
    for (const e of events) { by_type[e.event_type]++; by_severity[e.severity]++; }
    const band = peak >= 90 ? 'critical' : peak >= 60 ? 'high' : peak >= 30 ? 'medium' : 'low';
    const recentCut = Date.now() - 90 * DAY, priorCut = Date.now() - 180 * DAY;
    const w: Record<MswTlSev, number> = { info: -1, warning: 2, critical: 4 };
    let recent = 0, prior = 0;
    for (const e of events) { const t = new Date(e.occurred_at).getTime(); if (t >= recentCut) recent += w[e.severity]; else if (t >= priorCut) prior += w[e.severity]; }
    const trajectory = recent > prior + 2 ? 'deteriorating' : recent < prior - 2 ? 'improving' : 'stable';
    let view = events.slice();
    if (eventType) view = view.filter((e) => e.event_type === eventType);
    if (since) { const s = new Date(since).getTime(); if (Number.isFinite(s)) view = view.filter((e) => new Date(e.occurred_at).getTime() >= s); }
    const limit = limitRaw && Number.isFinite(parseInt(limitRaw, 10)) ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : 100;
    const rendered = view.slice(0, limit);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        customer_id,
        customer_name,
        generated_at: new Date().toISOString(),
        current_risk_band: band,
        trajectory,
        peak_dpd: peak,
        total_events: events.length,
        returned_count: rendered.length,
        by_type,
        by_severity,
        first_event_at: events.length ? events[events.length - 1].occurred_at : null,
        last_event_at: events.length ? events[0].occurred_at : null,
        filters_applied: { event_type: eventType ?? null, since: since ?? null, limit },
        events: rendered,
      }),
    );
  }),
];

handlers.push(...__mswTimelineHandlers);

// ──────────────────────────────────────────────────────────────────────
// §2.1.8 — Branch / Geography heatmap handlers (deterministic synthesis).
// ──────────────────────────────────────────────────────────────────────

type MswBhHeat = 'low' | 'medium' | 'high' | 'critical';
type MswBhRegion = 'North' | 'South' | 'East' | 'West' | 'Central' | 'Coastal';
const __MSW_BH_REGIONS: MswBhRegion[] = ['North', 'South', 'East', 'West', 'Central', 'Coastal'];
interface MswBranchDef { branch_id: string; branch_name: string; region: MswBhRegion; city: string }
const __MSW_BRANCHES: MswBranchDef[] = [
  { branch_id: 'BR-N-01', branch_name: 'Delhi Connaught Place', region: 'North', city: 'Delhi' },
  { branch_id: 'BR-N-02', branch_name: 'Chandigarh Sector 17', region: 'North', city: 'Chandigarh' },
  { branch_id: 'BR-N-03', branch_name: 'Jaipur MI Road', region: 'North', city: 'Jaipur' },
  { branch_id: 'BR-S-01', branch_name: 'Bengaluru MG Road', region: 'South', city: 'Bengaluru' },
  { branch_id: 'BR-S-02', branch_name: 'Chennai T Nagar', region: 'South', city: 'Chennai' },
  { branch_id: 'BR-S-03', branch_name: 'Hyderabad Banjara Hills', region: 'South', city: 'Hyderabad' },
  { branch_id: 'BR-E-01', branch_name: 'Kolkata Park Street', region: 'East', city: 'Kolkata' },
  { branch_id: 'BR-E-02', branch_name: 'Patna Boring Road', region: 'East', city: 'Patna' },
  { branch_id: 'BR-W-01', branch_name: 'Mumbai Fort', region: 'West', city: 'Mumbai' },
  { branch_id: 'BR-W-02', branch_name: 'Pune FC Road', region: 'West', city: 'Pune' },
  { branch_id: 'BR-W-03', branch_name: 'Ahmedabad CG Road', region: 'West', city: 'Ahmedabad' },
  { branch_id: 'BR-C-01', branch_name: 'Bhopal MP Nagar', region: 'Central', city: 'Bhopal' },
  { branch_id: 'BR-C-02', branch_name: 'Nagpur Sitabuldi', region: 'Central', city: 'Nagpur' },
  { branch_id: 'BR-CO-01', branch_name: 'Kochi Marine Drive', region: 'Coastal', city: 'Kochi' },
  { branch_id: 'BR-CO-02', branch_name: 'Visakhapatnam Beach Road', region: 'Coastal', city: 'Visakhapatnam' },
  { branch_id: 'BR-CO-03', branch_name: 'Goa Panaji', region: 'Coastal', city: 'Panaji' },
];
function __mswBhHash(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function __mswBhRng(seed: number): () => number { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 0x100000000; }; }
function __mswBhHeatFor(npa: number): MswBhHeat { return npa >= 8 ? 'critical' : npa >= 5 ? 'high' : npa >= 2.5 ? 'medium' : 'low'; }
const __MSW_BH_RANK: Record<MswBhHeat, number> = { critical: 0, high: 1, medium: 2, low: 3 };
function __mswBhMetrics(b: MswBranchDef, day: string) {
  const rng = __mswBhRng(__mswBhHash(`BANK_DEMO|${b.branch_id}|${day}`));
  return {
    npa_ratio_pct: Math.round(rng() * 11 * 100) / 100,
    total_customers: Math.round(30 + rng() * 180),
    total_outstanding_kes: Math.round(300_000_000 + rng() * 3_500_000_000),
    delta_30d_pct: Math.round((rng() * 4 - 2) * 100) / 100,
  };
}

const __mswBranchHandlers = [
  http.get('/v1/banking/branches/heatmap', ({ request }) => {
    const u = new URL(request.url);
    const dimension = u.searchParams.get('dimension') === 'region' ? 'region' : 'branch';
    const day = new Date().toISOString().slice(0, 10);
    const counts: Record<MswBhHeat, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    type Cell = { id: string; label: string; region: MswBhRegion; city: string | null; branch_count: number | null; npa_ratio_pct: number; total_customers: number; total_outstanding_kes: number; delta_30d_pct: number; heat_level: MswBhHeat };
    let cells: Cell[];
    if (dimension === 'branch') {
      cells = __MSW_BRANCHES.map((b) => {
        const m = __mswBhMetrics(b, day);
        return { id: b.branch_id, label: b.branch_name, region: b.region, city: b.city, branch_count: null, ...m, heat_level: __mswBhHeatFor(m.npa_ratio_pct) };
      });
    } else {
      cells = __MSW_BH_REGIONS.map((region) => {
        const branches = __MSW_BRANCHES.filter((b) => b.region === region);
        let cust = 0, out = 0, npaNum = 0, deltaNum = 0;
        for (const b of branches) { const m = __mswBhMetrics(b, day); cust += m.total_customers; out += m.total_outstanding_kes; npaNum += m.npa_ratio_pct * m.total_customers; deltaNum += m.delta_30d_pct * m.total_customers; }
        const npa = cust > 0 ? Math.round((npaNum / cust) * 100) / 100 : 0;
        return { id: region, label: region, region, city: null, branch_count: branches.length, npa_ratio_pct: npa, total_customers: cust, total_outstanding_kes: out, delta_30d_pct: cust > 0 ? Math.round((deltaNum / cust) * 100) / 100 : 0, heat_level: __mswBhHeatFor(npa) };
      });
    }
    for (const c of cells) counts[c.heat_level]++;
    cells.sort((a, b) => __MSW_BH_RANK[a.heat_level] - __MSW_BH_RANK[b.heat_level] || b.npa_ratio_pct - a.npa_ratio_pct);
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), dimension, total_cells: cells.length, by_heat_level: counts, cells }));
  }),

  http.get('/v1/banking/branches/:branch_id/deep-dive', ({ params }) => {
    const id = String(params.branch_id);
    const branch = __MSW_BRANCHES.find((b) => b.branch_id === id);
    if (!branch) return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_branch', message: `unknown branch ${id}`, severity: 'MEDIUM' } }, { status: 404 });
    const day = new Date().toISOString().slice(0, 10);
    const m = __mswBhMetrics(branch, day);
    const trend = Array.from({ length: 12 }, (_, i) => {
      const mo = new Date(); mo.setUTCMonth(mo.getUTCMonth() - (11 - i));
      const base = Math.max(0.4, m.npa_ratio_pct - 2 + i * 0.15 + (i % 3) * 0.3);
      return { month: mo.toISOString().slice(0, 7), npa_pct: Math.round(base * 100) / 100 };
    });
    trend[11].npa_pct = m.npa_ratio_pct;
    const FIRST = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram'], LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy'];
    const top = Array.from({ length: 5 }, (_, i) => { const r = __mswBhRng(__mswBhHash(`BANK_DEMO|${id}|cust|${i}`)); return { customer_id: `c-${200000 + i + Math.floor(r() * 1000)}`, name: `${FIRST[Math.floor(r() * 5)]} ${LAST[Math.floor(r() * 5)]}`, pd: Math.round((0.45 + r() * 0.5) * 100) / 100, outstanding_kes: Math.round(8_000_000 + r() * 80_000_000) }; }).sort((a, b) => b.pd - a.pd);
    const SECTORS = ['Manufacturing', 'Real_Estate', 'Retail_Trade', 'Textiles', 'Logistics', 'Hospitality'];
    const sector_mix = SECTORS.map((sector, idx) => { const r = __mswBhRng(__mswBhHash(`BANK_DEMO|${id}|sector|${idx}`)); return { sector, customers: Math.round(5 + r() * 40), npa_ratio_pct: Math.round(r() * 12 * 100) / 100 }; }).sort((a, b) => b.npa_ratio_pct - a.npa_ratio_pct);
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', branch_id: id, branch_name: branch.branch_name, region: branch.region, city: branch.city, generated_at: new Date().toISOString(), npa_ratio_pct: m.npa_ratio_pct, total_customers: m.total_customers, total_outstanding_kes: m.total_outstanding_kes, heat_level: __mswBhHeatFor(m.npa_ratio_pct), npa_trend_12m: trend, top_at_risk_customers: top, sector_mix }));
  }),

  http.get('/v1/banking/branches/:branch_id', ({ params }) => {
    const id = String(params.branch_id);
    const branch = __MSW_BRANCHES.find((b) => b.branch_id === id);
    if (!branch) return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_branch', message: `unknown branch ${id}`, severity: 'MEDIUM' } }, { status: 404 });
    const day = new Date().toISOString().slice(0, 10);
    const m = __mswBhMetrics(branch, day);
    return HttpResponse.json(envelope({ id: branch.branch_id, label: branch.branch_name, region: branch.region, city: branch.city, branch_count: null, ...m, heat_level: __mswBhHeatFor(m.npa_ratio_pct), generated_at: new Date().toISOString() }));
  }),
];

handlers.push(...__mswBranchHandlers);

// ──────────────────────────────────────────────────────────────────────
// Insurance EWS Module 9 — Policy Timeline handler (deterministic lifecycle).
// ──────────────────────────────────────────────────────────────────────

type MswPtType =
  | 'policy_issued' | 'premium_paid' | 'premium_missed' | 'grace_period' | 'renewal'
  | 'claim_filed' | 'claim_settled' | 'claim_rejected' | 'anomaly_flagged' | 'alert_raised'
  | 'underwriting_event' | 'retention_action' | 'lapse_warning' | 'reinstatement' | 'surrender';
type MswPtSev = 'info' | 'warning' | 'critical';
const __MSW_PT_TYPES: MswPtType[] = ['policy_issued', 'premium_paid', 'premium_missed', 'grace_period', 'renewal', 'claim_filed', 'claim_settled', 'claim_rejected', 'anomaly_flagged', 'alert_raised', 'underwriting_event', 'retention_action', 'lapse_warning', 'reinstatement', 'surrender'];
function __mswPtHash(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function __mswPtRng(seed: number): () => number { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 0x100000000; }; }
const __MSW_PT_FIRST = ['Asha', 'Ravi', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya'];
const __MSW_PT_LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair'];
const __MSW_PT_PRODUCTS = ['Term Life', 'Endowment', 'ULIP', 'Health Indemnity', 'Critical Illness', 'Money-Back'];
const __MSW_PT_CHANNELS = ['Agency', 'Bancassurance', 'Broker', 'Direct', 'Corporate'];
const PT_DAY = 86_400_000;

function __mswBuildPolicyTimeline(policy_id: string) {
  const rng = __mswPtRng(__mswPtHash(`BANK_DEMO|${policy_id}|timeline`));
  const now = Date.now();
  const ev: Array<{ event_id: string; occurred_at: string; event_type: MswPtType; severity: MswPtSev; title: string; description: string; linked_ref: string | null; metadata: Record<string, string | number> }> = [];
  let seq = 0;
  const mk = (daysAgo: number, t: MswPtType, sev: MswPtSev, title: string, description: string, metadata: Record<string, string | number> = {}, linked_ref: string | null = null) => {
    ev.push({ event_id: `pt-${policy_id}-${String(seq).padStart(3, '0')}`, occurred_at: new Date(now - daysAgo * PT_DAY).toISOString(), event_type: t, severity: sev, title, description, linked_ref, metadata }); seq++;
  };
  const annual = Math.round(20_000 + rng() * 480_000);
  const product = __MSW_PT_PRODUCTS[Math.floor(rng() * __MSW_PT_PRODUCTS.length)];
  mk(1095, 'policy_issued', 'info', 'Policy issued', `${product} policy underwritten and issued.`, { annual_premium_kes: annual, sum_assured_kes: annual * 20 });
  if (rng() < 0.4) mk(1093, 'underwriting_event', 'info', 'Underwriting decision', 'Medical loading applied at underwriting.', { loading_pct: Math.round(10 + rng() * 40) });
  let premiumPaid = 0, missed = 0, peak = 0, filed = 0, settled = 0;
  for (let q = 11; q >= 0; q--) {
    const daysAgo = q * 90 + Math.floor(rng() * 10);
    const stress = q <= 5 ? (5 - q) / 5 : 0;
    if (rng() < 0.1 + stress * 0.5) {
      missed++;
      mk(daysAgo, 'premium_missed', missed >= 2 ? 'critical' : 'warning', 'Premium missed', `Quarterly premium not received (streak ${missed}).`, { amount_due_kes: Math.round(annual / 4), missed_streak: missed });
      if (missed === 1) mk(daysAgo - 3, 'grace_period', 'warning', 'Grace period started', '30-day grace period in effect.', { grace_days: 30 });
    } else {
      if (missed > 0) mk(daysAgo + 1, 'reinstatement', 'info', 'Policy reinstated', 'Arrears cleared; policy reinstated.', { cleared_kes: Math.round((annual / 4) * missed) });
      missed = 0; premiumPaid += Math.round(annual / 4);
      mk(daysAgo, 'premium_paid', 'info', 'Premium paid', 'Quarterly premium received on schedule.', { amount_kes: Math.round(annual / 4) });
    }
    if (q % 4 === 0 && q !== 0) mk(daysAgo - 1, 'renewal', 'info', 'Policy renewed', 'Annual renewal processed.', { renewal_year: Math.floor(q / 4) });
  }
  const nClaims = rng() < 0.5 ? 0 : rng() < 0.85 ? 1 : 2;
  for (let c = 0; c < nClaims; c++) {
    filed++; const daysAgo = 200 - c * 90 + Math.floor(rng() * 30);
    const ref = `CLM-${Math.floor(800000 + rng() * 9999)}`, amount = Math.round(annual * (1 + rng() * 6));
    mk(daysAgo, 'claim_filed', 'info', 'Claim filed', `Claim submitted for ${product}.`, { amount_kes: amount }, ref);
    if (rng() < 0.35) {
      const score = Math.round((0.55 + rng() * 0.4) * 100) / 100; if (score > peak) peak = score;
      mk(daysAgo - 2, 'anomaly_flagged', score >= 0.75 ? 'critical' : 'warning', 'Claim anomaly flagged', `Anomaly score ${score} — amount/frequency deviation.`, { anomaly_score: score }, ref);
      mk(daysAgo - 3, 'alert_raised', score >= 0.75 ? 'critical' : 'warning', 'EWS alert raised', 'Early-warning alert generated for claims review.', { severity_in: score >= 0.75 ? 'CRITICAL' : 'HIGH' }, `a-${Math.floor(700000 + rng() * 9999)}`);
      if (score >= 0.75) mk(daysAgo - 5, 'claim_rejected', 'warning', 'Claim rejected', 'Claim repudiated pending SIU review.', { amount_kes: amount }, ref);
      else { settled++; mk(daysAgo - 10, 'claim_settled', 'info', 'Claim settled', 'Claim approved and paid.', { amount_kes: amount }, ref); }
    } else { settled++; mk(daysAgo - 8, 'claim_settled', 'info', 'Claim settled', 'Claim approved and paid.', { amount_kes: amount }, ref); }
  }
  let lapseScore = Math.min(0.95, 0.1 + missed * 0.25 + rng() * 0.2);
  let status: 'in_force' | 'lapsed' | 'surrendered' | 'matured' = 'in_force';
  if (missed >= 1) {
    mk(25, 'lapse_warning', missed >= 2 ? 'critical' : 'warning', 'Lapse warning', `Lapse probability ${Math.round(lapseScore * 100)}% — retention review triggered.`, { lapse_probability: Math.round(lapseScore * 100) / 100 });
    mk(18, 'retention_action', 'info', 'Retention call', 'Retention specialist outreach logged.', { outcome: rng() < 0.5 ? 'promised_payment' : 'no_response' });
  }
  if (missed >= 3) {
    if (rng() < 0.5) { status = 'lapsed'; lapseScore = Math.max(lapseScore, 0.8); }
    else { status = 'surrendered'; mk(6, 'surrender', 'critical', 'Policy surrendered', 'Policyholder surrendered for cash value.', { surrender_value_kes: Math.round(premiumPaid * 0.6) }); }
  }
  ev.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  return { ev, status, peak, premiumPaid, filed, settled, lapseScore };
}

const __mswPolicyTimelineHandlers = [
  http.get('/v1/insurance/policies/:policy_id/timeline', ({ params, request }) => {
    const policy_id = String(params.policy_id);
    const u = new URL(request.url);
    const eventType = u.searchParams.get('event_type');
    const since = u.searchParams.get('since');
    const limitRaw = u.searchParams.get('limit');
    if (eventType && !__MSW_PT_TYPES.includes(eventType as MswPtType)) {
      return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_event_type', message: `unknown event_type ${eventType}`, severity: 'MEDIUM' } }, { status: 400 });
    }
    const meta = __mswPtRng(__mswPtHash(`BANK_DEMO|${policy_id}|meta`));
    const policyholder_name = `${__MSW_PT_FIRST[Math.floor(meta() * __MSW_PT_FIRST.length)]} ${__MSW_PT_LAST[Math.floor(meta() * __MSW_PT_LAST.length)]}`;
    const product = __MSW_PT_PRODUCTS[Math.floor(meta() * __MSW_PT_PRODUCTS.length)];
    const channel = __MSW_PT_CHANNELS[Math.floor(meta() * __MSW_PT_CHANNELS.length)];
    const { ev, status, peak, premiumPaid, filed, settled, lapseScore } = __mswBuildPolicyTimeline(policy_id);
    const by_type = Object.fromEntries(__MSW_PT_TYPES.map((t) => [t, 0])) as Record<MswPtType, number>;
    const by_severity: Record<MswPtSev, number> = { info: 0, warning: 0, critical: 0 };
    for (const e of ev) { by_type[e.event_type]++; by_severity[e.severity]++; }
    const band = lapseScore >= 0.75 ? 'critical' : lapseScore >= 0.5 ? 'high' : lapseScore >= 0.25 ? 'medium' : 'low';
    const recentCut = Date.now() - 180 * PT_DAY, priorCut = Date.now() - 360 * PT_DAY;
    const w: Record<MswPtSev, number> = { info: -1, warning: 2, critical: 4 };
    let recent = 0, prior = 0;
    for (const e of ev) { const t = new Date(e.occurred_at).getTime(); if (t >= recentCut) recent += w[e.severity]; else if (t >= priorCut) prior += w[e.severity]; }
    const trajectory = recent > prior + 2 ? 'deteriorating' : recent < prior - 2 ? 'improving' : 'stable';
    let view = ev.slice();
    if (eventType) view = view.filter((e) => e.event_type === eventType);
    if (since) { const s = new Date(since).getTime(); if (Number.isFinite(s)) view = view.filter((e) => new Date(e.occurred_at).getTime() >= s); }
    const limit = limitRaw && Number.isFinite(parseInt(limitRaw, 10)) ? Math.max(1, Math.min(500, parseInt(limitRaw, 10))) : 100;
    const rendered = view.slice(0, limit);
    return HttpResponse.json(envelope({
      tenant_id: 'BANK_DEMO', policy_id, policyholder_name, product, channel, generated_at: new Date().toISOString(),
      policy_status: status, lapse_risk_band: band, persistency_trajectory: trajectory,
      total_premium_paid_kes: premiumPaid, claims_filed: filed, claims_settled: settled, peak_anomaly_score: peak,
      total_events: ev.length, returned_count: rendered.length, by_type, by_severity,
      first_event_at: ev.length ? ev[ev.length - 1].occurred_at : null, last_event_at: ev.length ? ev[0].occurred_at : null,
      filters_applied: { event_type: eventType ?? null, since: since ?? null, limit }, events: rendered,
    }));
  }),
];

handlers.push(...__mswPolicyTimelineHandlers);

// ──────────────────────────────────────────────────────────────────────
// Insurance EWS Module 10 — Insurance Heatmaps (reusable engine).
// ──────────────────────────────────────────────────────────────────────

type MswIhMetric = 'fraud' | 'lapse_risk' | 'channel_risk' | 'solvency_stress' | 'persistency_weakness';
type MswIhDim = 'branch' | 'region' | 'channel';
type MswIhHeat = 'low' | 'medium' | 'high' | 'critical';
const __MSW_IH_METRICS: MswIhMetric[] = ['fraud', 'lapse_risk', 'channel_risk', 'solvency_stress', 'persistency_weakness'];
const __MSW_IH_DIMS: MswIhDim[] = ['branch', 'region', 'channel'];
const __MSW_IH_REGIONS = ['North', 'South', 'East', 'West', 'Central', 'Coastal'];
const __MSW_IH_CHANNELS = ['Agency', 'Bancassurance', 'Broker', 'Direct', 'Corporate'];
const __MSW_IH_BRANCHES = [
  { id: 'IB-N-01', label: 'Delhi North LO', region: 'North' }, { id: 'IB-N-02', label: 'Jaipur LO', region: 'North' },
  { id: 'IB-S-01', label: 'Bengaluru LO', region: 'South' }, { id: 'IB-S-02', label: 'Chennai LO', region: 'South' },
  { id: 'IB-E-01', label: 'Kolkata LO', region: 'East' }, { id: 'IB-E-02', label: 'Guwahati LO', region: 'East' },
  { id: 'IB-W-01', label: 'Mumbai LO', region: 'West' }, { id: 'IB-W-02', label: 'Pune LO', region: 'West' },
  { id: 'IB-C-01', label: 'Bhopal LO', region: 'Central' }, { id: 'IB-C-02', label: 'Nagpur LO', region: 'Central' },
  { id: 'IB-CO-01', label: 'Kochi LO', region: 'Coastal' }, { id: 'IB-CO-02', label: 'Goa LO', region: 'Coastal' },
];
const __MSW_IH_HEADLINE: Record<MswIhMetric, { label: string; unit: 'count' | 'pct' | 'ratio' }> = {
  fraud: { label: 'Open fraud cases', unit: 'count' },
  lapse_risk: { label: 'Lapse rate', unit: 'pct' },
  channel_risk: { label: 'Complaint ratio', unit: 'pct' },
  solvency_stress: { label: 'Solvency ratio', unit: 'ratio' },
  persistency_weakness: { label: '13m persistency', unit: 'pct' },
};
const __MSW_IH_CATALOG = [
  { metric: 'fraud', label: 'Fraud concentration', description: 'Open fraud cases + SIU load by unit.', natural_dimension: 'branch', headline_label: 'Open fraud cases', headline_unit: 'count', higher_is_worse: true },
  { metric: 'lapse_risk', label: 'Lapse risk', description: 'Policy lapse pressure by unit.', natural_dimension: 'region', headline_label: 'Lapse rate', headline_unit: 'pct', higher_is_worse: true },
  { metric: 'channel_risk', label: 'Channel risk', description: 'Complaint + mis-sell pressure by channel.', natural_dimension: 'channel', headline_label: 'Complaint ratio', headline_unit: 'pct', higher_is_worse: true },
  { metric: 'solvency_stress', label: 'Solvency stress', description: 'Solvency-ratio headroom by unit (lower = worse).', natural_dimension: 'region', headline_label: 'Solvency ratio', headline_unit: 'ratio', higher_is_worse: false },
  { metric: 'persistency_weakness', label: 'Persistency weakness', description: '13-month persistency by unit (lower = worse).', natural_dimension: 'channel', headline_label: '13m persistency', headline_unit: 'pct', higher_is_worse: false },
];
function __mswIhHash(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function __mswIhRng(seed: number): () => number { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 0x100000000; }; }
function __mswIhHeat(score: number): MswIhHeat { return score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low'; }
const __MSW_IH_RANK: Record<MswIhHeat, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const __mswInsuranceHeatmapHandlers = [
  http.get('/v1/insurance/heatmap/metrics', () =>
    HttpResponse.json(envelope({ metrics: __MSW_IH_CATALOG, dimensions: __MSW_IH_DIMS })),
  ),
  http.get('/v1/insurance/heatmap', ({ request }) => {
    const u = new URL(request.url);
    const metric = (u.searchParams.get('metric') || 'fraud') as MswIhMetric;
    const dimension = (u.searchParams.get('dimension') || 'branch') as MswIhDim;
    if (!__MSW_IH_METRICS.includes(metric)) return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_metric', message: `unknown metric ${metric}`, severity: 'MEDIUM' } }, { status: 400 });
    if (!__MSW_IH_DIMS.includes(dimension)) return HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_dimension', message: `unknown dimension ${dimension}`, severity: 'MEDIUM' } }, { status: 400 });
    const day = new Date().toISOString().slice(0, 10);
    const headline = __MSW_IH_HEADLINE[metric];
    type Unit = { id: string; label: string; group: string | null };
    const units: Unit[] =
      dimension === 'branch' ? __MSW_IH_BRANCHES.map((b) => ({ id: b.id, label: b.label, group: b.region }))
      : dimension === 'region' ? __MSW_IH_REGIONS.map((r) => ({ id: r, label: r, group: null }))
      : __MSW_IH_CHANNELS.map((c) => ({ id: c, label: c, group: c === 'Agency' || c === 'Broker' ? 'Intermediated' : 'Direct/Partner' }));
    const counts: Record<MswIhHeat, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const cells = units.map((un) => {
      const rng = __mswIhRng(__mswIhHash(`BANK_DEMO|${metric}|${dimension}|${un.id}|${day}`));
      const base = rng();
      let headline_value: number, risk_score: number;
      if (metric === 'fraud') { const n = Math.round(base * 28); headline_value = n; risk_score = Math.round(Math.min(100, (n / 28) * 100)); }
      else if (metric === 'lapse_risk') { const p = Math.round(base * 22 * 100) / 100; headline_value = p; risk_score = Math.round(Math.min(100, (p / 22) * 100)); }
      else if (metric === 'channel_risk') { const p = Math.round(base * 9 * 100) / 100; headline_value = p; risk_score = Math.round(Math.min(100, (p / 9) * 100)); }
      else if (metric === 'solvency_stress') { const r = Math.round((1.1 + base * 1.2) * 100) / 100; headline_value = r; risk_score = Math.round(Math.min(100, Math.max(0, ((2.3 - r) / 1.2) * 100))); }
      else { const p = Math.round((55 + base * 40) * 100) / 100; headline_value = p; risk_score = Math.round(Math.min(100, Math.max(0, ((95 - p) / 40) * 100))); }
      const heat_level = __mswIhHeat(risk_score);
      counts[heat_level]++;
      return { id: un.id, label: un.label, group: un.group, risk_score, heat_level, headline_value, headline_label: headline.label, headline_unit: headline.unit, volume: Math.round(200 + rng() * 3000), delta_30d_pct: Math.round((rng() * 4 - 2) * 100) / 100 };
    });
    cells.sort((a, b) => __MSW_IH_RANK[a.heat_level] - __MSW_IH_RANK[b.heat_level] || b.risk_score - a.risk_score);
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), metric, dimension, total_cells: cells.length, by_heat_level: counts, cells }));
  }),
];

handlers.push(...__mswInsuranceHeatmapHandlers);

// ──────────────────────────────────────────────────────────────────────
// Insurance EWS Module 8 — Claim Investigation (SIU) workspace (stateful).
// ──────────────────────────────────────────────────────────────────────

type MswSiuStatus = 'triage' | 'evidence_gathering' | 'awaiting_response' | 'review' | 'decision' | 'closed';
type MswSiuDecision = 'fraud_confirmed' | 'fraud_unsubstantiated' | 'partial_fraud' | 'data_quality';
type MswSiuEvType = 'document' | 'photo' | 'statement' | 'system_record' | 'external_report';
const __MSW_SIU_STATUSES: MswSiuStatus[] = ['triage', 'evidence_gathering', 'awaiting_response', 'review', 'decision', 'closed'];
const __MSW_SIU_DECISIONS: MswSiuDecision[] = ['fraud_confirmed', 'fraud_unsubstantiated', 'partial_fraud', 'data_quality'];
const __MSW_SIU_EVTYPES: MswSiuEvType[] = ['document', 'photo', 'statement', 'system_record', 'external_report'];
const __MSW_SIU_TRANSITIONS: Record<MswSiuStatus, MswSiuStatus[]> = {
  triage: ['evidence_gathering', 'closed'],
  evidence_gathering: ['awaiting_response', 'review', 'closed'],
  awaiting_response: ['evidence_gathering', 'review', 'closed'],
  review: ['decision', 'evidence_gathering', 'closed'],
  decision: ['closed', 'review'],
  closed: ['evidence_gathering'],
};
function __mswSiuHash(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function __mswSiuRng(seed: number): () => number { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 0x100000000; }; }
const __MSW_SIU_FIRST = ['Asha', 'Ravi', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya'];
const __MSW_SIU_LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair'];
const __MSW_SIU_PRODUCTS = ['Term Life', 'Endowment', 'ULIP', 'Health Indemnity', 'Critical Illness'];
const __MSW_SIU_REASONS = ['amount_spike', 'high_frequency', 'early_claim', 'document_mismatch', 'provider_collusion', 'duplicate_claim', 'identity_mismatch'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const __mswSiuStore = new Map<string, any>(); // investigation_id → inv
let __mswSiuSeq = 0;
export function __resetMswSiu() { __mswSiuStore.clear(); __mswSiuSeq = 0; }

function __mswSiuQueue() {
  const day = new Date().toISOString().slice(0, 10);
  const openClaims = new Set<string>();
  for (const inv of __mswSiuStore.values()) if (inv.status !== 'closed') openClaims.add(inv.claim_id);
  const rows = Array.from({ length: 24 }, (_, i) => {
    const rng = __mswSiuRng(__mswSiuHash(`BANK_DEMO|siu|${i}|${day}`));
    const score = Math.round((0.5 + rng() * 0.5) * 100) / 100;
    const reasons: string[] = [];
    const nR = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < nR; k++) { const r = __MSW_SIU_REASONS[Math.floor(rng() * __MSW_SIU_REASONS.length)]; if (!reasons.includes(r)) reasons.push(r); }
    const filed = new Date(); filed.setUTCDate(filed.getUTCDate() - Math.floor(rng() * 45));
    const claim_id = `CLM-BD-${800000 + i}`;
    return { claim_id, policy_id: `POL-BANK_DEMO-${100000 + i}`, claimant_name: `${__MSW_SIU_FIRST[Math.floor(rng() * __MSW_SIU_FIRST.length)]} ${__MSW_SIU_LAST[Math.floor(rng() * __MSW_SIU_LAST.length)]}`, product: __MSW_SIU_PRODUCTS[Math.floor(rng() * __MSW_SIU_PRODUCTS.length)], claim_amount_kes: Math.round(100_000 + rng() * 4_000_000), anomaly_score: score, suspicion_reasons: reasons, filed_at: filed.toISOString(), has_open_investigation: openClaims.has(claim_id) };
  });
  rows.sort((a, b) => b.anomaly_score - a.anomaly_score || a.claim_id.localeCompare(b.claim_id));
  return rows;
}
const __mswSiuFail = (code: string, status: number, msg: string) => HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } }, { status });

const __mswSiuHandlers = [
  http.get('/v1/insurance/siu/queue', ({ request }) => {
    const u = new URL(request.url);
    const min = u.searchParams.get('min_score');
    const limitRaw = u.searchParams.get('limit');
    let rows = __mswSiuQueue();
    if (min) rows = rows.filter((r) => r.anomaly_score >= Number(min));
    if (limitRaw) rows = rows.slice(0, Math.max(1, Math.min(24, parseInt(limitRaw, 10))));
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), total: rows.length, claims: rows }));
  }),
  http.post('/v1/insurance/siu/investigations', async ({ request }) => {
    const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const claim_id = String(b?.claim_id ?? '');
    if (!claim_id) return __mswSiuFail('EWS_400_invalid_input', 400, 'claim_id required');
    for (const inv of __mswSiuStore.values()) if (inv.claim_id === claim_id && inv.status !== 'closed') return __mswSiuFail('EWS_409_investigation_already_open', 409, `claim ${claim_id} already under investigation`);
    const match = __mswSiuQueue().find((r) => r.claim_id === claim_id);
    const ts = new Date().toISOString();
    const inv = {
      investigation_id: `siu-BANK_DEMO-${ts.slice(0, 10)}-${String(__mswSiuSeq++).padStart(4, '0')}`,
      tenant_id: 'BANK_DEMO', claim_id, policy_id: (b?.policy_id as string) ?? match?.policy_id ?? 'POL-unknown',
      claimant_name: (b?.claimant_name as string) ?? match?.claimant_name ?? 'Unknown', product: (b?.product as string) ?? match?.product ?? 'Unknown',
      claim_amount_kes: (b?.claim_amount_kes as number) ?? match?.claim_amount_kes ?? 0, anomaly_score: (b?.anomaly_score as number) ?? match?.anomaly_score ?? 0,
      suspicion_reasons: (b?.suspicion_reasons as string[]) ?? match?.suspicion_reasons ?? [], status: 'triage' as MswSiuStatus, decision: null as MswSiuDecision | null,
      escalated: false, opened_at: ts, opened_by: 'admin', last_updated_at: ts, last_updated_by: 'admin', closed_at: null as string | null, notes: [] as unknown[], evidence: [] as unknown[], linked_alerts: [] as string[],
    };
    __mswSiuStore.set(inv.investigation_id, inv);
    return HttpResponse.json(envelope(inv), { status: 201 });
  }),
  http.get('/v1/insurance/siu/investigations', ({ request }) => {
    const u = new URL(request.url);
    const status = u.searchParams.get('status') as MswSiuStatus | null;
    let items = Array.from(__mswSiuStore.values());
    if (status) items = items.filter((i) => i.status === status);
    items.sort((a, b) => b.anomaly_score - a.anomaly_score || b.opened_at.localeCompare(a.opened_at));
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', total: items.length, items }));
  }),
  http.get('/v1/insurance/siu/investigations/:id', ({ params }) => {
    const inv = __mswSiuStore.get(String(params.id));
    if (!inv) return __mswSiuFail('EWS_404_unknown_investigation', 404, `unknown investigation ${params.id}`);
    return HttpResponse.json(envelope(inv));
  }),
  http.patch('/v1/insurance/siu/investigations/:id/status', async ({ params, request }) => {
    const inv = __mswSiuStore.get(String(params.id));
    if (!inv) return __mswSiuFail('EWS_404_unknown_investigation', 404, `unknown investigation ${params.id}`);
    const b = (await request.json().catch(() => null)) as { status?: string; decision?: string | null } | null;
    const to = String(b?.status ?? '') as MswSiuStatus;
    if (!__MSW_SIU_STATUSES.includes(to)) return __mswSiuFail('EWS_400_invalid_status', 400, `unknown status ${to}`);
    if (!(__MSW_SIU_TRANSITIONS[inv.status as MswSiuStatus] ?? []).includes(to)) return __mswSiuFail('EWS_409_invalid_transition', 409, `cannot move ${inv.status} → ${to}`);
    const decision = b?.decision != null ? (String(b.decision) as MswSiuDecision) : null;
    if (decision != null && !__MSW_SIU_DECISIONS.includes(decision)) return __mswSiuFail('EWS_400_invalid_decision', 400, `unknown decision ${decision}`);
    if (to === 'closed' && inv.status === 'decision' && decision == null && inv.decision == null) return __mswSiuFail('EWS_409_decision_required', 409, 'a decision is required to close');
    if (decision != null) inv.decision = decision;
    inv.closed_at = to === 'closed' ? new Date().toISOString() : null;
    inv.status = to; inv.last_updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(inv));
  }),
  http.post('/v1/insurance/siu/investigations/:id/notes', async ({ params, request }) => {
    const inv = __mswSiuStore.get(String(params.id));
    if (!inv) return __mswSiuFail('EWS_404_unknown_investigation', 404, `unknown investigation ${params.id}`);
    const b = (await request.json().catch(() => null)) as { body?: string } | null;
    if (!b?.body || b.body.trim().length === 0) return __mswSiuFail('EWS_400_invalid_input', 400, 'note body required');
    inv.notes.push({ note_id: `note-${String(inv.notes.length).padStart(3, '0')}`, ts: new Date().toISOString(), author: 'admin', body: b.body.trim() });
    inv.last_updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(inv), { status: 201 });
  }),
  http.post('/v1/insurance/siu/investigations/:id/evidence', async ({ params, request }) => {
    const inv = __mswSiuStore.get(String(params.id));
    if (!inv) return __mswSiuFail('EWS_404_unknown_investigation', 404, `unknown investigation ${params.id}`);
    const b = (await request.json().catch(() => null)) as { type?: string; title?: string; description?: string; attachment_ref?: string } | null;
    if (!b || !__MSW_SIU_EVTYPES.includes(b.type as MswSiuEvType)) return __mswSiuFail('EWS_400_invalid_evidence_type', 400, `unknown evidence type ${b?.type}`);
    if (!b.title || b.title.trim().length === 0) return __mswSiuFail('EWS_400_invalid_input', 400, 'evidence title required');
    inv.evidence.push({ evidence_id: `ev-${String(inv.evidence.length).padStart(3, '0')}`, type: b.type, title: b.title.trim(), description: (b.description ?? '').trim(), attachment_ref: b.attachment_ref?.trim() || null, added_at: new Date().toISOString(), added_by: 'admin' });
    inv.last_updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(inv), { status: 201 });
  }),
  http.post('/v1/insurance/siu/investigations/:id/escalate', ({ params }) => {
    const inv = __mswSiuStore.get(String(params.id));
    if (!inv) return __mswSiuFail('EWS_404_unknown_investigation', 404, `unknown investigation ${params.id}`);
    inv.escalated = true; inv.last_updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(inv));
  }),
  http.post('/v1/insurance/siu/investigations/:id/link-alert', async ({ params, request }) => {
    const inv = __mswSiuStore.get(String(params.id));
    if (!inv) return __mswSiuFail('EWS_404_unknown_investigation', 404, `unknown investigation ${params.id}`);
    const b = (await request.json().catch(() => null)) as { alert_id?: string } | null;
    if (!b?.alert_id) return __mswSiuFail('EWS_400_invalid_input', 400, 'alert_id required');
    if (!inv.linked_alerts.includes(b.alert_id.trim())) inv.linked_alerts.push(b.alert_id.trim());
    inv.last_updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(inv), { status: 201 });
  }),
];

handlers.push(...__mswSiuHandlers);

// ──────────────────────────────────────────────────────────────────────
// T7 Module 10 — Experiment Tracking handlers (stateful in-memory)
// ──────────────────────────────────────────────────────────────────────
const __MSW_EXP_STATUSES = ['running', 'completed', 'failed', 'archived'] as const;
type MswExpStatus = (typeof __MSW_EXP_STATUSES)[number];
const __MSW_EXP_TRANSITIONS: Record<MswExpStatus, MswExpStatus[]> = {
  running: ['completed', 'failed'],
  completed: ['archived'],
  failed: ['archived'],
  archived: [],
};
const __MSW_EXP_DOMAINS = ['banking', 'insurance'];
const __MSW_EXP_MODEL_TYPES = ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'];
const __MSW_EXP_OUTCOMES = ['promoted', 'rejected', 'inconclusive'];

const __mswExpStore = new Map<string, any>(); // experiment_id → row
let __mswExpSeq = 0;
export function __resetMswExperiments() { __mswExpStore.clear(); __mswExpSeq = 0; }

// Seed a couple of deterministic runs so the page renders data on first load.
function __mswExpSeed() {
  if (__mswExpStore.size > 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const mk = (over: Record<string, unknown>): any => {
    const ts = new Date().toISOString();
    const id = `exp-BANK_DEMO-${day}-${String(++__mswExpSeq).padStart(4, '0')}`;
    const row: any = {
      experiment_id: id, tenant_id: 'BANK_DEMO', status: 'running' as MswExpStatus, outcome: null,
      params: {}, metrics: {}, notes: null, started_at: ts, completed_at: null, created_at: ts, updated_at: ts,
      ...over,
    };
    __mswExpStore.set(id, row);
    return row;
  };
  const a = mk({ name: 'XGBoost PD v4 depth sweep', domain: 'banking', model_type: 'pd', dataset_ref: 'mart.customer_360@2026-Q1', dataset_rows: 12000, params: { max_depth: 6, n_estimators: 400, learning_rate: 0.05 }, metrics: { auc: 0.842, precision: 0.71, recall: 0.64 }, owner: 'dsci.alice' });
  a.status = 'completed'; a.completed_at = a.started_at; a.outcome = 'promoted';
  const b = mk({ name: 'Lapse LightGBM persistency features', domain: 'insurance', model_type: 'lapse', dataset_ref: 'mart.policy_360@2026-Q1', dataset_rows: 8400, params: { num_leaves: 31, max_depth: 8 }, metrics: { auc: 0.808, precision: 0.66 }, owner: 'dsci.bob' });
  b.status = 'completed'; b.completed_at = b.started_at;
  mk({ name: 'Fraud isolation-forest contamination grid', domain: 'banking', model_type: 'fraud', dataset_ref: 'mart.txn_features@2026-Q1', dataset_rows: 21000, params: { contamination: 0.02 }, metrics: {}, owner: 'dsci.alice' });
}

const __mswExpFail = (code: string, status: number, msg: string) =>
  HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } }, { status });

function __mswExpSummary() {
  const rows = Array.from(__mswExpStore.values());
  const by_status: Record<string, number> = { running: 0, completed: 0, failed: 0, archived: 0 };
  const by_domain: Record<string, number> = { banking: 0, insurance: 0 };
  const by_model_type: Record<string, number> = { pd: 0, fraud: 0, churn: 0, lapse: 0, anomaly: 0, claim_severity: 0 };
  const by_outcome: Record<string, number> = { promoted: 0, rejected: 0, inconclusive: 0 };
  let pending_outcome_count = 0;
  let best_auc: { experiment_id: string; name: string; auc: number } | null = null;
  let most_recent_at: string | null = null;
  for (const e of rows) {
    by_status[e.status] = (by_status[e.status] ?? 0) + 1;
    by_domain[e.domain] = (by_domain[e.domain] ?? 0) + 1;
    by_model_type[e.model_type] = (by_model_type[e.model_type] ?? 0) + 1;
    if (e.outcome) by_outcome[e.outcome] = (by_outcome[e.outcome] ?? 0) + 1;
    const resolved = e.status === 'completed' || e.status === 'archived';
    if (resolved && e.outcome === null) pending_outcome_count++;
    if (resolved && typeof e.metrics?.auc === 'number' && (best_auc === null || e.metrics.auc > best_auc.auc)) best_auc = { experiment_id: e.experiment_id, name: e.name, auc: e.metrics.auc };
    if (most_recent_at === null || e.started_at > most_recent_at) most_recent_at = e.started_at;
  }
  return { tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), total: rows.length, by_status, by_domain, by_model_type, by_outcome, pending_outcome_count, best_auc, most_recent_at };
}

const __mswExperimentHandlers = [
  http.get('/v1/ai/experiments/summary', () => {
    __mswExpSeed();
    return HttpResponse.json(envelope(__mswExpSummary()));
  }),
  http.get('/v1/ai/experiments', ({ request }) => {
    __mswExpSeed();
    const u = new URL(request.url);
    let rows = Array.from(__mswExpStore.values());
    const domain = u.searchParams.get('domain');
    const status = u.searchParams.get('status');
    const model_type = u.searchParams.get('model_type');
    const owner = u.searchParams.get('owner');
    if (domain) rows = rows.filter((e) => e.domain === domain);
    if (status) rows = rows.filter((e) => e.status === status);
    if (model_type) rows = rows.filter((e) => e.model_type === model_type);
    if (owner) rows = rows.filter((e) => e.owner === owner);
    rows.sort((a, b) => b.started_at.localeCompare(a.started_at) || b.experiment_id.localeCompare(a.experiment_id));
    return HttpResponse.json(envelope({ items: rows, page: 1, page_size: 50, total: rows.length, page_size_default: 50, page_size_max: 200 }));
  }),
  http.post('/v1/ai/experiments', async ({ request }) => {
    const b = (await request.json().catch(() => null)) as Record<string, any> | null;
    const name = String(b?.name ?? '').trim();
    if (!name) return __mswExpFail('EWS_400_invalid_input', 400, 'name required');
    if (!__MSW_EXP_DOMAINS.includes(String(b?.domain))) return __mswExpFail('EWS_400_invalid_input', 400, 'domain must be banking|insurance');
    if (!__MSW_EXP_MODEL_TYPES.includes(String(b?.model_type))) return __mswExpFail('EWS_400_invalid_input', 400, 'model_type out of enum');
    if (!String(b?.dataset_ref ?? '').trim()) return __mswExpFail('EWS_400_invalid_input', 400, 'dataset_ref required');
    const ts = new Date().toISOString();
    const id = `exp-BANK_DEMO-${ts.slice(0, 10)}-${String(++__mswExpSeq).padStart(4, '0')}`;
    const row = {
      experiment_id: id, tenant_id: 'BANK_DEMO', name, domain: b!.domain, model_type: b!.model_type,
      status: 'running' as MswExpStatus, dataset_ref: String(b!.dataset_ref).trim(),
      dataset_rows: typeof b!.dataset_rows === 'number' ? b!.dataset_rows : 0,
      params: b!.params ?? {}, metrics: b!.metrics ?? {}, outcome: null,
      owner: String(b!.owner ?? 'analyst'), notes: b!.notes != null ? String(b!.notes) : null,
      started_at: ts, completed_at: null, created_at: ts, updated_at: ts,
    };
    __mswExpStore.set(id, row);
    return HttpResponse.json(envelope(row), { status: 201 });
  }),
  http.get('/v1/ai/experiments/:id', ({ params }) => {
    const row = __mswExpStore.get(String(params.id));
    if (!row) return __mswExpFail('EWS_404_unknown_experiment', 404, `unknown experiment ${params.id}`);
    return HttpResponse.json(envelope(row));
  }),
  http.patch('/v1/ai/experiments/:id/status', async ({ params, request }) => {
    const row = __mswExpStore.get(String(params.id));
    if (!row) return __mswExpFail('EWS_404_unknown_experiment', 404, `unknown experiment ${params.id}`);
    const b = (await request.json().catch(() => null)) as { status?: string } | null;
    const to = String(b?.status ?? '') as MswExpStatus;
    if (!__MSW_EXP_STATUSES.includes(to)) return __mswExpFail('EWS_400_invalid_status', 400, `unknown status ${to}`);
    if (!(__MSW_EXP_TRANSITIONS[row.status as MswExpStatus] ?? []).includes(to)) return __mswExpFail('EWS_409_invalid_transition', 409, `cannot move ${row.status} → ${to}`);
    row.status = to;
    if (to === 'completed' || to === 'failed') row.completed_at = row.completed_at ?? new Date().toISOString();
    row.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(row));
  }),
  http.patch('/v1/ai/experiments/:id/outcome', async ({ params, request }) => {
    const row = __mswExpStore.get(String(params.id));
    if (!row) return __mswExpFail('EWS_404_unknown_experiment', 404, `unknown experiment ${params.id}`);
    const b = (await request.json().catch(() => null)) as { outcome?: string } | null;
    const outcome = String(b?.outcome ?? '');
    if (!__MSW_EXP_OUTCOMES.includes(outcome)) return __mswExpFail('EWS_400_invalid_outcome', 400, `unknown outcome ${outcome}`);
    if (row.status === 'running') return __mswExpFail('EWS_409_outcome_requires_completion', 409, 'experiment must be resolved first');
    row.outcome = outcome; row.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(row));
  }),
];

handlers.push(...__mswExperimentHandlers);

// ──────────────────────────────────────────────────────────────────────
// T7 Module 7 — Drift Detection handlers (deterministic synth + history)
// ──────────────────────────────────────────────────────────────────────
const __MSW_DRIFT_MODELS: { model_id: string; model_type: string; version: string; baseline_auc: number | null; features: { name: string; type: 'numeric' | 'categorical' }[] }[] = [
  { model_id: 'pd_xgb_v3', model_type: 'pd', version: 'v3', baseline_auc: 0.847, features: [{ name: 'utilization', type: 'numeric' }, { name: 'dpd_max_90d', type: 'numeric' }, { name: 'bureau_score', type: 'numeric' }, { name: 'repayment_delay_streak', type: 'numeric' }, { name: 'txn_volume_zscore_90d', type: 'numeric' }, { name: 'tenure_months', type: 'numeric' }, { name: 'product_level', type: 'categorical' }, { name: 'income_level', type: 'categorical' }] },
  { model_id: 'fraud_lgbm_v1', model_type: 'fraud', version: 'v1', baseline_auc: 0.891, features: [{ name: 'utilization', type: 'numeric' }, { name: 'dpd_max_90d', type: 'numeric' }, { name: 'bureau_score', type: 'numeric' }, { name: 'txn_volume_zscore_90d', type: 'numeric' }, { name: 'product_level', type: 'categorical' }] },
  { model_id: 'churn_xgb_v1', model_type: 'churn', version: 'v1', baseline_auc: 0.782, features: [{ name: 'tenure_months', type: 'numeric' }, { name: 'utilization', type: 'numeric' }, { name: 'income_level', type: 'categorical' }] },
  { model_id: 'lapse_xgb_v1', model_type: 'lapse', version: 'v1', baseline_auc: 0.804, features: [{ name: 'premium_to_sum_assured', type: 'numeric' }, { name: 'days_since_last_premium', type: 'numeric' }, { name: 'policy_age_months', type: 'numeric' }, { name: 'agent_persistency', type: 'numeric' }, { name: 'product_category', type: 'categorical' }] },
  { model_id: 'anomaly_if_v2', model_type: 'anomaly', version: 'v2', baseline_auc: null, features: [{ name: 'txn_volume_zscore_90d', type: 'numeric' }, { name: 'utilization', type: 'numeric' }] },
];
const __mswPsiBand = (psi: number) => (psi < 0.1 ? 'stable' : psi < 0.25 ? 'warn' : 'drift');
const __mswWorstBand = (bands: string[]) => bands.reduce((acc, b) => (['stable', 'warn', 'drift'].indexOf(b) > ['stable', 'warn', 'drift'].indexOf(acc) ? b : acc), 'stable');
const __mswDriftRound = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;
const __mswDriftStore = new Map<string, any[]>(); // tenant::model → newest-first snapshots
let __mswDriftSeq = 0;
export function __resetMswDrift() { __mswDriftStore.clear(); __mswDriftSeq = 0; }

function __mswBuildDrift(tenant: string, m: (typeof __MSW_DRIFT_MODELS)[number], salt = '') {
  const day = new Date().toISOString().slice(0, 10);
  const rng = __mswSiuRng(__mswSiuHash(`${tenant}|drift|${m.model_id}|${day}|${salt}`));
  const stress = rng();
  const features = m.features.map((f) => {
    const r = rng();
    let psi = r * 0.06;
    if (r > 0.78) psi += stress * 0.18;
    if (r > 0.94) psi += stress * 0.22;
    psi = __mswDriftRound(Math.max(0, psi));
    return { feature: f.name, psi, band: __mswPsiBand(psi), feature_type: f.type };
  });
  const max_psi = features.reduce((mx, f) => Math.max(mx, f.psi), 0);
  const worst = features.reduce<any>((acc, f) => (acc === null || f.psi > acc.psi ? f : acc), null);
  const data_drift = { features, drifted_count: features.filter((f) => f.band === 'drift').length, warn_count: features.filter((f) => f.band === 'warn').length, max_psi: __mswDriftRound(max_psi), worst_feature: worst && worst.psi > 0 ? worst.feature : null };
  const ks_stat = __mswDriftRound(0.02 + rng() * 0.04 + stress * 0.12);
  const p_value = __mswDriftRound(Math.max(0.0001, (1 - stress) * (0.2 + rng() * 0.6)));
  const model_drift = { ks_stat, p_value, drifted: p_value < 0.01 && ks_stat > 0.1 };
  let performance_drift: any;
  if (m.baseline_auc === null) {
    performance_drift = { current_auc: null, baseline_auc: null, delta: null, drifted: false };
  } else {
    const delta = __mswDriftRound(-(stress * 0.06) + (rng() - 0.5) * 0.01);
    const current_auc = __mswDriftRound(Math.max(0.5, Math.min(0.999, m.baseline_auc + delta)));
    performance_drift = { current_auc, baseline_auc: m.baseline_auc, delta, drifted: delta < -0.03 };
  }
  const baseline_rate = __mswDriftRound(8 + rng() * 6, 2);
  const ratio = __mswDriftRound(0.85 + rng() * 0.5 + stress * 1.1, 3);
  const anomaly_spike = { baseline_rate, current_rate: __mswDriftRound(baseline_rate * ratio, 2), ratio, spiked: ratio > 1.5 };
  const overall_status = __mswWorstBand([__mswWorstBand(features.map((f) => f.band)), model_drift.drifted ? 'drift' : 'stable', performance_drift.drifted ? 'warn' : 'stable', anomaly_spike.spiked ? 'warn' : 'stable']);
  return { snapshot_id: `drift-${tenant}-${m.model_id}-${day}${salt ? '-' + salt : ''}`, tenant_id: tenant, model_id: m.model_id, model_type: m.model_type, model_version: m.version, computed_at: new Date().toISOString(), reference_window: 'training', current_window: 'last_7d', overall_status, data_drift, model_drift, performance_drift, anomaly_spike };
}
function __mswDriftLatest(tenant: string, model_id: string) {
  const m = __MSW_DRIFT_MODELS.find((x) => x.model_id === model_id);
  if (!m) return null;
  const k = `${tenant}::${model_id}`;
  const arr = __mswDriftStore.get(k);
  if (arr && arr.length) return arr[0];
  const snap = __mswBuildDrift(tenant, m);
  __mswDriftStore.set(k, [snap]);
  return snap;
}
const __mswDriftFail = (code: string, status: number, msg: string) =>
  HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } }, { status });

const __mswDriftHandlers = [
  http.get('/v1/ai/drift', () => {
    const models = __MSW_DRIFT_MODELS.map((m) => __mswDriftLatest('BANK_DEMO', m.model_id));
    const by_status: Record<string, number> = { stable: 0, warn: 0, drift: 0 };
    let worst_offender: any = null;
    for (const s of models) {
      by_status[s!.overall_status]++;
      const rank = ['stable', 'warn', 'drift'].indexOf(s!.overall_status);
      if (worst_offender === null || rank > ['stable', 'warn', 'drift'].indexOf(worst_offender.overall_status) || (rank === ['stable', 'warn', 'drift'].indexOf(worst_offender.overall_status) && s!.data_drift.max_psi > worst_offender.max_psi)) {
        worst_offender = { model_id: s!.model_id, overall_status: s!.overall_status, max_psi: s!.data_drift.max_psi };
      }
    }
    if (worst_offender && worst_offender.overall_status === 'stable') worst_offender = null;
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), total_models: models.length, by_status, models_needing_attention: by_status.warn + by_status.drift, worst_offender, models }));
  }),
  http.get('/v1/ai/drift/:model_id/history', ({ params, request }) => {
    if (!__MSW_DRIFT_MODELS.find((x) => x.model_id === String(params.model_id))) return __mswDriftFail('EWS_404_unknown_model', 404, `unknown model ${params.model_id}`);
    const u = new URL(request.url);
    const limit = Math.min(Math.max(1, parseInt(u.searchParams.get('limit') ?? '20', 10) || 20), 50);
    const arr = __mswDriftStore.get(`BANK_DEMO::${params.model_id}`) ?? [];
    return HttpResponse.json(envelope({ model_id: params.model_id, total: Math.min(arr.length, limit), items: arr.slice(0, limit) }));
  }),
  http.post('/v1/ai/drift/:model_id/recompute', ({ params }) => {
    const m = __MSW_DRIFT_MODELS.find((x) => x.model_id === String(params.model_id));
    if (!m) return __mswDriftFail('EWS_404_unknown_model', 404, `unknown model ${params.model_id}`);
    const snap = __mswBuildDrift('BANK_DEMO', m, `r${++__mswDriftSeq}`);
    const k = `BANK_DEMO::${m.model_id}`;
    const arr = __mswDriftStore.get(k) ?? [];
    arr.unshift(snap);
    __mswDriftStore.set(k, arr);
    return HttpResponse.json(envelope(snap), { status: 201 });
  }),
  http.get('/v1/ai/drift/:model_id', ({ params }) => {
    const snap = __mswDriftLatest('BANK_DEMO', String(params.model_id));
    if (!snap) return __mswDriftFail('EWS_404_unknown_model', 404, `unknown model ${params.model_id}`);
    return HttpResponse.json(envelope(snap));
  }),
];

handlers.push(...__mswDriftHandlers);

// ──────────────────────────────────────────────────────────────────────
// T7 Module 9 — AI Insight Panels handlers (deterministic synth)
// ──────────────────────────────────────────────────────────────────────
const __MSW_INSIGHT_DEFS: { insight_id: string; title: string; description: string; category: string; domain: string; model_ref: string; prefix: string; label: (s: number) => string; reasons: string[] }[] = [
  { insight_id: 'top_risky_borrowers', title: 'Top risky borrowers', description: 'Customers with the highest model-estimated PD this cycle.', category: 'risk', domain: 'banking', model_ref: 'pd_xgb_v3', prefix: 'CUST', label: (s) => `PD ${s.toFixed(2)}`, reasons: ['DPD breach + utilisation spike', 'bureau score drop > 40pts', 'repeated min-payments', 'income volatility flag', 'cross-product exposure rising'] },
  { insight_id: 'fraud_anomaly_highlights', title: 'Fraud anomaly highlights', description: 'Transactions flagged anomalous in the last window.', category: 'fraud', domain: 'banking', model_ref: 'fraud_lgbm_v1', prefix: 'TXN', label: (s) => `anomaly ${s.toFixed(2)}`, reasons: ['geo-velocity impossible travel', 'device fingerprint change', 'sudden withdrawal spike', 'salary credit disappeared', 'channel switch anomaly'] },
  { insight_id: 'lapse_prediction_insights', title: 'Lapse prediction insights', description: 'Policies most likely to lapse in the next 30 days.', category: 'retention', domain: 'insurance', model_ref: 'lapse_xgb_v1', prefix: 'POL', label: (s) => `lapse ${Math.round(s * 100)}%`, reasons: ['premium overdue > 15d', 'grace period entered', 'agent left the book', 'first-year policy', 'auto-debit bounce'] },
  { insight_id: 'persistency_risk', title: 'Persistency risk (agents)', description: 'Agent books with weakening 13-month persistency.', category: 'retention', domain: 'insurance', model_ref: 'persistency_signal', prefix: 'AGT', label: (s) => `risk ${s.toFixed(2)}`, reasons: ['persistency below branch median', 'cancellation cluster', 'mis-selling complaint', 'payout-ratio drift', 'new-business quality dip'] },
  { insight_id: 'claim_fraud_highlights', title: 'Claim fraud highlights', description: 'Claims scored most suspicious for SIU triage.', category: 'fraud', domain: 'insurance', model_ref: 'claim_anomaly', prefix: 'CLM', label: (s) => `anomaly ${s.toFixed(2)}`, reasons: ['waiting-period breach', 'repeat reason < 180d', 'amount deviation > 30%', 'flagged hospital', 'rapid policy-to-claim'] },
  { insight_id: 'unusual_trends', title: 'Unusual trends', description: 'Emerging aggregate anomalies across portfolios.', category: 'trend', domain: 'cross', model_ref: 'trend_monitor', prefix: 'SIG', label: (s) => `z ${(s * 4).toFixed(1)}`, reasons: ['NPA inflow accelerating in SME', 'fraud rate up in digital channel', 'lapse spike in unit-linked', 'collections promise-to-pay falling', 'utilisation creeping in retail cards'] },
];
export function __resetMswInsights() { /* stateless synth — no-op */ }
const __mswInsRound = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const __mswInsSeverity = (s: number) => (s >= 0.85 ? 'critical' : s >= 0.7 ? 'high' : s >= 0.5 ? 'medium' : 'info');

function __mswBuildInsight(tenant: string, def: (typeof __MSW_INSIGHT_DEFS)[number]) {
  const day = new Date().toISOString().slice(0, 10);
  const rng = __mswSiuRng(__mswSiuHash(`${tenant}|insight|${def.insight_id}|${day}`));
  const n = 4 + Math.floor(rng() * 4);
  const items: any[] = [];
  for (let i = 0; i < n; i++) {
    const score = __mswInsRound(Math.min(0.99, 0.45 + rng() * 0.5), 4);
    const tr = rng();
    items.push({ entity_id: `${def.prefix}-${tenant === 'BANK_DEMO' ? 'BD' : tenant.slice(0, 3).toUpperCase()}-${100000 + Math.floor(rng() * 900000)}`, entity_label: `${def.prefix} ${100000 + i}`, score, score_label: def.label(score), reason: def.reasons[Math.floor(rng() * def.reasons.length)], trend: tr > 0.6 ? 'up' : tr > 0.25 ? 'flat' : 'down', delta: __mswInsRound((rng() - 0.4) * 0.2, 4) });
  }
  items.sort((a, b) => b.score - a.score || a.entity_id.localeCompare(b.entity_id));
  const top = items[0];
  return { insight_id: def.insight_id, tenant_id: tenant, title: def.title, description: def.description, category: def.category, domain: def.domain, severity: __mswInsSeverity(top.score), model_ref: def.model_ref, confidence: __mswInsRound(0.7 + rng() * 0.28, 4), headline: `${n} items — top signal ${top.score.toFixed(2)}`, generated_at: new Date().toISOString(), item_count: n, items };
}
const __mswInsFail = (code: string, status: number, msg: string) =>
  HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } }, { status });

const __mswInsightHandlers = [
  http.get('/v1/ai/insights/catalog', () =>
    HttpResponse.json(envelope({ total: __MSW_INSIGHT_DEFS.length, insights: __MSW_INSIGHT_DEFS.map((d) => ({ insight_id: d.insight_id, title: d.title, category: d.category, domain: d.domain, model_ref: d.model_ref })) })),
  ),
  http.get('/v1/ai/insights', ({ request }) => {
    const u = new URL(request.url);
    const category = u.searchParams.get('category');
    const domain = u.searchParams.get('domain');
    const severity = u.searchParams.get('severity');
    if (severity && !['critical', 'high', 'medium', 'info'].includes(severity)) return __mswInsFail('EWS_400_invalid_input', 400, `unknown severity ${severity}`);
    if (category && !['risk', 'fraud', 'retention', 'trend'].includes(category)) return __mswInsFail('EWS_400_invalid_input', 400, `unknown category ${category}`);
    if (domain && !['banking', 'insurance', 'cross'].includes(domain)) return __mswInsFail('EWS_400_invalid_input', 400, `unknown domain ${domain}`);
    let defs = __MSW_INSIGHT_DEFS;
    if (category) defs = defs.filter((d) => d.category === category);
    if (domain) defs = defs.filter((d) => d.domain === domain);
    let insights = defs.map((d) => __mswBuildInsight('BANK_DEMO', d));
    if (severity) insights = insights.filter((i) => i.severity === severity);
    const by_category: Record<string, number> = { risk: 0, fraud: 0, retention: 0, trend: 0 };
    const by_severity: Record<string, number> = { critical: 0, high: 0, medium: 0, info: 0 };
    for (const i of insights) { by_category[i.category]++; by_severity[i.severity]++; }
    const sevRank: Record<string, number> = { critical: 3, high: 2, medium: 1, info: 0 };
    insights.sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || a.insight_id.localeCompare(b.insight_id));
    const top = insights[0] ?? null;
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), total: insights.length, by_category, by_severity, top_insight: top ? { insight_id: top.insight_id, title: top.title, severity: top.severity } : null, insights }));
  }),
  http.get('/v1/ai/insights/:insight_id', ({ params }) => {
    const def = __MSW_INSIGHT_DEFS.find((d) => d.insight_id === String(params.insight_id));
    if (!def) return __mswInsFail('EWS_404_unknown_insight', 404, `unknown insight ${params.insight_id}`);
    return HttpResponse.json(envelope(__mswBuildInsight('BANK_DEMO', def)));
  }),
];

handlers.push(...__mswInsightHandlers);

// ──────────────────────────────────────────────────────────────────────
// T7 Module 8 — Prediction Audit Logs handlers (stateful append-only)
// ──────────────────────────────────────────────────────────────────────
const __MSW_PREDLOG_ACTIONS = ['created', 'viewed', 'acknowledged', 'overridden', 'escalated', 'dismissed', 'alert_triggered', 'feedback_recorded'];
const __mswPredLog: any[] = []; // append-only, tenant BANK_DEMO in dev
let __mswPredLogSeq = 0;
let __mswPredLogSeeded = false;
export function __resetMswPredictionLogs() { __mswPredLog.length = 0; __mswPredLogSeq = 0; __mswPredLogSeeded = false; }

function __mswPredLogMintId() {
  const n = (++__mswPredLogSeq).toString(16).padStart(12, '0');
  return `aaaaaaaa-bbbb-4ccc-8ddd-${n}`;
}
// Seed a short trail for any prediction the Explainability page loads, so the
// audit panel renders data without the operator having to act first.
function __mswPredLogSeedFor(pid: string) {
  if (__mswPredLog.some((e) => e.prediction_id === pid)) return;
  const base = Date.now() - 3600_000;
  const mk = (action: string, actor: string, offsetMin: number, extra: Record<string, unknown> = {}) => ({
    log_id: __mswPredLogMintId(), tenant_id: 'BANK_DEMO', prediction_id: pid, model_id: 'pd_xgb_v3', model_version: 'v3',
    action, actor, actor_role: actor === 'system' ? null : 'risk_analyst', confidence: 0.84, triggered_alert_id: null,
    note: null, metadata: null, created_at: new Date(base + offsetMin * 60_000).toISOString(), ...extra,
  });
  __mswPredLog.push(mk('created', 'system', 0));
  __mswPredLog.push(mk('alert_triggered', 'system', 1, { triggered_alert_id: 'a-700001', note: 'PD crossed RED threshold (0.82)' }));
  __mswPredLog.push(mk('viewed', 'alice.analyst', 5));
}

const __mswPredLogFail = (code: string, status: number, msg: string) =>
  HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } }, { status });

const __mswPredLogHandlers = [
  http.get('/v1/ai/predictions/:pid/log', ({ params }) => {
    const pid = String(params.pid);
    if (!__mswPredLogSeeded) { __mswPredLogSeedFor(pid); __mswPredLogSeeded = true; }
    const items = __mswPredLog.filter((e) => e.prediction_id === pid);
    return HttpResponse.json(envelope({ prediction_id: pid, total: items.length, items }));
  }),
  http.post('/v1/ai/predictions/:pid/log', async ({ params, request }) => {
    const pid = String(params.pid);
    const b = (await request.json().catch(() => null)) as Record<string, any> | null;
    if (!b || !__MSW_PREDLOG_ACTIONS.includes(String(b.action))) return __mswPredLogFail('EWS_400_invalid_action', 400, `unknown action ${b?.action}`);
    const row = {
      log_id: __mswPredLogMintId(), tenant_id: 'BANK_DEMO', prediction_id: pid, model_id: b.model_id ?? 'pd_xgb_v3', model_version: b.model_version ?? 'v3',
      action: b.action, actor: b.actor ?? 'alice.analyst', actor_role: 'risk_analyst', confidence: typeof b.confidence === 'number' ? b.confidence : null,
      triggered_alert_id: b.triggered_alert_id != null ? String(b.triggered_alert_id) : null, note: b.note != null ? String(b.note) : null,
      metadata: b.metadata ?? null, created_at: new Date().toISOString(),
    };
    __mswPredLog.push(row);
    return HttpResponse.json(envelope(row), { status: 201 });
  }),
  http.get('/v1/ai/prediction-logs/summary', () => {
    const by_action: Record<string, number> = Object.fromEntries(__MSW_PREDLOG_ACTIONS.map((a) => [a, 0]));
    const actors = new Set<string>(); const preds = new Set<string>();
    let most_recent_at: string | null = null;
    for (const e of __mswPredLog) { by_action[e.action]++; actors.add(e.actor); preds.add(e.prediction_id); if (!most_recent_at || e.created_at > most_recent_at) most_recent_at = e.created_at; }
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', generated_at: new Date().toISOString(), total: __mswPredLog.length, by_action, total_alerts_triggered: by_action.alert_triggered, total_overrides: by_action.overridden, distinct_actors: actors.size, distinct_predictions: preds.size, most_recent_at }));
  }),
  http.get('/v1/ai/prediction-logs', ({ request }) => {
    const u = new URL(request.url);
    const action = u.searchParams.get('action');
    const actor = u.searchParams.get('actor');
    const pid = u.searchParams.get('prediction_id');
    if (action && !__MSW_PREDLOG_ACTIONS.includes(action)) return __mswPredLogFail('EWS_400_invalid_action', 400, `unknown action ${action}`);
    let rows = [...__mswPredLog];
    if (action) rows = rows.filter((e) => e.action === action);
    if (actor) rows = rows.filter((e) => e.actor === actor);
    if (pid) rows = rows.filter((e) => e.prediction_id === pid);
    rows.reverse();
    return HttpResponse.json(envelope({ items: rows, page: 1, page_size: 50, total: rows.length, page_size_default: 50, page_size_max: 200 }));
  }),
];

handlers.push(...__mswPredLogHandlers);

// ──────────────────────────────────────────────────────────────────────
// T7 — AI Rule + ML Hybrid Support handlers (stateful CRUD + dry-run preview)
// ──────────────────────────────────────────────────────────────────────
const __MSW_HY_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const __MSW_HY_DOMAINS = ['banking', 'insurance'];
const __MSW_HY_LOGIC = ['AND', 'OR'];
const __MSW_HY_ACTIONS = ['create_alert', 'open_case', 'notify', 'escalate'];
const __MSW_HY_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const __MSW_HY_STATUSES = ['draft', 'active', 'disabled'];
const __MSW_HY_TRANSITIONS: Record<string, string[]> = { draft: ['active', 'disabled'], active: ['disabled'], disabled: ['active'] };
const __MSW_HY_OPSYM: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', neq: '!=' };
const __mswHyStore = new Map<string, any>(); // rule_id → rule
let __mswHySeq = 0;
let __mswHySeeded = false;
export function __resetMswHybridRules() { __mswHyStore.clear(); __mswHySeq = 0; __mswHySeeded = false; }

const __mswHyExpr = (logic: string, conds: any[], action: string, severity: string) => {
  const lhs = conds.map((c) => (c.kind === 'metric' ? `${c.field} ${__MSW_HY_OPSYM[c.op]} ${c.value}` : `ai_score(${c.model_ref}) ${__MSW_HY_OPSYM[c.op]} ${c.threshold}`)).join(` ${logic} `);
  return `IF ${lhs} THEN ${action.toUpperCase()} (${severity})`;
};
const __mswHyApplyOp = (a: number, op: string, b: number) => (op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'eq' ? a === b : a !== b);
function __mswHyEval(rule: any, input: any) {
  const metrics = input?.metrics ?? {};
  const ai_scores = input?.ai_scores ?? {};
  const condition_results = (rule.conditions ?? []).map((c: any) => {
    if (c.kind === 'metric') {
      const observed = Object.prototype.hasOwnProperty.call(metrics, c.field) ? metrics[c.field] : null;
      if (observed === null || !Number.isFinite(observed)) return { condition: c, observed: null, matched: false, detail: `metric '${c.field}' not supplied` };
      const matched = __mswHyApplyOp(observed, c.op, c.value);
      return { condition: c, observed, matched, detail: `${c.field}=${observed} ${__MSW_HY_OPSYM[c.op]} ${c.value} → ${matched}` };
    }
    const observed = Object.prototype.hasOwnProperty.call(ai_scores, c.model_ref) ? ai_scores[c.model_ref] : null;
    if (observed === null || !Number.isFinite(observed)) return { condition: c, observed: null, matched: false, detail: `ai_score '${c.model_ref}' not supplied` };
    const matched = __mswHyApplyOp(observed, c.op, c.threshold);
    return { condition: c, observed, matched, detail: `ai_score(${c.model_ref})=${observed} ${__MSW_HY_OPSYM[c.op]} ${c.threshold} → ${matched}` };
  });
  const matched = rule.logic === 'AND' ? condition_results.every((r: any) => r.matched) : condition_results.some((r: any) => r.matched);
  return { rule_id: rule.rule_id ?? null, name: rule.name ?? 'preview', logic: rule.logic, condition_results, matched, would_fire: matched ? { action: rule.action, severity: rule.severity } : null, expression: __mswHyExpr(rule.logic, rule.conditions ?? [], rule.action, rule.severity) };
}
const __mswHyFail = (code: string, status: number, msg: string) =>
  HttpResponse.json({ header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } }, { status });
function __mswHyValidateCreate(b: any): string | null {
  if (!b || !String(b.name ?? '').trim()) return 'name required';
  if (!__MSW_HY_DOMAINS.includes(b.domain)) return 'domain must be banking|insurance';
  if (!__MSW_HY_LOGIC.includes(b.logic)) return 'logic must be AND|OR';
  if (!__MSW_HY_ACTIONS.includes(b.action)) return 'action out of enum';
  if (!__MSW_HY_SEVERITIES.includes(b.severity)) return 'severity out of enum';
  if (!Array.isArray(b.conditions) || b.conditions.length === 0) return 'at least one condition is required';
  for (const c of b.conditions) {
    if (!__MSW_HY_OPS.includes(c.op)) return `bad op ${c.op}`;
    if (c.kind === 'metric' && (!String(c.field ?? '').trim() || !Number.isFinite(c.value))) return 'bad metric condition';
    if (c.kind === 'ai_score' && (!String(c.model_ref ?? '').trim() || !Number.isFinite(c.threshold))) return 'bad ai_score condition';
    if (c.kind !== 'metric' && c.kind !== 'ai_score') return `unknown condition kind ${c.kind}`;
  }
  return null;
}
function __mswHySeed() {
  if (__mswHySeeded) return;
  __mswHySeeded = true;
  const ts = new Date().toISOString();
  const mk = (over: any) => {
    const id = `hyb-BANK_DEMO-${ts.slice(0, 10)}-${String(++__mswHySeq).padStart(4, '0')}`;
    const row = { rule_id: id, tenant_id: 'BANK_DEMO', description: null, status: 'active', created_by: 'system', created_at: ts, updated_at: ts, ...over };
    __mswHyStore.set(id, row);
  };
  mk({ name: 'High-DPD + high-PD → critical alert', domain: 'banking', logic: 'AND', action: 'create_alert', severity: 'critical', conditions: [{ kind: 'metric', field: 'DPD', op: 'gt', value: 90 }, { kind: 'ai_score', model_ref: 'pd_xgb_v3', op: 'gt', threshold: 0.82 }] });
  mk({ name: 'Lapse-likely + grace → notify retention', domain: 'insurance', logic: 'AND', action: 'notify', severity: 'high', conditions: [{ kind: 'ai_score', model_ref: 'lapse_xgb_v1', op: 'gt', threshold: 0.7 }, { kind: 'metric', field: 'days_overdue', op: 'gte', value: 15 }] });
}

const __mswHybridHandlers = [
  http.get('/v1/ai/hybrid-rules', ({ request }) => {
    __mswHySeed();
    const u = new URL(request.url);
    const domain = u.searchParams.get('domain');
    const status = u.searchParams.get('status');
    if (domain && !__MSW_HY_DOMAINS.includes(domain)) return __mswHyFail('EWS_400_invalid_input', 400, `domain ${domain}`);
    if (status && !__MSW_HY_STATUSES.includes(status)) return __mswHyFail('EWS_400_invalid_input', 400, `status ${status}`);
    let rows = Array.from(__mswHyStore.values());
    if (domain) rows = rows.filter((r) => r.domain === domain);
    if (status) rows = rows.filter((r) => r.status === status);
    return HttpResponse.json(envelope({ total: rows.length, items: rows }));
  }),
  http.post('/v1/ai/hybrid-rules', async ({ request }) => {
    const b = (await request.json().catch(() => null)) as any;
    const err = __mswHyValidateCreate(b);
    if (err) return __mswHyFail(err.includes('condition') ? 'EWS_400_invalid_condition' : 'EWS_400_invalid_input', 400, err);
    const ts = new Date().toISOString();
    const id = `hyb-BANK_DEMO-${ts.slice(0, 10)}-${String(++__mswHySeq).padStart(4, '0')}`;
    const row = { rule_id: id, tenant_id: 'BANK_DEMO', name: String(b.name).trim(), description: b.description ?? null, domain: b.domain, logic: b.logic, conditions: b.conditions, action: b.action, severity: b.severity, status: 'draft', created_by: 'alice.analyst', created_at: ts, updated_at: ts };
    __mswHyStore.set(id, row);
    return HttpResponse.json(envelope(row), { status: 201 });
  }),
  http.post('/v1/ai/hybrid-rules/preview', async ({ request }) => {
    const b = (await request.json().catch(() => null)) as any;
    const rule = b?.rule ?? {};
    if (!__MSW_HY_LOGIC.includes(rule.logic) || !__MSW_HY_ACTIONS.includes(rule.action) || !__MSW_HY_SEVERITIES.includes(rule.severity)) return __mswHyFail('EWS_400_invalid_input', 400, 'bad rule');
    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return __mswHyFail('EWS_400_invalid_condition', 400, 'at least one condition is required');
    return HttpResponse.json(envelope(__mswHyEval(rule, b?.input ?? {})));
  }),
  http.get('/v1/ai/hybrid-rules/:id', ({ params }) => {
    __mswHySeed();
    const row = __mswHyStore.get(String(params.id));
    if (!row) return __mswHyFail('EWS_404_unknown_rule', 404, `unknown rule ${params.id}`);
    return HttpResponse.json(envelope(row));
  }),
  http.patch('/v1/ai/hybrid-rules/:id', async ({ params, request }) => {
    const row = __mswHyStore.get(String(params.id));
    if (!row) return __mswHyFail('EWS_404_unknown_rule', 404, `unknown rule ${params.id}`);
    const b = (await request.json().catch(() => null)) as any;
    if (b?.status !== undefined) {
      if (!__MSW_HY_STATUSES.includes(b.status)) return __mswHyFail('EWS_400_invalid_input', 400, `status ${b.status}`);
      if (b.status !== row.status && !(__MSW_HY_TRANSITIONS[row.status] ?? []).includes(b.status)) return __mswHyFail('EWS_409_invalid_transition', 409, `cannot move ${row.status} → ${b.status}`);
      row.status = b.status;
    }
    if (b?.name !== undefined) row.name = String(b.name).trim();
    if (b?.description !== undefined) row.description = b.description ?? null;
    if (b?.logic !== undefined) row.logic = b.logic;
    if (b?.action !== undefined) row.action = b.action;
    if (b?.severity !== undefined) row.severity = b.severity;
    if (b?.conditions !== undefined) row.conditions = b.conditions;
    row.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(row));
  }),
  http.delete('/v1/ai/hybrid-rules/:id', ({ params }) => {
    if (!__mswHyStore.has(String(params.id))) return __mswHyFail('EWS_404_unknown_rule', 404, `unknown rule ${params.id}`);
    __mswHyStore.delete(String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/v1/ai/hybrid-rules/:id/preview', async ({ params, request }) => {
    const row = __mswHyStore.get(String(params.id));
    if (!row) return __mswHyFail('EWS_404_unknown_rule', 404, `unknown rule ${params.id}`);
    const b = (await request.json().catch(() => null)) as any;
    return HttpResponse.json(envelope(__mswHyEval(row, b?.input ?? {})));
  }),
];

handlers.push(...__mswHybridHandlers);

// ──────────────────────────────────────────────────────────────────────
// Master Setup — Risk Score Configuration handlers (stateful per domain)
// ──────────────────────────────────────────────────────────────────────
const __MSW_RSC_DOMAINS = ['banking', 'insurance', 'both'];
// rule_id → factor row
const __mswRscStore = new Map<string, any>();
let __mswRscSeq = 0;
let __mswRscSeeded = false;
export function __resetMswRiskScore() {
  __mswRscStore.clear();
  __mswRscSeq = 0;
  __mswRscSeeded = false;
}
const __mswRscRound2 = (n: number) => Math.round(n * 100) / 100;
function __mswRscSeed() {
  if (__mswRscSeeded) return;
  __mswRscSeeded = true;
  const iso = new Date(0).toISOString();
  const seed = [
    ['OVERDUE', 'Overdue / DPD', 'banking', 30],
    ['EMI_BOUNCE', 'EMI Bounce', 'banking', 25],
    ['TXN_BEHAVIOUR', 'Transaction Behaviour', 'banking', 25],
    ['BUREAU_SCORE', 'Bureau Score', 'banking', 20],
    ['PREMIUM_MISSED', 'Premium Missed', 'insurance', 35],
    ['CLAIM_FREQUENCY', 'Claim Frequency', 'insurance', 30],
    ['PERSISTENCY', 'Persistency', 'insurance', 20],
    ['LAPSE_RISK', 'Lapse Risk', 'insurance', 15],
  ] as const;
  seed.forEach(([code, name, domain, weight], i) => {
    const id = `rsf-BANK_DEMO-${String(++__mswRscSeq).padStart(4, '0')}`;
    __mswRscStore.set(id, {
      factor_id: id,
      tenant_id: 'BANK_DEMO',
      code,
      name,
      description: null,
      domain,
      weight_pct: weight,
      enabled: true,
      sort_order: i,
      created_by: 'system',
      created_at: iso,
      updated_at: iso,
    });
  });
}
const __mswRscList = (domain: string) => {
  __mswRscSeed();
  return Array.from(__mswRscStore.values())
    .filter((r) => domain === 'all' || r.domain === domain)
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
};
const __mswRscSummary = (domain: string, factors: any[]) => {
  const enabled = factors.filter((f) => f.enabled);
  const total = __mswRscRound2(enabled.reduce((s, f) => s + f.weight_pct, 0));
  return {
    domain,
    factor_count: factors.length,
    enabled_count: enabled.length,
    total_weight_pct: total,
    balanced: Math.abs(total - 100) < 0.01,
    remainder_pct: __mswRscRound2(100 - total),
  };
};
const __mswRscFail = (code: string, status: number, msg: string) =>
  HttpResponse.json(
    { header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } },
    { status },
  );
const __mswRscPeel = (b: any) => (b && typeof b === 'object' && b.body && typeof b.body === 'object' ? b.body : b);

const __mswRiskScoreHandlers = [
  http.get('/v1/config/risk-score/factors', ({ request }) => {
    const domain = new URL(request.url).searchParams.get('domain') ?? 'all';
    const factors = __mswRscList(domain);
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', total: factors.length, factors }));
  }),
  http.get('/v1/config/risk-score/summary', ({ request }) => {
    const domain = new URL(request.url).searchParams.get('domain') ?? 'all';
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', ...__mswRscSummary(domain, __mswRscList(domain)) }));
  }),
  http.post('/v1/config/risk-score/factors', async ({ request }) => {
    __mswRscSeed();
    const b = __mswRscPeel(await request.json().catch(() => null));
    const code = String(b?.code ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return __mswRscFail('EWS_400_invalid_input', 400, 'bad code');
    if (!String(b?.name ?? '').trim()) return __mswRscFail('EWS_400_invalid_input', 400, 'name required');
    if (!__MSW_RSC_DOMAINS.includes(b?.domain)) return __mswRscFail('EWS_400_invalid_domain', 400, 'bad domain');
    if (typeof b?.weight_pct !== 'number' || b.weight_pct < 0 || b.weight_pct > 100) return __mswRscFail('EWS_400_invalid_weight', 400, 'bad weight');
    if (Array.from(__mswRscStore.values()).some((r) => r.code === code)) return __mswRscFail('EWS_409_duplicate_code', 409, 'dup code');
    const id = `rsf-BANK_DEMO-${String(++__mswRscSeq).padStart(4, '0')}`;
    const iso = new Date().toISOString();
    const maxOrder = Math.max(-1, ...Array.from(__mswRscStore.values()).map((r) => r.sort_order));
    const row = {
      factor_id: id,
      tenant_id: 'BANK_DEMO',
      code,
      name: String(b.name).trim(),
      description: b.description ?? null,
      domain: b.domain,
      weight_pct: __mswRscRound2(b.weight_pct),
      enabled: b.enabled ?? true,
      sort_order: maxOrder + 1,
      created_by: 'alice.admin',
      created_at: iso,
      updated_at: iso,
    };
    __mswRscStore.set(id, row);
    return HttpResponse.json(envelope(row), { status: 201 });
  }),
  http.patch('/v1/config/risk-score/factors/:id', async ({ params, request }) => {
    __mswRscSeed();
    const row = __mswRscStore.get(String(params.id));
    if (!row) return __mswRscFail('EWS_404_unknown_factor', 404, 'unknown factor');
    const b = __mswRscPeel(await request.json().catch(() => null));
    if (b?.weight_pct !== undefined) {
      if (typeof b.weight_pct !== 'number' || b.weight_pct < 0 || b.weight_pct > 100) return __mswRscFail('EWS_400_invalid_weight', 400, 'bad weight');
      row.weight_pct = __mswRscRound2(b.weight_pct);
    }
    if (b?.name !== undefined) row.name = String(b.name).trim();
    if (b?.description !== undefined) row.description = b.description ?? null;
    if (b?.enabled !== undefined) row.enabled = !!b.enabled;
    if (b?.domain !== undefined && __MSW_RSC_DOMAINS.includes(b.domain)) row.domain = b.domain;
    row.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(row));
  }),
  http.delete('/v1/config/risk-score/factors/:id', ({ params }) => {
    __mswRscSeed();
    if (!__mswRscStore.has(String(params.id))) return __mswRscFail('EWS_404_unknown_factor', 404, 'unknown factor');
    __mswRscStore.delete(String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/v1/config/risk-score/reorder', async ({ request }) => {
    __mswRscSeed();
    const b = __mswRscPeel(await request.json().catch(() => null));
    const domain = b?.domain;
    const ids: string[] = Array.isArray(b?.ordered_ids) ? b.ordered_ids : [];
    const domainRows = Array.from(__mswRscStore.values()).filter((r) => r.domain === domain);
    const domainIds = new Set(domainRows.map((r) => r.factor_id));
    if (ids.length !== domainRows.length || ids.some((id) => !domainIds.has(id)) || new Set(ids).size !== ids.length) {
      return __mswRscFail('EWS_400_invalid_input', 400, 'ordered_ids must be the exact set');
    }
    ids.forEach((id, i) => {
      const r = __mswRscStore.get(id);
      r.sort_order = i;
      r.updated_at = new Date().toISOString();
    });
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', domain, factors: __mswRscList(domain) }));
  }),
  http.post('/v1/config/risk-score/normalize', async ({ request }) => {
    __mswRscSeed();
    const b = __mswRscPeel(await request.json().catch(() => null));
    const domain = b?.domain;
    const enabled = Array.from(__mswRscStore.values())
      .filter((r) => r.domain === domain && r.enabled)
      .sort((a, b2) => a.sort_order - b2.sort_order);
    if (enabled.length === 0) return __mswRscFail('EWS_400_invalid_input', 400, 'no enabled factors');
    const sum = enabled.reduce((s, r) => s + r.weight_pct, 0);
    if (sum <= 0) return __mswRscFail('EWS_400_invalid_input', 400, 'weights sum to 0');
    let running = 0;
    enabled.forEach((r, i) => {
      if (i === enabled.length - 1) r.weight_pct = __mswRscRound2(100 - running);
      else {
        const scaled = __mswRscRound2((r.weight_pct / sum) * 100);
        r.weight_pct = scaled;
        running += scaled;
      }
      r.updated_at = new Date().toISOString();
    });
    const factors = __mswRscList(domain);
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', domain, factors, summary: __mswRscSummary(domain, factors) }));
  }),
];

handlers.push(...__mswRiskScoreHandlers);

// ──────────────────────────────────────────────────────────────────────
// Master Setup — Alert Classification Setup handlers (RAG score bands)
// ──────────────────────────────────────────────────────────────────────
const __MSW_ACC_BANDS = ['green', 'amber', 'red'];
const __MSW_ACC_DEFAULTS = { amber_min: 60, red_min: 100 };
const __MSW_ACC_DEFAULT_ACTIONS: Record<string, string> = {
  green: 'No action — monitor',
  amber: 'Review within SLA',
  red: 'Immediate action — escalate',
};
const __mswAccColor: Record<string, string> = { green: '#16a34a', amber: '#d97706', red: '#dc2626' };
const __mswAccRank: Record<string, number> = { green: 0, amber: 1, red: 2 };
const __mswAccLabel: Record<string, string> = { green: 'Green', amber: 'Amber', red: 'Red' };
let __mswAccState: { amber_min: number; red_min: number; actions: Record<string, string>; updated_at: string; updated_by: string } | null = null;
export function __resetMswAlertClassification() {
  __mswAccState = null;
}
function __mswAccSeed() {
  if (!__mswAccState) {
    __mswAccState = {
      amber_min: __MSW_ACC_DEFAULTS.amber_min,
      red_min: __MSW_ACC_DEFAULTS.red_min,
      actions: { ...__MSW_ACC_DEFAULT_ACTIONS },
      updated_at: new Date(0).toISOString(),
      updated_by: 'system',
    };
  }
  return __mswAccState;
}
const __mswAccRangeLabel = (band: string, min: number, max: number | null) =>
  band === 'green' ? `< ${max}` : band === 'red' ? `≥ ${min}` : `${min}–${max}`;
function __mswAccConfig() {
  const s = __mswAccSeed();
  const spec: [string, number, number | null][] = [
    ['green', 0, s.amber_min],
    ['amber', s.amber_min, s.red_min],
    ['red', s.red_min, null],
  ];
  return {
    tenant_id: 'BANK_DEMO',
    score_floor: 0,
    amber_min: s.amber_min,
    red_min: s.red_min,
    bands: spec.map(([band, min, max]) => ({
      band,
      label: __mswAccLabel[band],
      color_hex: __mswAccColor[band],
      severity_rank: __mswAccRank[band],
      min_score: min,
      max_score: max,
      action_required: s.actions[band],
      range_label: __mswAccRangeLabel(band, min, max),
    })),
    updated_at: s.updated_at,
    updated_by: s.updated_by,
  };
}
const __mswAccFail = (code: string, status: number, msg: string) =>
  HttpResponse.json(
    { header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } },
    { status },
  );
const __mswAccPeel = (b: any) => (b && typeof b === 'object' && b.body && typeof b.body === 'object' ? b.body : b);

const __mswAlertClassificationHandlers = [
  http.get('/v1/config/alert-classification', () => HttpResponse.json(envelope(__mswAccConfig()))),
  http.put('/v1/config/alert-classification/boundaries', async ({ request }) => {
    const b = __mswAccPeel(await request.json().catch(() => null));
    const amber = Number(b?.amber_min);
    const red = Number(b?.red_min);
    if (!Number.isFinite(amber) || !Number.isFinite(red)) return __mswAccFail('EWS_400_invalid_input', 400, 'boundaries must be numbers');
    if (amber <= 0) return __mswAccFail('EWS_400_invalid_boundaries', 400, 'amber_min must be > 0');
    if (red <= amber) return __mswAccFail('EWS_400_invalid_boundaries', 400, 'red_min must be > amber_min');
    if (red > 1000) return __mswAccFail('EWS_400_invalid_boundaries', 400, 'red_min must be ≤ 1000');
    const s = __mswAccSeed();
    s.amber_min = Math.round(amber * 100) / 100;
    s.red_min = Math.round(red * 100) / 100;
    s.updated_at = new Date().toISOString();
    s.updated_by = 'alice.admin';
    return HttpResponse.json(envelope(__mswAccConfig()));
  }),
  http.patch('/v1/config/alert-classification/bands/:band', async ({ params, request }) => {
    const band = String(params.band);
    if (!__MSW_ACC_BANDS.includes(band)) return __mswAccFail('EWS_400_invalid_band', 400, 'unknown band');
    const b = __mswAccPeel(await request.json().catch(() => null));
    const action = String(b?.action_required ?? '').trim();
    if (!action) return __mswAccFail('EWS_400_invalid_input', 400, 'action_required is required');
    if (action.length > 200) return __mswAccFail('EWS_400_invalid_input', 400, 'action_required exceeds 200 chars');
    const s = __mswAccSeed();
    s.actions[band] = action;
    s.updated_at = new Date().toISOString();
    s.updated_by = 'alice.admin';
    return HttpResponse.json(envelope(__mswAccConfig()));
  }),
  http.post('/v1/config/alert-classification/classify', async ({ request }) => {
    const b = __mswAccPeel(await request.json().catch(() => null));
    const score = Number(b?.score);
    if (!Number.isFinite(score)) return __mswAccFail('EWS_400_invalid_input', 400, 'score must be a finite number');
    const s = __mswAccSeed();
    const band = score >= s.red_min ? 'red' : score >= s.amber_min ? 'amber' : 'green';
    return HttpResponse.json(
      envelope({ score, band, label: __mswAccLabel[band], color_hex: __mswAccColor[band], action_required: s.actions[band] }),
    );
  }),
  http.post('/v1/config/alert-classification/reset', () => {
    __mswAccState = {
      amber_min: __MSW_ACC_DEFAULTS.amber_min,
      red_min: __MSW_ACC_DEFAULTS.red_min,
      actions: { ...__MSW_ACC_DEFAULT_ACTIONS },
      updated_at: new Date().toISOString(),
      updated_by: 'alice.admin',
    };
    return HttpResponse.json(envelope(__mswAccConfig()));
  }),
];

handlers.push(...__mswAlertClassificationHandlers);

// ──────────────────────────────────────────────────────────────────────
// Runtime — composite scorecard evaluate (consumes risk-score #11 + RAG #12).
// Reads both the risk-score factor store + the alert-classification state.
// ──────────────────────────────────────────────────────────────────────
const __mswScorecardEvalHandlers = [
  http.post('/v1/config/risk-score/evaluate', async ({ request }) => {
    const b = __mswRscPeel(await request.json().catch(() => null)) as { domain?: string; factor_values?: Record<string, unknown> } | null;
    const domain = b?.domain;
    if (domain !== 'banking' && domain !== 'insurance') {
      return __mswRscFail('EWS_400_invalid_input', 400, "domain must be 'banking' or 'insurance'");
    }
    const raw = b?.factor_values ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return __mswRscFail('EWS_400_invalid_input', 400, 'factor_values must be an object');
    }
    const fv: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return __mswRscFail('EWS_400_invalid_input', 400, `factor_values['${k}'] must be a finite number`);
      }
      fv[k.trim().toUpperCase()] = v;
    }
    const enabled = __mswRscList(domain).filter((f) => f.enabled);
    const codes = new Set(enabled.map((f) => f.code));
    const unknown_value_codes = Object.keys(fv).filter((c) => !codes.has(c)).sort();
    let missing = 0;
    const clamp = (n: number) => (n < 0 ? 0 : n > 100 ? 100 : n);
    const factors = enabled.map((f) => {
      const provided = Object.prototype.hasOwnProperty.call(fv, f.code);
      if (!provided) missing++;
      const signal_value = provided ? clamp(fv[f.code]) : 0;
      return {
        factor_id: f.factor_id,
        code: f.code,
        name: f.name,
        weight_pct: f.weight_pct,
        signal_value,
        value_provided: provided,
        contribution: __mswRscRound2((f.weight_pct / 100) * signal_value),
      };
    });
    const composite_score = __mswRscRound2(factors.reduce((s, f) => s + f.contribution, 0));
    const total_weight_pct = __mswRscRound2(enabled.reduce((s, f) => s + f.weight_pct, 0));
    const cfg = __mswAccConfig();
    const band = composite_score >= cfg.red_min ? 'red' : composite_score >= cfg.amber_min ? 'amber' : 'green';
    const row = cfg.bands.find((bd) => bd.band === band)!;
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        domain,
        composite_score,
        total_weight_pct,
        balanced: Math.abs(total_weight_pct - 100) < 0.01,
        classification: { score: composite_score, band, label: row.label, color_hex: row.color_hex, action_required: row.action_required },
        factors,
        unknown_value_codes,
        missing_value_count: missing,
        evaluated_at: new Date().toISOString(),
      }),
    );
  }),
  http.post('/v1/config/risk-score/evaluate-batch', async ({ request }) => {
    const b = __mswRscPeel(await request.json().catch(() => null)) as { domain?: string; rows?: unknown } | null;
    const domain = b?.domain;
    if (domain !== 'banking' && domain !== 'insurance') {
      return __mswRscFail('EWS_400_invalid_input', 400, "domain must be 'banking' or 'insurance'");
    }
    if (!Array.isArray(b?.rows)) return __mswRscFail('EWS_400_invalid_input', 400, 'rows must be an array');
    const enabled = __mswRscList(domain).filter((f) => f.enabled);
    const cfg = __mswAccConfig();
    const clamp = (n: number) => (n < 0 ? 0 : n > 100 ? 100 : n);
    const total_weight_pct = __mswRscRound2(enabled.reduce((s, f) => s + f.weight_pct, 0));
    const distribution: Record<string, number> = { green: 0, amber: 0, red: 0 };
    const rows: any[] = [];
    let sum = 0;
    let max: number | null = null;
    let min: number | null = null;
    for (const raw of b!.rows as any[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || raw.id.trim() === '') {
        return __mswRscFail('EWS_400_invalid_input', 400, 'each row needs a non-empty id');
      }
      const fv: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw.factor_values ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v)) fv[k.trim().toUpperCase()] = v;
      }
      const composite = __mswRscRound2(enabled.reduce((s, f) => s + (f.weight_pct / 100) * clamp(fv[f.code] ?? 0), 0));
      const band = composite >= cfg.red_min ? 'red' : composite >= cfg.amber_min ? 'amber' : 'green';
      const bandRow = cfg.bands.find((x) => x.band === band)!;
      distribution[band]++;
      sum += composite;
      max = max === null ? composite : Math.max(max, composite);
      min = min === null ? composite : Math.min(min, composite);
      rows.push({ id: raw.id, composite_score: composite, band, label: bandRow.label, action_required: bandRow.action_required });
    }
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        domain,
        evaluated_at: new Date().toISOString(),
        total: rows.length,
        total_weight_pct,
        balanced: Math.abs(total_weight_pct - 100) < 0.01,
        distribution,
        mean_composite: rows.length === 0 ? null : __mswRscRound2(sum / rows.length),
        max_composite: max,
        min_composite: min,
        rows,
      }),
    );
  }),
];
handlers.push(...__mswScorecardEvalHandlers);

// ──────────────────────────────────────────────────────────────────────
// Master Setup — Case Management Setup handlers (case-type master)
// ──────────────────────────────────────────────────────────────────────
const __MSW_CTY_PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const __mswCtyStore = new Map<string, any>();
let __mswCtySeq = 0;
let __mswCtySeeded = false;
export function __resetMswCaseTypes() {
  __mswCtyStore.clear();
  __mswCtySeq = 0;
  __mswCtySeeded = false;
}
function __mswCtySeed() {
  if (__mswCtySeeded) return;
  __mswCtySeeded = true;
  const iso = new Date(0).toISOString();
  const seed = [
    ['FRAUD_INVESTIGATION', 'Fraud Investigation', 'P1', 4, 'Fraud Desk'],
    ['CREDIT_RISK_REVIEW', 'Credit Risk Review', 'P2', 24, 'Credit Risk Team'],
    ['KYC_REMEDIATION', 'KYC Remediation', 'P3', 72, 'Compliance'],
    ['COLLECTIONS_FOLLOWUP', 'Collections Follow-up', 'P4', 168, 'Recovery Desk'],
  ] as const;
  seed.forEach(([code, name, priority, sla, team], i) => {
    const id = `cty-BANK_DEMO-${String(++__mswCtySeq).padStart(4, '0')}`;
    __mswCtyStore.set(id, {
      case_type_id: id,
      tenant_id: 'BANK_DEMO',
      code,
      name,
      description: null,
      priority,
      sla_hours: sla,
      assigned_team: team,
      enabled: true,
      sort_order: i,
      created_by: 'system',
      created_at: iso,
      updated_at: iso,
    });
  });
}
const __mswCtyList = (priority: string, enabledOnly: boolean) => {
  __mswCtySeed();
  return Array.from(__mswCtyStore.values())
    .filter((r) => (priority === 'all' || r.priority === priority) && (!enabledOnly || r.enabled))
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
};
const __mswCtyFail = (code: string, status: number, msg: string) =>
  HttpResponse.json(
    { header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } },
    { status },
  );
const __mswCtyPeel = (b: any) => (b && typeof b === 'object' && b.body && typeof b.body === 'object' ? b.body : b);

const __mswCaseTypeHandlers = [
  http.get('/v1/config/case-types/summary', () => {
    const rows = __mswCtyList('all', false);
    const by_priority: Record<string, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
    rows.forEach((r) => by_priority[r.priority]++);
    const enabled = rows.filter((r) => r.enabled);
    const slas = enabled.map((r) => r.sla_hours);
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        total: rows.length,
        enabled_count: enabled.length,
        by_priority,
        mean_sla_hours: slas.length ? Math.round((slas.reduce((s, n) => s + n, 0) / slas.length) * 100) / 100 : null,
        fastest_sla_hours: slas.length ? Math.min(...slas) : null,
        slowest_sla_hours: slas.length ? Math.max(...slas) : null,
      }),
    );
  }),
  http.get('/v1/config/case-types', ({ request }) => {
    const u = new URL(request.url);
    const priority = u.searchParams.get('priority') ?? 'all';
    const enabledOnly = u.searchParams.get('enabled') === 'true';
    const rows = __mswCtyList(priority, enabledOnly);
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', total: rows.length, case_types: rows }));
  }),
  http.get('/v1/config/case-types/:id', ({ params }) => {
    __mswCtySeed();
    const row = __mswCtyStore.get(String(params.id));
    if (!row) return __mswCtyFail('EWS_404_unknown_case_type', 404, 'unknown case type');
    return HttpResponse.json(envelope(row));
  }),
  http.post('/v1/config/case-types', async ({ request }) => {
    __mswCtySeed();
    const b = __mswCtyPeel(await request.json().catch(() => null));
    const code = String(b?.code ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return __mswCtyFail('EWS_400_invalid_input', 400, 'bad code');
    if (!String(b?.name ?? '').trim()) return __mswCtyFail('EWS_400_invalid_input', 400, 'name required');
    if (!__MSW_CTY_PRIORITIES.includes(b?.priority)) return __mswCtyFail('EWS_400_invalid_priority', 400, 'bad priority');
    if (typeof b?.sla_hours !== 'number' || b.sla_hours <= 0 || b.sla_hours > 8760) return __mswCtyFail('EWS_400_invalid_sla', 400, 'bad sla');
    if (!String(b?.assigned_team ?? '').trim()) return __mswCtyFail('EWS_400_invalid_input', 400, 'team required');
    if (Array.from(__mswCtyStore.values()).some((r) => r.code === code)) return __mswCtyFail('EWS_409_duplicate_code', 409, 'dup code');
    const id = `cty-BANK_DEMO-${String(++__mswCtySeq).padStart(4, '0')}`;
    const iso = new Date().toISOString();
    const maxOrder = Math.max(-1, ...Array.from(__mswCtyStore.values()).map((r) => r.sort_order));
    const row = {
      case_type_id: id,
      tenant_id: 'BANK_DEMO',
      code,
      name: String(b.name).trim(),
      description: b.description ?? null,
      priority: b.priority,
      sla_hours: Math.round(b.sla_hours * 100) / 100,
      assigned_team: String(b.assigned_team).trim(),
      enabled: b.enabled ?? true,
      sort_order: maxOrder + 1,
      created_by: 'alice.admin',
      created_at: iso,
      updated_at: iso,
    };
    __mswCtyStore.set(id, row);
    return HttpResponse.json(envelope(row), { status: 201 });
  }),
  http.patch('/v1/config/case-types/:id', async ({ params, request }) => {
    __mswCtySeed();
    const row = __mswCtyStore.get(String(params.id));
    if (!row) return __mswCtyFail('EWS_404_unknown_case_type', 404, 'unknown case type');
    const b = __mswCtyPeel(await request.json().catch(() => null));
    if (b?.priority !== undefined) {
      if (!__MSW_CTY_PRIORITIES.includes(b.priority)) return __mswCtyFail('EWS_400_invalid_priority', 400, 'bad priority');
      row.priority = b.priority;
    }
    if (b?.sla_hours !== undefined) {
      if (typeof b.sla_hours !== 'number' || b.sla_hours <= 0 || b.sla_hours > 8760) return __mswCtyFail('EWS_400_invalid_sla', 400, 'bad sla');
      row.sla_hours = Math.round(b.sla_hours * 100) / 100;
    }
    if (b?.name !== undefined) row.name = String(b.name).trim();
    if (b?.description !== undefined) row.description = b.description ?? null;
    if (b?.assigned_team !== undefined) row.assigned_team = String(b.assigned_team).trim();
    if (b?.enabled !== undefined) row.enabled = !!b.enabled;
    row.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(row));
  }),
  http.delete('/v1/config/case-types/:id', ({ params }) => {
    __mswCtySeed();
    if (!__mswCtyStore.has(String(params.id))) return __mswCtyFail('EWS_404_unknown_case_type', 404, 'unknown case type');
    __mswCtyStore.delete(String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
];

handlers.push(...__mswCaseTypeHandlers);

// ──────────────────────────────────────────────────────────────────────
// Configuration — Job & Scheduler Config handlers (consolidated registry)
// ──────────────────────────────────────────────────────────────────────
const __MSW_JSC_FREQUENCIES = ['realtime', 'every_5min', 'every_15min', 'hourly', 'every_6h', 'daily', 'weekly', 'monthly'];
const __MSW_JSC_FREQ_MIN: Record<string, number> = {
  realtime: 1, every_5min: 5, every_15min: 15, hourly: 60, every_6h: 360, daily: 1440, weekly: 10080, monthly: 43200,
};
const __mswJscStore = new Map<string, any>();
const __mswJscRunLog = new Map<string, any[]>(); // job_id → newest-first
let __mswJscSeeded = false;
let __mswJscRunCounter = 0;
export function __resetMswJobScheduler() {
  __mswJscStore.clear();
  __mswJscRunLog.clear();
  __mswJscSeeded = false;
  __mswJscRunCounter = 0;
}
const __mswJscNextRun = (freq: string) => new Date(Date.now() + __MSW_JSC_FREQ_MIN[freq] * 60_000).toISOString();
function __mswJscSeed() {
  if (__mswJscSeeded) return;
  __mswJscSeeded = true;
  const seed = [
    ['CBS_INGESTION', 'CBS Ingestion DAG', 'ingestion', 'pipeline-svc', 'hourly', 'success'],
    ['BUREAU_SYNC', 'Bureau Sync DAG', 'ingestion', 'pipeline-svc', 'weekly', 'success'],
    ['FEATURE_BUILD', 'Feature Build DAG', 'data_quality', 'pipeline-svc', 'daily', 'success'],
    ['FEATURE_STORE_BACKFILL', 'Feature Store Backfill DAG', 'ml', 'pipeline-svc', 'daily', 'never_run'],
    ['PD_RETRAINING', 'PD Retraining Scheduler', 'ml', 'ai-copilot-svc', 'every_6h', 'success'],
    ['DRIFT_MONITOR', 'Drift Monitor', 'ml', 'ai-copilot-svc', 'daily', 'partial'],
    ['REPORT_SCHEDULES', 'Report Scheduler Tick', 'reporting', 'bff', 'every_15min', 'success'],
    ['ESCALATION_WORKER', 'Escalation Worker Tick', 'workflow', 'regulatory-svc', 'every_5min', 'success'],
    ['DQ_EXECUTIONS', 'Data Quality Run', 'data_quality', 'pipeline-svc', 'every_6h', 'failure'],
    ['AUDIT_RETENTION', 'Audit Retention Sweep', 'system', 'audit-svc', 'daily', 'success'],
    ['STREAMING_INGEST', 'Streaming Indicator Ingest', 'ingestion', 'regulatory-svc', 'realtime', 'running'],
  ] as const;
  seed.forEach(([key, name, category, owner, freq, status]) => {
    const id = `job-BANK_DEMO-${key}`;
    const neverRun = status === 'never_run';
    __mswJscStore.set(id, {
      job_id: id,
      tenant_id: 'BANK_DEMO',
      name,
      category,
      description: `${name} — ${owner}`,
      owner_service: owner,
      frequency: freq,
      enabled: true,
      last_run_status: status,
      last_run_at: neverRun ? null : new Date(Date.now() - 2 * 3_600_000).toISOString(),
      last_run_duration_ms: neverRun ? null : 1500,
      consecutive_failures: status === 'failure' ? 2 : 0,
      next_run_at: __mswJscNextRun(freq),
      updated_at: new Date(Date.now()).toISOString(),
    });
  });
}
const __mswJscList = (category: string) => {
  __mswJscSeed();
  return Array.from(__mswJscStore.values())
    .filter((j) => category === 'all' || j.category === category)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
};
const __mswJscFail = (code: string, status: number, msg: string) =>
  HttpResponse.json(
    { header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code, message: msg, severity: 'MEDIUM' } },
    { status },
  );
const __mswJscPeel = (b: any) => (b && typeof b === 'object' && b.body && typeof b.body === 'object' ? b.body : b);
// Lazily synthesise an 8-entry run history whose newest entry mirrors the
// job's current last_run_* (mirrors the BFF). never_run jobs → empty log.
function __mswJscSeededRuns(id: string): any[] {
  const existing = __mswJscRunLog.get(id);
  if (existing) return existing;
  const job = __mswJscStore.get(id);
  const log: any[] = [];
  if (job && job.last_run_at !== null) {
    log.push({ run_id: `${id}-h0`, job_id: id, status: job.last_run_status, triggered_by: 'scheduler', ran_at: job.last_run_at, duration_ms: job.last_run_duration_ms ?? 0 });
    const stepMs = __MSW_JSC_FREQ_MIN[job.frequency] * 60_000;
    let t = Date.parse(job.last_run_at);
    for (let i = 1; i < 8; i++) {
      t -= stepMs;
      const roll = (i * 0.31 + 0.17) % 1;
      const status = roll < 0.84 ? 'success' : roll < 0.92 ? 'partial' : 'failure';
      log.push({ run_id: `${id}-h${i}`, job_id: id, status, triggered_by: 'scheduler', ran_at: new Date(t).toISOString(), duration_ms: 200 + Math.floor(roll * 9800) });
    }
  }
  __mswJscRunLog.set(id, log);
  return log;
}

const __mswJobSchedulerHandlers = [
  http.get('/v1/config/jobs/summary', () => {
    const rows = __mswJscList('all');
    const by_category: Record<string, number> = { ingestion: 0, reporting: 0, ml: 0, workflow: 0, data_quality: 0, system: 0 };
    const by_status: Record<string, number> = { success: 0, failure: 0, partial: 0, running: 0, never_run: 0 };
    const attention_required: { job_id: string; name: string; reason: string }[] = [];
    let enabled = 0;
    let overdue = 0;
    rows.forEach((j) => {
      by_category[j.category]++;
      by_status[j.last_run_status]++;
      if (j.enabled) enabled++;
      const isOverdue = j.enabled && j.next_run_at && Date.parse(j.next_run_at) < Date.now();
      if (isOverdue) overdue++;
      if (j.last_run_status === 'failure') attention_required.push({ job_id: j.job_id, name: j.name, reason: `last run failed (${j.consecutive_failures} consecutive)` });
      else if (isOverdue) attention_required.push({ job_id: j.job_id, name: j.name, reason: 'overdue — next run is in the past' });
    });
    return HttpResponse.json(
      envelope({
        tenant_id: 'BANK_DEMO',
        generated_at: new Date().toISOString(),
        total_jobs: rows.length,
        enabled_count: enabled,
        disabled_count: rows.length - enabled,
        by_category,
        by_status,
        failing_count: by_status.failure,
        overdue_count: overdue,
        attention_required,
      }),
    );
  }),
  http.get('/v1/config/jobs', ({ request }) => {
    const u = new URL(request.url);
    const category = u.searchParams.get('category') ?? 'all';
    const status = u.searchParams.get('status');
    const enabledOnly = u.searchParams.get('enabled') === 'true';
    let rows = __mswJscList(category);
    if (status) rows = rows.filter((j) => j.last_run_status === status);
    if (enabledOnly) rows = rows.filter((j) => j.enabled);
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', total: rows.length, jobs: rows }));
  }),
  http.get('/v1/config/jobs/:id', ({ params }) => {
    __mswJscSeed();
    const row = __mswJscStore.get(String(params.id));
    if (!row) return __mswJscFail('EWS_404_unknown_job', 404, 'unknown job');
    return HttpResponse.json(envelope(row));
  }),
  http.patch('/v1/config/jobs/:id', async ({ params, request }) => {
    __mswJscSeed();
    const row = __mswJscStore.get(String(params.id));
    if (!row) return __mswJscFail('EWS_404_unknown_job', 404, 'unknown job');
    const b = __mswJscPeel(await request.json().catch(() => null));
    if (b?.frequency !== undefined) {
      if (!__MSW_JSC_FREQUENCIES.includes(b.frequency)) return __mswJscFail('EWS_400_invalid_frequency', 400, 'bad frequency');
      row.frequency = b.frequency;
      if (row.enabled) row.next_run_at = __mswJscNextRun(b.frequency);
    }
    if (b?.enabled !== undefined) {
      row.enabled = !!b.enabled;
      row.next_run_at = row.enabled ? __mswJscNextRun(row.frequency) : null;
    }
    row.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(row));
  }),
  http.post('/v1/config/jobs/:id/run', ({ params }) => {
    __mswJscSeed();
    const row = __mswJscStore.get(String(params.id));
    if (!row) return __mswJscFail('EWS_404_unknown_job', 404, 'unknown job');
    if (!row.enabled) return __mswJscFail('EWS_400_invalid_input', 400, 'cannot run a disabled job');
    __mswJscRunCounter++;
    const roll = (__mswJscRunCounter * 0.37) % 1;
    const status = roll < 0.88 ? 'success' : roll < 0.95 ? 'partial' : 'failure';
    const ran_at = new Date().toISOString();
    const duration_ms = 200 + Math.floor(roll * 9800);
    row.last_run_status = status;
    row.last_run_at = ran_at;
    row.last_run_duration_ms = duration_ms;
    row.consecutive_failures = status === 'failure' ? row.consecutive_failures + 1 : 0;
    row.next_run_at = __mswJscNextRun(row.frequency);
    row.updated_at = ran_at;
    const log = __mswJscSeededRuns(row.job_id);
    log.unshift({ run_id: `${row.job_id}-r${__mswJscRunCounter}`, job_id: row.job_id, status, triggered_by: 'alice.admin', ran_at, duration_ms });
    return HttpResponse.json(envelope({ job_id: row.job_id, status, ran_at, duration_ms, triggered_by: 'alice.admin' }), { status: 202 });
  }),
  http.get('/v1/config/jobs/:id/runs', ({ params, request }) => {
    __mswJscSeed();
    const id = String(params.id);
    if (!__mswJscStore.get(id)) return __mswJscFail('EWS_404_unknown_job', 404, 'unknown job');
    const limRaw = Number(new URL(request.url).searchParams.get('limit') ?? 20);
    const lim = Math.max(1, Math.min(50, Number.isFinite(limRaw) ? Math.floor(limRaw) : 20));
    const runs = __mswJscSeededRuns(id).slice(0, lim);
    return HttpResponse.json(envelope({ tenant_id: 'BANK_DEMO', job_id: id, total: runs.length, runs }));
  }),
  http.get('/v1/config/jobs/:id/run-stats', ({ params }) => {
    __mswJscSeed();
    const id = String(params.id);
    if (!__mswJscStore.get(id)) return __mswJscFail('EWS_404_unknown_job', 404, 'unknown job');
    const log = __mswJscSeededRuns(id);
    const by_status: Record<string, number> = { success: 0, failure: 0, partial: 0, running: 0, never_run: 0 };
    let terminal = 0;
    let durSum = 0;
    log.forEach((e) => {
      by_status[e.status]++;
      if (e.status === 'success' || e.status === 'partial' || e.status === 'failure') {
        terminal++;
        durSum += e.duration_ms;
      }
    });
    return HttpResponse.json(
      envelope({
        job_id: id,
        total_runs: log.length,
        by_status,
        success_rate: terminal === 0 ? null : Math.round((by_status.success / terminal) * 100) / 100,
        mean_duration_ms: terminal === 0 ? null : Math.round(durSum / terminal),
        last_run_at: log.length > 0 ? log[0].ran_at : null,
        last_status: log.length > 0 ? log[0].status : null,
      }),
    );
  }),
];

handlers.push(...__mswJobSchedulerHandlers);

// ──────────────────────────────────────────────────────────────────────
// Configuration · Access Control Config (read-only RBAC matrix viewer)
// Static representative matrix mirroring infra/rbac/matrix.json shape.
// No mutable state — read-only, so no reset.
// ──────────────────────────────────────────────────────────────────────
type MswRbacRole = 'admin' | 'risk_analyst' | 'supervisor' | 'collection_officer' | 'field_officer';
const __MSW_ACC_ROLES: MswRbacRole[] = ['admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer'];
const __MSW_ACC_ROLE_DESC: Record<MswRbacRole, string> = {
  admin: 'Full platform administration',
  risk_analyst: 'Reviews alerts, runs risk profiles',
  supervisor: 'Approves sensitive actions, oversees teams',
  collection_officer: 'Works the collections queue',
  field_officer: 'Logs field visits + actions',
};
// operation -> allowed roles
const __MSW_ACC_OPS: Record<string, MswRbacRole[]> = {
  'alerts:list': ['admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer'],
  'alerts:read': ['admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer'],
  'alerts:assign': ['admin', 'risk_analyst', 'supervisor'],
  'cases:list': ['admin', 'risk_analyst', 'supervisor', 'collection_officer'],
  'cases:close': ['admin', 'supervisor'],
  'cases:log_action': ['admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer'],
  'rules:list': ['admin', 'risk_analyst', 'supervisor'],
  'rules:create': ['admin', 'risk_analyst'],
  'audit:read': ['admin', 'supervisor'],
  'reports:export': ['admin', 'supervisor', 'risk_analyst'],
};
function __mswAccResourceOf(op: string): string {
  const i = op.indexOf(':');
  return i < 0 ? op : op.slice(0, i);
}
function __mswAccActionOf(op: string): string {
  const i = op.indexOf(':');
  return i < 0 ? op : op.slice(i + 1);
}
function __mswAccGroup(ops: string[]) {
  const m = new Map<string, string[]>();
  for (const op of ops) {
    const r = __mswAccResourceOf(op);
    (m.get(r) ?? m.set(r, []).get(r)!).push(op);
  }
  return Array.from(m.entries())
    .map(([resource, operations]) => ({ resource, operation_count: operations.length, operations }))
    .sort((a, b) => a.resource.localeCompare(b.resource));
}
const __mswAccessControlHandlers = [
  http.get('/v1/config/access-control', () => {
    const allOps = Object.keys(__MSW_ACC_OPS);
    return HttpResponse.json(
      envelope({
        version: '1.0.0',
        total_roles: __MSW_ACC_ROLES.length,
        total_operations: allOps.length,
        total_resources: __mswAccGroup(allOps).length,
        roles: __MSW_ACC_ROLES,
        resources: __mswAccGroup(allOps),
        role_summaries: __MSW_ACC_ROLES.map((role) => ({
          role,
          description: __MSW_ACC_ROLE_DESC[role],
          operation_count: allOps.filter((op) => __MSW_ACC_OPS[op].includes(role)).length,
        })),
      }),
    );
  }),
  http.get('/v1/config/access-control/matrix', () => {
    const rows = Object.entries(__MSW_ACC_OPS).map(([operation, allowed]) => {
      const by_role = {} as Record<MswRbacRole, boolean>;
      for (const role of __MSW_ACC_ROLES) by_role[role] = allowed.includes(role);
      return {
        operation,
        resource: __mswAccResourceOf(operation),
        action: __mswAccActionOf(operation),
        allowed_role_count: allowed.length,
        by_role,
      };
    });
    return HttpResponse.json(envelope({ version: '1.0.0', roles: __MSW_ACC_ROLES, total_operations: rows.length, rows }));
  }),
  http.get('/v1/config/access-control/check', ({ request }) => {
    const u = new URL(request.url);
    const role = (u.searchParams.get('role') ?? '').trim();
    const operation = (u.searchParams.get('operation') ?? '').trim();
    if (role === '' || operation === '') {
      return HttpResponse.json(
        { header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_400_invalid_input', message: 'role and operation required', severity: 'MEDIUM' } },
        { status: 400 },
      );
    }
    const role_known = __MSW_ACC_ROLES.includes(role as MswRbacRole);
    const operation_known = Object.prototype.hasOwnProperty.call(__MSW_ACC_OPS, operation);
    const allowed = operation_known && __MSW_ACC_OPS[operation].includes(role as MswRbacRole);
    return HttpResponse.json(
      envelope({ role, operation, resource: __mswAccResourceOf(operation), action: __mswAccActionOf(operation), allowed, role_known, operation_known }),
    );
  }),
  http.get('/v1/config/access-control/roles/:role', ({ params }) => {
    const role = params.role as MswRbacRole;
    if (!__MSW_ACC_ROLES.includes(role)) {
      return HttpResponse.json(
        { header: { status: 'FAILURE', requestId: 'r-mock', timestamp: new Date().toISOString() }, error: { code: 'EWS_404_unknown_role', message: `unknown role '${String(role)}'`, severity: 'MEDIUM' } },
        { status: 404 },
      );
    }
    const ops = Object.keys(__MSW_ACC_OPS).filter((op) => __MSW_ACC_OPS[op].includes(role));
    return HttpResponse.json(
      envelope({
        role,
        description: __MSW_ACC_ROLE_DESC[role],
        total_operations: ops.length,
        total_resources: __mswAccGroup(ops).length,
        resources: __mswAccGroup(ops),
      }),
    );
  }),
];
handlers.push(...__mswAccessControlHandlers);

// ──────────────────────────────────────────────────────────────────────
// M5.4 — Workflows handlers (additive — appended AFTER pushlist
// declarations so they are picked up at module load)
// ──────────────────────────────────────────────────────────────────────

interface MswWorkflowStep {
  step_order: number;
  name: string;
  description: string;
  required_role: string;
  expected_duration_hours: number;
  optional: boolean;
  requires_4_eyes?: boolean;
  approver_pool?: string[];
}

interface MswWorkflowTemplate {
  template_id: string;
  tenant_id: string;
  name: string;
  domain: string;
  description: string;
  steps: MswWorkflowStep[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
}

const __mswWorkflows = new Map<string, MswWorkflowTemplate>();
let __mswWorkflowSeq = 0;

function __mswSeedWorkflows() {
  if (__mswWorkflows.size > 0) return;
  __mswWorkflowSeq++;
  const t1: MswWorkflowTemplate = {
    template_id: `wft-BANK_DEMO-${String(__mswWorkflowSeq).padStart(5, '0')}`,
    tenant_id: 'BANK_DEMO',
    name: 'Stress-test approval workflow',
    domain: 'stress_test',
    description: 'RBI Form-K + IRDAI solvency stress approval chain',
    steps: [
      {
        step_order: 1, name: 'Author drafts shock vector',
        description: 'Risk analyst configures GDP/rate/FX shocks',
        required_role: 'risk_analyst', expected_duration_hours: 8, optional: false,
      },
      {
        step_order: 2, name: 'Maker submits + Checker approves (4-eyes)',
        description: 'Two distinct supervisors must independently approve',
        required_role: 'supervisor', expected_duration_hours: 4, optional: false,
        requires_4_eyes: true,
        approver_pool: ['supervisor', 'head_of_risk', 'compliance_officer'],
      },
      {
        step_order: 3, name: 'CRO sign-off',
        description: 'Single sign-off by Chief Risk Officer',
        required_role: 'head_of_risk', expected_duration_hours: 2, optional: false,
      },
    ],
    is_default: false,
    created_at: '2026-05-20T10:00:00.000Z',
    updated_at: '2026-05-20T10:00:00.000Z',
    created_by: 'alice.admin',
  };
  __mswWorkflows.set(t1.template_id, t1);
  __mswWorkflowSeq++;
  const t2: MswWorkflowTemplate = {
    template_id: `wft-BANK_DEMO-${String(__mswWorkflowSeq).padStart(5, '0')}`,
    tenant_id: 'BANK_DEMO',
    name: 'KYC onboarding review',
    domain: 'kyc_onboarding',
    description: 'New corporate onboarding KYC + AML checks',
    steps: [
      {
        step_order: 1, name: 'KYC analyst collects documents',
        description: '', required_role: 'kyc_analyst',
        expected_duration_hours: 24, optional: false,
      },
      {
        step_order: 2, name: 'Compliance officer reviews',
        description: '', required_role: 'compliance_officer',
        expected_duration_hours: 8, optional: false,
      },
    ],
    is_default: true,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    created_by: 'alice.admin',
  };
  __mswWorkflows.set(t2.template_id, t2);
}

function __mswDeriveRouting(steps: MswWorkflowStep[]) {
  return steps.map((s) => {
    const req4 = !!s.requires_4_eyes;
    const pool = (req4 ? (s.approver_pool ?? [s.required_role]) : [s.required_role]).slice();
    pool.sort((a, b) => a.localeCompare(b));
    return {
      step_order: s.step_order,
      step_name: s.name,
      strategy: req4 ? 'four_eyes' : 'single',
      pool,
      requires_distinct_actors: req4,
    };
  });
}

export function __resetMswWorkflows() {
  __mswWorkflows.clear();
  __mswWorkflowSeq = 0;
}

const __mswWorkflowHandlers = [
  http.get('/v1/workflows/templates', ({ request }) => {
    __mswSeedWorkflows();
    const url = new URL(request.url);
    const domain = url.searchParams.get('domain');
    const templates = Array.from(__mswWorkflows.values())
      .filter((t) => !domain || t.domain === domain)
      .sort((a, b) => a.name.localeCompare(b.name));
    return HttpResponse.json(envelope({ templates }));
  }),
  http.post('/v1/workflows/templates', async ({ request }) => {
    __mswSeedWorkflows();
    const raw = (await request.json()) as Record<string, unknown>;
    const inner =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    __mswWorkflowSeq++;
    const id = `wft-BANK_DEMO-${String(__mswWorkflowSeq).padStart(5, '0')}`;
    const t: MswWorkflowTemplate = {
      template_id: id,
      tenant_id: 'BANK_DEMO',
      name: String(inner.name ?? 'Untitled'),
      domain: String(inner.domain ?? 'other'),
      description: String(inner.description ?? ''),
      steps: ((inner.steps as MswWorkflowStep[]) ?? []).map((s) => ({ ...s })),
      is_default: !!inner.is_default,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: 'alice.admin',
    };
    __mswWorkflows.set(id, t);
    return HttpResponse.json(envelope(t), { status: 201 });
  }),
  http.get('/v1/workflows/templates/:template_id', ({ params }) => {
    __mswSeedWorkflows();
    const id = String(params.template_id);
    // Resolve /routing collision — handled below; this fires only for
    // bare /:template_id since MSW matches static segments first.
    if (id === 'routing') return HttpResponse.json(envelope({}));
    const t = __mswWorkflows.get(id);
    if (!t)
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_template', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    return HttpResponse.json(envelope(t));
  }),
  http.get('/v1/workflows/templates/:template_id/routing', ({ params }) => {
    __mswSeedWorkflows();
    const id = String(params.template_id);
    const t = __mswWorkflows.get(id);
    if (!t)
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_template', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    return HttpResponse.json(envelope({
      template_id: t.template_id,
      name: t.name,
      domain: t.domain,
      stages: __mswDeriveRouting(t.steps),
    }));
  }),
  http.patch('/v1/workflows/templates/:template_id', async ({ params, request }) => {
    __mswSeedWorkflows();
    const id = String(params.template_id);
    const t = __mswWorkflows.get(id);
    if (!t)
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_template', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    const raw = (await request.json()) as Record<string, unknown>;
    const patch =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    if (patch.name !== undefined) t.name = String(patch.name);
    if (patch.description !== undefined) t.description = String(patch.description);
    if (patch.steps !== undefined) t.steps = (patch.steps as MswWorkflowStep[]).map((s) => ({ ...s }));
    if (patch.is_default !== undefined) t.is_default = !!patch.is_default;
    t.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(t));
  }),
  http.delete('/v1/workflows/templates/:template_id', ({ params }) => {
    __mswSeedWorkflows();
    const id = String(params.template_id);
    if (!__mswWorkflows.has(id))
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_template', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    __mswWorkflows.delete(id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/v1/workflows/templates/:template_id/clone', async ({ params, request }) => {
    __mswSeedWorkflows();
    const id = String(params.template_id);
    const src = __mswWorkflows.get(id);
    if (!src)
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_template', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    const raw = (await request.json()) as Record<string, unknown>;
    const inner =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    __mswWorkflowSeq++;
    const newId = `wft-BANK_DEMO-${String(__mswWorkflowSeq).padStart(5, '0')}`;
    const clone: MswWorkflowTemplate = {
      ...src,
      template_id: newId,
      name: String(inner.name ?? `${src.name} (copy)`),
      description: `Cloned from ${src.name}: ${src.description}`,
      is_default: false,
      steps: src.steps.map((s) => ({ ...s })),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    __mswWorkflows.set(newId, clone);
    return HttpResponse.json(envelope(clone), { status: 201 });
  }),
];

handlers.push(...__mswWorkflowHandlers);

// ──────────────────────────────────────────────────────────────────────
// M6.3 — Testing Hub MSW handlers
// ──────────────────────────────────────────────────────────────────────

interface MswTestingCase {
  test_id: string;
  tenant_id: string;
  name: string;
  target_type: string;
  target_id: string;
  description: string;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
}

interface MswTestingRun {
  run_id: string;
  test_id: string;
  tenant_id: string;
  status: string;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
  triggered_by: string;
  message: string | null;
}

const __mswTestingCases = new Map<string, MswTestingCase>();
const __mswTestingRuns = new Map<string, MswTestingRun>();
let __mswTestingCaseSeq = 0;
let __mswTestingRunSeq = 0;
let __mswTestingReportSeq = 0;
let __mswTestingSchedule = {
  tenant_id: 'BANK_DEMO',
  enabled: false,
  cron_expression: '0 6 * * *',
  updated_at: '',
  updated_by: '',
};

function __mswTestingSeed() {
  if (__mswTestingCases.size > 0) return;
  // Two seed cases so the page isn't empty in dev mode
  for (const c of [
    {
      name: 'RULE-001 fires on high DPD',
      target_type: 'rule',
      target_id: 'RULE-001',
      description: 'High-DPD rule should fire CRITICAL when dpd > 90',
      inputs: { dpd: 95 },
      expected: { severity: 'CRITICAL', fired: true },
    },
    {
      name: 'FIN-001 indicator computes utilization',
      target_type: 'indicator',
      target_id: 'FIN-001',
      description: 'Utilization indicator stays in [0,1]',
      inputs: { balance: 800_000, limit: 1_000_000 },
      expected: { value: 0.8 },
    },
  ]) {
    __mswTestingCaseSeq++;
    const id = `tst-BANK_DEMO-${String(__mswTestingCaseSeq).padStart(6, '0')}`;
    __mswTestingCases.set(id, {
      test_id: id,
      tenant_id: 'BANK_DEMO',
      name: c.name,
      target_type: c.target_type,
      target_id: c.target_id,
      description: c.description,
      inputs: c.inputs,
      expected: c.expected,
      enabled: true,
      created_at: '2026-05-20T10:00:00.000Z',
      updated_at: '2026-05-20T10:00:00.000Z',
      created_by: 'alice.admin',
    });
  }
}

function __mswTestingRunCase(tc: MswTestingCase, triggered_by: string): MswTestingRun {
  __mswTestingRunSeq++;
  // Deterministic stub: status hinges on a content hash so dev mode is stable
  const hash = tc.test_id.charCodeAt(tc.test_id.length - 1) + new Date().getUTCDate();
  const status = hash % 7 === 0 ? 'fail' : 'pass';
  const run: MswTestingRun = {
    run_id: `tstrun-BANK_DEMO-${String(__mswTestingRunSeq).padStart(5, '0')}`,
    test_id: tc.test_id,
    tenant_id: 'BANK_DEMO',
    status,
    duration_ms: 30 + Math.floor(Math.random() * 250),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    triggered_by,
    message: status === 'pass' ? 'OK' : 'Expected output did not match',
  };
  __mswTestingRuns.set(run.run_id, run);
  return run;
}

export function __resetMswM63() {
  __mswTestingCases.clear();
  __mswTestingRuns.clear();
  __mswTestingCaseSeq = 0;
  __mswTestingRunSeq = 0;
  __mswTestingReportSeq = 0;
  __mswTestingSchedule = {
    tenant_id: 'BANK_DEMO',
    enabled: false,
    cron_expression: '0 6 * * *',
    updated_at: '',
    updated_by: '',
  };
}

const __mswTestingHandlers = [
  http.get('/v1/testing/cases', ({ request }) => {
    __mswTestingSeed();
    const url = new URL(request.url);
    const target_type = url.searchParams.get('target_type');
    const enabled_only = url.searchParams.get('enabled_only') === 'true';
    const cases = Array.from(__mswTestingCases.values())
      .filter((c) => !target_type || c.target_type === target_type)
      .filter((c) => !enabled_only || c.enabled)
      .sort((a, b) => a.name.localeCompare(b.name));
    return HttpResponse.json(envelope({ cases }));
  }),
  http.post('/v1/testing/cases', async ({ request }) => {
    __mswTestingSeed();
    const raw = (await request.json()) as Record<string, unknown>;
    const inner =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    __mswTestingCaseSeq++;
    const id = `tst-BANK_DEMO-${String(__mswTestingCaseSeq).padStart(6, '0')}`;
    const tc: MswTestingCase = {
      test_id: id,
      tenant_id: 'BANK_DEMO',
      name: String(inner.name ?? 'Untitled'),
      target_type: String(inner.target_type ?? 'rule'),
      target_id: String(inner.target_id ?? ''),
      description: String(inner.description ?? ''),
      inputs: (inner.inputs as Record<string, unknown>) ?? {},
      expected: (inner.expected as Record<string, unknown>) ?? {},
      enabled: inner.enabled !== false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: 'alice.admin',
    };
    __mswTestingCases.set(id, tc);
    return HttpResponse.json(envelope(tc), { status: 201 });
  }),
  http.get('/v1/testing/cases/:case_id', ({ params }) => {
    __mswTestingSeed();
    const id = String(params.case_id);
    const tc = __mswTestingCases.get(id);
    if (!tc) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_case', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(tc));
  }),
  http.put('/v1/testing/cases/:case_id', async ({ params, request }) => {
    __mswTestingSeed();
    const id = String(params.case_id);
    const tc = __mswTestingCases.get(id);
    if (!tc) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_case', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    }
    const raw = (await request.json()) as Record<string, unknown>;
    const patch =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    if (patch.name !== undefined) tc.name = String(patch.name);
    if (patch.description !== undefined) tc.description = String(patch.description);
    if (patch.inputs !== undefined) tc.inputs = patch.inputs as Record<string, unknown>;
    if (patch.expected !== undefined) tc.expected = patch.expected as Record<string, unknown>;
    if (patch.enabled !== undefined) tc.enabled = !!patch.enabled;
    tc.updated_at = new Date().toISOString();
    return HttpResponse.json(envelope(tc));
  }),
  http.delete('/v1/testing/cases/:case_id', ({ params }) => {
    const id = String(params.case_id);
    if (!__mswTestingCases.has(id)) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_case', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    }
    __mswTestingCases.delete(id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/v1/testing/cases/:case_id/run', ({ params }) => {
    __mswTestingSeed();
    const id = String(params.case_id);
    const tc = __mswTestingCases.get(id);
    if (!tc) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_case', `unknown ${id}`, 'MEDIUM'),
        { status: 404 },
      );
    }
    if (!tc.enabled) {
      return HttpResponse.json(
        envelopeError('EWS_409_case_disabled', 'test is disabled', 'MEDIUM'),
        { status: 409 },
      );
    }
    const run = __mswTestingRunCase(tc, 'alice.admin');
    return HttpResponse.json(envelope(run), { status: 201 });
  }),
  http.post('/v1/testing/run-all', () => {
    __mswTestingSeed();
    const enabled = Array.from(__mswTestingCases.values()).filter((c) => c.enabled);
    const runs = enabled.map((tc) => __mswTestingRunCase(tc, 'alice.admin'));
    const counts = { pass: 0, fail: 0, error: 0, skipped: 0 };
    for (const r of runs) {
      if (r.status === 'pass') counts.pass++;
      else if (r.status === 'fail') counts.fail++;
      else if (r.status === 'error') counts.error++;
      else if (r.status === 'skipped') counts.skipped++;
    }
    __mswTestingReportSeq++;
    return HttpResponse.json(
      envelope({
        report_id: `tstrep-BANK_DEMO-${String(__mswTestingReportSeq).padStart(5, '0')}`,
        tenant_id: 'BANK_DEMO',
        triggered_by: 'alice.admin',
        triggered_at: new Date().toISOString(),
        total_tests: runs.length,
        total_pass: counts.pass,
        total_fail: counts.fail,
        total_error: counts.error,
        total_skipped: counts.skipped,
        duration_ms: runs.reduce((s, r) => s + r.duration_ms, 0),
        runs,
      }),
      { status: 201 },
    );
  }),
  http.post('/v1/testing/bulk-upload', async ({ request }) => {
    __mswTestingSeed();
    const raw = (await request.json()) as Record<string, unknown>;
    const inner =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    const csv = String(inner.csv ?? '');
    if (!csv) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'csv body required', 'MEDIUM'),
        { status: 400 },
      );
    }
    const lines = csv.split('\n').slice(1).filter((l) => l.trim().length > 0);
    let created = 0;
    for (const line of lines) {
      const [name, target_type, target_id, description] = line.split(',');
      if (!name || !target_type || !target_id) continue;
      __mswTestingCaseSeq++;
      const id = `tst-BANK_DEMO-${String(__mswTestingCaseSeq).padStart(6, '0')}`;
      __mswTestingCases.set(id, {
        test_id: id,
        tenant_id: 'BANK_DEMO',
        name: name.trim(),
        target_type: target_type.trim(),
        target_id: target_id.trim(),
        description: (description ?? '').trim(),
        inputs: {},
        expected: {},
        enabled: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: 'alice.admin',
      });
      created++;
    }
    return HttpResponse.json(envelope({
      created_count: created,
      skipped_count: lines.length - created,
      rows: lines.map((_, i) => ({ line: i + 2, status: 'created' as const })),
    }));
  }),
  http.get('/v1/testing/runs', ({ request }) => {
    const url = new URL(request.url);
    const test_id = url.searchParams.get('test_id');
    const status = url.searchParams.get('status');
    const runs = Array.from(__mswTestingRuns.values())
      .filter((r) => !test_id || r.test_id === test_id)
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
    return HttpResponse.json(envelope({ runs }));
  }),
  http.get('/v1/testing/schedules', () => {
    return HttpResponse.json(envelope({ schedules: [__mswTestingSchedule] }));
  }),
  http.post('/v1/testing/schedules', async ({ request }) => {
    const raw = (await request.json()) as Record<string, unknown>;
    const inner =
      raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
        ? ((raw as { body: Record<string, unknown> }).body)
        : raw;
    __mswTestingSchedule = {
      tenant_id: 'BANK_DEMO',
      enabled: !!inner.enabled,
      cron_expression: String(inner.cron_expression ?? '0 6 * * *'),
      updated_at: new Date().toISOString(),
      updated_by: 'alice.admin',
    };
    return HttpResponse.json(envelope(__mswTestingSchedule), { status: 201 });
  }),
];

handlers.push(...__mswTestingHandlers);

// ──────────────────────────────────────────────────────────────────────
// M6.4 — Glossary MSW handlers
// ──────────────────────────────────────────────────────────────────────

interface MswGlossaryTerm {
  term_id: string;
  term: string;
  category: string;
  definition: string;
  source_doc?: string;
  related_term_ids?: string[];
  source?: 'platform' | 'tenant';
  updated_at?: string;
  updated_by?: string;
}

const __mswGlossarySeed: MswGlossaryTerm[] = [
  { term_id: 'sma', term: 'SMA — Special Mention Account', category: 'regulatory', definition: 'Per RBI Master Direction (April 2015), accounts overdue 1-90 days are classified as SMA-0/1/2. Accounts overdue >90 days are NPA.', source_doc: 'RBI Master Direction on Stressed Assets', related_term_ids: ['npa', 'dpd'], source: 'platform' },
  { term_id: 'npa', term: 'NPA — Non-Performing Asset', category: 'regulatory', definition: 'An account where principal/interest is overdue for >90 days.', source_doc: 'RBI IRACP Norms', related_term_ids: ['sma'], source: 'platform' },
  { term_id: 'dpd', term: 'DPD — Days Past Due', category: 'banking', definition: 'Number of days past the original due date that an installment remains unpaid.', related_term_ids: ['sma', 'npa'], source: 'platform' },
  { term_id: 'pd', term: 'PD — Probability of Default', category: 'risk', definition: 'Probability that an obligor will default within a defined horizon.', related_term_ids: ['lgd', 'ead', 'ecl'], source: 'platform' },
  { term_id: 'lgd', term: 'LGD — Loss Given Default', category: 'risk', definition: 'Proportion of exposure that is lost when a default event occurs.', related_term_ids: ['pd', 'ead'], source: 'platform' },
  { term_id: 'shap', term: 'SHAP — SHapley Additive exPlanations', category: 'ai_ml', definition: 'A game-theoretic approach to explaining ML model output.', source: 'platform' },
  { term_id: 'maker_checker', term: 'Maker-Checker (4-eyes)', category: 'workflow', definition: 'A control where maker proposes and a distinct checker approves the action.', source_doc: 'RBI Operational Risk Framework', source: 'platform' },
];
const __mswGlossaryOverlay = new Map<string, MswGlossaryTerm>();
const __mswGlossaryTombstones = new Set<string>();

function __mswGlossaryEffective(): MswGlossaryTerm[] {
  const out: MswGlossaryTerm[] = [];
  for (const t of __mswGlossarySeed) {
    if (__mswGlossaryTombstones.has(t.term_id)) continue;
    const ovr = __mswGlossaryOverlay.get(t.term_id);
    out.push(ovr ? { ...ovr, source: 'tenant' } : { ...t });
  }
  const platformIds = new Set(__mswGlossarySeed.map((t) => t.term_id));
  for (const t of __mswGlossaryOverlay.values()) {
    if (!platformIds.has(t.term_id)) out.push({ ...t, source: 'tenant' });
  }
  return out;
}

export function __resetMswM64() {
  __mswGlossaryOverlay.clear();
  __mswGlossaryTombstones.clear();
}

const __mswGlossaryHandlers = [
  http.get('/v1/glossary/terms', ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.toLowerCase();
    const category = url.searchParams.get('category');
    let terms = __mswGlossaryEffective();
    if (category) terms = terms.filter((t) => t.category === category);
    if (q) {
      terms = terms.filter(
        (t) =>
          t.term.toLowerCase().includes(q) ||
          t.definition.toLowerCase().includes(q) ||
          t.term_id.toLowerCase().includes(q),
      );
    }
    return HttpResponse.json(envelope({ terms }));
  }),
  http.get('/v1/glossary/categories', () => {
    return HttpResponse.json(envelope({
      categories: ['banking', 'regulatory', 'risk', 'ai_ml', 'workflow', 'fraud', 'insurance'],
    }));
  }),
  http.get('/v1/glossary/terms/:term_id', ({ params }) => {
    const id = String(params.term_id);
    if (__mswGlossaryTombstones.has(id)) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_term', `unknown ${id}`, 'LOW'), { status: 404 });
    }
    const ovr = __mswGlossaryOverlay.get(id);
    if (ovr) return HttpResponse.json(envelope({ ...ovr, source: 'tenant' }));
    const platform = __mswGlossarySeed.find((t) => t.term_id === id);
    if (!platform) return HttpResponse.json(envelopeError('EWS_404_unknown_term', `unknown ${id}`, 'LOW'), { status: 404 });
    return HttpResponse.json(envelope({ ...platform, source: 'platform' }));
  }),
  http.post('/v1/glossary/terms', async ({ request }) => {
    const raw = (await request.json()) as Record<string, unknown>;
    const inner = raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
      ? ((raw as { body: Record<string, unknown> }).body) : raw;
    const term_id = String(inner.term_id ?? '');
    if (!term_id || !/^[a-z0-9_]{2,64}$/.test(term_id)) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_term_id', 'term_id invalid', 'MEDIUM'), { status: 400 });
    }
    if (__mswGlossaryOverlay.has(term_id)) {
      return HttpResponse.json(envelopeError('EWS_409_duplicate_term_id', `${term_id} already exists`, 'MEDIUM'), { status: 409 });
    }
    if (__mswGlossarySeed.some((t) => t.term_id === term_id) && !__mswGlossaryTombstones.has(term_id)) {
      return HttpResponse.json(envelopeError('EWS_409_platform_term_exists', `${term_id} is a platform term`, 'MEDIUM'), { status: 409 });
    }
    const entry: MswGlossaryTerm = {
      term_id,
      term: String(inner.term ?? ''),
      category: String(inner.category ?? 'banking'),
      definition: String(inner.definition ?? ''),
      source_doc: inner.source_doc as string | undefined,
      related_term_ids: inner.related_term_ids as string[] | undefined,
      source: 'tenant',
      updated_at: new Date().toISOString(),
      updated_by: 'alice.admin',
    };
    __mswGlossaryOverlay.set(term_id, entry);
    __mswGlossaryTombstones.delete(term_id);
    return HttpResponse.json(envelope(entry), { status: 201 });
  }),
  http.put('/v1/glossary/terms/:term_id', async ({ params, request }) => {
    const id = String(params.term_id);
    if (__mswGlossaryTombstones.has(id)) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_term', `${id} is hidden`, 'LOW'), { status: 404 });
    }
    const raw = (await request.json()) as Record<string, unknown>;
    const patch = raw && typeof raw === 'object' && 'body' in raw && 'header' in raw
      ? ((raw as { body: Record<string, unknown> }).body) : raw;
    const existing = __mswGlossaryOverlay.get(id) ?? __mswGlossarySeed.find((t) => t.term_id === id);
    if (!existing) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_term', `unknown ${id}`, 'LOW'), { status: 404 });
    }
    const merged: MswGlossaryTerm = {
      ...existing,
      ...(patch.term !== undefined ? { term: String(patch.term) } : {}),
      ...(patch.category !== undefined ? { category: String(patch.category) } : {}),
      ...(patch.definition !== undefined ? { definition: String(patch.definition) } : {}),
      ...(patch.source_doc !== undefined ? { source_doc: String(patch.source_doc) } : {}),
      ...(patch.related_term_ids !== undefined ? { related_term_ids: patch.related_term_ids as string[] } : {}),
      source: 'tenant',
      updated_at: new Date().toISOString(),
      updated_by: 'alice.admin',
    };
    __mswGlossaryOverlay.set(id, merged);
    return HttpResponse.json(envelope(merged));
  }),
  http.delete('/v1/glossary/terms/:term_id', ({ params }) => {
    const id = String(params.term_id);
    if (__mswGlossaryOverlay.has(id)) {
      __mswGlossaryOverlay.delete(id);
      if (__mswGlossarySeed.some((t) => t.term_id === id)) {
        __mswGlossaryTombstones.add(id);
      }
      return new HttpResponse(null, { status: 204 });
    }
    if (__mswGlossarySeed.some((t) => t.term_id === id) && !__mswGlossaryTombstones.has(id)) {
      __mswGlossaryTombstones.add(id);
      return new HttpResponse(null, { status: 204 });
    }
    return HttpResponse.json(envelopeError('EWS_404_unknown_term', `unknown ${id}`, 'LOW'), { status: 404 });
  }),
];

handlers.push(...__mswGlossaryHandlers);

// ────────────────────────────────────────────────────────────────────
// Phase 9 T11 — Master Setup framework MSW handlers.
// Mirrors services/bff/src/masters/registry.ts so the SPA can render the
// reusable MasterEntityPage end-to-end in dev mode without the BFF up.
// ────────────────────────────────────────────────────────────────────

interface MswMasterField {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'enum';
  required?: boolean;
  max_length?: number;
  enum_values?: readonly string[];
  label?: string;
}
interface MswMasterRow {
  id: string;
  tenant_id: string;
  fields: Record<string, unknown>;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}
interface MswMasterEntity {
  entity: string;
  label: string;
  label_plural: string;
  tenant_scoped: boolean;
  fields: MswMasterField[];
  rows: MswMasterRow[];
}

const __mswMasterEntities: MswMasterEntity[] = [
  {
    entity: 'countries',
    label: 'Country',
    label_plural: 'Countries',
    tenant_scoped: false,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 3, label: 'ISO code' },
      { name: 'name', type: 'string', required: true, max_length: 80, label: 'Name' },
      { name: 'region', type: 'enum', enum_values: ['AF', 'AS', 'EU', 'NA', 'OC', 'SA'], label: 'Region' },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('countries', 0, { code: 'IN', name: 'India', region: 'AS', active: true }),
      mswMasterSeedRow('countries', 1, { code: 'BT', name: 'Bhutan', region: 'AS', active: true }),
      mswMasterSeedRow('countries', 2, { code: 'KE', name: 'Kenya', region: 'AF', active: true }),
    ],
  },
  {
    entity: 'departments',
    label: 'Department',
    label_plural: 'Departments',
    tenant_scoped: true,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
      { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
      {
        name: 'function',
        type: 'enum',
        enum_values: ['risk', 'compliance', 'operations', 'it', 'audit', 'business'],
        label: 'Function',
      },
      { name: 'headcount', type: 'integer', label: 'Headcount' },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('departments', 0, { code: 'CR', name: 'Credit Risk', function: 'risk', headcount: 24, active: true }),
      mswMasterSeedRow('departments', 1, { code: 'OPS', name: 'Operations', function: 'operations', headcount: 80, active: true }),
    ],
  },
  {
    entity: 'risk-categories',
    label: 'Risk Category',
    label_plural: 'Risk Categories',
    tenant_scoped: true,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
      { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
      {
        name: 'severity',
        type: 'enum',
        enum_values: ['critical', 'high', 'medium', 'low'],
        label: 'Default severity',
      },
      {
        name: 'domain',
        type: 'enum',
        enum_values: ['credit', 'fraud', 'aml', 'operational', 'market', 'liquidity'],
        label: 'Domain',
      },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('risk-categories', 0, { code: 'NPA', name: 'NPA / Default risk', severity: 'critical', domain: 'credit', active: true }),
      mswMasterSeedRow('risk-categories', 1, { code: 'FRD_VEL', name: 'Velocity fraud', severity: 'critical', domain: 'fraud', active: true }),
    ],
  },
  // ──────────────────────────────────────────────────────────────────
  // Phase 9 T11 expansion — 6 new entities. Mirrors registry.ts on
  // the BFF. Slim seed (3-5 rows each) is enough for dev-mode demos.
  // ──────────────────────────────────────────────────────────────────
  {
    entity: 'currencies',
    label: 'Currency',
    label_plural: 'Currencies',
    tenant_scoped: false,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 3, label: 'ISO code' },
      { name: 'name', type: 'string', required: true, max_length: 80, label: 'Name' },
      { name: 'symbol', type: 'string', max_length: 8, label: 'Symbol' },
      { name: 'decimal_places', type: 'integer', label: 'Decimal places' },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('currencies', 0, { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimal_places: 2, active: true }),
      mswMasterSeedRow('currencies', 1, { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', decimal_places: 2, active: true }),
      mswMasterSeedRow('currencies', 2, { code: 'USD', name: 'United States Dollar', symbol: '$', decimal_places: 2, active: true }),
    ],
  },
  {
    entity: 'severity-levels',
    label: 'Severity Level',
    label_plural: 'Severity Levels',
    tenant_scoped: true,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
      { name: 'name', type: 'string', required: true, max_length: 80, label: 'Name' },
      { name: 'colour', type: 'enum', enum_values: ['red', 'orange', 'amber', 'yellow', 'green'], label: 'RAG colour' },
      { name: 'min_score', type: 'integer', label: 'Min score' },
      { name: 'max_score', type: 'integer', label: 'Max score' },
      { name: 'action_required', type: 'boolean', label: 'Action required' },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('severity-levels', 0, { code: 'RED', name: 'Red — Immediate action', colour: 'red', min_score: 80, max_score: 100, action_required: true, active: true }),
      mswMasterSeedRow('severity-levels', 1, { code: 'ORG', name: 'Orange — Escalate', colour: 'orange', min_score: 60, max_score: 79, action_required: true, active: true }),
      mswMasterSeedRow('severity-levels', 2, { code: 'GRN', name: 'Green — Healthy', colour: 'green', min_score: 0, max_score: 19, action_required: false, active: true }),
    ],
  },
  {
    entity: 'case-types',
    label: 'Case Type',
    label_plural: 'Case Types',
    tenant_scoped: true,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
      { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
      { name: 'domain', type: 'enum', enum_values: ['credit', 'fraud', 'aml', 'operational', 'compliance', 'underwriting', 'claims'], label: 'Domain' },
      { name: 'default_sla_hours', type: 'integer', label: 'Default SLA (hours)' },
      { name: 'requires_maker_checker', type: 'boolean', label: 'Maker-checker' },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('case-types', 0, { code: 'NPA_INV', name: 'NPA investigation', domain: 'credit', default_sla_hours: 24, requires_maker_checker: true, active: true }),
      mswMasterSeedRow('case-types', 1, { code: 'FRD_INV', name: 'Fraud investigation', domain: 'fraud', default_sla_hours: 4, requires_maker_checker: true, active: true }),
      mswMasterSeedRow('case-types', 2, { code: 'AML_STR', name: 'AML / STR review', domain: 'aml', default_sla_hours: 48, requires_maker_checker: true, active: true }),
    ],
  },
  {
    entity: 'case-priorities',
    label: 'Case Priority',
    label_plural: 'Case Priorities',
    tenant_scoped: true,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 8, label: 'Code' },
      { name: 'name', type: 'string', required: true, max_length: 80, label: 'Name' },
      { name: 'sla_hours', type: 'integer', label: 'SLA (hours)' },
      { name: 'escalate_after_hours', type: 'integer', label: 'Escalate after (hours)' },
      { name: 'colour', type: 'enum', enum_values: ['red', 'orange', 'amber', 'yellow', 'green'], label: 'RAG colour' },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('case-priorities', 0, { code: 'P1', name: 'P1 — Critical', sla_hours: 4, escalate_after_hours: 1, colour: 'red', active: true }),
      mswMasterSeedRow('case-priorities', 1, { code: 'P2', name: 'P2 — High', sla_hours: 24, escalate_after_hours: 8, colour: 'orange', active: true }),
      mswMasterSeedRow('case-priorities', 2, { code: 'P3', name: 'P3 — Medium', sla_hours: 72, escalate_after_hours: 24, colour: 'amber', active: true }),
      mswMasterSeedRow('case-priorities', 3, { code: 'P4', name: 'P4 — Low', sla_hours: 168, escalate_after_hours: 96, colour: 'yellow', active: true }),
    ],
  },
  {
    entity: 'regulatory-frameworks',
    label: 'Regulatory Framework',
    label_plural: 'Regulatory Frameworks',
    tenant_scoped: false,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
      { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
      { name: 'country', type: 'enum', enum_values: ['IN', 'KE', 'BT', 'NP', 'LK', 'AE', 'GB', 'US'], label: 'Country' },
      { name: 'vertical', type: 'enum', enum_values: ['banking', 'insurance', 'capital_markets', 'payments', 'aml'], label: 'Vertical' },
      { name: 'classification_scheme', type: 'enum', enum_values: ['SMA', 'STAGE', 'NONE'], label: 'Classification scheme' },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('regulatory-frameworks', 0, { code: 'RBI', name: 'Reserve Bank of India', country: 'IN', vertical: 'banking', classification_scheme: 'SMA', active: true }),
      mswMasterSeedRow('regulatory-frameworks', 1, { code: 'IRDAI', name: 'Insurance Regulatory and Development Authority of India', country: 'IN', vertical: 'insurance', classification_scheme: 'STAGE', active: true }),
      mswMasterSeedRow('regulatory-frameworks', 2, { code: 'CBK', name: 'Central Bank of Kenya', country: 'KE', vertical: 'banking', classification_scheme: 'SMA', active: true }),
    ],
  },
  {
    entity: 'channels',
    label: 'Channel',
    label_plural: 'Channels',
    tenant_scoped: true,
    fields: [
      { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
      { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
      { name: 'kind', type: 'enum', enum_values: ['email', 'sms', 'push', 'in_app', 'webhook', 'phone'], label: 'Kind' },
      { name: 'rate_limit_per_minute', type: 'integer', label: 'Rate limit (per min)' },
      { name: 'quiet_hours_enabled', type: 'boolean', label: 'Honour quiet hours' },
      { name: 'active', type: 'boolean', label: 'Active' },
    ],
    rows: [
      mswMasterSeedRow('channels', 0, { code: 'EMAIL_PRI', name: 'Primary email', kind: 'email', rate_limit_per_minute: 60, quiet_hours_enabled: true, active: true }),
      mswMasterSeedRow('channels', 1, { code: 'SMS_PRI', name: 'Primary SMS', kind: 'sms', rate_limit_per_minute: 30, quiet_hours_enabled: true, active: true }),
      mswMasterSeedRow('channels', 2, { code: 'INAPP_BELL', name: 'In-app bell', kind: 'in_app', rate_limit_per_minute: 600, quiet_hours_enabled: false, active: true }),
    ],
  },
];

// ──────────────────────────────────────────────────────────────────
// Enterprise Permission Matrix (049 overlay) — MSW seed fixtures.
// Trimmed catalog (5 modules × 5 actions × 4 roles) — enough for the
// SPA matrix editor smoke test in dev mode.
// ──────────────────────────────────────────────────────────────────
const __mswRbacActions = [
  { id: 'view', label: 'View', description: 'Read or list records in the module', sort_order: 1 },
  { id: 'create', label: 'Create', description: 'Create new records within the module', sort_order: 2 },
  { id: 'edit', label: 'Edit', description: 'Modify existing records', sort_order: 3 },
  { id: 'delete', label: 'Delete', description: 'Soft-delete or hard-delete records', sort_order: 4 },
  { id: 'approve', label: 'Approve', description: 'Approve maker-checker workflows', sort_order: 5 },
  { id: 'export', label: 'Export', description: 'Export records to CSV / PDF / Excel', sort_order: 6 },
  { id: 'configure', label: 'Configure', description: 'Edit module configuration + thresholds', sort_order: 7 },
] as const;

const __mswRbacModules = [
  { id: 'dashboard', label: 'Dashboard', description: 'Enterprise + per-role landing dashboards', category: 'dashboard', domain: 'both', sort_order: 1, active: true },
  { id: 'borrower_watch', label: 'Borrower Watch', description: 'Per-borrower watchlist + drill-through', category: 'banking', domain: 'banking', sort_order: 10, active: true },
  { id: 'claims_anomaly', label: 'Claims Anomaly', description: 'Claim-fraud detection', category: 'insurance', domain: 'insurance', sort_order: 20, active: true },
  { id: 'rules_engine', label: 'Rules Engine', description: 'Rule authoring + simulation', category: 'ai', domain: 'both', sort_order: 40, active: true },
  { id: 'users', label: 'Users & RBAC', description: 'User lifecycle', category: 'admin', domain: 'both', sort_order: 60, active: true },
  { id: 'audit_trail', label: 'Audit Trail', description: 'Hash-chained audit events', category: 'admin', domain: 'both', sort_order: 62, active: true },
] as const;

const __mswRbacRoles = [
  'super_admin', 'country_admin', 'bank_admin', 'insurance_admin', 'risk_analyst',
  'fraud_analyst', 'credit_officer', 'operations_user', 'auditor', 'read_only_user',
];

const __mswRbacGrants: Array<{ role_id: string; module_id: string; action_id: string }> = [
  // super_admin → everything
  ...__mswRbacModules.flatMap((m) =>
    __mswRbacActions.map((a) => ({ role_id: 'super_admin', module_id: m.id, action_id: a.id })),
  ),
  // risk_analyst → view + edit on banking + dashboard
  { role_id: 'risk_analyst', module_id: 'dashboard', action_id: 'view' },
  { role_id: 'risk_analyst', module_id: 'borrower_watch', action_id: 'view' },
  { role_id: 'risk_analyst', module_id: 'borrower_watch', action_id: 'edit' },
  { role_id: 'risk_analyst', module_id: 'rules_engine', action_id: 'view' },
  // auditor → view + export on audit-relevant
  { role_id: 'auditor', module_id: 'dashboard', action_id: 'view' },
  { role_id: 'auditor', module_id: 'audit_trail', action_id: 'view' },
  { role_id: 'auditor', module_id: 'audit_trail', action_id: 'export' },
  // read_only_user → strict view
  { role_id: 'read_only_user', module_id: 'dashboard', action_id: 'view' },
  { role_id: 'read_only_user', module_id: 'borrower_watch', action_id: 'view' },
];

function __mswRbacGridFor(role: string): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  for (const m of __mswRbacModules) {
    out[m.id] = {};
    for (const a of __mswRbacActions) out[m.id][a.id] = false;
  }
  for (const e of __mswRbacGrants) {
    if (e.role_id !== role) continue;
    out[e.module_id] ??= {};
    out[e.module_id][e.action_id] = true;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// Tenant Governance (051 overlay) — MSW seed fixtures.
// ──────────────────────────────────────────────────────────────────
interface MswBranch {
  branch_id: string;
  tenant_id: string;
  country_code: string;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  manager_user: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface MswComplianceRule {
  rule_id: string;
  country_code: string;
  regulator: string;
  domain: 'banking' | 'insurance' | 'both';
  rule_code: string;
  title: string;
  description: string;
  requirement_kind: 'reporting' | 'capital' | 'kyc' | 'sanctions' | 'governance' | 'data_residency' | 'audit';
  severity: 'mandatory' | 'recommended' | 'advisory';
  effective_from: string | null;
  effective_until: string | null;
  source_url: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const __mswGovTs = new Date().toISOString();

const __mswBranches: MswBranch[] = [
  { branch_id: 'br-hdfc-mumbai-fort',   tenant_id: 'HDFC_BANK',     country_code: 'IN', code: 'HDFC001', name: 'HDFC Bank Fort Branch',     city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
  { branch_id: 'br-hdfc-delhi-cp',      tenant_id: 'HDFC_BANK',     country_code: 'IN', code: 'HDFC002', name: 'HDFC Bank Connaught Place', city: 'Delhi',    state: 'Delhi',       address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
  { branch_id: 'br-icici-mumbai-bkc',   tenant_id: 'ICICI_BANK',    country_code: 'IN', code: 'ICIC001', name: 'ICICI Bank BKC',            city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
  { branch_id: 'br-sbi-mumbai-main',    tenant_id: 'SBI',           country_code: 'IN', code: 'SBI001',  name: 'State Bank of India Main',  city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
  { branch_id: 'br-hdfcergo-mumbai-hq', tenant_id: 'HDFC_ERGO',     country_code: 'IN', code: 'HERGO01', name: 'HDFC ERGO Mumbai HQ',       city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
  { branch_id: 'br-icicilom-mumbai-hq', tenant_id: 'ICICI_LOMBARD', country_code: 'IN', code: 'ILOM001', name: 'ICICI Lombard Mumbai HQ',   city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
  { branch_id: 'br-bank-demo-main',     tenant_id: 'BANK_DEMO',     country_code: 'IN', code: 'DEMO001', name: 'APEX Demo Bank — Main',     city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
  { branch_id: 'br-bil-thimphu',        tenant_id: 'BIL',           country_code: 'BT', code: 'BIL001',  name: 'BIL Thimphu Head Office',   city: 'Thimphu',  state: 'Thimphu',     address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
];

const __mswComplianceRules: MswComplianceRule[] = [
  { rule_id: 'cr-rbi-md-npa',   country_code: 'IN', regulator: 'RBI',   domain: 'banking',   rule_code: 'RBI-MD-NPA-2024',   title: 'IRACP — Income Recognition + Asset Classification', description: 'Loans classified as NPA when DPD ≥ 90; SMA-0/1/2 tiers per DPD bracket. Quarterly reporting to RBI.', requirement_kind: 'reporting',     severity: 'mandatory', effective_from: '2024-04-01', effective_until: null, source_url: 'https://www.rbi.org.in/', active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
  { rule_id: 'cr-rbi-pmla',     country_code: 'IN', regulator: 'RBI',   domain: 'banking',   rule_code: 'RBI-PMLA-2002',     title: 'PMLA — Anti Money Laundering',                       description: 'KYC + Sanctions screening + STR/CTR reporting to FIU-IND.',                                          requirement_kind: 'kyc',           severity: 'mandatory', effective_from: '2002-07-01', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
  { rule_id: 'cr-irdai-cg',     country_code: 'IN', regulator: 'IRDAI', domain: 'insurance', rule_code: 'IRDAI-CG-2016',     title: 'Corporate Governance Guidelines',                    description: 'Board composition + risk committees + investment committee + audit committee.',                       requirement_kind: 'governance',    severity: 'mandatory', effective_from: '2016-05-18', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
  { rule_id: 'cr-irdai-claims', country_code: 'IN', regulator: 'IRDAI', domain: 'insurance', rule_code: 'IRDAI-CLM-2024',    title: 'Claim Settlement Turnaround Time',                   description: 'Acknowledge claim within 24h; settle within 30 days of last document received.',                     requirement_kind: 'reporting',     severity: 'mandatory', effective_from: '2024-04-01', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
  { rule_id: 'cr-rma-bt-cap',   country_code: 'BT', regulator: 'RMA',   domain: 'banking',   rule_code: 'RMA-CAP-2022',      title: 'Capital Adequacy Framework',                         description: 'Minimum CRAR 12.5% for Bhutan-registered banks.',                                                    requirement_kind: 'capital',       severity: 'mandatory', effective_from: '2022-01-01', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
  { rule_id: 'cr-rbi-data-res', country_code: 'IN', regulator: 'RBI',   domain: 'both',      rule_code: 'RBI-DATA-RES-2018', title: 'Data Localisation for Payment Systems',              description: 'Payment-system data must reside in India.',                                                          requirement_kind: 'data_residency', severity: 'mandatory', effective_from: '2018-10-15', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
];

export function __resetMswGovernance(): void {
  __mswBranches.length = 0;
  __mswBranches.push(
    { branch_id: 'br-hdfc-mumbai-fort',   tenant_id: 'HDFC_BANK',     country_code: 'IN', code: 'HDFC001', name: 'HDFC Bank Fort Branch',     city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
    { branch_id: 'br-hdfc-delhi-cp',      tenant_id: 'HDFC_BANK',     country_code: 'IN', code: 'HDFC002', name: 'HDFC Bank Connaught Place', city: 'Delhi',    state: 'Delhi',       address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
    { branch_id: 'br-icici-mumbai-bkc',   tenant_id: 'ICICI_BANK',    country_code: 'IN', code: 'ICIC001', name: 'ICICI Bank BKC',            city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
    { branch_id: 'br-sbi-mumbai-main',    tenant_id: 'SBI',           country_code: 'IN', code: 'SBI001',  name: 'State Bank of India Main',  city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
    { branch_id: 'br-hdfcergo-mumbai-hq', tenant_id: 'HDFC_ERGO',     country_code: 'IN', code: 'HERGO01', name: 'HDFC ERGO Mumbai HQ',       city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
    { branch_id: 'br-icicilom-mumbai-hq', tenant_id: 'ICICI_LOMBARD', country_code: 'IN', code: 'ILOM001', name: 'ICICI Lombard Mumbai HQ',   city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
    { branch_id: 'br-bank-demo-main',     tenant_id: 'BANK_DEMO',     country_code: 'IN', code: 'DEMO001', name: 'APEX Demo Bank — Main',     city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
    { branch_id: 'br-bil-thimphu',        tenant_id: 'BIL',           country_code: 'BT', code: 'BIL001',  name: 'BIL Thimphu Head Office',   city: 'Thimphu',  state: 'Thimphu',     address: null, phone: null, email: null, manager_user: null, active: true,  created_at: __mswGovTs, updated_at: __mswGovTs },
  );
  __mswComplianceRules.length = 0;
  __mswComplianceRules.push(
    { rule_id: 'cr-rbi-md-npa',   country_code: 'IN', regulator: 'RBI',   domain: 'banking',   rule_code: 'RBI-MD-NPA-2024',   title: 'IRACP — Income Recognition + Asset Classification', description: 'Loans classified as NPA when DPD ≥ 90; SMA-0/1/2 tiers per DPD bracket. Quarterly reporting to RBI.', requirement_kind: 'reporting',     severity: 'mandatory', effective_from: '2024-04-01', effective_until: null, source_url: 'https://www.rbi.org.in/', active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
    { rule_id: 'cr-rbi-pmla',     country_code: 'IN', regulator: 'RBI',   domain: 'banking',   rule_code: 'RBI-PMLA-2002',     title: 'PMLA — Anti Money Laundering',                       description: 'KYC + Sanctions screening + STR/CTR reporting to FIU-IND.',                                          requirement_kind: 'kyc',           severity: 'mandatory', effective_from: '2002-07-01', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
    { rule_id: 'cr-irdai-cg',     country_code: 'IN', regulator: 'IRDAI', domain: 'insurance', rule_code: 'IRDAI-CG-2016',     title: 'Corporate Governance Guidelines',                    description: 'Board composition + risk committees + investment committee + audit committee.',                       requirement_kind: 'governance',    severity: 'mandatory', effective_from: '2016-05-18', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
    { rule_id: 'cr-irdai-claims', country_code: 'IN', regulator: 'IRDAI', domain: 'insurance', rule_code: 'IRDAI-CLM-2024',    title: 'Claim Settlement Turnaround Time',                   description: 'Acknowledge claim within 24h; settle within 30 days of last document received.',                     requirement_kind: 'reporting',     severity: 'mandatory', effective_from: '2024-04-01', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
    { rule_id: 'cr-rma-bt-cap',   country_code: 'BT', regulator: 'RMA',   domain: 'banking',   rule_code: 'RMA-CAP-2022',      title: 'Capital Adequacy Framework',                         description: 'Minimum CRAR 12.5% for Bhutan-registered banks.',                                                    requirement_kind: 'capital',       severity: 'mandatory', effective_from: '2022-01-01', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
    { rule_id: 'cr-rbi-data-res', country_code: 'IN', regulator: 'RBI',   domain: 'both',      rule_code: 'RBI-DATA-RES-2018', title: 'Data Localisation for Payment Systems',              description: 'Payment-system data must reside in India.',                                                          requirement_kind: 'data_residency', severity: 'mandatory', effective_from: '2018-10-15', effective_until: null, source_url: null, active: true, created_at: __mswGovTs, updated_at: __mswGovTs },
  );
}

export function __resetMswRbacMatrix(): void {
  __mswRbacGrants.length = 0;
  __mswRbacGrants.push(
    ...__mswRbacModules.flatMap((m) =>
      __mswRbacActions.map((a) => ({ role_id: 'super_admin', module_id: m.id, action_id: a.id })),
    ),
    { role_id: 'risk_analyst', module_id: 'dashboard', action_id: 'view' },
    { role_id: 'risk_analyst', module_id: 'borrower_watch', action_id: 'view' },
    { role_id: 'risk_analyst', module_id: 'borrower_watch', action_id: 'edit' },
    { role_id: 'risk_analyst', module_id: 'rules_engine', action_id: 'view' },
    { role_id: 'auditor', module_id: 'dashboard', action_id: 'view' },
    { role_id: 'auditor', module_id: 'audit_trail', action_id: 'view' },
    { role_id: 'auditor', module_id: 'audit_trail', action_id: 'export' },
    { role_id: 'read_only_user', module_id: 'dashboard', action_id: 'view' },
    { role_id: 'read_only_user', module_id: 'borrower_watch', action_id: 'view' },
  );
}

function mswMasterSeedRow(entity: string, idx: number, fields: Record<string, unknown>): MswMasterRow {
  // Platform-static entities (rows shared across every tenant) write
  // their seed under PLATFORM; tenant-scoped entities land in
  // BANK_DEMO so the dev demo always renders. Inline set keeps the
  // module-init order working without hoisting traps.
  const PLATFORM_STATIC = new Set(['countries', 'currencies', 'regulatory-frameworks']);
  const now = new Date().toISOString();
  return {
    id: `mst-${entity}-seed-${idx}`,
    tenant_id: PLATFORM_STATIC.has(entity) ? 'PLATFORM' : 'BANK_DEMO',
    fields,
    created_at: now,
    created_by: 'system:seed',
    updated_at: now,
    updated_by: 'system:seed',
  };
}

function findMswEntity(slug: string): MswMasterEntity | undefined {
  return __mswMasterEntities.find((e) => e.entity === slug);
}

handlers.push(
  http.get('/v1/admin/masters', () => {
    return HttpResponse.json(
      envelope({
        entities: __mswMasterEntities.map((e) => ({
          entity: e.entity,
          label: e.label,
          label_plural: e.label_plural,
          tenant_scoped: e.tenant_scoped,
          field_count: e.fields.length,
        })),
        total: __mswMasterEntities.length,
      }),
    );
  }),
  http.get('/v1/admin/masters/:entity', ({ params }) => {
    const entity = findMswEntity(String(params.entity));
    if (!entity) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_entity', `unknown master entity ${params.entity}`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(
      envelope({
        entity: entity.entity,
        label: entity.label,
        label_plural: entity.label_plural,
        tenant_scoped: entity.tenant_scoped,
        fields: entity.fields,
        rows: entity.rows,
        total: entity.rows.length,
      }),
    );
  }),
  http.get('/v1/admin/masters/:entity/:id', ({ params }) => {
    const entity = findMswEntity(String(params.entity));
    if (!entity) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_entity', `unknown master entity ${params.entity}`, 'LOW'),
        { status: 404 },
      );
    }
    const row = entity.rows.find((r) => r.id === params.id);
    if (!row) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_row', `unknown ${entity.entity} id ${params.id}`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(row));
  }),
  http.post('/v1/admin/masters/:entity', async ({ params, request }) => {
    const entity = findMswEntity(String(params.entity));
    if (!entity) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_entity', `unknown master entity ${params.entity}`, 'LOW'),
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    for (const f of entity.fields) {
      if (f.required && (body[f.name] === undefined || body[f.name] === '' || body[f.name] === null)) {
        return HttpResponse.json(
          envelopeError('EWS_400_missing_required', `field ${f.name} is required`, 'MEDIUM'),
          { status: 400 },
        );
      }
    }
    const now = new Date().toISOString();
    const id = `mst-${entity.entity}-${Math.random().toString(36).slice(2, 10)}`;
    const row: MswMasterRow = {
      id,
      tenant_id: entity.tenant_scoped ? 'BANK_DEMO' : 'PLATFORM',
      fields: body,
      created_at: now,
      created_by: 'admin',
      updated_at: now,
      updated_by: 'admin',
    };
    entity.rows.unshift(row);
    return HttpResponse.json(envelope(row), { status: 201 });
  }),
  http.patch('/v1/admin/masters/:entity/:id', async ({ params, request }) => {
    const entity = findMswEntity(String(params.entity));
    if (!entity) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_entity', `unknown master entity ${params.entity}`, 'LOW'),
        { status: 404 },
      );
    }
    const idx = entity.rows.findIndex((r) => r.id === params.id);
    if (idx === -1) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_row', `unknown ${entity.entity} id ${params.id}`, 'LOW'),
        { status: 404 },
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const row = entity.rows[idx]!;
    const updated: MswMasterRow = {
      ...row,
      fields: { ...row.fields, ...body },
      updated_at: new Date().toISOString(),
      updated_by: 'admin',
    };
    entity.rows[idx] = updated;
    return HttpResponse.json(envelope(updated));
  }),
  http.delete('/v1/admin/masters/:entity/:id', ({ params }) => {
    const entity = findMswEntity(String(params.entity));
    if (!entity) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_entity', `unknown master entity ${params.entity}`, 'LOW'),
        { status: 404 },
      );
    }
    const idx = entity.rows.findIndex((r) => r.id === params.id);
    if (idx === -1) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_row', `unknown ${entity.entity} id ${params.id}`, 'LOW'),
        { status: 404 },
      );
    }
    entity.rows.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // ──────────────────────────────────────────────────────────────────
  // Enterprise Permission Matrix (049 overlay) — MSW dev-mode mocks.
  // Mirrors the BFF routes at /v1/rbac/* with a smaller in-memory grid.
  // ──────────────────────────────────────────────────────────────────
  http.get('/v1/rbac/actions', () =>
    HttpResponse.json(
      envelope({
        total: __mswRbacActions.length,
        actions: __mswRbacActions,
      }),
    ),
  ),

  http.get('/v1/rbac/modules', () =>
    HttpResponse.json(
      envelope({
        total: __mswRbacModules.length,
        modules: __mswRbacModules,
      }),
    ),
  ),

  http.get('/v1/rbac/roles', () =>
    HttpResponse.json(
      envelope({
        total: __mswRbacRoles.length,
        roles: __mswRbacRoles,
      }),
    ),
  ),

  http.get('/v1/rbac/matrix', () => {
    const matrix: Record<string, Record<string, Record<string, boolean>>> = {};
    for (const e of __mswRbacGrants) {
      matrix[e.role_id] ??= {};
      matrix[e.role_id][e.module_id] ??= {};
      matrix[e.role_id][e.module_id][e.action_id] = true;
    }
    return HttpResponse.json(
      envelope({
        generated_at: new Date().toISOString(),
        total_roles: __mswRbacRoles.length,
        total_modules: __mswRbacModules.length,
        total_actions: __mswRbacActions.length,
        matrix,
      }),
    );
  }),

  http.get('/v1/rbac/matrix/:role', ({ params }) => {
    const role = params.role as string;
    if (!__mswRbacRoles.includes(role)) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_role', `unknown role ${role}`, 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope({ role_id: role, permissions: __mswRbacGridFor(role) }));
  }),

  http.put('/v1/rbac/matrix/:role', async ({ params, request }) => {
    const role = params.role as string;
    if (!__mswRbacRoles.includes(role)) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_role', `unknown role ${role}`, 'LOW'),
        { status: 404 },
      );
    }
    const body = (await request.json()) as { grants?: Record<string, Record<string, boolean>> };
    if (!body || typeof body.grants !== 'object' || body.grants === null) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_grants', 'grants object required', 'MEDIUM'),
        { status: 400 },
      );
    }
    let touched = 0;
    for (const [module_id, actions] of Object.entries(body.grants)) {
      for (const [action_id, granted] of Object.entries(actions ?? {})) {
        // Remove existing entry then re-add when granted=true.
        const idx = __mswRbacGrants.findIndex(
          (e) => e.role_id === role && e.module_id === module_id && e.action_id === action_id,
        );
        if (idx !== -1) __mswRbacGrants.splice(idx, 1);
        if (granted === true) {
          __mswRbacGrants.push({ role_id: role, module_id, action_id });
        }
        touched++;
      }
    }
    return HttpResponse.json(
      envelope({ role, cells_touched: touched, grid: { role_id: role, permissions: __mswRbacGridFor(role) } }),
    );
  }),

  http.get('/v1/rbac/me/permissions', ({ request }) => {
    const role = request.headers.get('x-apex-role') ?? '';
    return HttpResponse.json(envelope({ role_id: role, permissions: __mswRbacGridFor(role) }));
  }),

  http.post('/v1/rbac/check', async ({ request }) => {
    const body = (await request.json()) as { role?: string; module?: string; action?: string };
    const role = body?.role ?? request.headers.get('x-apex-role') ?? '';
    const module_id = body?.module ?? '';
    const action = body?.action ?? '';
    if (!role || !module_id || !action) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'role + module + action required', 'MEDIUM'),
        { status: 400 },
      );
    }
    const granted = __mswRbacGrants.some(
      (e) => e.role_id === role && e.module_id === module_id && e.action_id === action,
    );
    return HttpResponse.json(envelope({ role, module: module_id, action, granted }));
  }),

  // ──────────────────────────────────────────────────────────────────
  // Domain Based Access Control (DBAC, 050 overlay) — MSW.
  // Resolves the caller's effective domain off the request headers.
  // Mirrors services/bff/src/dbac/domain_resolver.ts precedence:
  //   super_admin/admin → 'both' → user pin → tenant vertical → null.
  // ──────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────
  // Tenant Governance (051 overlay) — branches + compliance rules.
  // ──────────────────────────────────────────────────────────────────
  http.get('/v1/governance/me', ({ request }) => {
    const role = request.headers.get('x-apex-role') ?? '';
    const tenant_id = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const branch_id = request.headers.get('x-apex-user-branch') ?? null;
    const map: Record<string, { name: string; vertical: 'banking' | 'insurance'; country: string; parent: string | null }> = {
      BANK_DEMO:     { name: 'APEX Bank (demo)',             vertical: 'banking',   country: 'IN', parent: null },
      BIL:           { name: 'Bhutan Insurance Limited',     vertical: 'insurance', country: 'BT', parent: null },
      HDFC_BANK:     { name: 'HDFC Bank Limited',            vertical: 'banking',   country: 'IN', parent: 'HDFC Group' },
      ICICI_BANK:    { name: 'ICICI Bank Limited',           vertical: 'banking',   country: 'IN', parent: 'ICICI Group' },
      SBI:           { name: 'State Bank of India',          vertical: 'banking',   country: 'IN', parent: 'SBI Group' },
      HDFC_ERGO:     { name: 'HDFC ERGO General Insurance',  vertical: 'insurance', country: 'IN', parent: 'HDFC Group' },
      ICICI_LOMBARD: { name: 'ICICI Lombard General Insurance', vertical: 'insurance', country: 'IN', parent: 'ICICI Group' },
    };
    const t = map[tenant_id] ?? { name: tenant_id, vertical: 'banking', country: 'IN', parent: null };
    return HttpResponse.json(
      envelope({
        country_code: t.country,
        tenant_id,
        tenant_name: t.name,
        tenant_vertical: t.vertical,
        parent_organization: t.parent,
        branch_id,
        role,
      }),
    );
  }),

  http.get('/v1/governance/branches', ({ request }) => {
    const url = new URL(request.url);
    let rows = __mswBranches.slice();
    const tenant_id = url.searchParams.get('tenant_id');
    const country_code = url.searchParams.get('country_code');
    const active_only = url.searchParams.get('active_only') === 'true';
    if (tenant_id) rows = rows.filter((r) => r.tenant_id === tenant_id);
    if (country_code) rows = rows.filter((r) => r.country_code === country_code);
    if (active_only) rows = rows.filter((r) => r.active);
    rows.sort((a, b) =>
      a.tenant_id !== b.tenant_id
        ? a.tenant_id.localeCompare(b.tenant_id)
        : a.code.localeCompare(b.code),
    );
    return HttpResponse.json(envelope({ total: rows.length, branches: rows }));
  }),

  http.get('/v1/governance/branches/:branch_id', ({ params }) => {
    const r = __mswBranches.find((b) => b.branch_id === params.branch_id);
    if (!r) {
      return HttpResponse.json(
        envelopeError('EWS_404_unknown_branch', 'branch not found', 'LOW'),
        { status: 404 },
      );
    }
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/governance/branches', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || !body.tenant_id || !body.country_code || !body.code || !body.name) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'missing fields', 'MEDIUM'), { status: 400 });
    }
    if (__mswBranches.find((b) => b.tenant_id === body.tenant_id && b.code === body.code)) {
      return HttpResponse.json(
        envelopeError('EWS_409_duplicate_branch_code', 'duplicate branch code for tenant', 'MEDIUM'),
        { status: 409 },
      );
    }
    const now = new Date().toISOString();
    const branch = {
      branch_id: `br-msw-${Date.now()}`,
      tenant_id: String(body.tenant_id),
      country_code: String(body.country_code),
      code: String(body.code),
      name: String(body.name),
      city: (body.city as string | null) ?? null,
      state: (body.state as string | null) ?? null,
      address: (body.address as string | null) ?? null,
      phone: (body.phone as string | null) ?? null,
      email: (body.email as string | null) ?? null,
      manager_user: (body.manager_user as string | null) ?? null,
      active: body.active === false ? false : true,
      created_at: now,
      updated_at: now,
    };
    __mswBranches.push(branch);
    return HttpResponse.json(envelope(branch, 'EWS_201', 'Created'), { status: 201 });
  }),

  http.patch('/v1/governance/branches/:branch_id', async ({ params, request }) => {
    const idx = __mswBranches.findIndex((b) => b.branch_id === params.branch_id);
    if (idx === -1) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_branch', 'branch not found', 'LOW'), { status: 404 });
    }
    const patch = (await request.json()) as Record<string, unknown>;
    const merged = { ...__mswBranches[idx] };
    for (const k of ['code', 'name', 'city', 'state', 'address', 'phone', 'email', 'manager_user', 'active'] as const) {
      if (patch[k] !== undefined) (merged as Record<string, unknown>)[k] = patch[k];
    }
    merged.updated_at = new Date().toISOString();
    __mswBranches[idx] = merged;
    return HttpResponse.json(envelope(merged));
  }),

  http.delete('/v1/governance/branches/:branch_id', ({ params }) => {
    const idx = __mswBranches.findIndex((b) => b.branch_id === params.branch_id);
    if (idx === -1) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_branch', 'branch not found', 'LOW'), { status: 404 });
    }
    __mswBranches.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/v1/governance/compliance-rules', ({ request }) => {
    const url = new URL(request.url);
    let rows = __mswComplianceRules.slice();
    const country_code = url.searchParams.get('country_code');
    const regulator = url.searchParams.get('regulator');
    const domain = url.searchParams.get('domain');
    const active_only = url.searchParams.get('active_only') === 'true';
    if (domain && !['banking', 'insurance', 'both'].includes(domain)) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_domain', `unknown domain ${domain}`, 'MEDIUM'), { status: 400 });
    }
    if (country_code) rows = rows.filter((r) => r.country_code === country_code);
    if (regulator) rows = rows.filter((r) => r.regulator === regulator);
    if (domain) rows = rows.filter((r) => r.domain === domain);
    if (active_only) rows = rows.filter((r) => r.active);
    return HttpResponse.json(envelope({ total: rows.length, rules: rows }));
  }),

  http.get('/v1/governance/compliance-rules/:rule_id', ({ params }) => {
    const r = __mswComplianceRules.find((x) => x.rule_id === params.rule_id);
    if (!r) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_compliance_rule', 'rule not found', 'LOW'), { status: 404 });
    }
    return HttpResponse.json(envelope(r));
  }),

  http.post('/v1/governance/compliance-rules', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || !body.country_code || !body.regulator || !body.rule_code || !body.title || !body.description || !body.domain || !body.requirement_kind) {
      return HttpResponse.json(envelopeError('EWS_400_invalid_input', 'missing fields', 'MEDIUM'), { status: 400 });
    }
    if (__mswComplianceRules.find((r) => r.country_code === body.country_code && r.regulator === body.regulator && r.rule_code === body.rule_code)) {
      return HttpResponse.json(envelopeError('EWS_409_duplicate_compliance_rule', 'duplicate (country, regulator, rule_code)', 'MEDIUM'), { status: 409 });
    }
    const now = new Date().toISOString();
    const rule = {
      rule_id: `cr-msw-${Date.now()}`,
      country_code: String(body.country_code),
      regulator: String(body.regulator),
      domain: body.domain as 'banking' | 'insurance' | 'both',
      rule_code: String(body.rule_code),
      title: String(body.title),
      description: String(body.description),
      requirement_kind: body.requirement_kind as 'reporting' | 'capital' | 'kyc' | 'sanctions' | 'governance' | 'data_residency' | 'audit',
      severity: (body.severity as 'mandatory' | 'recommended' | 'advisory') ?? 'mandatory',
      effective_from: (body.effective_from as string | null) ?? null,
      effective_until: (body.effective_until as string | null) ?? null,
      source_url: (body.source_url as string | null) ?? null,
      active: body.active === false ? false : true,
      created_at: now,
      updated_at: now,
    };
    __mswComplianceRules.push(rule);
    return HttpResponse.json(envelope(rule, 'EWS_201', 'Created'), { status: 201 });
  }),

  http.patch('/v1/governance/compliance-rules/:rule_id', async ({ params, request }) => {
    const idx = __mswComplianceRules.findIndex((r) => r.rule_id === params.rule_id);
    if (idx === -1) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_compliance_rule', 'rule not found', 'LOW'), { status: 404 });
    }
    const patch = (await request.json()) as Record<string, unknown>;
    const merged = { ...__mswComplianceRules[idx] };
    for (const k of ['title', 'description', 'requirement_kind', 'severity', 'effective_from', 'effective_until', 'source_url', 'active'] as const) {
      if (patch[k] !== undefined) (merged as Record<string, unknown>)[k] = patch[k];
    }
    merged.updated_at = new Date().toISOString();
    __mswComplianceRules[idx] = merged;
    return HttpResponse.json(envelope(merged));
  }),

  http.delete('/v1/governance/compliance-rules/:rule_id', ({ params }) => {
    const idx = __mswComplianceRules.findIndex((r) => r.rule_id === params.rule_id);
    if (idx === -1) {
      return HttpResponse.json(envelopeError('EWS_404_unknown_compliance_rule', 'rule not found', 'LOW'), { status: 404 });
    }
    __mswComplianceRules.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/v1/dbac/me', ({ request }) => {
    const role = request.headers.get('x-apex-role') ?? '';
    const userPinRaw = request.headers.get('x-apex-user-domain')?.trim() ?? '';
    const userPin: 'banking' | 'insurance' | null =
      userPinRaw === 'banking' || userPinRaw === 'insurance' ? userPinRaw : null;
    const tenantId = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    // Mirror the seed tenant verticals: BANK_DEMO → banking; BIL → insurance.
    const tenantVertical: 'banking' | 'insurance' | null =
      tenantId === 'BIL' ? 'insurance' : tenantId === 'BANK_DEMO' ? 'banking' : null;
    let effective: 'banking' | 'insurance' | 'both' | null;
    if (role === 'admin' || role === 'super_admin') effective = 'both';
    else if (userPin) effective = userPin;
    else effective = tenantVertical;
    return HttpResponse.json(
      envelope({
        effective_domain: effective,
        inputs: { user_domain: userPin, tenant_vertical: tenantVertical, role },
      }),
    );
  }),

  // ── CMS Cases /v1/cms/* ──────────────────────────────────────────────────
  // Explicit mock coverage for the 3 CMS read endpoints.
  // Provides consistent dev-mode behaviour even when BFF is not running
  // (onUnhandledRequest:'bypass' normally passes these through, but explicit
  // handlers give faster feedback + predictable test baselines).

  http.get('/v1/cms/cases', ({ request }) => {
    const url = new URL(request.url);
    const tenant = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const statusFilter = url.searchParams.get('status');
    const priorityFilter = url.searchParams.get('priority');
    const qFilter = url.searchParams.get('q') ?? '';
    const assignedToFilter = url.searchParams.get('assigned_to');
    const breachedFilter = url.searchParams.get('breached');

    // Validate status enum if provided
    const VALID_STATES = ['OPEN','ASSIGNED','INVESTIGATING','PENDING_APPROVAL','ESCALATED','CLOSED','REOPENED'];
    if (statusFilter && !VALID_STATES.includes(statusFilter)) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'invalid status', 'MEDIUM'),
        { status: 400 },
      );
    }
    const VALID_PRIORITIES = ['P1','P2','P3','P4'];
    if (priorityFilter && !VALID_PRIORITIES.includes(priorityFilter)) {
      return HttpResponse.json(
        envelopeError('EWS_400_invalid_input', 'invalid priority', 'MEDIUM'),
        { status: 400 },
      );
    }

    // Seed cases matching services/bff/src/cms_store.ts seedDemoCmsCases()
    const BASE_MS = 1748736000000; // 2025-06-01T00:00:00Z — stable anchor
    const seedCases = [
      {
        case_id: 'mock-cms-001', case_number: 'EWS-2026-00001', tenant_id: tenant,
        title: 'Multi-bureau delinquency on Olivia Cherop',
        description: 'Cross-product cascade detected; collections must verify employment.',
        alert_id: 'a-1009', status: 'ESCALATED', priority: 'P1',
        assigned_to: 'carl.collect', created_by: 'alice.admin',
        created_at: new Date(BASE_MS - 3 * 86400000).toISOString(),
        updated_at: new Date(BASE_MS - 86400000).toISOString(),
        sla_due_at: new Date(BASE_MS - 86400000).toISOString(),
        resolved_at: null, resolution_category: null, resolution_notes: '',
        tags: ['critical', 'collections', 'site-visit'], is_locked: false, case_category: null,
      },
      {
        case_id: 'mock-cms-002', case_number: 'EWS-2026-00002', tenant_id: tenant,
        title: 'DPD≥30 + 95% utilisation — Achieng Otieno',
        description: 'Card maxed out and 30 days behind.',
        alert_id: 'a-1001', status: 'INVESTIGATING', priority: 'P1',
        assigned_to: 'sue.super', created_by: 'alice.admin',
        created_at: new Date(BASE_MS - 5 * 86400000).toISOString(),
        updated_at: new Date(BASE_MS - 2 * 86400000).toISOString(),
        sla_due_at: new Date(BASE_MS - 2 * 86400000).toISOString(),
        resolved_at: null, resolution_category: null, resolution_notes: '',
        tags: ['restructure', 'maker-checker'], is_locked: false, case_category: null,
      },
      {
        case_id: 'mock-cms-003', case_number: 'EWS-2026-00003', tenant_id: tenant,
        title: 'Direct-debit bounce x3 — Ruth Akinyi',
        description: 'Standing instruction failures across 30d window.',
        alert_id: 'a-1010', status: 'OPEN', priority: 'P2',
        assigned_to: null, created_by: 'alice.admin',
        created_at: new Date(BASE_MS - 2 * 86400000).toISOString(),
        updated_at: new Date(BASE_MS - 86400000).toISOString(),
        sla_due_at: new Date(BASE_MS + 22 * 3600000).toISOString(),
        resolved_at: null, resolution_category: null, resolution_notes: '',
        tags: ['payments', 'fraud-watch'], is_locked: false, case_category: null,
      },
      {
        case_id: 'mock-cms-004', case_number: 'EWS-2026-00004', tenant_id: tenant,
        title: 'Cheque return 2x in 30d — Catherine Wanjiru',
        description: 'Cheque return pattern flagged; verify with branch.',
        alert_id: 'a-1003', status: 'ASSIGNED', priority: 'P3',
        assigned_to: 'ravi.risk', created_by: 'alice.admin',
        created_at: new Date(BASE_MS - 7 * 86400000).toISOString(),
        updated_at: new Date(BASE_MS - 3 * 86400000).toISOString(),
        sla_due_at: new Date(BASE_MS + 65 * 3600000).toISOString(),
        resolved_at: null, resolution_category: null, resolution_notes: '',
        tags: ['msme'], is_locked: false, case_category: null,
      },
      {
        case_id: 'mock-cms-005', case_number: 'EWS-2026-00005', tenant_id: tenant,
        title: 'Bureau enquiry surge — Daniel Mwangi',
        description: '4 bureau enquiries in 14 days.',
        alert_id: 'a-1004', status: 'OPEN', priority: 'P4',
        assigned_to: 'ravi.risk', created_by: 'alice.admin',
        created_at: new Date(BASE_MS - 4 * 86400000).toISOString(),
        updated_at: new Date(BASE_MS - 86400000).toISOString(),
        sla_due_at: new Date(BASE_MS + 4 * 86400000).toISOString(),
        resolved_at: null, resolution_category: null, resolution_notes: '',
        tags: ['credit-shopping'], is_locked: false, case_category: null,
      },
      {
        case_id: 'mock-cms-006', case_number: 'EWS-2026-00006', tenant_id: tenant,
        title: 'Salary inflow stopped — Faisal Hussein',
        description: '60-day salary inflow gap; possible employment loss.',
        alert_id: 'a-1006', status: 'OPEN', priority: 'P2',
        assigned_to: 'fiona.field', created_by: 'alice.admin',
        created_at: new Date(BASE_MS - 4 * 86400000).toISOString(),
        updated_at: new Date(BASE_MS - 86400000).toISOString(),
        sla_due_at: new Date(BASE_MS + 20 * 3600000).toISOString(),
        resolved_at: null, resolution_category: null, resolution_notes: '',
        tags: ['employment-shock'], is_locked: false, case_category: null,
      },
    ].filter(c => c.tenant_id === tenant);

    let items = seedCases;
    if (statusFilter) items = items.filter(c => c.status === statusFilter);
    if (priorityFilter) items = items.filter(c => c.priority === priorityFilter);
    if (qFilter) items = items.filter(c => c.title.toLowerCase().includes(qFilter.toLowerCase()));
    if (assignedToFilter) items = items.filter(c => c.assigned_to === assignedToFilter);
    if (breachedFilter === 'true') {
      // Stable anchor: cases with sla_due_at before BASE_MS are always "breached"
      items = items.filter(c => c.status !== 'CLOSED' && new Date(c.sla_due_at).getTime() < BASE_MS);
    }

    return HttpResponse.json(envelope({ items, total: items.length }));
  }),

  http.get('/v1/cms/cases/stats', ({ request }) => {
    const tenant = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    // Return stats that match the seed data above regardless of tenant
    // (empty tenants get all-zero stats, BANK_DEMO/BIL get seeded numbers)
    const isKnownTenant = tenant === 'BANK_DEMO' || tenant === 'BIL';
    if (!isKnownTenant) {
      return HttpResponse.json(envelope({
        total: 0,
        by_status: { OPEN:0, ASSIGNED:0, INVESTIGATING:0, PENDING_APPROVAL:0, ESCALATED:0, CLOSED:0, REOPENED:0 },
        by_priority: { P1:0, P2:0, P3:0, P4:0 },
        sla_breached_count: 0,
        sla_warning_count: 0,
        avg_resolution_hours: null,
      }));
    }
    return HttpResponse.json(envelope({
      total: 6,
      by_status: { OPEN:3, ASSIGNED:1, INVESTIGATING:1, PENDING_APPROVAL:0, ESCALATED:1, CLOSED:0, REOPENED:0 },
      by_priority: { P1:2, P2:2, P3:1, P4:1 },
      sla_breached_count: 2,
      sla_warning_count: 1,
      avg_resolution_hours: null,
    }));
  }),

  http.get('/v1/cms/cases/sla-breaches', ({ request }) => {
    const tenant = (request.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    const isKnownTenant = tenant === 'BANK_DEMO' || tenant === 'BIL';
    if (!isKnownTenant) {
      return HttpResponse.json(envelope({ items: [], total: 0 }));
    }
    // Stable anchor: cases 001 and 002 have sla_due_at before BASE_MS → always breached
    const BASE_MS = 1748736000000;
    const breaches = [
      {
        case_id: 'mock-cms-002', case_number: 'EWS-2026-00002',
        title: 'DPD≥30 + 95% utilisation — Achieng Otieno',
        priority: 'P1', assigned_to: 'sue.super', status: 'INVESTIGATING',
        sla_due_at: new Date(BASE_MS - 2 * 86400000).toISOString(),
        overshoot_hours: 48.2, progress_pct: 148,
      },
      {
        case_id: 'mock-cms-001', case_number: 'EWS-2026-00001',
        title: 'Multi-bureau delinquency on Olivia Cherop',
        priority: 'P1', assigned_to: 'carl.collect', status: 'ESCALATED',
        sla_due_at: new Date(BASE_MS - 86400000).toISOString(),
        overshoot_hours: 24.5, progress_pct: 124,
      },
    ];
    return HttpResponse.json(envelope({ items: breaches, total: breaches.length }));
  }),

  // ── Notification stream / publish /v1/notifications/* ───────────────────
  // NOTE: GET /v1/notifications/stream uses the browser's native EventSource
  // API which MSW's service worker cannot intercept (EventSource is not
  // fetch). In the test environment, EventSource is replaced by MockEventSource
  // (see web/src/__tests__/setup.ts) so no MSW handler is needed for the
  // stream itself.
  //
  // POST /v1/notifications/publish IS a regular fetch — handled here so the
  // bell's "Send test notification" button works in MSW dev mode and tests
  // that call publishTest() don't throw an "unhandled request" error.
  http.post('/v1/notifications/publish', async ({ request }) => {
    const body = await request.json() as {
      level?: string;
      title?: string;
      body?: string;
      href?: string;
      type?: string;
    };
    const VALID_LEVELS = ['info', 'success', 'warning', 'danger'];
    if (!body?.title || !VALID_LEVELS.includes(body?.level ?? '')) {
      return HttpResponse.json(
        { header: { status: 'FAILURE' }, error: { code: 'EWS_400', message: 'title and valid level are required', severity: 'MEDIUM' } },
        { status: 400 },
      );
    }
    const notification = {
      id: `mock-notif-${Date.now()}`,
      ts: new Date().toISOString(),
      level: body.level,
      title: body.title,
      body: body.body,
      href: body.href,
      type: body.type ?? 'system',
    };
    return HttpResponse.json(
      envelope({ ok: true, notification, subscribers: 0 }),
      { status: 201 },
    );
  }),

  // ── Report Schedules /v1/reports/schedules/* ─────────────────────────────
  //
  // ROOT CAUSE: GET /v1/reports/schedules/upcoming → HTTP 500
  //             POST /v1/reports/schedules          → HTTP 400
  //
  // No MSW handlers existed for ANY schedule endpoint. The SPA's SchedulerPanel
  // (ReportsPage.tsx) and schedulerApi.ts call three endpoints:
  //   listSchedules  → GET  /v1/reports/schedules           ← missing
  //   upcoming       → GET  /v1/reports/schedules/upcoming  ← missing (HTTP 500)
  //   tick           → POST /v1/reports/schedules/tick      ← missing
  //
  // Additionally POST /v1/reports/schedules (schedule creation) and the CRUD
  // endpoints were all missing. The bypass→BFF-not-running path caused
  // connection errors that React Query surfaces as "HTTP 500/400" in the UI.
  //
  // All schedule endpoints are now stubbed. The in-memory __mswScheduleStore
  // maintains state across calls within the same MSW session (page reload clears
  // it). Stable anchor: 2026-06-04T06:00:00.000Z matches the BFF seed time.

  ...(() => {
    const __SCHED_BASE_MS = 1749017600000; // 2026-06-04T06:00:00.000Z
    const __SCHED_VALID_CADENCES = ['daily', 'weekly', 'monthly', 'quarterly', 'last_day_of_month'] as const;
    const __SCHED_VALID_FORMATS = ['json', 'csv', 'pdf', 'xlsx'];
    const __SCHED_VALID_REPORTS = [
      'portfolio_snapshot_daily', 'alerts_activity_weekly', 'case_outcomes_monthly',
      'sla_breach_digest', 'rbi_quarterly_summary', 'irdai_claims_quarterly',
      'irdai_solvency_monthly', 'audit_compliance_dump', 'agent_productivity_monthly',
    ];

    // Per-tenant in-memory store so create/list/delete stay consistent
    const __mswScheduleStore = new Map<string, Record<string, unknown>[]>();

    function __schedTenant(req: Request): string {
      return (req.headers.get('x-tenant-id') ?? 'BANK_DEMO').toUpperCase();
    }
    function __schedItems(tenant: string): Record<string, unknown>[] {
      if (!__mswScheduleStore.has(tenant)) __mswScheduleStore.set(tenant, []);
      return __mswScheduleStore.get(tenant)!;
    }
    function __schedEnvelope(body: unknown, status = 200) {
      return HttpResponse.json(
        { header: { status: 'success', code: status === 201 ? 'EWS_201' : 'EWS_200', message: 'ok',
            requestId: `req-msw-sched-${Date.now()}`, timestamp: new Date().toISOString() }, body },
        { status },
      );
    }
    function __nextRunAt(cadence: string, hourUtc: number, from: Date): string {
      const d = new Date(from);
      // Advance to next firing time (simplified for MSW mock)
      switch (cadence) {
        case 'daily': d.setUTCHours(hourUtc, 0, 0, 0); if (d <= from) d.setUTCDate(d.getUTCDate() + 1); break;
        case 'weekly': d.setUTCDate(d.getUTCDate() + 7); d.setUTCHours(hourUtc, 0, 0, 0); break;
        case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(hourUtc, 0, 0, 0); break;
        case 'quarterly': d.setUTCMonth(d.getUTCMonth() + 3, 1); d.setUTCHours(hourUtc, 0, 0, 0); break;
        default: d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(hourUtc, 0, 0, 0);
      }
      return d.toISOString();
    }

    return [
      // GET /v1/reports/schedules — list all schedules for this tenant
      http.get('/v1/reports/schedules', ({ request }) => {
        const tenant = __schedTenant(request);
        const url = new URL(request.url);
        const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
        const page_size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') ?? '20', 10)));
        const items = __schedItems(tenant);
        const start = (page - 1) * page_size;
        return __schedEnvelope({ items: items.slice(start, start + page_size), page, page_size, total: items.length });
      }),

      // POST /v1/reports/schedules — create a schedule
      http.post('/v1/reports/schedules', async ({ request }) => {
        const tenant = __schedTenant(request);
        const raw = await request.json() as Record<string, unknown>;
        // Unwrap envelope body if present
        const body: Record<string, unknown> = (raw && typeof raw === 'object' && 'body' in raw)
          ? raw.body as Record<string, unknown> : raw ?? {};

        // Validate required fields — matching BFF validateInput() error codes
        if (!body.report_id || typeof body.report_id !== 'string')
          return __schedEnvelope({ code: 'EWS_400_invalid_report_id', message: 'report_id is required', severity: 'MEDIUM' }, 400);
        if (!__SCHED_VALID_REPORTS.includes(String(body.report_id)))
          return __schedEnvelope({ code: 'EWS_400_invalid_report_id', message: `Unknown report_id: ${body.report_id}`, severity: 'MEDIUM' }, 400);
        if (!body.format || !__SCHED_VALID_FORMATS.includes(String(body.format)))
          return __schedEnvelope({ code: 'EWS_400_invalid_format', message: 'format must be json/csv/pdf/xlsx', severity: 'MEDIUM' }, 400);
        if (!body.name || typeof body.name !== 'string' || !(body.name as string).trim())
          return __schedEnvelope({ code: 'EWS_400_invalid_input', message: 'name is required', severity: 'MEDIUM' }, 400);
        if (!body.cadence || !__SCHED_VALID_CADENCES.includes(body.cadence as never))
          return __schedEnvelope({ code: 'EWS_400_invalid_cadence', message: `cadence must be one of ${__SCHED_VALID_CADENCES.join(',')}`, severity: 'MEDIUM' }, 400);
        const hourUtc = Number(body.hour_utc ?? 0);
        if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23)
          return __schedEnvelope({ code: 'EWS_400_invalid_input', message: 'hour_utc must be 0-23', severity: 'MEDIUM' }, 400);
        const recipients = body.recipients as string[] | undefined;
        if (!Array.isArray(recipients) || recipients.length === 0)
          return __schedEnvelope({ code: 'EWS_400_invalid_recipients', message: 'at least one recipient required', severity: 'MEDIUM' }, 400);

        const now = new Date(__SCHED_BASE_MS);
        const entry: Record<string, unknown> = {
          schedule_id: `sched-${tenant}-${Date.now()}`,
          tenant_id: tenant, report_id: body.report_id, format: body.format,
          name: String(body.name).trim(), cadence: body.cadence, hour_utc: hourUtc,
          day_of_week: body.day_of_week ?? null, day_of_month: body.day_of_month ?? null,
          recipients, enabled: body.enabled !== false, parameters: body.parameters ?? {},
          created_by: (request.headers.get('x-apex-user') ?? 'admin'),
          created_at: now.toISOString(), updated_at: now.toISOString(),
          next_run_at: __nextRunAt(String(body.cadence), hourUtc, now),
          last_run_at: null, tz: body.tz ?? 'UTC', retry_state: null,
        };
        const items = __schedItems(tenant);
        if (items.length >= 50)
          return __schedEnvelope({ code: 'EWS_409_cap_reached', message: 'Max 50 schedules per tenant', severity: 'MEDIUM' }, 409);
        items.unshift(entry); // newest-first
        return __schedEnvelope(entry, 201);
      }),

      // GET /v1/reports/schedules/upcoming — next N firing times across fleet
      http.get('/v1/reports/schedules/upcoming', ({ request }) => {
        const tenant = __schedTenant(request);
        const url = new URL(request.url);
        const n = Math.min(100, Math.max(1, parseInt(url.searchParams.get('n') ?? '20', 10)));
        const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : new Date(__SCHED_BASE_MS);
        const items = __schedItems(tenant);
        // Generate upcoming firings from enabled schedules
        const firings: Array<{ schedule_id: string; name: string; report_id: string; format: string; fire_at: string }> = [];
        for (const s of items) {
          if (!s.enabled) continue;
          firings.push({
            schedule_id: String(s.schedule_id), name: String(s.name),
            report_id: String(s.report_id), format: String(s.format),
            fire_at: __nextRunAt(String(s.cadence), Number(s.hour_utc), from),
          });
          if (firings.length >= n * 2) break; // enough candidates
        }
        firings.sort((a, b) => a.fire_at.localeCompare(b.fire_at));
        return __schedEnvelope({
          from: from.toISOString(),
          total_schedules_considered: items.length,
          total_enabled: items.filter(s => s.enabled).length,
          total_returned: Math.min(n, firings.length),
          items: firings.slice(0, n),
        });
      }),

      // POST /v1/reports/schedules/tick — scheduler worker tick
      http.post('/v1/reports/schedules/tick', async ({ request }) => {
        const tenant = __schedTenant(request);
        const body = await request.json() as Record<string, unknown>;
        const dry_run = Boolean(body?.dry_run ?? false);
        const tolerance = Number(body?.tolerance_minutes ?? 5);
        const max_retries = Number(body?.max_retries ?? 3);
        const backoff = Number(body?.backoff_minutes ?? 15);
        const as_of = body?.as_of ? new Date(String(body.as_of)) : new Date(__SCHED_BASE_MS);
        const items = __schedItems(tenant);
        const due = items.filter(s => s.enabled && s.next_run_at);
        // All due in this tick (simplified)
        const fired = dry_run ? [] : due.map(s => ({
          schedule_id: String(s.schedule_id), name: String(s.name),
          report_id: String(s.report_id), job_id: `job-${Date.now()}-${s.schedule_id}`,
          next_run_at: __nextRunAt(String(s.cadence), Number(s.hour_utc), as_of),
        }));
        return __schedEnvelope({
          tenant_id: tenant, generated_at: new Date().toISOString(),
          as_of: as_of.toISOString(), tolerance_minutes: tolerance,
          max_retries, backoff_minutes: backoff, dry_run,
          total_considered: items.length, would_fire: due.length,
          candidates: dry_run ? due.slice(0, 10) : undefined,
          fired, retried_later: [], parked: [], errors: [],
        });
      }),

      // GET /v1/reports/schedules/due — schedules ready to fire
      http.get('/v1/reports/schedules/due', ({ request }) => {
        const tenant = __schedTenant(request);
        const items = __schedItems(tenant);
        const as_of = new Date(__SCHED_BASE_MS);
        return __schedEnvelope({ items: items.filter(s => s.enabled), total: items.filter(s => s.enabled).length, as_of: as_of.toISOString() });
      }),

      // GET /v1/reports/schedules/cadence-stats
      http.get('/v1/reports/schedules/cadence-stats', ({ request }) => {
        const tenant = __schedTenant(request);
        const items = __schedItems(tenant);
        const cadences = __SCHED_VALID_CADENCES.map(c => ({
          cadence: c, total_count: items.filter(s => s.cadence === c).length,
          enabled_count: items.filter(s => s.cadence === c && s.enabled).length,
          disabled_count: items.filter(s => s.cadence === c && !s.enabled).length,
          next_run_within_24h_count: 0, next_run_within_7d_count: 0,
          earliest_next_run_at: null,
        }));
        return __schedEnvelope({
          tenant_id: tenant, generated_at: new Date(__SCHED_BASE_MS).toISOString(),
          total_schedules: items.length, total_enabled: items.filter(s => s.enabled).length,
          total_disabled: items.filter(s => !s.enabled).length,
          cadences, most_common_cadence: null, unused_cadences: __SCHED_VALID_CADENCES.filter(c => items.every(s => s.cadence !== c)),
        });
      }),

      // GET /v1/reports/schedules/:schedule_id — single schedule
      http.get('/v1/reports/schedules/:schedule_id', ({ request, params }) => {
        const tenant = __schedTenant(request);
        const id = String(params.schedule_id);
        const entry = __schedItems(tenant).find(s => s.schedule_id === id);
        if (!entry) return __schedEnvelope({ code: 'EWS_404_unknown_schedule', message: `Schedule ${id} not found`, severity: 'LOW' }, 404);
        return __schedEnvelope(entry);
      }),

      // PATCH /v1/reports/schedules/:schedule_id — update schedule
      http.patch('/v1/reports/schedules/:schedule_id', async ({ request, params }) => {
        const tenant = __schedTenant(request);
        const id = String(params.schedule_id);
        const items = __schedItems(tenant);
        const idx = items.findIndex(s => s.schedule_id === id);
        if (idx === -1) return __schedEnvelope({ code: 'EWS_404_unknown_schedule', message: `Schedule ${id} not found`, severity: 'LOW' }, 404);
        const patch = await request.json() as Record<string, unknown>;
        const inner = (patch && typeof patch === 'object' && 'body' in patch) ? patch.body as Record<string, unknown> : patch ?? {};
        Object.assign(items[idx], inner, { updated_at: new Date().toISOString() });
        if (inner.cadence || inner.hour_utc !== undefined) {
          items[idx].next_run_at = __nextRunAt(String(items[idx].cadence), Number(items[idx].hour_utc), new Date());
        }
        return __schedEnvelope(items[idx]);
      }),

      // DELETE /v1/reports/schedules/:schedule_id — delete schedule
      http.delete('/v1/reports/schedules/:schedule_id', ({ request, params }) => {
        const tenant = __schedTenant(request);
        const id = String(params.schedule_id);
        const items = __schedItems(tenant);
        const idx = items.findIndex(s => s.schedule_id === id);
        if (idx === -1) return __schedEnvelope({ code: 'EWS_404_unknown_schedule', message: `Schedule ${id} not found`, severity: 'LOW' }, 404);
        items.splice(idx, 1);
        return new Response(null, { status: 204 });
      }),

      // POST /v1/reports/schedules/:schedule_id/mark-run — advance schedule
      http.post('/v1/reports/schedules/:schedule_id/mark-run', ({ request, params }) => {
        const tenant = __schedTenant(request);
        const id = String(params.schedule_id);
        const items = __schedItems(tenant);
        const entry = items.find(s => s.schedule_id === id);
        if (!entry) return __schedEnvelope({ code: 'EWS_404_unknown_schedule', message: `Schedule ${id} not found`, severity: 'LOW' }, 404);
        const now = new Date();
        entry.last_run_at = now.toISOString();
        entry.next_run_at = __nextRunAt(String(entry.cadence), Number(entry.hour_utc), now);
        entry.retry_state = null;
        entry.updated_at = now.toISOString();
        return __schedEnvelope(entry);
      }),
    ];
  })(),
);
