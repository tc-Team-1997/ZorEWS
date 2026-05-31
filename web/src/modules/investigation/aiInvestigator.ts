// AI Investigator — pure-function explanation + recommendation framework.
// Production swap: real Claude / Bedrock LLM call producing the same shape.

import {
  type InvestigationKind,
  type InvestigationDomain,
} from './investigationEngine';

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RelatedEntityKind =
  | 'alert'
  | 'case'
  | 'borrower'
  | 'policy'
  | 'customer'
  | 'agent'
  | 'branch';

export interface RelatedEntity {
  kind: RelatedEntityKind;
  entity_id: string;
  label: string;
  similarity_score: number;
  rationale: string;
}

export interface RiskDriver {
  driver_id: string;
  label: string;
  shap_value: number;
  direction: 'up' | 'down';
  human_value: string;
}

export type RecommendationPriority = 'low' | 'medium' | 'high';
export type RecommendationCategory =
  | 'evidence'
  | 'interview'
  | 'verification'
  | 'escalation'
  | 'closure';

export interface InvestigationRecommendation {
  recommendation_id: string;
  title: string;
  description: string;
  priority: RecommendationPriority;
  category: RecommendationCategory;
}

export interface AIInvestigationReport {
  investigation_id: string;
  tenant_id: string;
  generated_at: string;
  confidence: number;
  model_id: 'investigator-llm';
  model_version: '1.0.0';
  root_cause_analysis: string;
  related_alerts: RelatedEntity[];
  related_cases: RelatedEntity[];
  related_borrowers: RelatedEntity[];
  related_policies: RelatedEntity[];
  related_customers: RelatedEntity[];
  risk_drivers: RiskDriver[];
  recommendations: InvestigationRecommendation[];
}

