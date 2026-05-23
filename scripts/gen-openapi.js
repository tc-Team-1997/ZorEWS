#!/usr/bin/env node
/**
 * scripts/gen-openapi.js
 *
 * Auto-discover every route declared in services/bff/src/server.ts and
 * emit OpenAPI 3.1 documentation:
 *   - docs/api/swagger.json
 *   - docs/api/swagger.yaml
 *   - docs/api/openapi.md
 *
 * Local-only. No network, no AWS, no code changes. Pure Node + js-yaml
 * (from services/bff/node_modules — already installed).
 *
 * Strategy:
 *   1. Regex-scan server.ts for app.METHOD('PATH', ...) declarations
 *   2. Extract the preceding line-comment or JSDoc block as the
 *      operation summary when present
 *   3. Group routes into 10 tag buckets per the spec:
 *        Auth · Users · Dashboard · Borrower · EWS · Alerts ·
 *        Workflow · AI · Reports · Config
 *   4. Build the OpenAPI 3.1 document with:
 *        - shared components.schemas (Envelope, EnvelopeError, etc.)
 *        - bearerAuth security scheme
 *        - per-route parameters (path params + common headers)
 *        - standard response set (200/201/204/400/401/403/404/500)
 *        - examples for representative routes
 *   5. Validate structurally (every $ref resolves, every path unique,
 *      every method valid, every status valid)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// js-yaml lives in the bff workspace's node_modules
const yaml = require(path.join(__dirname, '..', 'services', 'bff', 'node_modules', 'js-yaml'));

const REPO_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'api');

// Sources to scan. Each entry is { file, server, label } where:
//   - file: absolute path to a TS file declaring routes
//   - server: which server URL (from spec.servers) hosts these routes
//   - label: human-readable origin tag
const SOURCES = [
  {
    file: path.join(REPO_ROOT, 'services', 'bff', 'src', 'server.ts'),
    server: 'bff',
    label: 'BFF (port 8084)',
  },
  {
    file: path.join(REPO_ROOT, 'services', 'auth-svc', 'src', 'server.ts'),
    server: 'auth-svc',
    label: 'auth-svc (port 8080)',
  },
  ...['auth', 'service_clients', 'teams', 'leave_covers', 'dashboard_widgets']
    .map((name) => ({
      file: path.join(REPO_ROOT, 'services', 'auth-svc', 'src', 'routes', `${name}.ts`),
      server: 'auth-svc',
      label: `auth-svc /routes/${name}.ts`,
    }))
    .filter((s) => fs.existsSync(s.file)),
];

// ─── 1. Route discovery ─────────────────────────────────────────────────

/**
 * Extract every `app.method('/path', ...)` declaration from server.ts.
 * Also captures the preceding comment block (1-15 lines back) as the
 * operation summary when present.
 */
function discoverRoutes(sourceText, sourceMeta = {}) {
  const lines = sourceText.split('\n');

  // Match the opening `app.METHOD` token. The trailing structure can be:
  //   - inline: `app.METHOD('/path', ...)`         (Express)
  //   - generic-inline: `app.post<{...}>('/path', ...)` (Fastify TS)
  //   - generic-multi: `app.post<{`        \n  ...   \n  }>(  \n  '/path',`
  //   - paren-multi: `app.METHOD(`         \n  '/path', ...
  // Catch ALL by anchoring on `app.METHOD\b` and then scanning forward for
  // the first quoted path literal that starts with `/`. Skip over JSDoc + line
  // comments. Bail out after MAX_LOOKAHEAD lines.
  const methodRe = /^\s*app\.(get|post|patch|put|delete)\b/;
  // Quote either side; literal must start with `/` to be a route path
  const pathInsideLineRe = /["'](\/[^"']+)["']/;
  const MAX_LOOKAHEAD = 30;

  const routes = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(methodRe);
    if (!open) continue;
    const method = open[1];

    // Scan THIS line first (covers `app.METHOD('/path', ...)`)
    let rawPath = null;
    let foundOnLine = i;
    const same = lines[i].match(pathInsideLineRe);
    if (same) {
      rawPath = same[1];
    } else {
      // Walk forward up to MAX_LOOKAHEAD lines
      for (let j = i + 1; j <= Math.min(i + MAX_LOOKAHEAD, lines.length - 1); j++) {
        const ln = lines[j];
        const trimmed = ln.trim();
        // Skip blank lines + comments
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        const pm = ln.match(pathInsideLineRe);
        if (pm) {
          rawPath = pm[1];
          foundOnLine = j;
          break;
        }
      }
    }

    if (!rawPath) continue;
    if (!rawPath.startsWith('/')) continue;

    // Look back up to 15 lines for a comment block
    let summary = null;
    let description = null;
    const commentLines = [];
    for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
      const ln = lines[j].trim();
      if (ln === '' || ln === '*/' || ln === '/*' || ln === '/**') continue;
      if (ln.startsWith('//')) {
        commentLines.unshift(ln.replace(/^\/\/\s?/, ''));
      } else if (ln.startsWith('*') && !ln.startsWith('*/')) {
        commentLines.unshift(ln.replace(/^\*\s?/, ''));
      } else {
        break;
      }
    }
    if (commentLines.length) {
      // Strip section-divider noise (box-drawing chars + long dash runs)
      const cleaned = commentLines
        .map((s) =>
          s
            // Trim leading divider chars + trailing dashes
            .replace(/^[─━╌╍╾╴═-]+\s*/, '')
            .replace(/\s*[─━╌╍╾╴═-]+$/, '')
            .trim(),
        )
        .filter((s) => s.length > 0 && !/^[─━╌╍╾╴═-]+$/.test(s));
      summary = cleaned[0] || null;
      if (cleaned.length > 1) description = cleaned.slice(1).join('\n');
    }

    routes.push({
      method,
      path: rawPath,
      line: i + 1,
      summary,
      description,
      server: sourceMeta.server ?? 'bff',
      source_file: sourceMeta.label ?? null,
    });
  }
  return routes;
}

