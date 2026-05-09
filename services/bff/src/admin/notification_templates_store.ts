// services/bff/src/admin/notification_templates_store.ts
//
// CRUD store for app_admin.notification_templates (T6 M14.15 schema).
// In-memory implementation for tests + dev fallback. The PG-backed
// implementation reads from `data/schema/021_case_scenarios_and_admin_extensions.sql`.
//
// Mirrors the sla_config_store contract:
//   - tenant-scoped everywhere
//   - validation throws NotificationTemplateError {status, code, message}
//   - status moves DRAFT → ACTIVE → ARCHIVED forward only
//   - soft-delete via deleted_at — list() hides deleted rows
//
// The DB CHECK constraints in 021 enforce the same rules at the
// storage layer (channel/subject pairing, body length, name uniqueness),
// so a malformed payload fails twice — once cheaply at the API boundary
// and once authoritatively at INSERT time.

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  type NotificationChannel,
  type NotificationTemplate,
  type NotificationTemplateStatus,
} from './case_scenarios_types';

export interface CreateNotificationTemplateInput {
  name: string;
  channel: NotificationChannel;
  subject?: string | null;
  body: string;
  locale?: string;
}

export interface UpdateNotificationTemplateInput {
  name?: string;
  subject?: string | null;
  body?: string;
  locale?: string;
}

export interface ListFilter {
  channel?: NotificationChannel;
  status?: NotificationTemplateStatus[];
  /** Default false — soft-deleted rows hidden. */
  include_deleted?: boolean;
  page?: number;
  page_size?: number;
}

export interface ListResult {
  items: NotificationTemplate[];
  total: number;
  page: number;
  page_size: number;
}

export interface ActorContext {
  actor_id: string;
}

export class NotificationTemplateError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'NotificationTemplateError';
  }
}

// ─── Validation (pure, no IO) ────────────────────────────────────────

const VALID_CHANNELS: readonly NotificationChannel[] = ['EMAIL', 'SMS', 'IN_APP'];
const VALID_STATUSES: readonly NotificationTemplateStatus[] = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

function bad(code: string, msg: string): never {
  throw new NotificationTemplateError(400, code, msg);
}

function validateName(s: unknown): string {
  if (typeof s !== 'string') bad('EWS_400_invalid_input', 'name must be a string');
  const t = (s as string).trim();
  if (t.length < 1 || t.length > 120) bad('EWS_400_invalid_input', 'name length must be 1..120');
  return t;
}

function validateChannel(c: unknown): NotificationChannel {
  if (typeof c !== 'string' || !(VALID_CHANNELS as readonly string[]).includes(c)) {
    bad('EWS_400_invalid_input', `channel must be one of ${VALID_CHANNELS.join('|')}`);
  }
  return c as NotificationChannel;
}

function validateBody(s: unknown): string {
  if (typeof s !== 'string') bad('EWS_400_invalid_input', 'body must be a string');
  const t = s as string;
  if (t.length < 1 || t.length > 10000) bad('EWS_400_invalid_input', 'body length must be 1..10000');
  return t;
}

function validateLocale(s: unknown): string {
  if (s === undefined || s === null || s === '') return 'en-IN';
  if (typeof s !== 'string') bad('EWS_400_invalid_input', 'locale must be a string');
  const t = (s as string).trim();
  if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(t)) bad('EWS_400_invalid_input', 'locale must be BCP-47 (e.g. en-IN)');
  return t;
}

/** Channel ↔ subject pairing — mirrors the DB CHECK. */
function validateSubjectForChannel(
  subject: string | null,
  channel: NotificationChannel,
): string | null {
  if (channel === 'SMS') {
    if (subject !== null && subject !== '') {
      bad('EWS_400_invalid_input', 'subject must be null for SMS channel');
    }
    return null;
  }
  // EMAIL + IN_APP require subject
  if (subject === null || subject === undefined) {
    bad('EWS_400_invalid_input', `subject required for ${channel} channel`);
  }
  if (typeof subject !== 'string') bad('EWS_400_invalid_input', 'subject must be a string');
  const t = subject.trim();
  if (t.length < 1 || t.length > 200) bad('EWS_400_invalid_input', 'subject length must be 1..200');
  return t;
}

export function validateCreate(raw: unknown): {
  name: string;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  locale: string;
} {
  if (!raw || typeof raw !== 'object') bad('EWS_400_invalid_input', 'request body required');
  const r = raw as Record<string, unknown>;
  const name = validateName(r.name);
  const channel = validateChannel(r.channel);
  const body = validateBody(r.body);
  const locale = validateLocale(r.locale);
  const subjectIn = r.subject === undefined ? null : (r.subject as string | null);
  const subject = validateSubjectForChannel(subjectIn, channel);
  return { name, channel, subject, body, locale };
}

