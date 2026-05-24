// services/bff/src/notices.ts
//
// Notice generation — closes §2.3 #17 of ZorEWS_Pending_Gap_Analysis.md.
//
// 4 endpoints back the Notice generation wireframe:
//   GET  /v1/notices/templates                            (template catalogue)
//   GET  /v1/notices/templates/:template_id               (single template)
//   POST /v1/notices/preview                              (render without issuing)
//   POST /v1/notices/issue                                (issue + record + return cohort summary)
//
// Distinct from M10 notification channels (channel-specific email/SMS/push
// templates) — Notices are REGULATORY / BORROWER COMMUNICATION rendered
// documents (notice of demand, SARFAESI 13(2), SMA reminder, NPA tagging)
// that go through the bank's outbound mail/SMS systems with an audit trail.

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

export type NoticeCategory = 'sma_reminder' | 'npa_tagging' | 'sarfaesi_13_2' | 'demand_notice' | 'covenant_breach' | 'kyc_refresh' | 'fraud_advisory';
export const ALL_NOTICE_CATEGORIES: readonly NoticeCategory[] = [
  'sma_reminder', 'npa_tagging', 'sarfaesi_13_2', 'demand_notice', 'covenant_breach', 'kyc_refresh', 'fraud_advisory',
];

export type NoticeChannel = 'email' | 'sms' | 'post' | 'registered_post';
export const ALL_NOTICE_CHANNELS: readonly NoticeChannel[] = ['email', 'sms', 'post', 'registered_post'];

export interface NoticeTemplate {
  template_id: string;
  category: NoticeCategory;
  name: string;
  description: string;
  default_channels: NoticeChannel[];
  required_vars: string[];
  subject_template: string;
  body_template: string;
  source_doc: string;
}

export const NOTICE_TEMPLATES: NoticeTemplate[] = [
  {
    template_id: 'tpl_sma_reminder_v1',
    category: 'sma_reminder',
    name: 'SMA Overdue Reminder',
    description: 'Reminder for accounts crossing SMA-0/1/2 with overdue installments per RBI Master Direction (2015).',
    default_channels: ['email', 'sms'],
    required_vars: ['customer_name', 'account_id', 'overdue_amount', 'overdue_days', 'sma_category', 'as_of_date'],
    subject_template: 'Reminder: Account {{account_id}} is overdue ({{sma_category}})',
    body_template: 'Dear {{customer_name}},\n\nOur records indicate that your account {{account_id}} has overdue dues of INR {{overdue_amount}} as on {{as_of_date}} ({{overdue_days}} days past due). The account has been classified as {{sma_category}} per RBI Master Direction.\n\nPlease regularise the dues at the earliest to avoid further escalation.\n\nRegards,\nApex Bank',
    source_doc: 'RBI Master Direction on Stressed Assets (April 2015)',
  },
  {
    template_id: 'tpl_npa_tagging_v1',
    category: 'npa_tagging',
    name: 'NPA Classification Notice',
    description: 'Mandatory notice when account is tagged NPA (90+ DPD).',
    default_channels: ['registered_post', 'email'],
    required_vars: ['customer_name', 'account_id', 'sanctioned_limit', 'outstanding_balance', 'tagged_on', 'sub_category'],
    subject_template: 'Notice of NPA classification — Account {{account_id}}',
    body_template: 'Dear {{customer_name}},\n\nWith reference to the loan facility extended (Account: {{account_id}}, Sanctioned: INR {{sanctioned_limit}}), we hereby inform you that your account has been classified as Non-Performing Asset (Sub-Category: {{sub_category}}) effective {{tagged_on}}. Outstanding balance: INR {{outstanding_balance}}.\n\nKindly contact your relationship manager within 15 days.\n\nRegards,\nApex Bank',
    source_doc: 'RBI IRACP Norms',
  },
  {
    template_id: 'tpl_sarfaesi_13_2_v1',
    category: 'sarfaesi_13_2',
    name: 'SARFAESI Section 13(2) Notice',
    description: 'Statutory 60-day demand notice under SARFAESI 13(2) for secured asset recovery.',
    default_channels: ['registered_post'],
    required_vars: ['customer_name', 'account_id', 'outstanding_balance', 'security_description', 'demand_date'],
    subject_template: 'SARFAESI 13(2) Demand Notice — Account {{account_id}}',
    body_template: 'TO: {{customer_name}}\n\nUnder Section 13(2) of the SARFAESI Act, 2002, you are hereby called upon to discharge your liability of INR {{outstanding_balance}} in respect of loan account {{account_id}} within 60 days from the date of this notice ({{demand_date}}). The security charged is: {{security_description}}.\n\nFailure to comply will entitle the Bank to exercise its rights under Section 13(4) of the Act.\n\nAuthorised Officer,\nApex Bank',
    source_doc: 'SARFAESI Act, 2002 — Section 13(2)',
  },
  {
    template_id: 'tpl_demand_notice_v1',
    category: 'demand_notice',
    name: 'Demand Notice (cooperative + civil recovery)',
    description: 'General demand for repayment prior to SARFAESI invocation.',
    default_channels: ['registered_post', 'email'],
    required_vars: ['customer_name', 'account_id', 'outstanding_balance', 'demand_date'],
    subject_template: 'Demand Notice — Account {{account_id}}',
    body_template: 'Dear {{customer_name}},\n\nYou are hereby called upon to pay the outstanding amount of INR {{outstanding_balance}} on Account {{account_id}} within 30 days from {{demand_date}}, failing which the Bank shall initiate recovery proceedings without further notice.\n\nRegards,\nApex Bank',
    source_doc: 'Internal credit policy',
  },
  {
    template_id: 'tpl_covenant_breach_v1',
    category: 'covenant_breach',
    name: 'Covenant Breach Notice',
    description: 'Notice when a financial / non-financial covenant under the sanction letter is breached.',
    default_channels: ['email'],
    required_vars: ['customer_name', 'account_id', 'covenant_name', 'breach_value', 'cure_period_days'],
    subject_template: 'Covenant breach — {{covenant_name}} on Account {{account_id}}',
    body_template: 'Dear {{customer_name}},\n\nOur records indicate that the covenant "{{covenant_name}}" agreed under your sanction letter has been breached (observed value: {{breach_value}}). You are required to cure this breach within {{cure_period_days}} days.\n\nRegards,\nApex Bank',
    source_doc: 'Sanction letter — standard covenant clauses',
  },
  {
    template_id: 'tpl_kyc_refresh_v1',
    category: 'kyc_refresh',
    name: 'KYC Refresh Reminder',
    description: 'KYC re-verification reminder per RBI KYC Master Direction.',
    default_channels: ['email', 'sms'],
    required_vars: ['customer_name', 'customer_id', 'kyc_due_date'],
    subject_template: 'KYC refresh required — {{customer_id}}',
    body_template: 'Dear {{customer_name}},\n\nYour Know Your Customer (KYC) details require refresh as per RBI guidelines. The deadline is {{kyc_due_date}}. Please visit the nearest branch with valid identity and address proofs.\n\nRegards,\nApex Bank',
    source_doc: 'RBI KYC Master Direction (2016, as amended)',
  },
  {
    template_id: 'tpl_fraud_advisory_v1',
    category: 'fraud_advisory',
    name: 'Fraud Reporting Advisory',
    description: 'Customer notification when account shows suspected fraudulent activity.',
    default_channels: ['email', 'sms'],
    required_vars: ['customer_name', 'account_id', 'suspected_txn_count', 'as_of_date'],
    subject_template: 'Important: Suspected fraudulent activity on Account {{account_id}}',
    body_template: 'Dear {{customer_name}},\n\nWe have observed {{suspected_txn_count}} suspicious transactions on your account {{account_id}} as on {{as_of_date}}. As a precaution, we recommend changing your transaction PIN and contacting our 24x7 helpline immediately.\n\nRegards,\nApex Bank Fraud Risk Cell',
    source_doc: 'RBI Master Directions on Frauds (2016)',
  },
];

