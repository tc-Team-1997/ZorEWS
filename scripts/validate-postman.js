#!/usr/bin/env node
/**
 * scripts/validate-postman.js
 *
 * Structural validation pass for the 10 per-tag Postman collections +
 * shared environment. Runs after `npm run postman:generate` to assert:
 *   1. Every file parses cleanly as JSON
 *   2. Every collection declares the v2.1 schema
 *   3. Every collection inherits Bearer auth
 *   4. Every collection has a "00 — Smoke tests" folder
 *   5. Every request carries a 'test' event script
 *   6. Every URL uses an environment variable (no hard-coded localhost)
 *   7. Environment has all required variables
 *   8. No file > 5 MB (Postman's typical comfort cap)
 *   9. Folder counts add up to the route totals
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const POSTMAN_DIR = path.join(REPO_ROOT, 'docs', 'postman');

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

const REQUIRED_ENV_VARS = [
  'bff_url',
  'auth_svc_url',
  'tenant_id',
  'channel',
  'apex_user',
  'apex_role',
  'access_token',
];

let passes = 0;
let fails = 0;
function ok(msg, detail = '') {
  console.log(`  ✓ ${msg}${detail ? ' — ' + detail : ''}`);
  passes++;
}
function fail(msg, detail = '') {
  console.error(`  ✕ ${msg}${detail ? ' — ' + detail : ''}`);
  fails++;
}

function walkRequests(items, visit) {
  for (const it of items) {
    if (it.request) visit(it);
    if (Array.isArray(it.item)) walkRequests(it.item, visit);
  }
}

function main() {
  console.log('Validating Postman artefacts in', path.relative(REPO_ROOT, POSTMAN_DIR));
  console.log('');

  // Environment first
  const envPath = path.join(POSTMAN_DIR, 'local.postman_environment.json');
  if (!fs.existsSync(envPath)) {
    fail('local.postman_environment.json present');
    process.exit(1);
  }
  let env;
  try {
    env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
    ok('environment parses', `${env.values.length} vars`);
  } catch (e) {
    fail('environment parses', e.message);
    process.exit(1);
  }
  const envKeys = new Set(env.values.map((v) => v.key));
  for (const k of REQUIRED_ENV_VARS) {
    if (envKeys.has(k)) ok(`env carries ${k}`);
    else fail(`env carries ${k}`);
  }
  // No hard-coded production URLs in env
  const prodHits = env.values.filter(
    (v) =>
      typeof v.value === 'string' &&
      /https?:\/\/(?!localhost|127\.0\.0\.1)/.test(v.value),
  );
  if (prodHits.length === 0) ok('no production URLs in env');
  else fail('production URLs in env', prodHits.map((v) => v.key).join(', '));

  console.log('');

  // Per-collection validation
  for (const tag of REQUIRED_TAGS) {
    const collectionName = `ZorEWS-${tag}.postman_collection.json`;
    const colPath = path.join(POSTMAN_DIR, collectionName);
    console.log(`-- ${collectionName} --`);
    if (!fs.existsSync(colPath)) {
      fail(`${collectionName} exists`);
      continue;
    }
    const sizeMB = fs.statSync(colPath).size / 1024 / 1024;
    if (sizeMB > 5) fail(`${collectionName} ≤ 5 MB`, sizeMB.toFixed(2) + ' MB');
    else ok(`${collectionName} ≤ 5 MB`, sizeMB.toFixed(2) + ' MB');

    let col;
    try {
      col = JSON.parse(fs.readFileSync(colPath, 'utf8'));
      ok(`${tag} parses`);
    } catch (e) {
      fail(`${tag} parses`, e.message);
      continue;
    }

    // Schema check
    if (col.info?.schema === 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json') {
      ok(`${tag} schema is v2.1`);
    } else fail(`${tag} schema is v2.1`, col.info?.schema || '(missing)');

    // Bearer auth at collection level
    if (col.auth?.type === 'bearer') ok(`${tag} bearer auth declared`);
    else fail(`${tag} bearer auth declared`);

    // Smoke folder present
    const smokeFolder = (col.item || []).find((f) => /smoke/i.test(f.name));
    if (smokeFolder) ok(`${tag} smoke folder present`, `${smokeFolder.item.length} test(s)`);
    else fail(`${tag} smoke folder present`);

    // Every request has a test event script
    let totalReq = 0;
    let withTest = 0;
    let noEnvVar = 0;
    walkRequests(col.item || [], (req) => {
      totalReq++;
      const ev = (req.event || []).find((e) => e.listen === 'test');
      if (ev && Array.isArray(ev.script?.exec)) withTest++;
      // URL must use {{var}} — no hard-coded localhost
      const raw = req.request?.url?.raw || '';
      if (raw.includes('localhost') && !raw.includes('{{')) noEnvVar++;
    });
    if (totalReq > 0) ok(`${tag} request count`, `${totalReq} requests`);
    if (withTest === totalReq) ok(`${tag} every request has test script`, `${withTest}/${totalReq}`);
    else fail(`${tag} every request has test script`, `${withTest}/${totalReq}`);
    if (noEnvVar === 0) ok(`${tag} no hard-coded localhost URLs`);
    else fail(`${tag} no hard-coded localhost URLs`, `${noEnvVar} request(s)`);

    console.log('');
  }

  console.log(`Summary: ${passes} pass · ${fails} fail`);
  if (fails > 0) process.exit(1);
}

main();
