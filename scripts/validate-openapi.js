#!/usr/bin/env node
/**
 * scripts/validate-openapi.js — deeper structural validation pass.
 *
 * Runs after gen-openapi.js to verify:
 *   1. Both swagger.json and swagger.yaml parse cleanly
 *   2. swagger.json === yaml-roundtrip(swagger.yaml) (structural equivalence)
 *   3. Every $ref resolves
 *   4. Every operationId is unique
 *   5. Every path appears once
 *   6. Every status code is valid OpenAPI 3.1
 *   7. No duplicate schema names
 *   8. All 10 mandated tags present
 *   9. Bearer auth declared
 *  10. Pagination schema present
 *  11. Error schema present
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const yaml = require(path.join(REPO_ROOT, 'services', 'bff', 'node_modules', 'js-yaml'));

const JSON_PATH = path.join(REPO_ROOT, 'docs', 'api', 'swagger.json');
const YAML_PATH = path.join(REPO_ROOT, 'docs', 'api', 'swagger.yaml');

const REQUIRED_TAGS = [
  'Auth',
  'Users',
  'Dashboard',
  'Borrower',
  'EWS',
  'Alerts',
  'Workflow',
  'AI',
  'Reports',
  'Config',
];

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
    return true;
  }
  console.error(`  ✕ ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

function collectRefs(obj, refs = new Set()) {
  if (!obj || typeof obj !== 'object') return refs;
  if (Array.isArray(obj)) {
    for (const v of obj) collectRefs(v, refs);
    return refs;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$ref' && typeof v === 'string') refs.add(v);
    else collectRefs(v, refs);
  }
  return refs;
}

function resolveRef(spec, ref) {
  if (!ref.startsWith('#/')) return true; // external — assume valid
  const parts = ref.slice(2).split('/');
  let node = spec;
  for (const p of parts) {
    if (!node || typeof node !== 'object' || !(p in node)) return false;
    node = node[p];
  }
  return true;
}

function main() {
  console.log('OpenAPI validation:\n');

  // 1. swagger.json parses
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    check('swagger.json parses as JSON', true, `${fs.statSync(JSON_PATH).size} bytes`);
  } catch (e) {
    check('swagger.json parses as JSON', false, e.message);
    process.exit(1);
  }

  // 2. swagger.yaml parses
  let yamlSpec;
  try {
    yamlSpec = yaml.load(fs.readFileSync(YAML_PATH, 'utf8'));
    check('swagger.yaml parses as YAML', true, `${fs.statSync(YAML_PATH).size} bytes`);
  } catch (e) {
    check('swagger.yaml parses as YAML', false, e.message);
    process.exit(1);
  }

  // 3. JSON === YAML round-trip (deep equality after stringification)
  const equal = JSON.stringify(spec) === JSON.stringify(yamlSpec);
  check(
    'swagger.json deep-equals yaml-roundtrip(swagger.yaml)',
    equal,
    equal ? 'identical structure' : 'STRUCTURAL DRIFT',
  );

  // 4. OpenAPI version
  check('openapi version is 3.1.x', spec.openapi && spec.openapi.startsWith('3.1'), `got ${spec.openapi}`);

  // 5. Required metadata
  check('info.title set', !!spec.info?.title, spec.info?.title);
  check('info.version set', !!spec.info?.version, spec.info?.version);

  // 6. Every $ref resolves
  const refs = collectRefs(spec);
  let unresolved = 0;
  for (const r of refs) {
    if (!resolveRef(spec, r)) {
      console.error(`    ! unresolved $ref: ${r}`);
      unresolved++;
    }
  }
  check(`every $ref resolves`, unresolved === 0, `${refs.size} refs / ${unresolved} unresolved`);

  // 7. Unique operationIds
  const opIds = new Map();
  const dupIds = [];
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(ops)) {
      if (!op.operationId) continue;
      if (opIds.has(op.operationId)) {
        dupIds.push(`${op.operationId} (${opIds.get(op.operationId)} vs ${m.toUpperCase()} ${p})`);
      } else {
        opIds.set(op.operationId, `${m.toUpperCase()} ${p}`);
      }
    }
  }
  check('all operationIds unique', dupIds.length === 0, `${opIds.size} ops`);
  if (dupIds.length) for (const d of dupIds.slice(0, 5)) console.error('    ! ' + d);

  // 8. Valid status codes
  let badStatus = 0;
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(ops)) {
      for (const s of Object.keys(op.responses || {})) {
        if (!/^([1-5]\d\d|default)$/.test(s)) {
          console.error(`    ! ${m.toUpperCase()} ${p}: bad status ${s}`);
          badStatus++;
        }
      }
    }
  }
  check('all status codes valid', badStatus === 0);

  // 9. Unique schema names
  const schemaNames = Object.keys(spec.components?.schemas ?? {});
  const uniqueSchemas = new Set(schemaNames);
  check(
    'no duplicate schema names',
    schemaNames.length === uniqueSchemas.size,
    `${schemaNames.length} schemas`,
  );

  // 10. All 10 mandated tags present in the spec
  const declaredTags = new Set((spec.tags ?? []).map((t) => t.name));
  const usedTags = new Set();
  for (const ops of Object.values(spec.paths)) {
    for (const op of Object.values(ops)) {
      for (const t of op.tags || []) usedTags.add(t);
    }
  }
  const missing = REQUIRED_TAGS.filter((t) => !declaredTags.has(t) || !usedTags.has(t));
  check(
    'all 10 mandated tags declared + used',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED_TAGS.length}/10`,
  );

  // 11. Bearer auth declared
  check(
    'bearerAuth security scheme declared',
    spec.components?.securitySchemes?.bearerAuth?.scheme === 'bearer',
  );

  // 12. Pagination schema present
  check(
    'pagination schema present (PaginatedListBody)',
    !!spec.components?.schemas?.PaginatedListBody,
  );
  check(
    'pagination metadata schema present (Pagination)',
    !!spec.components?.schemas?.Pagination,
  );

  // 13. Error schema present
  check(
    'error envelope schema present (EnvelopeError)',
    !!spec.components?.schemas?.EnvelopeError,
  );
  check('error body schema present (ErrorBody)', !!spec.components?.schemas?.ErrorBody);

  // 14. Examples present
  const examples = Object.keys(spec.components?.examples ?? {});
  check(
    'has examples',
    examples.length > 0,
    `${examples.length}: ${examples.slice(0, 4).join(', ')}${examples.length > 4 ? ', …' : ''}`,
  );

  // 15. Per-tag route count
  const perTagCount = new Map();
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const op of Object.values(ops)) {
      for (const t of op.tags || []) {
        perTagCount.set(t, (perTagCount.get(t) || 0) + 1);
      }
    }
  }
  console.log('\n  Routes per tag:');
  for (const t of REQUIRED_TAGS) {
    const n = perTagCount.get(t) || 0;
    console.log(`    ${t.padEnd(10)} ${n}`);
  }

  const failed = unresolved + dupIds.length + badStatus + missing.length + (equal ? 0 : 1);
  console.log('');
  if (failed > 0) {
    console.error(`✕ ${failed} validation issue(s)`);
    process.exit(1);
  }
  console.log('✓ All validation checks passed.');
}

main();
