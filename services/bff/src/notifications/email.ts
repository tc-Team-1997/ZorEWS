// services/bff/src/notifications/email.ts
//
// T6 M10.1 — BIL notification email channel.
//
// The notification system already has an in-process pub/sub bus +
// SSE stream for the SPA bell (`/v1/notifications/stream`). What's
// missing is a *delivery transport* — the BIL pitch deck (§13)
// explicitly calls out email as the primary out-of-band channel.
//
// This module provides:
//   - EmailTransport interface: send(message) → receipt, plus a
//     ledger query for ops dashboards
//   - StubEmailTransport: in-memory implementation for the prototype.
//     Records every send to a per-tenant ledger; production swap is
//     a SES/SMTP transport that satisfies the same interface.
//   - 4 canned templates per BIL §13: ALERT_RED, ALERT_ORANGE,
//     CASE_ASSIGNED, SLA_BREACH. Simple {{var}} substitution — heavy
//     templating engines aren't worth the dependency in this scope.
//
// Why a separate transport from the bus: in-app notifications and
// email have different SLAs, audit requirements, and failure modes.
// The bus is fire-and-forget for the SPA; email is auditable and
// retryable. They can be wired together later (an indicator breach
// publishes to the bus AND fires off an email) but the abstractions
// stay distinct.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type EmailStatus = 'queued' | 'sent' | 'failed';

export type EmailTemplateId = 'ALERT_RED' | 'ALERT_ORANGE' | 'CASE_ASSIGNED' | 'SLA_BREACH';

export interface EmailMessageInput {
  /** Recipient address(es). At least one. RFC 5322 not strictly enforced —
   *  validates a basic `<local>@<host>` shape. */
  to: string[];
  /** Optional carbon-copy. */
  cc?: string[];
  /** Subject — ≤ 200 chars. Required when no template_id supplied. */
  subject?: string;
  /** Plain-text body — required when no template_id supplied. */
  body_text?: string;
  /** Optional HTML body — passes through to the transport. */
  body_html?: string;
  /** When set, subject + body_text + body_html are derived from the
   *  template, then merged with template_vars. Caller-supplied subject /
   *  body fields override the template fields. */
  template_id?: EmailTemplateId;
  /** {{var}} substitutions for the template. Undeclared vars survive
   *  in the output as `{{name}}` so misuses are visible. */
  template_vars?: Record<string, string | number>;
  /** Optional links to the alert / case that triggered this email — kept
   *  in the ledger so ops can correlate. */
  related_alert_id?: string;
  related_case_id?: string;
}

export interface EmailReceipt {
  message_id: string;
  status: EmailStatus;
  /** ISO timestamp of send (or final terminal state). */
  sent_at: string;
  /** Identifies the transport that produced this receipt — `stub` for
   *  the prototype, `ses` / `smtp:relay-1` / etc. in production. */
  transport: string;
}

export interface EmailLedgerEntry extends EmailReceipt {
  tenant_id: string;
  to: string[];
  cc?: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  template_id?: EmailTemplateId;
  related_alert_id?: string;
  related_case_id?: string;
}

export interface EmailTransport {
  /** Send a message. Throws EmailValidationError on bad input.
   *  Resolves with a terminal receipt — the transport may have queued
   *  in production, but the ledger entry reflects the queued status. */
  send(tenant_id: string, msg: EmailMessageInput): Promise<EmailReceipt>;
  /**
   * Recent ledger entries (newest-first). Admin-only ops surface.
   * `tenant_id=null` returns all tenants (admin platform view); a
   * tenant id scopes to that tenant's entries.
   */
  recent(tenant_id: string | null, limit?: number): EmailLedgerEntry[];
}

export class EmailValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'EmailValidationError';
  }
}

// ─── Templates ─────────────────────────────────────────────────────────
//
// Sourced from DataNetworks-EWS-Ver1.pdf §13 ("Notification Examples").
// Subject + body_text are stored as raw strings with `{{var}}` slots.
// The renderer is `{{var}}` substitution — no logic, no loops.

interface TemplateDef {
  id: EmailTemplateId;
  description: string;
  required_vars: string[];
  subject: string;
  body_text: string;
  body_html?: string;
}

