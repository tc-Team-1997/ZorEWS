// services/bff/src/governance/compliance_store.ts
//
// Compliance rules registry — in-memory implementation matching 051 schema.
// Country-scoped; UNIQUE(country_code, regulator, rule_code) enforced.

import {
  GovernanceError,
  isGovernanceDomain,
  isComplianceSeverity,
  isComplianceRequirementKind,
  type ComplianceRule,
  type ComplianceRuleInput,
  type ComplianceRulePatch,
  type GovernanceDomain,
} from './types';

export interface ListComplianceRulesFilter {
  country_code?: string;
  regulator?: string;
  domain?: GovernanceDomain;
  active_only?: boolean;
}

export interface IComplianceRuleStore {
  list(filter?: ListComplianceRulesFilter): ComplianceRule[];
  get(rule_id: string): ComplianceRule | null;
  byCountryAndCode(country_code: string, regulator: string, rule_code: string): ComplianceRule | null;
  create(input: ComplianceRuleInput, now: Date): ComplianceRule;
  update(rule_id: string, patch: ComplianceRulePatch, now: Date): ComplianceRule;
  delete(rule_id: string): boolean;
}

function validateInput(input: ComplianceRuleInput): void {
  if (!input || typeof input !== 'object') throw new GovernanceError('invalid_input');
  if (!input.country_code?.trim()) throw new GovernanceError('invalid_country');
  if (!input.regulator?.trim() || input.regulator.length > 32) throw new GovernanceError('invalid_input');
  if (!input.rule_code?.trim() || input.rule_code.length > 64) throw new GovernanceError('invalid_input');
  if (!input.title?.trim() || input.title.length > 200) throw new GovernanceError('invalid_input');
  if (!input.description?.trim() || input.description.length > 4000) throw new GovernanceError('invalid_input');
  if (!isGovernanceDomain(input.domain)) throw new GovernanceError('invalid_domain');
  if (!isComplianceRequirementKind(input.requirement_kind)) throw new GovernanceError('invalid_requirement_kind');
  if (input.severity !== undefined && !isComplianceSeverity(input.severity)) {
    throw new GovernanceError('invalid_severity');
  }
}