export const ROOT_CAUSE_TEMPLATES: Record<InvestigationKind, string[]> = {
  borrower: [
    'Borrower shows persistent stress signals across DPD + utilisation. Bureau score deteriorated over the 60-day window. Cross-product exposure crossed the concentration limit.',
    'Repayment delay streak compounded with falling income credits. Salary cadence broke vs the prior 12-month pattern. Watchlist flag raised on cross-product cascade.',
    'Behavioural decline on the deposit side preceded the credit signal. Outflow z-score above 2.5 sigma. Customer 360 shows reduced relationship intensity in last 90 days.',
    'Borrower exhibits early-warning markers consistent with restructure-eligible segment. Recent utilisation spike on revolver plus DPD creep on term loan.',
  ],
  sma: [
    'Account stepped from SMA-0 into SMA-1 within the quarter. Repayment delay streak indicates persistent partial servicing rather than total default. NPA migration probability elevated.',
    'SMA classification driven by overdue interest accrual rather than principal default. Pattern aligns with stress-but-willing borrower segment.',
    'Account oscillated between SMA buckets twice in 90 days indicating cashflow lumpiness. Standard restructure paths likely applicable.',
  ],
  npa: [
    'Account crossed 90-DPD threshold and triggered NPA classification. Loss given default modelling estimates 35-55% recovery on collateral net of haircuts.',
    'NPA tag fired after extended SMA-2 dwell. Borrower contact unsuccessful for 21 days. Field-visit + legal escalation track recommended.',
    'Cross-product NPA cascade — primary loan in NPA pulled the linked OD facility into substandard. Concentration review warranted.',
  ],
  fraud: [
    'Pattern matches velocity-fraud cluster. Channel anomaly score elevated alongside geo-distance signal. Withdrawal cadence falls outside the customer baseline.',
    'Transaction sequence aligns with mule-account typology. Rapid inflow-outflow with low retention. Beneficiary fan-out exceeds 5 fresh accounts in 24 hours.',
    'Document fingerprints fall outside expected template range. KYC photo embeddings show distance from prior submissions. Application-fraud investigation warranted.',
    'Identity-overlay risk surfaced — phone + device + IP triangulation links to a previously closed fraud case. Cross-reference recommended.',
  ],
  collections: [
    'Collections case shows broken-promise pattern across 3 consecutive cycles. Field-visit success rate below branch baseline. Re-tier to senior officer recommended.',
    'Customer-contact rate degraded over 30-day window. Outbound calls answered fell from 78% to 22%. Geo-pinned field visit may be required.',
    'Partial-payment cadence suggests cashflow constraint not willingness gap. Restructure proposal worth modelling before legal escalation.',
  ],
  sector_risk: [
    'Sector-level stress signals emerging — concentration in textiles + auto-ancillary above appetite. Macro overlay (rate hike, FX) amplifies vulnerability.',
    'Geographic concentration in regions impacted by recent regulatory action. Portfolio review at branch + product cohort level recommended.',
    'Co-movement of indicators across the sector cohort exceeds historical norms. Single-factor stress propagating through linked supply chain.',
  ],
  claim_fraud: [
    'Pattern matches the repeat-claim cluster. Hospital + claim-reason intersect known watchlist. Document fingerprints fall outside expected template range.',
    'Claim filed within suspect proximity of policy issuance. Waiting-period breach probability elevated. Insured + provider history shows prior flagged interactions.',
    'Amount deviation exceeds 30% of segment baseline for the procedure code. Off-template document detected on second medical certificate.',
    'Rapid policy-to-claim window combined with missing supporting documents. Investigation should prioritise provider verification + insured interview.',
  ],
  policy_risk: [
    'Policy shows lapse-imminent markers. Premium-due streak crossed 45 days. Persistency at the customer-cohort level dropped 8 percentage points in the quarter.',
    'Surrender-likelihood score elevated by recent portal activity. Insured browsed alternative-product pages 4 times in 30 days.',
    'Policy at-risk due to compound issues — agent attrition + payment-mode change + missed renewal notification window.',
  ],
  underwriting: [
    'High-risk proposal detected — sum-assured-to-income ratio above appetite. Disclosure gaps on medical history flagged by NLP review.',
    'Proposal triggers three of five Form-K underwriting flags. Manual UW review recommended before issuance.',
    'Anti-selection signals — applicant browsed claim-payout calculator multiple times before submitting proposal. Lifestyle disclosures inconsistent with declared occupation.',
  ],
  agent: [
    'Agent shows abnormal lapse contribution. Persistency 12% below branch median over last 2 quarters. Cancellation cluster in single product line.',
    'Agent productivity metrics consistent with shadow-broker pattern. Geographic spread of policies issued exceeds typical individual-agent radius.',
    'Mis-selling signals emerging — complaint rate elevated, policies sold to outside-target demographic, surrender within freelook period above peer baseline.',
  ],
  channel: [
    'Channel-level anomaly — digital onboarding conversion dropped while drop-off at OTP step spiked. Possible technical or fraud-screening regression.',
    'Bancassurance channel showing unusual cancellation-within-freelook pattern. Co-ordination with partner bank compliance recommended.',
    'Aggregator channel mix shifted toward higher-risk segment. Underwriting filter calibration review warranted.',
  ],
  solvency: [
    'Solvency-ratio stress flagged — projected ratio under adverse scenario falls below regulatory minimum. Capital action plan should be modelled.',
    'IRDAI Form-K solvency margin under severely-adverse scenario approaches breach threshold. Quarterly stress test should be re-run with refreshed claim assumptions.',
    'Asset-liability mismatch widening — duration gap stretched 0.8 years over last quarter. Tactical re-balancing recommended.',
  ],
};

interface BankingFeatureSpec {
  driver_id: string;
  label: string;
  shapMin: number;
  shapMax: number;
  formatValue: (rng: () => number) => string;
}

