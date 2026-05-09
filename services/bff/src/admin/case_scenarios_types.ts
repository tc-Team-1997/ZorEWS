// services/bff/src/admin/case_scenarios_types.ts
//
// Domain types for the M14.15 case_scenarios + case_scenario_history +
// notification_templates + escalation_matrix tables introduced by
// data/schema/021_case_scenarios_and_admin_extensions.sql.
//
// Pure types — no IO. Stores + routes import from this file so Jest
// tests run without bringing up Postgres. Mirrors the DB CHECK enums
// 1:1 so a typo at the API boundary fails compilation, not at INSERT
// time.

// ─── Shared enums ─────────────────────────────────────────────────────

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

export const PRIORITIES: readonly Priority[] = ['P1', 'P2', 'P3', 'P4'] as const;

// ─── notification_templates ───────────────────────────────────────────

export type NotificationChannel = 'EMAIL' | 'SMS' | 'IN_APP';
export type NotificationTemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface NotificationTemplate {
  template_id: string;
  tenant_id: string;
  name: string;
  channel: NotificationChannel;
  /** NULL for SMS, NON-NULL for EMAIL/IN_APP — enforced by DB CHECK. */
  subject: string | null;
  body: string;
  /** BCP-47 (e.g. en-IN). */
  locale: string;
  status: NotificationTemplateStatus;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ─── escalation_matrix ────────────────────────────────────────────────

export type EscalationStatus = 'ACTIVE' | 'ARCHIVED';

/** Mirror of the canonical RBAC role list (infra/rbac/matrix.json).
 *  Re-exported from escalation_matrix_store.ts. */
export const ESCALATION_ROLES = [
  'admin',
  'risk_analyst',
  'supervisor',
  'collection_officer',
  'field_officer',
] as const;
export type EscalationRole = (typeof ESCALATION_ROLES)[number];

export interface EscalationMatrixRule {
  escalation_id: string;
  tenant_id: string;
  name: string;
  case_category: string;
  priority: Priority;
  level_1_after_minutes: number;
  level_1_role: EscalationRole;
  /** Both level_2 columns set together or both null — DB CHECK enforced. */
  level_2_after_minutes: number | null;
  level_2_role: EscalationRole | null;
  /** Both level_3 columns set together or both null AND level_2 set. */
  level_3_after_minutes: number | null;
  level_3_role: EscalationRole | null;
  status: EscalationStatus;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── case_scenarios ───────────────────────────────────────────────────

export type CaseScenarioStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface CaseScenarioChecklistItem {
  title: string;
  required: boolean;
}

export interface CaseScenario {
  scenario_id: string;
  tenant_id: string;
  name: string;
  case_category: string;
  priority: Priority;
  /** When set, scenario auto-applies on this indicator firing. */
  trigger_indicator_id: string | null;
  /** Threshold value paired with trigger_indicator_id (both or neither). */
  trigger_threshold: number | null;
  default_escalation_id: string;
  notification_template_id: string | null;
  checklist: CaseScenarioChecklistItem[];
  status: CaseScenarioStatus;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  /** Soft-delete — when set the row is hidden from listings. */
  deleted_at: string | null;
}

// ─── case_scenario_history (append-only) ──────────────────────────────

export type CaseScenarioHistoryAction =
  | 'create'
  | 'update'
  | 'activate'
  | 'archive'
  | 'restore';

export interface CaseScenarioHistoryEntry {
  history_id: number;
  scenario_id: string;
  tenant_id: string;
  action: CaseScenarioHistoryAction;
  /** RFC-6902 JSON Patch from before → after. */
  diff: Array<{ op: string; path: string; value?: unknown; from?: string }>;
  /** Full row snapshot for replay. */
  after_state: Record<string, unknown>;
  performed_by: string;
  performed_at: string;
}
