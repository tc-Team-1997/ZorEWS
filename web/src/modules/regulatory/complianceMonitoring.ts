// Regulatory Compliance Center — pure resolver. 13th IA overlay (additive).
// Compliance monitoring: findings ledger, command center metrics, framework heatmap.

import {
  type ComplianceObligation,
  type FindingSeverity,
  type FindingStatus,
  type ObligationStatus,
  type RegulatoryDomain,
  type RegulatoryFramework,
  BANKING_FRAMEWORKS,
  INSURANCE_FRAMEWORKS,
  listObligations,
} from './regulatoryFrameworkEngine';

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

function toIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    ':' +
    pad(d.getUTCMinutes()) +
    ':' +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function pickWeighted<T>(rng: () => number, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((acc, [, w]) => acc + w, 0);
  const r = rng() * total;
  let cum = 0;
  for (const [v, w] of items) {
    cum += w;
    if (r < cum) return v;
  }
  return items[items.length - 1][0];
}

export interface ComplianceFinding {
  finding_id: string;
  tenant_id: string;
  obligation_id: string;
  regulation: string;
  framework: RegulatoryFramework;
  domain: RegulatoryDomain;
  title: string;
  description: string;
  severity: FindingSeverity;
  status: FindingStatus;
  owner: string;
  identified_at: string;
  due_date: string;
  remediated_at: string | null;
  evidence_link: string | null;
  root_cause: string | null;
}

export interface ComplianceFindingFilters {
  severity?: FindingSeverity;
  status?: FindingStatus;
  framework?: RegulatoryFramework;
  domain?: RegulatoryDomain;
}

const FINDING_TITLES: ReadonlyArray<string> = [
  'Late regulatory submission',
  'Incomplete KYC documentation',
  'Threshold breach in monitoring',
  'Missing board review evidence',
  'Inadequate audit trail',
  'Stale risk indicator data',
  'Manual override without approval',
  'Policy exception not documented',
  'Reporting data quality issue',
  'Control test failure',
  'Untimely escalation',
  'Insufficient remediation evidence',
];

const FINDING_DESCRIPTIONS: ReadonlyArray<string> = [
  'Submission deadline missed by greater than 5 business days',
  'Required customer due diligence documents not on file',
  'Monitoring threshold exceeded without timely investigation',
  'Quarterly board review evidence not captured in case file',
  'Audit log gaps detected during periodic review',
  'Risk indicator computation lagging by more than 24 hours',
  'Manual override applied without dual approval',
  'Policy exception applied without documented business case',
  'Data reconciliation differences exceed tolerance threshold',
  'Control execution evidence missing for prior period',
  'Escalation path bypassed for high-severity event',
  'Remediation closure lacks supporting evidence package',
];

const ROOT_CAUSES: ReadonlyArray<string> = [
  'Process gap — no defined SOP',
  'System limitation — feed delay',
  'Resource constraint — staff turnover',
  'Training gap — new control awareness',
  'Vendor dependency — third party data',
  'Change management — deployment regression',
];

const OWNERS: ReadonlyArray<string> = [
  'compliance_lead',
  'risk_ops',
  'cco_office',
  'aml_team',
  'kyc_team',
  'audit_team',
  'fraud_ops',
  'underwriting_ops',
  'claims_ops',
];

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 5,
  severe: 4,
  high: 3,
  moderate: 2,
  low: 1,
};

