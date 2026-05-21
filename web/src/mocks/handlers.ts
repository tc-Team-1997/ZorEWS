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

export const handlers = [
  ..._mswReportBuilderHandlers,
  ..._mswFeatureStoreHandlers,
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
];

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
