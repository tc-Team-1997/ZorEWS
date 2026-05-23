#!/usr/bin/env node
/**
 * scripts/gen-postman.js — module-by-module Postman v2.1 generator.
 *
 * Reads docs/api/swagger.json once, groups operations by the first tag,
 * and emits ONE collection file per tag (10 total) plus ONE shared
 * environment. This keeps each output file small + browseable, lets users
 * import only the modules they need, and dodges the single-large-file
 * generation issue from a prior attempt.
 *
 * Output:
 *   docs/postman/local.postman_environment.json
 *   docs/postman/ZorEWS-Auth.postman_collection.json
 *   docs/postman/ZorEWS-Users.postman_collection.json
 *   docs/postman/ZorEWS-Dashboard.postman_collection.json
 *   docs/postman/ZorEWS-Borrower.postman_collection.json
 *   docs/postman/ZorEWS-EWS.postman_collection.json
 *   docs/postman/ZorEWS-Alerts.postman_collection.json
 *   docs/postman/ZorEWS-Workflow.postman_collection.json
 *   docs/postman/ZorEWS-AI.postman_collection.json
 *   docs/postman/ZorEWS-Reports.postman_collection.json
 *   docs/postman/ZorEWS-Config.postman_collection.json
 *
 * Pure Node — no new deps. Uses the built-in crypto for stable UUIDs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const SWAGGER_PATH = path.join(REPO_ROOT, 'docs', 'api', 'swagger.json');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'postman');

const TAG_ORDER = [
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

/** Deterministic UUIDv5-ish id from a string seed. */
function stableId(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    '8' + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/** Express-style `:param` and OpenAPI `{param}` → `:param` for Postman. */
function pathToPostman(p) {
  return p.replace(/\{([^}]+)\}/g, ':$1');
}

function pathSegments(p) {
  return pathToPostman(p)
    .split('/')
    .filter((s) => s.length > 0);
}

function extractPathParams(p) {
  const out = [];
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(p)) !== null) out.push(m[1]);
  return out;
}

// ─── Headers per route ──────────────────────────────────────────────────

function buildHeaders(route) {
  const headers = [];
  // /v1/* routes always require tenant + channel
  if (route.path.startsWith('/v1/')) {
    headers.push({ key: 'X-Tenant-ID', value: '{{tenant_id}}', type: 'text' });
    headers.push({ key: 'X-Channel', value: '{{channel}}', type: 'text' });
    headers.push({ key: 'X-APEX-USER', value: '{{apex_user}}', type: 'text' });
    headers.push({ key: 'X-APEX-Role', value: '{{apex_role}}', type: 'text' });
  }
  // POST/PATCH/PUT need content-type
  if (['POST', 'PATCH', 'PUT'].includes(route.method.toUpperCase())) {
    headers.push({ key: 'Content-Type', value: 'application/json', type: 'text' });
  }
  return headers;
}

// ─── Body templates per route ──────────────────────────────────────────

/**
 * Choose a sensible example body per (method, path).
 *   - Login + 2FA setup + score endpoints: use realistic shapes
 *   - Other POST/PATCH/PUT: minimal `{}` (operator fills in)
 */
