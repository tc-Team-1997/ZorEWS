// Phase 4 — Alert Center: domain classification for the alert list.
//
// Alerts don't carry an explicit banking/insurance field, but every
// alert's `indicators[]` are catalog ids whose prefix names the KRI
// family — and the families partition cleanly by domain:
//   banking:   FIN- / BEH- / TXN- / CRD- / FRD-
//   insurance: POL- / CUS-INS- / CUS- / AGT- / CLM- / OPS-
// This derives the domain from that signal so the Alert Center can offer
// an additive "domain" filter without a backend schema change. Pure
// logic — no React, no network.

export type AlertDomain = 'banking' | 'insurance' | 'mixed' | 'unknown';
export type AlertDomainFilter = 'all' | 'banking' | 'insurance';

const BANKING_PREFIXES: ReadonlySet<string> = new Set([
  'FIN',
  'BEH',
  'TXN',
  'CRD',
  'FRD',
]);

const INSURANCE_PREFIXES: ReadonlySet<string> = new Set([
  'POL',
  'CUS-INS',
  'CUS',
  'AGT',
  'CLM',
  'OPS',
]);

/** Extract the family prefix from an indicator id. Handles both id
 *  shapes the app produces:
 *    - catalog / BFF dashed:  `FIN-001 → FIN`, `CUS-INS-001 → CUS-INS`
 *    - SPA mock underscored:  `IND_BEH_03 → BEH`
 *  Non-indicator tokens (no recognisable family) return null. */
export function indicatorPrefix(indicatorId: string): string | null {
  const s = indicatorId.trim();
  // SPA mock/dev format: IND_<FAMILY>_<NN>
  const mock = /^IND_([A-Za-z]+)_\d+$/.exec(s);
  if (mock) return mock[1].toUpperCase();
  // Catalog / BFF format: <PREFIX>-<NNN>
  const dashed = /^([A-Za-z][A-Za-z-]*?)-\d+$/.exec(s);
  if (dashed) return dashed[1].toUpperCase();
  return null;
}

/** Classify a single indicator id into its domain (or 'unknown'). */
export function classifyIndicatorDomain(
  indicatorId: string,
): 'banking' | 'insurance' | 'unknown' {
  const prefix = indicatorPrefix(indicatorId);
  if (prefix === null) return 'unknown';
  if (BANKING_PREFIXES.has(prefix)) return 'banking';
  if (INSURANCE_PREFIXES.has(prefix)) return 'insurance';
  return 'unknown';
}

/**
 * Derive an alert's domain from its indicators:
 *   - all-banking signals  → 'banking'
 *   - all-insurance signals → 'insurance'
 *   - both present          → 'mixed' (touches both books)
 *   - none classifiable     → 'unknown'
 */
export function classifyAlertDomain(
  alert: Pick<{ indicators: string[] }, 'indicators'>,
): AlertDomain {
  let hasBanking = false;
  let hasInsurance = false;
  for (const id of alert.indicators ?? []) {
    const d = classifyIndicatorDomain(id);
    if (d === 'banking') hasBanking = true;
    else if (d === 'insurance') hasInsurance = true;
  }
  if (hasBanking && hasInsurance) return 'mixed';
  if (hasBanking) return 'banking';
  if (hasInsurance) return 'insurance';
  return 'unknown';
}

/**
 * Does an alert pass the active domain filter? 'all' passes everything.
 * A 'mixed' alert (touches both books) shows under both the banking and
 * insurance filters. 'unknown'-domain alerts only show under 'all' — a
 * themed filter shouldn't claim an alert it can't attribute.
 */
export function alertMatchesDomain(
  alert: Pick<{ indicators: string[] }, 'indicators'>,
  filter: AlertDomainFilter,
): boolean {
  if (filter === 'all') return true;
  const d = classifyAlertDomain(alert);
  if (d === 'mixed') return true;
  return d === filter;
}

/** Narrow an arbitrary URL string to a valid filter (defaults to 'all'). */
export function asAlertDomainFilter(v: string | null): AlertDomainFilter {
  return v === 'banking' || v === 'insurance' ? v : 'all';
}
