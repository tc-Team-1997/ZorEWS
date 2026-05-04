import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, className, id, ...rest },
  ref,
) {
  const inputId = id ?? rest.name;
  return (
    <label className="block">
      {label && <span className="label">{label}</span>}
      <input
        ref={ref}
        id={inputId}
        className={cn('input', error && 'border-danger focus:border-danger focus:ring-danger/20', className)}
        {...rest}
      />
      {error && <span className="field-error">{error}</span>}
    </label>
  );
});
