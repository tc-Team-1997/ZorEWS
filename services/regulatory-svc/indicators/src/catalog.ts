// Catalog loader.
//
// catalog.json is the contract between agent-rule and agent-indicator.
// This module reads it, exposes typed access to the entries, and provides
// a registry-completeness assertion used at boot and in tests.
//
// T6 M4.1 (2026-05-04): a second catalog `catalog_insurance.json` ships
// alongside the banking one — same shape, different `vertical: 'insurance'`
// marker, 25 BIL-specific indicators across 5 families (Policy / Customer /
// Agent / Claim / Operational). The insurance catalog is intentionally
// independent of the compute registry — its inputs reference mart tables
// (policy_360, claim_360, agent_360) that don't materialise yet, so
// `checkRegistryAgainstCatalog` is NOT applied to it. Compute fns will
// land alongside the BIL synthetic-data follow-up.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IndicatorCatalog, IndicatorDef } from '../../../../rules/types';
import { ComputeRegistry } from './types';

const CATALOG_PATH = path.resolve(__dirname, '..', 'catalog.json');
const CATALOG_INSURANCE_PATH = path.resolve(__dirname, '..', 'catalog_insurance.json');

let _catalog: IndicatorCatalog | null = null;
let _catalogInsurance: IndicatorCatalog | null = null;

export function loadCatalog(forcePath?: string): IndicatorCatalog {
  if (_catalog && !forcePath) return _catalog;
  const raw = fs.readFileSync(forcePath ?? CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(raw) as IndicatorCatalog;
  if (!forcePath) _catalog = parsed;
  return parsed;
}

/**
 * T6 M4.1 — load the BIL insurance KRI catalog. Same shape as the
 * banking catalog (loadCatalog) but lives in catalog_insurance.json
 * with `vertical: 'insurance'`. Memoised; pass `forcePath` for tests.
 */
export function loadInsuranceCatalog(forcePath?: string): IndicatorCatalog {
  if (_catalogInsurance && !forcePath) return _catalogInsurance;
  const raw = fs.readFileSync(forcePath ?? CATALOG_INSURANCE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as IndicatorCatalog;
  if (!forcePath) _catalogInsurance = parsed;
  return parsed;
}

/**
 * Returns the catalog matching the requested vertical. 'banking' (default)
 * → banking KRIs; 'insurance' → BIL insurance KRIs. Tenants stamp their
 * vertical on creation (Phase 1) so a route handler picks the right
 * catalog from `req.tenant.vertical`.
 */
export function loadCatalogFor(vertical: 'banking' | 'insurance' = 'banking'): IndicatorCatalog {
  return vertical === 'insurance' ? loadInsuranceCatalog() : loadCatalog();
}

export function catalogIds(forcePath?: string): string[] {
  return loadCatalog(forcePath).indicators.map((i) => i.id);
}

export function catalogEntry(id: string, forcePath?: string): IndicatorDef | undefined {
  return loadCatalog(forcePath).indicators.find((i) => i.id === id);
}

export interface RegistryCheckResult {
  ok: boolean;
  missing: string[];   // catalog ids without a compute fn
  extras: string[];    // compute fns whose key is not in the catalog
}

/**
 * Assert that the compute registry covers exactly the catalog. This is the
 * DoD gate: every catalog id must have a registered compute fn.
 */
export function checkRegistryAgainstCatalog(
  registry: ComputeRegistry,
  forcePath?: string,
): RegistryCheckResult {
  const ids = catalogIds(forcePath);
  const keys = Object.keys(registry);
  const idSet = new Set(ids);
  const keySet = new Set(keys);
  const missing = ids.filter((id) => !keySet.has(id));
  const extras = keys.filter((k) => !idSet.has(k));
  return { ok: missing.length === 0 && extras.length === 0, missing, extras };
}