// ─── 2. Categorisation ──────────────────────────────────────────────────

const TAGS = {
  Auth: 'Authentication, OAuth, 2FA, API key provisioning, sessions',
  Users: 'User management, profile, dashboard-widget config',
  Dashboard:
    'Executive + Operational + Claims + Underwriting + Agent dashboards (SPA-facing aggregations)',
  Borrower:
    'Customer-centric reads: risk profile, exposure, history, drill-throughs',
  EWS:
    'Early-warning surface — indicators, rules, streaming alert path, feature store',
  Alerts:
    'Alert ledger, routing, classification, ack/unack, escalation matrix',
  Workflow:
    'Cases, investigations, maker-checker approvals, action log, tenant onboarding',
  AI:
    'AI/ML model registry, scoring, promotions, retraining, copilot, predictions',
  Reports:
    'Report catalog, scheduled jobs, builder, scenario library, exports',
  Config:
    'Admin configuration, webhooks, integrations, audit trail, recovery, FinOps',
};

/** Decide the tag for a path. */
function tagFor(p) {
  // Auth
  if (p === '/oauth/token') return 'Auth';
  if (p.startsWith('/auth/2fa') || p === '/auth/login' || p === '/auth/refresh' || p === '/auth/logout')
    return 'Auth';
  if (p.startsWith('/.well-known/')) return 'Auth';
  if (p.startsWith('/v1/admin/api-keys')) return 'Auth';
  if (p === '/v1/svc/whoami') return 'Auth';
  if (p.startsWith('/v1/svc/')) return 'Auth';

  // Users
  if (p.startsWith('/auth/users')) return 'Users';
  if (p.startsWith('/auth/me')) return 'Users';
  if (p.startsWith('/auth/sessions')) return 'Users';
  if (p.startsWith('/auth/teams')) return 'Users';
  if (p.startsWith('/auth/leave-covers')) return 'Users';
  if (p.startsWith('/auth/dashboard-widgets')) return 'Users';
  if (p.startsWith('/auth/service-clients')) return 'Users';
  if (p.startsWith('/auth/audit')) return 'Users';
  if (p.startsWith('/auth/captcha')) return 'Auth';
  if (p.startsWith('/auth/')) return 'Users';

  // Dashboard
  if (p.startsWith('/api/dashboard')) return 'Dashboard';
  if (p.startsWith('/v1/dashboards')) return 'Dashboard';

  // Borrower
  if (p.startsWith('/api/customers')) return 'Borrower';
  if (p.startsWith('/v1/customers')) return 'Borrower';
  if (p.startsWith('/v1/risk-profile')) return 'Borrower';
  if (p.startsWith('/v1/watchlist')) return 'Borrower';

  // AI (must come before EWS to catch /v1/ai/*)
  if (p.startsWith('/v1/ai/')) return 'AI';
  if (p.startsWith('/v1/copilot/')) return 'AI';
  if (p.startsWith('/v1/scoring/')) return 'AI';

  // EWS
  if (p.startsWith('/v1/ews/')) return 'EWS';
  if (p.startsWith('/v1/indicators')) return 'EWS';
  if (p.startsWith('/v1/streaming/')) return 'EWS';
  if (p.startsWith('/v1/rules')) return 'EWS';
  if (p.startsWith('/api/rules')) return 'EWS';
  if (p.startsWith('/v1/feature-store')) return 'EWS';

  // Alerts
  if (p.startsWith('/api/alerts')) return 'Alerts';
  if (p.startsWith('/v1/alerts')) return 'Alerts';
  if (p.startsWith('/v1/aml/')) return 'Alerts';

  // Workflow
  if (p.startsWith('/api/cases')) return 'Workflow';
  if (p.startsWith('/v1/cases')) return 'Workflow';
  if (p.startsWith('/v1/investigations')) return 'Workflow';
  if (p === '/v1/action') return 'Workflow';
  if (p.startsWith('/v1/cms/')) return 'Workflow';
  if (p.startsWith('/v1/tenants/me/onboarding')) return 'Workflow';
  if (p.startsWith('/v1/tenants/onboarding')) return 'Workflow';
  if (p.match(/^\/v1\/tenants\/[^/]+\/onboarding/)) return 'Workflow';
  if (p === '/v1/field/operations/analytics') return 'Workflow';
  if (p.startsWith('/v1/field/')) return 'Workflow';

  // Reports
  if (p.startsWith('/v1/reports')) return 'Reports';
  if (p.startsWith('/v1/scenario/') || p === '/v1/scenarios' || p === '/v1/scenario/run')
    return 'Reports';
  if (p.startsWith('/v1/scenarios/')) return 'Reports';
  if (p.startsWith('/v1/scenarios')) return 'Reports';

  // Config (catch-all for the rest of /v1)
  if (p.startsWith('/v1/admin/config')) return 'Config';
  if (p.startsWith('/v1/webhooks')) return 'Config';
  if (p.startsWith('/v1/integrations')) return 'Config';
  if (p.startsWith('/v1/audit')) return 'Config';
  if (p.startsWith('/v1/ingestion')) return 'Config';
  if (p.startsWith('/v1/recovery')) return 'Config';
  if (p.startsWith('/v1/finops')) return 'Config';
  if (p.startsWith('/v1/notifications')) return 'Config';
  if (p.startsWith('/v1/tenants')) return 'Config'; // remaining tenant CRUD
  if (p.startsWith('/v1/')) return 'Config';

  // Health and root
  if (p === '/healthz' || p === '/' || p === '/healthz/') return 'Config';

  return 'Config';
}

// ─── 3. Path normalisation: Express `:param` → OpenAPI `{param}` ────────

function normalisePath(p) {
  return p.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}

function extractPathParams(p) {
  const params = [];
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(p)) !== null) params.push(m[1]);
  return params;
}

// ─── 4. Common parameters / responses / examples ───────────────────────

