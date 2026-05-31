// Regulatory Compliance Center — pure resolver. 13th IA overlay (additive).
// Foundational engine module: declares every shared closed enum, type alias,
// and obligation/workflow primitive consumed by sibling resolver modules.
// No I/O, no React, no async, deterministic.

// ============================================================================
// FNV-1a + Mulberry32 deterministic synthesis helpers
// ============================================================================

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

function dayIndex(asOf: Date): number {
  return Math.floor(asOf.getTime() / 86_400_000);
}

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

function toIsoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

function toIsoTimestamp(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}T${pad(
    d.getUTCHours(),
    2,
  )}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.000Z`;
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

function pickIndex<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

// ============================================================================
// SHARED CLOSED ENUMS
// ============================================================================

export const REGULATORY_DOMAINS = ['banking', 'insurance'] as const;
export type RegulatoryDomain = (typeof REGULATORY_DOMAINS)[number];

export const BANKING_FRAMEWORKS = [
  'rbi',
  'basel_iii',
  'basel_iv',
  'aml',
  'kyc',
  'credit_risk',
  'operational_risk',
  'regulatory_filings',
] as const;
export type BankingFramework = (typeof BANKING_FRAMEWORKS)[number];

export const INSURANCE_FRAMEWORKS = [
  'irdai',
  'solvency',
  'claims_governance',
  'policy_governance',
  'persistency',
  'fraud_compliance',
  'underwriting_compliance',
  'regulatory_filings_insurance',
] as const;
export type InsuranceFramework = (typeof INSURANCE_FRAMEWORKS)[number];

export type RegulatoryFramework = BankingFramework | InsuranceFramework;

export const OBLIGATION_CATEGORIES = [
  'filing',
  'review',
  'audit',
  'submission',
  'board_review',
  'monitoring',
] as const;
export type ObligationCategory = (typeof OBLIGATION_CATEGORIES)[number];

export const OBLIGATION_STATUSES = [
  'compliant',
  'at_risk',
  'overdue',
  'in_review',
  'closed',
] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export const REVIEW_FREQUENCIES = [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'semi_annual',
  'annual',
  'ad_hoc',
] as const;
export type ReviewFrequency = (typeof REVIEW_FREQUENCIES)[number];

export const COMPLIANCE_WORKFLOW_STATUSES = [
  'draft',
  'under_review',
  'approved',
  'submitted',
  'closed',
] as const;
export type ComplianceWorkflowStatus = (typeof COMPLIANCE_WORKFLOW_STATUSES)[number];

export const COMPLIANCE_WORKFLOW_ACTIONS = [
  'assign',
  'review',
  'approve',
  'reject',
  'escalate',
  'submit',
] as const;
export type ComplianceWorkflowAction = (typeof COMPLIANCE_WORKFLOW_ACTIONS)[number];

export const FINDING_SEVERITIES = [
  'low',
  'moderate',
  'high',
  'severe',
  'critical',
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = [
  'open',
  'in_progress',
  'remediated',
  'accepted_risk',
  'closed',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const REPORT_FORMATS = ['pdf', 'excel', 'csv'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_KINDS = [
  'rbi',
  'basel',
  'aml',
  'kyc',
  'irdai',
  'solvency',
  'fraud',
  'executive_compliance',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REGULATORY_ROLES = [
  'super_admin',
  'country_admin',
  'compliance_officer',
  'auditor',
  'risk_analyst',
  'fraud_analyst',
  'cro',
  'ceo',
  'cfo',
  'coo',
  'board_member',
  'country_head',
  'admin',
  'supervisor',
  'executive',
] as const;
export type RegulatoryRole = (typeof REGULATORY_ROLES)[number];

export function canAccessRegulatoryCenter(roles?: string[]): boolean {
  if (!roles || roles.length === 0) return false;
  for (const role of roles) {
    if ((REGULATORY_ROLES as readonly string[]).includes(role)) return true;
  }
  return false;
}

// ============================================================================
// Obligation Registry
// ============================================================================

export interface ComplianceObligation {
  obligation_id: string;
  tenant_id: string;
  regulation: string;
  framework: RegulatoryFramework;
  domain: RegulatoryDomain;
  clause: string;
  category: ObligationCategory;
  owner: string;
  review_frequency: ReviewFrequency;
  status: ObligationStatus;
  last_review_date: string;
  next_due_date: string;
  priority: FindingSeverity;
  description: string;
  evidence_required: boolean;
}

// ============================================================================
// Workflow transitions
// ============================================================================

export const WORKFLOW_TRANSITIONS: Record<
  ComplianceWorkflowStatus,
  ComplianceWorkflowStatus[]
> = {
  draft: ['under_review'],
  under_review: ['approved', 'draft', 'closed'],
  approved: ['submitted', 'closed'],
  submitted: ['closed'],
  closed: ['draft'],
};

export function canTransition(
  from: ComplianceWorkflowStatus,
  to: ComplianceWorkflowStatus,
): boolean {
  const allowed = WORKFLOW_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

// ============================================================================
// Framework catalog
// ============================================================================

export interface RegulatoryFrameworkDef {
  framework: RegulatoryFramework;
  domain: RegulatoryDomain;
  label: string;
  regulator: string;
  description: string;
  primary_geography: string;
}

export const REGULATORY_FRAMEWORKS: readonly RegulatoryFrameworkDef[] = [
  // ---- Banking (8) ----
  {
    framework: 'rbi',
    domain: 'banking',
    label: 'RBI Master Circulars',
    regulator: 'Reserve Bank of India',
    description:
      'Master Circulars covering asset classification, provisioning, IRAC norms, and prudential guidelines.',
    primary_geography: 'IN',
  },
  {
    framework: 'basel_iii',
    domain: 'banking',
    label: 'Basel III Pillar I/II/III',
    regulator: 'Basel Committee on Banking Supervision',
    description:
      'Capital adequacy (Pillar I), supervisory review (Pillar II), and market discipline (Pillar III) requirements.',
    primary_geography: 'global',
  },
  {
    framework: 'basel_iv',
    domain: 'banking',
    label: 'Basel IV — Final Output Floor',
    regulator: 'Basel Committee on Banking Supervision',
    description:
      'Revised standardised approaches for credit, operational, and market risk plus 72.5% output floor on internal models.',
    primary_geography: 'global',
  },
  {
    framework: 'aml',
    domain: 'banking',
    label: 'Anti-Money Laundering (PMLA)',
    regulator: 'Financial Intelligence Unit — India',
    description:
      'PMLA-aligned suspicious transaction reporting, sanctions screening, and watchlist surveillance.',
    primary_geography: 'IN',
  },
  {
    framework: 'kyc',
    domain: 'banking',
    label: 'KYC / Customer Due Diligence',
    regulator: 'Reserve Bank of India',
    description:
      'Customer Identification Programme, periodic KYC refresh cadence, and enhanced due diligence for high-risk segments.',
    primary_geography: 'IN',
  },
  {
    framework: 'credit_risk',
    domain: 'banking',
    label: 'Credit Risk — IRAC + IFRS 9',
    regulator: 'Reserve Bank of India',
    description:
      'Asset classification, ECL staging, and provisioning under IRAC + IFRS 9 frameworks.',
    primary_geography: 'IN',
  },
  {
    framework: 'operational_risk',
    domain: 'banking',
    label: 'Operational Risk Management',
    regulator: 'Reserve Bank of India',
    description:
      'Internal loss data collection, KRI monitoring, BCP / DR governance, and operational resilience requirements.',
    primary_geography: 'IN',
  },
  {
    framework: 'regulatory_filings',
    domain: 'banking',
    label: 'RBI Regulatory Returns / Filings',
    regulator: 'Reserve Bank of India',
    description:
      'DSB-I/II/III returns, RBS-aligned XBRL submissions, and statutory reporting cadence to the supervisor.',
    primary_geography: 'IN',
  },
  // ---- Insurance (8) ----
  {
    framework: 'irdai',
    domain: 'insurance',
    label: 'IRDAI Form-K Submissions',
    regulator: 'Insurance Regulatory and Development Authority of India',
    description:
      'IRDAI regulatory return suite covering Form-K, public disclosures, and ULIP / participating fund reporting.',
    primary_geography: 'IN',
  },
  {
    framework: 'solvency',
    domain: 'insurance',
    label: 'Solvency II-aligned ALSM',
    regulator: 'IRDAI',
    description:
      'Available solvency margin vs required solvency margin reporting per IRDAI ALSM regulations.',
    primary_geography: 'IN',
  },
  {
    framework: 'claims_governance',
    domain: 'insurance',
    label: 'Claims Governance & TAT',
    regulator: 'IRDAI',
    description:
      'Claims settlement turnaround, repudiation governance, and grievance redressal monitoring.',
    primary_geography: 'IN',
  },
  {
    framework: 'policy_governance',
    domain: 'insurance',
    label: 'Policy Governance & Free-Look',
    regulator: 'IRDAI',
    description:
      'Proposal acceptance, free-look compliance, mid-term endorsement, and surrender value governance.',
    primary_geography: 'IN',
  },
  {
    framework: 'persistency',
    domain: 'insurance',
    label: 'Persistency Reporting',
    regulator: 'IRDAI',
    description:
      '13/25/37/49/61-month persistency reporting against IRDAI prescribed cohorts.',
    primary_geography: 'IN',
  },
  {
    framework: 'fraud_compliance',
    domain: 'insurance',
    label: 'Insurance Fraud Compliance',
    regulator: 'IRDAI',
    description:
      'IRDAI Fraud Monitoring Framework — board reporting, AFR cell governance, and red-flag investigation.',
    primary_geography: 'IN',
  },
  {
    framework: 'underwriting_compliance',
    domain: 'insurance',
    label: 'Underwriting Compliance',
    regulator: 'IRDAI',
    description:
      'Underwriting policy adherence, risk-based pricing controls, and treaty / facultative compliance.',
    primary_geography: 'IN',
  },
  {
    framework: 'regulatory_filings_insurance',
    domain: 'insurance',
    label: 'IRDAI Regulatory Returns',
    regulator: 'IRDAI',
    description:
      'Quarterly + annual statutory returns covering business, investments, expense-of-management, and public disclosures.',
    primary_geography: 'IN',
  },
];

export function listFrameworks(domain?: RegulatoryDomain): RegulatoryFrameworkDef[] {
  if (!domain) return REGULATORY_FRAMEWORKS.slice();
  return REGULATORY_FRAMEWORKS.filter((f) => f.domain === domain);
}

export function getFramework(
  framework: RegulatoryFramework,
): RegulatoryFrameworkDef | null {
  const match = REGULATORY_FRAMEWORKS.find((f) => f.framework === framework);
  return match ?? null;
}

// ============================================================================
// Obligation generation
// ============================================================================

const BANKING_REGULATIONS: Record<BankingFramework, string[]> = {
  rbi: [
    'RBI Master Circular — Asset Classification',
    'RBI Master Direction — Prudential Norms',
    'RBI Circular — IRAC Provisioning',
  ],
  basel_iii: [
    'Basel III — Capital Adequacy (Pillar I)',
    'Basel III — Liquidity Coverage Ratio',
    'Basel III — Pillar III Disclosures',
  ],
  basel_iv: [
    'Basel IV — Standardised Credit Risk',
    'Basel IV — Output Floor Calibration',
    'Basel IV — Revised Operational Risk',
  ],
  aml: [
    'PMLA — Suspicious Transaction Reporting',
    'AML — Sanctions Screening Programme',
    'AML — Cash Transaction Reporting',
  ],
  kyc: [
    'KYC — Periodic Refresh Programme',
    'KYC — Enhanced Due Diligence',
    'KYC — Customer Identification Procedure',
  ],
  credit_risk: [
    'Credit Risk — IFRS 9 Stage Migration',
    'Credit Risk — ECL Methodology Review',
    'Credit Risk — Concentration Reporting',
  ],
  operational_risk: [
    'Operational Risk — KRI Monitoring',
    'Operational Risk — Loss Data Collection',
    'Operational Risk — BCP Annual Review',
  ],
  regulatory_filings: [
    'RBI — DSB Returns Submission',
    'RBI — RBS XBRL Filing',
    'RBI — Off-site Surveillance Return',
  ],
};

const INSURANCE_REGULATIONS: Record<InsuranceFramework, string[]> = {
  irdai: [
    'IRDAI — Form-K Quarterly Submission',
    'IRDAI — Public Disclosure Compliance',
    'IRDAI — ULIP Disclosure Filing',
  ],
  solvency: [
    'ALSM — Solvency Margin Reporting',
    'ALSM — Required Capital Computation',
    'ALSM — Stress Test Submission',
  ],
  claims_governance: [
    'Claims — TAT Governance Review',
    'Claims — Repudiation Audit',
    'Claims — Grievance Redressal Cycle',
  ],
  policy_governance: [
    'Policy — Free-Look Compliance',
    'Policy — Surrender Value Audit',
    'Policy — Proposal Acceptance Review',
  ],
  persistency: [
    'Persistency — 13-Month Cohort Reporting',
    'Persistency — 37-Month Cohort Review',
    'Persistency — 61-Month Cohort Audit',
  ],
  fraud_compliance: [
    'Fraud — AFR Board Reporting',
    'Fraud — Red-Flag Investigation Closure',
    'Fraud — Annual Fraud Monitoring Return',
  ],
  underwriting_compliance: [
    'Underwriting — Policy Adherence Audit',
    'Underwriting — Treaty Compliance Review',
    'Underwriting — Risk-Based Pricing Audit',
  ],
  regulatory_filings_insurance: [
    'IRDAI — Quarterly Business Return',
    'IRDAI — Annual Investment Return',
    'IRDAI — Expense of Management Filing',
  ],
};

const CLAUSE_SAMPLES = [
  'Para 4.2.1',
  'Para 5.1.3',
  'Para 6.4',
  'Para 7.2.2',
  'Para 8.1',
  'Para 2.3.4',
  'Para 9.5',
  'Para 3.6.1',
];

const FREQUENCY_DELTA_DAYS: Record<ReviewFrequency, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 91,
  semi_annual: 182,
  annual: 365,
  ad_hoc: 45,
};

function obligationCategoryFor(framework: RegulatoryFramework): ObligationCategory {
  if (framework === 'regulatory_filings' || framework === 'regulatory_filings_insurance' || framework === 'irdai') {
    return 'filing';
  }
  if (framework === 'basel_iii' || framework === 'basel_iv' || framework === 'solvency') {
    return 'submission';
  }
  if (framework === 'aml' || framework === 'kyc' || framework === 'fraud_compliance') {
    return 'monitoring';
  }
  if (framework === 'credit_risk' || framework === 'underwriting_compliance' || framework === 'policy_governance') {
    return 'review';
  }
  if (framework === 'operational_risk' || framework === 'claims_governance' || framework === 'persistency') {
    return 'audit';
  }
  if (framework === 'rbi') {
    return 'review';
  }
  return 'board_review';
}

function statusForBucket(bucket: number): ObligationStatus {
  // Distribution: ~50% compliant, 25% at_risk, 10% overdue, 10% in_review, 5% closed.
  if (bucket < 50) return 'compliant';
  if (bucket < 75) return 'at_risk';
  if (bucket < 85) return 'overdue';
  if (bucket < 95) return 'in_review';
  return 'closed';
}

function frequencyForBucket(bucket: number): ReviewFrequency {
  if (bucket < 14) return 'daily';
  if (bucket < 28) return 'weekly';
  if (bucket < 44) return 'monthly';
  if (bucket < 60) return 'quarterly';
  if (bucket < 74) return 'semi_annual';
  if (bucket < 90) return 'annual';
  return 'ad_hoc';
}

function priorityForBucket(bucket: number): FindingSeverity {
  if (bucket < 30) return 'low';
  if (bucket < 55) return 'moderate';
  if (bucket < 80) return 'high';
  if (bucket < 95) return 'severe';
  return 'critical';
}

function buildObligation(
  seq: number,
  tenant_id: string,
  asOf: Date,
  framework: RegulatoryFramework,
  domain: RegulatoryDomain,
): ComplianceObligation {
  const seed = fnv1a(`${tenant_id}|${dayIndex(asOf)}|obligation|${seq}|${framework}`);
  const rng = mulberry32(seed);

  const pool =
    domain === 'banking'
      ? BANKING_REGULATIONS[framework as BankingFramework]
      : INSURANCE_REGULATIONS[framework as InsuranceFramework];
  const regulation = pickIndex(rng, pool);
  const clause = pickIndex(rng, CLAUSE_SAMPLES);

  const statusBucket = Math.floor(rng() * 100);
  const status = statusForBucket(statusBucket);

  const frequencyBucket = Math.floor(rng() * 100);
  const review_frequency = frequencyForBucket(frequencyBucket);

  const priorityBucket = Math.floor(rng() * 100);
  const priority = priorityForBucket(priorityBucket);

  const ownerNumber = (seq % 12) + 1;
  const owner = `compliance.${pad(ownerNumber, 2)}`;

  const lastReviewOffset = Math.floor(rng() * 181); // 0..180 days back
  const lastReview = addDays(asOf, -lastReviewOffset);
  const last_review_date = toIsoDate(lastReview);

  const delta = FREQUENCY_DELTA_DAYS[review_frequency];
  const nextDue = addDays(lastReview, delta);
  const next_due_date = toIsoDate(nextDue);

  const category = obligationCategoryFor(framework);

  const description = `${regulation} — ${clause} requires ${review_frequency.replace(
    '_',
    ' ',
  )} ${category} for ${domain} domain (framework ${framework}).`;

  return {
    obligation_id: `OB-${pad(seq + 1, 5)}`,
    tenant_id,
    regulation,
    framework,
    domain,
    clause,
    category,
    owner,
    review_frequency,
    status,
    last_review_date,
    next_due_date,
    priority,
    description,
    evidence_required: rng() < 0.7,
  };
}

function generateObligations(tenant_id: string, asOf: Date): ComplianceObligation[] {
  const out: ComplianceObligation[] = [];

  // 20 banking obligations (spread across 8 banking frameworks).
  for (let i = 0; i < 20; i++) {
    const framework = BANKING_FRAMEWORKS[i % BANKING_FRAMEWORKS.length];
    out.push(buildObligation(i, tenant_id, asOf, framework, 'banking'));
  }

  // 20 insurance obligations (spread across 8 insurance frameworks).
  for (let i = 0; i < 20; i++) {
    const seq = 20 + i;
    const framework = INSURANCE_FRAMEWORKS[i % INSURANCE_FRAMEWORKS.length];
    out.push(buildObligation(seq, tenant_id, asOf, framework, 'insurance'));
  }

  // Sort by next_due_date asc (earliest-due first); tie-break by obligation_id.
  out.sort((a, b) => {
    if (a.next_due_date < b.next_due_date) return -1;
    if (a.next_due_date > b.next_due_date) return 1;
    if (a.obligation_id < b.obligation_id) return -1;
    if (a.obligation_id > b.obligation_id) return 1;
    return 0;
  });

  return out;
}

export function listObligations(
  tenant_id: string,
  asOf?: Date,
  filters?: {
    framework?: RegulatoryFramework;
    domain?: RegulatoryDomain;
    status?: ObligationStatus;
    category?: ObligationCategory;
  },
): ComplianceObligation[] {
  const effectiveAsOf = asOf ?? new Date();
  let rows = generateObligations(tenant_id, effectiveAsOf);

  if (filters?.framework) {
    rows = rows.filter((r) => r.framework === filters.framework);
  }
  if (filters?.domain) {
    rows = rows.filter((r) => r.domain === filters.domain);
  }
  if (filters?.status) {
    rows = rows.filter((r) => r.status === filters.status);
  }
  if (filters?.category) {
    rows = rows.filter((r) => r.category === filters.category);
  }

  return rows;
}

export function getObligation(
  obligation_id: string,
  tenant_id: string,
  asOf?: Date,
): ComplianceObligation | null {
  const rows = generateObligations(tenant_id, asOf ?? new Date());
  const match = rows.find((r) => r.obligation_id === obligation_id);
  return match ?? null;
}

// ============================================================================
// Compliance workflow items
// ============================================================================

export interface ComplianceItem {
  item_id: string;
  tenant_id: string;
  obligation_id: string;
  title: string;
  status: ComplianceWorkflowStatus;
  owner: string;
  reviewer: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  closed_at: string | null;
  notes: string;
}

export function applyWorkflowAction(
  item: ComplianceItem,
  action: ComplianceWorkflowAction,
  actor: string,
): ComplianceItem {
  // Build a defensive shallow copy; never mutate input.
  const base: ComplianceItem = {
    item_id: item.item_id,
    tenant_id: item.tenant_id,
    obligation_id: item.obligation_id,
    title: item.title,
    status: item.status,
    owner: item.owner,
    reviewer: item.reviewer,
    created_at: item.created_at,
    submitted_at: item.submitted_at,
    approved_at: item.approved_at,
    closed_at: item.closed_at,
    notes: item.notes,
  };

  const now = new Date();
  const nowIso = toIsoTimestamp(now);

  switch (action) {
    case 'assign': {
      // Assign updates reviewer; status unchanged.
      return { ...base, reviewer: actor };
    }
    case 'review': {
      if (!canTransition(base.status, 'under_review')) {
        throw new Error('invalid_transition');
      }
      return { ...base, status: 'under_review', reviewer: base.reviewer ?? actor };
    }
    case 'approve': {
      if (!canTransition(base.status, 'approved')) {
        throw new Error('invalid_transition');
      }
      return {
        ...base,
        status: 'approved',
        approved_at: nowIso,
        reviewer: base.reviewer ?? actor,
      };
    }
    case 'reject': {
      if (!canTransition(base.status, 'draft')) {
        throw new Error('invalid_transition');
      }
      return { ...base, status: 'draft' };
    }
    case 'escalate': {
      if (base.status === 'closed') {
        throw new Error('invalid_transition');
      }
      if (base.status === 'under_review') {
        // Already under review; refresh reviewer.
        return { ...base, reviewer: actor };
      }
      if (!canTransition(base.status, 'under_review')) {
        throw new Error('invalid_transition');
      }
      return { ...base, status: 'under_review', reviewer: actor };
    }
    case 'submit': {
      if (!canTransition(base.status, 'submitted')) {
        throw new Error('invalid_transition');
      }
      return { ...base, status: 'submitted', submitted_at: nowIso };
    }
    default: {
      throw new Error('invalid_transition');
    }
  }
}

// 6 draft + 6 under_review + 5 approved + 4 submitted + 3 closed = 24.
const WORKFLOW_STATUS_DISTRIBUTION: ComplianceWorkflowStatus[] = [
  ...Array<ComplianceWorkflowStatus>(6).fill('draft'),
  ...Array<ComplianceWorkflowStatus>(6).fill('under_review'),
  ...Array<ComplianceWorkflowStatus>(5).fill('approved'),
  ...Array<ComplianceWorkflowStatus>(4).fill('submitted'),
  ...Array<ComplianceWorkflowStatus>(3).fill('closed'),
];

function generateComplianceItems(tenant_id: string, asOf: Date): ComplianceItem[] {
  const obligations = generateObligations(tenant_id, asOf);
  const out: ComplianceItem[] = [];

  for (let i = 0; i < WORKFLOW_STATUS_DISTRIBUTION.length; i++) {
    const seed = fnv1a(`${tenant_id}|${dayIndex(asOf)}|compliance_item|${i}`);
    const rng = mulberry32(seed);

    const status = WORKFLOW_STATUS_DISTRIBUTION[i];
    const obligation = obligations[i % obligations.length];

    const ownerNumber = (i % 12) + 1;
    const owner = `compliance.${pad(ownerNumber, 2)}`;

    const hasReviewer =
      status === 'under_review' ||
      status === 'approved' ||
      status === 'submitted' ||
      status === 'closed';
    const reviewerNumber = ((i + 3) % 8) + 1;
    const reviewer = hasReviewer ? `reviewer.${pad(reviewerNumber, 2)}` : null;

    const createdOffsetDays = Math.floor(rng() * 60) + 1; // 1..60 days back
    const createdAtDate = addDays(asOf, -createdOffsetDays);
    const created_at = toIsoTimestamp(createdAtDate);

    let submitted_at: string | null = null;
    let approved_at: string | null = null;
    let closed_at: string | null = null;

    if (status === 'approved' || status === 'submitted' || status === 'closed') {
      const approvedOffset = Math.max(1, Math.floor(createdOffsetDays * 0.5));
      const approvedDate = addDays(asOf, -approvedOffset);
      approved_at = toIsoTimestamp(approvedDate);
    }

    if (status === 'submitted' || status === 'closed') {
      const submittedOffset = Math.max(1, Math.floor(createdOffsetDays * 0.3));
      const submittedDate = addDays(asOf, -submittedOffset);
      submitted_at = toIsoTimestamp(submittedDate);
    }

    if (status === 'closed') {
      const closedOffset = Math.max(0, Math.floor(createdOffsetDays * 0.1));
      const closedDate = addDays(asOf, -closedOffset);
      closed_at = toIsoTimestamp(closedDate);
    }

    const item: ComplianceItem = {
      item_id: `CI-${pad(i + 1, 5)}`,
      tenant_id,
      obligation_id: obligation.obligation_id,
      title: `${obligation.regulation} — ${obligation.clause}`,
      status,
      owner,
      reviewer,
      created_at,
      submitted_at,
      approved_at,
      closed_at,
      notes: `Workflow item for ${obligation.regulation} (${obligation.framework}) — ${status.replace(
        '_',
        ' ',
      )}.`,
    };

    out.push(item);
  }

  return out;
}

export function listComplianceItems(
  tenant_id: string,
  asOf?: Date,
  filters?: { status?: ComplianceWorkflowStatus },
): ComplianceItem[] {
  const rows = generateComplianceItems(tenant_id, asOf ?? new Date());
  if (filters?.status) {
    return rows.filter((r) => r.status === filters.status);
  }
  return rows;
}
