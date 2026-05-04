// services/regulatory-svc/cases/src/event_validator.ts
//
// AJV validator for outbound apex.case.events. The cases service must never
// write an event that fails the registered schema — this module is the
// emit-side guard that catches drift between code and contract.
//
// Schema lives at infra/schema-registry/apex.case.events.v1.json (the
// canonical Glue Schema Registry source). We compile it once on first call
// and reuse the validator.

import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CaseEvent } from './types';

const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'infra',
  'schema-registry',
  'apex.case.events.v1.json',
);

let _validator: ValidateFunction<CaseEvent> | null = null;

export function loadEventValidator(): ValidateFunction<CaseEvent> {
  if (_validator) return _validator;
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  _validator = ajv.compile(schema) as ValidateFunction<CaseEvent>;
  return _validator;
}

export class CaseEventSchemaError extends Error {
  constructor(
    public readonly errors: NonNullable<ValidateFunction['errors']>,
    public readonly event: unknown,
  ) {
    const detail = errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    super(`apex.case.events violates schema: ${detail}`);
    this.name = 'CaseEventSchemaError';
  }
}

/** Validate or throw. Used by service.ts:emit before write. */
export function validateOrThrow(event: CaseEvent): void {
  const validate = loadEventValidator();
  if (!validate(event)) {
    throw new CaseEventSchemaError(validate.errors ?? [], event);
  }
}
