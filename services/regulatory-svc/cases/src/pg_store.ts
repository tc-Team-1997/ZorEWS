// services/regulatory-svc/cases/src/pg_store.ts
//
// Postgres-backed CaseStore. Same public surface as the in-memory CaseStore
// (store.ts) so service.ts doesn't care which backend is in use.
//
// Strategy (cribbed from T4.13 BFF webhooks + T4.14 auth-svc — see
// docs/database-gap-analysis.md "T4.13/T4.14 implementation notes"):
//   - cache-on-init   — load every row from app_cases.cases + .actions
//                       into in-memory Maps so reads stay synchronous
//   - sync reads      — get() / list() / getByAlert() never await pg
//   - write-through   — upsert() updates the cache + fires pg INSERT
//                       (or UPDATE for existing case) + per-action INSERT
//                       in the background (.catch logs the failure)
//
// Schema gotchas (worth knowing for callers):
//   - app_cases.cases.customer_name and rule_name are NOT NULL but the
//     in-memory Case only carries customer_id + rule_id. We fall back to
//     empty strings on insert; production would resolve via mart.customer_360
//     and the rules service before persisting.
//   - sla_status defaults to 'on_track' (or 'closed' when state='closed').
//   - actions are persisted as separate rows on every upsert; we INSERT
//     only the new ones (computed by diffing against the cached previous
//     action list) so we don't churn duplicates on every state transition.

import type { Pool } from 'pg';
import type {
  Action,
  Cap,
  CapStatus,
  CasDecision,
  CasRecord,
  Case,
  CaseState,
  CauseType,
  IssuePriority,
  ReviewStatus,
  SeverityAssessment,
} from './types';
import type { ListFilters } from './store';

