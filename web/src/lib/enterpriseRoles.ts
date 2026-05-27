// Enterprise RBAC catalog for the user-create flow.
//
// The auth-svc backend currently exposes a 5-value `Role` enum (admin /
// risk_analyst / supervisor / collection_officer / field_officer) but the
// EWS product surface needs 11 enterprise roles for proper segregation
// of duties in banking + insurance ops.
//
// This file holds the 11-role catalog the SPA renders. Each enterprise
// role maps to one backend role for the actual /auth/register call,
// keeping the contract stable until auth-svc grows the enum.
//
// When auth-svc adds native support for these roles, the mapping flips
// to 1:1 and nothing else changes.

import type { Role } from '@/store/auth';

export type EnterpriseRoleId =
  | 'super_admin'
  | 'country_admin'
  | 'bank_admin'
  | 'insurance_admin'
  | 'risk_analyst'
  | 'credit_officer'
  | 'operations_user'
  | 'fraud_analyst'
  | 'collection_manager'
  | 'auditor'
  | 'read_only_user';

export type EnterpriseDomain = 'banking' | 'insurance' | 'both';

export interface EnterpriseRoleDef {
  id: EnterpriseRoleId;
  label: string;
  /** One-line spec-card subtitle. */
  description: string;
  /** Domain affinity — drives the SPA filter when a domain is locked. */
  domain: EnterpriseDomain;
  /** Pre-selected matrix of capability flags. SPA renders this as a
   *  live preview when the admin picks a role. */
  capabilities: {
    view_alerts: boolean;
    edit_rules: boolean;
    close_cases: boolean;
    approve_actions: boolean;
    export_reports: boolean;
    admin_users: boolean;
    admin_tenants: boolean;
    admin_config: boolean;
    audit_read: boolean;
  };
  /** Backend role the SPA actually sends on /auth/register. */
  backend_role: Role;
}

/**
 * Canonical 11-role catalog. Order matters — this is the order in the
 * user-create dropdown + the RBAC preview matrix.
 */
export const ENTERPRISE_ROLES: EnterpriseRoleDef[] = [
  {
    id: 'super_admin',
    label: 'Super Admin',
    description: 'Platform-wide control across countries, tenants, and domains.',
    domain: 'both',
    capabilities: {
      view_alerts: true,
      edit_rules: true,
      close_cases: true,
      approve_actions: true,
      export_reports: true,
      admin_users: true,
      admin_tenants: true,
      admin_config: true,
      audit_read: true,
    },
    backend_role: 'admin',
  },
  {
    id: 'country_admin',
    label: 'Country Admin',
    description: 'Owns every tenant + branch within a single country.',
    domain: 'both',
    capabilities: {
      view_alerts: true,
      edit_rules: true,
      close_cases: true,
      approve_actions: true,
      export_reports: true,
      admin_users: true,
      admin_tenants: true,
      admin_config: true,
      audit_read: true,
    },
    backend_role: 'admin',
  },
  {
    id: 'bank_admin',
    label: 'Bank Admin',
    description: 'Tenant-level administrator scoped to a single bank.',
    domain: 'banking',
    capabilities: {
      view_alerts: true,
      edit_rules: true,
      close_cases: true,
      approve_actions: true,
      export_reports: true,
      admin_users: true,
      admin_tenants: false,
      admin_config: true,
      audit_read: true,
    },
    backend_role: 'admin',
  },
  {
    id: 'insurance_admin',
    label: 'Insurance Admin',
    description: 'Tenant-level administrator scoped to a single insurer.',
    domain: 'insurance',
    capabilities: {
      view_alerts: true,
      edit_rules: true,
      close_cases: true,
      approve_actions: true,
      export_reports: true,
      admin_users: true,
      admin_tenants: false,
      admin_config: true,
      audit_read: true,
    },
    backend_role: 'admin',
  },
  {
    id: 'risk_analyst',
    label: 'Risk Analyst',
    description: 'Investigates indicators, runs scenarios, authors rules.',
    domain: 'both',
    capabilities: {
      view_alerts: true,
      edit_rules: true,
      close_cases: false,
      approve_actions: false,
      export_reports: true,
      admin_users: false,
      admin_tenants: false,
      admin_config: false,
      audit_read: true,
    },
    backend_role: 'risk_analyst',
  },
  {
    id: 'credit_officer',
    label: 'Credit Officer',
    description: 'Reviews borrower behaviour, recommends action on cases.',
    domain: 'banking',
    capabilities: {
      view_alerts: true,
      edit_rules: false,
      close_cases: true,
      approve_actions: true,
      export_reports: true,
      admin_users: false,
      admin_tenants: false,
      admin_config: false,
      audit_read: false,
    },
    backend_role: 'supervisor',
  },
  {
    id: 'operations_user',
    label: 'Operations User',
    description: 'Handles day-to-day alerts + case routing.',
    domain: 'both',
    capabilities: {
      view_alerts: true,
      edit_rules: false,
      close_cases: true,
      approve_actions: false,
      export_reports: false,
      admin_users: false,
      admin_tenants: false,
      admin_config: false,
      audit_read: false,
    },
    backend_role: 'supervisor',
  },
  {
    id: 'fraud_analyst',
    label: 'Fraud Analyst',
    description: 'Pursues fraud signals across transactions + claims.',
    domain: 'both',
    capabilities: {
      view_alerts: true,
      edit_rules: true,
      close_cases: true,
      approve_actions: false,
      export_reports: true,
      admin_users: false,
      admin_tenants: false,
      admin_config: false,
      audit_read: true,
    },
    backend_role: 'risk_analyst',
  },
  {
    id: 'collection_manager',
    label: 'Collection Manager',
    description: 'Drives recovery from SMA/NPA + lapsed-premium accounts.',
    domain: 'both',
    capabilities: {
      view_alerts: true,
      edit_rules: false,
      close_cases: true,
      approve_actions: true,
      export_reports: true,
      admin_users: false,
      admin_tenants: false,
      admin_config: false,
      audit_read: false,
    },
    backend_role: 'collection_officer',
  },
  {
    id: 'auditor',
    label: 'Auditor',
    description: 'Read-only access to the full evidence + audit trail.',
    domain: 'both',
    capabilities: {
      view_alerts: true,
      edit_rules: false,
      close_cases: false,
      approve_actions: false,
      export_reports: true,
      admin_users: false,
      admin_tenants: false,
      admin_config: false,
      audit_read: true,
    },
    backend_role: 'field_officer',
  },
  {
    id: 'read_only_user',
    label: 'Read-Only User',
    description: 'Dashboard + reports only. No mutations.',
    domain: 'both',
    capabilities: {
      view_alerts: true,
      edit_rules: false,
      close_cases: false,
      approve_actions: false,
      export_reports: false,
      admin_users: false,
      admin_tenants: false,
      admin_config: false,
      audit_read: false,
    },
    backend_role: 'field_officer',
  },
];

export function getEnterpriseRole(id: EnterpriseRoleId | string | null | undefined): EnterpriseRoleDef | null {
  if (!id) return null;
  return ENTERPRISE_ROLES.find((r) => r.id === id) ?? null;
}

export const CAPABILITY_LABELS: Record<keyof EnterpriseRoleDef['capabilities'], string> = {
  view_alerts: 'View alerts + risk profiles',
  edit_rules: 'Author and edit rules',
  close_cases: 'Close + assign cases',
  approve_actions: 'Approve sensitive actions',
  export_reports: 'Export reports + evidence',
  admin_users: 'Manage users',
  admin_tenants: 'Manage tenants',
  admin_config: 'Edit platform config',
  audit_read: 'Read audit trail',
};
