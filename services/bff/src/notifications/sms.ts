// services/bff/src/notifications/sms.ts
//
// T6 M10.2 — BIL SMS notification channel.
//
// Same architecture as M10.1 email channel — `<Channel>Transport`
// interface + `Stub<Channel>Transport` implementation + canned
// templates + per-tenant ledger. The shape was designed to scale to
// SMS / push / in-app at M10.1 time; this commit demonstrates the
// abstraction holds.
//
// BIL constraints (per pitch §13):
//   - SMS bodies ≤ 160 chars (single SMS segment — operator chatter)
//   - E.164 international phone numbers
//   - 4 canned templates: ALERT_RED_BRIEF, OTP_LOGIN, KYC_REMINDER,
//     PAYMENT_REMINDER
//
// Production swap: a Twilio / MSG91 / SMS-gateway transport satisfying
// the SmsTransport interface. The StubSmsTransport's ledger captures
// every send for ops dashboards + delivery audits.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type SmsStatus = 'queued' | 'sent' | 'failed';

export type SmsTemplateId = 'ALERT_RED_BRIEF' | 'OTP_LOGIN' | 'KYC_REMINDER' | 'PAYMENT_REMINDER';

export interface SmsMessageInput {
  /** E.164 phone number (e.g. +254712345678). */
  to: string;
  /** Plain-text body — required when no template_id supplied. ≤ 160 chars. */
  body?: string;
  /** Canned template id; body derived from template + template_vars. */
  template_id?: SmsTemplateId;
  /** {{var}} substitutions for the template. */
  template_vars?: Record<string, string | number>;
  /** Optional alert + case correlations preserved in the ledger. */
  related_alert_id?: string;
  related_case_id?: string;
}

export interface SmsReceipt {
  message_id: string;
  status: SmsStatus;
  sent_at: string;
  /** Transport name — `stub` for the prototype, `twilio` / `msg91` etc. */
  transport: string;
  /** Number of SMS segments billed (always 1 in the stub since body
   *  is capped at 160 chars). */
  segments: number;
}

export interface SmsLedgerEntry extends SmsReceipt {
  tenant_id: string;
  to: string;
  body: string;
  template_id?: SmsTemplateId;
  related_alert_id?: string;
  related_case_id?: string;
}

export interface SmsTransport {
  send(tenant_id: string, msg: SmsMessageInput): Promise<SmsReceipt>;
  /** Recent ledger entries newest-first. tenant_id=null returns all
   *  tenants (admin platform view). */
  recent(tenant_id: string | null, limit?: number): SmsLedgerEntry[];
}

export class SmsValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SmsValidationError';
  }
}

// ─── Templates ─────────────────────────────────────────────────────────
//
// Keep bodies very tight — 160 chars is the single-segment SMS budget.
// The template strings here include the {{var}} placeholders so the
// final length depends on the variable values — we validate length on
// resolveMessage.

interface TemplateDef {
  id: SmsTemplateId;
  description: string;
  required_vars: string[];
  body: string;
}

const TEMPLATES: Record<SmsTemplateId, TemplateDef> = {
  ALERT_RED_BRIEF: {
    id: 'ALERT_RED_BRIEF',
    description: 'Red-severity alert SMS — escalation digest for ops oncall',
    required_vars: ['customer_name', 'case_id'],
    body: 'APEX RED alert {{customer_name}} - case {{case_id}}. Action required immediately.',
  },
  OTP_LOGIN: {
    id: 'OTP_LOGIN',
    description: 'One-time login passcode',
    required_vars: ['otp', 'minutes_valid'],
    body: 'ZorEWS login OTP: {{otp}}. Valid for {{minutes_valid}} minutes. Do not share.',
  },
  KYC_REMINDER: {
    id: 'KYC_REMINDER',
    description: 'KYC document reminder',
    required_vars: ['days_until_expiry'],
    body: 'Your KYC expires in {{days_until_expiry}} days. Upload renewed proof at apex-ews.test.',
  },
  PAYMENT_REMINDER: {
    id: 'PAYMENT_REMINDER',
    description: 'Premium payment reminder',
    required_vars: ['policy_id', 'amount_kes', 'due_date'],
    body: 'Premium for policy {{policy_id}} ({{amount_kes}} KES) due {{due_date}}. Pay to avoid lapse.',
  },
};

export function listSmsTemplates(): TemplateDef[] {
  return Object.values(TEMPLATES);
}

export function getSmsTemplate(id: SmsTemplateId): TemplateDef | undefined {
  return TEMPLATES[id];
}