function nextRuleId(seq: number): string {
  return `cr-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export class InMemoryComplianceRuleStore implements IComplianceRuleStore {
  private readonly rows = new Map<string, ComplianceRule>();
  private seq = 0;

  constructor(seed?: Iterable<ComplianceRule>) {
    if (seed) for (const r of seed) this.rows.set(r.rule_id, r);
  }

  list(filter: ListComplianceRulesFilter = {}): ComplianceRule[] {
    let out = Array.from(this.rows.values());
    if (filter.country_code) out = out.filter((r) => r.country_code === filter.country_code);
    if (filter.regulator) out = out.filter((r) => r.regulator === filter.regulator);
    if (filter.domain) out = out.filter((r) => r.domain === filter.domain);
    if (filter.active_only) out = out.filter((r) => r.active);
    out.sort((a, b) => {
      if (a.country_code !== b.country_code) return a.country_code < b.country_code ? -1 : 1;
      if (a.regulator !== b.regulator) return a.regulator < b.regulator ? -1 : 1;
      return a.rule_code < b.rule_code ? -1 : a.rule_code > b.rule_code ? 1 : 0;
    });
    return out.map((r) => ({ ...r }));
  }

  get(rule_id: string): ComplianceRule | null {
    const r = this.rows.get(rule_id);
    return r ? { ...r } : null;
  }

  byCountryAndCode(country_code: string, regulator: string, rule_code: string): ComplianceRule | null {
    for (const r of this.rows.values()) {
      if (r.country_code === country_code && r.regulator === regulator && r.rule_code === rule_code) return { ...r };
    }
    return null;
  }

  create(input: ComplianceRuleInput, now: Date): ComplianceRule {
    validateInput(input);
    if (this.byCountryAndCode(input.country_code, input.regulator, input.rule_code)) {
      throw new GovernanceError('duplicate_compliance_rule');
    }
    this.seq += 1;
    const rule: ComplianceRule = {
      rule_id: nextRuleId(this.seq),
      country_code: input.country_code,
      regulator: input.regulator,
      domain: input.domain,
      rule_code: input.rule_code,
      title: input.title,
      description: input.description,
      requirement_kind: input.requirement_kind,
      severity: input.severity ?? 'mandatory',
      effective_from: input.effective_from ?? null,
      effective_until: input.effective_until ?? null,
      source_url: input.source_url ?? null,
      active: input.active ?? true,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.rows.set(rule.rule_id, rule);
    return { ...rule };
  }

  update(rule_id: string, patch: ComplianceRulePatch, now: Date): ComplianceRule {
    const existing = this.rows.get(rule_id);
    if (!existing) throw new GovernanceError('unknown_compliance_rule');
    if (!patch || typeof patch !== 'object') throw new GovernanceError('invalid_input');
    if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 200)) {
      throw new GovernanceError('invalid_input');
    }
    if (patch.description !== undefined && (!patch.description.trim() || patch.description.length > 4000)) {
      throw new GovernanceError('invalid_input');
    }
    if (patch.severity !== undefined && !isComplianceSeverity(patch.severity)) {
      throw new GovernanceError('invalid_severity');
    }
    if (patch.requirement_kind !== undefined && !isComplianceRequirementKind(patch.requirement_kind)) {
      throw new GovernanceError('invalid_requirement_kind');
    }
    const next: ComplianceRule = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.requirement_kind !== undefined ? { requirement_kind: patch.requirement_kind } : {}),
      ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
      ...(patch.effective_from !== undefined ? { effective_from: patch.effective_from } : {}),
      ...(patch.effective_until !== undefined ? { effective_until: patch.effective_until } : {}),
      ...(patch.source_url !== undefined ? { source_url: patch.source_url } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updated_at: now.toISOString(),
    };
    this.rows.set(rule_id, next);
    return { ...next };
  }

  delete(rule_id: string): boolean {
    return this.rows.delete(rule_id);
  }
}

/** Seed mirrors data/schema/051 — 9 sample rules across RBI/IRDAI/RMA/CBK/FIU. */
export function buildDefaultComplianceSeed(now: Date): ComplianceRule[] {
  const ts = now.toISOString();
  const rows: Omit<ComplianceRule, 'created_at' | 'updated_at'>[] = [
    { rule_id: 'cr-rbi-md-npa',   country_code: 'IN', regulator: 'RBI',   domain: 'banking',   rule_code: 'RBI-MD-NPA-2024',   title: 'IRACP — Income Recognition and Asset Classification', description: 'Loans classified as NPA when DPD ≥ 90; SMA-0/1/2 tiers per DPD bracket. Quarterly reporting to RBI.', requirement_kind: 'reporting', severity: 'mandatory', effective_from: '2024-04-01', effective_until: null, source_url: 'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx', active: true },
    { rule_id: 'cr-rbi-pmla',     country_code: 'IN', regulator: 'RBI',   domain: 'banking',   rule_code: 'RBI-PMLA-2002',     title: 'PMLA — Anti Money Laundering', description: 'KYC + Sanctions screening + STR/CTR reporting to FIU-IND.', requirement_kind: 'kyc', severity: 'mandatory', effective_from: '2002-07-01', effective_until: null, source_url: 'https://www.fiuindia.gov.in/', active: true },
    { rule_id: 'cr-rbi-basel3',   country_code: 'IN', regulator: 'RBI',   domain: 'banking',   rule_code: 'RBI-BASEL-III',     title: 'Basel III Capital Adequacy', description: 'Min CET1 + Tier-1 + Total CRAR ratios with capital conservation buffer.', requirement_kind: 'capital', severity: 'mandatory', effective_from: '2013-04-01', effective_until: null, source_url: 'https://www.rbi.org.in/', active: true },
    { rule_id: 'cr-irdai-cg',     country_code: 'IN', regulator: 'IRDAI', domain: 'insurance', rule_code: 'IRDAI-CG-2016',     title: 'Corporate Governance Guidelines', description: 'Board composition + risk committees + investment committee + audit committee.', requirement_kind: 'governance', severity: 'mandatory', effective_from: '2016-05-18', effective_until: null, source_url: 'https://www.irdai.gov.in/', active: true },
    { rule_id: 'cr-irdai-claims', country_code: 'IN', regulator: 'IRDAI', domain: 'insurance', rule_code: 'IRDAI-CLM-2024',    title: 'Claim Settlement Turnaround Time', description: 'Acknowledge claim within 24h; settle within 30 days of last document received.', requirement_kind: 'reporting', severity: 'mandatory', effective_from: '2024-04-01', effective_until: null, source_url: 'https://www.irdai.gov.in/', active: true },
    { rule_id: 'cr-rma-bt-cap',   country_code: 'BT', regulator: 'RMA',   domain: 'banking',   rule_code: 'RMA-CAP-2022',      title: 'Capital Adequacy Framework', description: 'Minimum CRAR 12.5% for Bhutan-registered banks.', requirement_kind: 'capital', severity: 'mandatory', effective_from: '2022-01-01', effective_until: null, source_url: 'https://www.rma.org.bt/', active: true },
    { rule_id: 'cbk-fia-2009',    country_code: 'KE', regulator: 'CBK',   domain: 'banking',   rule_code: 'CBK-FIA-2009',      title: 'Banking Act CAP 488 Compliance', description: 'Periodic returns + capital ratios per Banking Act of Kenya.', requirement_kind: 'reporting', severity: 'mandatory', effective_from: '2009-01-01', effective_until: null, source_url: 'https://www.centralbank.go.ke/', active: true },
    { rule_id: 'cr-rbi-data-res', country_code: 'IN', regulator: 'RBI',   domain: 'both',      rule_code: 'RBI-DATA-RES-2018', title: 'Data Localisation for Payment Systems', description: 'All payment-system data must be stored in India; cross-border processing allowed but original must reside in IN.', requirement_kind: 'data_residency', severity: 'mandatory', effective_from: '2018-10-15', effective_until: null, source_url: 'https://www.rbi.org.in/', active: true },
    { rule_id: 'cr-fiu-str',      country_code: 'IN', regulator: 'FIU',   domain: 'both',      rule_code: 'FIU-STR-2005',      title: 'Suspicious Transaction Report filing', description: 'STR within 7 working days of suspicion arising; record retention 5 years post-transaction.', requirement_kind: 'sanctions', severity: 'mandatory', effective_from: '2005-07-01', effective_until: null, source_url: 'https://www.fiuindia.gov.in/', active: true },
  ];
  return rows.map((r) => ({ ...r, created_at: ts, updated_at: ts }));
}

let _default: InMemoryComplianceRuleStore | undefined;
export function defaultComplianceRuleStore(): InMemoryComplianceRuleStore {
  if (!_default) _default = new InMemoryComplianceRuleStore(buildDefaultComplianceSeed(new Date()));
  return _default;
}
export function _resetDefaultComplianceRuleStore(): void {
  _default = undefined;
}