export class NoticesError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NoticesError';
  }
}

export function isNoticeCategory(x: unknown): x is NoticeCategory {
  return typeof x === 'string' && ALL_NOTICE_CATEGORIES.includes(x as NoticeCategory);
}
export function isNoticeChannel(x: unknown): x is NoticeChannel {
  return typeof x === 'string' && ALL_NOTICE_CHANNELS.includes(x as NoticeChannel);
}

export function listNoticeTemplates(category?: NoticeCategory): NoticeTemplate[] {
  const out = category ? NOTICE_TEMPLATES.filter((t) => t.category === category) : NOTICE_TEMPLATES.slice();
  return out.map((t) => ({ ...t, default_channels: [...t.default_channels], required_vars: [...t.required_vars] }));
}

export function getNoticeTemplate(template_id: string): NoticeTemplate | null {
  const found = NOTICE_TEMPLATES.find((t) => t.template_id === template_id);
  if (!found) return null;
  return { ...found, default_channels: [...found.default_channels], required_vars: [...found.required_vars] };
}

function substitute(template: string, vars: Record<string, string | number>): { rendered: string; missing: string[] } {
  const missing: string[] = [];
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    if (vars[key] === undefined || vars[key] === null || vars[key] === '') {
      missing.push(key);
      return `{{${key}}}`;
    }
    return String(vars[key]);
  });
  return { rendered, missing: Array.from(new Set(missing)) };
}

export interface NoticePreviewInput {
  template_id: string;
  vars: Record<string, string | number>;
  channels?: NoticeChannel[];
}

export interface NoticePreview {
  template_id: string;
  category: NoticeCategory;
  subject: string;
  body: string;
  channels: NoticeChannel[];
  missing_vars: string[];
  ready_to_issue: boolean;
}

