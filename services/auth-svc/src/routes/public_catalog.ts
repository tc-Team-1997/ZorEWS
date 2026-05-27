/**
 * Public catalog endpoints — `/api/auth/{countries,domains,tenants}`.
 *
 * These are anonymous (no Bearer required) lookups the login screen
 * uses to populate its country / domain / tenant dropdowns BEFORE
 * credentials are exchanged. No PII, no tenant-specific state.
 *
 * They sit at `/api/auth/...` rather than `/auth/...` so the SPA's
 * Vite proxy (and the production BFF) can keep `/auth/*` reserved
 * for credentialed flows and namespace public catalog data under
 * `/api/*` alongside the regular SPA endpoints.
 *
 * Backed by static catalogs that mirror `web/src/lib/countries.ts`
 * and `web/src/lib/organizations.ts` so the SPA can either read
 * these endpoints OR fall back to its bundled copies in offline
 * mode (MSW) — both produce the same shape.
 */

import type { FastifyInstance } from "fastify";

export interface CountryEntry {
  code: string;
  name: string;
  flag: string;
  currency: { code: string; symbol: string };
  locale: string;
  timezone: { label: string; tz: string };
  date_format: string;
  regulators: {
    banking: string[];
    insurance: string[];
  };
}

export interface DomainEntry {
  id: "banking" | "insurance";
  label: string;
  description: string;
}

export interface TenantEntry {
  id: string;
  name: string;
  short_name: string;
  domain: "banking" | "insurance";
  country: string;
  regions: string[];
  /** Operational tenant_id the BFF X-Tenant-ID header expects. */
  tenant_id: string;
}

/** Mirror of `web/src/lib/countries.ts` — kept inline so the auth-svc
 *  has no cross-service file dependency on the SPA tree. Both lists
 *  are deliberately small (6 entries) and change rarely. */
const COUNTRIES: CountryEntry[] = [
  {
    code: "IN",
    name: "India",
    flag: "🇮🇳",
    currency: { code: "INR", symbol: "₹" },
    locale: "en-IN",
    timezone: { label: "IST (UTC+5:30)", tz: "Asia/Kolkata" },
    date_format: "DD-MMM-YYYY",
    regulators: { banking: ["RBI", "BAC-A 2024"], insurance: ["IRDAI", "IFRS 9"] },
  },
  {
    code: "AE",
    name: "United Arab Emirates",
    flag: "🇦🇪",
    currency: { code: "AED", symbol: "د.إ" },
    locale: "en-AE",
    timezone: { label: "GST (UTC+4)", tz: "Asia/Dubai" },
    date_format: "DD/MM/YYYY",
    regulators: { banking: ["CBUAE", "Basel III"], insurance: ["CBUAE Insurance", "IFRS 17"] },
  },
  {
    code: "SG",
    name: "Singapore",
    flag: "🇸🇬",
    currency: { code: "SGD", symbol: "S$" },
    locale: "en-SG",
    timezone: { label: "SGT (UTC+8)", tz: "Asia/Singapore" },
    date_format: "DD/MM/YYYY",
    regulators: { banking: ["MAS Notice 612", "Basel III"], insurance: ["MAS Notice 133", "RBC 2"] },
  },
  {
    code: "US",
    name: "United States",
    flag: "🇺🇸",
    currency: { code: "USD", symbol: "$" },
    locale: "en-US",
    timezone: { label: "ET (UTC−5)", tz: "America/New_York" },
    date_format: "MM/DD/YYYY",
    regulators: { banking: ["FRB SR 11-7", "OCC 2011-12", "CECL"], insurance: ["NAIC", "ORSA"] },
  },
  {
    code: "GB",
    name: "United Kingdom",
    flag: "🇬🇧",
    currency: { code: "GBP", symbol: "£" },
    locale: "en-GB",
    timezone: { label: "GMT (UTC+0)", tz: "Europe/London" },
    date_format: "DD/MM/YYYY",
    regulators: { banking: ["PRA SS3/18", "Basel III.1"], insurance: ["PRA", "Solvency II"] },
  },
  {
    code: "CA",
    name: "Canada",
    flag: "🇨🇦",
    currency: { code: "CAD", symbol: "C$" },
    locale: "en-CA",
    timezone: { label: "ET (UTC−5)", tz: "America/Toronto" },
    date_format: "YYYY-MM-DD",
    regulators: { banking: ["OSFI E-23", "Basel III"], insurance: ["OSFI MCT", "LICAT"] },
  },
];

const DOMAINS: DomainEntry[] = [
  {
    id: "banking",
    label: "Banking",
    description: "Borrower stress, NPA risk, fraud signals, portfolio health.",
  },
  {
    id: "insurance",
    label: "Insurance",
    description: "Claim fraud, lapse, underwriting anomalies, premium-collection risk.",
  },
];

/** Mirror of `web/src/lib/organizations.ts`. Trimmed to (id, name,
 *  short_name, domain, country, regions[], tenant_id) — the SPA
 *  already has the full branch matrix bundled. */
