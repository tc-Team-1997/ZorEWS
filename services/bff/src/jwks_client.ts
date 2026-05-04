// services/bff/src/jwks_client.ts
//
// JWKS-based JWT signature verification (T4.24 Phase 7).
//
// Phase 3 introduced a base64-decode-only shim in tenant.ts — tokens
// were parsed but not signature-verified, with the trade-off documented.
// This module replaces that shim with proper RS256 verification when
// `BFF_JWKS_URL` is configured (production / integration testing).
//
// Two modes:
//   1. JWKS verification (BFF_JWKS_URL set):
//      - Lazy-fetch JWKS from auth-svc on first need; cache in-process.
//      - Verify the RS256 signature against the cached JWK matching the
//        token's `kid`. Returns the verified payload on success.
//      - Reject forged signatures, expired tokens, wrong issuer/audience.
//   2. Insecure decode (BFF_JWKS_URL unset — the default for hermetic
//      tests):
//      - Behaves like the Phase 3 shim: base64-decode the payload, no
//        signature check. Documented as test-only.
//
// Production bootstrap: BFF_JWKS_URL=http://auth-svc:8080/.well-known/jwks.json
//
// Key rotation: cache TTL is process lifetime — auth-svc keys are
// ephemeral on restart, so a key rotation requires the BFF to restart
// too. Production swaps to KMS rotation + BFF cache TTL ≤ rotation
// window.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const ISSUER = 'apex-ews-auth';
const AUDIENCE = 'apex-ews';

export interface JwtVerifier {
  /**
   * Verify the token + return the decoded payload. Throws on failure
   * (forged signature, expired, wrong issuer/audience, malformed).
   * Returns undefined when the token is malformed beyond recovery.
   */
  verify(token: string): Promise<JWTPayload | undefined>;
}

/**
 * Verifier that fetches JWKS lazily, caches it, and runs jose.jwtVerify
 * on every call. Use in production / integration testing.
 */
export class JwksVerifier implements JwtVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(jwksUrl: string) {
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
  }

  async verify(token: string): Promise<JWTPayload | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      return payload;
    } catch {
      // Forged sig, expired, malformed, wrong iss/aud — all fold to
      // undefined so callers can react with a uniform 401 / 403.
      return undefined;
    }
  }
}

/**
 * Insecure verifier — base64-decodes the payload without checking the
 * signature. Used when BFF_JWKS_URL is unset (hermetic tests + dev
 * without auth-svc running).
 */
export class InsecureDecodeVerifier implements JwtVerifier {
  async verify(token: string): Promise<JWTPayload | undefined> {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    try {
      const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
      const json = Buffer.from(
        padded.replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString('utf8');
      const obj = JSON.parse(json);
      return typeof obj === 'object' && obj !== null
        ? (obj as JWTPayload)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Build the verifier based on env. `BFF_JWKS_URL` set → secure JWKS
 * verification. Unset → insecure decode (test mode).
 */
export function makeJwtVerifier(env: NodeJS.ProcessEnv = process.env): JwtVerifier {
  const url = env.BFF_JWKS_URL;
  if (url) return new JwksVerifier(url);
  return new InsecureDecodeVerifier();
}
