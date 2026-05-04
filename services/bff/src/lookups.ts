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
  'c-101': { name: 'Achieng Otieno' },
  'c-102': { name: 'Brian Kamau' },
  'c-103': { name: 'Cynthia Mwangi' },
  'c-104': { name: 'Daniel Wanjiku' },
  'c-105': { name: 'Esther Njeri' },
  'c-106': { name: 'Faisal Hussein' },
};

export const SEED_RULES: RuleLookup = {
  'r-22': { name: 'Salary inflow stopped 60d' },
  'r-09': { name: 'DPD ≥ 30 + utilisation > 95%' },
  'r-14': { name: 'Cheque return 2× in 30d' },
  'r-15': { name: 'Net flow drop 30d > 40%' },
};

export function makeSeedLookups(): Lookups {
  return {
    customers: { ...SEED_CUSTOMERS },
    rules: { ...SEED_RULES },
    assignees: {},
  };
}