const COMMON_HEADERS = {
  XTenantId: {
    name: 'X-Tenant-ID',
    in: 'header',
    required: true,
    description:
      'Tenant identifier from the registry (e.g. `BANK_DEMO`, `BIL`). Validated by the BFF tenant middleware.',
    schema: { type: 'string', example: 'BANK_DEMO' },
  },
  XChannel: {
    name: 'X-Channel',
    in: 'header',
    required: true,
    description:
      'Calling channel — one of the tenant\'s `channels_allowed`. Typical values: `API`, `SPA`, `MOBILE`.',
    schema: { type: 'string', example: 'API' },
  },
  XApexUser: {
    name: 'X-APEX-USER',
    in: 'header',
    required: false,
    description:
      'Operator identity (audit-trail attribution). Required for routes that record `actor_username` / `created_by`.',
    schema: { type: 'string', example: 'alice.admin' },
  },
  XApexRole: {
    name: 'X-APEX-Role',
    in: 'header',
    required: false,
    description:
      'Role override for RBAC tests. In production this is derived from the verified JWT claim.',
    schema: {
      type: 'string',
      enum: ['admin', 'supervisor', 'risk_analyst', 'collection_officer', 'field_officer'],
    },
  },
};

const STANDARD_ERROR_RESPONSES = {
  '400': {
    description: 'Bad request — code-routed `EWS_400_<code>` envelope.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/EnvelopeError' } } },
  },
  '401': {
    description: 'Unauthenticated — missing or invalid bearer token / API key.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/EnvelopeError' } } },
  },
  '403': {
    description: 'Forbidden — role lacks the required RBAC scope.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/EnvelopeError' } } },
  },
  '404': {
    description: 'Not found — tenant-scoped lookup miss.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/EnvelopeError' } } },
  },
  '500': {
    description: 'Server error.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/EnvelopeError' } } },
  },
};

function defaultSuccessResponse(method, p) {
  // 204 for DELETE; 201 for POST that creates; 200 otherwise.
  if (method === 'delete') {
    return {
      '204': { description: 'No content — resource deleted.' },
    };
  }
  if (method === 'post' && /\/(create|provision|enrol|enroll|register)$/.test(p) === false) {
    // generic 200/201 — most POSTs in this codebase return 200 envelope
    return {
      '200': {
        description: 'Successful response (enveloped).',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Envelope' },
            example: { $ref: '#/components/examples/EnvelopeSuccess/value' },
          },
        },
      },
      '201': {
        description: 'Created (enveloped) — for POSTs that mint a new resource.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Envelope' } },
        },
      },
    };
  }
  return {
    '200': {
      description: 'Successful response (enveloped for `/v1/*`, raw JSON for `/api/*`).',
      content: {
        'application/json': {
          schema: {
            oneOf: [
              { $ref: '#/components/schemas/Envelope' },
              { type: 'object', additionalProperties: true },
            ],
          },
        },
      },
    },
  };
}

// ─── 5. Per-route OpenAPI builder ──────────────────────────────────────

function buildOperation(route) {
  const tag = tagFor(route.path);
  const pathParams = extractPathParams(route.path);
  const op = {
    tags: [tag],
    summary:
      route.summary ||
      `${route.method.toUpperCase()} ${route.path} — auto-discovered (server.ts:${route.line})`,
    operationId: makeOperationId(route),
    parameters: [],
    responses: { ...defaultSuccessResponse(route.method, route.path), ...STANDARD_ERROR_RESPONSES },
  };
  if (route.description) op.description = route.description;

  // Path params
  for (const name of pathParams) {
    op.parameters.push({
      name,
      in: 'path',
      required: true,
      description: `Path parameter \`${name}\`.`,
      schema: { type: 'string' },
    });
  }

  // Tenant + channel headers for /v1/* (the tenant middleware enforces these)
  if (route.path.startsWith('/v1/')) {
    op.parameters.push({ $ref: '#/components/parameters/XTenantId' });
    op.parameters.push({ $ref: '#/components/parameters/XChannel' });
    op.parameters.push({ $ref: '#/components/parameters/XApexUser' });
    op.parameters.push({ $ref: '#/components/parameters/XApexRole' });
  }

  // Body for POST/PATCH/PUT
  if (['post', 'patch', 'put'].includes(route.method)) {
    op.requestBody = {
      description:
        'Request body — `/v1/*` routes accept both raw and `{header, body}` enveloped bodies; the BFF unwraps automatically.',
      required: route.method !== 'patch', // PATCH bodies sometimes optional
      content: {
        'application/json': {
          schema: {
            oneOf: [
              { type: 'object', additionalProperties: true },
              { $ref: '#/components/schemas/RequestEnvelope' },
            ],
          },
        },
      },
    };
  }

  // Security: bearer for everything except a small allowlist
  const ANON_PATHS = ['/healthz', '/oauth/token', '/.well-known/jwks.json', '/auth/login', '/auth/refresh', '/auth/captcha'];
  if (!ANON_PATHS.includes(route.path)) {
    op.security = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
  } else {
    op.security = []; // public
  }

  return op;
}

