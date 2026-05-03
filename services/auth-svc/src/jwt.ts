import { SignJWT, jwtVerify, generateKeyPair, type KeyLike } from "jose";

/**
 * Production:
 *   The JWT signing key never leaves AWS KMS. We use the asymmetric KMS key
 *   `alias/apex-ews-secret` (RSA_2048) and call kms:Sign / kms:Verify via
 *   `@aws-sdk/client-kms` with IRSA. The token's `kid` header is the KMS key
 *   alias, so verifiers fetch the public key from KMS and cache it.
 *
 * Local dev (this file):
 *   We generate an in-memory RS256 keypair on boot. Same JWT shape, same
 *   `kid` semantics. To switch to real KMS, replace `loadSigner()` with a
 *   `KMSSigner` that delegates `.sign()` to KMS. The route layer is unchanged.
 */

const ISSUER = "apex-ews-auth";
const AUDIENCE = "apex-ews";

export interface Signer {
  kid: string;
  privateKey: KeyLike;
  publicKey: KeyLike;
}

export async function loadSigner(): Promise<Signer> {
  // Local-dev: ephemeral RS256 keypair. In production, replace this function
  // with a KMSSigner that calls kms:Sign on `alias/apex-ews-secret` (asymmetric
  // RSA_2048) and caches the public key from kms:GetPublicKey.
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  return { kid: "alias/apex-ews-secret", privateKey, publicKey };
}

export async function signAccessToken(
  signer: Signer,
  claims: { sub: string; role: string; display_name: string; sid?: string; tenant_id?: string },
  ttlSeconds = 900,
): Promise<string> {
  // `sid` ties the token to a server-side session record so the user (or
  // an admin) can revoke it before its natural expiry. Optional so the
  // signer is still callable in unit tests that don't care about sessions.
  // `tenant_id` (T4.24 Phase 3) lets resource servers verify that
  // X-Tenant-ID matches the user's home tenant — defense in depth against
  // a valid user setting a foreign tenant in the header.
  const payload: Record<string, unknown> = {
    role: claims.role,
    display_name: claims.display_name,
  };
  if (claims.sid) payload.sid = claims.sid;
  if (claims.tenant_id) payload.tenant_id = claims.tenant_id;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: signer.kid })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(signer.privateKey);
}

export async function signRefreshToken(
  signer: Signer,
  sub: string,
  sid?: string,
  ttlSeconds = 60 * 60 * 24 * 7,
): Promise<string> {
  const payload: Record<string, unknown> = { typ: "refresh" };
  if (sid) payload.sid = sid;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: signer.kid })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(signer.privateKey);
}

export async function verifyToken(signer: Signer, token: string) {
  return jwtVerify(token, signer.publicKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}
