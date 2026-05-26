// services/bff/src/glossary.ts
//
// Glossary — closes §2.4 #22 of ZorEWS_Pending_Gap_Analysis.md.
//
//   GET /v1/glossary/terms[?category=&q=]
//   GET /v1/glossary/terms/:term_id
//   GET /v1/glossary/categories
//
// Static catalogue of EWS/banking terminology — pure-static + platform-
// wide (same response across tenants). Operators reference this from
// help tooltips, hover-over definitions, training material.

export type GlossaryCategory = 'banking' | 'regulatory' | 'risk' | 'ai_ml' | 'workflow' | 'fraud' | 'insurance';
export const ALL_GLOSSARY_CATEGORIES: readonly GlossaryCategory[] = ['banking', 'regulatory', 'risk', 'ai_ml', 'workflow', 'fraud', 'insurance'];

export interface GlossaryTerm {
  term_id: string;
  term: string;
  category: GlossaryCategory;
  definition: string;
  source_doc?: string;
  related_term_ids?: string[];
  // M6.4 — Glossary: provenance + edit trail for tenant-owned terms.
  // `source = 'platform'` denotes the read-only seed catalogue from
  // GLOSSARY_TERMS; `source = 'tenant'` denotes admin-authored terms
  // stored in the per-tenant overlay. The audit trail captures
  // create / update / delete; these timestamps are convenience markers
  // for the SPA's "last updated" column.
  source?: 'platform' | 'tenant';
  updated_at?: string;
  updated_by?: string;
}

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  { term_id: 'sma', term: 'SMA — Special Mention Account', category: 'regulatory', definition: 'Per RBI Master Direction (April 2015), accounts overdue 1-90 days are classified as SMA-0 (1-30 dpd), SMA-1 (31-60 dpd), or SMA-2 (61-90 dpd). Accounts overdue >90 days are NPA.', source_doc: 'RBI Master Direction on Stressed Assets', related_term_ids: ['npa', 'dpd'] },
  { term_id: 'npa', term: 'NPA — Non-Performing Asset', category: 'regulatory', definition: 'An account where principal/interest is overdue for >90 days (Term Loan), or where the account remains "out of order" for >90 days (Cash Credit/Overdraft).', source_doc: 'RBI IRACP Norms', related_term_ids: ['sma', 'sub_standard'] },
  { term_id: 'dpd', term: 'DPD — Days Past Due', category: 'banking', definition: 'Number of days past the original due date that an installment or repayment remains unpaid.', related_term_ids: ['sma', 'npa'] },
  { term_id: 'pd', term: 'PD — Probability of Default', category: 'risk', definition: 'Probability that an obligor will default on their obligation within a defined horizon (typically 12 months).', related_term_ids: ['lgd', 'ead', 'ecl'] },
  { term_id: 'lgd', term: 'LGD — Loss Given Default', category: 'risk', definition: 'Proportion of exposure that is lost when a default event occurs (1 minus recovery rate).', related_term_ids: ['pd', 'ead', 'ecl'] },
  { term_id: 'ead', term: 'EAD — Exposure at Default', category: 'risk', definition: 'The exposure (outstanding + undrawn × CCF) expected to be in place at the time of default.', related_term_ids: ['pd', 'lgd', 'ecl'] },
  { term_id: 'ecl', term: 'ECL — Expected Credit Loss', category: 'risk', definition: 'ECL = PD × LGD × EAD. Used in IFRS 9 / Ind AS 109 for impairment provisioning.', source_doc: 'IFRS 9 / Ind AS 109', related_term_ids: ['pd', 'lgd', 'ead'] },
  { term_id: 'cma_pack', term: 'CMA Pack — Credit Monitoring Arrangement Pack', category: 'banking', definition: 'A 4-form package (Forms II/III/IV/V) submitted by borrowers for working-capital assessment. Form II: Operating Statement; Form III: Balance Sheet; Form IV: Working Capital; Form V: MPBF calculation.', source_doc: 'RBI Tandon Committee / Working Capital Norms' },
  { term_id: 'dscr', term: 'DSCR — Debt Service Coverage Ratio', category: 'banking', definition: 'DSCR = (Net Operating Income + Depreciation) / Annual Debt Service. A DSCR of ≥1.5 is generally considered healthy.', related_term_ids: ['icr', 'der'] },
  { term_id: 'icr', term: 'ICR — Interest Coverage Ratio', category: 'banking', definition: 'ICR = EBIT / Interest Expense. Measures the borrower\'s ability to service interest from operating profits.', related_term_ids: ['dscr', 'der'] },
  { term_id: 'der', term: 'DER — Debt-to-Equity Ratio', category: 'banking', definition: 'DER = Total Debt / Total Equity. Measures leverage; banks typically watch for DER >2.0 in SME / >3.0 in mid-corporate as a warning signal.', related_term_ids: ['dscr', 'icr', 'covenant'] },
  { term_id: 'sarfaesi', term: 'SARFAESI Act, 2002', category: 'regulatory', definition: 'Securitisation and Reconstruction of Financial Assets and Enforcement of Security Interest Act, 2002. Empowers banks to recover NPAs without court intervention. Section 13(2) requires a 60-day demand notice before enforcement.', source_doc: 'SARFAESI Act, 2002' },
  { term_id: 'sar', term: 'SAR — Suspicious Activity Report', category: 'fraud', definition: 'A regulatory report filed with FIU-IND (Financial Intelligence Unit) for suspicious financial transactions, per RBI Master Directions on Frauds (2016).', source_doc: 'RBI Master Directions on Frauds, 2016' },
  { term_id: 'shap', term: 'SHAP — SHapley Additive exPlanations', category: 'ai_ml', definition: 'A game-theoretic approach to explaining ML model output. Each feature gets a signed contribution explaining how much it pushed the prediction up or down vs the population mean.', related_term_ids: ['pd'] },
  { term_id: 'auc', term: 'AUC — Area Under the ROC Curve', category: 'ai_ml', definition: 'Measures a binary classifier\'s ability to discriminate. AUC=0.5 is random; AUC=1.0 is perfect. Typical PD models target AUC ≥0.78.', related_term_ids: ['ks', 'pd'] },
  { term_id: 'ks', term: 'KS — Kolmogorov-Smirnov Statistic', category: 'ai_ml', definition: 'Max difference between cumulative distributions of good vs bad outcomes. KS ≥0.4 considered acceptable for PD models.', related_term_ids: ['auc'] },
  { term_id: 'psi', term: 'PSI — Population Stability Index', category: 'ai_ml', definition: 'Measures distributional drift between training and current data. PSI<0.1 stable; 0.1-0.25 moderate drift; >0.25 significant drift.', related_term_ids: ['drift'] },
  { term_id: 'drift', term: 'Model Drift', category: 'ai_ml', definition: 'Degradation of model performance over time due to shifts in the input data distribution or the underlying outcome relationship.', related_term_ids: ['psi'] },
  { term_id: 'maker_checker', term: 'Maker-Checker (4-eyes)', category: 'workflow', definition: 'A control where one operator (maker) proposes a sensitive action and a different operator (checker) approves or rejects it. The maker and checker MUST be different individuals per RBI segregation-of-duties guidance.', source_doc: 'RBI Operational Risk Framework' },
  { term_id: 'aml', term: 'AML — Anti-Money Laundering', category: 'regulatory', definition: 'Framework to detect and report transactions that could be linked to money laundering or terrorist financing, governed by the Prevention of Money Laundering Act (PMLA), 2002.', source_doc: 'PMLA 2002', related_term_ids: ['sar'] },
  { term_id: 'covenant', term: 'Covenant', category: 'banking', definition: 'A contractual condition in a loan agreement (financial or non-financial) the borrower must maintain. Breach can trigger demand, repricing, or call.', related_term_ids: ['dscr', 'icr'] },
  { term_id: 'ifrs9', term: 'IFRS 9 / Ind AS 109', category: 'regulatory', definition: 'Accounting standard for financial instruments with a 3-stage impairment model (Stage 1: 12-month ECL; Stage 2: lifetime ECL for SICR; Stage 3: lifetime ECL for credit-impaired).', source_doc: 'IFRS 9', related_term_ids: ['ecl', 'pd'] },
  { term_id: 'sub_standard', term: 'Sub-Standard Asset', category: 'regulatory', definition: 'An NPA that has remained NPA for ≤12 months. After 12 months it becomes a Doubtful asset.', source_doc: 'RBI IRACP Norms', related_term_ids: ['npa'] },
  { term_id: 'lapse', term: 'Policy Lapse', category: 'insurance', definition: 'When an insurance policyholder fails to pay premium within the grace period and coverage ceases. A leading EWS signal for retention risk.', related_term_ids: ['persistency'] },
  { term_id: 'persistency', term: 'Persistency Ratio', category: 'insurance', definition: 'Proportion of insurance policies still in force at the n-th month post-issuance (typically 13M, 25M, 37M, 49M, 61M).', related_term_ids: ['lapse'] },
];

