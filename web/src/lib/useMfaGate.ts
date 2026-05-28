// MFA-ready seam (placeholder — NO OTP UI / NO API by design).
//
// The auth-svc already issues the full TOTP 2FA flow: a 2FA-enrolled
// account's POST /auth/login returns `{ requires_2fa, partial_token,
// expires_in }` instead of the token pair, and POST /auth/login/verify-2fa
// completes the exchange. This module is the FRONTEND seam that a future
// OTP step plugs into — it is deliberately a no-op today:
//
//   - `MFA_ENABLED` is false, so `useMfaGate()` always reports not-pending.
//   - `parseMfaChallenge()` is a pure reader of the auth-svc response shape.
//
// When the OTP screen is built later: flip `MFA_ENABLED`, branch the login
// store on `parseMfaChallenge(response)`, and render an OTP card that calls
// `/auth/login/verify-2fa` with `partial_token` + the code. Nothing here
// changes the current login behaviour — the login card stays untouched.

import { useMemo } from 'react';

/** Shape the auth-svc returns when an account has 2FA enrolled. */
export interface MfaChallenge {
  /** Always true on the challenge branch — the credential step passed but
   *  a second factor is required before tokens are issued. */
  requires_2fa: true;
  /** Short-lived RS256 JWT (typ '2fa_partial') exchanged at verify-2fa. */
  partial_token: string;
  /** Seconds until the partial token expires (auth-svc default 300). */
  expires_in: number;
}

/** Feature flag for the OTP step. Kept false until the OTP UI ships —
 *  matches the explicit "build MFA-ready, do NOT implement OTP yet" scope. */
export const MFA_ENABLED = false;

/**
 * Pure reader: extract an MfaChallenge from a login response, or null when
 * the response is a normal token issuance. Safe to call on any object.
 */
export function parseMfaChallenge(response: unknown): MfaChallenge | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  if (r.requires_2fa !== true) return null;
  if (typeof r.partial_token !== 'string' || r.partial_token.length === 0) return null;
  const expires = typeof r.expires_in === 'number' && Number.isFinite(r.expires_in) ? r.expires_in : 300;
  return { requires_2fa: true, partial_token: r.partial_token, expires_in: expires };
}

export interface MfaGateState {
  /** Whether an OTP step is required + active. Always false while the OTP
   *  UI is unimplemented (`MFA_ENABLED === false`). */
  pending: boolean;
  /** The active challenge, when one is being handled. Null today. */
  challenge: MfaChallenge | null;
  /** True when the OTP feature has been turned on. Lets callers render the
   *  seam conditionally without importing the flag directly. */
  enabled: boolean;
}

/**
 * MFA gate hook — the integration point for a future OTP step. Today it is
 * a no-op: returns `pending: false` regardless of input, so the login flow
 * behaves exactly as it does now. Pass the latest login response so that,
 * once `MFA_ENABLED` flips, this begins reporting a pending challenge with
 * zero call-site churn.
 */
export function useMfaGate(loginResponse?: unknown): MfaGateState {
  return useMemo(() => {
    const challenge = MFA_ENABLED ? parseMfaChallenge(loginResponse) : null;
    return {
      pending: challenge !== null,
      challenge,
      enabled: MFA_ENABLED,
    };
  }, [loginResponse]);
}