function buildBody(route) {
  const method = route.method.toUpperCase();
  if (!['POST', 'PATCH', 'PUT'].includes(method)) return null;

  const exampleByPattern = [
    [
      /^\/auth\/login$/,
      { username: '{{apex_user}}', password: 'Admin!Pass1' },
    ],
    [/^\/auth\/refresh$/, { refresh_token: '{{refresh_token}}' }],
    [/^\/auth\/login\/verify-2fa$/, { code: '{{otp_code}}' }],
    [/^\/auth\/2fa\/verify$/, { code: '{{otp_code}}' }],
    [/^\/auth\/2fa\/setup$/, {}],
    [/^\/oauth\/token$/, { grant_type: 'client_credentials', client_id: 'apex-mobile-bank-demo', client_secret: '{{oauth_client_secret}}' }],
    [
      /^\/v1\/ai\/models\/[^/]+\/score$/,
      { customer_id: '{{customer_id}}' },
    ],
    [
      /^\/v1\/ews\/evaluate$/,
      { customer_id: '{{customer_id}}' },
    ],
    [
      /^\/v1\/risk-profile\/[^/]+/,
      { customer_id: '{{customer_id}}' },
    ],
    [
      /^\/v1\/admin\/api-keys$/,
      { name: 'Postman test key', scopes: ['alerts:read', 'audit:read'] },
    ],
    [
      /^\/v1\/scoring\/risk$/,
      {
        items: [
          { indicator_id: 'FIN-001', weight: 0.9, value: 0.7 },
          { indicator_id: 'BEH-002', weight: 0.6, value: 0.5 },
        ],
      },
    ],
    [
      /^\/v1\/scenarios\/bulk-run$/,
      { preset_ids: ['rbi_baseline', 'rbi_adverse'] },
    ],
    [
      /^\/v1\/audit\/events$/,
      {
        actor_username: '{{apex_user}}',
        action: 'config.update',
        resource_type: 'config',
        resource_id: 'alerts.red_sla_hours',
        outcome: 'success',
        severity: 'info',
      },
    ],
    [
      /^\/v1\/webhooks$/,
      {
        name: 'Postman test sub',
        url: 'http://localhost:9999/postman-test-sink',
        event_types: ['alert.created'],
      },
    ],
    [
      /^\/v1\/admin\/config\/[^/]+$/,
      { value: 4 },
    ],
  ];

  for (const [re, body] of exampleByPattern) {
    if (re.test(route.path)) {
      return {
        mode: 'raw',
        raw: JSON.stringify(body, null, 2),
        options: { raw: { language: 'json' } },
      };
    }
  }

  // Default — empty body skeleton
  return {
    mode: 'raw',
    raw: '{}',
    options: { raw: { language: 'json' } },
  };
}

// ─── Postman test scripts ──────────────────────────────────────────────

function smokeTestScript(route) {
  const path = route.path;
  const method = route.method.toUpperCase();
  const successCodes = [];
  if (method === 'DELETE') successCodes.push(204, 200, 404);
  else if (method === 'POST') successCodes.push(200, 201, 400, 401, 403, 404, 409);
  else successCodes.push(200, 400, 401, 403, 404);

  return {
    type: 'text/javascript',
    exec: [
      `// Smoke assertion — accepts any documented status for ${method} ${path}`,
      `pm.test('status is documented (200/201/204 success OR 4xx envelope)', () => {`,
      `  pm.expect([${successCodes.join(', ')}]).to.include(pm.response.code);`,
      `});`,
      `pm.test('responds in < 5s', () => {`,
      `  pm.expect(pm.response.responseTime).to.be.below(5000);`,
      `});`,
      ...(path.startsWith('/v1/')
        ? [
            `if (pm.response.code >= 200 && pm.response.code < 300) {`,
            `  pm.test('success envelope shape', () => {`,
            `    const j = pm.response.json();`,
            `    pm.expect(j).to.have.property('header');`,
            `    pm.expect(j.header).to.have.property('status', 'success');`,
            `    pm.expect(j).to.have.property('body');`,
            `  });`,
            `}`,
            `if (pm.response.code >= 400) {`,
            `  pm.test('error envelope shape', () => {`,
            `    const j = pm.response.json();`,
            `    pm.expect(j).to.have.property('header');`,
            `    pm.expect(j).to.have.property('error');`,
            `    pm.expect(j.error).to.have.property('code');`,
            `    pm.expect(j.error).to.have.property('severity');`,
            `  });`,
            `}`,
          ]
        : []),
    ],
  };
}

/** Special test script for /auth/login — captures access_token + refresh_token. */
function loginAuthCaptureScript() {
  return {
    type: 'text/javascript',
    exec: [
      `pm.test('login 200', () => pm.response.to.have.status(200));`,
      `const j = pm.response.json();`,
      `if (j.requires_2fa) {`,
      `  pm.environment.set('partial_token', j.partial_token);`,
      `  console.log('2FA required — partial_token saved. Run /auth/login/verify-2fa next.');`,
      `} else if (j.access_token) {`,
      `  pm.environment.set('access_token', j.access_token);`,
      `  if (j.refresh_token) pm.environment.set('refresh_token', j.refresh_token);`,
      `  console.log('access_token captured (' + j.access_token.slice(0, 24) + '…)');`,
      `}`,
      `pm.test('token present', () => {`,
      `  pm.expect(j.access_token || j.partial_token).to.be.a('string');`,
      `});`,
    ],
  };
}

