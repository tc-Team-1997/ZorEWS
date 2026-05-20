// services/bff/src/aml/aml_dashboard.ts
//
// PHASE C.2 — AML Dashboard rollup (PDF §11 AML Integration item 5).
//
// Pure composer that aggregates AML-related signals across modules
// into a single dashboard payload the SPA renders as the AML
// homepage. No new store; reads from existing tenant-scoped stores.
//
// Architecture (per execution rules):
//   - Additive only — no changes to M14.3 adapter, M_GEO, M_CUST,
//     or STR store.
//   - Pure function — no I/O state in the rollup itself.
//   - RBAC: audit:read admin-only (compliance-grade view).
//
// Composes:
//   - Phase B.1 customer_master → PEP roster + KYC-expiring count
//   - Phase A.2 geography_master → sanctioned-country list + risk-level
//   - Phase C.1 STR summary → workflow rollup
//   - (M14.3 AML adapter is queried at the route layer when wired —
//     this module accepts a pre-computed AmlAdapterSummary so the
//     composer stays pure and easy to test.)

import type { CustomerMasterEntry, CustomerMasterStore } from '../master/customer_master';
import { listKycExpiringCustomers } from '../master/customer_master';
import type { GeographyMasterEntry, GeographyMasterStore } from '../master/geography_master';
import type { StrReportStore } from './str_reporting';
import { buildStrSummary, type StrSummary } from './str_reporting';

/** Compact summary of AML adapter activity. Optional — the rollup
 *  works without it (returns null in the corresponding section).
 *  Callers (route handler) build this from the M14.3 AML adapter
 *  when wired. */
export interface AmlAdapterSummary {
  total_screens: number;
  open_matches: number;
  cleared_matches: number;
  escalated_matches: number;
  false_positive_matches: number;
  high_severity_open: number;
  most_recent_screen_at: string | null;
}

export interface AmlDashboardRollup {
  tenant_id: string;
  generated_at: string;
  /** STR workflow rollup (from Phase C.1). */
  str_summary: StrSummary;
  /** Customer compliance (PEP roster + KYC-expiring queue). */
  customer_compliance: {
    pep_customer_count: number;
    pep_sample: Array<{
      customer_id: string;
      country: string;
      kyc_status: string;
      risk_category: string | null;
    }>;
    kyc_expiring_count_30d: number;
    kyc_expiring_count_7d: number;
    high_risk_override_count: number; // risk_category='high' overrides
  };
  /** Geography sanctions + high-risk country roster. */
  geography_risk: {
    sanctioned_country_count: number;
    sanctioned_countries: Array<{ country_code: string; country_name: string; aml_regime: string }>;
    high_risk_country_count: number;
    high_risk_countries: Array<{ country_code: string; country_name: string }>;
  };
  /** AML adapter section (null when adapter not wired). */
  adapter_activity: AmlAdapterSummary | null;
  /** Aggregate compliance attention indicator — admins see a chip
   *  glowing when any of: STR pending_review > 0, kyc_expiring_7d > 0,
   *  adapter high_severity_open > 0. */
  attention: {
    needs_action: boolean;
    reasons: string[];
  };
}

/** Builds the AML dashboard payload. Pure — no I/O.
 *
 *  Caller provides:
 *    - tenant_id : scoping key
 *    - customerMasterStore + geographyMasterStore + strReportStore
 *    - adapterSummary : optional pre-computed AML adapter rollup;
 *                       null when adapter not wired
 *    - now : injectable clock for tests
 *
 *  Sample caps:
 *    - pep_sample : top-10 PEP customers (alpha by customer_id)
 *    - sanctioned_countries : full list (typically <30 globally; no cap)
 *    - high_risk_countries : top-20 (alpha by country_name)
 */
export const AML_PEP_SAMPLE_CAP = 10;
export const AML_HIGH_RISK_COUNTRY_CAP = 20;

