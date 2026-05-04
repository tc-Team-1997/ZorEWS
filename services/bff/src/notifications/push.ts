// services/bff/src/notifications/push.ts
//
// T6 M10.3 — BIL push notification channel.
//
// 3rd Module 10 channel after email (M10.1) + SMS (M10.2). Same
// `<Channel>Transport` shape proves the abstraction scales to a 3rd
// channel. Push is the mobile/web side of the BIL pitch §13 escalation
// triad — the SPA bell + native APNS/FCM payloads + browser Web Push.
//
// BIL constraints (per pitch §13):
//   - title ≤ 100 chars (notification headline)
//   - body  ≤ 240 chars (subtitle area; truncated by some platforms)
//   - deep_link must be either a relative SPA path (/cases/123) or an
//     https:// URL (the SPA + native shell deep-link based on protocol)
//   - 3 platforms: FCM (Android), APNS (iOS), Web (browser push)
//   - 4 canned templates: ALERT_RED_PUSH, OTP_CONFIRM, NEW_CASE_ASSIGNED,
//     REPORT_READY
//
// Production swap: a Firebase Admin SDK / APNS / Web Push transport
// satisfying PushTransport. The StubPushTransport's per-tenant ledger
// captures every send for ops dashboards + delivery audits.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type PushStatus = 'queued' | 'sent' | 'failed';

export type PushPlatform = 'fcm' | 'apns' | 'web';

export type PushTemplateId = 'ALERT_RED_PUSH' | 'OTP_CONFIRM' | 'NEW_CASE_ASSIGNED' | 'REPORT_READY';

export interface PushDevice {
  /** Platform-specific token (FCM registration token, APNS device token,
   *  or Web Push subscription endpoint). */
  device_token: string;
  platform: PushPlatform;
  /** Username the device belongs to — used for audit trail. */
  user_id: string;
}

export interface PushMessageInput {
  /** One or more recipient devices. At least one. */
  to: PushDevice[];
  /** Optional caller-supplied title. Required when no template_id. */
  title?: string;
  /** Optional caller-supplied body. Required when no template_id. */
  body?: string;
  /** Optional deep-link target for the SPA / native shell. Either a
   *  relative path starting with `/` or an https:// URL. */
  deep_link?: string;
  /** Optional iOS badge count override (FCM ignores). */
  badge_count?: number;
  /** Canned template id; resolves into title + body. */
  template_id?: PushTemplateId;
  /** {{var}} substitutions for the template. */
  template_vars?: Record<string, string | number>;
  /** Optional alert + case correlations preserved in the ledger. */
  related_alert_id?: string;
  related_case_id?: string;
}

export interface PushReceipt {
  message_id: string;
  /** One per recipient device; same length as input.to. */
  per_device: PushPerDevice[];
  /** Roll-up status: 'sent' iff every per-device entry is sent;
   *  'queued' when at least one is queued; 'failed' when every device
   *  failed. */
  status: PushStatus;
  sent_at: string;
  transport: string;
}

export interface PushPerDevice {
  device_token: string;
  platform: PushPlatform;
  status: PushStatus;
  /** Set on failure; null otherwise. */
  error?: string;
}

export interface PushLedgerEntry extends PushReceipt {
  tenant_id: string;
  to: PushDevice[];
  title: string;
  body: string;
  deep_link?: string;
  badge_count?: number;
  template_id?: PushTemplateId;
  related_alert_id?: string;
  related_case_id?: string;
}

export interface PushTransport {
  send(tenant_id: string, msg: PushMessageInput): Promise<PushReceipt>;
  /** Recent ledger entries newest-first. tenant_id=null returns all
   *  tenants (admin platform view). */
  recent(tenant_id: string | null, limit?: number): PushLedgerEntry[];
}

export class PushValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PushValidationError';
  }
}

// ─── Templates ─────────────────────────────────────────────────────────

interface TemplateDef {
  id: PushTemplateId;
  description: string;
  required_vars: string[];
  title: string;
  body: string;
}

