// MFA-ready seam — asserts the placeholder is a no-op today + that the
// pure parser reads the auth-svc challenge shape correctly (so the seam is
// ready to consume when the OTP UI ships).

import { describe, test, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseMfaChallenge, useMfaGate, MFA_ENABLED } from '@/lib/useMfaGate';

describe('parseMfaChallenge — pure reader', () => {
  test('returns a challenge for a 2FA-required response', () => {
    const c = parseMfaChallenge({ requires_2fa: true, partial_token: 'pt-abc', expires_in: 300 });
    expect(c).toEqual({ requires_2fa: true, partial_token: 'pt-abc', expires_in: 300 });
  });

  test('defaults expires_in to 300 when missing/invalid', () => {
    expect(parseMfaChallenge({ requires_2fa: true, partial_token: 'pt' })?.expires_in).toBe(300);
  });

  test('returns null for a normal token issuance', () => {
    expect(parseMfaChallenge({ access_token: 'a', refresh_token: 'r' })).toBeNull();
  });

  test('returns null on requires_2fa without a partial_token', () => {
    expect(parseMfaChallenge({ requires_2fa: true })).toBeNull();
  });

  test('returns null on non-object input', () => {
    expect(parseMfaChallenge(null)).toBeNull();
    expect(parseMfaChallenge(undefined)).toBeNull();
    expect(parseMfaChallenge('x')).toBeNull();
  });
});

describe('useMfaGate — placeholder seam (no OTP UI yet)', () => {
  test('MFA_ENABLED is false until the OTP step ships', () => {
    expect(MFA_ENABLED).toBe(false);
  });

  test('reports not-pending even for a 2FA-required response (no-op today)', () => {
    const { result } = renderHook(() =>
      useMfaGate({ requires_2fa: true, partial_token: 'pt', expires_in: 300 }),
    );
    expect(result.current.pending).toBe(false);
    expect(result.current.challenge).toBeNull();
    expect(result.current.enabled).toBe(false);
  });

  test('reports not-pending for a normal login response', () => {
    const { result } = renderHook(() => useMfaGate({ access_token: 'a' }));
    expect(result.current.pending).toBe(false);
  });
});
