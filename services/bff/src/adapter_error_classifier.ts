// services/bff/src/adapter_error_classifier.ts
//
// T6 M14.34 — Adapter error classification.
//
// For each of the 8 BIL adapters, classify potential error types
// and their likelihood using deterministic PRNG per (tenant, adapter_id).
// Error types: timeout, auth_failure, data_format, unavailable.
// Envelope: adapters[] sorted by overall_risk_score desc.

import { listFleetAdapters, type AdapterId } from './adapter_health';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

type ErrorType = 'timeout' | 'auth_failure' | 'data_format' | 'unavailable';
type ErrorSeverity = 'low' | 'medium' | 'high';

export interface AdapterErrorClass {
  type: ErrorType;
  probability: number;
  severity: ErrorSeverity;
  mitigation: string;
}

export interface AdapterErrorProfile {
  adapter_id: AdapterId;
  label: string;
  error_classes: AdapterErrorClass[];
  overall_risk_score: number; // sum of probabilities * 100, capped at 100
}

export interface AdapterErrorClassificationResult {
  tenant_id: string;
  generated_at: string;
  adapters: AdapterErrorProfile[];
  highest_risk_adapter: AdapterId | null;
  avg_risk_score: number;
}

const ERROR_MITIGATIONS: Record<ErrorType, string> = {
  timeout: 'Retry with exponential back-off; check upstream SLA',
  auth_failure: 'Rotate credentials; verify token expiry',
  data_format: 'Validate schema before processing; add defensive parsing',
  unavailable: 'Check upstream health endpoint; activate fallback adapter',
};

const ERROR_SEVERITY: Record<ErrorType, ErrorSeverity> = {
  timeout: 'medium',
  auth_failure: 'high',
  data_format: 'low',
  unavailable: 'high',
};

function severityOf(prob: number): ErrorSeverity {
  if (prob >= 0.10) return 'high';
  if (prob >= 0.05) return 'medium';
  return 'low';
}

export function buildAdapterErrorClassification(
  tenant_id: string,
  now: Date,
): AdapterErrorClassificationResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const fleet = listFleetAdapters();
  const profiles: AdapterErrorProfile[] = [];

  for (const adapter of fleet) {
    const seed = fnv1a(`${tenant_id}|${adapter.adapter_id}|error`);
    const rand = mulberry32(seed);

    const timeout_prob = Math.round(rand() * 0.15 * 1000) / 1000;
    const auth_prob = Math.round(rand() * 0.05 * 1000) / 1000;
    const format_prob = Math.round(rand() * 0.10 * 1000) / 1000;
    const unavail_prob = Math.round(rand() * 0.08 * 1000) / 1000;

    const error_classes: AdapterErrorClass[] = [
      {
        type: 'timeout',
        probability: timeout_prob,
        severity: severityOf(timeout_prob),
        mitigation: ERROR_MITIGATIONS.timeout,
      },
      {
        type: 'auth_failure',
        probability: auth_prob,
        severity: severityOf(auth_prob),
        mitigation: ERROR_MITIGATIONS.auth_failure,
      },
      {
        type: 'data_format',
        probability: format_prob,
        severity: severityOf(format_prob),
        mitigation: ERROR_MITIGATIONS.data_format,
      },
      {
        type: 'unavailable',
        probability: unavail_prob,
        severity: severityOf(unavail_prob),
        mitigation: ERROR_MITIGATIONS.unavailable,
      },
    ];

    const sum = timeout_prob + auth_prob + format_prob + unavail_prob;
    const overall_risk_score = Math.min(100, Math.round(sum * 100));

    profiles.push({
      adapter_id: adapter.adapter_id,
      label: adapter.label,
      error_classes,
      overall_risk_score,
    });
  }

  profiles.sort((a, b) => b.overall_risk_score - a.overall_risk_score || a.adapter_id.localeCompare(b.adapter_id));

  const highest_risk_adapter = profiles.length > 0 ? profiles[0].adapter_id : null;
  const avg_risk_score = profiles.length > 0
    ? Math.round((profiles.reduce((s, p) => s + p.overall_risk_score, 0) / profiles.length) * 100) / 100
    : 0;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    adapters: profiles,
    highest_risk_adapter,
    avg_risk_score,
  };
}
