// Country selector used by the login + onboarding pages.
//
// Not a vanilla <select>. Drops down into a panel that previews the
// country's currency / timezone / regulatory framework before commit —
// matches the editorial gravitas of the login shell. Closes on outside
// click + Escape, supports keyboard navigation.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Globe2, Check } from 'lucide-react';
import { COUNTRIES, type CountryCode, getCountry } from '@/lib/countries';
import { cn } from '@/lib/cn';

interface Props {
  value: CountryCode | null;
  onChange: (next: CountryCode) => void;
  /** When true, render the danger ring on the trigger. */
  invalid?: boolean;
  /** dark | light surface — switches text + border tone. */
  variant?: 'dark' | 'light';
}

export function CountrySelector({ value, onChange, invalid, variant = 'dark' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = getCountry(value);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isDark = variant === 'dark';

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid ?? false}
        onClick={() => setOpen((o) => !o)}
        data-testid="country-selector-trigger"
        className={cn(
          'w-full h-11 px-3 rounded-input flex items-center gap-2.5 text-left transition-all',
          'border focus:outline-none focus:ring-2 focus:ring-ews-orange/40',
          isDark
            ? 'bg-ews-slate/40 border-ews-line text-ews-warmWhite hover:border-ews-orange/60'
            : 'bg-white border-border text-ink hover:border-action',
          invalid && 'border-danger ring-2 ring-danger/30',
        )}
      >
        {selected ? (
          <>
            <span className="text-base leading-none" aria-hidden>
              {selected.flag}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium truncate">{selected.name}</span>
              <span className={cn('block text-[10.5px] truncate font-mono', isDark ? 'text-ews-warmWhite/55' : 'text-muted')}>
                {selected.currency.code} · {selected.timezone.label}
              </span>
            </span>
          </>
        ) : (
          <>
            <Globe2 size={16} className={isDark ? 'text-ews-warmWhite/50' : 'text-muted'} />
            <span className={cn('flex-1 text-sm', isDark ? 'text-ews-warmWhite/55' : 'text-muted')}>
              Select your country
            </span>
          </>
        )}
        <ChevronDown
          size={16}
          className={cn(
            'transition-transform shrink-0',
            isDark ? 'text-ews-warmWhite/60' : 'text-muted',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Country"
          className={cn(
            'absolute z-50 mt-2 left-0 right-0 max-h-[420px] overflow-y-auto rounded-card shadow-2xl',
            isDark
              ? 'bg-ews-deepNavy border border-ews-line text-ews-warmWhite'
              : 'bg-white border border-border text-ink',
          )}
        >
          <ul className="py-1">
            {COUNTRIES.map((c) => {
              const isActive = c.code === value;
              return (
                <li key={c.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-testid={`country-option-${c.code}`}
                    onClick={() => {
                      onChange(c.code);
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                    className={cn(
                      'w-full px-3 py-2.5 flex items-start gap-3 text-left transition-colors',
                      isDark
                        ? 'hover:bg-ews-slate/60'
                        : 'hover:bg-action-subtle',
                      isActive && (isDark ? 'bg-ews-slate' : 'bg-action-subtle'),
                    )}
                  >
                    <span className="text-lg leading-none mt-0.5" aria-hidden>
                      {c.flag}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{c.name}</span>
                        <span className={cn('font-mono text-[10.5px] tracking-wide', isDark ? 'text-ews-warmWhite/55' : 'text-muted')}>
                          {c.currency.code}
                        </span>
                      </span>
                      <span className={cn('block text-[11px] mt-0.5 truncate', isDark ? 'text-ews-warmWhite/55' : 'text-muted')}>
                        {c.blurb}
                      </span>
                      <span className={cn('block text-[10.5px] mt-0.5 font-mono', isDark ? 'text-ews-warmWhite/45' : 'text-muted/80')}>
                        {c.timezone.label} · {c.date_format}
                      </span>
                    </span>
                    {isActive && (
                      <Check size={14} className="text-ews-orange shrink-0 mt-1" strokeWidth={2.5} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
