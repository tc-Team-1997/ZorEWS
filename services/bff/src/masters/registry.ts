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

// ──────────────────────────────────────────────────────────────────────
// Phase 9 T11 — additional entities (currencies / severity / case-types
// / case-priorities / regulatory frameworks / channels).
//
// Each below is the SAME shape as the three above — the framework does
// the rest. Adding a 10th entity is still ~15 lines of declaration.
// ──────────────────────────────────────────────────────────────────────

const CURRENCY_SCHEMA: MasterSchema = {
  entity: 'currencies',
  label: 'Currency',
  label_plural: 'Currencies',
  // ISO 4217 — every tenant sees the same canonical list.
  tenant_scoped: false,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 3, label: 'ISO code' },
    { name: 'name', type: 'string', required: true, max_length: 80, label: 'Name' },
    { name: 'symbol', type: 'string', max_length: 8, label: 'Symbol' },
    {
      name: 'decimal_places',
      type: 'integer',
      label: 'Decimal places',
    },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimal_places: 2, active: true },
    { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', decimal_places: 2, active: true },
    { code: 'BTN', name: 'Bhutanese Ngultrum', symbol: 'Nu.', decimal_places: 2, active: true },
    { code: 'USD', name: 'United States Dollar', symbol: '$', decimal_places: 2, active: true },
    { code: 'EUR', name: 'Euro', symbol: '€', decimal_places: 2, active: true },
    { code: 'GBP', name: 'Pound Sterling', symbol: '£', decimal_places: 2, active: true },
    { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', decimal_places: 2, active: true },
    { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimal_places: 0, active: true },
  ],
};

const SEVERITY_LEVEL_SCHEMA: MasterSchema = {
  entity: 'severity-levels',
  label: 'Severity Level',
  label_plural: 'Severity Levels',
  // Per-tenant — risk teams calibrate their own RAG cutoffs.
  tenant_scoped: true,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 80, label: 'Name' },
    {
      name: 'colour',
      type: 'enum',
      enum_values: ['red', 'orange', 'amber', 'yellow', 'green'],
      label: 'RAG colour',
    },
    { name: 'min_score', type: 'integer', label: 'Min score' },
    { name: 'max_score', type: 'integer', label: 'Max score' },
    { name: 'action_required', type: 'boolean', label: 'Action required' },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'RED', name: 'Red — Immediate action', colour: 'red', min_score: 80, max_score: 100, action_required: true, active: true },
    { code: 'ORG', name: 'Orange — Escalate', colour: 'orange', min_score: 60, max_score: 79, action_required: true, active: true },
    { code: 'AMB', name: 'Amber — Review', colour: 'amber', min_score: 40, max_score: 59, action_required: true, active: true },
    { code: 'YEL', name: 'Yellow — Watch', colour: 'yellow', min_score: 20, max_score: 39, action_required: false, active: true },
    { code: 'GRN', name: 'Green — Healthy', colour: 'green', min_score: 0, max_score: 19, action_required: false, active: true },
  ],
};

const CASE_TYPE_SCHEMA: MasterSchema = {
  entity: 'case-types',
  label: 'Case Type',
  label_plural: 'Case Types',
  tenant_scoped: true,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
    {
      name: 'domain',
      type: 'enum',
      enum_values: ['credit', 'fraud', 'aml', 'operational', 'compliance', 'underwriting', 'claims'],
      label: 'Domain',
    },
    { name: 'default_sla_hours', type: 'integer', label: 'Default SLA (hours)' },
    { name: 'requires_maker_checker', type: 'boolean', label: 'Maker-checker' },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'NPA_INV', name: 'NPA investigation', domain: 'credit', default_sla_hours: 24, requires_maker_checker: true, active: true },
    { code: 'FRD_INV', name: 'Fraud investigation', domain: 'fraud', default_sla_hours: 4, requires_maker_checker: true, active: true },
    { code: 'AML_STR', name: 'AML / STR review', domain: 'aml', default_sla_hours: 48, requires_maker_checker: true, active: true },
    { code: 'KYC_REF', name: 'KYC refresh', domain: 'compliance', default_sla_hours: 72, requires_maker_checker: false, active: true },
    { code: 'CLM_FRD', name: 'Claim fraud review', domain: 'claims', default_sla_hours: 24, requires_maker_checker: true, active: true },
    { code: 'UW_DEV', name: 'Underwriting deviation', domain: 'underwriting', default_sla_hours: 24, requires_maker_checker: false, active: true },
  ],
};

