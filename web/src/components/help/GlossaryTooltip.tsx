// web/src/components/help/GlossaryTooltip.tsx
//
// M6.4 — Glossary tooltip helper.
//
// Anywhere in the SPA, render `<GlossaryTooltip term_id="npa" />` next to a label
// to expose the canonical definition from `/v1/glossary/terms/:term_id`.
//
// Acceptance gate (M6.4 spec): "'?' tooltip in any screen pulls definition from
// glossary." This component closes that loop — every "?" in the SPA goes through
// here, single source-of-truth for term definitions.

import { useQuery } from '@tanstack/react-query';
import { useState, useRef, useEffect } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';

export interface GlossaryTooltipProps {
  /** term_id from `/v1/glossary/terms` (e.g. "npa", "shap", "dpd") */
  term_id: string;
  /** Optional override of the inline label; default uses the canonical `term`. */
  label?: string;
  /** Optional testId for jest selectors */
  testId?: string;
}

export function GlossaryTooltip({ term_id, label, testId }: GlossaryTooltipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Defer the network call until first hover/click — keeps page loads cheap.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['glossary-term', term_id],
    queryFn: () => api.glossaryGet(term_id),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  // Outside-click closes the panel.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <span
      ref={ref}
      className="relative inline-block"
      data-testid={testId ?? `glossary-tooltip-${term_id}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-action focus:outline-none focus-visible:ring-2 focus-visible:ring-action rounded"
        aria-label={`Glossary: ${label ?? term_id}`}
        data-testid={`glossary-tooltip-btn-${term_id}`}
      >
        {label ? <span className="underline decoration-dotted">{label}</span> : null}
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="absolute z-50 mt-2 w-80 rounded border border-divider bg-surface shadow-lg p-3 text-left text-xs"
          role="tooltip"
          data-testid={`glossary-tooltip-panel-${term_id}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="font-semibold text-ink">
              {isLoading ? 'Loading…' : isError ? term_id : data?.term ?? term_id}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-ink-muted hover:text-ink"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-1 text-ink-muted whitespace-pre-wrap">
            {isLoading
              ? 'Looking up the glossary…'
              : isError
                ? 'Definition unavailable.'
                : data?.definition ?? ''}
          </div>
          {data?.source_doc && (
            <div className="mt-2 text-[10px] uppercase tracking-wide text-ink-muted">
              Source: {data.source_doc}
            </div>
          )}
          <div className="mt-2 border-t border-divider pt-2">
            <Link
              to={`/glossary?focus=${encodeURIComponent(term_id)}`}
              className="text-action hover:underline"
              onClick={() => setOpen(false)}
            >
              Open in Glossary →
            </Link>
          </div>
        </div>
      )}
    </span>
  );
}