const BANKING_FEATURE_POOL: BankingFeatureSpec[] = [
  {
    driver_id: 'dpd_max_90d',
    label: 'Max DPD (90d)',
    shapMin: 0.25,
    shapMax: 0.62,
    formatValue: (rng) => `DPD = ${Math.floor(15 + rng() * 65)} days`,
  },
  {
    driver_id: 'utilization',
    label: 'Credit utilisation',
    shapMin: 0.18,
    shapMax: 0.5,
    formatValue: (rng) => `utilisation = ${Math.floor(72 + rng() * 25)}%`,
  },
  {
    driver_id: 'bureau_score',
    label: 'Bureau score',
    shapMin: 0.15,
    shapMax: 0.42,
    formatValue: (rng) => `score = ${Math.floor(540 + rng() * 110)}`,
  },
  {
    driver_id: 'repayment_delay_streak',
    label: 'Repayment delay streak',
    shapMin: 0.12,
    shapMax: 0.38,
    formatValue: (rng) => `${Math.floor(2 + rng() * 5)} consecutive missed cycles`,
  },
  {
    driver_id: 'income_drop_pct',
    label: 'Income credit drop',
    shapMin: 0.1,
    shapMax: 0.34,
    formatValue: (rng) => `salary credit down ${Math.floor(18 + rng() * 32)}%`,
  },
];

const INSURANCE_FEATURE_POOL: BankingFeatureSpec[] = [
  {
    driver_id: 'premium_due_days',
    label: 'Premium overdue',
    shapMin: 0.22,
    shapMax: 0.58,
    formatValue: (rng) => `${Math.floor(28 + rng() * 60)} days past due`,
  },
  {
    driver_id: 'claim_freq_180d',
    label: 'Claim frequency (180d)',
    shapMin: 0.2,
    shapMax: 0.52,
    formatValue: (rng) => `${Math.floor(2 + rng() * 4)} claims in last 180d`,
  },
  {
    driver_id: 'agent_persistency',
    label: 'Agent persistency',
    shapMin: 0.14,
    shapMax: 0.4,
    formatValue: (rng) => `persistency = ${Math.floor(55 + rng() * 25)}%`,
  },
  {
    driver_id: 'portal_login_drop',
    label: 'Portal engagement drop',
    shapMin: 0.1,
    shapMax: 0.32,
    formatValue: (rng) => `logins down ${Math.floor(40 + rng() * 45)}% (30d)`,
  },
  {
    driver_id: 'solvency_ratio',
    label: 'Solvency ratio proxy',
    shapMin: 0.12,
    shapMax: 0.36,
    formatValue: (rng) => `cohort ratio = ${(1.45 + rng() * 0.4).toFixed(2)}`,
  },
];

interface RecommendationSpec {
  recommendation_id: string;
  title: string;
  description: string;
  priority: RecommendationPriority;
  category: RecommendationCategory;
}

