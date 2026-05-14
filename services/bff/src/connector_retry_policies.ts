// services/bff/src/connector_retry_policies.ts
//
// T6 M3.10 — Connector retry policy catalog.
//
// M3.1 ships the 10-connector registry; M3.5 ships run analytics;
// M3.6 ships failure clustering. M3.10 surfaces the hand-calibrated
// retry policy each connector type follows: max_retries,
// backoff_strategy, initial + max backoff seconds, retryable error
// codes. Lets the SPA's "retry transparency" panel render
// connector-specific recovery posture next to the M3.6 failure
// pattern report.
//
// Pure — hand-calibrated static metadata keyed off connector type
// (the policy is type-driven, not per-id: kafka_stream connectors
// share the same retry curve, etc).

import { SEED_CONNECTORS, type ConnectorDef } from './ingestion';

// ─── Public types ─────────────────────────────────────────────────────

export type BackoffStrategy = 'linear' | 'exponential' | 'none';

export interface ConnectorRetryPolicy {
  connector_id: string;
  name: string;
  type: ConnectorDef['type'];
  max_retries: number;
  backoff_strategy: BackoffStrategy;
  initial_backoff_seconds: number;
  max_backoff_seconds: number;
  /** Error codes the policy will RETRY on. Other codes terminate
   *  the attempt immediately. */
  retryable_error_codes: string[];
  /** Whether the connector emits a dead-letter on terminal failure
   *  (vs silently dropping the message). */
  dead_letter_enabled: boolean;
}

export interface ConnectorRetryCatalog {
  total_connectors: number;
  policies: ConnectorRetryPolicy[];
}

// ─── Static policy table — keyed by connector type ───────────────────

const POLICY_BY_TYPE: Record<
  ConnectorDef['type'],
  Omit<ConnectorRetryPolicy, 'connector_id' | 'name' | 'type'>
> = {
  kafka_stream: {
    max_retries: 5,
    backoff_strategy: 'exponential',
    initial_backoff_seconds: 1,
    max_backoff_seconds: 60,
    retryable_error_codes: ['broker_unavailable', 'timeout', 'leader_election_in_progress'],
    dead_letter_enabled: true,
  },
  sftp_drop: {
    max_retries: 3,
    backoff_strategy: 'exponential',
    initial_backoff_seconds: 30,
    max_backoff_seconds: 600,
    retryable_error_codes: ['connection_reset', 'timeout', 'auth_temp_failure'],
    dead_letter_enabled: false,
  },
  batch_csv: {
    max_retries: 2,
    backoff_strategy: 'linear',
    initial_backoff_seconds: 60,
    max_backoff_seconds: 120,
    retryable_error_codes: ['file_locked', 'transient_io_error'],
    dead_letter_enabled: false,
  },
  rest_api: {
    max_retries: 4,
    backoff_strategy: 'exponential',
    initial_backoff_seconds: 2,
    max_backoff_seconds: 120,
    retryable_error_codes: ['429_rate_limit', '503_service_unavailable', 'connection_reset', 'timeout'],
    dead_letter_enabled: true,
  },
  soap_api: {
    max_retries: 3,
    backoff_strategy: 'exponential',
    initial_backoff_seconds: 5,
    max_backoff_seconds: 180,
    retryable_error_codes: ['soap_fault_temporary', 'timeout', '503_service_unavailable'],
    dead_letter_enabled: true,
  },
};

// ─── Pure accessors ──────────────────────────────────────────────────

export function getConnectorRetryPolicy(connector_id: string): ConnectorRetryPolicy | null {
  const def = SEED_CONNECTORS.find((c) => c.id === connector_id);
  if (!def) return null;
  const policy = POLICY_BY_TYPE[def.type];
  return {
    connector_id: def.id,
    name: def.name,
    type: def.type,
    ...policy,
    retryable_error_codes: [...policy.retryable_error_codes],
  };
}

export function listConnectorRetryPolicies(): ConnectorRetryCatalog {
  const policies = SEED_CONNECTORS.map((def) => ({
    connector_id: def.id,
    name: def.name,
    type: def.type,
    ...POLICY_BY_TYPE[def.type],
    retryable_error_codes: [...POLICY_BY_TYPE[def.type].retryable_error_codes],
  }));
  policies.sort((a, b) => (a.connector_id < b.connector_id ? -1 : a.connector_id > b.connector_id ? 1 : 0));
  return {
    total_connectors: policies.length,
    policies,
  };
}