export class GlossaryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'GlossaryError';
  }
}

export function isGlossaryCategory(x: unknown): x is GlossaryCategory {
  return typeof x === 'string' && ALL_GLOSSARY_CATEGORIES.includes(x as GlossaryCategory);
}

// ──────────────────────────────────────────────────────────────────────
// M6.4 — Glossary: per-tenant CRUD overlay
//
// The platform seed catalogue (GLOSSARY_TERMS) is READ-ONLY. Tenants
// can ADD new terms, OVERRIDE platform terms with a tenant-specific
// definition, or DELETE (= hide) platform terms. The effective list
// for a tenant is:
//
//   1. Every platform term that hasn't been deleted/hidden, with
//      tenant overrides applied on top (same term_id wins).
//   2. Every tenant-only term added via createGlossaryTerm.
//
// Tombstone semantics: deleting a platform term writes a hide-marker
// to the tombstone set rather than mutating the platform seed (so the
// seed stays a pure constant + reset semantics are simple). Tenant
// terms are hard-deleted from the overlay map.
// ──────────────────────────────────────────────────────────────────────

const _tenantOverlay = new Map<string, Map<string, GlossaryTerm>>();
const _tenantTombstones = new Map<string, Set<string>>();

function tenantOverlayMap(tenant_id: string): Map<string, GlossaryTerm> {
  let m = _tenantOverlay.get(tenant_id);
  if (!m) {
    m = new Map<string, GlossaryTerm>();
    _tenantOverlay.set(tenant_id, m);
  }
  return m;
}