function generateFindings(tenant_id: string, asOf: Date): ComplianceFinding[] {
  const obligations = listObligations(tenant_id, asOf);
  if (obligations.length === 0) return [];

  const day = dayIndex(asOf);
  const seed = fnv1a(`${tenant_id}|findings|${day}`);
  const rng = mulberry32(seed);

  const TARGET = 30;
  const findings: ComplianceFinding[] = [];

  const severityWeights: ReadonlyArray<readonly [FindingSeverity, number]> = [
    ['low', 30],
    ['moderate', 25],
    ['high', 25],
    ['severe', 15],
    ['critical', 5],
  ];

  const statusWeights: ReadonlyArray<readonly [FindingStatus, number]> = [
    ['open', 40],
    ['in_progress', 25],
    ['remediated', 20],
    ['accepted_risk', 10],
    ['closed', 5],
  ];

  for (let i = 0; i < TARGET; i++) {
    const obligation: ComplianceObligation = obligations[Math.floor(rng() * obligations.length)];
    const severity = pickWeighted(rng, severityWeights);
    const status = pickWeighted(rng, statusWeights);
    const owner = OWNERS[Math.floor(rng() * OWNERS.length)];
    const titleIdx = Math.floor(rng() * FINDING_TITLES.length);
    const descIdx = Math.floor(rng() * FINDING_DESCRIPTIONS.length);

    const identifiedDaysBack = Math.floor(rng() * 121);
    const identifiedAt = new Date(asOf.getTime() - identifiedDaysBack * 86_400_000);

    const dueOffsetDays = 7 + Math.floor(rng() * 54);
    const dueDate = new Date(identifiedAt.getTime() + dueOffsetDays * 86_400_000);

    let remediatedAt: string | null = null;
    if (status === 'remediated' || status === 'closed') {
      const remDaysAfter = Math.floor(rng() * Math.max(1, dueOffsetDays));
      const remDate = new Date(identifiedAt.getTime() + remDaysAfter * 86_400_000);
      remediatedAt = toIso(remDate);
    }

    const hasEvidence = rng() < 0.7;
    const evidenceLink = hasEvidence
      ? `https://evidence.zorews.local/findings/FND-${String(i + 1).padStart(5, '0')}`
      : null;

    const hasRootCause = status !== 'open' || rng() < 0.5;
    const rootCause = hasRootCause ? ROOT_CAUSES[Math.floor(rng() * ROOT_CAUSES.length)] : null;

    findings.push({
      finding_id: `FND-${String(i + 1).padStart(5, '0')}`,
      tenant_id,
      obligation_id: obligation.obligation_id,
      regulation: obligation.regulation,
      framework: obligation.framework,
      domain: obligation.domain,
      title: FINDING_TITLES[titleIdx],
      description: FINDING_DESCRIPTIONS[descIdx],
      severity,
      status,
      owner,
      identified_at: toIso(identifiedAt),
      due_date: toIso(dueDate),
      remediated_at: remediatedAt,
      evidence_link: evidenceLink,
      root_cause: rootCause,
    });
  }

  findings.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.identified_at.localeCompare(b.identified_at);
  });

  return findings;
}

export function listFindings(
  tenant_id: string,
  asOf?: Date,
  filters?: ComplianceFindingFilters,
): ComplianceFinding[] {
  const when = asOf ?? new Date();
  const all = generateFindings(tenant_id, when);
  if (!filters) return all;
  return all.filter((f) => {
    if (filters.severity && f.severity !== filters.severity) return false;
    if (filters.status && f.status !== filters.status) return false;
    if (filters.framework && f.framework !== filters.framework) return false;
    if (filters.domain && f.domain !== filters.domain) return false;
    return true;
  });
}

export function getFinding(
  finding_id: string,
  tenant_id: string,
  asOf?: Date,
): ComplianceFinding | null {
  const when = asOf ?? new Date();
  const all = generateFindings(tenant_id, when);
  return all.find((f) => f.finding_id === finding_id) ?? null;
}

export interface ComplianceCommandCenter {
  tenant_id: string;
  generated_at: string;
  total_obligations: number;
  open_findings: number;
  regulatory_breaches: number;
  sla_violations: number;
  audit_findings: number;
  pending_actions: number;
  high_risk_obligations: number;
  by_status: Record<ObligationStatus, number>;
  by_severity: Record<FindingSeverity, number>;
  by_domain: Record<RegulatoryDomain, number>;
  compliance_health_score: number;
  regulatory_risk_score: number;
  audit_readiness: string;
}