const TEMPLATES: Record<EmailTemplateId, TemplateDef> = {
  ALERT_RED: {
    id: 'ALERT_RED',
    description: 'Critical (Red) alert — immediate-action notification per BIL §11',
    required_vars: ['customer_name', 'indicator', 'risk_score', 'case_id'],
    subject: '[RED] {{customer_name}} — {{indicator}} breach (score {{risk_score}})',
    body_text:
      'A Red-severity alert has been raised:\n\n' +
      'Customer: {{customer_name}}\n' +
      'Indicator: {{indicator}}\n' +
      'Risk score: {{risk_score}}\n' +
      'Case: {{case_id}}\n\n' +
      'This requires immediate action. Open the case in ZorEWS to triage.',
  },
  ALERT_ORANGE: {
    id: 'ALERT_ORANGE',
    description: 'High (Orange) alert — investigate notification per BIL §11',
    required_vars: ['customer_name', 'indicator', 'risk_score'],
    subject: '[ORANGE] {{customer_name}} — {{indicator}} (score {{risk_score}})',
    body_text:
      'An Orange-severity alert has been raised:\n\n' +
      'Customer: {{customer_name}}\n' +
      'Indicator: {{indicator}}\n' +
      'Risk score: {{risk_score}}\n\n' +
      'Investigate within the standard SLA. Open ZorEWS to review.',
  },
  CASE_ASSIGNED: {
    id: 'CASE_ASSIGNED',
    description: 'Case assignment — recipient has been assigned a case',
    required_vars: ['case_id', 'customer_name', 'assignee_name', 'sla_hours'],
    subject: 'Case assigned to you: {{case_id}} ({{customer_name}})',
    body_text:
      'Hi {{assignee_name}},\n\n' +
      'You have been assigned case {{case_id}} for customer {{customer_name}}.\n' +
      'SLA: {{sla_hours}} hours from now.\n\n' +
      'Open ZorEWS to begin triage.',
  },
  SLA_BREACH: {
    id: 'SLA_BREACH',
    description: 'SLA breach — case has passed its SLA threshold',
    required_vars: ['case_id', 'customer_name', 'hours_overdue'],
    subject: '[SLA BREACH] {{case_id}} — {{hours_overdue}}h overdue',
    body_text:
      'Case {{case_id}} ({{customer_name}}) has breached its SLA by ' +
      '{{hours_overdue}} hours.\n\n' +
      'Escalation required. Open ZorEWS for the case detail.',
  },
};

export function listTemplates(): TemplateDef[] {
  return Object.values(TEMPLATES);
}

export function getTemplate(id: EmailTemplateId): TemplateDef | undefined {
  return TEMPLATES[id];
}

/** Substitute `{{var}}` slots. Unmatched slots survive in the output so
 *  misuses are visible to the operator instead of silently producing
 *  empty strings. */
export function substitute(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) => {
    const v = vars[name];
    return v === undefined ? m : String(v);
  });
}

/** Render a template + vars to a concrete (subject, body_text, body_html?).
 *  Throws EmailValidationError if the template is unknown. */
export function renderTemplate(
  id: EmailTemplateId,
  vars: Record<string, string | number> = {},
): { subject: string; body_text: string; body_html?: string; missing_vars: string[] } {
  const t = TEMPLATES[id];
  if (!t) {
    throw new EmailValidationError('unknown_template', `unknown template: ${id}`);
  }
  const missing_vars = t.required_vars.filter((v) => vars[v] === undefined);
  return {
    subject: substitute(t.subject, vars),
    body_text: substitute(t.body_text, vars),
    body_html: t.body_html ? substitute(t.body_html, vars) : undefined,
    missing_vars,
  };
}

// ─── Validation ────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateAddresses(field: 'to' | 'cc', addrs: string[] | undefined): string[] {
  if (addrs === undefined) return [];
  if (!Array.isArray(addrs)) {
    throw new EmailValidationError('invalid_addresses', `${field} must be a string[]`);
  }
  for (const a of addrs) {
    if (typeof a !== 'string' || !EMAIL_RE.test(a)) {
      throw new EmailValidationError('invalid_addresses', `${field} contains invalid address: ${a}`);
    }
  }
  return addrs;
}

