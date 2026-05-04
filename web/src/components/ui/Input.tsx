import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, className, id, type, ...rest },
  ref,
) {
  const inputId = id ?? rest.name;
  // Show/hide affordance for password fields. Native <input type="password">
  // hides characters; clicking the eye icon flips the rendered type to
  // "text" so the user can verify what they typed without re-entering.
  // Only enabled when the consumer declared `type="password"` — other
  // inputs render as before.
  const isPassword = type === 'password';
  const [reveal, setReveal] = useState(false);
  const renderedType = isPassword && reveal ? 'text' : type;

  return (
    <label className="block">
      {label && <span className="label">{label}</span>}
      <div className={cn('relative', isPassword && 'flex items-stretch')}>
        <input
          ref={ref}
          id={inputId}
          type={renderedType}
          className={cn(
            'input',
            isPassword && 'pr-10',
            error && 'border-danger focus:border-danger focus:ring-danger/20',
            className,
          )}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? 'Hide password' : 'Show password'}
            aria-pressed={reveal}
            data-testid={`reveal-${inputId ?? 'password'}`}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 rounded text-muted hover:text-ink hover:bg-divider/40 focus:outline-none focus:ring-2 focus:ring-action/40 transition-colors"
          >
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
      {error && <span className="field-error">{error}</span>}
    </label>
  );
});
