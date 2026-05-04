// services/regulatory-svc/alerts/src/schemas.ts
//
// AJV-backed validators for our two wire schemas:
//   - apex.rule.firings.v1.json (input — agent-rule)
//   - apex.regulatory.events.v2.json (output — canonical alert)
//
// We compile lazily so tests can construct without filesystem access if they
// inject their own validators.

import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'infra', 'schema-registry');

let _firingValidator: ValidateFunction | null = null;
let _alertValidator: ValidateFunction | null = null;

// The wire schemas declare `$schema: draft/2020-12/schema`; the default Ajv
// import only supports draft-07 and throws "no schema with key or ref ..."
// at compile time. Use Ajv2020 explicitly. Same pattern as rules/dsl.ts.
function loadAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

export function ruleFiringValidator(): ValidateFunction {
  if (_firingValidator) return _firingValidator;
  const schema = JSON.parse(
    fs.readFileSync(path.join(SCHEMA_DIR, 'apex.rule.firings.v1.json'), 'utf8'),
  );
  _firingValidator = loadAjv().compile(schema);
  return _firingValidator;
}

export function alertEventValidator(): ValidateFunction {
  if (_alertValidator) return _alertValidator;
  const schema = JSON.parse(
    fs.readFileSync(path.join(SCHEMA_DIR, 'apex.regulatory.events.v2.json'), 'utf8'),
  );
  _alertValidator = loadAjv().compile(schema);
  return _alertValidator;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function explain(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}