export class PgCaseStore {
  private readonly cases = new Map<string, Case>();
  private readonly byAlert = new Map<string, string>();
  /** action_id -> case_id for O(1) "is this action already persisted" check.
   *  Populated on init() + every upsert. */
  private readonly persistedActions = new Set<string>();
  /** cas_id -> seen, for the same diff-on-upsert pattern as actions. */
  private readonly persistedCas = new Set<string>();
  /** cap_id -> seen. */
  private readonly persistedCaps = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: (msg: string, err?: unknown) => void = (m, e) =>
      console.warn(`[pg-case-store] ${m}`, e ?? ''),
  ) {}

  async init(): Promise<void> {
    const caseRows = await this.pool.query<{
      case_id: string;
      alert_id: string;
      customer_id: string;
      tenant_id: string;
      severity: string;
      rule_id: string;
      reason_summary: string | null;
      state: string;
      assignee: string | null;
      loan_id: string | null;
      outcome: string | null;
      created_at: Date;
      updated_at: Date;
      closed_at: Date | null;
    }>(
      `SELECT case_id, alert_id, customer_id, tenant_id, severity, rule_id,
              reason_summary, state, assignee, loan_id, outcome,
              created_at, updated_at, closed_at
         FROM app_cases.cases`,
    );

    const actionRows = await this.pool.query<{
      action_id: string;
      case_id: string;
      kind: string;
      officer_id: string;
      occurred_at: Date;
      outcome_note: string | null;
      gps_lat: string | null;
      gps_lng: string | null;
      gps_accuracy_m: string | null;
    }>(
      `SELECT action_id, case_id, kind, officer_id, occurred_at,
              outcome_note, gps_lat::text AS gps_lat,
              gps_lng::text AS gps_lng, gps_accuracy_m::text AS gps_accuracy_m
         FROM app_cases.actions
        ORDER BY case_id, occurred_at ASC`,
    );

    const actionsByCase = new Map<string, Action[]>();
    for (const r of actionRows.rows) {
      const action: Action = {
        action_id: r.action_id,
        ts: r.occurred_at.toISOString(),
        kind: r.kind as Action['kind'],
        officer_id: r.officer_id,
        outcome_note: r.outcome_note,
        gps:
          r.gps_lat !== null && r.gps_lng !== null
            ? {
                lat: Number(r.gps_lat),
                lng: Number(r.gps_lng),
                accuracy_m:
                  r.gps_accuracy_m !== null ? Number(r.gps_accuracy_m) : null,
              }
            : null,
      };
      const list = actionsByCase.get(r.case_id) ?? [];
      list.push(action);
      actionsByCase.set(r.case_id, list);
      this.persistedActions.add(r.action_id);
    }

    // Load CAS records (T4.19 — BAC-A manual §3.1.5).
    const casRows = await this.pool.query<{
      cas_id: string;
      case_id: string;
      cause_type: string;
      cause_summary: string;
      severity_assessment: string;
      decision: string;
      submitted_by: string;
      submitted_at: Date;
      reviewed_by: string | null;
      reviewed_at: Date | null;
      review_status: string;
      review_comments: string | null;
      attachments: unknown;
    }>(
      `SELECT cas_id, case_id, cause_type, cause_summary, severity_assessment,
              decision, submitted_by, submitted_at, reviewed_by, reviewed_at,
              review_status, review_comments, attachments
         FROM app_cases.cas_records
        ORDER BY case_id, submitted_at ASC`,
    );
    const casByCase = new Map<string, CasRecord[]>();
    for (const r of casRows.rows) {
      const cas: CasRecord = {
        cas_id: r.cas_id,
        case_id: r.case_id,
        cause_type: r.cause_type as CauseType,
        cause_summary: r.cause_summary,
        severity_assessment: r.severity_assessment as SeverityAssessment,
        decision: r.decision as CasDecision,
        submitted_by: r.submitted_by,
        submitted_at: r.submitted_at.toISOString(),
        reviewed_by: r.reviewed_by,
        reviewed_at: r.reviewed_at ? r.reviewed_at.toISOString() : null,
        review_status: r.review_status as ReviewStatus,
        review_comments: r.review_comments,
        attachments: Array.isArray(r.attachments) ? (r.attachments as CasRecord['attachments']) : [],
      };
      const list = casByCase.get(r.case_id) ?? [];
      list.push(cas);
      casByCase.set(r.case_id, list);
      this.persistedCas.add(r.cas_id);
    }

    // Load CAPs (T4.19 — BAC-A manual §3.1.5). target_completion_date
    // cast to text in the SELECT so we keep the literal 'YYYY-MM-DD' —
    // pg-node returns DATE columns as midnight local-time Dates, which
    // .toISOString() then shifts back a day in non-UTC timezones.
    const capRows = await this.pool.query<{
      cap_id: string;
      case_id: string;
      cap_item: string;
      issue_owner_group: string;
      issue_owner: string;
      issue_priority: string;
      target_completion_date: string;
      status: string;
      proposed_by: string;
      proposed_at: Date;
      approved_by: string | null;
      approved_at: Date | null;
      closed_at: Date | null;
      closure_comments: string | null;
      attachments: unknown;
    }>(
      `SELECT cap_id, case_id, cap_item, issue_owner_group, issue_owner,
              issue_priority, target_completion_date::text AS target_completion_date,
              status, proposed_by, proposed_at, approved_by, approved_at,
              closed_at, closure_comments, attachments
         FROM app_cases.caps
        ORDER BY case_id, proposed_at ASC`,
    );
    const capsByCase = new Map<string, Cap[]>();
    for (const r of capRows.rows) {
      const cap: Cap = {
        cap_id: r.cap_id,
        case_id: r.case_id,
        cap_item: r.cap_item,
        issue_owner_group: r.issue_owner_group,
        issue_owner: r.issue_owner,
        issue_priority: r.issue_priority as IssuePriority,
        // Cast-as-text in the SELECT keeps this as the literal 'YYYY-MM-DD'.
        target_completion_date: r.target_completion_date,
        status: r.status as CapStatus,
        proposed_by: r.proposed_by,
        proposed_at: r.proposed_at.toISOString(),
        approved_by: r.approved_by,
        approved_at: r.approved_at ? r.approved_at.toISOString() : null,
        closed_at: r.closed_at ? r.closed_at.toISOString() : null,
        closure_comments: r.closure_comments,
        attachments: Array.isArray(r.attachments) ? (r.attachments as Cap['attachments']) : [],
      };
      const list = capsByCase.get(r.case_id) ?? [];
      list.push(cap);
      capsByCase.set(r.case_id, list);
      this.persistedCaps.add(r.cap_id);
    }

    this.cases.clear();
    this.byAlert.clear();
    for (const r of caseRows.rows) {
      const c: Case = {
        case_id: r.case_id,
        tenant_id: r.tenant_id,
        alert_id: r.alert_id,
        customer_id: r.customer_id,
        loan_id: r.loan_id,
        severity: r.severity as Case['severity'],
        rule_id: r.rule_id,
        reason_summary: r.reason_summary,
        state: r.state as CaseState,
        assignee: r.assignee,
        outcome: r.outcome as Case['outcome'],
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
        closed_at: r.closed_at ? r.closed_at.toISOString() : null,
        actions: actionsByCase.get(r.case_id) ?? [],
        cas_records: casByCase.get(r.case_id) ?? [],
        caps: capsByCase.get(r.case_id) ?? [],
      };
      this.cases.set(c.case_id, c);
      this.byAlert.set(c.alert_id, c.case_id);
    }
  }

  upsert(c: Case): Case {
    const prior = this.cases.get(c.case_id);
    this.cases.set(c.case_id, c);
    this.byAlert.set(c.alert_id, c.case_id);

    const isNew = !prior;
    const slaStatus = c.state === 'closed' ? 'closed' : 'on_track';

    if (isNew) {
      void this.pool
        .query(
          `INSERT INTO app_cases.cases (
              case_id, alert_id, customer_id, customer_name, severity,
              rule_id, rule_name, state, assignee, loan_id, reason_summary,
              outcome, created_at, updated_at, closed_at, sla_status, tenant_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (case_id) DO NOTHING`,
          [
            c.case_id,
            c.alert_id,
            c.customer_id,
            // customer_name + rule_name are NOT NULL in the schema but the
            // in-memory Case doesn't carry them. Empty string is the cheapest
            // honest answer; production would resolve via mart.customer_360.
            '',
            c.severity,
            c.rule_id,
            '',
            c.state,
            c.assignee,
            c.loan_id,
            c.reason_summary,
            c.outcome,
            new Date(c.created_at),
            new Date(c.updated_at),
            c.closed_at ? new Date(c.closed_at) : null,
            slaStatus,
            c.tenant_id,
          ],
        )
        .catch((err) => this.logger(`failed to insert case ${c.case_id}`, err));
    } else {
      void this.pool
        .query(
          `UPDATE app_cases.cases
              SET state = $2,
                  assignee = $3,
                  outcome = $4,
                  updated_at = $5,
                  closed_at = $6,
                  sla_status = $7,
                  reason_summary = $8
            WHERE case_id = $1`,
          [
            c.case_id,
            c.state,
            c.assignee,
            c.outcome,
            new Date(c.updated_at),
            c.closed_at ? new Date(c.closed_at) : null,
            slaStatus,
            c.reason_summary,
          ],
        )
        .catch((err) => this.logger(`failed to update case ${c.case_id}`, err));
    }

    // Persist only newly-added actions. The state machine appends to
    // `actions` on logAction() — earlier transitions don't touch it.
    for (const action of c.actions) {
      if (this.persistedActions.has(action.action_id)) continue;
      this.persistedActions.add(action.action_id);
      void this.pool
        .query(
          `INSERT INTO app_cases.actions (
              action_id, case_id, kind, officer_id, occurred_at,
              outcome_note, gps_lat, gps_lng, gps_accuracy_m
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (action_id) DO NOTHING`,
          [
            action.action_id,
            c.case_id,
            action.kind,
            action.officer_id,
            new Date(action.ts),
            action.outcome_note,
            action.gps?.lat ?? null,
            action.gps?.lng ?? null,
            action.gps?.accuracy_m ?? null,
          ],
        )
        .catch((err) =>
          this.logger(`failed to insert action ${action.action_id}`, err),
        );
    }

    // Persist CAS records (T4.19). New ones get INSERTed; review state
    // changes (reviewed_by / reviewed_at / review_status / review_comments)
    // get UPDATEd. We always issue UPDATE for existing rows since they
    // mutate over their lifecycle (pending → approved/rework/rejected) —
    // append-only diff like actions doesn't fit.
    for (const cas of c.cas_records ?? []) {
      const isNew = !this.persistedCas.has(cas.cas_id);
      if (isNew) {
        this.persistedCas.add(cas.cas_id);
        void this.pool
          .query(
            `INSERT INTO app_cases.cas_records (
                cas_id, case_id, cause_type, cause_summary, severity_assessment,
                decision, submitted_by, submitted_at, reviewed_by, reviewed_at,
                review_status, review_comments, attachments
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
             ON CONFLICT (cas_id) DO NOTHING`,
            [
              cas.cas_id,
              c.case_id,
              cas.cause_type,
              cas.cause_summary,
              cas.severity_assessment,
              cas.decision,
              cas.submitted_by,
              new Date(cas.submitted_at),
              cas.reviewed_by,
              cas.reviewed_at ? new Date(cas.reviewed_at) : null,
              cas.review_status,
              cas.review_comments,
              JSON.stringify(cas.attachments ?? []),
            ],
          )
          .catch((err) => this.logger(`failed to insert cas ${cas.cas_id}`, err));
      } else {
        // Existing row — only the review fields can change (reviewCas()).
        void this.pool
          .query(
            `UPDATE app_cases.cas_records
                SET reviewed_by = $2,
                    reviewed_at = $3,
                    review_status = $4,
                    review_comments = $5
              WHERE cas_id = $1`,
            [
              cas.cas_id,
              cas.reviewed_by,
              cas.reviewed_at ? new Date(cas.reviewed_at) : null,
              cas.review_status,
              cas.review_comments,
            ],
          )
          .catch((err) => this.logger(`failed to update cas ${cas.cas_id}`, err));
      }
    }

    // Persist CAPs (T4.19). New CAPs get INSERTed; status transitions
    // (open → in_progress → closed/overdue) get UPDATEd.
    for (const cap of c.caps ?? []) {
      const isNew = !this.persistedCaps.has(cap.cap_id);
      if (isNew) {
        this.persistedCaps.add(cap.cap_id);
        void this.pool
          .query(
            `INSERT INTO app_cases.caps (
                cap_id, case_id, cap_item, issue_owner_group, issue_owner,
                issue_priority, target_completion_date, status, proposed_by,
                proposed_at, approved_by, approved_at, closed_at,
                closure_comments, attachments
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
             ON CONFLICT (cap_id) DO NOTHING`,
            [
              cap.cap_id,
              c.case_id,
              cap.cap_item,
              cap.issue_owner_group,
              cap.issue_owner,
              cap.issue_priority,
              cap.target_completion_date,
              cap.status,
              cap.proposed_by,
              new Date(cap.proposed_at),
              cap.approved_by,
              cap.approved_at ? new Date(cap.approved_at) : null,
              cap.closed_at ? new Date(cap.closed_at) : null,
              cap.closure_comments,
              JSON.stringify(cap.attachments ?? []),
            ],
          )
          .catch((err) => this.logger(`failed to insert cap ${cap.cap_id}`, err));
      } else {
        void this.pool
          .query(
            `UPDATE app_cases.caps
                SET status = $2,
                    approved_by = $3,
                    approved_at = $4,
                    closed_at = $5,
                    closure_comments = $6
              WHERE cap_id = $1`,
            [
              cap.cap_id,
              cap.status,
              cap.approved_by,
              cap.approved_at ? new Date(cap.approved_at) : null,
              cap.closed_at ? new Date(cap.closed_at) : null,
              cap.closure_comments,
            ],
          )
          .catch((err) => this.logger(`failed to update cap ${cap.cap_id}`, err));
      }
    }
    return c;
  }

  get(caseId: string, tenant_id: string = 'BANK_DEMO'): Case | undefined {
    const c = this.cases.get(caseId);
    const t = c?.tenant_id ?? 'BANK_DEMO';
    return c && t === tenant_id ? c : undefined;
  }

  getByAlert(alertId: string, tenant_id: string = 'BANK_DEMO'): Case | undefined {
    const caseId = this.byAlert.get(alertId);
    if (!caseId) return undefined;
    const c = this.cases.get(caseId);
    const t = c?.tenant_id ?? 'BANK_DEMO';
    return c && t === tenant_id ? c : undefined;
  }

  list(f: ListFilters = {}): {
    items: Case[];
    total: number;
    page: number;
    pageSize: number;
  } {
    const tenant_id = f.tenant_id ?? 'BANK_DEMO';
    const all = [...this.cases.values()].filter((c) => {
      if ((c.tenant_id ?? 'BANK_DEMO') !== tenant_id) return false;
      if (f.state && c.state !== f.state) return false;
      if (f.assignee && c.assignee !== f.assignee) return false;
      if (f.customer_id && c.customer_id !== f.customer_id) return false;
      return true;
    });
    all.sort((a, b) =>
      a.updated_at === b.updated_at
        ? a.case_id.localeCompare(b.case_id)
        : a.updated_at < b.updated_at
          ? 1
          : -1,
    );
    const page = Math.max(1, f.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize),
      total: all.length,
      page,
      pageSize,
    };
  }

  /** Truncate all 4 case tables — used by integration tests only.
   *  CASCADE means truncating `cases` cleans the child tables too, but
   *  we list them all for clarity + index-reset symmetry. */
  async reset(): Promise<void> {
    await this.pool.query(
      `TRUNCATE app_cases.caps, app_cases.cas_records, app_cases.actions, app_cases.cases RESTART IDENTITY CASCADE`,
    );
    this.cases.clear();
    this.byAlert.clear();
    this.persistedActions.clear();
    this.persistedCas.clear();
    this.persistedCaps.clear();
  }
}
