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

export function listGlossaryTerms(filter: { category?: GlossaryCategory; q?: string } = {}): GlossaryTerm[] {
  let out = GLOSSARY_TERMS.slice();
  if (filter.category) {
    if (!isGlossaryCategory(filter.category))
      throw new GlossaryError('invalid_category', `invalid category ${filter.category}`);
    out = out.filter((t) => t.category === filter.category);
  }
  if (filter.q && filter.q.trim().length > 0) {
    const q = filter.q.toLowerCase();
    out = out.filter((t) => t.term.toLowerCase().includes(q) || t.definition.toLowerCase().includes(q) || t.term_id.toLowerCase().includes(q));
  }
  return out.map((t) => ({ ...t, related_term_ids: t.related_term_ids ? [...t.related_term_ids] : undefined }));
}

export function getGlossaryTerm(term_id: string): GlossaryTerm | null {
  const found = GLOSSARY_TERMS.find((t) => t.term_id === term_id);
  if (!found) return null;
  return { ...found, related_term_ids: found.related_term_ids ? [...found.related_term_ids] : undefined };
}

export function listGlossaryCategories(): GlossaryCategory[] {
  return ALL_GLOSSARY_CATEGORIES.slice();
}
