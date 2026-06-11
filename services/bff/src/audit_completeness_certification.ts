// services/bff/src/audit_completeness_certification.ts
// T6 M15.30 — Audit completeness certification

import { type AuditTrailStore } from './audit_trail';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

export type CertificationLevel = 'gold' | 'silver' | 'bronze' | 'fail';

export interface CertificationCriterion {
  name: string;
  passed: boolean;
  detail: string;
}

export interface AuditCertificate {
  cert_id: string;
  issued_at: string;
  valid_until: string;
  certification_level: CertificationLevel;
  criteria_results: CertificationCriterion[];
  overall_passed: boolean;
  signature: string;
}

export interface AuditCompletenessCertification {
  tenant_id: string;
  generated_at: string;
  certificate: AuditCertificate;
  recommendations: string[];
}

const MIN_EVENTS = 100;
const MIN_EVENTS_PER_DAY = 1;
const MIN_RESOURCE_TYPES = 7;

export function buildAuditCompletenessCertification(
  store: AuditTrailStore,
  tenant_id: string,
  now: Date
): AuditCompletenessCertification {
  const generated_at = now.toISOString();
  const issued_at = generated_at;
  const valid_until = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch all events
  const page = store.list(tenant_id, { page_size: 10000 });
  const events = page.items;
  const total_events = page.total;

  const criteria_results: CertificationCriterion[] = [];

  // 1. total_events > 100
  const criterion1 = total_events > MIN_EVENTS;
  criteria_results.push({
    name: 'sufficient_events',
    passed: criterion1,
    detail: `${total_events} events (minimum: ${MIN_EVENTS}).`,
  });

  // 2. chain_intact
  const verification = store.verifyChain(tenant_id, now);
  const criterion2 = verification.valid;
  criteria_results.push({
    name: 'chain_intact',
    passed: criterion2,
    detail: criterion2
      ? 'Hash chain is intact.'
      : `Chain broken at index ${verification.broken_at?.index ?? 'unknown'}.`,
  });

  // 3. coverage_days (days between oldest and newest event)
  let criterion3 = false;
  let coverageDays = 0;
  if (events.length >= 2) {
    const timestamps = events.map((e) => new Date(e.ts).getTime()).sort((a, b) => a - b);
    const oldest = timestamps[0]!;
    const newest = timestamps[timestamps.length - 1]!;
    coverageDays = Math.round((newest - oldest) / (24 * 60 * 60 * 1000));
    criterion3 = coverageDays >= 1;
  } else if (events.length === 1) {
    criterion3 = true;
    coverageDays = 0;
  }
  criteria_results.push({
    name: 'coverage_days',
    passed: criterion3,
    detail: `Audit covers ${coverageDays} day(s).`,
  });

  // 4. events_per_day >= 1
  let criterion4 = false;
  if (coverageDays > 0) {
    const eventsPerDay = total_events / coverageDays;
    criterion4 = eventsPerDay >= MIN_EVENTS_PER_DAY;
    criteria_results.push({
      name: 'events_per_day',
      passed: criterion4,
      detail: `${Math.round(eventsPerDay * 10) / 10} avg events/day (minimum: ${MIN_EVENTS_PER_DAY}).`,
    });
  } else {
    criterion4 = events.length > 0;
    criteria_results.push({
      name: 'events_per_day',
      passed: criterion4,
      detail: events.length > 0 ? `${events.length} event(s) in single day.` : 'No events yet.',
    });
  }

  // 5. all_resource_types_covered (>= 7 of 10)
  const distinctResourceTypes = new Set(events.map((e) => e.resource_type));
  const criterion5 = distinctResourceTypes.size >= MIN_RESOURCE_TYPES;
  criteria_results.push({
    name: 'resource_types_covered',
    passed: criterion5,
    detail: `${distinctResourceTypes.size}/10 resource types covered (minimum: ${MIN_RESOURCE_TYPES}).`,
  });

  const passedCount = criteria_results.filter((c) => c.passed).length;
  const overall_passed = passedCount === criteria_results.length;

  let certification_level: CertificationLevel;
  if (passedCount === 5) certification_level = 'gold';
  else if (passedCount === 4) certification_level = 'silver';
  else if (passedCount === 3) certification_level = 'bronze';
  else certification_level = 'fail';

  // Signature = fnv1a of concatenated results
  const sigInput = criteria_results.map((c) => `${c.name}:${c.passed}`).join('|');
  const sig = fnv1a(sigInput + issued_at).toString(16);

  const cert_id = fnv1a(`${tenant_id}:cert:${issued_at}`).toString(16).padStart(8, '0');

  const recommendations: string[] = [];
  for (const c of criteria_results) {
    if (!c.passed) {
      if (c.name === 'sufficient_events') recommendations.push('Record more audit events to reach the 100-event threshold.');
      if (c.name === 'chain_intact') recommendations.push('Investigate and repair the broken hash chain.');
      if (c.name === 'coverage_days') recommendations.push('Ensure audit logging has been active for at least 1 day.');
      if (c.name === 'events_per_day') recommendations.push('Increase audit event volume — aim for ≥ 1 event per day.');
      if (c.name === 'resource_types_covered') recommendations.push('Ensure operations across ≥ 7 resource types are being audited.');
    }
  }

  return {
    tenant_id,
    generated_at,
    certificate: {
      cert_id,
      issued_at,
      valid_until,
      certification_level,
      criteria_results,
      overall_passed,
      signature: sig,
    },
    recommendations,
  };
}