function makeOperationId(route) {
  const verb = route.method;
  const slug =
    route.path
      .replace(/^\//, '')
      .replace(/[/:{}]/g, '_')
      .replace(/[^a-zA-Z0-9_]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'root';
  return `${verb}_${slug}`;
}

// ─── 6. Components: shared schemas, parameters, examples ────────────────

function buildComponents() {
  return {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'JWT issued by `/auth/login` or `/oauth/token` (client_credentials). The BFF verifies the signature against the auth-svc JWKS (`/.well-known/jwks.json`) and binds the caller to the `tenant_id` claim.',
      },
      apiKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Key (`apex_<prefix>.<secret>`)',
        description:
          'Service-account API key minted via `POST /v1/admin/api-keys`. Carried as `Authorization: Bearer apex_<prefix>.<secret>`. Resolves directly to (tenant_id, scopes); `X-Tenant-ID` overrides are ignored when API-key auth wins.',
      },
    },
    parameters: COMMON_HEADERS,
    schemas: {
      EnvelopeHeader: {
        type: 'object',
        description:
          'Bank-grade response envelope header per `Banking API Integration §6`.',
        required: ['status', 'code', 'message', 'requestId', 'timestamp'],
        properties: {
          status: { type: 'string', enum: ['SUCCESS', 'FAILURE'], example: 'SUCCESS' },
          code: { type: 'string', example: 'EWS_200' },
          message: { type: 'string', example: 'Processed Successfully' },
          requestId: { type: 'string', format: 'uuid' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      Envelope: {
        type: 'object',
        description: 'Standard success envelope.',
        required: ['header', 'body'],
        properties: {
          header: { $ref: '#/components/schemas/EnvelopeHeader' },
          body: {
            description: 'Operation payload. Shape varies per route.',
            oneOf: [
              { type: 'object', additionalProperties: true },
              { type: 'array', items: {} },
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
            ],
          },
        },
      },
      RequestEnvelope: {
        type: 'object',
        description:
          'Optional request envelope — `/v1/*` routes accept either this shape or the raw inner body.',
        required: ['body'],
        properties: {
          header: { type: 'object', additionalProperties: true },
          body: { type: 'object', additionalProperties: true },
        },
      },
      ErrorBody: {
        type: 'object',
        required: ['code', 'message', 'severity'],
        properties: {
          code: {
            type: 'string',
            description: 'Code-routed error identifier, e.g. `EWS_404_unknown_tenant`.',
            example: 'EWS_404_unknown_tenant',
          },
          message: { type: 'string', example: 'tenant BIL_FAKE not found' },
          severity: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
            example: 'MEDIUM',
          },
          detail: {
            type: 'object',
            description: 'Free-form extra context — error-specific.',
            additionalProperties: true,
          },
        },
      },
      EnvelopeError: {
        type: 'object',
        description: 'Standard error envelope per `Banking API Integration §11`.',
        required: ['header', 'error'],
        properties: {
          header: { $ref: '#/components/schemas/EnvelopeHeader' },
          error: { $ref: '#/components/schemas/ErrorBody' },
        },
      },
      Pagination: {
        type: 'object',
        description:
          'Cursor-free pagination metadata used by every paginated list route.',
        required: ['page', 'page_size', 'total'],
        properties: {
          page: { type: 'integer', minimum: 1, example: 1 },
          page_size: { type: 'integer', minimum: 1, maximum: 500, example: 50 },
          total: { type: 'integer', minimum: 0, example: 1234 },
        },
      },
      PaginatedListBody: {
        type: 'object',
        description:
          'Common paginated list body. Concrete routes substitute `items` element type via `oneOf`.',
        required: ['items', 'page', 'page_size', 'total'],
        properties: {
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          page: { type: 'integer', minimum: 1 },
          page_size: { type: 'integer', minimum: 1 },
          total: { type: 'integer', minimum: 0 },
        },
      },

      // ─── Domain resources (representative, not exhaustive) ─────────────

      Tenant: {
        type: 'object',
        required: ['tenant_id', 'name', 'vertical', 'channels_allowed', 'active'],
        properties: {
          tenant_id: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9_]{1,31}$',
            example: 'BIL',
          },
          name: { type: 'string', example: 'BIL Insurance' },
          vertical: { type: 'string', enum: ['banking', 'insurance'], example: 'insurance' },
          channels_allowed: {
            type: 'array',
            items: { type: 'string' },
            example: ['API', 'SPA', 'MOBILE'],
          },
          active: { type: 'boolean' },
        },
      },

      RiskLevel: { type: 'string', enum: ['Low', 'Medium', 'High'] },
      AlertSeverity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
      BilAlertClass: { type: 'string', enum: ['red', 'orange', 'yellow', 'green'] },
      AlertStatus: { type: 'string', enum: ['open', 'acked', 'closed'] },

      Customer: {
        type: 'object',
        required: ['customer_id', 'name'],
        properties: {
          customer_id: { type: 'string', example: 'c-101' },
          name: { type: 'string', example: 'Alice Onyango' },
          risk_level: { $ref: '#/components/schemas/RiskLevel' },
          exposure_kes: { type: 'number', example: 4_500_000 },
          dpd_max_90d: { type: 'integer', example: 12 },
          bureau_score: { type: 'integer', example: 745 },
        },
      },

      ShapReason: {
        type: 'object',
        required: ['feature', 'value', 'shap_value', 'direction'],
        properties: {
          feature: { type: 'string', example: 'utilization' },
          value: { type: 'number', example: 0.92 },
          shap_value: { type: 'number', example: 0.18 },
          direction: { type: 'string', enum: ['positive', 'negative'] },
        },
      },

      RiskProfile: {
        type: 'object',
        required: ['customer_id', 'pd', 'level', 'top_reasons'],
        properties: {
          customer_id: { type: 'string' },
          pd: { type: 'number', minimum: 0, maximum: 1, example: 0.42 },
          level: { $ref: '#/components/schemas/RiskLevel' },
          top_reasons: {
            type: 'array',
            items: { $ref: '#/components/schemas/ShapReason' },
            minItems: 0,
            maxItems: 5,
          },
          model_name: { type: 'string', example: 'pd_xgboost' },
          model_version: { type: 'string', example: '3.2.1' },
        },
      },

      Alert: {
        type: 'object',
        required: ['id', 'customer', 'rule', 'severity', 'status'],
        properties: {
          id: { type: 'string', example: 'alert-2026-05-23-001' },
          customer: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
          },
          rule: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
          },
          severity: { $ref: '#/components/schemas/AlertSeverity' },
          status: { $ref: '#/components/schemas/AlertStatus' },
          bil_class: { $ref: '#/components/schemas/BilAlertClass' },
          criticality_score: { type: 'number', example: 7.82 },
          customer_exposure_kes: { type: 'number', example: 4_500_000 },
          created_at: { type: 'string', format: 'date-time' },
          age_min: { type: 'integer' },
          assignee: { type: 'string', nullable: true },
        },
      },

      CaseState: {
        type: 'string',
        enum: ['open', 'assigned', 'in_action', 'monitored', 'closed'],
      },
      CaseOutcome: {
        type: 'string',
        enum: ['cured', 'cured_temp', 'defaulted'],
        nullable: true,
      },

      Case: {
        type: 'object',
        required: ['case_id', 'tenant_id', 'state'],
        properties: {
          case_id: { type: 'string' },
          tenant_id: { type: 'string' },
          alert_id: { type: 'string', nullable: true },
          customer_id: { type: 'string' },
          state: { $ref: '#/components/schemas/CaseState' },
          assignee: { type: 'string', nullable: true },
          outcome: { $ref: '#/components/schemas/CaseOutcome' },
          sla_status: {
            type: 'string',
            enum: ['on_track', 'approaching', 'breached', 'closed'],
          },
          opened_at: { type: 'string', format: 'date-time' },
          closed_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },

      AiModelStatus: {
        type: 'string',
        enum: ['experimental', 'staging', 'production', 'shadow', 'retired'],
      },
      AiModelType: {
        type: 'string',
        enum: ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'],
      },

      AiModel: {
        type: 'object',
        required: ['model_id', 'name', 'type', 'version', 'status', 'framework'],
        properties: {
          model_id: { type: 'string', example: 'pd_xgb_v3' },
          name: { type: 'string', example: 'PD Model — XGBoost v3' },
          type: { $ref: '#/components/schemas/AiModelType' },
          version: { type: 'string', example: '3.2.1' },
          status: { $ref: '#/components/schemas/AiModelStatus' },
          framework: {
            type: 'string',
            enum: ['xgboost', 'sklearn', 'torch', 'lightgbm', 'isolation_forest'],
          },
          trained_at: { type: 'string', format: 'date-time' },
          deployed_at: { type: 'string', format: 'date-time', nullable: true },
          key_features: { type: 'array', items: { type: 'string' } },
          metrics: {
            type: 'object',
            properties: {
              auc: { type: 'number', nullable: true },
              precision: { type: 'number', nullable: true },
              recall: { type: 'number', nullable: true },
              f1: { type: 'number', nullable: true },
              mae: { type: 'number', nullable: true },
              training_rows: { type: 'integer' },
              evaluated_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      },

      AiPrediction: {
        type: 'object',
        required: [
          'prediction_id',
          'tenant_id',
          'model_id',
          'model_version',
          'prediction_type',
          'customer_id',
          'value',
          'top_features',
          'generated_at',
          'created_at',
          'created_by',
        ],
        properties: {
          prediction_id: { type: 'string', format: 'uuid' },
          tenant_id: { type: 'string' },
          model_id: { type: 'string' },
          model_version: { type: 'string' },
          prediction_type: { $ref: '#/components/schemas/AiModelType' },
          customer_id: { type: 'string' },
          value: { type: 'number' },
          band: { type: 'string', enum: ['low', 'medium', 'high'], nullable: true },
          confidence: { type: 'number', nullable: true },
          top_features: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                feature: { type: 'string' },
                value: { type: 'number' },
                attribution: { type: 'number' },
              },
            },
          },
          input_snapshot: { type: 'object', additionalProperties: true, nullable: true },
          generated_at: { type: 'string', format: 'date-time' },
          created_at: { type: 'string', format: 'date-time' },
          created_by: { type: 'string' },
        },
      },

      ConfigEntry: {
        type: 'object',
        required: ['key', 'category', 'type', 'value', 'is_default'],
        properties: {
          key: { type: 'string', example: 'alerts.red_sla_hours' },
          category: {
            type: 'string',
            enum: ['alerts', 'notifications', 'reporting', 'scoring', 'features'],
          },
          type: { type: 'string', enum: ['number', 'string', 'boolean', 'json'] },
          value: {
            oneOf: [
              { type: 'number' },
              { type: 'string' },
              { type: 'boolean' },
              { type: 'object', additionalProperties: true },
            ],
          },
          default_value: {
            oneOf: [
              { type: 'number' },
              { type: 'string' },
              { type: 'boolean' },
              { type: 'object', additionalProperties: true },
            ],
          },
          description: { type: 'string' },
          is_default: { type: 'boolean' },
          updated_at: { type: 'string', format: 'date-time', nullable: true },
          updated_by: { type: 'string', nullable: true },
        },
      },

      WebhookSubscription: {
        type: 'object',
        required: ['subscription_id', 'tenant_id', 'name', 'url', 'event_types', 'active'],
        properties: {
          subscription_id: { type: 'string' },
          tenant_id: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          event_types: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['alert.created', 'alert.updated', 'case.assigned', 'case.closed', 'scenario.run'],
            },
          },
          active: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },

      ApiKeyEntry: {
        type: 'object',
        required: ['key_id', 'name', 'prefix', 'status', 'scopes', 'created_at', 'created_by'],
        properties: {
          key_id: { type: 'string' },
          name: { type: 'string' },
          prefix: { type: 'string', example: 'apex_abc123def456' },
          status: { type: 'string', enum: ['active', 'revoked'] },
          scopes: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'alerts:read',
                'cases:read',
                'audit:read',
                'reports:read',
                'notifications:send',
                'webhooks:dispatch',
                'integrations:read',
                'recovery:archive_internal',
              ],
            },
          },
          created_at: { type: 'string', format: 'date-time' },
          created_by: { type: 'string' },
          expires_at: { type: 'string', format: 'date-time', nullable: true },
          last_used_at: { type: 'string', format: 'date-time', nullable: true },
          revoked_at: { type: 'string', format: 'date-time', nullable: true },
          revoked_by: { type: 'string', nullable: true },
        },
      },
    },

    examples: {
      EnvelopeSuccess: {
        summary: 'Successful enveloped response',
        value: {
          header: {
            status: 'SUCCESS',
            code: 'EWS_200',
            message: 'Processed Successfully',
            requestId: '8f4e5a90-2a55-4f8e-9c63-bc4e5e1d3a91',
            timestamp: '2026-05-23T12:00:00.000Z',
          },
          body: { ok: true },
        },
      },
      EnvelopeError404: {
        summary: 'Not-found error envelope',
        value: {
          header: {
            status: 'FAILURE',
            code: 'EWS_404_unknown_tenant',
            message: 'tenant BIL_FAKE not found',
            requestId: '8f4e5a90-2a55-4f8e-9c63-bc4e5e1d3a91',
            timestamp: '2026-05-23T12:00:00.000Z',
          },
          error: {
            code: 'EWS_404_unknown_tenant',
            message: 'tenant BIL_FAKE not found',
            severity: 'MEDIUM',
          },
        },
      },
      EnvelopeError403: {
        summary: 'Forbidden envelope (RBAC scope missing)',
        value: {
          header: {
            status: 'FAILURE',
            code: 'EWS_403_missing_scope',
            message: 'role field_officer is not permitted to invoke webhooks:manage',
            requestId: '8f4e5a90-2a55-4f8e-9c63-bc4e5e1d3a91',
            timestamp: '2026-05-23T12:00:00.000Z',
          },
          error: {
            code: 'EWS_403_missing_scope',
            message: 'role field_officer is not permitted to invoke webhooks:manage',
            severity: 'MEDIUM',
          },
        },
      },
      LoginRequest: {
        summary: 'Login request',
        value: { username: 'alice.admin', password: 'Admin!Pass1' },
      },
      LoginResponse: {
        summary: 'Login response (full token pair, no 2FA enrolled)',
        value: {
          access_token: '<RS256 JWT>',
          refresh_token: '<RS256 JWT>',
          token_type: 'Bearer',
          expires_in: 900,
          must_change_password: false,
        },
      },
      ScoreRequest: {
        summary: 'AI score request',
        value: { customer_id: 'c-101' },
      },
      ScoreResponse: {
        summary: 'AI score envelope',
        value: {
          header: {
            status: 'SUCCESS',
            code: 'EWS_200',
            message: 'Processed Successfully',
            requestId: '8f4e5a90-2a55-4f8e-9c63-bc4e5e1d3a91',
            timestamp: '2026-05-23T12:00:00.000Z',
          },
          body: {
            model_id: 'pd_xgb_v3',
            customer_id: 'c-101',
            score: 0.42,
            probability: 0.42,
            band: 'medium',
            scored_at: '2026-05-23T12:00:00.000Z',
            top_features: [
              { feature: 'utilization', value: 0.85, attribution: 0.18 },
              { feature: 'dpd_max_90d', value: 12, attribution: 0.12 },
            ],
          },
        },
      },
    },
  };
}

