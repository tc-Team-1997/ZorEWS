// services/bff/src/governance/types.ts
//
// Enterprise Tenant Governance — shared types.
// Mirrors data/schema/051_tenant_governance.sql.

export type GovernanceDomain = 'banking' | 'insurance' | 'both';
export type ComplianceSeverity = 'mandatory' | 'recommended' | 'advisory';
export type ComplianceRequirementKind =
  | 'reporting'
  | 'capital'
  | 'kyc'
  | 'sanctions'
  | 'governance'
  | 'data_residency'
  | 'audit';

export const COMPLIANCE_SEVERITIES = ['mandatory', 'recommended', 'advisory'] as const;
export const COMPLIANCE_REQUIREMENT_KINDS = [
  'reporting', 'capital', 'kyc', 'sanctions', 'governance', 'data_residency', 'audit',
] as const;
export const GOVERNANCE_DOMAINS = ['banking', 'insurance', 'both'] as const;

export interface Branch {
  branch_id: string;
  tenant_id: string;
  country_code: string;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  manager_user: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BranchInput {
  tenant_id: string;
  country_code: string;
  code: string;
  name: string;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  manager_user?: string | null;
  active?: boolean;
}

export interface BranchPatch {
  code?: string;
  name?: string;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  manager_user?: string | null;
  active?: boolean;
}

export interface ComplianceRule {
  rule_id: string;
  country_code: string;
  regulator: string;
  domain: GovernanceDomain;
  rule_code: string;
  title: string;
  description: string;
  requirement_kind: ComplianceRequirementKind;
  severity: ComplianceSeverity;
  effective_from: string | null;
  effective_until: string | null;
  source_url: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ComplianceRuleInput {
  country_code: string;
  regulator: string;
  domain: GovernanceDomain;
  rule_code: string;
  title: string;
  description: string;
  requirement_kind: ComplianceRequirementKind;
  severity?: ComplianceSeverity;
  effective_from?: string | null;
  effective_until?: string | null;
  source_url?: string | null;
  active?: boolean;
}

export interface ComplianceRulePatch {
  title?: string;
  description?: string;
  requirement_kind?: ComplianceRequirementKind;
  severity?: ComplianceSeverity;
  effective_from?: string | null;
  effective_until?: string | null;
  source_url?: string | null;
  active?: boolean;
}

export class GovernanceError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'unknown_branch'
      | 'duplicate_branch_code'
      | 'unknown_compliance_rule'
      | 'duplicate_compliance_rule'
      | 'invalid_country'
      | 'invalid_tenant'
      | 'invalid_domain'
      | 'invalid_severity'
      | 'invalid_requirement_kind',
  ) {
    super(code);
    this.name = 'GovernanceError';
  }
}

export function isGovernanceDomain(s: unknown): s is GovernanceDomain {
  return s === 'banking' || s === 'insurance' || s === 'both';
}

export function isComplianceSeverity(s: unknown): s is ComplianceSeverity {
  return s === 'mandatory' || s === 'recommended' || s === 'advisory';
}

export function isComplianceRequirementKind(s: unknown): s is ComplianceRequirementKind {
  return (
    typeof s === 'string' &&
    (COMPLIANCE_REQUIREMENT_KINDS as readonly string[]).includes(s)
  );
}
