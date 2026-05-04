import Fastify from "fastify";
import { registerAuthRoutes } from "./routes/auth.js";

/**
 * OWASP-recommended response headers — same set as the BFF emits.
 * See services/bff/src/security_headers.ts for the rationale per header.
 * Auth responses are JSON-only so a strict CSP (no inline / no unsafe-eval)
 * is fine.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=()",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.body.password"],
    },
  });

  // Apply security headers to every response. onSend fires after route
  // handlers so this catches both happy-path responses and error replies.
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    return payload;
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  registerAuthRoutes(app);

  return app;
}

// Allow `import { buildServer }` for tests; only listen when run directly.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8080);
  app.listen({ port, host: "0.0.0.0" })
    .then(() => {
      app.log.info(
        `auth-svc listening on :${port} — store: ${
          process.env.AUTH_SVC_PG_URL ? "postgres (app_iam.*)" : "in-memory"
        }`,
      );
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