function tenantTombstoneSet(tenant_id: string): Set<string> {
  let s = _tenantTombstones.get(tenant_id);
  if (!s) {
    s = new Set<string>();
    _tenantTombstones.set(tenant_id, s);
  }
  return s;
}

function cloneTerm(t: GlossaryTerm): GlossaryTerm {
  return {
    ...t,
    related_term_ids: t.related_term_ids ? [...t.related_term_ids] : undefined,
  };
}

const TERM_ID_RE = /^[a-z0-9_]{2,64}$/;

function validateTermInput(
  input: Partial<Pick<GlossaryTerm, 'term_id' | 'term' | 'category' | 'definition' | 'source_doc' | 'related_term_ids'>>,
  opts: { requireId?: boolean } = {},
): void {
  if (opts.requireId) {
    if (!input.term_id || typeof input.term_id !== 'string' || !TERM_ID_RE.test(input.term_id)) {
      throw new GlossaryError('invalid_term_id', 'term_id must match /^[a-z0-9_]{2,64}$/');
    }
  }
  if (input.term !== undefined) {
    if (typeof input.term !== 'string' || input.term.trim().length < 2 || input.term.length > 200) {
      throw new GlossaryError('invalid_term', 'term must be 2..200 chars');
    }
  }
  if (input.category !== undefined) {
    if (!isGlossaryCategory(input.category)) {
      throw new GlossaryError('invalid_category', `invalid category ${input.category}`);
    }
  }
  if (input.definition !== undefined) {
    if (typeof input.definition !== 'string' || input.definition.trim().length < 10 || input.definition.length > 4000) {
      throw new GlossaryError('invalid_definition', 'definition must be 10..4000 chars');
    }
  }
  if (input.source_doc !== undefined && input.source_doc !== null) {
    if (typeof input.source_doc !== 'string' || input.source_doc.length > 200) {
      throw new GlossaryError('invalid_source_doc', 'source_doc must be ≤200 chars');
    }
  }
  if (input.related_term_ids !== undefined) {
    if (!Array.isArray(input.related_term_ids) || input.related_term_ids.length > 32) {
      throw new GlossaryError('invalid_related_term_ids', 'related_term_ids must be array ≤32');
    }
    for (const id of input.related_term_ids) {
      if (typeof id !== 'string' || !TERM_ID_RE.test(id)) {
        throw new GlossaryError('invalid_related_term_ids', `related_term_id "${id}" must match /^[a-z0-9_]{2,64}$/`);
      }
    }
  }
}

