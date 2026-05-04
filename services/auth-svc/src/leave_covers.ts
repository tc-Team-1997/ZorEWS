// services/auth-svc/src/leave_covers.ts
//
// Leave-cover delegations (T4.22, BAC-A manual §3.1.9.1.3). A user
// "assigns his/her tasks for a time period to another user". The SPA
// assignment dropdowns query `activeCoverFor(user_id, today)` to
// auto-route work to the coverer; case-side routing is intentionally
// kept out (same SPA-layer-validation design choice as T4.21 teams —
// see docs/bac-a-manual-gap-analysis.md).
//
// Date semantics
// --------------
// `start_date` and `end_date` are calendar dates (YYYY-MM-DD), inclusive
// on both ends. "Active today" means start_date <= today <= end_date AND
// cancelled_at IS NULL. We deliberately don't carry hours/minutes — leave
// is a day-grained concept in the bank's HR sense.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface LeaveCover {
  cover_id: string;
  applicant_user: string;
  leave_coverer: string;
  role: string;
  start_date: string;     // 'YYYY-MM-DD'
  end_date: string;       // 'YYYY-MM-DD'
  in_office: boolean;
  comments: string | null;
  created_at: string;
  cancelled_at: string | null;
}

export interface CreateLeaveCoverInput {
  applicant_user: string;
  leave_coverer: string;
  role: string;
  start_date: string;     // 'YYYY-MM-DD'
  end_date: string;       // 'YYYY-MM-DD'
  in_office?: boolean;
  comments?: string | null;
}

export interface ListFilters {
  applicant_user?: string;
  leave_coverer?: string;
  /** When set, only return covers active on this date (inclusive of
   *  start + end). 'YYYY-MM-DD'. */
  active_on?: string;
  /** When true (default), only return rows where cancelled_at IS NULL. */
  active_only?: boolean;
}

export interface ILeaveCoverStore {
  init(): Promise<void>;
  list(filters?: ListFilters): LeaveCover[];
  get(cover_id: string): LeaveCover | undefined;
  create(input: CreateLeaveCoverInput): LeaveCover;
  cancel(cover_id: string): boolean;
  /**
   * Returns the active cover for `user_id` on the given date, or
   * undefined if none is active. The "active" predicate is:
   *   start_date <= date <= end_date AND cancelled_at IS NULL.
   * If multiple covers overlap (shouldn't happen but the schema doesn't
   * prevent it), the most-recently-created one wins.
   */
  activeCoverFor(user_id: string, date: string): LeaveCover | undefined;
  /** Test-only — wipe everything. */
  reset(): Promise<void> | void;
}

function newCoverId(): string {
  return `lc_${randomUUID().slice(0, 8)}`;
}

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateInput(input: CreateLeaveCoverInput): void {
  if (!input.applicant_user) throw httpError(400, "applicant_user is required");
  if (!input.leave_coverer) throw httpError(400, "leave_coverer is required");
  if (input.applicant_user === input.leave_coverer) {
    throw httpError(400, "leave_coverer must differ from applicant_user");
  }
  if (!input.role) throw httpError(400, "role is required");
  if (!ISO_DATE.test(input.start_date)) {
    throw httpError(400, "start_date must be YYYY-MM-DD");
  }
  if (!ISO_DATE.test(input.end_date)) {
    throw httpError(400, "end_date must be YYYY-MM-DD");
  }
  if (input.end_date < input.start_date) {
    throw httpError(400, "end_date must be >= start_date");
  }
}

// ─── In-memory store ───────────────────────────────────────────────────

export class InMemoryLeaveCoverStore implements ILeaveCoverStore {
  private readonly byId = new Map<string, LeaveCover>();

  async init(): Promise<void> {
    // no-op
  }

  list(filters: ListFilters = {}): LeaveCover[] {
    const activeOnly = filters.active_only !== false;
    return Array.from(this.byId.values())
      .filter((c) => {
        if (activeOnly && c.cancelled_at) return false;
        if (filters.applicant_user && c.applicant_user !== filters.applicant_user) return false;
        if (filters.leave_coverer && c.leave_coverer !== filters.leave_coverer) return false;
        if (filters.active_on) {
          if (filters.active_on < c.start_date || filters.active_on > c.end_date) return false;
        }
        return true;
      })
      .sort((a, b) =>
        a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0,
      );
  }

  get(cover_id: string): LeaveCover | undefined {
    return this.byId.get(cover_id);
  }

  create(input: CreateLeaveCoverInput): LeaveCover {
    validateInput(input);
    const cover: LeaveCover = {
      cover_id: newCoverId(),
      applicant_user: input.applicant_user,
      leave_coverer: input.leave_coverer,
      role: input.role,
      start_date: input.start_date,
      end_date: input.end_date,
      in_office: input.in_office ?? false,
      comments: input.comments ?? null,
      created_at: new Date().toISOString(),
      cancelled_at: null,
    };
    this.byId.set(cover.cover_id, cover);
    return cover;
  }