const RECOMMENDATION_POOL: RecommendationSpec[] = [
  {
    recommendation_id: 'collect_additional_docs',
    title: 'Collect additional documents',
    description:
      'Request supplementary KYC + income proofs to close the evidence gap. Upload via the case attachments tab.',
    priority: 'medium',
    category: 'evidence',
  },
  {
    recommendation_id: 'interview_customer',
    title: 'Schedule customer interview',
    description:
      'Set up a structured interview to validate the disclosures + capture intent signals. Use the standard questionnaire.',
    priority: 'medium',
    category: 'interview',
  },
  {
    recommendation_id: 'verify_kyc',
    title: 'Re-verify KYC artefacts',
    description:
      'Run KYC artefacts through the verification adapter. Cross-check ID embeddings against prior submissions.',
    priority: 'high',
    category: 'verification',
  },
  {
    recommendation_id: 'cross_check_with_bureau',
    title: 'Cross-check with bureau',
    description:
      'Pull a fresh bureau report to confirm exposure across other lenders. Compare against the in-case snapshot.',
    priority: 'medium',
    category: 'verification',
  },
  {
    recommendation_id: 'escalate_to_supervisor',
    title: 'Escalate to supervisor',
    description:
      'Risk indicators justify supervisor review before next action. Use the in-app escalate button with rationale.',
    priority: 'high',
    category: 'escalation',
  },
  {
    recommendation_id: 'launch_field_visit',
    title: 'Launch field visit',
    description:
      'Dispatch the field officer to the registered address for in-person verification. Capture GPS-tagged evidence.',
    priority: 'high',
    category: 'evidence',
  },
  {
    recommendation_id: 'freeze_disbursement',
    title: 'Freeze pending disbursement',
    description:
      'Hold any pending disbursement until the investigation closes. Apply the temporary block in CBS.',
    priority: 'high',
    category: 'escalation',
  },
  {
    recommendation_id: 'consult_legal',
    title: 'Consult legal team',
    description:
      'Flag to legal for advisory on enforcement options. Attach the full evidence package to the consult ticket.',
    priority: 'medium',
    category: 'escalation',
  },
  {
    recommendation_id: 'capture_evidence_signoff',
    title: 'Capture evidence sign-off',
    description:
      'Confirm chain-of-custody on key documents + record the maker-checker approval before progression.',
    priority: 'low',
    category: 'evidence',
  },
  {
    recommendation_id: 'close_case_with_decision',
    title: 'Close case with decision',
    description:
      'Sufficient evidence gathered. Record the final decision + outcome notes and trigger the close workflow.',
    priority: 'low',
    category: 'closure',
  },
];

function deterministicPick<T>(arr: readonly T[], rng: () => number): T {
  const idx = Math.floor(rng() * arr.length);
  return arr[Math.min(idx, arr.length - 1)];
}

function pickN<T>(arr: readonly T[], n: number, rng: () => number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[Math.min(idx, pool.length - 1)]);
    pool.splice(idx, 1);
  }
  return out;
}