// ─── 7. Validation ─────────────────────────────────────────────────────

function validateSpec(spec) {
  const errors = [];

  // OpenAPI 3.1 must have openapi, info, paths
  if (!spec.openapi) errors.push('missing openapi version');
  if (!spec.info) errors.push('missing info block');
  if (!spec.info.title) errors.push('missing info.title');
  if (!spec.info.version) errors.push('missing info.version');
  if (!spec.paths) errors.push('missing paths');

  // Every path must have at least one method
  const validMethods = ['get', 'post', 'patch', 'put', 'delete', 'options', 'head'];
  for (const [p, ops] of Object.entries(spec.paths)) {
    const keys = Object.keys(ops);
    if (keys.length === 0) errors.push(`path ${p}: no operations`);
    for (const k of keys) {
      if (!validMethods.includes(k)) errors.push(`path ${p}: invalid method ${k}`);
    }
  }

  // Every $ref must resolve to an existing component
  const seenRefs = new Set();
  function collectRefs(obj, trail = '$') {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$ref' && typeof v === 'string') seenRefs.add(v);
      else collectRefs(v, `${trail}.${k}`);
    }
  }
  collectRefs(spec);
  for (const ref of seenRefs) {
    // Resolve '#/components/schemas/X' or '#/components/parameters/X' etc.
    if (!ref.startsWith('#/')) continue; // external refs allowed
    const parts = ref.slice(2).split('/');
    let node = spec;
    for (const part of parts) {
      if (!node || typeof node !== 'object' || !(part in node)) {
        errors.push(`unresolved $ref: ${ref}`);
        break;
      }
      node = node[part];
    }
  }

  // Every status code must be a 3-digit string
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(ops)) {
      if (!op.responses) {
        errors.push(`${m.toUpperCase()} ${p}: no responses block`);
        continue;
      }
      for (const status of Object.keys(op.responses)) {
        if (!/^([1-5]\d\d|default)$/.test(status)) {
          errors.push(`${m.toUpperCase()} ${p}: invalid status ${status}`);
        }
      }
    }
  }

  // No duplicate operationIds
  const opIds = new Map();
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(ops)) {
      if (op.operationId) {
        if (opIds.has(op.operationId)) {
          errors.push(
            `duplicate operationId ${op.operationId}: ${opIds.get(op.operationId)} vs ${m.toUpperCase()} ${p}`,
          );
        } else {
          opIds.set(op.operationId, `${m.toUpperCase()} ${p}`);
        }
      }
    }
  }

  // No duplicate schemas (by content equality on the same name)
  // (component schemas can't have duplicates by definition of Map; this is
  //  more a sanity check on the build itself.)
  if (spec.components && spec.components.schemas) {
    const names = Object.keys(spec.components.schemas);
    const unique = new Set(names);
    if (names.length !== unique.size) {
      errors.push('duplicate schema names in components.schemas');
    }
  }

  return errors;
}