export function buildComplianceCommandCenter(
  tenant_id: string,
  asOf?: Date,
): ComplianceCommandCenter {
  const when = asOf ?? new Date();
  const obligations = listObligations(tenant_id, when);
  const findings = generateFindings(tenant_id, when);

  const byStatus: Record<ObligationStatus, number> = {
    compliant: 0,
    at_risk: 0,
    overdue: 0,
    in_review: 0,
    closed: 0,
  };
  for (const o of obligations) {
    byStatus[o.status] += 1;
  }

  const bySeverity: Record<FindingSeverity, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    severe: 0,
    critical: 0,
  };
  for (const f of findings) {
    bySeverity[f.severity] += 1;
  }

  const byDomain: Record<RegulatoryDomain, number> = {
    banking: 0,
    insurance: 0,
  };
  for (const o of obligations) {
    byDomain[o.domain] += 1;
  }

  const openFindings = findings.filter((f) => f.status === 'open').length;
  const regulatoryBreaches = findings.filter(
    (f) => f.status === 'open' && (f.severity === 'severe' || f.severity === 'critical'),
  ).length;
  const slaViolations = obligations.filter((o) => o.status === 'overdue').length;
  const auditFindings = findings.length;
  const pendingActions = findings.filter(
    (f) => f.status === 'open' || f.status === 'in_progress',
  ).length;
  const highRiskObligations = obligations.filter(
    (o) =>
      (o.priority === 'high' || o.priority === 'severe' || o.priority === 'critical') &&
      o.status !== 'closed',
  ).length;

  const openCritical = findings.filter((f) => f.status === 'open' && f.severity === 'critical')
    .length;
  const openSevere = findings.filter((f) => f.status === 'open' && f.severity === 'severe').length;
  const openHigh = findings.filter((f) => f.status === 'open' && f.severity === 'high').length;
  let healthScore = 100 - openCritical * 10 - openSevere * 5 - openHigh * 1;
  if (healthScore < 0) healthScore = 0;
  if (healthScore > 100) healthScore = 100;

  const riskRaw = openFindings * 2 + regulatoryBreaches * 5 + slaViolations * 3;
  let regulatoryRiskScore = riskRaw;
  if (regulatoryRiskScore > 100) regulatoryRiskScore = 100;
  if (regulatoryRiskScore < 0) regulatoryRiskScore = 0;

  let auditReadiness: string;
  if (healthScore >= 80) auditReadiness = 'ready';
  else if (healthScore >= 50) auditReadiness = 'needs_attention';
  else auditReadiness = 'not_ready';

  return {
    tenant_id,
    generated_at: toIso(when),
    total_obligations: obligations.length,
    open_findings: openFindings,
    regulatory_breaches: regulatoryBreaches,
    sla_violations: slaViolations,
    audit_findings: auditFindings,
    pending_actions: pendingActions,
    high_risk_obligations: highRiskObligations,
    by_status: byStatus,
    by_severity: bySeverity,
    by_domain: byDomain,
    compliance_health_score: healthScore,
    regulatory_risk_score: regulatoryRiskScore,
    audit_readiness: auditReadiness,
  };
}

export interface ComplianceHeatmapCell {
  framework: RegulatoryFramework;
  domain: RegulatoryDomain;
  total_obligations: number;
  open_findings: number;
  breaches: number;
  health_score: number;
  band: 'green' | 'amber' | 'red';
}

export function buildComplianceHeatmap(tenant_id: string, asOf?: Date): ComplianceHeatmapCell[] {
  const when = asOf ?? new Date();
  const obligations = listObligations(tenant_id, when);
  const findings = generateFindings(tenant_id, when);

  const cells: ComplianceHeatmapCell[] = [];

  const allFrameworks: ReadonlyArray<readonly [RegulatoryFramework, RegulatoryDomain]> = [
    ...BANKING_FRAMEWORKS.map((f) => [f, 'banking'] as const),
    ...INSURANCE_FRAMEWORKS.map((f) => [f, 'insurance'] as const),
  ];

  for (const [framework, domain] of allFrameworks) {
    const fwObligations = obligations.filter((o) => o.framework === framework);
    const fwFindings = findings.filter((f) => f.framework === framework);
    const open = fwFindings.filter((f) => f.status === 'open').length;
    const breaches = fwFindings.filter(
      (f) => f.status === 'open' && (f.severity === 'severe' || f.severity === 'critical'),
    ).length;
    const openCritical = fwFindings.filter(
      (f) => f.status === 'open' && f.severity === 'critical',
    ).length;
    const openSevere = fwFindings.filter((f) => f.status === 'open' && f.severity === 'severe')
      .length;
    const openHigh = fwFindings.filter((f) => f.status === 'open' && f.severity === 'high').length;
    let healthScore = 100 - openCritical * 10 - openSevere * 5 - openHigh * 1;
    if (healthScore < 0) healthScore = 0;
    if (healthScore > 100) healthScore = 100;

    let band: 'green' | 'amber' | 'red';
    if (healthScore >= 80) band = 'green';
    else if (healthScore >= 50) band = 'amber';
    else band = 'red';

    cells.push({
      framework,
      domain,
      total_obligations: fwObligations.length,
      open_findings: open,
      breaches,
      health_score: healthScore,
      band,
    });
  }

  return cells;
}