/**
 * Resolve template + caller fields into a final (subject, body_text, body_html).
 * Caller-supplied fields override template-rendered fields.
 *
 * @throws EmailValidationError when no recipient is present, or neither
 *   template_id nor explicit subject+body are supplied, or required template
 *   vars are missing.
 */
export function resolveMessage(input: EmailMessageInput): {
  to: string[];
  cc: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  template_id?: EmailTemplateId;
  related_alert_id?: string;
  related_case_id?: string;
} {
  const to = validateAddresses('to', input.to);
  if (to.length === 0) {
    throw new EmailValidationError('no_recipient', 'to must contain at least one address');
  }
  const cc = validateAddresses('cc', input.cc);

  let subject: string | undefined = input.subject;
  let body_text: string | undefined = input.body_text;
  let body_html: string | undefined = input.body_html;
  let template_id: EmailTemplateId | undefined = input.template_id;

  if (template_id) {
    const r = renderTemplate(template_id, input.template_vars);
    if (r.missing_vars.length > 0) {
      throw new EmailValidationError(
        'missing_template_vars',
        `template ${template_id} requires: ${r.missing_vars.join(', ')}`,
      );
    }
    subject = subject ?? r.subject;
    body_text = body_text ?? r.body_text;
    body_html = body_html ?? r.body_html;
  }

  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    throw new EmailValidationError('missing_subject', 'subject is required (or supply a template_id)');
  }
  if (subject.length > 200) {
    throw new EmailValidationError('subject_too_long', 'subject must be ≤ 200 characters');
  }
  if (!body_text || typeof body_text !== 'string' || !body_text.trim()) {
    throw new EmailValidationError('missing_body', 'body_text is required (or supply a template_id)');
  }

  return {
    to,
    cc,
    subject,
    body_text,
    body_html,
    template_id,
    related_alert_id: input.related_alert_id,
    related_case_id: input.related_case_id,
  };
}

// ─── Stub transport ────────────────────────────────────────────────────

export class StubEmailTransport implements EmailTransport {
  /** Per-tenant ledger. Newest entries appended at the end; the recent()
   *  reader reverses + slices. */
  private readonly ledger: EmailLedgerEntry[] = [];
  /** Cap on stored entries to avoid unbounded growth in long-running
   *  test workers. Production transport persists, no cap. */
  private readonly cap: number;
  private readonly clock: () => Date;
  private readonly transportName: string;

  constructor(opts: { cap?: number; now?: () => Date; transportName?: string } = {}) {
    this.cap = opts.cap ?? 200;
    this.clock = opts.now ?? (() => new Date());
    this.transportName = opts.transportName ?? 'stub';
  }

  async send(tenant_id: string, input: EmailMessageInput): Promise<EmailReceipt> {
    const resolved = resolveMessage(input);
    const message_id = `email-${randomUUID()}`;
    const sent_at = this.clock().toISOString();
    const entry: EmailLedgerEntry = {
      message_id,
      tenant_id,
      status: 'sent',
      sent_at,
      transport: this.transportName,
      to: resolved.to,
      cc: resolved.cc.length > 0 ? resolved.cc : undefined,
      subject: resolved.subject,
      body_text: resolved.body_text,
      body_html: resolved.body_html,
      template_id: resolved.template_id,
      related_alert_id: resolved.related_alert_id,
      related_case_id: resolved.related_case_id,
    };
    this.ledger.push(entry);
    if (this.ledger.length > this.cap) {
      this.ledger.splice(0, this.ledger.length - this.cap);
    }
    return {
      message_id,
      status: entry.status,
      sent_at,
      transport: this.transportName,
    };
  }

  recent(tenant_id: string | null, limit = 50): EmailLedgerEntry[] {
    const filtered = tenant_id === null ? this.ledger : this.ledger.filter((e) => e.tenant_id === tenant_id);
    return filtered.slice(-limit).reverse();
  }

  /** Test helper. */
  reset(): void {
    this.ledger.length = 0;
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultEmailTransport: EmailTransport = new StubEmailTransport();