export function previewNotice(input: NoticePreviewInput): NoticePreview {
  if (!input || typeof input !== 'object') throw new NoticesError('invalid_input', 'input required');
  if (!input.template_id) throw new NoticesError('invalid_input', 'template_id required');
  const tpl = getNoticeTemplate(input.template_id);
  if (!tpl) throw new NoticesError('unknown_template', `unknown template ${input.template_id}`);
  const vars = input.vars ?? {};
  const channels = input.channels && input.channels.length > 0 ? input.channels : tpl.default_channels;
  for (const ch of channels) {
    if (!isNoticeChannel(ch)) throw new NoticesError('invalid_channel', `invalid channel ${ch}`);
  }
  const sub = substitute(tpl.subject_template, vars);
  const bod = substitute(tpl.body_template, vars);
  const missing = Array.from(new Set([...sub.missing, ...bod.missing]));
  return {
    template_id: tpl.template_id,
    category: tpl.category,
    subject: sub.rendered,
    body: bod.rendered,
    channels,
    missing_vars: missing,
    ready_to_issue: missing.length === 0,
  };
}

export interface NoticeCohortRow {
  customer_id: string;
  vars: Record<string, string | number>;
}

export interface NoticeIssueInput {
  template_id: string;
  cohort: NoticeCohortRow[];
  channels?: NoticeChannel[];
}

export interface NoticeIssueRow {
  customer_id: string;
  notice_id: string;
  status: 'issued' | 'skipped';
  reason?: string;
  channels: NoticeChannel[];
  rendered_subject?: string;
}

export interface NoticeIssueResult {
  tenant_id: string;
  template_id: string;
  category: NoticeCategory;
  issued_at: string;
  issued_by: string;
  cohort_size: number;
  issued_count: number;
  skipped_count: number;
  rows: NoticeIssueRow[];
}

const _issueLedger = new Map<string, NoticeIssueResult>();
let _issueSeq = 0;

export function issueNotices(tenant_id: string, input: NoticeIssueInput, issued_by: string, now: Date): NoticeIssueResult {
  if (!tenant_id) throw new NoticesError('invalid_input', 'tenant_id required');
  if (!issued_by) throw new NoticesError('invalid_input', 'issued_by required');
  if (!input || typeof input !== 'object') throw new NoticesError('invalid_input', 'input required');
  if (!input.template_id) throw new NoticesError('invalid_input', 'template_id required');
  if (!Array.isArray(input.cohort) || input.cohort.length === 0)
    throw new NoticesError('invalid_input', 'cohort must be non-empty');
  if (input.cohort.length > 1000) throw new NoticesError('cohort_too_large', 'cohort > 1000');
  const tpl = getNoticeTemplate(input.template_id);
  if (!tpl) throw new NoticesError('unknown_template', `unknown template ${input.template_id}`);
  const channels = input.channels && input.channels.length > 0 ? input.channels : tpl.default_channels;
  for (const ch of channels) {
    if (!isNoticeChannel(ch)) throw new NoticesError('invalid_channel', `invalid channel ${ch}`);
  }

  const rows: NoticeIssueRow[] = [];
  let issuedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < input.cohort.length; i++) {
    const row = input.cohort[i];
    if (!row.customer_id) {
      rows.push({ customer_id: '', notice_id: '', status: 'skipped', reason: 'missing_customer_id', channels });
      skippedCount++;
      continue;
    }
    const preview = previewNotice({ template_id: input.template_id, vars: row.vars ?? {}, channels });
    if (!preview.ready_to_issue) {
      rows.push({
        customer_id: row.customer_id,
        notice_id: '',
        status: 'skipped',
        reason: `missing_vars: ${preview.missing_vars.join(',')}`,
        channels,
      });
      skippedCount++;
      continue;
    }
    _issueSeq++;
    const noticeId = `ntc-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(_issueSeq).padStart(5, '0')}`;
    rows.push({
      customer_id: row.customer_id,
      notice_id: noticeId,
      status: 'issued',
      channels,
      rendered_subject: preview.subject,
    });
    issuedCount++;
  }

  const result: NoticeIssueResult = {
    tenant_id,
    template_id: tpl.template_id,
    category: tpl.category,
    issued_at: now.toISOString(),
    issued_by,
    cohort_size: input.cohort.length,
    issued_count: issuedCount,
    skipped_count: skippedCount,
    rows,
  };
  const runId = `${tenant_id}-${_issueSeq}-${tpl.template_id}`;
  _issueLedger.set(runId, result);
  return result;
}

export function listIssuedRuns(tenant_id: string): NoticeIssueResult[] {
  const out: NoticeIssueResult[] = [];
  for (const v of _issueLedger.values()) if (v.tenant_id === tenant_id) out.push(v);
  out.sort((a, b) => b.issued_at.localeCompare(a.issued_at));
  return out;
}

export function _resetNoticeStore() {
  _issueLedger.clear();
  _issueSeq = 0;
}

// Suppress unused-var warning for mulberry32 + fnv1a — exported helpers
// kept for future cohort-builder synthesis (e.g. seeding test cohorts
// deterministically when the SPA reuses the resolver for dry-runs).
void mulberry32;
void fnv1a;
