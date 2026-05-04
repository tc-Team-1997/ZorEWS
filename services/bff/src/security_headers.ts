// services/bff/src/security_headers.ts
//
// Express middleware that sets the OWASP-recommended response headers on
// every response. Hand-rolled (no helmet dep) so the prototype keeps a
// small dependency graph; the values follow the same defaults helmet
// would emit, with comments where we deviate for local-dev usability.
//
// Production note: HSTS is only meaningful behind HTTPS. The middleware
// emits it unconditionally so the header survives ALB/Cloudfront. CSP
// is intentionally permissive for the prototype because the SPA also
// loads from a different origin in dev (vite on :5174); production
// would tighten `connect-src` and `script-src` to the SPA's origin.

import type { NextFunction, Request, Response } from 'express';

interface CspOptions {
  /** Override the connect-src list (e.g. for production where it should
   *  be the SPA's origin only). Defaults to "'self' http: https:". */
  connect_src?: string[];
}

function buildCsp(opts: CspOptions = {}): string {
  const connectSrc = opts.connect_src ?? ["'self'", 'http:', 'https:'];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // 'unsafe-inline' is necessary for Tailwind's dev-mode style injection
    // and the recharts SVG attribute styles. Production builds should
    // drop it once styles are pre-compiled.
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    `connect-src ${connectSrc.join(' ')}`,
    "form-action 'self'",
  ].join('; ');
}

export function securityHeaders(opts: CspOptions = {}) {
  const csp = buildCsp(opts);
  return function securityHeadersMw(_req: Request, res: Response, next: NextFunction) {
    // Force HTTPS for 1 year, including subdomains. Browsers ignore this
    // unless the response itself was served over HTTPS, so this is safe
    // to emit unconditionally during local dev.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Block MIME-sniffing.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Defense-in-depth against clickjacking; CSP frame-ancestors is the
    // modern equivalent but X-Frame-Options is still respected by older
    // browsers + intermediaries.
    res.setHeader('X-Frame-Options', 'DENY');
    // Don't leak the full URL in cross-origin Referer headers.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Surface a deny-by-default policy for sensitive browser features
    // that this app never uses.
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=()',
    );
    // Hide the server fingerprint.
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.removeHeader('X-Powered-By');
    res.setHeader('Content-Security-Policy', csp);
    // Modern browsers respect Cross-Origin-Resource-Policy + COOP/COEP
    // for embedding control; same-origin is the strict-but-usable
    // default.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  };
}
