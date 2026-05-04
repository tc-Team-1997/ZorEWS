/**
 * Compact 4-bar password-strength meter. Pure / stateless — pass the
 * current password value, get a render. Ratings track the backend's
 * complexity gate (≥8 chars, lower, upper, digit-or-symbol) plus a
 * "long" bonus at 12+ chars.
 *
 * Strength levels:
 *   0 — empty
 *   1 — weak     (fewer than 3 of {lower, upper, digit, symbol})
 *   2 — fair     (3 of 4 categories OR all 4 but <8 chars)
 *   3 — strong   (all 4 categories + ≥8 chars)
 *   4 — very strong (above + ≥12 chars)
 */
export interface PasswordStrengthProps {
  password: string;
  /** Hidden until non-empty — surfaces a useful hint without taking
   *  layout space on the empty form. */
  className?: string;
}

const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;
const HAS_SYMBOL = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/;

export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!pw) return { score: 0, label: 'Empty' };
  const cats = [HAS_LOWER, HAS_UPPER, HAS_DIGIT, HAS_SYMBOL].reduce(
    (n, re) => n + (re.test(pw) ? 1 : 0),
    0,
  );
  if (cats < 3 || pw.length < 8) return { score: 1, label: 'Weak' };
  if (cats === 3 || pw.length < 12) return { score: 2, label: 'Fair' };
  if (pw.length < 16) return { score: 3, label: 'Strong' };
  return { score: 4, label: 'Very strong' };
}

const TONES: Record<0 | 1 | 2 | 3 | 4, { bar: string; text: string }> = {
  0: { bar: 'bg-divider', text: 'text-muted' },
  1: { bar: 'bg-danger', text: 'text-danger' },
  2: { bar: 'bg-amber-500', text: 'text-amber-700' },
  3: { bar: 'bg-success', text: 'text-success' },
  4: { bar: 'bg-success', text: 'text-success' },
};

export function PasswordStrength({ password, className = '' }: PasswordStrengthProps) {
  if (!password) return null;
  const { score, label } = passwordStrength(password);
  const tone = TONES[score];

  return (
    <div data-testid="password-strength" className={`flex items-center gap-2 ${className}`}>
      <div className="flex gap-1 flex-1" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <div
            key={n}
            className={`h-1 flex-1 rounded ${n <= score ? tone.bar : 'bg-divider'}`}
          />
        ))}
      </div>
      <span
        className={`text-[11px] font-medium tabular-nums shrink-0 ${tone.text}`}
        data-testid="password-strength-label"
        role="status"
        aria-live="polite"
      >
        {label}
      </span>
    </div>
  );
}
