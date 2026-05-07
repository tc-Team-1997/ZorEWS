// services/bff/src/lookups.ts
//
// Thin lookup tables for the customer + rule joins. In production agent-data
// owns customer master and agent-rule owns the rule registry — the BFF
// fetches both and caches them. For the prototype we ship in-memory seeds
// that match the UI mock fixtures (web/src/mocks/data.ts) so tests and a
// local `npm run dev` produce the same names users see in the SPA's MSW
// path.

import type { CustomerLookup, Lookups, RuleLookup } from './types';

export const SEED_CUSTOMERS: CustomerLookup = {
  'c-101': { name: 'Achieng Otieno',   exposure_kes: 1_240_000 },
  'c-102': { name: 'Brian Kamau',      exposure_kes:   540_000 },
  'c-103': { name: 'Cynthia Mwangi',   exposure_kes:   320_000 },
  'c-104': { name: 'Daniel Wanjiku',   exposure_kes:   150_000 },
  'c-105': { name: 'Esther Njeri',     exposure_kes:   880_000 },
  'c-106': { name: 'Faisal Hussein',   exposure_kes: 1_650_000 },
  'c-107': { name: 'Grace Atieno',     exposure_kes:   470_000 },
  'c-108': { name: 'Hassan Otieno',    exposure_kes:   220_000 },
  'c-109': { name: 'Irene Mutua',      exposure_kes:   780_000 },
  'c-110': { name: 'James Kiprotich',  exposure_kes:   380_000 },
  'c-111': { name: 'Kavita Singh',     exposure_kes:   180_000 },
  'c-112': { name: 'Linus Owino',      exposure_kes:   910_000 },
  'c-113': { name: 'Mary Wambui',      exposure_kes:   420_000 },
  'c-114': { name: 'Nathan Korir',     exposure_kes:   260_000 },
  'c-115': { name: 'Olivia Cherop',    exposure_kes: 1_980_000 },
  'c-116': { name: 'Peter Maina',      exposure_kes:   720_000 },
  'c-117': { name: 'Quentin Wamalwa',  exposure_kes:   510_000 },
  'c-118': { name: 'Ruth Akinyi',      exposure_kes:   840_000 },
  'c-119': { name: 'Samuel Tanui',     exposure_kes:   195_000 },
  'c-120': { name: 'Tabitha Njoroge',  exposure_kes: 1_110_000 },
};

export const SEED_RULES: RuleLookup = {
  'r-22': { name: 'Salary inflow stopped 60d' },
  'r-09': { name: 'DPD ≥ 30 + utilisation > 95%' },
  'r-14': { name: 'Cheque return 2× in 30d' },
  'r-15': { name: 'Net flow drop 30d > 40%' },
  'r-18': { name: 'Sudden cash withdrawal pattern' },
  'r-25': { name: 'Multi-bureau delinquency confirmed' },
  'r-30': { name: 'Cross-product default cascade' },
  'r-31': { name: 'Direct-debit bounce ≥ 3 in 30d' },
  'r-32': { name: 'Geographic risk migration' },
  'r-33': { name: 'Account dormancy with active loan' },
  'r-34': { name: 'Card spend anomaly z-score > 2.5' },
};

export function makeSeedLookups(): Lookups {
  return {
    customers: { ...SEED_CUSTOMERS },
    rules: { ...SEED_RULES },
    assignees: {},
  };
}
