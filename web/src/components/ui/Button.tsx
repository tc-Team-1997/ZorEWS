import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-input font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

// Aurora premium button variants — consistent 4-variant system per spec
// (Primary / Secondary / Ghost / Danger), aurora-indigo accent, soft shadows,
// indigo focus ring. JSX class names (NOT @apply in CSS) so the aurora-* JIT
// race that bit P0d cannot recur here.
const variants: Record<Variant, string> = {
  primary:   'bg-aurora-indigo text-white shadow-sm hover:bg-aurora-violet focus:outline-none focus:ring-2 focus:ring-aurora-indigo/40 focus:ring-offset-1',
  secondary: 'bg-aurora-tint text-aurora-indigo border border-aurora-line hover:bg-[#DCE4FF] focus:outline-none focus:ring-2 focus:ring-aurora-indigo/30',
  ghost:     'bg-white border border-aurora-line text-aurora-ink-sub hover:bg-aurora-tint/60 hover:text-aurora-ink focus:outline-none focus:ring-2 focus:ring-aurora-indigo/30',
  danger:    'bg-danger text-white shadow-sm hover:bg-[#c73b3a] focus:outline-none focus:ring-2 focus:ring-danger/40',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled ?? loading}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {loading ? <span className="animate-pulse">…</span> : children}
    </button>
  );
});
