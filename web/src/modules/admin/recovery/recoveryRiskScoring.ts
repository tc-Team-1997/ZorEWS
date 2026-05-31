// web/src/modules/admin/recovery/recoveryRiskScoring.ts
//
// Enterprise Recovery Management Center — risk-scoring resolver (pure).
//
// Composes a recovery request shape into a 4-level risk verdict so the
// maker-checker queue can prioritise approvals. Mirror of M9.3 case_maker_checker
// + M7.2 ai_model_promotion + M16.1 security_activity_center pattern.
//
// Factors:
//   • PII payload                  (payload has name / email / phone / dob ⇒ +2)
//   • Bulk action                  (action_type startswith 'recovery.bulk_'  ⇒ +1)
//   • Purge action                 (action_type endswith 'purge'/'anonymize' ⇒ +2)
//   • Recent deletion              (record was deleted < 7 days ago         ⇒ +1)
//   • High-value entity            (entity_type ∈ tenants/customers/cases   ⇒ +2)
//
// Pure — no fetch, no store. Caller passes the recovery record + action type.

export type RecoveryRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const ALL_RECOVERY_RISK_LEVELS: readonly RecoveryRiskLevel[] = [
  'low', 'medium', 'high', 'critical',
] as const;

export type RecoveryActionType =
  | 'recovery.restore'
  | 'recovery.bulk_restore'
  | 'recovery.purge'
  | 'recovery.bulk_purge'
  | 'recovery.anonymize';

export const ALL_RECOVERY_ACTION_TYPES: readonly RecoveryActionType[] = [
  'recovery.restore',
  'recovery.bulk_restore',
  'recovery.purge',
  'recovery.bulk_purge',
  'recovery.anonymize',
] as const;

export interface RecoveryRiskFactor {
  id: 'pii_payload' | 'bulk_action' | 'purge_action' | 'recent_deletion' | 'high_value_entity';
  label: string;
  weight: number;
  triggered: boolean;
  detail: string;
}

export interface RecoveryRiskInput {
  /** action_type the maker is submitting. */
  action_type: RecoveryActionType;
  /** entity_type from the soft-deleted record (e.g. 'user', 'tenant', 'case'). */
  entity_type: string;
  /** ISO-8601 timestamp of the original soft-delete. */
  deleted_at: string;
  /** Raw payload from the deleted_records row — used to detect PII. */
  payload?: Record<string, unknown>;
  /** Bulk size (1 for single-record actions). */
  record_count?: number;
}

export interface RecoveryRiskScore {
  action_type: RecoveryActionType;
  entity_type: string;
  total_score: number;
  level: RecoveryRiskLevel;
  factors: RecoveryRiskFactor[];
  record_count: number;
  /** Hours since the record was originally deleted. */
  age_hours: number;
}

const PII_KEYS = new Set([
  'name', 'full_name', 'email', 'phone', 'mobile', 'dob', 'date_of_birth',
  'pan', 'aadhaar', 'ssn', 'address', 'national_id', 'passport',
]);

const HIGH_VALUE_ENTITIES = new Set([
  'tenant', 'customer', 'case', 'investigation', 'user', 'rule',
]);

const RECENT_DELETION_HOURS = 7 * 24; // 7 days
const HIGH_VALUE_WEIGHT = 2;
const PII_WEIGHT = 2;
const PURGE_WEIGHT = 2;
const BULK_WEIGHT = 1;
const RECENT_WEIGHT = 1;

/** Bucket boundaries match M8.16 / M7.15 / Security Activity Center pattern. */
function bucketScore(score: number): RecoveryRiskLevel {
  if (score >= 6) return 'critical';
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function detectPii(payload: Record<string, unknown> | undefined): string[] {
  if (!payload || typeof payload !== 'object') return [];
  return Object.keys(payload).filter((k) => PII_KEYS.has(k.toLowerCase()));
}

export function scoreRecoveryRequest(input: RecoveryRiskInput, now: Date = new Date()): RecoveryRiskScore {
  const piiKeys = detectPii(input.payload);
  const recordCount = input.record_count ?? 1;
  const isBulk = input.action_type.startsWith('recovery.bulk_') || recordCount > 1;
  const isPurge = input.action_type === 'recovery.purge'
    || input.action_type === 'recovery.bulk_purge'
    || input.action_type === 'recovery.anonymize';
  const isHighValue = HIGH_VALUE_ENTITIES.has(input.entity_type);

  const deletedAt = new Date(input.deleted_at).getTime();
  const ageHours = Number.isFinite(deletedAt)
    ? Math.max(0, (now.getTime() - deletedAt) / 3_600_000)
    : 0;
  const isRecent = ageHours < RECENT_DELETION_HOURS;

  const factors: RecoveryRiskFactor[] = [
    {
      id: 'pii_payload',
      label: 'PII in payload',
      weight: PII_WEIGHT,
      triggered: piiKeys.length > 0,
      detail: piiKeys.length > 0
        ? `${piiKeys.length} PII field${piiKeys.length === 1 ? '' : 's'} detected: ${piiKeys.slice(0, 3).join(', ')}`
        : 'No PII fields detected in payload',
    },
    {
      id: 'bulk_action',
      label: 'Bulk action',
      weight: BULK_WEIGHT,
      triggered: isBulk,
      detail: isBulk ? `${recordCount} records in single action` : 'Single record',
    },
    {
      id: 'purge_action',
      label: 'Irreversible purge / anonymize',
      weight: PURGE_WEIGHT,
      triggered: isPurge,
      detail: isPurge
        ? `Action ${input.action_type} cannot be undone`
        : 'Restore is reversible',
    },
    {
      id: 'recent_deletion',
      label: 'Recent deletion',
      weight: RECENT_WEIGHT,
      triggered: isRecent,
      detail: isRecent
        ? `Deleted ${Math.round(ageHours)}h ago — within 7-day window`
        : `Deleted ${Math.round(ageHours / 24)}d ago — beyond recent window`,
    },
    {
      id: 'high_value_entity',
      label: 'High-value entity type',
      weight: HIGH_VALUE_WEIGHT,
      triggered: isHighValue,
      detail: isHighValue
        ? `entity_type=${input.entity_type} is a privileged / regulated resource`
        : `entity_type=${input.entity_type}`,
    },
  ];

  const total_score = factors.reduce((acc, f) => acc + (f.triggered ? f.weight : 0), 0);

  return {
    action_type: input.action_type,
    entity_type: input.entity_type,
    total_score,
    level: bucketScore(total_score),
    factors,
    record_count: recordCount,
    age_hours: Math.round(ageHours * 100) / 100,
  };
}

export const RECOVERY_RISK_THRESHOLDS = {
  RECENT_DELETION_HOURS,
  PII_WEIGHT,
  BULK_WEIGHT,
  PURGE_WEIGHT,
  RECENT_WEIGHT,
  HIGH_VALUE_WEIGHT,
} as const;