export function listGlossaryTerms(filter: { category?: GlossaryCategory; q?: string; tenant_id?: string } = {}): GlossaryTerm[] {
  if (filter.category && !isGlossaryCategory(filter.category)) {
    throw new GlossaryError('invalid_category', `invalid category ${filter.category}`);
  }
  // Start from the platform seed, with tenant overrides / tombstones
  // applied. Tenant-only terms are appended below.
  const out: GlossaryTerm[] = [];
  const overlay = filter.tenant_id ? tenantOverlayMap(filter.tenant_id) : new Map<string, GlossaryTerm>();
  const tombstones = filter.tenant_id ? tenantTombstoneSet(filter.tenant_id) : new Set<string>();

  // Platform seed (read-only) with overrides applied
  for (const t of GLOSSARY_TERMS) {
    if (tombstones.has(t.term_id)) continue; // tenant has hidden this term
    const ovr = overlay.get(t.term_id);
    if (ovr) {
      out.push({ ...ovr, source: 'tenant' });
    } else {
      out.push({ ...t, source: 'platform' });
    }
  }
  // Tenant-only terms (those whose term_id isn't in GLOSSARY_TERMS)
  const platformIds = new Set(GLOSSARY_TERMS.map((t) => t.term_id));
  for (const t of overlay.values()) {
    if (!platformIds.has(t.term_id)) {
      out.push({ ...t, source: 'tenant' });
    }
  }

  // Filter
  let filtered = out;
  if (filter.category) {
    filtered = filtered.filter((t) => t.category === filter.category);
  }
  if (filter.q && filter.q.trim().length > 0) {
    const q = filter.q.toLowerCase();
    filtered = filtered.filter(
      (t) =>
        t.term.toLowerCase().includes(q) ||
        t.definition.toLowerCase().includes(q) ||
        t.term_id.toLowerCase().includes(q),
    );
  }

  return filtered.map(cloneTerm);
}

export function getGlossaryTerm(term_id: string, tenant_id?: string): GlossaryTerm | null {
  if (tenant_id) {
    const tombs = tenantTombstoneSet(tenant_id);
    if (tombs.has(term_id)) return null;
    const ovr = tenantOverlayMap(tenant_id).get(term_id);
    if (ovr) return { ...cloneTerm(ovr), source: 'tenant' };
  }
  const found = GLOSSARY_TERMS.find((t) => t.term_id === term_id);
  if (!found) return null;
  return { ...cloneTerm(found), source: 'platform' };
}

export function listGlossaryCategories(): GlossaryCategory[] {
  return ALL_GLOSSARY_CATEGORIES.slice();
}

export interface GlossaryTermCreateInput {
  term_id: string;
  term: string;
  category: GlossaryCategory;
  definition: string;
  source_doc?: string;
  related_term_ids?: string[];
}

