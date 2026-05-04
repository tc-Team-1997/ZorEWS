// services/auth-svc/src/totp.ts
//
// TOTP 2FA helpers (T5 Module 1.1 — RFC 6238).
//
// Wraps `otpauth` for code generation/verification and exposes a
// store interface (in-memory + future Pg) for enrolment state. The
// auth-svc routes import this module and never touch otpauth directly.
//
// Lifecycle:
//   1. POST /auth/2fa/setup — server generates a fresh secret, stores
//      it as PENDING. Returns the secret + otpauth URL + QR data so
//      the client can render a QR for the user's authenticator app.
//   2. POST /auth/2fa/verify — user submits the first TOTP code. If
//      it matches, the row is promoted to ENROLLED + 10 backup codes
//      are minted (returned plaintext exactly once). Login flow
//      starts requiring 2FA from the next sign-in.
//   3. Login flow (existing /auth/login + new /auth/login/verify-2fa)
//      runs the verify branch on each sign-in for enrolled users.
//   4. DELETE /auth/2fa — user disables their own 2FA (or admin
//      disables for any user — admin-impersonation-safe via the
//      requireAdmin gate).

import { Secret, TOTP } from "otpauth";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

export interface TotpEnrolment {
  user_id: string;
  secret_base32: string;
  issuer: string;
  algorithm: "SHA1" | "SHA256";
  digits: 6 | 8;
  period_seconds: number;
  enrolled_at: string;
  last_used_at: string | null;
  /** argon2id hashes of the 10 single-use backup codes. */
  backup_code_hashes: string[];
}

export interface I2faStore {
  /** Read by user_id. Returns undefined when not enrolled. */
  get(user_id: string): TotpEnrolment | undefined;
  /** Upsert. Used during enrolment (verify step) + on backup-code consumption. */
  put(enrolment: TotpEnrolment): void;
  /** Remove enrolment row. Idempotent. */
  delete(user_id: string): boolean;
}

/**
 * Pending-enrolment cache — a user who started /auth/2fa/setup but
 * hasn't completed /auth/2fa/verify yet. Lives in process memory with
 * a 10-minute TTL; production stashes this in Redis with the same
 * shape so a load-balanced cluster sees the same secret.
 */
export interface I2faPendingStore {
  put(user_id: string, secret_base32: string, expires_at_ms: number): void;
  get(user_id: string): { secret_base32: string; expires_at_ms: number } | undefined;
  delete(user_id: string): void;
}

export class InMemory2faStore implements I2faStore {
  private rows = new Map<string, TotpEnrolment>();

  get(user_id: string): TotpEnrolment | undefined {
    return this.rows.get(user_id);
  }
  put(e: TotpEnrolment): void {
    this.rows.set(e.user_id, e);
  }
  delete(user_id: string): boolean {
    return this.rows.delete(user_id);
  }
}

export class InMemory2faPendingStore implements I2faPendingStore {
  private rows = new Map<string, { secret_base32: string; expires_at_ms: number }>();

  put(user_id: string, secret_base32: string, expires_at_ms: number): void {
    this.rows.set(user_id, { secret_base32, expires_at_ms });
  }
  get(user_id: string) {
    const r = this.rows.get(user_id);
    if (!r) return undefined;
    if (r.expires_at_ms < Date.now()) {
      this.rows.delete(user_id);
      return undefined;
    }
    return r;
  }
  delete(user_id: string): void {
    this.rows.delete(user_id);
  }
}

const ISSUER = "APEX EWS";
const PERIOD_S = 30;
const DIGITS = 6;
const ALGORITHM: "SHA1" = "SHA1"; // widest authenticator-app compat

/** RFC 6238 — generate a fresh 20-byte secret, base32-encoded. */
export function generateSecret(): string {
  // otpauth's Secret.fromRandom() is good but constructs an internal
  // class; we want raw base32 we can put on the wire + store. 20 bytes
  // → 160 bits, the default for SHA1 TOTP.
  const bytes = randomBytes(20);
  return new Secret({ buffer: bytes }).base32;
}

/** Build the otpauth:// URL the QR encoder consumes. */
export function buildOtpauthUrl(opts: {
  username: string;
  secret_base32: string;
  issuer?: string;
}): string {
  return new TOTP({
    issuer: opts.issuer ?? ISSUER,
    label: opts.username,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_S,
    secret: Secret.fromBase32(opts.secret_base32),
  }).toString();
}

/**
 * Verify a 6-digit TOTP code against a secret. Allows ±1 step (30s)
 * of clock drift — the standard tolerance.
 *
 * Returns true when the code matches, false otherwise. Constant-time
 * inside otpauth (it uses a delta-walk; the upper bound on iterations
 * is fixed regardless of input).
 */
export function verifyCode(secret_base32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD_S,
    secret: Secret.fromBase32(secret_base32),
  });
  // window=1 → check current step + previous + next (covers ±30s drift).
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

/**
 * Generate 10 single-use backup codes. Plaintext form is shown to the
 * user once; we store argon2id hashes. Each code is 10 hex chars
 * (40 bits — collision-resistant enough for one-time codes).
 */
export async function mintBackupCodes(): Promise<{ plaintext: string[]; hashes: string[] }> {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < 10; i++) {
    // 5 bytes → 10 hex chars. Avoid ambiguous chars by formatting.
    const code = randomBytes(5).toString("hex");
    plaintext.push(code);
    // eslint-disable-next-line no-await-in-loop
    hashes.push(await argon2.hash(code, { type: argon2.argon2id }));
  }
  return { plaintext, hashes };
}

/**
 * Verify a backup code against the stored hashes. On a successful
 * match the matched hash is REMOVED from the array (single-use). Returns
 * the new hashes array on success, undefined on no match.
 *
 * Caller is responsible for persisting the returned array back to the
 * store so the consumed code can't be replayed.
 */
export async function consumeBackupCode(
  hashes: readonly string[],
  candidate: string,
): Promise<string[] | undefined> {
  for (let i = 0; i < hashes.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (await argon2.verify(hashes[i]!, candidate)) {
      const next = hashes.slice();
      next.splice(i, 1);
      return next;
    }
  }
  return undefined;
}

// ─── Module-level singletons (lazy) ────────────────────────────────────

let store: I2faStore | undefined;
let pending: I2faPendingStore | undefined;

export function get2faStore(): I2faStore {
  if (!store) store = new InMemory2faStore();
  return store;
}

export function get2faPendingStore(): I2faPendingStore {
  if (!pending) pending = new InMemory2faPendingStore();
  return pending;
}

/** Test helpers — drop the cached singletons so each test starts clean. */
export function __reset2faForTests(): void {
  store = undefined;
  pending = undefined;
}
