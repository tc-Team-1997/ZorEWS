// Tenant catalogue surfaced on the onboarding tenant-selection page.
//
// Sourced from the BIL pitch + auth-svc seed registry + a handful of
// regional anchors per country so the cascading picker has realistic
// content end-to-end. Static for now; production swaps this for a
// /v1/tenants/catalog query that joins app_iam.tenants + branches.

import type { CountryCode } from './countries';
import type { EnterpriseDomain } from './enterpriseRoles';

export interface OrganizationDef {
  id: string;
  name: string;
  short_name: string;
  domain: Exclude<EnterpriseDomain, 'both'>;
  country: CountryCode;
  /** Regional macro-area within the country (e.g. North India, GCC West). */
  regions: string[];
  /** Branches/divisions within each region — flat list keyed by region. */
  branches: Record<string, string[]>;
  /** BFF tenant_id (matches app_iam.tenants.tenant_id). */
  tenant_id: string;
}

export const ORGANIZATIONS: OrganizationDef[] = [
  // --- Banking, India ---
  {
    id: 'sbi-in',
    name: 'State Bank of India',
    short_name: 'SBI',
    domain: 'banking',
    country: 'IN',
    regions: ['North India', 'West India', 'South India', 'East India'],
    branches: {
      'North India': ['Delhi-Parliament Street', 'Chandigarh-Sector 17', 'Lucknow-Hazratganj'],
      'West India': ['Mumbai-Fort', 'Pune-FC Road', 'Ahmedabad-CG Road'],
      'South India': ['Bengaluru-MG Road', 'Chennai-Mount Road', 'Hyderabad-Bank Street'],
      'East India': ['Kolkata-BBD Bagh', 'Bhubaneswar-Janpath'],
    },
    tenant_id: 'BANK_DEMO',
  },
  {
    id: 'hdfc-bank-in',
    name: 'HDFC Bank',
    short_name: 'HDFC',
    domain: 'banking',
    country: 'IN',
    regions: ['North India', 'West India', 'South India'],
    branches: {
      'North India': ['Delhi-CP', 'Delhi-Gurugram', 'Chandigarh', 'Lucknow'],
      'West India': ['Mumbai-BKC', 'Mumbai-Andheri', 'Pune-Camp', 'Ahmedabad'],
      'South India': ['Bengaluru-MG Road', 'Chennai-Anna Salai', 'Hyderabad-Hitec'],
    },
    tenant_id: 'BANK_DEMO',
  },
  {
    id: 'icici-bank-in',
    name: 'ICICI Bank',
    short_name: 'ICICI',
    domain: 'banking',
    country: 'IN',
    regions: ['North India', 'West India'],
    branches: {
      'North India': ['Delhi-Connaught Place', 'Noida-Sector 18'],
      'West India': ['Mumbai-Lower Parel', 'Pune-Aundh'],
    },
    tenant_id: 'BIL',
  },
  {
    id: 'bob-in',
    name: 'Bank of Baroda',
    short_name: 'BoB',
    domain: 'banking',
    country: 'IN',
    regions: ['West India', 'North India', 'South India'],
    branches: {
      'West India': ['Vadodara-Mandvi', 'Mumbai-Nariman Point', 'Ahmedabad-Relief Road'],
      'North India': ['Delhi-Parliament Street'],
      'South India': ['Bengaluru-Race Course Road'],
    },
    tenant_id: 'BANK_DEMO',
  },
  {
    id: 'axis-bank-in',
    name: 'Axis Bank',
    short_name: 'AXIS',
    domain: 'banking',
    country: 'IN',
    regions: ['North India', 'West India', 'South India'],
    branches: {
      'North India': ['Delhi-Connaught Place', 'Gurugram-Cyber Hub'],
      'West India': ['Mumbai-Worli', 'Pune-Senapati Bapat Road'],
      'South India': ['Bengaluru-Koramangala', 'Chennai-T Nagar'],
    },
    tenant_id: 'BANK_DEMO',
  },
  // --- Banking, UAE ---
  {
    id: 'enbd-ae',
    name: 'Emirates NBD',
    short_name: 'ENBD',
    domain: 'banking',
    country: 'AE',
    regions: ['Dubai', 'Abu Dhabi', 'Sharjah'],
    branches: {
      Dubai: ['Dubai-Deira HQ', 'Dubai-DIFC', 'Dubai-Jumeirah'],
      'Abu Dhabi': ['Abu Dhabi-Corniche', 'Abu Dhabi-Al Ain'],
      Sharjah: ['Sharjah-Buhaira'],
    },
    tenant_id: 'BANK_DEMO',
  },
  {
    id: 'adcb-ae',
    name: 'Abu Dhabi Commercial Bank',
    short_name: 'ADCB',
    domain: 'banking',
    country: 'AE',
    regions: ['Abu Dhabi', 'Dubai'],
    branches: {
      'Abu Dhabi': ['Abu Dhabi-Hamdan Street HQ', 'Abu Dhabi-Khalifa City'],
      Dubai: ['Dubai-Sheikh Zayed Road', 'Dubai-Mall of the Emirates'],
    },
    tenant_id: 'BANK_DEMO',
  },
  // --- Banking, Singapore ---
  {
    id: 'dbs-sg',
    name: 'DBS Bank',
    short_name: 'DBS',
    domain: 'banking',
    country: 'SG',
    regions: ['Central', 'East', 'West'],
    branches: {
      Central: ['DBS Marina Bay', 'DBS Raffles Place', 'DBS Orchard'],
      East: ['DBS Tampines', 'DBS Changi'],
      West: ['DBS Jurong East'],
    },
    tenant_id: 'BANK_DEMO',
  },
  // --- Banking, USA ---
  {
    id: 'jpm-us',
    name: 'JPMorgan Chase',
    short_name: 'JPM',
    domain: 'banking',
    country: 'US',
    regions: ['East Coast', 'Midwest', 'West Coast'],
    branches: {
      'East Coast': ['NYC-Park Avenue', 'NYC-Brooklyn', 'Boston'],
      Midwest: ['Chicago-Loop', 'Detroit'],
      'West Coast': ['SF-Financial District', 'LA-Downtown'],
    },
    tenant_id: 'BANK_DEMO',
  },
  // --- Banking, UK ---
  {
    id: 'barclays-gb',
    name: 'Barclays',
    short_name: 'BAR',
    domain: 'banking',
    country: 'GB',
    regions: ['London', 'Manchester', 'Edinburgh'],
    branches: {
      London: ['Canary Wharf', 'Mayfair', 'City of London'],
      Manchester: ['Manchester Spinningfields'],
      Edinburgh: ['Edinburgh George Street'],
    },
    tenant_id: 'BANK_DEMO',
  },
  // --- Banking, Canada ---
  {
    id: 'rbc-ca',
    name: 'Royal Bank of Canada',
    short_name: 'RBC',
    domain: 'banking',
    country: 'CA',
    regions: ['Ontario', 'Quebec', 'British Columbia'],
    branches: {
      Ontario: ['Toronto-Bay Street', 'Mississauga', 'Ottawa'],
      Quebec: ['Montreal-Centre-ville'],
      'British Columbia': ['Vancouver-Burrard'],
    },
    tenant_id: 'BANK_DEMO',
  },
  // --- Insurance, India ---
  {
    id: 'lic-in',
    name: 'Life Insurance Corporation of India',
    short_name: 'LIC',
    domain: 'insurance',
    country: 'IN',
    regions: ['West India', 'North India', 'South India', 'East India'],
    branches: {
      'West India': ['Mumbai HQ-Yogakshema', 'Pune-Camp', 'Ahmedabad-Lal Darwaza'],
      'North India': ['Delhi-Jeevan Bharti', 'Lucknow-Hazratganj'],
      'South India': ['Bengaluru-Jeevan Bhima Nagar', 'Chennai-Anna Salai'],
      'East India': ['Kolkata-Chowringhee'],
    },
    tenant_id: 'BIL',
  },
  {
    id: 'icici-lombard-in',
    name: 'ICICI Lombard',
    short_name: 'ICICI-L',
    domain: 'insurance',
    country: 'IN',
    regions: ['North India', 'West India', 'South India'],
    branches: {
      'North India': ['Delhi HQ', 'Noida Ops'],
      'West India': ['Mumbai-Lower Parel', 'Pune-Yerwada'],
      'South India': ['Bengaluru-Whitefield', 'Hyderabad-Madhapur'],
    },
    tenant_id: 'BIL',
  },
  {
    id: 'hdfc-ergo-in',
    name: 'HDFC ERGO General Insurance',
    short_name: 'HDFC-E',
    domain: 'insurance',
    country: 'IN',
    regions: ['West India', 'North India', 'South India'],
    branches: {
      'West India': ['Mumbai-Lower Parel HQ', 'Pune-Aundh'],
      'North India': ['Delhi-Saket', 'Noida-Sector 62'],
      'South India': ['Bengaluru-Whitefield', 'Chennai-Egmore'],
    },
    tenant_id: 'BIL',
  },
  {
    id: 'new-india-in',
    name: 'New India Assurance',
    short_name: 'NIA',
    domain: 'insurance',
    country: 'IN',
    regions: ['West India', 'North India', 'South India', 'East India'],
    branches: {
      'West India': ['Mumbai-Fort HQ', 'Ahmedabad'],
      'North India': ['Delhi-Connaught Place'],
      'South India': ['Bengaluru-MG Road', 'Chennai'],
      'East India': ['Kolkata-BBD Bagh'],
    },
    tenant_id: 'BIL',
  },
  {
    id: 'bajaj-allianz-in',
    name: 'Bajaj Allianz Insurance',
    short_name: 'BAGIC',
    domain: 'insurance',
    country: 'IN',
    regions: ['West India', 'South India'],
    branches: {
      'West India': ['Pune HQ', 'Mumbai-Worli'],
      'South India': ['Bengaluru-Indiranagar'],
    },
    tenant_id: 'BIL',
  },
  // --- Insurance, UAE ---
  {
    id: 'oman-ins-ae',
    name: 'Oman Insurance',
    short_name: 'OIC',
    domain: 'insurance',
    country: 'AE',
    regions: ['Dubai', 'Abu Dhabi'],
    branches: {
      Dubai: ['Dubai-Sheikh Zayed Road', 'Dubai-Bur Dubai'],
      'Abu Dhabi': ['Abu Dhabi-Khalidiya'],
    },
    tenant_id: 'BIL',
  },
  // --- Insurance, Singapore ---
  {
    id: 'aia-sg',
    name: 'AIA Singapore',
    short_name: 'AIA-SG',
    domain: 'insurance',
    country: 'SG',
    regions: ['Central'],
    branches: {
      Central: ['AIA Tower', 'AIA East Coast'],
    },
    tenant_id: 'BIL',
  },
  // --- Insurance, USA ---
  {
    id: 'metlife-us',
    name: 'MetLife',
    short_name: 'MET',
    domain: 'insurance',
    country: 'US',
    regions: ['East Coast', 'Midwest', 'West Coast'],
    branches: {
      'East Coast': ['NYC HQ', 'Boston'],
      Midwest: ['Chicago'],
      'West Coast': ['LA', 'SF'],
    },
    tenant_id: 'BIL',
  },
  // --- Insurance, UK ---
  {
    id: 'aviva-gb',
    name: 'Aviva',
    short_name: 'AVI',
    domain: 'insurance',
    country: 'GB',
    regions: ['London', 'Norwich'],
    branches: {
      London: ['London-St Helens', 'London-City'],
      Norwich: ['Norwich HQ'],
    },
    tenant_id: 'BIL',
  },
  // --- Insurance, Canada ---
  {
    id: 'manulife-ca',
    name: 'Manulife',
    short_name: 'MFC',
    domain: 'insurance',
    country: 'CA',
    regions: ['Ontario', 'Quebec'],
    branches: {
      Ontario: ['Toronto-Bloor', 'Waterloo'],
      Quebec: ['Montreal'],
    },
    tenant_id: 'BIL',
  },
];

export function organizationsFor(
  country: CountryCode,
  domain: Exclude<EnterpriseDomain, 'both'>,
): OrganizationDef[] {
  return ORGANIZATIONS.filter((o) => o.country === country && o.domain === domain);
}

export function getOrganization(id: string | null | undefined): OrganizationDef | null {
  if (!id) return null;
  return ORGANIZATIONS.find((o) => o.id === id) ?? null;
}

export const TENANT_CONTEXT_KEY = 'zorews.tenantContext';

export interface TenantContext {
  country: CountryCode;
  domain: 'banking' | 'insurance';
  organization_id: string;
  region: string;
  branch: string;
  /** Mirrored from the chosen org for fast access at request time. */
  tenant_id: string;
}