const CASE_PRIORITY_SCHEMA: MasterSchema = {
  entity: 'case-priorities',
  label: 'Case Priority',
  label_plural: 'Case Priorities',
  tenant_scoped: true,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 8, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 80, label: 'Name' },
    {
      name: 'sla_hours',
      type: 'integer',
      label: 'SLA (hours)',
    },
    { name: 'escalate_after_hours', type: 'integer', label: 'Escalate after (hours)' },
    {
      name: 'colour',
      type: 'enum',
      enum_values: ['red', 'orange', 'amber', 'yellow', 'green'],
      label: 'RAG colour',
    },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'P1', name: 'P1 — Critical', sla_hours: 4, escalate_after_hours: 1, colour: 'red', active: true },
    { code: 'P2', name: 'P2 — High', sla_hours: 24, escalate_after_hours: 8, colour: 'orange', active: true },
    { code: 'P3', name: 'P3 — Medium', sla_hours: 72, escalate_after_hours: 24, colour: 'amber', active: true },
    { code: 'P4', name: 'P4 — Low', sla_hours: 168, escalate_after_hours: 96, colour: 'yellow', active: true },
  ],
};

const REGULATORY_FRAMEWORK_SCHEMA: MasterSchema = {
  entity: 'regulatory-frameworks',
  label: 'Regulatory Framework',
  label_plural: 'Regulatory Frameworks',
  // Platform — every tenant sees the same regulator catalog; the SMA
  // module routes by tenant.vertical + tenant.country.
  tenant_scoped: false,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
    {
      name: 'country',
      type: 'enum',
      enum_values: ['IN', 'KE', 'BT', 'NP', 'LK', 'AE', 'GB', 'US'],
      label: 'Country',
    },
    {
      name: 'vertical',
      type: 'enum',
      enum_values: ['banking', 'insurance', 'capital_markets', 'payments', 'aml'],
      label: 'Vertical',
    },
    {
      name: 'classification_scheme',
      type: 'enum',
      enum_values: ['SMA', 'STAGE', 'NONE'],
      label: 'Classification scheme',
    },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'RBI', name: 'Reserve Bank of India', country: 'IN', vertical: 'banking', classification_scheme: 'SMA', active: true },
    { code: 'IRDAI', name: 'Insurance Regulatory and Development Authority of India', country: 'IN', vertical: 'insurance', classification_scheme: 'STAGE', active: true },
    { code: 'RMA', name: 'Royal Monetary Authority of Bhutan', country: 'BT', vertical: 'banking', classification_scheme: 'SMA', active: true },
    { code: 'CBK', name: 'Central Bank of Kenya', country: 'KE', vertical: 'banking', classification_scheme: 'SMA', active: true },
    { code: 'NRB', name: 'Nepal Rastra Bank', country: 'NP', vertical: 'banking', classification_scheme: 'SMA', active: true },
    { code: 'CBSL', name: 'Central Bank of Sri Lanka', country: 'LK', vertical: 'banking', classification_scheme: 'SMA', active: true },
    { code: 'FIU', name: 'Financial Intelligence Unit', country: 'IN', vertical: 'aml', classification_scheme: 'NONE', active: true },
  ],
};

// ── Governance Center additions (additive — Master Setup remains the
//    canonical registry; Governance Center wraps it with a layered UX).
//
// Regions group branches within a country (e.g. India / North / South /
// East / West). Tenant-scoped — different tenants may slice regions
// differently. Field `country_code` joins to the COUNTRY_SCHEMA master
// (or to app_iam.tenants.country_code for the global view).
const REGION_SCHEMA: MasterSchema = {
  entity: 'regions',
  label: 'Region',
  label_plural: 'Regions',
  tenant_scoped: true,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 32, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 200, label: 'Name' },
    { name: 'country_code', type: 'string', max_length: 4, label: 'Country ISO code' },
    { name: 'parent_region', type: 'string', max_length: 200, label: 'Parent region (optional)' },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'IN_NORTH', name: 'India · North', country_code: 'IN', parent_region: '', active: true },
    { code: 'IN_SOUTH', name: 'India · South', country_code: 'IN', parent_region: '', active: true },
    { code: 'IN_EAST',  name: 'India · East',  country_code: 'IN', parent_region: '', active: true },
    { code: 'IN_WEST',  name: 'India · West',  country_code: 'IN', parent_region: '', active: true },
  ],
};