const TEMPLATES: Record<PushTemplateId, TemplateDef> = {
  ALERT_RED_PUSH: {
    id: 'ALERT_RED_PUSH',
    description: 'Red-severity alert push — critical action required',
    required_vars: ['customer_name', 'case_id'],
    title: 'APEX RED Alert',
    body: '{{customer_name}} flagged. Case {{case_id}} needs immediate action.',
  },
  OTP_CONFIRM: {
    id: 'OTP_CONFIRM',
    description: 'OTP confirmation push — login or sensitive action',
    required_vars: ['otp', 'minutes_valid'],
    title: 'Confirm your action',
    body: 'Your code is {{otp}}. Valid for {{minutes_valid}} minutes.',
  },
  NEW_CASE_ASSIGNED: {
    id: 'NEW_CASE_ASSIGNED',
    description: 'New case assigned to the device user',
    required_vars: ['case_id', 'customer_name', 'sla_hours'],
    title: 'New case assigned',
    body: 'Case {{case_id}} ({{customer_name}}) — {{sla_hours}}h SLA.',
  },
  REPORT_READY: {
    id: 'REPORT_READY',
    description: 'A report you requested is ready to download',
    required_vars: ['report_name'],
    title: 'Report ready',
    body: '"{{report_name}}" is ready to download.',
  },
};

export function listPushTemplates(): TemplateDef[] {
  return Object.values(TEMPLATES);
}

export function getPushTemplate(id: PushTemplateId): TemplateDef | undefined {
  return TEMPLATES[id];
}

/** {{var}} substitution. Unmatched slots survive in the output. */
export function substitute(s: string, vars: Record<string, string | number> = {}): string {
  return s.replace(/\{\{(\w+)\}\}/g, (m, name) => {
    const v = vars[name];
    return v === undefined ? m : String(v);
  });
}

export function renderPushTemplate(
  id: PushTemplateId,
  vars: Record<string, string | number> = {},
): { title: string; body: string; missing_vars: string[] } {
  const t = TEMPLATES[id];
  if (!t) {
    throw new PushValidationError('unknown_template', `unknown template: ${id}`);
  }
  const missing_vars = t.required_vars.filter((v) => vars[v] === undefined);
  return {
    title: substitute(t.title, vars),
    body: substitute(t.body, vars),
    missing_vars,
  };
}

// ─── Validation ────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 100;
const MAX_BODY_LENGTH = 240;
const VALID_PLATFORMS: PushPlatform[] = ['fcm', 'apns', 'web'];

export function isPushPlatform(s: unknown): s is PushPlatform {
  return typeof s === 'string' && VALID_PLATFORMS.includes(s as PushPlatform);
}

function validateDeepLink(s: unknown): string | undefined {
  if (s === undefined) return undefined;
  if (typeof s !== 'string') {
    throw new PushValidationError('invalid_deep_link', 'deep_link must be a string');
  }
  if (s.startsWith('/')) return s;
  if (/^https:\/\//.test(s)) return s;
  throw new PushValidationError(
    'invalid_deep_link',
    `deep_link must be a relative path starting with '/' OR an https:// URL (got '${s}')`,
  );
}

function validateDevices(devices: unknown): PushDevice[] {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new PushValidationError('no_devices', 'to must contain at least one device');
  }
  if (devices.length > 1000) {
    throw new PushValidationError('too_many_devices', 'to must contain at most 1000 devices');
  }
  return devices.map((d, idx) => {
    if (!d || typeof d !== 'object') {
      throw new PushValidationError('invalid_device', `device[${idx}] must be an object`);
    }
    const obj = d as Partial<PushDevice>;
    if (typeof obj.device_token !== 'string' || !obj.device_token.trim()) {
      throw new PushValidationError(
        'invalid_device',
        `device[${idx}].device_token must be a non-empty string`,
      );
    }
    if (!isPushPlatform(obj.platform)) {
      throw new PushValidationError(
        'invalid_device',
        `device[${idx}].platform must be one of fcm|apns|web (got '${obj.platform}')`,
      );
    }
    if (typeof obj.user_id !== 'string' || !obj.user_id.trim()) {
      throw new PushValidationError(
        'invalid_device',
        `device[${idx}].user_id must be a non-empty string`,
      );
    }
    return { device_token: obj.device_token, platform: obj.platform, user_id: obj.user_id };
  });
}

