// Enterprise Data Fabric Center — pure resolver. 14th IA overlay (additive).
// Data Catalog, Lineage, Governance — deterministic synthesis keyed on (tenant, kind, day).

import {
  DATA_DOMAINS,
  DATA_CLASSIFICATIONS,
  type DataDomain,
  type DataClassification,
  type DataSource,
  listDataSources,
} from './dataFabricEngine';

// ─── deterministic synthesis helpers ────────────────────────────────────────

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

function isoTimestamp(asOf: Date): string {
  const y = asOf.getUTCFullYear();
  const mo = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const d = String(asOf.getUTCDate()).padStart(2, '0');
  const h = String(asOf.getUTCHours()).padStart(2, '0');
  const mi = String(asOf.getUTCMinutes()).padStart(2, '0');
  const s = String(asOf.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

function isoDateOffset(asOf: Date, daysAgo: number): string {
  const offset = new Date(asOf.getTime() - daysAgo * 86_400_000);
  const y = offset.getUTCFullYear();
  const mo = String(offset.getUTCMonth() + 1).padStart(2, '0');
  const d = String(offset.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}T00:00:00.000Z`;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ─── shared roster pools (deterministic) ────────────────────────────────────

const OWNERS = [
  'data.platform@example.com',
  'banking.cdo@example.com',
  'insurance.cdo@example.com',
  'risk.office@example.com',
  'finance.ops@example.com',
  'compliance.team@example.com',
  'underwriting.head@example.com',
  'claims.head@example.com',
];

const STEWARDS = [
  'priya.s@example.com',
  'arjun.m@example.com',
  'sunita.k@example.com',
  'ravi.p@example.com',
  'meera.j@example.com',
  'vikram.t@example.com',
  'anjali.b@example.com',
  'rohit.d@example.com',
];

// ─── A. METADATA CATALOG ────────────────────────────────────────────────────

export interface GlossaryTerm {
  term_id: string;
  term: string;
  definition: string;
  domain: DataDomain;
  owner: string;
  steward: string;
  related_term_ids: string[];
  updated_at: string;
}

const GLOSSARY_SEED: ReadonlyArray<{
  term: string;
  definition: string;
  domain: DataDomain;
}> = [
  { term: 'Customer 360', definition: 'Unified view of a customer aggregating data across products, channels, and interactions.', domain: 'common' },
  { term: 'NPA Account', definition: 'Non-Performing Asset — a loan where interest or principal has been overdue for 90 days or more.', domain: 'banking' },
  { term: 'Days Past Due (DPD)', definition: 'Number of days a payment is overdue beyond its contractual due date.', domain: 'banking' },
  { term: 'IFRS 9 Stage', definition: 'Credit risk classification (Stage 1 / 2 / 3) under IFRS 9 expected credit loss framework.', domain: 'banking' },
  { term: 'Probability of Default', definition: 'Likelihood, expressed 0..1, that an obligor will default within a defined horizon.', domain: 'banking' },
  { term: 'Loss Given Default', definition: 'Share of exposure expected to be lost if a default event occurs, net of recoveries.', domain: 'banking' },
  { term: 'Exposure at Default', definition: 'Expected gross exposure to the obligor at the time of default.', domain: 'banking' },
  { term: 'Capital Adequacy Ratio', definition: 'Ratio of a bank\'s capital to its risk-weighted assets, regulated under Basel norms.', domain: 'banking' },
  { term: 'Policy Lapse', definition: 'Termination of an insurance policy due to non-payment of premium beyond the grace period.', domain: 'insurance' },
  { term: 'Persistency', definition: 'Percentage of policies in force at the end of a period vs the start; measures customer retention.', domain: 'insurance' },
  { term: 'Sum Assured', definition: 'Guaranteed amount payable by the insurer on the occurrence of the insured event.', domain: 'insurance' },
  { term: 'Claim Ratio', definition: 'Ratio of incurred claims to earned premium over a reporting period.', domain: 'insurance' },
  { term: 'Underwriting Decision', definition: 'Outcome of risk assessment determining policy issuance, premium loading, or rejection.', domain: 'insurance' },
  { term: 'Solvency Margin', definition: 'Excess of insurer\'s assets over liabilities, mandated by regulator to absorb shocks.', domain: 'insurance' },
  { term: 'Agent Productivity', definition: 'Performance metric capturing policies sold, premium collected, and persistency per agent.', domain: 'insurance' },
  { term: 'KYC Verification', definition: 'Know Your Customer process verifying identity, address, and risk profile.', domain: 'common' },
  { term: 'PII (Personally Identifiable Information)', definition: 'Data that can directly or indirectly identify a natural person.', domain: 'common' },
  { term: 'Critical Data Element', definition: 'Data field designated as critical for regulatory, financial, or operational purposes.', domain: 'common' },
  { term: 'Data Lineage', definition: 'Traceable record of data origin, transformations, and downstream consumption.', domain: 'common' },
  { term: 'Master Data', definition: 'Authoritative, golden-record reference data for core business entities.', domain: 'common' },
];

export function listGlossaryTerms(
  tenant_id: string,
  asOf: Date = new Date(),
  filters?: { domain?: DataDomain },
): GlossaryTerm[] {
  const day = dayIndex(asOf);
  const baseSeed = fnv1a(`${tenant_id}|glossary|${day}`);

  const terms: GlossaryTerm[] = GLOSSARY_SEED.map((seed, idx) => {
    const rng = mulberry32(baseSeed + idx * 37);
    const term_id = `gt-${tenant_id}-${String(idx + 1).padStart(3, '0')}`;
    const owner = OWNERS[Math.floor(rng() * OWNERS.length)];
    const steward = STEWARDS[Math.floor(rng() * STEWARDS.length)];
    const relatedCount = Math.floor(rng() * 3);
    const related_term_ids: string[] = [];
    for (let r = 0; r < relatedCount; r++) {
      const otherIdx = Math.floor(rng() * GLOSSARY_SEED.length);
      if (otherIdx !== idx) {
        const id = `gt-${tenant_id}-${String(otherIdx + 1).padStart(3, '0')}`;
        if (!related_term_ids.includes(id)) related_term_ids.push(id);
      }
    }
    const daysAgo = Math.floor(rng() * 180) + 1;
    return {
      term_id,
      term: seed.term,
      definition: seed.definition,
      domain: seed.domain,
      owner,
      steward,
      related_term_ids,
      updated_at: isoDateOffset(asOf, daysAgo),
    };
  });

  if (filters?.domain) {
    return terms.filter((t) => t.domain === filters.domain);
  }
  return terms;
}

export interface DataDictionaryEntry {
  entry_id: string;
  source_id: string;
  field_name: string;
  data_type: string;
  nullable: boolean;
  classification: DataClassification;
  is_pii: boolean;
  is_critical_data_element: boolean;
  is_regulatory: boolean;
  business_definition: string;
  sample_value: string;
  owner: string;
  steward: string;
}

const FIELD_TEMPLATES: ReadonlyArray<{
  field_name: string;
  data_type: string;
  classification: DataClassification;
  is_pii: boolean;
  is_critical_data_element: boolean;
  is_regulatory: boolean;
  business_definition: string;
  sample_value: string;
}> = [
  { field_name: 'customer_id', data_type: 'string', classification: 'internal', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Unique customer identifier across the enterprise.', sample_value: 'CUST-100023' },
  { field_name: 'full_name', data_type: 'string', classification: 'pii', is_pii: true, is_critical_data_element: true, is_regulatory: true, business_definition: 'Legal name of the customer as per KYC records.', sample_value: 'Priya Sharma' },
  { field_name: 'pan_number', data_type: 'string', classification: 'pii', is_pii: true, is_critical_data_element: true, is_regulatory: true, business_definition: 'Permanent Account Number issued by IT Department.', sample_value: 'ABCDE1234F' },
  { field_name: 'aadhaar_number', data_type: 'string', classification: 'restricted', is_pii: true, is_critical_data_element: true, is_regulatory: true, business_definition: 'Unique 12-digit identity issued by UIDAI; masked for processing.', sample_value: 'XXXX-XXXX-1234' },
  { field_name: 'date_of_birth', data_type: 'date', classification: 'pii', is_pii: true, is_critical_data_element: false, is_regulatory: true, business_definition: 'Customer date of birth.', sample_value: '1985-06-15' },
  { field_name: 'mobile_number', data_type: 'string', classification: 'pii', is_pii: true, is_critical_data_element: false, is_regulatory: false, business_definition: 'Registered mobile number for OTP and communication.', sample_value: '+91-98XXXXXX67' },
  { field_name: 'email_address', data_type: 'string', classification: 'pii', is_pii: true, is_critical_data_element: false, is_regulatory: false, business_definition: 'Registered email for digital communication.', sample_value: 'priya.s@example.com' },
  { field_name: 'address_pincode', data_type: 'string', classification: 'internal', is_pii: false, is_critical_data_element: false, is_regulatory: false, business_definition: 'Six-digit postal code of customer address.', sample_value: '110001' },
  { field_name: 'loan_account_no', data_type: 'string', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Unique loan account identifier in CBS.', sample_value: 'LN-2024-00501' },
  { field_name: 'loan_amount', data_type: 'decimal', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Sanctioned principal amount of the loan.', sample_value: '1500000.00' },
  { field_name: 'outstanding_balance', data_type: 'decimal', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Current outstanding principal + interest.', sample_value: '1245678.50' },
  { field_name: 'dpd_days', data_type: 'integer', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Number of days payment is past due.', sample_value: '45' },
  { field_name: 'npa_flag', data_type: 'boolean', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Non-Performing Asset classification flag.', sample_value: 'false' },
  { field_name: 'ifrs9_stage', data_type: 'enum', classification: 'regulatory', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'IFRS 9 credit risk stage (1, 2, or 3).', sample_value: '2' },
  { field_name: 'pd_score', data_type: 'decimal', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Probability of default in [0,1].', sample_value: '0.0234' },
  { field_name: 'policy_no', data_type: 'string', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Unique insurance policy identifier.', sample_value: 'POL-2024-00789' },
  { field_name: 'sum_assured', data_type: 'decimal', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Guaranteed payout on insured event.', sample_value: '5000000.00' },
  { field_name: 'premium_amount', data_type: 'decimal', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: false, business_definition: 'Periodic premium payable by the policyholder.', sample_value: '24500.00' },
  { field_name: 'policy_status', data_type: 'enum', classification: 'internal', is_pii: false, is_critical_data_element: true, is_regulatory: false, business_definition: 'Current policy lifecycle status.', sample_value: 'in_force' },
  { field_name: 'lapse_date', data_type: 'date', classification: 'internal', is_pii: false, is_critical_data_element: false, is_regulatory: false, business_definition: 'Date when policy lapsed due to non-payment.', sample_value: '2024-08-12' },
  { field_name: 'claim_amount', data_type: 'decimal', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Amount claimed under the policy.', sample_value: '350000.00' },
  { field_name: 'claim_status', data_type: 'enum', classification: 'internal', is_pii: false, is_critical_data_element: true, is_regulatory: false, business_definition: 'Claim processing lifecycle status.', sample_value: 'approved' },
  { field_name: 'agent_id', data_type: 'string', classification: 'internal', is_pii: false, is_critical_data_element: false, is_regulatory: false, business_definition: 'Servicing agent identifier.', sample_value: 'AGT-4521' },
  { field_name: 'underwriting_decision', data_type: 'enum', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: false, business_definition: 'Outcome of underwriting evaluation.', sample_value: 'approved' },
  { field_name: 'kyc_status', data_type: 'enum', classification: 'internal', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'KYC verification status.', sample_value: 'verified' },
  { field_name: 'created_at', data_type: 'date', classification: 'public', is_pii: false, is_critical_data_element: false, is_regulatory: false, business_definition: 'Record creation timestamp.', sample_value: '2024-01-15T10:23:00Z' },
  { field_name: 'updated_at', data_type: 'date', classification: 'public', is_pii: false, is_critical_data_element: false, is_regulatory: false, business_definition: 'Last update timestamp.', sample_value: '2024-09-20T14:50:00Z' },
  { field_name: 'branch_code', data_type: 'string', classification: 'internal', is_pii: false, is_critical_data_element: false, is_regulatory: false, business_definition: 'Originating branch identifier.', sample_value: 'BR-DEL-021' },
  { field_name: 'product_code', data_type: 'string', classification: 'internal', is_pii: false, is_critical_data_element: true, is_regulatory: false, business_definition: 'Product SKU identifier.', sample_value: 'HL-FLOAT-30Y' },
  { field_name: 'risk_rating', data_type: 'enum', classification: 'confidential', is_pii: false, is_critical_data_element: true, is_regulatory: true, business_definition: 'Internal risk grade.', sample_value: 'A2' },
];

export function listDataDictionary(
  tenant_id: string,
  asOf: Date = new Date(),
  filters?: { source_id?: string; is_pii?: boolean; is_regulatory?: boolean },
  limit: number = 50,
): DataDictionaryEntry[] {
  const day = dayIndex(asOf);
  const sources = listDataSources(tenant_id, asOf);
  const baseSeed = fnv1a(`${tenant_id}|dictionary|${day}`);

  const entries: DataDictionaryEntry[] = [];
  const targetTotal = 80;
  const sourcePool = sources.length > 0 ? sources : ([{ source_id: `src-${tenant_id}-000` }] as Pick<DataSource, 'source_id'>[]);

  for (let i = 0; i < targetTotal; i++) {
    const rng = mulberry32(baseSeed + i * 53);
    const tmpl = FIELD_TEMPLATES[i % FIELD_TEMPLATES.length];
    const source = sourcePool[Math.floor(rng() * sourcePool.length)];
    const entry_id = `dd-${tenant_id}-${String(i + 1).padStart(4, '0')}`;
    const owner = OWNERS[Math.floor(rng() * OWNERS.length)];
    const steward = STEWARDS[Math.floor(rng() * STEWARDS.length)];
    const nullable = !tmpl.is_critical_data_element && rng() < 0.4;

    entries.push({
      entry_id,
      source_id: source.source_id,
      field_name: tmpl.field_name,
      data_type: tmpl.data_type,
      nullable,
      classification: tmpl.classification,
      is_pii: tmpl.is_pii,
      is_critical_data_element: tmpl.is_critical_data_element,
      is_regulatory: tmpl.is_regulatory,
      business_definition: tmpl.business_definition,
      sample_value: tmpl.sample_value,
      owner,
      steward,
    });
  }

  let filtered = entries;
  if (filters?.source_id) {
    filtered = filtered.filter((e) => e.source_id === filters.source_id);
  }
  if (filters?.is_pii !== undefined) {
    filtered = filtered.filter((e) => e.is_pii === filters.is_pii);
  }
  if (filters?.is_regulatory !== undefined) {
    filtered = filtered.filter((e) => e.is_regulatory === filters.is_regulatory);
  }

  return filtered.slice(0, Math.max(0, limit));
}

export interface MetadataCatalogSummary {
  tenant_id: string;
  generated_at: string;
  total_glossary_terms: number;
  total_dictionary_entries: number;
  total_sources_documented: number;
  total_owners: number;
  total_stewards: number;
  sensitive_data_count: number;
  regulatory_data_count: number;
  critical_data_element_count: number;
  by_classification: Record<DataClassification, number>;
  by_domain: Record<DataDomain, number>;
}

export function buildMetadataCatalogSummary(tenant_id: string, asOf: Date = new Date()): MetadataCatalogSummary {
  const glossary = listGlossaryTerms(tenant_id, asOf);
  const dictionary = listDataDictionary(tenant_id, asOf, undefined, 1000);

  const by_classification: Record<DataClassification, number> = {} as Record<DataClassification, number>;
  for (const c of DATA_CLASSIFICATIONS) by_classification[c] = 0;
  for (const e of dictionary) by_classification[e.classification] = (by_classification[e.classification] ?? 0) + 1;

  const by_domain: Record<DataDomain, number> = {} as Record<DataDomain, number>;
  for (const d of DATA_DOMAINS) by_domain[d] = 0;
  for (const t of glossary) by_domain[t.domain] = (by_domain[t.domain] ?? 0) + 1;

  const sources = new Set(dictionary.map((e) => e.source_id));
  const owners = new Set<string>();
  const stewards = new Set<string>();
  for (const e of dictionary) {
    owners.add(e.owner);
    stewards.add(e.steward);
  }
  for (const t of glossary) {
    owners.add(t.owner);
    stewards.add(t.steward);
  }

  return {
    tenant_id,
    generated_at: isoTimestamp(asOf),
    total_glossary_terms: glossary.length,
    total_dictionary_entries: dictionary.length,
    total_sources_documented: sources.size,
    total_owners: owners.size,
    total_stewards: stewards.size,
    sensitive_data_count: dictionary.filter((e) => e.is_pii).length,
    regulatory_data_count: dictionary.filter((e) => e.is_regulatory).length,
    critical_data_element_count: dictionary.filter((e) => e.is_critical_data_element).length,
    by_classification,
    by_domain,
  };
}

// ─── B. DATA LINEAGE ────────────────────────────────────────────────────────

export interface LineageNode {
  node_id: string;
  label: string;
  kind: 'source' | 'transformation' | 'data_quality' | 'risk_engine' | 'ai_model' | 'dashboard' | 'report';
  domain: DataDomain | null;
  owner: string | null;
}

export interface LineageEdge {
  from: string;
  to: string;
  transformation: string;
  kind: 'realtime' | 'batch' | 'manual';
}

export interface LineageGraph {
  tenant_id: string;
  generated_at: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

const SOURCE_SPECS: ReadonlyArray<{ label: string; domain: DataDomain }> = [
  { label: 'Core Banking System', domain: 'banking' },
  { label: 'Loan Management System', domain: 'banking' },
  { label: 'Credit Bureau Feed', domain: 'banking' },
  { label: 'Policy Administration', domain: 'insurance' },
  { label: 'Claims Management', domain: 'insurance' },
  { label: 'Customer Master (MDM)', domain: 'common' },
];

const TRANSFORMATION_SPECS: ReadonlyArray<{ label: string; domain: DataDomain }> = [
  { label: 'Customer 360 Enrichment', domain: 'common' },
  { label: 'IFRS9 Stage Calculation', domain: 'banking' },
  { label: 'Premium-to-Policy Join', domain: 'insurance' },
  { label: 'Risk Feature Engineering', domain: 'common' },
];

const DQ_SPECS: ReadonlyArray<{ label: string; domain: DataDomain }> = [
  { label: 'Completeness Validator', domain: 'common' },
  { label: 'Accuracy Reconciliation', domain: 'common' },
  { label: 'Regulatory Field Audit', domain: 'common' },
];

const RISK_ENGINE_SPECS: ReadonlyArray<{ label: string; domain: DataDomain }> = [
  { label: 'Credit Risk Engine', domain: 'banking' },
  { label: 'Underwriting Risk Engine', domain: 'insurance' },
];

const AI_MODEL_SPECS: ReadonlyArray<{ label: string; domain: DataDomain }> = [
  { label: 'PD/LGD Predictive Model', domain: 'banking' },
  { label: 'Persistency Churn Model', domain: 'insurance' },
];

const DASHBOARD_SPECS: ReadonlyArray<{ label: string; domain: DataDomain }> = [
  { label: 'Executive Risk Cockpit', domain: 'common' },
  { label: 'Banking NPA Dashboard', domain: 'banking' },
  { label: 'Insurance Persistency Dashboard', domain: 'insurance' },
];

const REPORT_SPECS: ReadonlyArray<{ label: string; domain: DataDomain }> = [
  { label: 'RBI Regulatory Return', domain: 'banking' },
  { label: 'IRDAI Solvency Report', domain: 'insurance' },
  { label: 'Board Quarterly Pack', domain: 'common' },
];

function makeNodes(tenant_id: string, asOf: Date): { nodes: LineageNode[]; idsByKind: Record<string, string[]> } {
  const day = dayIndex(asOf);
  const baseSeed = fnv1a(`${tenant_id}|lineage_nodes|${day}`);
  const nodes: LineageNode[] = [];
  const idsByKind: Record<string, string[]> = {
    source: [],
    transformation: [],
    data_quality: [],
    risk_engine: [],
    ai_model: [],
    dashboard: [],
    report: [],
  };

  let counter = 0;
  const addAll = (
    specs: ReadonlyArray<{ label: string; domain: DataDomain }>,
    kind: LineageNode['kind'],
  ) => {
    specs.forEach((spec, idx) => {
      counter++;
      const rng = mulberry32(baseSeed + counter * 41);
      const node_id = `ln-${tenant_id}-${kind}-${String(idx + 1).padStart(2, '0')}`;
      const owner = OWNERS[Math.floor(rng() * OWNERS.length)];
      nodes.push({
        node_id,
        label: spec.label,
        kind,
        domain: spec.domain,
        owner,
      });
      idsByKind[kind].push(node_id);
    });
  };

  addAll(SOURCE_SPECS, 'source');
  addAll(TRANSFORMATION_SPECS, 'transformation');
  addAll(DQ_SPECS, 'data_quality');
  addAll(RISK_ENGINE_SPECS, 'risk_engine');
  addAll(AI_MODEL_SPECS, 'ai_model');
  addAll(DASHBOARD_SPECS, 'dashboard');
  addAll(REPORT_SPECS, 'report');

  return { nodes, idsByKind };
}

function makeEdges(tenant_id: string, asOf: Date, idsByKind: Record<string, string[]>): LineageEdge[] {
  const day = dayIndex(asOf);
  const baseSeed = fnv1a(`${tenant_id}|lineage_edges|${day}`);
  const rng = mulberry32(baseSeed);
  const edgeKinds: ReadonlyArray<LineageEdge['kind']> = ['realtime', 'batch', 'manual'];
  const edges: LineageEdge[] = [];

  const transforms = [
    'extract',
    'cleanse',
    'join',
    'aggregate',
    'enrich',
    'validate',
    'score',
    'publish',
    'derive',
    'merge',
  ];

  // sources → transformations
  for (const src of idsByKind.source) {
    const t1 = pick(rng, idsByKind.transformation);
    edges.push({ from: src, to: t1, transformation: pick(rng, transforms), kind: pick(rng, edgeKinds) });
  }
  // some sources → DQ directly
  edges.push({ from: idsByKind.source[0], to: idsByKind.data_quality[0], transformation: 'validate', kind: 'batch' });
  edges.push({ from: idsByKind.source[3], to: idsByKind.data_quality[0], transformation: 'validate', kind: 'batch' });

  // transformations → DQ
  for (const t of idsByKind.transformation) {
    const dq = pick(rng, idsByKind.data_quality);
    edges.push({ from: t, to: dq, transformation: pick(rng, transforms), kind: pick(rng, edgeKinds) });
  }

  // DQ → risk engines
  for (const dq of idsByKind.data_quality) {
    const re = pick(rng, idsByKind.risk_engine);
    edges.push({ from: dq, to: re, transformation: pick(rng, transforms), kind: pick(rng, edgeKinds) });
  }

  // transformations → AI models
  edges.push({ from: idsByKind.transformation[1], to: idsByKind.ai_model[0], transformation: 'score', kind: 'batch' });
  edges.push({ from: idsByKind.transformation[2], to: idsByKind.ai_model[1], transformation: 'score', kind: 'batch' });

  // risk engines → dashboards
  edges.push({ from: idsByKind.risk_engine[0], to: idsByKind.dashboard[1], transformation: 'publish', kind: 'realtime' });
  edges.push({ from: idsByKind.risk_engine[1], to: idsByKind.dashboard[2], transformation: 'publish', kind: 'realtime' });
  edges.push({ from: idsByKind.risk_engine[0], to: idsByKind.dashboard[0], transformation: 'aggregate', kind: 'batch' });
  edges.push({ from: idsByKind.risk_engine[1], to: idsByKind.dashboard[0], transformation: 'aggregate', kind: 'batch' });

  // AI models → dashboards
  edges.push({ from: idsByKind.ai_model[0], to: idsByKind.dashboard[1], transformation: 'enrich', kind: 'batch' });
  edges.push({ from: idsByKind.ai_model[1], to: idsByKind.dashboard[2], transformation: 'enrich', kind: 'batch' });

  // risk engines → reports
  edges.push({ from: idsByKind.risk_engine[0], to: idsByKind.report[0], transformation: 'publish', kind: 'batch' });
  edges.push({ from: idsByKind.risk_engine[1], to: idsByKind.report[1], transformation: 'publish', kind: 'batch' });
  edges.push({ from: idsByKind.risk_engine[0], to: idsByKind.report[2], transformation: 'aggregate', kind: 'manual' });
  edges.push({ from: idsByKind.risk_engine[1], to: idsByKind.report[2], transformation: 'aggregate', kind: 'manual' });

  // dashboards → reports (some derived reports)
  edges.push({ from: idsByKind.dashboard[0], to: idsByKind.report[2], transformation: 'derive', kind: 'manual' });

  // sources directly to a few transformations for richness
  edges.push({ from: idsByKind.source[1], to: idsByKind.transformation[1], transformation: 'extract', kind: 'batch' });
  edges.push({ from: idsByKind.source[2], to: idsByKind.transformation[1], transformation: 'extract', kind: 'batch' });
  edges.push({ from: idsByKind.source[4], to: idsByKind.transformation[2], transformation: 'extract', kind: 'batch' });
  edges.push({ from: idsByKind.source[5], to: idsByKind.transformation[0], transformation: 'merge', kind: 'realtime' });
  edges.push({ from: idsByKind.source[5], to: idsByKind.transformation[3], transformation: 'merge', kind: 'batch' });

  return edges;
}

export function buildLineageGraph(tenant_id: string, asOf: Date = new Date()): LineageGraph {
  const { nodes, idsByKind } = makeNodes(tenant_id, asOf);
  const edges = makeEdges(tenant_id, asOf, idsByKind);

  return {
    tenant_id,
    generated_at: isoTimestamp(asOf),
    nodes,
    edges,
  };
}

export interface ImpactAnalysisResult {
  tenant_id: string;
  generated_at: string;
  target_node_id: string;
  target_label: string;
  upstream_nodes: LineageNode[];
  downstream_nodes: LineageNode[];
  impacted_dashboards: string[];
  impacted_reports: string[];
  impacted_ai_models: string[];
}

function bfs(
  startNodeId: string,
  edges: LineageEdge[],
  direction: 'upstream' | 'downstream',
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startNodeId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const neighbors = edges
      .filter((e) => (direction === 'downstream' ? e.from === current : e.to === current))
      .map((e) => (direction === 'downstream' ? e.to : e.from));
    for (const n of neighbors) {
      if (!visited.has(n) && n !== startNodeId) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return visited;
}

export function analyzeImpact(
  tenant_id: string,
  target_node_id: string,
  asOf: Date = new Date(),
): ImpactAnalysisResult | null {
  const graph = buildLineageGraph(tenant_id, asOf);
  const target = graph.nodes.find((n) => n.node_id === target_node_id);
  if (!target) return null;

  const upstreamIds = bfs(target_node_id, graph.edges, 'upstream');
  const downstreamIds = bfs(target_node_id, graph.edges, 'downstream');

  const nodeById = new Map(graph.nodes.map((n) => [n.node_id, n]));
  const upstream_nodes: LineageNode[] = [];
  const downstream_nodes: LineageNode[] = [];
  for (const id of upstreamIds) {
    const n = nodeById.get(id);
    if (n) upstream_nodes.push(n);
  }
  for (const id of downstreamIds) {
    const n = nodeById.get(id);
    if (n) downstream_nodes.push(n);
  }

  const impacted_dashboards = downstream_nodes.filter((n) => n.kind === 'dashboard').map((n) => n.label);
  const impacted_reports = downstream_nodes.filter((n) => n.kind === 'report').map((n) => n.label);
  const impacted_ai_models = downstream_nodes.filter((n) => n.kind === 'ai_model').map((n) => n.label);

  return {
    tenant_id,
    generated_at: isoTimestamp(asOf),
    target_node_id,
    target_label: target.label,
    upstream_nodes,
    downstream_nodes,
    impacted_dashboards,
    impacted_reports,
    impacted_ai_models,
  };
}

// ─── C. DATA GOVERNANCE ─────────────────────────────────────────────────────

export interface DataPolicy {
  policy_id: string;
  tenant_id: string;
  name: string;
  policy_kind: 'retention' | 'access' | 'classification' | 'masking' | 'anonymization';
  description: string;
  applies_to_classification: DataClassification[];
  retention_days: number | null;
  approver: string;
  status: 'active' | 'draft' | 'retired';
  updated_at: string;
}

const POLICY_SEED: ReadonlyArray<{
  name: string;
  policy_kind: DataPolicy['policy_kind'];
  description: string;
  applies_to_classification: DataClassification[];
  retention_days: number | null;
}> = [
  { name: 'PII Retention Policy', policy_kind: 'retention', description: 'PII data retained for 7 years per DPDP Act requirements.', applies_to_classification: ['pii'], retention_days: 2555 },
  { name: 'Regulatory Data Retention', policy_kind: 'retention', description: 'Regulatory records retained for 10 years per RBI directives.', applies_to_classification: ['regulatory'], retention_days: 3650 },
  { name: 'Operational Data Retention', policy_kind: 'retention', description: 'Internal operational data retained for 3 years.', applies_to_classification: ['internal'], retention_days: 1095 },
  { name: 'Confidential Data Retention', policy_kind: 'retention', description: 'Confidential business data retained for 5 years.', applies_to_classification: ['confidential'], retention_days: 1825 },
  { name: 'Restricted Data Access', policy_kind: 'access', description: 'Restricted data accessible only via just-in-time elevated approval.', applies_to_classification: ['restricted'], retention_days: null },
  { name: 'PII Access Control', policy_kind: 'access', description: 'PII access requires role-based authorisation + audit log.', applies_to_classification: ['pii'], retention_days: null },
  { name: 'Confidential Access Policy', policy_kind: 'access', description: 'Confidential data restricted to need-to-know basis.', applies_to_classification: ['confidential'], retention_days: null },
  { name: 'PCI Access Restriction', policy_kind: 'access', description: 'PCI data accessible only by PCI-DSS certified roles.', applies_to_classification: ['pci'], retention_days: null },
  { name: 'Data Classification Schema', policy_kind: 'classification', description: 'Enterprise data classification taxonomy and ownership.', applies_to_classification: ['public', 'internal', 'confidential', 'restricted'], retention_days: null },
  { name: 'Sensitive Field Tagging', policy_kind: 'classification', description: 'All PII, PCI, PHI fields tagged at ingestion via metadata catalog.', applies_to_classification: ['pii', 'pci', 'phi'], retention_days: null },
  { name: 'PII Masking Policy', policy_kind: 'masking', description: 'PII fields masked in non-production environments.', applies_to_classification: ['pii'], retention_days: null },
  { name: 'PAN/Aadhaar Masking', policy_kind: 'masking', description: 'PAN and Aadhaar masked except last 4 characters in displays.', applies_to_classification: ['pii', 'restricted'], retention_days: null },
  { name: 'PCI Card Masking', policy_kind: 'masking', description: 'Card numbers masked to PCI-DSS tokenization standard.', applies_to_classification: ['pci'], retention_days: null },
  { name: 'Analytics Anonymization', policy_kind: 'anonymization', description: 'Customer identifiers anonymised for analytics workloads.', applies_to_classification: ['pii'], retention_days: null },
  { name: 'Health Data Anonymization', policy_kind: 'anonymization', description: 'PHI data anonymised for research and aggregate reporting.', applies_to_classification: ['phi'], retention_days: null },
  { name: 'Public Data Open Sharing', policy_kind: 'classification', description: 'Public data freely shareable with external stakeholders.', applies_to_classification: ['public'], retention_days: null },
];

export function listDataPolicies(
  tenant_id: string,
  asOf: Date = new Date(),
  filters?: { policy_kind?: DataPolicy['policy_kind']; status?: DataPolicy['status'] },
): DataPolicy[] {
  const day = dayIndex(asOf);
  const baseSeed = fnv1a(`${tenant_id}|policies|${day}`);
  const statuses: ReadonlyArray<DataPolicy['status']> = ['active', 'active', 'active', 'active', 'draft', 'retired'];

  const policies: DataPolicy[] = POLICY_SEED.map((seed, idx) => {
    const rng = mulberry32(baseSeed + idx * 67);
    const status = statuses[Math.floor(rng() * statuses.length)];
    const approver = OWNERS[Math.floor(rng() * OWNERS.length)];
    const daysAgo = Math.floor(rng() * 240) + 1;

    return {
      policy_id: `pol-${tenant_id}-${String(idx + 1).padStart(3, '0')}`,
      tenant_id,
      name: seed.name,
      policy_kind: seed.policy_kind,
      description: seed.description,
      applies_to_classification: seed.applies_to_classification,
      retention_days: seed.retention_days,
      approver,
      status,
      updated_at: isoDateOffset(asOf, daysAgo),
    };
  });

  let filtered = policies;
  if (filters?.policy_kind) {
    filtered = filtered.filter((p) => p.policy_kind === filters.policy_kind);
  }
  if (filters?.status) {
    filtered = filtered.filter((p) => p.status === filters.status);
  }
  return filtered;
}

export interface DataGovernanceSummary {
  tenant_id: string;
  generated_at: string;
  total_policies: number;
  active_policies: number;
  total_owners: number;
  total_stewards: number;
  compliance_score: number;
  by_kind: Record<'retention' | 'access' | 'classification' | 'masking' | 'anonymization', number>;
  by_status: Record<'active' | 'draft' | 'retired', number>;
}

export function buildDataGovernanceSummary(tenant_id: string, asOf: Date = new Date()): DataGovernanceSummary {
  const policies = listDataPolicies(tenant_id, asOf);
  const dictionary = listDataDictionary(tenant_id, asOf, undefined, 1000);
  const glossary = listGlossaryTerms(tenant_id, asOf);

  const by_kind: Record<'retention' | 'access' | 'classification' | 'masking' | 'anonymization', number> = {
    retention: 0,
    access: 0,
    classification: 0,
    masking: 0,
    anonymization: 0,
  };
  const by_status: Record<'active' | 'draft' | 'retired', number> = {
    active: 0,
    draft: 0,
    retired: 0,
  };

  for (const p of policies) {
    by_kind[p.policy_kind] = (by_kind[p.policy_kind] ?? 0) + 1;
    by_status[p.status] = (by_status[p.status] ?? 0) + 1;
  }

  const owners = new Set<string>();
  const stewards = new Set<string>();
  for (const e of dictionary) {
    owners.add(e.owner);
    stewards.add(e.steward);
  }
  for (const t of glossary) {
    owners.add(t.owner);
    stewards.add(t.steward);
  }
  for (const p of policies) {
    owners.add(p.approver);
  }

  // compliance_score: percent of DATA_CLASSIFICATIONS covered by at least one active policy
  const coveredClassifications = new Set<DataClassification>();
  for (const p of policies) {
    if (p.status === 'active') {
      for (const c of p.applies_to_classification) coveredClassifications.add(c);
    }
  }
  const compliance_score = Math.round((coveredClassifications.size / DATA_CLASSIFICATIONS.length) * 100);

  return {
    tenant_id,
    generated_at: isoTimestamp(asOf),
    total_policies: policies.length,
    active_policies: by_status.active,
    total_owners: owners.size,
    total_stewards: stewards.size,
    compliance_score,
    by_kind,
    by_status,
  };
}
