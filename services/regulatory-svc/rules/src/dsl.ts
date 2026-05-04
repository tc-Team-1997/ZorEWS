// DSL validation + evaluation. Runtime contract for rule expressions.
//
// The schema lives at /Users/taniya/apex-ews/rules/dsl.schema.json and is the
// single source of truth for *shape*. This module also enforces a *semantic*
// check: every indicator id referenced in a rule must exist in the catalog.

import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Rule,
  Expr,
  CmpExpr,
  IndicatorCatalog,
  isAnd,
  isOr,
  isNot,
  isCmp,
} from '../../../../rules/types';

const SCHEMA_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'rules', 'dsl.schema.json');
const CATALOG_PATH = path.resolve(__dirname, '..', '..', 'indicators', 'catalog.json');

let _ajvValidator: ValidateFunction | null = null;
let _catalogIds: Set<string> | null = null;

export function loadSchemaValidator(): ValidateFunction {
  if (_ajvValidator) return _ajvValidator;
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  _ajvValidator = ajv.compile(schema);
  return _ajvValidator;
}

export function loadCatalog(forcePath?: string): IndicatorCatalog {
  const p = forcePath ?? CATALOG_PATH;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as IndicatorCatalog;
}

export function loadCatalogIds(forcePath?: string): Set<string> {
  if (_catalogIds && !forcePath) return _catalogIds;
  const cat = loadCatalog(forcePath);
  const set = new Set(cat.indicators.map((i) => i.id));
  if (!forcePath) _catalogIds = set;
  return set;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Walk the expression tree and collect indicator ids used. */
export function collectIndicators(e: Expr, acc: Set<string> = new Set()): Set<string> {
  if (isCmp(e)) {
    acc.add(e.indicator);
  } else if (isAnd(e)) {
    e.and.forEach((sub) => collectIndicators(sub, acc));
  } else if (isOr(e)) {
    e.or.forEach((sub) => collectIndicators(sub, acc));
  } else if (isNot(e)) {
    collectIndicators(e.not, acc);
  }
  return acc;
}

/** Validate a rule against schema + indicator catalog. */
export function validateRule(rule: unknown, catalogIds?: Set<string>): ValidationResult {
  const validator = loadSchemaValidator();
  const ok = validator(rule);
  const errors: string[] = [];
  if (!ok) {
    for (const err of validator.errors ?? []) {
      errors.push(`${err.instancePath || '/'} ${err.message ?? 'invalid'}`);
    }
    return { ok: false, errors };
  }

  const r = rule as Rule;
  const ids = catalogIds ?? loadCatalogIds();
  const used = collectIndicators(r.when);
  for (const id of used) {
    if (!ids.has(id)) {
      errors.push(`unknown indicator id: ${id}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Evaluate a comparator leaf against a numeric value (or null if unknown). */
export function evalCmp(cmp: CmpExpr, value: number | null | undefined): boolean {
  if (value === null || value === undefined || Number.isNaN(value)) return false;
  switch (cmp.op) {
    case 'gt':
      return value > Number(cmp.value);
    case 'gte':
      return value >= Number(cmp.value);
    case 'lt':
      return value < Number(cmp.value);
    case 'lte':
      return value <= Number(cmp.value);
    case 'eq':
      return value === Number(cmp.value);
    case 'between': {
      if (!cmp.range) return false;
      const [lo, hi] = cmp.range;
      return value >= lo && value <= hi;
    }
    default:
      return false;
  }
}

/** Evaluate a full when-expression given a map of indicator id → numeric value. */
export function evalExpr(e: Expr, values: Record<string, number | null | undefined>): boolean {
  if (isCmp(e)) {
    return evalCmp(e, values[e.indicator]);
  }
  if (isAnd(e)) return e.and.every((sub) => evalExpr(sub, values));
  if (isOr(e)) return e.or.some((sub) => evalExpr(sub, values));
  if (isNot(e)) return !evalExpr(e.not, values);
  return false;
}

/** Return the indicator ids that contributed to firing (for AlertEvent.indicators_fired). */
export function firingIndicators(
  e: Expr,
  values: Record<string, number | null | undefined>,
): string[] {
  if (isCmp(e)) {
    return evalCmp(e, values[e.indicator]) ? [e.indicator] : [];
  }
  if (isAnd(e)) {
    if (!e.and.every((sub) => evalExpr(sub, values))) return [];
    return Array.from(new Set(e.and.flatMap((sub) => firingIndicators(sub, values))));
  }
  if (isOr(e)) {
    return Array.from(
      new Set(
        e.or
          .filter((sub) => evalExpr(sub, values))
          .flatMap((sub) => firingIndicators(sub, values)),
      ),
    );
  }
  if (isNot(e)) {
    return evalExpr(e, values) ? collectIdsFlat(e.not) : [];
  }
  return [];
}

function collectIdsFlat(e: Expr): string[] {
  return Array.from(collectIndicators(e));
}