// Business Calendar — working days + holidays per country/tenant. Drives
// the SLA + escalation timer business-day math. Tenant-scoped because
// banks + insurers in the same country often diverge on regional holidays.
const BUSINESS_CALENDAR_SCHEMA: MasterSchema = {
  entity: 'business-calendars',
  label: 'Business Calendar',
  label_plural: 'Business Calendars',
  tenant_scoped: true,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 32, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 200, label: 'Name' },
    { name: 'country_code', type: 'string', max_length: 4, label: 'Country ISO code' },
    {
      name: 'domain',
      type: 'enum',
      enum_values: ['banking', 'insurance', 'shared'],
      label: 'Domain',
    },
    {
      name: 'working_days',
      type: 'string',
      max_length: 32,
      label: 'Working days (CSV, ISO Mon=1..Sun=7)',
    },
    { name: 'holidays_csv', type: 'string', max_length: 4000, label: 'Holiday dates (YYYY-MM-DD, comma-sep)' },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    {
      code: 'IN_BANK_2026',
      name: 'India · Banking · 2026',
      country_code: 'IN',
      domain: 'banking',
      working_days: '1,2,3,4,5',
      holidays_csv: '2026-01-26,2026-08-15,2026-10-02,2026-12-25',
      active: true,
    },
    {
      code: 'IN_INS_2026',
      name: 'India · Insurance · 2026',
      country_code: 'IN',
      domain: 'insurance',
      working_days: '1,2,3,4,5,6',
      holidays_csv: '2026-01-26,2026-08-15,2026-10-02,2026-12-25',
      active: true,
    },
    {
      code: 'BT_SHARED_2026',
      name: 'Bhutan · Shared · 2026',
      country_code: 'BT',
      domain: 'shared',
      working_days: '1,2,3,4,5',
      holidays_csv: '2026-02-21,2026-12-17',
      active: true,
    },
  ],
};

const CHANNEL_SCHEMA: MasterSchema = {
  entity: 'channels',
  label: 'Channel',
  label_plural: 'Channels',
  tenant_scoped: true,
  fields: [
    { name: 'code', type: 'string', required: true, max_length: 16, label: 'Code' },
    { name: 'name', type: 'string', required: true, max_length: 120, label: 'Name' },
    {
      name: 'kind',
      type: 'enum',
      enum_values: ['email', 'sms', 'push', 'in_app', 'webhook', 'phone'],
      label: 'Kind',
    },
    { name: 'rate_limit_per_minute', type: 'integer', label: 'Rate limit (per min)' },
    { name: 'quiet_hours_enabled', type: 'boolean', label: 'Honour quiet hours' },
    { name: 'active', type: 'boolean', label: 'Active' },
  ],
  seed: [
    { code: 'EMAIL_PRI', name: 'Primary email', kind: 'email', rate_limit_per_minute: 60, quiet_hours_enabled: true, active: true },
    { code: 'SMS_PRI', name: 'Primary SMS', kind: 'sms', rate_limit_per_minute: 30, quiet_hours_enabled: true, active: true },
    { code: 'PUSH_OPS', name: 'Ops push', kind: 'push', rate_limit_per_minute: 120, quiet_hours_enabled: false, active: true },
    { code: 'INAPP_BELL', name: 'In-app bell', kind: 'in_app', rate_limit_per_minute: 600, quiet_hours_enabled: false, active: true },
    { code: 'WBHK_SIEM', name: 'SIEM webhook', kind: 'webhook', rate_limit_per_minute: 600, quiet_hours_enabled: false, active: true },
    { code: 'PHONE_HOC', name: 'Head-of-Credit phone tree', kind: 'phone', rate_limit_per_minute: 6, quiet_hours_enabled: false, active: true },
  ],
};

/** Master schemas live here. Add a new entity by appending its schema. */
export const MASTER_SCHEMAS: readonly MasterSchema[] = [
  COUNTRY_SCHEMA,
  DEPARTMENT_SCHEMA,
  RISK_CATEGORY_SCHEMA,
  // Phase 9 T11 follow-up — 6 high-value entities.
  CURRENCY_SCHEMA,
  SEVERITY_LEVEL_SCHEMA,
  CASE_TYPE_SCHEMA,
  CASE_PRIORITY_SCHEMA,
  REGULATORY_FRAMEWORK_SCHEMA,
  CHANNEL_SCHEMA,
  // Governance Center additions — wire into the same T11 framework for
  // auto-CRUD + audit fan-out + permission gates.
  REGION_SCHEMA,
  BUSINESS_CALENDAR_SCHEMA,
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