/** OAuth token capture for service-account flow. */
function oauthCaptureScript() {
  return {
    type: 'text/javascript',
    exec: [
      `pm.test('oauth 200', () => pm.response.to.have.status(200));`,
      `const j = pm.response.json();`,
      `if (j.access_token) {`,
      `  pm.environment.set('access_token', j.access_token);`,
      `  console.log('oauth access_token captured');`,
      `}`,
      `pm.test('token issued', () => {`,
      `  pm.expect(j.access_token).to.be.a('string');`,
      `  pm.expect(j.token_type).to.equal('Bearer');`,
      `});`,
    ],
  };
}

// ─── Build a single Postman request item ───────────────────────────────

function buildRequestItem(route) {
  const method = route.method.toUpperCase();
  const summary = (route.op.summary || `${method} ${route.path}`).slice(0, 100);
  const description = route.op.description || '';

  const baseUrlVar = pickBaseUrlVar(route.path);
  const segs = pathSegments(route.path);

  const requestObj = {
    method,
    header: buildHeaders(route),
    url: {
      raw: `{{${baseUrlVar}}}/${segs.join('/')}`,
      host: [`{{${baseUrlVar}}}`],
      path: segs,
    },
    description,
  };

  // Path-param sample values
  const pParams = extractPathParams(route.path);
  if (pParams.length > 0) {
    requestObj.url.variable = pParams.map((name) => ({
      key: name,
      value: defaultForPathParam(name),
      description: `Path parameter: ${name}`,
    }));
  }

  const body = buildBody(route);
  if (body) requestObj.body = body;

  // Pick test script — special handlers for login + oauth
  let testScript;
  if (route.path === '/auth/login' && method === 'POST') testScript = loginAuthCaptureScript();
  else if (route.path === '/oauth/token' && method === 'POST') testScript = oauthCaptureScript();
  else testScript = smokeTestScript(route);

  return {
    name: `${method} ${route.path}`,
    request: requestObj,
    event: [{ listen: 'test', script: testScript }],
    response: [],
    _summary: summary,
  };
}

function pickBaseUrlVar(p) {
  if (p.startsWith('/auth/') || p === '/oauth/token' || p.startsWith('/.well-known/')) {
    return 'auth_svc_url';
  }
  return 'bff_url';
}

function defaultForPathParam(name) {
  const lower = name.toLowerCase();
  if (lower === 'tenant_id') return '{{tenant_id}}';
  if (lower === 'customer_id' || lower === 'id') return '{{customer_id}}';
  if (lower === 'model_id') return '{{model_id}}';
  if (lower === 'case_id') return '{{case_id}}';
  if (lower === 'alert_id') return '{{alert_id}}';
  if (lower === 'prediction_id') return '{{prediction_id}}';
  if (lower === 'key_id' || lower === 'key') return '{{config_key}}';
  if (lower === 'preset_id') return '{{scenario_preset_id}}';
  if (lower === 'rule_id') return '{{rule_id}}';
  if (lower === 'username') return '{{apex_user}}';
  if (lower === 'session_id' || lower === 'sid') return '{{session_id}}';
  return `<${name}>`;
}

// ─── Smoke folder per tag (happy + negative tests) ──────────────────────

