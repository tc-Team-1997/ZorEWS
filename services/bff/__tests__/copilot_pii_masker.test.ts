// services/bff/__tests__/copilot_pii_masker.test.ts
//
// Copilot-1 — PII masker tests.

import { hasPII, maskPII } from '../src/copilot/pii_masker';

describe('Copilot-1 — maskPII', () => {
  test('empty input is a no-op', () => {
    expect(maskPII('')).toEqual({ masked: '', hits: [] });
    expect(maskPII(undefined as never)).toEqual({ masked: '', hits: [] });
  });

  test('plain text returns unchanged', () => {
    const out = maskPII('Why is the customer high risk?');
    expect(out.masked).toBe('Why is the customer high risk?');
    expect(out.hits).toEqual([]);
  });

  test('emails masked', () => {
    const out = maskPII('Reach me at jane.doe@bil.example.com please');
    expect(out.masked).toContain('[EMAIL]');
    expect(out.hits).toEqual(['email']);
  });

  test('Indian phone (10 digits, + prefix)', () => {
    const out = maskPII('Call me on +91 9876543210');
    expect(out.masked).toContain('[PHONE]');
    expect(out.hits).toEqual(['phone']);
  });

  test('Indian phone (10 digits, no prefix)', () => {
    const out = maskPII('Number is 9876543210');
    expect(out.hits).toContain('phone');
  });

  test('PAN format', () => {
    const out = maskPII('PAN: ABCDE1234F');
    expect(out.masked).toContain('[PAN]');
    expect(out.hits).toEqual(['pan']);
  });

  test('Aadhaar format with spaces', () => {
    const out = maskPII('Aadhaar 1234 5678 9012');
    expect(out.masked).toContain('[AADHAAR]');
    expect(out.hits).toEqual(['aadhaar']);
  });

  test('Aadhaar format without spaces', () => {
    const out = maskPII('Aadhaar 123456789012');
    expect(out.hits.includes('aadhaar')).toBe(true);
  });

  test('customer ID convention cust-xxx', () => {
    const out = maskPII('Why is cust-001 flagged?');
    expect(out.masked).toContain('[CUSTOMER_ID]');
    expect(out.hits).toEqual(['customer_id']);
  });

  test('account number (long-digit run)', () => {
    const out = maskPII('Account 123456789012345');
    expect(out.masked).toContain('[ACCOUNT]');
    expect(out.hits.includes('account_no')).toBe(true);
  });

  test('multiple PII kinds in one message', () => {
    const out = maskPII(
      'Email jane@bil.com about cust-001 (PAN ABCDE1234F)',
    );
    expect(out.masked).toContain('[EMAIL]');
    expect(out.masked).toContain('[CUSTOMER_ID]');
    expect(out.masked).toContain('[PAN]');
    expect(out.hits.sort()).toEqual(['customer_id', 'email', 'pan']);
  });

  test('order safety: aadhaar masked before account_no swallows it', () => {
    const out = maskPII('Aadhaar 1234 5678 9012 confirmed');
    expect(out.masked).toContain('[AADHAAR]');
    // The 12-digit aadhaar pattern matches first; the 9-18 digit
    // account regex should not also fire on the same digits.
    expect(out.hits).toEqual(['aadhaar']);
  });

  test('case-id-style strings NOT masked (e.g. EWS-2026-00001)', () => {
    const out = maskPII('Looking at case EWS-2026-00001');
    expect(out.masked).toBe('Looking at case EWS-2026-00001');
    expect(out.hits).toEqual([]);
  });

  test('rule-id-style strings NOT masked', () => {
    const out = maskPII('See RULE_CREDIT_001');
    expect(out.masked).toContain('RULE_CREDIT_001');
    expect(out.hits).toEqual([]);
  });

  test('hits sorted alphabetically for stable assertions', () => {
    const out = maskPII('Email a@b.c phone +91 9876543210 cust-x');
    expect(out.hits).toEqual([...out.hits].sort());
  });

  test('hasPII helper', () => {
    expect(hasPII('plain text')).toBe(false);
    expect(hasPII('email a@b.c')).toBe(true);
  });

  test('idempotent: re-masking already-masked text is safe', () => {
    const first = maskPII('cust-001');
    const second = maskPII(first.masked);
    expect(second.masked).toBe('[CUSTOMER_ID]');
  });
});
