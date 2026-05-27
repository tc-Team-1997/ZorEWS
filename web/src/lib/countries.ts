// Country catalog for the enterprise onboarding flow.
//
// Each country drives locale-sensitive defaults (currency, date format,
// timezone) AND domain-specific regulatory context (banking + insurance
// regulators, risk thresholds). The login + onboarding pages read this
// single source of truth — DO NOT inline hex/text country data in TSX.

export type CountryCode = 'IN' | 'AE' | 'SG' | 'US' | 'GB' | 'CA';

export interface CountryDef {
  code: CountryCode;
  name: string;
  flag: string; // Unicode regional-indicator pair
  currency: { code: string; symbol: string };
  /** Intl-style locale tag — drives date/number formatting downstream. */
  locale: string;
  /** Canonical timezone label shown in the UI. */
  timezone: { label: string; tz: string };
  /** Date pattern shown next to the country in pickers + form previews. */
  date_format: string;
  /** Per-domain regulator + framework labels. */
  regulators: {
    banking: string[];
    insurance: string[];
  };
  /** Country-specific risk thresholds (basis points / pp) — surfaced
   *  on the login splash so ops see what their country defaults to. */
  risk_thresholds: {
    high_risk_pd_pct: number;
    sma_dpd_days: number;
  };
  /** Localisation: short flag-ish description for the country card. */
  blurb: string;
}

/**
 * 6 countries from the EWS launch list. Order matters — this is the
 * order shown in the login picker.
 */
export const COUNTRIES: CountryDef[] = [
  {
    code: 'IN',
    name: 'India',
    flag: '🇮🇳',
    currency: { code: 'INR', symbol: '₹' },
    locale: 'en-IN',
    timezone: { label: 'IST (UTC+5:30)', tz: 'Asia/Kolkata' },
    date_format: 'DD-MMM-YYYY',
    regulators: {
      banking: ['RBI', 'BAC-A 2024'],
      insurance: ['IRDAI', 'IFRS 9'],
    },
    risk_thresholds: { high_risk_pd_pct: 5.0, sma_dpd_days: 30 },
    blurb: 'RBI Master Direction · BAC-A · IFRS 9',
  },
  {
    code: 'AE',
    name: 'United Arab Emirates',
    flag: '🇦🇪',
    currency: { code: 'AED', symbol: 'د.إ' },
    locale: 'en-AE',
    timezone: { label: 'GST (UTC+4)', tz: 'Asia/Dubai' },
    date_format: 'DD/MM/YYYY',
    regulators: {
      banking: ['CBUAE', 'Basel III'],
      insurance: ['CBUAE Insurance', 'IFRS 17'],
    },
    risk_thresholds: { high_risk_pd_pct: 4.5, sma_dpd_days: 30 },
    blurb: 'CBUAE · Basel III · IFRS 17',
  },
  {
    code: 'SG',
    name: 'Singapore',
    flag: '🇸🇬',
    currency: { code: 'SGD', symbol: 'S$' },
    locale: 'en-SG',
    timezone: { label: 'SGT (UTC+8)', tz: 'Asia/Singapore' },
    date_format: 'DD/MM/YYYY',
    regulators: {
      banking: ['MAS Notice 612', 'Basel III'],
      insurance: ['MAS Notice 133', 'RBC 2'],
    },
    risk_thresholds: { high_risk_pd_pct: 3.5, sma_dpd_days: 30 },
    blurb: 'MAS Notice 612 · RBC 2 · Basel III',
  },
  {
    code: 'US',
    name: 'United States',
    flag: '🇺🇸',
    currency: { code: 'USD', symbol: '$' },
    locale: 'en-US',
    timezone: { label: 'ET (UTC−5)', tz: 'America/New_York' },
    date_format: 'MM/DD/YYYY',
    regulators: {
      banking: ['FRB SR 11-7', 'OCC 2011-12', 'CECL'],
      insurance: ['NAIC', 'ORSA'],
    },
    risk_thresholds: { high_risk_pd_pct: 4.0, sma_dpd_days: 30 },
    blurb: 'FRB · OCC · CECL · NAIC',
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    flag: '🇬🇧',
    currency: { code: 'GBP', symbol: '£' },
    locale: 'en-GB',
    timezone: { label: 'GMT (UTC+0)', tz: 'Europe/London' },
    date_format: 'DD/MM/YYYY',
    regulators: {
      banking: ['PRA SS3/18', 'Basel III.1'],
      insurance: ['PRA', 'Solvency II'],
    },
    risk_thresholds: { high_risk_pd_pct: 4.0, sma_dpd_days: 30 },
    blurb: 'PRA · FCA · Solvency II · Basel III.1',
  },
  {
    code: 'CA',
    name: 'Canada',
    flag: '🇨🇦',
    currency: { code: 'CAD', symbol: 'C$' },
    locale: 'en-CA',
    timezone: { label: 'ET (UTC−5)', tz: 'America/Toronto' },
    date_format: 'YYYY-MM-DD',
    regulators: {
      banking: ['OSFI E-23', 'Basel III'],
      insurance: ['OSFI MCT', 'LICAT'],
    },
    risk_thresholds: { high_risk_pd_pct: 4.0, sma_dpd_days: 30 },
    blurb: 'OSFI · LICAT · MCT · Basel III',
  },
];

export function getCountry(code: CountryCode | string | null | undefined): CountryDef | null {
  if (!code) return null;
  return COUNTRIES.find((c) => c.code === code) ?? null;
}

/** Persisted under this key for cross-tab + page-reload survival. */
export const COUNTRY_STORAGE_KEY = 'zorews.country';