function buildSmokeFolder(tag) {
  const items = [];

  if (tag === 'Auth') {
    // 1. Login flow (captures token)
    items.push({
      name: '✅ 1. Login (captures access_token)',
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json', type: 'text' }],
        url: {
          raw: '{{auth_svc_url}}/auth/login',
          host: ['{{auth_svc_url}}'],
          path: ['auth', 'login'],
        },
        body: {
          mode: 'raw',
          raw: JSON.stringify({ username: '{{apex_user}}', password: 'Admin!Pass1' }, null, 2),
          options: { raw: { language: 'json' } },
        },
      },
      event: [{ listen: 'test', script: loginAuthCaptureScript() }],
    });
    // 2. JWKS public — sanity (no auth)
    items.push({
      name: '✅ 2. JWKS available (no auth needed)',
      request: {
        method: 'GET',
        header: [],
        url: {
          raw: '{{auth_svc_url}}/.well-known/jwks.json',
          host: ['{{auth_svc_url}}'],
          path: ['.well-known', 'jwks.json'],
        },
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              `pm.test('200 OK', () => pm.response.to.have.status(200));`,
              `pm.test('has keys[]', () => pm.expect(pm.response.json().keys).to.be.an('array'));`,
            ],
          },
        },
      ],
    });
    // 3. Healthz
    items.push({
      name: '✅ 3. /healthz (BFF + auth)',
      request: {
        method: 'GET',
        header: [],
        url: {
          raw: '{{bff_url}}/healthz',
          host: ['{{bff_url}}'],
          path: ['healthz'],
        },
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              `pm.test('200 OK', () => pm.response.to.have.status(200));`,
              `pm.test('< 1s', () => pm.expect(pm.response.responseTime).to.be.below(1000));`,
            ],
          },
        },
      ],
    });
    // Negative test: bad creds
    items.push({
      name: '❌ Login with bad creds → 401',
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json', type: 'text' }],
        url: {
          raw: '{{auth_svc_url}}/auth/login',
          host: ['{{auth_svc_url}}'],
          path: ['auth', 'login'],
        },
        body: {
          mode: 'raw',
          raw: JSON.stringify({ username: 'alice.admin', password: 'WRONG!' }, null, 2),
          options: { raw: { language: 'json' } },
        },
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              `pm.test('401 or 423 expected on bad password', () => {`,
              `  pm.expect([401, 423]).to.include(pm.response.code);`,
              `});`,
            ],
          },
        },
      ],
    });
    // Negative test: missing username field
    items.push({
      name: '❌ Login missing username → 400',
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json', type: 'text' }],
        url: {
          raw: '{{auth_svc_url}}/auth/login',
          host: ['{{auth_svc_url}}'],
          path: ['auth', 'login'],
        },
        body: {
          mode: 'raw',
          raw: JSON.stringify({ password: 'Admin!Pass1' }, null, 2),
          options: { raw: { language: 'json' } },
        },
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [`pm.test('4xx on missing field', () => pm.expect(pm.response.code).to.be.within(400, 499));`],
          },
        },
      ],
    });
  } else {
    // Happy + negative for every other tag — use representative routes
    const HAPPY = {
      Users: { method: 'GET', url: '{{auth_svc_url}}/auth/me', host: 'auth_svc_url', path: ['auth', 'me'] },
      Dashboard: { method: 'GET', url: '{{bff_url}}/api/dashboard/summary', host: 'bff_url', path: ['api', 'dashboard', 'summary'] },
      Borrower: { method: 'GET', url: '{{bff_url}}/api/customers', host: 'bff_url', path: ['api', 'customers'] },
      EWS: { method: 'GET', url: '{{bff_url}}/v1/indicators/catalog-stats', host: 'bff_url', path: ['v1', 'indicators', 'catalog-stats'], v1: true },
      Alerts: { method: 'GET', url: '{{bff_url}}/v1/alerts', host: 'bff_url', path: ['v1', 'alerts'], v1: true },
      Workflow: { method: 'GET', url: '{{bff_url}}/api/cases', host: 'bff_url', path: ['api', 'cases'] },
      AI: { method: 'GET', url: '{{bff_url}}/v1/ai/models', host: 'bff_url', path: ['v1', 'ai', 'models'], v1: true },
      Reports: { method: 'GET', url: '{{bff_url}}/v1/reports/catalog', host: 'bff_url', path: ['v1', 'reports', 'catalog'], v1: true },
      Config: { method: 'GET', url: '{{bff_url}}/v1/admin/config', host: 'bff_url', path: ['v1', 'admin', 'config'], v1: true },
    };

    const h = HAPPY[tag];
    if (h) {
      const headers = [];
      if (h.v1) {
        headers.push({ key: 'X-Tenant-ID', value: '{{tenant_id}}', type: 'text' });
        headers.push({ key: 'X-Channel', value: '{{channel}}', type: 'text' });
        headers.push({ key: 'X-APEX-Role', value: '{{apex_role}}', type: 'text' });
      }
      items.push({
        name: `✅ Happy path — ${h.method} ${h.url.replace('{{' + h.host + '}}', '')}`,
        request: {
          method: h.method,
          header: headers,
          url: {
            raw: h.url,
            host: [`{{${h.host}}}`],
            path: h.path,
          },
        },
        event: [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: [
                `pm.test('2xx or 401 (no auth in env)', () => {`,
                `  pm.expect([200, 201, 401, 403]).to.include(pm.response.code);`,
                `});`,
              ],
            },
          },
        ],
      });

      // Negative — missing tenant header (if /v1/*)
      if (h.v1) {
        items.push({
          name: `❌ Negative — missing X-Tenant-ID → 400`,
          request: {
            method: h.method,
            header: [], // no headers
            url: {
              raw: h.url,
              host: [`{{${h.host}}}`],
              path: h.path,
            },
          },
          event: [
            {
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: [
                  `pm.test('400 when tenant header missing', () => pm.expect(pm.response.code).to.equal(400));`,
                  `pm.test('error envelope', () => {`,
                  `  const j = pm.response.json();`,
                  `  pm.expect(j).to.have.property('error');`,
                  `  pm.expect(j.error).to.have.property('code');`,
                  `});`,
                ],
              },
            },
          ],
        });

        // Negative — wrong role → 403
        items.push({
          name: `❌ Negative — unknown role → 403`,
          request: {
            method: h.method,
            header: [
              { key: 'X-Tenant-ID', value: '{{tenant_id}}', type: 'text' },
              { key: 'X-Channel', value: '{{channel}}', type: 'text' },
              { key: 'X-APEX-Role', value: 'unknown_role', type: 'text' },
            ],
            url: {
              raw: h.url,
              host: [`{{${h.host}}}`],
              path: h.path,
            },
          },
          event: [
            {
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: [
                  `pm.test('403 with unknown role', () => pm.expect(pm.response.code).to.equal(403));`,
                ],
              },
            },
          ],
        });
      }
    }
  }

  return {
    name: '00 — Smoke tests',
    description:
      'Happy-path + negative-test sanity checks. Run this folder first to verify the local stack + auth flow.',
    item: items,
  };
}