export function validateUpdate(raw: unknown): UpdateNotificationTemplateInput {
  if (!raw || typeof raw !== 'object') bad('EWS_400_invalid_input', 'request body required');
  const r = raw as Record<string, unknown>;
  const out: UpdateNotificationTemplateInput = {};
  if (r.name !== undefined) out.name = validateName(r.name);
  if (r.body !== undefined) out.body = validateBody(r.body);
  if (r.locale !== undefined) out.locale = validateLocale(r.locale);
  // subject patch is deferred to update() so we can pair against the row's channel
  if (r.subject !== undefined) {
    if (r.subject !== null && typeof r.subject !== 'string') {
      bad('EWS_400_invalid_input', 'subject must be a string or null');
    }
    out.subject = r.subject as string | null;
  }
  if (Object.keys(out).length === 0) {
    bad('EWS_400_invalid_input', 'at least one of name/subject/body/locale must be provided');
  }
  return out;
}

// ─── Store interface ─────────────────────────────────────────────────

export interface NotificationTemplateStore {
  list(tenant_id: string, filter: ListFilter): Promise<ListResult>;
  get(tenant_id: string, id: string): Promise<NotificationTemplate | null>;
  create(
    tenant_id: string,
    input: ReturnType<typeof validateCreate>,
    actor: ActorContext,
    now: Date,
  ): Promise<NotificationTemplate>;
  update(
    tenant_id: string,
    id: string,
    patch: UpdateNotificationTemplateInput,
    actor: ActorContext,
    now: Date,
  ): Promise<NotificationTemplate>;
  /** Status DRAFT → ACTIVE. Idempotent on already-ACTIVE rows. Refuses ARCHIVED. */
  activate(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<NotificationTemplate>;
  /** Sets deleted_at + status=ARCHIVED. Idempotent on already-deleted rows. */
  archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<NotificationTemplate>;
}

// ─── In-memory implementation ────────────────────────────────────────

export class InMemoryNotificationTemplateStore implements NotificationTemplateStore {
  private readonly rows: NotificationTemplate[] = [];

  /** Test helper — seed deterministic rows. */
  seed(...rows: NotificationTemplate[]): void {
    for (const r of rows) this.rows.push({ ...r });
  }