export function buildAmlDashboard(
  tenant_id: string,
  customerMasterStore: CustomerMasterStore,
  geographyMasterStore: GeographyMasterStore,
  strReportStore: StrReportStore,
  adapterSummary: AmlAdapterSummary | null,
  now: Date,
): AmlDashboardRollup {
  // ─── STR section ────────────────────────────────────────────────
  const str_summary = buildStrSummary(strReportStore, tenant_id, now);

  // ─── Customer compliance section ────────────────────────────────
  const pepCustomers = customerMasterStore.list(tenant_id, { pep_flag: true, limit: 5000 });
  const pep_sample = pepCustomers
    .slice()
    .sort((a, b) => a.customer_id.localeCompare(b.customer_id))
    .slice(0, AML_PEP_SAMPLE_CAP)
    .map((c) => ({
      customer_id: c.customer_id,
      country: c.country,
      kyc_status: c.kyc_status,
      risk_category: c.risk_category,
    }));

  const kycExpiring30 = listKycExpiringCustomers(customerMasterStore, tenant_id, now, 30);
  const kycExpiring7 = listKycExpiringCustomers(customerMasterStore, tenant_id, now, 7);
  const high_risk_override_count = customerMasterStore.list(tenant_id, {
    risk_category: 'high',
    limit: 5000,
  }).length;

  // ─── Geography section ──────────────────────────────────────────
  const sanctioned = geographyMasterStore.list(tenant_id, { sanction_flag: true });
  const highRisk = geographyMasterStore.list(tenant_id, { risk_level: 'high' });

  const sanctioned_countries = sanctioned.map((g: GeographyMasterEntry) => ({
    country_code: g.country_code,
    country_name: g.country_name,
    aml_regime: g.aml_regime,
  }));
  const high_risk_countries = highRisk
    .slice()
    .sort((a, b) => a.country_name.localeCompare(b.country_name))
    .slice(0, AML_HIGH_RISK_COUNTRY_CAP)
    .map((g) => ({
      country_code: g.country_code,
      country_name: g.country_name,
    }));

  // ─── Attention rollup ───────────────────────────────────────────
  const reasons: string[] = [];
  if (str_summary.pending_review_count > 0) {
    reasons.push(
      `${str_summary.pending_review_count} STR(s) pending checker review`,
    );
  }
  if (str_summary.unacked_submitted_count > 0) {
    reasons.push(
      `${str_summary.unacked_submitted_count} submitted STR(s) awaiting FIU-IND ack`,
    );
  }
  if (kycExpiring7.length > 0) {
    reasons.push(`${kycExpiring7.length} customer KYC(s) expiring within 7 days`);
  }
  if (adapterSummary && adapterSummary.high_severity_open > 0) {
    reasons.push(`${adapterSummary.high_severity_open} high-severity AML match(es) open`);
  }
  const attention = {
    needs_action: reasons.length > 0,
    reasons,
  };

  return {
    tenant_id,
    generated_at: now.toISOString(),
    str_summary,
    customer_compliance: {
      pep_customer_count: pepCustomers.length,
      pep_sample,
      kyc_expiring_count_30d: kycExpiring30.length,
      kyc_expiring_count_7d: kycExpiring7.length,
      high_risk_override_count,
    },
    geography_risk: {
      sanctioned_country_count: sanctioned.length,
      sanctioned_countries,
      high_risk_country_count: highRisk.length,
      high_risk_countries,
    },
    adapter_activity: adapterSummary,
    attention,
  };
}

/** Convenience: build the adapter-summary stub from the existing M14.3
 *  AML adapter's match list. Drains all matches across known customers
 *  is impractical for in-memory stub data, so this helper is the
 *  rollup OVER an already-fetched match list (a caller passes the
 *  list — keeps the composer pure).
 *
 *  Returns null when matches is null/undefined (signals "adapter not
 *  available" to downstream consumers). */
export function summariseAmlMatches(
  matches: ReadonlyArray<{
    status: string;
    severity: string;
    screened_at?: string;
    last_checked_at?: string;
  }> | null,
): AmlAdapterSummary | null {
  if (matches == null) return null;
  let open = 0;
  let cleared = 0;
  let escalated = 0;
  let falsePos = 0;
  let highSevOpen = 0;
  let mostRecentTs = -Infinity;
  for (const m of matches) {
    if (m.status === 'open') open++;
    else if (m.status === 'cleared') cleared++;
    else if (m.status === 'escalated') escalated++;
    else if (m.status === 'false_positive') falsePos++;
    if (m.status === 'open' && m.severity === 'high') highSevOpen++;
    const ts = m.last_checked_at ?? m.screened_at;
    if (ts) {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed) && parsed > mostRecentTs) mostRecentTs = parsed;
    }
  }
  return {
    total_screens: matches.length,
    open_matches: open,
    cleared_matches: cleared,
    escalated_matches: escalated,
    false_positive_matches: falsePos,
    high_severity_open: highSevOpen,
    most_recent_screen_at: mostRecentTs === -Infinity ? null : new Date(mostRecentTs).toISOString(),
  };
}