// ─── 8. Build the markdown index ────────────────────────────────────────

function buildMarkdown(spec, routes) {
  const lines = [];
  const byTag = new Map();
  for (const r of routes) {
    const t = tagFor(r.path);
    if (!byTag.has(t)) byTag.set(t, []);
    byTag.get(t).push(r);
  }

  lines.push('# BFF OpenAPI 3.1 — API Reference');
  lines.push('');
  lines.push(
    `> Auto-generated from \`services/bff/src/server.ts\` + \`services/auth-svc/src/**\` ` +
      `on **${new Date().toISOString()}**. ` +
      `Hand-edits are overwritten on next \`scripts/gen-openapi.js\` run.`,
  );
  lines.push('');
  lines.push('## Specification artefacts');
  lines.push('');
  lines.push('| File | Format | Purpose |');
  lines.push('|---|---|---|');
  lines.push('| [`swagger.json`](./swagger.json) | OpenAPI 3.1 JSON | Machine-readable; import to Postman / Insomnia / Stoplight |');
  lines.push('| [`swagger.yaml`](./swagger.yaml) | OpenAPI 3.1 YAML | Human-readable canonical form |');
  lines.push('| [`openapi.md`](./openapi.md) | Markdown | This file — quick navigation + curl examples |');
  lines.push('');

  const bffCount = routes.filter((r) => r.server === 'bff').length;
  const authCount = routes.filter((r) => r.server === 'auth-svc').length;
  lines.push('## Coverage');
  lines.push('');
  lines.push(
    `- **${routes.length}** route declarations auto-discovered: ${bffCount} from BFF + ${authCount} from auth-svc`,
  );
  lines.push(
    `- Grouped into **${byTag.size}** tag buckets (Auth · Users · Dashboard · Borrower · EWS · Alerts · Workflow · AI · Reports · Config)`,
  );
  lines.push(`- **Bearer auth** required on all routes except: \`/healthz\`, \`/oauth/token\`, \`/.well-known/jwks.json\`, \`/auth/login\`, \`/auth/refresh\`, \`/auth/captcha\``);
  lines.push(`- **\`X-Tenant-ID\` + \`X-Channel\`** headers required on every \`/v1/*\` route (BFF tenant middleware)`);
  lines.push('');

  lines.push('## Authentication');
  lines.push('');
  lines.push('Two parallel schemes supported on every guarded route:');
  lines.push('');
  lines.push('### `bearerAuth` — JWT (user sessions)');
  lines.push('');
  lines.push('```');
  lines.push('Authorization: Bearer <RS256 JWT>');
  lines.push('X-Tenant-ID: BANK_DEMO');
  lines.push('X-Channel: API');
  lines.push('```');
  lines.push('');
  lines.push('Issue via `POST /auth/login` (user + password) or `POST /oauth/token` (`grant_type=client_credentials`). Signature verified against `GET /.well-known/jwks.json`.');
  lines.push('');
  lines.push('### `apiKeyAuth` — service-account keys');
  lines.push('');
  lines.push('```');
  lines.push('Authorization: Bearer apex_<prefix>.<secret>');
  lines.push('```');
  lines.push('');
  lines.push('Minted via `POST /v1/admin/api-keys`; secret returned ONCE. Scoped to a subset of `alerts:read | cases:read | audit:read | reports:read | notifications:send | webhooks:dispatch | integrations:read | recovery:archive_internal`. Tenant binding baked into the key — `X-Tenant-ID` overrides are ignored.');
  lines.push('');

  lines.push('## Response envelope');
  lines.push('');
  lines.push('Every `/v1/*` route returns the bank-grade envelope per Banking API Integration §6:');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({
    header: {
      status: 'success',
      code: 'EWS_200',
      message: 'Processed Successfully',
      requestId: '8f4e5a90-2a55-4f8e-9c63-bc4e5e1d3a91',
      timestamp: '2026-05-23T12:00:00.000Z',
    },
    body: '<route-specific payload>',
  }, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Errors carry the same header + an `error: { code, message, severity, detail? }` block. Codes route by status: `EWS_400_<reason>` / `EWS_404_<resource>` / `EWS_409_<conflict>` / `EWS_500`. SPA-internal `/api/*` routes return raw JSON (no envelope) and are documented but not enveloped.');
  lines.push('');

  lines.push('## Pagination');
  lines.push('');
  lines.push('Every paginated list route accepts `?page=N&page_size=N` and returns:');
  lines.push('');
  lines.push('```');
  lines.push('{ "items": [...], "page": 1, "page_size": 50, "total": 1234 }');
  lines.push('```');
  lines.push('');
  lines.push('`page_size` is silently clamped — see the per-route schema for the cap (typically 200 or 500).');
  lines.push('');

  // Per-tag tables
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

  lines.push('## Endpoints by tag');
  lines.push('');
  for (const tag of TAG_ORDER) {
    const list = byTag.get(tag) || [];
    if (list.length === 0) continue;
    lines.push(`### ${tag}`);
    lines.push('');
    lines.push(`_${TAGS[tag]}_`);
    lines.push('');
    lines.push(`**${list.length} routes.** Routes sorted by path.`);
    lines.push('');
    lines.push('| Method | Path | Summary |');
    lines.push('|---|---|---|');
    list
      .slice()
      .sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
      .forEach((r) => {
        const summary = (r.summary || '').replace(/\|/g, '\\|').slice(0, 120);
        lines.push(`| \`${r.method.toUpperCase()}\` | \`${r.path}\` | ${summary} |`);
      });
    lines.push('');
  }

  lines.push('## Example curl invocations');
  lines.push('');
  lines.push('### Authenticate + score a customer');
  lines.push('');
  lines.push('```bash');
  lines.push('TOKEN=$(curl -s http://localhost:8080/auth/login \\');
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push('  -d \'{"username":"alice.admin","password":"Admin!Pass1"}\' | jq -r .access_token)');
  lines.push('');
  lines.push('curl http://localhost:8084/v1/ai/models/pd_xgb_v3/score \\');
  lines.push('  -H "Authorization: Bearer $TOKEN" \\');
  lines.push('  -H "X-Tenant-ID: BANK_DEMO" \\');
  lines.push('  -H "X-Channel: API" \\');
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push('  -d \'{"customer_id":"c-101"}\'');
  lines.push('```');
  lines.push('');
  lines.push('### List BIL claims dashboard');
  lines.push('');
  lines.push('```bash');
  lines.push('curl http://localhost:8084/v1/dashboards/bil/claims \\');
  lines.push('  -H "Authorization: Bearer $TOKEN" \\');
  lines.push('  -H "X-Tenant-ID: BIL" \\');
  lines.push('  -H "X-Channel: API"');
  lines.push('```');
  lines.push('');
  lines.push('### Provision a service-account API key');
  lines.push('');
  lines.push('```bash');
  lines.push('curl http://localhost:8084/v1/admin/api-keys \\');
  lines.push('  -H "Authorization: Bearer $TOKEN" \\');
  lines.push('  -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API" \\');
  lines.push('  -H "X-APEX-USER: alice.admin" \\');
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push('  -d \'{"name":"AML Hub primary","scopes":["alerts:read","audit:read"]}\'');
  lines.push('');
  lines.push('# Response includes `key: apex_<prefix>.<secret>` — captured ONCE.');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

// ─── 9. Build the OpenAPI spec ──────────────────────────────────────────

function buildSpec(routes) {
  const paths = {};
  const tagSet = new Set();

  // De-duplicate operationIds by suffixing _2, _3, ... on collision.
  const seenOpIds = new Map();
  function nextOpId(base) {
    if (!seenOpIds.has(base)) {
      seenOpIds.set(base, 1);
      return base;
    }
    let i = seenOpIds.get(base) + 1;
    while (seenOpIds.has(`${base}_${i}`)) i++;
    seenOpIds.set(base, i);
    const id = `${base}_${i}`;
    seenOpIds.set(id, 1);
    return id;
  }

  for (const route of routes) {
    const openapiPath = normalisePath(route.path);
    if (!paths[openapiPath]) paths[openapiPath] = {};
    const op = buildOperation(route);
    op.operationId = nextOpId(op.operationId);
    paths[openapiPath][route.method] = op;
    tagSet.add(tagFor(route.path));
  }

  const tags = [];
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
  for (const t of TAG_ORDER) {
    if (tagSet.has(t)) tags.push({ name: t, description: TAGS[t] });
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ZorEWS BFF API',
      version: '1.0.0',
      summary:
        'Backend-for-frontend API surface for the ZorEWS Early Warning System (banking + insurance verticals).',
      description:
        'Auto-discovered from `services/bff/src/server.ts`. Covers every public `/v1/*` operation plus the SPA-internal `/api/*` proxies. Generated by `scripts/gen-openapi.js`.\n\nSee Banking API Integration §6 (envelope), §7 (OAuth), §11 (error shape) for protocol details.',
      contact: { name: 'ZorEWS Engineering' },
      license: { name: 'Proprietary' },
    },
    servers: [
      { url: 'http://localhost:8084', description: 'BFF (local development; `make up`)' },
      { url: 'http://localhost:8080', description: 'auth-svc (login + /oauth/token + JWKS)' },
      { url: 'https://api.apex-ews.example', description: 'Production (placeholder — not deployed)' },
    ],
    tags,
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    paths,
    components: buildComponents(),
  };
}

// ─── 10. Main ───────────────────────────────────────────────────────────

function main() {
  const routes = [];
  for (const src of SOURCES) {
    if (!fs.existsSync(src.file)) {
      console.warn(`  ! skipping (not found): ${path.relative(REPO_ROOT, src.file)}`);
      continue;
    }
    const text = fs.readFileSync(src.file, 'utf8');
    const found = discoverRoutes(text, src);
    console.log(`  + ${path.relative(REPO_ROOT, src.file).padEnd(50)} ${found.length} routes`);
    routes.push(...found);
  }

  // Deduplicate routes by (method, path, server) — same route declared in
  // multiple sources is rare but possible during refactors.
  const seenKeys = new Set();
  const uniqueRoutes = [];
  for (const r of routes) {
    const k = `${r.server}|${r.method}|${r.path}`;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    uniqueRoutes.push(r);
  }
  console.log(`\nDiscovered ${uniqueRoutes.length} unique routes (${routes.length} raw)`);

  const tagCounts = new Map();
  for (const r of uniqueRoutes) {
    const t = tagFor(r.path);
    tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }
  for (const [t, n] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(10)} ${n}`);
  }

  const spec = buildSpec(uniqueRoutes);
  const errors = validateSpec(spec);
  if (errors.length) {
    console.error('\n✕ Validation errors:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('\n✓ Spec validates structurally:');
  console.log(`  - ${Object.keys(spec.paths).length} unique paths`);
  console.log(`  - ${Object.keys(spec.components.schemas).length} schemas`);
  console.log(`  - ${Object.keys(spec.components.parameters).length} shared parameters`);
  console.log(`  - ${Object.keys(spec.components.examples).length} examples`);
  console.log(`  - ${Object.keys(spec.components.securitySchemes).length} security schemes`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, 'swagger.json');
  const yamlPath = path.join(OUT_DIR, 'swagger.yaml');
  const mdPath = path.join(OUT_DIR, 'openapi.md');

  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  fs.writeFileSync(yamlPath, yaml.dump(spec, { lineWidth: 120, noRefs: true }), 'utf8');
  fs.writeFileSync(mdPath, buildMarkdown(spec, uniqueRoutes), 'utf8');

  console.log(`\nWrote:`);
  console.log(`  - ${path.relative(REPO_ROOT, jsonPath)}`);
  console.log(`  - ${path.relative(REPO_ROOT, yamlPath)}`);
  console.log(`  - ${path.relative(REPO_ROOT, mdPath)}`);
}

main();