  async list(tenant_id: string, filter: ListFilter): Promise<ListResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const all = this.rows
      .filter((r) => r.tenant_id === tenant_id)
      .filter((r) => filter.include_deleted || r.deleted_at === null)
      .filter((r) => !filter.channel || r.channel === filter.channel)
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize).map((r) => ({ ...r })),
      total: all.length,
      page,
      page_size: pageSize,
    };
  }

  async get(tenant_id: string, id: string): Promise<NotificationTemplate | null> {
    const r = this.rows.find((x) => x.tenant_id === tenant_id && x.template_id === id);
    return r ? { ...r } : null;
  }

  async create(
    tenant_id: string,
    input: ReturnType<typeof validateCreate>,
    actor: ActorContext,
    now: Date,
  ): Promise<NotificationTemplate> {
    // Mirror the DB UNIQUE (tenant_id, lower(name), locale) WHERE deleted_at IS NULL
    const dup = this.rows.find(
      (r) =>
        r.tenant_id === tenant_id &&
        r.deleted_at === null &&
        r.name.toLowerCase() === input.name.toLowerCase() &&
        r.locale === input.locale,
    );
    if (dup) {
      throw new NotificationTemplateError(
        409,
        'EWS_409_duplicate_template_name',
        `template name already used in this locale (id=${dup.template_id})`,
      );
    }
    const ts = now.toISOString();
    const row: NotificationTemplate = {
      template_id: randomUUID(),
      tenant_id,
      name: input.name,
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      locale: input.locale,
      status: 'DRAFT',
      created_by: actor.actor_id,
      updated_by: null,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async update(
    tenant_id: string,
    id: string,
    patch: UpdateNotificationTemplateInput,
    actor: ActorContext,
    now: Date,
  ): Promise<NotificationTemplate> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.template_id === id);
    if (idx < 0) {
      throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.deleted_at !== null) {
      throw new NotificationTemplateError(409, 'EWS_409_invalid_state', 'cannot update an archived template');
    }
    // Re-validate subject against the row's channel since channel is fixed.
    let nextSubject: string | null = old.subject;
    if (patch.subject !== undefined) {
      nextSubject = validateSubjectForChannel(patch.subject, old.channel);
    }
    const nextName = patch.name ?? old.name;
    const nextLocale = patch.locale ?? old.locale;
    // Re-check the unique constraint when name OR locale changes.
    if (
      nextName.toLowerCase() !== old.name.toLowerCase() ||
      nextLocale !== old.locale
    ) {
      const dup = this.rows.find(
        (r) =>
          r.tenant_id === tenant_id &&
          r.template_id !== id &&
          r.deleted_at === null &&
          r.name.toLowerCase() === nextName.toLowerCase() &&
          r.locale === nextLocale,
      );
      if (dup) {
        throw new NotificationTemplateError(
          409,
          'EWS_409_duplicate_template_name',
          `template name already used in this locale (id=${dup.template_id})`,
        );
      }
    }
    const ts = now.toISOString();
    const updated: NotificationTemplate = {
      ...old,
      name: nextName,
      subject: nextSubject,
      body: patch.body ?? old.body,
      locale: nextLocale,
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = updated;
    return { ...updated };
  }

  async activate(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<NotificationTemplate> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.template_id === id);
    if (idx < 0) {
      throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.deleted_at !== null || old.status === 'ARCHIVED') {
      throw new NotificationTemplateError(409, 'EWS_409_invalid_state', 'cannot activate an archived template');
    }
    if (old.status === 'ACTIVE') return { ...old }; // idempotent
    const ts = now.toISOString();
    const updated: NotificationTemplate = {
      ...old,
      status: 'ACTIVE',
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = updated;
    return { ...updated };
  }

  async archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<NotificationTemplate> {
    const idx = this.rows.findIndex((x) => x.tenant_id === tenant_id && x.template_id === id);
    if (idx < 0) {
      throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${id} not found`);
    }
    const old = this.rows[idx]!;
    if (old.deleted_at !== null) return { ...old }; // idempotent
    const ts = now.toISOString();
    const updated: NotificationTemplate = {
      ...old,
      status: 'ARCHIVED',
      deleted_at: ts,
      updated_by: actor.actor_id,
      updated_at: ts,
    };
    this.rows[idx] = updated;
    return { ...updated };
  }
}

// ─── PG-backed implementation ────────────────────────────────────────

interface PgRow {
  template_id: string;
  tenant_id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  locale: string;
  status: string;
  created_by: string;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

function rowToTemplate(r: PgRow): NotificationTemplate {
  return {
    template_id: String(r.template_id),
    tenant_id: String(r.tenant_id),
    name: String(r.name),
    channel: r.channel as NotificationChannel,
    subject: r.subject !== null ? String(r.subject) : null,
    body: String(r.body),
    locale: String(r.locale),
    status: r.status as NotificationTemplateStatus,
    created_by: String(r.created_by),
    updated_by: r.updated_by !== null ? String(r.updated_by) : null,
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
    deleted_at: r.deleted_at !== null ? (r.deleted_at as Date).toISOString() : null,
  };
}

export class PgNotificationTemplateStore implements NotificationTemplateStore {
  constructor(private readonly pool: Pool) {}

  async list(tenant_id: string, filter: ListFilter): Promise<ListResult> {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filter.page_size ?? 100));
    const where: string[] = ['tenant_id = $1'];
    const args: unknown[] = [tenant_id];
    if (!filter.include_deleted) where.push('deleted_at IS NULL');
    if (filter.channel) {
      args.push(filter.channel);
      where.push(`channel = $${args.length}`);
    }
    if (filter.status && filter.status.length > 0) {
      args.push(filter.status);
      where.push(`status = ANY($${args.length}::text[])`);
    }
    const whereSql = where.join(' AND ');
    const totalRes = await this.pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM app_admin.notification_templates WHERE ${whereSql}`,
      args,
    );
    const total = Number(totalRes.rows[0]?.c ?? 0);
    args.push(pageSize, (page - 1) * pageSize);
    const r = await this.pool.query<PgRow>(
      `SELECT * FROM app_admin.notification_templates
        WHERE ${whereSql}
        ORDER BY updated_at DESC
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return {
      items: r.rows.map(rowToTemplate),
      total,
      page,
      page_size: pageSize,
    };
  }

  async get(tenant_id: string, id: string): Promise<NotificationTemplate | null> {
    const r = await this.pool.query<PgRow>(
      `SELECT * FROM app_admin.notification_templates
        WHERE tenant_id = $1 AND template_id = $2`,
      [tenant_id, id],
    );
    return r.rows[0] ? rowToTemplate(r.rows[0]) : null;
  }

  async create(
    tenant_id: string,
    input: ReturnType<typeof validateCreate>,
    actor: ActorContext,
    now: Date,
  ): Promise<NotificationTemplate> {
    const id = randomUUID();
    const ts = now;
    try {
      const r = await this.pool.query<PgRow>(
        `INSERT INTO app_admin.notification_templates
           (template_id, tenant_id, name, channel, subject, body, locale,
            status, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8,$9,$9)
         RETURNING *`,
        [id, tenant_id, input.name, input.channel, input.subject, input.body, input.locale, actor.actor_id, ts],
      );
      return rowToTemplate(r.rows[0]!);
    } catch (e) {
      const err = e as { code?: string };
      if (err?.code === '23505') {
        throw new NotificationTemplateError(
          409,
          'EWS_409_duplicate_template_name',
          `template name already used in this locale`,
        );
      }
      throw e;
    }
  }

  async update(
    tenant_id: string,
    id: string,
    patch: UpdateNotificationTemplateInput,
    actor: ActorContext,
    now: Date,
  ): Promise<NotificationTemplate> {
    // Read first so we can re-validate subject against the row's channel
    // (channel is fixed; can't be patched). Also yields the 404 case.
    const existing = await this.get(tenant_id, id);
    if (!existing) {
      throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${id} not found`);
    }
    if (existing.deleted_at !== null) {
      throw new NotificationTemplateError(409, 'EWS_409_invalid_state', 'cannot update an archived template');
    }
    let nextSubject: string | null = existing.subject;
    if (patch.subject !== undefined) {
      // Re-use the channel-pairing check from the in-memory validator
      // by inlining the same rules — DB CHECK will catch it again at INSERT.
      if (existing.channel === 'SMS') {
        if (patch.subject !== null && patch.subject !== '') {
          throw new NotificationTemplateError(400, 'EWS_400_invalid_input', 'subject must be null for SMS channel');
        }
        nextSubject = null;
      } else {
        if (patch.subject === null || patch.subject === undefined) {
          throw new NotificationTemplateError(400, 'EWS_400_invalid_input', `subject required for ${existing.channel} channel`);
        }
        const t = patch.subject.trim();
        if (t.length < 1 || t.length > 200) {
          throw new NotificationTemplateError(400, 'EWS_400_invalid_input', 'subject length must be 1..200');
        }
        nextSubject = t;
      }
    }
    try {
      const r = await this.pool.query<PgRow>(
        `UPDATE app_admin.notification_templates
            SET name        = COALESCE($3, name),
                subject     = $4,
                body        = COALESCE($5, body),
                locale      = COALESCE($6, locale),
                updated_by  = $7,
                updated_at  = $8
          WHERE tenant_id = $1 AND template_id = $2
          RETURNING *`,
        [
          tenant_id, id,
          patch.name ?? null,
          nextSubject,
          patch.body ?? null,
          patch.locale ?? null,
          actor.actor_id, now,
        ],
      );
      if (!r.rows[0]) {
        throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${id} not found`);
      }
      return rowToTemplate(r.rows[0]);
    } catch (e) {
      if (e instanceof NotificationTemplateError) throw e;
      const err = e as { code?: string };
      if (err?.code === '23505') {
        throw new NotificationTemplateError(
          409,
          'EWS_409_duplicate_template_name',
          'template name already used in this locale',
        );
      }
      throw e;
    }
  }

  async activate(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<NotificationTemplate> {
    const existing = await this.get(tenant_id, id);
    if (!existing) {
      throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${id} not found`);
    }
    if (existing.deleted_at !== null || existing.status === 'ARCHIVED') {
      throw new NotificationTemplateError(409, 'EWS_409_invalid_state', 'cannot activate an archived template');
    }
    if (existing.status === 'ACTIVE') return existing; // idempotent — no DB write
    const r = await this.pool.query<PgRow>(
      `UPDATE app_admin.notification_templates
          SET status = 'ACTIVE', updated_by = $3, updated_at = $4
        WHERE tenant_id = $1 AND template_id = $2
        RETURNING *`,
      [tenant_id, id, actor.actor_id, now],
    );
    return rowToTemplate(r.rows[0]!);
  }

  async archive(tenant_id: string, id: string, actor: ActorContext, now: Date): Promise<NotificationTemplate> {
    const existing = await this.get(tenant_id, id);
    if (!existing) {
      throw new NotificationTemplateError(404, 'EWS_404_not_found', `notification template ${id} not found`);
    }
    if (existing.deleted_at !== null) return existing; // idempotent
    const r = await this.pool.query<PgRow>(
      `UPDATE app_admin.notification_templates
          SET status = 'ARCHIVED', deleted_at = $4, updated_by = $3, updated_at = $4
        WHERE tenant_id = $1 AND template_id = $2
        RETURNING *`,
      [tenant_id, id, actor.actor_id, now],
    );
    return rowToTemplate(r.rows[0]!);
  }
}

export async function makeNotificationTemplateStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: NotificationTemplateStore; pool: Pool | null }> {
  const url = env.ADMIN_PG_URL ?? env.BFF_PG_URL;
  if (!url) return { store: new InMemoryNotificationTemplateStore(), pool: null };
  const pool = new Pool({ connectionString: url, max: 4 });
  return { store: new PgNotificationTemplateStore(pool), pool };
}