/** {{var}} substitution. Unmatched slots survive in the output. */
export function substitute(body: string, vars: Record<string, string | number> = {}): string {
  return body.replace(/\{\{(\w+)\}\}/g, (m, name) => {
    const v = vars[name];
    return v === undefined ? m : String(v);
  });
}

export function renderSmsTemplate(
  id: SmsTemplateId,
  vars: Record<string, string | number> = {},
): { body: string; missing_vars: string[] } {
  const t = TEMPLATES[id];
  if (!t) {
    throw new SmsValidationError('unknown_template', `unknown template: ${id}`);
  }
  const missing_vars = t.required_vars.filter((v) => vars[v] === undefined);
  return {
    body: substitute(t.body, vars),
    missing_vars,
  };
}

// ─── Validation ────────────────────────────────────────────────────────

const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_BODY_LENGTH = 160;

function validateE164(addr: string): string {
  if (typeof addr !== 'string' || !E164.test(addr)) {
    throw new SmsValidationError(
      'invalid_recipient',
      `to must be an E.164 phone number (e.g. +254712345678); got ${addr}`,
    );
  }
  return addr;
}

/**
 * Resolve template + caller body into a final body. Caller-supplied
 * body overrides the template body when both are present.
 *
 * @throws SmsValidationError on missing recipient, missing body+template,
 *   missing template vars, or body > 160 chars.
 */
export function resolveMessage(input: SmsMessageInput): {
  to: string;
  body: string;
  template_id?: SmsTemplateId;
  related_alert_id?: string;
  related_case_id?: string;
} {
  if (!input || typeof input !== 'object') {
    throw new SmsValidationError('invalid_input', 'request body required');
  }
  const to = validateE164(input.to);

  let body: string | undefined = input.body;
  let template_id: SmsTemplateId | undefined = input.template_id;
  if (template_id) {
    const r = renderSmsTemplate(template_id, input.template_vars);
    if (r.missing_vars.length > 0) {
      throw new SmsValidationError(
        'missing_template_vars',
        `template ${template_id} requires: ${r.missing_vars.join(', ')}`,
      );
    }
    body = body ?? r.body;
  }

  if (!body || typeof body !== 'string' || !body.trim()) {
    throw new SmsValidationError('missing_body', 'body is required (or supply a template_id)');
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new SmsValidationError(
      'body_too_long',
      `body must be ≤ ${MAX_BODY_LENGTH} chars (got ${body.length})`,
    );
  }

  return {
    to,
    body,
    template_id,
    related_alert_id: input.related_alert_id,
    related_case_id: input.related_case_id,
  };
}

// ─── Stub transport ────────────────────────────────────────────────────

export class StubSmsTransport implements SmsTransport {
  private readonly ledger: SmsLedgerEntry[] = [];
  private readonly cap: number;
  private readonly clock: () => Date;
  private readonly transportName: string;

  constructor(opts: { cap?: number; now?: () => Date; transportName?: string } = {}) {
    this.cap = opts.cap ?? 200;
    this.clock = opts.now ?? (() => new Date());
    this.transportName = opts.transportName ?? 'stub';
  }

  async send(tenant_id: string, input: SmsMessageInput): Promise<SmsReceipt> {
    const resolved = resolveMessage(input);
    const message_id = `sms-${randomUUID()}`;
    const sent_at = this.clock().toISOString();
    const entry: SmsLedgerEntry = {
      message_id,
      tenant_id,
      to: resolved.to,
      body: resolved.body,
      template_id: resolved.template_id,
      related_alert_id: resolved.related_alert_id,
      related_case_id: resolved.related_case_id,
      status: 'sent',
      sent_at,
      transport: this.transportName,
      segments: 1, // body capped at 160 chars → always 1 segment
    };
    this.ledger.push(entry);
    if (this.ledger.length > this.cap) {
      this.ledger.splice(0, this.ledger.length - this.cap);
    }
    return {
      message_id,
      status: 'sent',
      sent_at,
      transport: this.transportName,
      segments: 1,
    };
  }

  recent(tenant_id: string | null, limit = 50): SmsLedgerEntry[] {
    const filtered = tenant_id === null ? this.ledger : this.ledger.filter((e) => e.tenant_id === tenant_id);
    return filtered.slice(-limit).reverse();
  }

  /** Test helper. */
  reset(): void {
    this.ledger.length = 0;
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultSmsTransport: SmsTransport = new StubSmsTransport();