  cancel(cover_id: string): boolean {
    const cover = this.byId.get(cover_id);
    if (!cover || cover.cancelled_at) return false;
    cover.cancelled_at = new Date().toISOString();
    return true;
  }

  activeCoverFor(user_id: string, date: string): LeaveCover | undefined {
    if (!ISO_DATE.test(date)) throw httpError(400, "date must be YYYY-MM-DD");
    const candidates = Array.from(this.byId.values()).filter(
      (c) =>
        c.applicant_user === user_id &&
        !c.cancelled_at &&
        c.start_date <= date &&
        date <= c.end_date,
    );
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return candidates[0];
  }

  reset(): void {
    this.byId.clear();
  }
}

// ─── Pg-backed store ───────────────────────────────────────────────────

export class PgLeaveCoverStore implements ILeaveCoverStore {
  private readonly byId = new Map<string, LeaveCover>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-leave-cover-store] ${m}`, e ?? ""),
  ) {}

  async init(): Promise<void> {
    // start_date / end_date cast to text to dodge the pg-node DATE
    // timezone issue (same trick T4.19 used for caps.target_completion_date).
    const rows = await this.pool.query<{
      cover_id: string;
      applicant_user: string;
      leave_coverer: string;
      role: string;
      start_date: string;
      end_date: string;
      in_office: boolean;
      comments: string | null;
      created_at: Date;
      cancelled_at: Date | null;
    }>(
      `SELECT cover_id, applicant_user, leave_coverer, role,
              start_date::text AS start_date,
              end_date::text   AS end_date,
              in_office, comments, created_at, cancelled_at
         FROM app_iam.leave_covers`,
    );
    this.byId.clear();
    for (const r of rows.rows) {
      this.byId.set(r.cover_id, {
        cover_id: r.cover_id,
        applicant_user: r.applicant_user,
        leave_coverer: r.leave_coverer,
        role: r.role,
        start_date: r.start_date,
        end_date: r.end_date,
        in_office: r.in_office,
        comments: r.comments,
        created_at: r.created_at.toISOString(),
        cancelled_at: r.cancelled_at ? r.cancelled_at.toISOString() : null,
      });
    }
  }

  list(filters: ListFilters = {}): LeaveCover[] {
    const activeOnly = filters.active_only !== false;
    return Array.from(this.byId.values())
      .filter((c) => {
        if (activeOnly && c.cancelled_at) return false;
        if (filters.applicant_user && c.applicant_user !== filters.applicant_user) return false;
        if (filters.leave_coverer && c.leave_coverer !== filters.leave_coverer) return false;
        if (filters.active_on) {
          if (filters.active_on < c.start_date || filters.active_on > c.end_date) return false;
        }
        return true;
      })
      .sort((a, b) =>
        a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0,
      );
  }

  get(cover_id: string): LeaveCover | undefined {
    return this.byId.get(cover_id);
  }

  create(input: CreateLeaveCoverInput): LeaveCover {
    validateInput(input);
    const cover: LeaveCover = {
      cover_id: newCoverId(),
      applicant_user: input.applicant_user,
      leave_coverer: input.leave_coverer,
      role: input.role,
      start_date: input.start_date,
      end_date: input.end_date,
      in_office: input.in_office ?? false,
      comments: input.comments ?? null,
      created_at: new Date().toISOString(),
      cancelled_at: null,
    };
    this.byId.set(cover.cover_id, cover);
    void this.pool
      .query(
        `INSERT INTO app_iam.leave_covers (
            cover_id, applicant_user, leave_coverer, role,
            start_date, end_date, in_office, comments, created_at
         ) VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9)`,
        [
          cover.cover_id,
          cover.applicant_user,
          cover.leave_coverer,
          cover.role,
          cover.start_date,
          cover.end_date,
          cover.in_office,
          cover.comments,
          new Date(cover.created_at),
        ],
      )
      .catch((err) => this.logger(`failed to insert leave cover ${cover.cover_id}`, err));
    return cover;
  }

  cancel(cover_id: string): boolean {
    const cover = this.byId.get(cover_id);
    if (!cover || cover.cancelled_at) return false;
    const ts = new Date().toISOString();
    cover.cancelled_at = ts;
    void this.pool
      .query(
        `UPDATE app_iam.leave_covers SET cancelled_at = $2 WHERE cover_id = $1`,
        [cover_id, new Date(ts)],
      )
      .catch((err) => this.logger(`failed to cancel leave cover ${cover_id}`, err));
    return true;
  }

  activeCoverFor(user_id: string, date: string): LeaveCover | undefined {
    if (!ISO_DATE.test(date)) throw httpError(400, "date must be YYYY-MM-DD");
    const candidates = Array.from(this.byId.values()).filter(
      (c) =>
        c.applicant_user === user_id &&
        !c.cancelled_at &&
        c.start_date <= date &&
        date <= c.end_date,
    );
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return candidates[0];
  }

  async reset(): Promise<void> {
    await this.pool.query(`TRUNCATE app_iam.leave_covers`);
    this.byId.clear();
  }
}