// ─── Collection builder ─────────────────────────────────────────────────

function buildCollection(tag, routes) {
  const items = [];

  // Folder 0: smoke
  items.push(buildSmokeFolder(tag));

  // Group remaining routes by first-3 path segments for browsability
  // Each route becomes a separate request item; folders cluster related ones.
  const folders = new Map();
  for (const route of routes) {
    const segs = pathSegments(route.path);
    let folderName;
    if (segs[0] === 'v1') folderName = '/' + segs.slice(0, Math.min(3, segs.length)).join('/');
    else if (segs[0] === 'api') folderName = '/' + segs.slice(0, Math.min(2, segs.length)).join('/');
    else folderName = '/' + (segs[0] || 'root');

    if (!folders.has(folderName)) folders.set(folderName, []);
    folders.get(folderName).push(route);
  }

  // Sort folder keys alphabetically; sort routes inside each folder by path then method
  const sortedFolders = [...folders.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [folderName, list] of sortedFolders) {
    list.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });
    const folder = {
      name: folderName,
      description: `${list.length} route(s) under ${folderName}`,
      item: list.map(buildRequestItem),
    };
    items.push(folder);
  }

  return {
    info: {
      _postman_id: stableId(`ZorEWS-${tag}`),
      name: `ZorEWS — ${tag} APIs`,
      description: `${tag} routes from the ZorEWS BFF + auth-svc surface. ${routes.length} operations. Auto-generated from \`docs/api/swagger.json\` by \`scripts/gen-postman.js\`. Re-import after running \`npm run openapi:generate\` to refresh.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }],
    },
    event: [
      {
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: [
            `// Collection-level pre-request — log the active environment + tenant for visibility`,
            `if (!pm.environment.get('access_token') && pm.request.url.toString().indexOf('/auth/login') === -1 && pm.request.url.toString().indexOf('/oauth/token') === -1 && pm.request.url.toString().indexOf('/healthz') === -1 && pm.request.url.toString().indexOf('/.well-known/') === -1) {`,
            `  console.warn('access_token is empty — run the Smoke > Login request first to capture a token.');`,
            `}`,
          ],
        },
      },
    ],
    variable: [
      // Per-collection variable overrides (none — env carries everything)
    ],
    item: items,
  };
}