const TENANTS: TenantEntry[] = [
  // India banking
  { id: "sbi-in",         name: "State Bank of India",       short_name: "SBI",    domain: "banking",   country: "IN", regions: ["North India", "West India", "South India", "East India"], tenant_id: "BANK_DEMO" },
  { id: "hdfc-bank-in",   name: "HDFC Bank",                  short_name: "HDFC",   domain: "banking",   country: "IN", regions: ["North India", "West India", "South India"], tenant_id: "BANK_DEMO" },
  { id: "icici-bank-in",  name: "ICICI Bank",                 short_name: "ICICI",  domain: "banking",   country: "IN", regions: ["North India", "West India"], tenant_id: "BIL" },
  { id: "bob-in",         name: "Bank of Baroda",             short_name: "BoB",    domain: "banking",   country: "IN", regions: ["West India", "North India", "South India"], tenant_id: "BANK_DEMO" },
  { id: "axis-bank-in",   name: "Axis Bank",                  short_name: "AXIS",   domain: "banking",   country: "IN", regions: ["North India", "West India", "South India"], tenant_id: "BANK_DEMO" },
  // UAE banking
  { id: "enbd-ae",        name: "Emirates NBD",               short_name: "ENBD",   domain: "banking",   country: "AE", regions: ["Dubai", "Abu Dhabi", "Sharjah"], tenant_id: "BANK_DEMO" },
  { id: "adcb-ae",        name: "Abu Dhabi Commercial Bank",  short_name: "ADCB",   domain: "banking",   country: "AE", regions: ["Abu Dhabi", "Dubai"], tenant_id: "BANK_DEMO" },
  // SG banking
  { id: "dbs-sg",         name: "DBS Bank",                   short_name: "DBS",    domain: "banking",   country: "SG", regions: ["Central", "East", "West"], tenant_id: "BANK_DEMO" },
  // US banking
  { id: "jpm-us",         name: "JPMorgan Chase",             short_name: "JPM",    domain: "banking",   country: "US", regions: ["East Coast", "Midwest", "West Coast"], tenant_id: "BANK_DEMO" },
  // UK banking
  { id: "barclays-gb",    name: "Barclays",                   short_name: "BAR",    domain: "banking",   country: "GB", regions: ["London", "Manchester", "Edinburgh"], tenant_id: "BANK_DEMO" },
  // CA banking
  { id: "rbc-ca",         name: "Royal Bank of Canada",       short_name: "RBC",    domain: "banking",   country: "CA", regions: ["Ontario", "Quebec", "British Columbia"], tenant_id: "BANK_DEMO" },
  // India insurance
  { id: "lic-in",         name: "Life Insurance Corp of India", short_name: "LIC",  domain: "insurance", country: "IN", regions: ["West India", "North India", "South India", "East India"], tenant_id: "BIL" },
  { id: "icici-lombard-in", name: "ICICI Lombard",            short_name: "ICICI-L", domain: "insurance", country: "IN", regions: ["North India", "West India", "South India"], tenant_id: "BIL" },
  { id: "hdfc-ergo-in",   name: "HDFC ERGO General Insurance", short_name: "HDFC-E", domain: "insurance", country: "IN", regions: ["West India", "North India", "South India"], tenant_id: "BIL" },
  { id: "new-india-in",   name: "New India Assurance",        short_name: "NIA",    domain: "insurance", country: "IN", regions: ["West India", "North India", "South India", "East India"], tenant_id: "BIL" },
  { id: "bajaj-allianz-in", name: "Bajaj Allianz Insurance",  short_name: "BAGIC",  domain: "insurance", country: "IN", regions: ["West India", "South India"], tenant_id: "BIL" },
  // UAE insurance
  { id: "oman-ins-ae",    name: "Oman Insurance",             short_name: "OIC",    domain: "insurance", country: "AE", regions: ["Dubai", "Abu Dhabi"], tenant_id: "BIL" },
  // SG insurance
  { id: "aia-sg",         name: "AIA Singapore",              short_name: "AIA-SG", domain: "insurance", country: "SG", regions: ["Central"], tenant_id: "BIL" },
  // US insurance
  { id: "metlife-us",     name: "MetLife",                    short_name: "MET",    domain: "insurance", country: "US", regions: ["East Coast", "Midwest", "West Coast"], tenant_id: "BIL" },
  // UK insurance
  { id: "aviva-gb",       name: "Aviva",                      short_name: "AVI",    domain: "insurance", country: "GB", regions: ["London", "Norwich"], tenant_id: "BIL" },
  // CA insurance
  { id: "manulife-ca",    name: "Manulife",                   short_name: "MFC",    domain: "insurance", country: "CA", regions: ["Ontario", "Quebec"], tenant_id: "BIL" },
];

export function registerPublicCatalogRoutes(app: FastifyInstance): void {
  /**
   * GET /api/auth/countries
   *
   * Public — returns the 6-country catalogue used by the login picker.
   * Includes currency / locale / timezone / date_format / regulators
   * so the SPA can render the regulatory chip strip the moment a
   * country is chosen.
   */
  app.get("/api/auth/countries", async (_req, reply) => {
    return reply.send({ total: COUNTRIES.length, countries: COUNTRIES });
  });

  /**
   * GET /api/auth/domains
   *
   * Public — banking | insurance with one-line descriptions.
   */
  app.get("/api/auth/domains", async (_req, reply) => {
    return reply.send({ total: DOMAINS.length, domains: DOMAINS });
  });

  /**
   * GET /api/auth/tenants?country=&domain=
   *
   * Public — paginated tenant list, optionally filtered by country +
   * domain. Returns the static catalogue today; production swaps in
   * the live tenant registry from app_iam.tenants.
   */
  app.get<{ Querystring: { country?: string; domain?: string } }>(
    "/api/auth/tenants",
    async (req, reply) => {
      const { country, domain } = req.query ?? {};
      if (domain && domain !== "banking" && domain !== "insurance") {
        return reply.code(400).send({ error: "invalid_domain", message: "domain must be banking or insurance" });
      }
      let filtered = TENANTS.slice();
      if (country) filtered = filtered.filter((t) => t.country === country);
      if (domain) filtered = filtered.filter((t) => t.domain === domain);
      return reply.send({
        total: filtered.length,
        filters: { country: country ?? null, domain: domain ?? null },
        tenants: filtered,
      });
    },
  );
}
