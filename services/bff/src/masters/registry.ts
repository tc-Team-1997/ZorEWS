// services/bff/src/masters/registry.ts
//
// Phase 9 T11 — Master entity registry.
//
// Each representative entity declares its MasterSchema; the registry
// instantiates a store per entity once at boot. Adding a 4th entity
// (e.g. 'banking-products') is ~10 lines: declare the schema below +
// add an entry to MASTER_ENTITIES + the route auto-mounts via
// createMasterRoutes.

import { createMasterStore, type IMasterStore, type MasterSchema } from './createMasterStore';

const COUNTRY_SCHEMA: MasterSchema = {
  entity: 'countries',
  label: 'Country',
  label_plural: 'Countries',
  // Countries are platform-static — all tenants share the same
  // canonical ISO list. Not tenant-scoped.
  tenant_scoped: false,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 3, label: 'ISO code' },
    { name: 'name', type: 'string', required: true, max_length: 80, label: 'Name' },
    { name: 'region', type: 'enum', enum_values: ['AF', 'AS', 'EU', 'NA', 'OC', 'SA'], label: 'Region' },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'IN', name: 'India', region: 'AS', active: true },
    { code: 'BT', name: 'Bhutan', region: 'AS', active: true },
    { code: 'NP', name: 'Nepal', region: 'AS', active: true },
    { code: 'LK', name: 'Sri Lanka', region: 'AS', active: true },
    { code: 'KE', name: 'Kenya', region: 'AF', active: true },
    { code: 'US', name: 'United States', region: 'NA', active: true },
    { code: 'GB', name: 'United Kingdom', region: 'EU', active: true },
    { code: 'AE', name: 'United Arab Emirates', region: 'AS', active: true },
  ],
};

const DEPARTMENT_SCHEMA: MasterSchema = {
  entity: 'departments',
  label: 'Department',
  label_plural: 'Departments',
  // Per-bank — every tenant maintains its own department list.
  tenant_scoped: true,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
    {
      name: 'function',
      type: 'enum',
      enum_values: ['risk', 'compliance', 'operations', 'it', 'audit', 'business'],
      label: 'Function',
    },
    { name: 'headcount', type: 'integer', label: 'Headcount' },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'CR', name: 'Credit Risk', function: 'risk', headcount: 24, active: true },
    { code: 'OPS', name: 'Operations', function: 'operations', headcount: 80, active: true },
    { code: 'IA', name: 'Internal Audit', function: 'audit', headcount: 12, active: true },
    { code: 'CMP', name: 'Compliance', function: 'compliance', headcount: 18, active: true },
  ],
};

const RISK_CATEGORY_SCHEMA: MasterSchema = {
  entity: 'risk-categories',
  label: 'Risk Category',
  label_plural: 'Risk Categories',
  tenant_scoped: true,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
    {
      name: 'severity',
      type: 'enum',
      enum_values: ['critical', 'high', 'medium', 'low'],
      label: 'Default severity',
    },
    {
      name: 'domain',
      type: 'enum',
      enum_values: ['credit', 'fraud', 'aml', 'operational', 'market', 'liquidity'],
      label: 'Domain',
    },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'NPA', name: 'NPA / Default risk', severity: 'critical', domain: 'credit', active: true },
    { code: 'DPD30', name: 'DPD 30+ aging', severity: 'high', domain: 'credit', active: true },
    { code: 'FRD_VEL', name: 'Velocity fraud', severity: 'critical', domain: 'fraud', active: true },
    { code: 'KYC_EXP', name: 'KYC expired', severity: 'medium', domain: 'aml', active: true },
    { code: 'BREACH_SLA', name: 'Operational SLA breach', severity: 'high', domain: 'operational', active: true },
  ],
};

/** Master schemas live here. Add a new entity by appending its schema. */
export const MASTER_SCHEMAS: readonly MasterSchema[] = [
  COUNTRY_SCHEMA,
  DEPARTMENT_SCHEMA,
  RISK_CATEGORY_SCHEMA,
] as const;

const _byEntity = new Map<string, IMasterStore>();
for (const schema of MASTER_SCHEMAS) {
  _byEntity.set(schema.entity, createMasterStore(schema));
}

export function listMasterStores(): IMasterStore[] {
  return Array.from(_byEntity.values());
}

export function getMasterStore(entity: string): IMasterStore | undefined {
  return _byEntity.get(entity);
}

/** Slim public projection of the catalog — used by /v1/admin/masters
 *  to render the SPA menu without exposing the entire schema. */
export function listMasterCatalog(): Array<{
  entity: string;
  label: string;
  label_plural: string;
  tenant_scoped: boolean;
  field_count: number;
}> {
  return MASTER_SCHEMAS.map((s) => ({
    entity: s.entity,
    label: s.label,
    label_plural: s.label_plural,
    tenant_scoped: s.tenant_scoped,
    field_count: s.fields.length,
  }));
}
