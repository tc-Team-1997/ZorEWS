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
// (Primary / Secondary / Ghost / Danger). Uses Tailwind BUILT-IN palette
// classes (indigo-500/violet-600/indigo-50/slate-*) instead of the nested
// `aurora-*` theme group — the built-ins generate EXACT same hex values
// (indigo-500 = #6366F1 = aurora.indigo, violet-600 = #7C3AED = aurora.violet,
// indigo-50 = #EEF2FF = aurora.tint, slate-900 = #0F172A = aurora.ink,
// slate-700 = #334155 = aurora.ink-sub) but are GUARANTEED to be in any
// Tailwind output even if the JIT cache or vite dev pipeline ever races
// the nested-aurora utilities (which is what made the primary button render
// invisible on the user's localhost — fix for that visible-on-2026-05-30 bug).
const variants: Record<Variant, string> = {
  primary:   'bg-indigo-500 text-white shadow-sm hover:bg-violet-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:ring-offset-1',
  secondary: 'bg-indigo-50 text-indigo-600 border border-slate-200 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30',
  ghost:     'bg-white border border-slate-200 text-slate-700 hover:bg-indigo-50 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/30',
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
