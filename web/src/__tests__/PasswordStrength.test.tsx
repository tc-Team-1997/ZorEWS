import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PasswordStrength, passwordStrength } from '@/components/ui/PasswordStrength';

describe('passwordStrength', () => {
  it('returns score 0 / "Empty" for empty input', () => {
    expect(passwordStrength('')).toEqual({ score: 0, label: 'Empty' });
  });

  it('rates "abc" as weak (single category, too short)', () => {
    expect(passwordStrength('abc').score).toBe(1);
  });

  it('rates "Abcd1234" as fair (all 3 of lower+upper+digit, 8 chars)', () => {
    const r = passwordStrength('Abcd1234');
    // 3 categories + length 8: still flagged at "Fair" not "Strong"
    // because we want length ≥ 12 for the "Strong" tier.
    expect(r.score).toBe(2);
    expect(r.label).toBe('Fair');
  });

  it('rates "Abcdef1!" as fair (4 categories but <12 chars)', () => {
    expect(passwordStrength('Abcdef1!').score).toBe(2);
  });

  it('rates "Abcdef!ghij1" as strong (4 cats + ≥12 chars)', () => {
    const r = passwordStrength('Abcdef!ghij1');
    expect(r.score).toBe(3);
    expect(r.label).toBe('Strong');
  });

  it('rates a 16+ char passphrase with all categories as very strong', () => {
    const r = passwordStrength('Abcdef!ghij1Klmno');
    expect(r.score).toBe(4);
    expect(r.label).toBe('Very strong');
  });
});

describe('PasswordStrength component', () => {
  it('renders nothing when password is empty', () => {
    const { container } = render(<PasswordStrength password="" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the strength label when password is non-empty', () => {
    render(<PasswordStrength password="Abcdef!ghij1Klmno" />);
    expect(screen.getByTestId('password-strength')).toBeInTheDocument();
    expect(screen.getByTestId('password-strength-label')).toHaveTextContent('Very strong');
  });
});
