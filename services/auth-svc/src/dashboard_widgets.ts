// services/auth-svc/src/dashboard_widgets.ts
//
// Per-role dashboard widget configuration (T4.23, BAC-A §3.1.9.1.4).
// The SPA dashboard renders a fixed catalogue of widgets; admins use
// this store to hide irrelevant ones for collection_officer / field_officer
// + reorder priority. Empty config for a role = SPA falls back to the
// catalogue's `default_visible` flag (no row in the table is the same as
// "no override").
//
// Storage shape: one row per (role, widget_id). The PUT endpoint
// replaces all rows for a role atomically — simpler API than per-row
// PATCH and matches the "save layout" UX shape.

import type { Pool } from "pg";

export type Role =
  | "admin"
  | "risk_analyst"
  | "supervisor"
  | "collection_officer"
  | "field_officer";

export const ALL_ROLES: readonly Role[] = [
  "admin",
  "risk_analyst",
  "supervisor",
  "collection_officer",
  "field_officer",
];

export interface DashboardWidgetConfig {
  widget_id: string;
  sort_order: number;
  is_visible: boolean;
  updated_at: string;
  updated_by: string | null;
}

export interface ReplaceWidgetsInput {
  role: Role;
  widgets: Array<{
    widget_id: string;
    sort_order: number;
    is_visible: boolean;
  }>;
  updated_by: string;
}

export interface IDashboardWidgetsStore {
  init(): Promise<void>;
  /** Returns the configured widgets for the role, sorted by sort_order.
   *  Empty array means "no override" — caller falls back to defaults. */
  forRole(role: Role): DashboardWidgetConfig[];
  /** Atomically replace the role's full layout. Wipes any prior rows
   *  for the role and inserts the new ones. Returns the rows as stored
   *  (with updated_at set to now). */
  replaceForRole(input: ReplaceWidgetsInput): DashboardWidgetConfig[];
  /** Test-only — wipe everything. */
  reset(): Promise<void> | void;
}

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function validateInput(input: ReplaceWidgetsInput): void {
  if (!ALL_ROLES.includes(input.role)) {
    throw httpError(400, `role must be one of ${ALL_ROLES.join(",")}`);
  }
  if (!input.updated_by) {
    throw httpError(400, "updated_by is required");
  }
  // Reject duplicate widget_ids in the input. The schema PK enforces this
  // too, but failing fast in app-land gives a clearer error.
  const seen = new Set<string>();
  for (const w of input.widgets) {
    if (!w.widget_id) throw httpError(400, "widget_id is required");
    if (seen.has(w.widget_id)) {
      throw httpError(400, `duplicate widget_id "${w.widget_id}" in input`);
    }
    seen.add(w.widget_id);
  }
}

// ─── In-memory store ──────────────────────────────────────────────────

export class InMemoryDashboardWidgetsStore implements IDashboardWidgetsStore {
  private readonly byRole = new Map<Role, DashboardWidgetConfig[]>();

  async init(): Promise<void> {
    // no-op
  }

  forRole(role: Role): DashboardWidgetConfig[] {
    const list = this.byRole.get(role) ?? [];
    return [...list].sort((a, b) => a.sort_order - b.sort_order);
  }

  replaceForRole(input: ReplaceWidgetsInput): DashboardWidgetConfig[] {
    validateInput(input);
    const ts = new Date().toISOString();
    const rows: DashboardWidgetConfig[] = input.widgets.map((w) => ({
      widget_id: w.widget_id,
      sort_order: w.sort_order,
      is_visible: w.is_visible,
      updated_at: ts,
      updated_by: input.updated_by,
    }));
    this.byRole.set(input.role, rows);
    return [...rows].sort((a, b) => a.sort_order - b.sort_order);
  }

  reset(): void {
    this.byRole.clear();
  }
}

// ─── Pg-backed store ──────────────────────────────────────────────────

export class PgDashboardWidgetsStore implements IDashboardWidgetsStore {
  private readonly byRole = new Map<Role, DashboardWidgetConfig[]>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-dashboard-widgets] ${m}`, e ?? ""),
  ) {}

  async init(): Promise<void> {
    const rows = await this.pool.query<{
      role: string;
      widget_id: string;
      sort_order: number;
      is_visible: boolean;
      updated_at: Date;
      updated_by: string | null;
    }>(
      `SELECT role, widget_id, sort_order, is_visible, updated_at, updated_by
         FROM app_iam.role_dashboard_widgets
        ORDER BY role, sort_order`,
    );
    this.byRole.clear();
    for (const r of rows.rows) {
      const role = r.role as Role;
      const list = this.byRole.get(role) ?? [];
      list.push({
        widget_id: r.widget_id,
        sort_order: r.sort_order,
        is_visible: r.is_visible,
        updated_at: r.updated_at.toISOString(),
        updated_by: r.updated_by,
      });
      this.byRole.set(role, list);
    }
  }

  forRole(role: Role): DashboardWidgetConfig[] {
    const list = this.byRole.get(role) ?? [];
    return [...list].sort((a, b) => a.sort_order - b.sort_order);
  }

  replaceForRole(input: ReplaceWidgetsInput): DashboardWidgetConfig[] {
    validateInput(input);
    const ts = new Date().toISOString();
    const rows: DashboardWidgetConfig[] = input.widgets.map((w) => ({
      widget_id: w.widget_id,
      sort_order: w.sort_order,
      is_visible: w.is_visible,
      updated_at: ts,
      updated_by: input.updated_by,
    }));
    this.byRole.set(input.role, rows);
    // Replace-all happens in a transaction so we don't leave the role
    // half-configured if the second statement fails.
    void (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM app_iam.role_dashboard_widgets WHERE role = $1`,
          [input.role],
        );
        for (const w of input.widgets) {
          await client.query(
            `INSERT INTO app_iam.role_dashboard_widgets
                (role, widget_id, sort_order, is_visible, updated_at, updated_by)
              VALUES ($1, $2, $3, $4, $5, $6)`,
            [input.role, w.widget_id, w.sort_order, w.is_visible, new Date(ts), input.updated_by],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        this.logger(`failed to replace widgets for role ${input.role}`, err);
      } finally {
        client.release();
      }
    })();
    return [...rows].sort((a, b) => a.sort_order - b.sort_order);
  }

  async reset(): Promise<void> {
    await this.pool.query(`TRUNCATE app_iam.role_dashboard_widgets`);
    this.byRole.clear();
  }
}
