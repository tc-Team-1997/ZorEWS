/**
 * OpenAPI / Swagger UI surface.
 *
 * Two routes:
 *   * GET /auth/openapi.yaml — raw spec (cached read on first hit).
 *   * GET /auth/docs         — Swagger UI page served from the
 *                              jsDelivr CDN; no new npm dep.
 *
 * Spec source-of-truth lives at services/auth-svc/openapi.yaml so the
 * file can be lifted into a partner integration pack independently of
 * the running auth-svc.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

let cached: string | null = null;

function loadSpec(): string {
  if (cached !== null) return cached;
  // openapi.yaml sits in the auth-svc root (one level above `src/`).
  // Works for both `tsx src/server.ts` (dev) and `node dist/server.js`
  // (prod) since the relative climb is the same.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "openapi.yaml"),
    join(here, "..", "..", "..", "openapi.yaml"),
  ];
  for (const c of candidates) {
    try {
      cached = readFileSync(c, "utf8");
      return cached;
    } catch {
      /* try next */
    }
  }
  cached = "openapi: 3.1.0\ninfo:\n  title: ZorEWS Auth\n  version: '0.0.0'\npaths: {}\n";
  return cached;
}

function swaggerHtml(specUrl: string): string {
  // Pin the CDN version so a Swagger-UI release doesn't change the
  // rendering surface without a deliberate update here.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ZorEWS Auth API · docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>
    body { margin: 0; background: #f5f1e8; }
    .topbar { display: none; }
    #header {
      background: linear-gradient(115deg, #0A1430 0%, #11296D 70%, #1B3CA8 100%);
      color: #F5F1E8;
      padding: 18px 32px;
      font-family: ui-sans-serif, Inter, system-ui, sans-serif;
      border-bottom: 4px solid #FF6B35;
    }
    #header h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
    #header h1 span { color: #FF6B35; }
    #header p { margin: 4px 0 0; font-size: 12px; opacity: 0.75; }
  </style>
</head>
<body>
  <div id="header">
    <h1>Zor<span>EWS</span> · Authentication API</h1>
    <p>OpenAPI 3.1 · multi-country · multi-tenant · MFA · JWT + refresh rotation</p>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "${specUrl}",
      dom_id: '#swagger-ui',
      docExpansion: 'list',
      defaultModelsExpandDepth: 0,
      tryItOutEnabled: true,
      filter: true,
      syntaxHighlight: { theme: 'agate' },
      // Persist Bearer authorization across page reloads so testers
      // can paste a token once + replay every Try-It-Out call.
      persistAuthorization: true,
    });
  </script>
</body>
</html>`;
}

export function registerOpenapiRoutes(app: FastifyInstance): void {
  app.get("/auth/openapi.yaml", async (_req, reply) => {
    reply.header("Content-Type", "application/yaml; charset=utf-8");
    // Loose CSP for this single route — we don't render HTML here,
    // raw YAML download is safe across origins.
    reply.header("Content-Disposition", 'inline; filename="zorews-auth-openapi.yaml"');
    return reply.send(loadSpec());
  });

  app.get("/auth/docs", async (req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    // Swagger UI loads scripts + styles from jsDelivr — relax the
    // route-level CSP so the inline bootstrap + CDN assets work.
    // The global onSend hook in server.ts sets a strict CSP that
    // we override here only for the docs page (HTML-only surface).
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; " +
        "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
        "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "font-src 'self' data:; " +
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return reply.send(swaggerHtml(`/auth/openapi.yaml`));
  });
}
