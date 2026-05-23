// services/bff/src/docs.ts
//
// Mount Swagger UI for the auto-generated OpenAPI 3.1 spec at /docs.
//
// Behaviour:
//   - Tries to read `docs/api/swagger.json` from the repo root
//     (relative to the source file's runtime location)
//   - On success: serves the interactive UI at /docs and the raw JSON at
//     /docs/openapi.json
//   - On miss / read failure: logs one warning line and skips. The BFF
//     keeps running normally — docs are an additive convenience, not a
//     hard dependency.
//
// Opt-out: set DISABLE_DOCS=true to skip the mount entirely (production
// override; the docs surface itself has no business logic).
//
// Why not always mount inside makeApp()? Existing jest tests construct
// makeApp() with hermetic deps; pulling in swagger-ui middleware on every
// test instance is extra work for no test value. Mount happens once in
// the dev/prod bootstrap (`if (require.main === module)`).

import fs from 'fs';
import path from 'path';
import type { Express, Request, Response } from 'express';

const REPO_ROOT_CANDIDATES = [
  // From services/bff/dist/server.js (after compile)
  path.resolve(__dirname, '..', '..', '..'),
  // From services/bff/src/server.ts (ts-node / dev)
  path.resolve(__dirname, '..', '..', '..'),
  // Allow override via env
  process.env.ZOREWS_REPO_ROOT,
].filter((p): p is string => typeof p === 'string' && p.length > 0);

function resolveSpecPath(): string | null {
  for (const root of REPO_ROOT_CANDIDATES) {
    const p = path.join(root, 'docs', 'api', 'swagger.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface MountDocsOptions {
  /** Override the docs path (default: /docs). */
  basePath?: string;
  /** Override the OpenAPI JSON path (default: <basePath>/openapi.json). */
  jsonPath?: string;
}

export function mountDocs(app: Express, opts: MountDocsOptions = {}): boolean {
  if (process.env.DISABLE_DOCS === 'true') {
    console.log('[docs] mount skipped — DISABLE_DOCS=true');
    return false;
  }

  const basePath = opts.basePath ?? '/docs';
  const jsonPath = opts.jsonPath ?? `${basePath}/openapi.json`;

  const specPath = resolveSpecPath();
  if (!specPath) {
    console.warn(
      '[docs] swagger.json not found — skipping /docs mount. ' +
        'Run `node scripts/gen-openapi.js` from the repo root to generate it.',
    );
    return false;
  }

  let spec: unknown;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  } catch (e) {
    console.error('[docs] failed to parse swagger.json:', e);
    return false;
  }

  // Lazy-require swagger-ui-express. If the package isn't installed (rare
  // path; defensive after npm-prune), log + skip rather than crash.
  let swaggerUi: typeof import('swagger-ui-express');
  try {
    swaggerUi = require('swagger-ui-express') as typeof import('swagger-ui-express');
  } catch (e) {
    console.warn('[docs] swagger-ui-express not installed — skipping /docs mount.');
    return false;
  }

  // Serve raw JSON FIRST so callers can curl `<base>/openapi.json` without
  // hitting the swagger-ui static handler.
  app.get(jsonPath, (_req: Request, res: Response) => res.json(spec));

  // Mount the interactive UI. Customise the page title + remove the
  // default "explore" bar (no remote-load — local-only).
  app.use(
    basePath,
    swaggerUi.serveFiles(spec as Record<string, unknown>, {
      swaggerOptions: { displayRequestDuration: true, persistAuthorization: true },
    }),
    swaggerUi.setup(spec as Record<string, unknown>, {
      customSiteTitle: 'ZorEWS BFF — API Reference',
      customCss: '.swagger-ui .topbar { display: none }',
      explorer: false,
    }),
  );

  console.log(
    `[docs] Swagger UI mounted at ${basePath} — JSON at ${jsonPath} — ${
      Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {}).length
    } paths`,
  );
  return true;
}