function isoFromAsOf(asOf: Date): string {
  const y = asOf.getUTCFullYear();
  const m = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const d = String(asOf.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}T08:00:00Z`;
}

function padId(prefix: string, n: number, rng: () => number): string {
  const num = Math.floor(rng() * 9999) + 1;
  return `${prefix}-${String(num).padStart(n, '0')}`;
}

function buildRelatedAlerts(rng: () => number): RelatedEntity[] {
  const count = 2 + Math.floor(rng() * 3);
  const out: RelatedEntity[] = [];
  for (let i = 0; i < count; i++) {
    const id = padId('ALERT', 4, rng);
    const sim = 0.5 + rng() * 0.45;
    out.push({
      kind: 'alert',
      entity_id: id,
      label: `Alert ${id}`,
      similarity_score: Math.round(sim * 100) / 100,
      rationale: 'Shares indicator family + customer segment with this investigation',
    });
  }
  return out;
}

function buildRelatedCases(rng: () => number): RelatedEntity[] {
  const count = 1 + Math.floor(rng() * 3);
  const out: RelatedEntity[] = [];
  for (let i = 0; i < count; i++) {
    const id = padId('CASE', 4, rng);
    const sim = 0.55 + rng() * 0.4;
    out.push({
      kind: 'case',
      entity_id: id,
      label: `Case ${id}`,
      similarity_score: Math.round(sim * 100) / 100,
      rationale: 'Similar resolution pattern in same product cohort within 90 days',
    });
  }
  return out;
}

function buildRelatedBorrowers(rng: () => number): RelatedEntity[] {
  const count = 1 + Math.floor(rng() * 3);
  const out: RelatedEntity[] = [];
  for (let i = 0; i < count; i++) {
    const id = padId('BORROWER', 4, rng);
    const sim = 0.5 + rng() * 0.4;
    out.push({
      kind: 'borrower',
      entity_id: id,
      label: `Borrower ${id}`,
      similarity_score: Math.round(sim * 100) / 100,
      rationale: 'Comparable exposure + DPD trajectory in the same branch portfolio',
    });
  }
  return out;
}

function buildRelatedPolicies(rng: () => number): RelatedEntity[] {
  const count = 1 + Math.floor(rng() * 3);
  const out: RelatedEntity[] = [];
  for (let i = 0; i < count; i++) {
    const id = padId('POLICY', 4, rng);
    const sim = 0.5 + rng() * 0.4;
    out.push({
      kind: 'policy',
      entity_id: id,
      label: `Policy ${id}`,
      similarity_score: Math.round(sim * 100) / 100,
      rationale: 'Same product family + payment-mode pattern as this policy',
    });
  }
  return out;
}

function buildRelatedCustomers(rng: () => number): RelatedEntity[] {
  const count = 1 + Math.floor(rng() * 3);
  const out: RelatedEntity[] = [];
  for (let i = 0; i < count; i++) {
    const id = padId('CUST', 4, rng);
    const sim = 0.5 + rng() * 0.4;
    out.push({
      kind: 'customer',
      entity_id: id,
      label: `Customer ${id}`,
      similarity_score: Math.round(sim * 100) / 100,
      rationale: 'Cross-product relationship + similar 360 signal mix',
    });
  }
  return out;
}

function buildRiskDrivers(
  domain: InvestigationDomain,
  rng: () => number,
): RiskDriver[] {
  const pool =
    domain === 'banking' ? BANKING_FEATURE_POOL : INSURANCE_FEATURE_POOL;
  const drivers: RiskDriver[] = pool.map((spec) => {
    const magnitude = spec.shapMin + rng() * (spec.shapMax - spec.shapMin);
    const direction: 'up' | 'down' = rng() < 0.85 ? 'up' : 'down';
    const signed = direction === 'up' ? magnitude : -magnitude;
    return {
      driver_id: spec.driver_id,
      label: spec.label,
      shap_value: Math.round(signed * 1000) / 1000,
      direction,
      human_value: spec.formatValue(rng),
    };
  });
  drivers.sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value));
  return drivers;
}

function buildRecommendations(
  rng: () => number,
): InvestigationRecommendation[] {
  const count = 3 + Math.floor(rng() * 3);
  const picks = pickN(RECOMMENDATION_POOL, count, rng);
  return picks.map((spec) => ({
    recommendation_id: spec.recommendation_id,
    title: spec.title,
    description: spec.description,
    priority: spec.priority,
    category: spec.category,
  }));
}

export function buildAIInvestigationReport(
  investigation_id: string,
  tenant_id: string,
  kind: InvestigationKind,
  domain: InvestigationDomain,
  asOf?: Date,
): AIInvestigationReport {
  const at = asOf ?? new Date();
  const day = Math.floor(at.getTime() / 86_400_000);
  const seed = fnv1a(`${tenant_id}|${investigation_id}|${kind}|${domain}|${day}`);
  const rng = mulberry32(seed);

  const templates = ROOT_CAUSE_TEMPLATES[kind] ?? [
    'Investigation under review with mixed early-warning signals.',
  ];
  const root_cause_analysis = deterministicPick(templates, rng);

  const confidence = Math.round((0.65 + rng() * 0.27) * 100) / 100;

  const related_alerts = buildRelatedAlerts(rng);
  const related_cases = buildRelatedCases(rng);
  const related_borrowers =
    domain === 'banking' ? buildRelatedBorrowers(rng) : [];
  const related_policies =
    domain === 'insurance' ? buildRelatedPolicies(rng) : [];
  const related_customers = buildRelatedCustomers(rng);
  const risk_drivers = buildRiskDrivers(domain, rng);
  const recommendations = buildRecommendations(rng);

  return {
    investigation_id,
    tenant_id,
    generated_at: isoFromAsOf(at),
    confidence,
    model_id: 'investigator-llm',
    model_version: '1.0.0',
    root_cause_analysis,
    related_alerts,
    related_cases,
    related_borrowers,
    related_policies,
    related_customers,
    risk_drivers,
    recommendations,
  };
}