export function createGlossaryTerm(
  tenant_id: string,
  input: GlossaryTermCreateInput,
  actor: string,
  now: Date,
): GlossaryTerm {
  if (!tenant_id) throw new GlossaryError('invalid_input', 'tenant_id required');
  if (!actor) throw new GlossaryError('invalid_input', 'actor required');
  validateTermInput(input, { requireId: true });
  // Conflict if a tenant override already exists OR if platform term
  // exists AND has not been tombstoned (admin must DELETE first to
  // override a platform term).
  const overlay = tenantOverlayMap(tenant_id);
  if (overlay.has(input.term_id)) {
    throw new GlossaryError('duplicate_term_id', `term_id ${input.term_id} already exists in this tenant`);
  }
  const platformTerm = GLOSSARY_TERMS.find((t) => t.term_id === input.term_id);
  if (platformTerm && !tenantTombstoneSet(tenant_id).has(input.term_id)) {
    throw new GlossaryError('platform_term_exists', `term_id ${input.term_id} is a platform term; PUT it to override`);
  }
  const entry: GlossaryTerm = {
    term_id: input.term_id,
    term: input.term,
    category: input.category,
    definition: input.definition,
    source_doc: input.source_doc,
    related_term_ids: input.related_term_ids ? [...input.related_term_ids] : undefined,
    source: 'tenant',
    updated_at: now.toISOString(),
    updated_by: actor,
  };
  overlay.set(entry.term_id, entry);
  // If we previously tombstoned this id, clear the tombstone since
  // it's now a real (overlay-backed) term.
  tenantTombstoneSet(tenant_id).delete(input.term_id);
  return cloneTerm(entry);
}

export function updateGlossaryTerm(
  tenant_id: string,
  term_id: string,
  patch: Partial<Pick<GlossaryTerm, 'term' | 'category' | 'definition' | 'source_doc' | 'related_term_ids'>>,
  actor: string,
  now: Date,
): GlossaryTerm {
  if (!tenant_id) throw new GlossaryError('invalid_input', 'tenant_id required');
  if (!actor) throw new GlossaryError('invalid_input', 'actor required');
  if (!TERM_ID_RE.test(term_id)) throw new GlossaryError('invalid_term_id', `term_id ${term_id} invalid`);
  if (tenantTombstoneSet(tenant_id).has(term_id)) {
    throw new GlossaryError('unknown_term', `term_id ${term_id} is hidden in this tenant`);
  }
  validateTermInput(patch);

  const overlay = tenantOverlayMap(tenant_id);
  let base: GlossaryTerm | undefined = overlay.get(term_id);
  if (!base) {
    // Promote platform term → tenant override (copy-on-write)
    const platformTerm = GLOSSARY_TERMS.find((t) => t.term_id === term_id);
    if (!platformTerm) throw new GlossaryError('unknown_term', `unknown term_id ${term_id}`);
    base = { ...platformTerm };
  }
  const merged: GlossaryTerm = {
    ...base,
    ...patch,
    related_term_ids: patch.related_term_ids
      ? [...patch.related_term_ids]
      : base.related_term_ids
        ? [...base.related_term_ids]
        : undefined,
    source: 'tenant',
    updated_at: now.toISOString(),
    updated_by: actor,
  };
  overlay.set(term_id, merged);
  return cloneTerm(merged);
}

export function deleteGlossaryTerm(tenant_id: string, term_id: string): boolean {
  if (!tenant_id) throw new GlossaryError('invalid_input', 'tenant_id required');
  const overlay = tenantOverlayMap(tenant_id);
  const tombs = tenantTombstoneSet(tenant_id);

  // Tenant overlay entry? Hard-delete it.
  if (overlay.has(term_id)) {
    overlay.delete(term_id);
    // If the same id has a platform term, also tombstone it so the
    // platform definition doesn't reappear (admin intent: this term
    // should be hidden in this tenant). Without the tombstone, the
    // listGlossaryTerms loop above would revert to the platform seed.
    if (GLOSSARY_TERMS.some((t) => t.term_id === term_id)) {
      tombs.add(term_id);
    }
    return true;
  }

  // Otherwise, mark platform term as hidden via tombstone
  const platformTerm = GLOSSARY_TERMS.find((t) => t.term_id === term_id);
  if (!platformTerm) return false; // unknown
  if (tombs.has(term_id)) return false; // already tombstoned
  tombs.add(term_id);
  return true;
}

export function _resetGlossaryOverlay() {
  _tenantOverlay.clear();
  _tenantTombstones.clear();
}