// ─── Environment builder ───────────────────────────────────────────────

function buildEnvironment() {
  const values = [
    { key: 'bff_url', value: 'http://localhost:8084', type: 'default', enabled: true },
    { key: 'auth_svc_url', value: 'http://localhost:8080', type: 'default', enabled: true },
    { key: 'tenant_id', value: 'BANK_DEMO', type: 'default', enabled: true },
    { key: 'channel', value: 'API', type: 'default', enabled: true },
    { key: 'apex_user', value: 'alice.admin', type: 'default', enabled: true },
    { key: 'apex_role', value: 'admin', type: 'default', enabled: true },
    { key: 'access_token', value: '', type: 'secret', enabled: true },
    { key: 'refresh_token', value: '', type: 'secret', enabled: true },
    { key: 'partial_token', value: '', type: 'secret', enabled: true },
    { key: 'otp_code', value: '', type: 'default', enabled: true },
    { key: 'oauth_client_secret', value: '', type: 'secret', enabled: true },
    // Resource ids used as path-param defaults
    { key: 'customer_id', value: 'c-101', type: 'default', enabled: true },
    { key: 'model_id', value: 'pd_xgb_v3', type: 'default', enabled: true },
    { key: 'case_id', value: 'case-001', type: 'default', enabled: true },
    { key: 'alert_id', value: 'alert-001', type: 'default', enabled: true },
    { key: 'prediction_id', value: '', type: 'default', enabled: true },
    { key: 'config_key', value: 'alerts.red_sla_hours', type: 'default', enabled: true },
    { key: 'scenario_preset_id', value: 'rbi_baseline', type: 'default', enabled: true },
    { key: 'rule_id', value: 'r-1', type: 'default', enabled: true },
    { key: 'session_id', value: '', type: 'default', enabled: true },
  ];

  return {
    id: stableId('ZorEWS-local-env'),
    name: 'ZorEWS Local',
    values,
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: 'scripts/gen-postman.js',
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  console.log('Reading swagger.json…');
  const spec = JSON.parse(fs.readFileSync(SWAGGER_PATH, 'utf8'));

  // Group routes by primary tag
  const byTag = new Map();
  for (const t of TAG_ORDER) byTag.set(t, []);

  for (const [pathStr, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = (op.tags && op.tags[0]) || 'Config';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ path: pathStr, method, op });
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Environment first
  const envPath = path.join(OUT_DIR, 'local.postman_environment.json');
  const env = buildEnvironment();
  fs.writeFileSync(envPath, JSON.stringify(env, null, 2) + '\n', 'utf8');
  console.log(`  ✓ ${path.relative(REPO_ROOT, envPath)} — ${env.values.length} variables`);

  // One collection per tag
  let totalOps = 0;
  for (const tag of TAG_ORDER) {
    const routes = byTag.get(tag) || [];
    if (routes.length === 0) {
      console.log(`  ~ ${tag.padEnd(10)} (skip — no routes)`);
      continue;
    }
    const collection = buildCollection(tag, routes);
    const outName = `ZorEWS-${tag}.postman_collection.json`;
    const outPath = path.join(OUT_DIR, outName);
    fs.writeFileSync(outPath, JSON.stringify(collection, null, 2) + '\n', 'utf8');
    const folderCount = collection.item.length;
    console.log(
      `  ✓ ${outName.padEnd(46)} ${routes.length.toString().padStart(3)} ops · ${folderCount} folders`,
    );
    totalOps += routes.length;
  }

  console.log(`\nTotals: ${totalOps} operations across ${TAG_ORDER.length} collections`);
}

main();