/**
 * Resolve template + caller fields into a final (title, body, deep_link).
 * Caller-supplied title/body override template-rendered ones.
 */
export function resolveMessage(input: PushMessageInput): {
  to: PushDevice[];
  title: string;
  body: string;
  deep_link?: string;
  badge_count?: number;
  template_id?: PushTemplateId;
  related_alert_id?: string;
  related_case_id?: string;
} {
  if (!input || typeof input !== 'object') {
    throw new PushValidationError('invalid_input', 'request body required');
  }
  const to = validateDevices(input.to);
  const deep_link = validateDeepLink(input.deep_link);

  let title: string | undefined = input.title;
  let body: string | undefined = input.body;
  const template_id = input.template_id;
  if (template_id) {
    const r = renderPushTemplate(template_id, input.template_vars);
    if (r.missing_vars.length > 0) {
      throw new PushValidationError(
        'missing_template_vars',
        `template ${template_id} requires: ${r.missing_vars.join(', ')}`,
      );
    }
    title = title ?? r.title;
    body = body ?? r.body;
  }

  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new PushValidationError(
      'missing_title',
      'title is required (or supply a template_id)',
    );
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new PushValidationError(
      'title_too_long',
      `title must be ≤ ${MAX_TITLE_LENGTH} chars (got ${title.length})`,
    );
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    throw new PushValidationError(
      'missing_body',
      'body is required (or supply a template_id)',
    );
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new PushValidationError(
      'body_too_long',
      `body must be ≤ ${MAX_BODY_LENGTH} chars (got ${body.length})`,
    );
  }
  if (input.badge_count !== undefined) {
    if (typeof input.badge_count !== 'number' || !Number.isInteger(input.badge_count) || input.badge_count < 0) {
      throw new PushValidationError(
        'invalid_badge',
        'badge_count must be a non-negative integer',
      );
    }
  }

  return {
    to,
    title,
    body,
    deep_link,
    badge_count: input.badge_count,
    template_id,
    related_alert_id: input.related_alert_id,
    related_case_id: input.related_case_id,
  };
}

// ─── Stub transport ────────────────────────────────────────────────────

export class StubPushTransport implements PushTransport {
  private readonly ledger: PushLedgerEntry[] = [];
  private readonly cap: number;
  private readonly clock: () => Date;
  private readonly transportName: string;

  constructor(opts: { cap?: number; now?: () => Date; transportName?: string } = {}) {
    this.cap = opts.cap ?? 200;
    this.clock = opts.now ?? (() => new Date());
    this.transportName = opts.transportName ?? 'stub';
  }

  async send(tenant_id: string, input: PushMessageInput): Promise<PushReceipt> {
    const resolved = resolveMessage(input);
    const message_id = `push-${randomUUID()}`;
    const sent_at = this.clock().toISOString();
    // Per-device status: stub fans out 'sent' to every recipient. Real
    // transport would fan out per-device errors here.
    const per_device: PushPerDevice[] = resolved.to.map((d) => ({
      device_token: d.device_token,
      platform: d.platform,
      status: 'sent',
    }));
    const status: PushStatus = 'sent';

    const entry: PushLedgerEntry = {
      message_id,
      tenant_id,
      to: resolved.to,
      title: resolved.title,
      body: resolved.body,
      deep_link: resolved.deep_link,
      badge_count: resolved.badge_count,
      template_id: resolved.template_id,
      related_alert_id: resolved.related_alert_id,
      related_case_id: resolved.related_case_id,
      per_device,
      status,
      sent_at,
      transport: this.transportName,
    };
    this.ledger.push(entry);
    if (this.ledger.length > this.cap) {
      this.ledger.splice(0, this.ledger.length - this.cap);
    }
    return {
      message_id,
      per_device,
      status,
      sent_at,
      transport: this.transportName,
    };
  }

  recent(tenant_id: string | null, limit = 50): PushLedgerEntry[] {
    const filtered = tenant_id === null ? this.ledger : this.ledger.filter((e) => e.tenant_id === tenant_id);
    return filtered.slice(-limit).reverse();
  }

  /** Test helper. */
  reset(): void {
    this.ledger.length = 0;
  }
}

/** Module-level singleton. */
export const defaultPushTransport: PushTransport = new StubPushTransport();
