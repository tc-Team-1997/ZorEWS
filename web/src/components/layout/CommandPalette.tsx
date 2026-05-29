// web/src/components/layout/CommandPalette.tsx
//
// Aurora ⌘K command palette — a glass overlay that fuzzy-jumps across every
// nav destination the signed-in user can actually reach. Visibility mirrors
// the sidebar exactly: domain-gated groups + super-admin override + per-item
// RBAC (`visibleItems`). Pure presentational + router navigation — no new
// runtime dep, jsdom-testable, animation gated by prefers-reduced-motion (the
// .aurora-rise class).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, CornerDownLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { NAV_GROUPS, NAV_HOME, visibleItems } from './navConfig';

export interface CommandEntry {
  to: string;
  label: string;
  group: string;
}

/** Flatten the nav schema into the destinations this viewer may reach. */
export function buildCommandEntries(
  t: (key: string) => string,
  roles: ReadonlyArray<string>,
  domain: string | null | undefined,
  isSuperAdmin: boolean,
): CommandEntry[] {
  const out: CommandEntry[] = [
    { to: NAV_HOME.to, label: t(`nav.${NAV_HOME.i18nKey}`), group: '' },
  ];
  const groups = NAV_GROUPS.filter(
    (g) => !g.domain || isSuperAdmin || !domain || g.domain === domain,
  );
  for (const g of groups) {
    const groupLabel = t(`nav.${g.i18nKey}`);
    for (const item of visibleItems(g, roles)) {
      out.push({ to: item.to, label: t(`nav.${item.i18nKey}`), group: groupLabel });
    }
  }
  return out;
}

/** Case-insensitive substring match on label OR path. Empty query → all. */
export function filterCommandEntries(entries: CommandEntry[], query: string): CommandEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.label.toLowerCase().includes(q) || e.to.toLowerCase().includes(q),
  );
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  roles: ReadonlyArray<string>;
  domain: string | null | undefined;
  isSuperAdmin: boolean;
}

export function CommandPalette({ open, onClose, roles, domain, isSuperAdmin }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const entries = useMemo(
    () => buildCommandEntries(t, roles, domain, isSuperAdmin),
    [t, roles, domain, isSuperAdmin],
  );
  const results = useMemo(() => filterCommandEntries(entries, query), [entries, query]);

  // Reset query + focus when the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      // Focus on next tick so the element is mounted.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Keep the highlight in range as results shrink.
  useEffect(() => {
    setHighlight((h) => (results.length === 0 ? 0 : Math.min(h, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (results.length === 0 ? 0 : (h + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (results.length === 0 ? 0 : (h - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = results[highlight];
      if (target) go(target.to);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh] bg-aurora-ink/30 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      data-testid="command-palette"
      onMouseDown={(e) => {
        // Click on the backdrop (not the panel) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass-card aurora-rise w-full max-w-[560px] overflow-hidden p-0 shadow-float">
        <div className="flex items-center gap-2.5 border-b border-aurora-line px-4 py-3">
          <Search size={16} className="text-aurora-indigo shrink-0" strokeWidth={2} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to…"
            aria-label="Search destinations"
            data-testid="command-palette-input"
            className="flex-1 bg-transparent text-[14px] text-aurora-ink placeholder:text-aurora-ink-sub/60 focus:outline-none"
          />
          <kbd className="rounded bg-aurora-tint px-1.5 py-0.5 text-[10px] font-semibold text-aurora-indigo">esc</kbd>
        </div>

        <ul role="listbox" className="max-h-[52vh] overflow-y-auto py-1.5" data-testid="command-palette-results">
          {results.length === 0 && (
            <li
              className="px-4 py-6 text-center text-[13px] text-aurora-ink-sub"
              data-testid="command-palette-empty"
            >
              No destinations match “{query}”.
            </li>
          )}
          {results.map((entry, i) => (
            <li key={entry.to}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                data-testid={`command-option-${entry.to}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => go(entry.to)}
                className={cn(
                  'w-full flex items-center justify-between gap-3 px-4 py-2 text-left transition-colors',
                  i === highlight ? 'bg-aurora-tint' : 'hover:bg-aurora-tint/60',
                )}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={cn(
                      'text-[13px] truncate',
                      i === highlight ? 'text-aurora-indigo font-medium' : 'text-aurora-ink',
                    )}
                  >
                    {entry.label}
                  </span>
                  {entry.group && (
                    <span className="shrink-0 rounded-full bg-aurora-tint px-2 py-0.5 text-[10px] text-aurora-ink-sub">
                      {entry.group}
                    </span>
                  )}
                </span>
                {i === highlight && (
                  <CornerDownLeft size={13} className="text-aurora-indigo shrink-0" strokeWidth={2} aria-hidden="true" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
