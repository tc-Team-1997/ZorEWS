// Preview modal for a notification template (T6 M14.24b).
// Lets the admin enter mustache vars and see the rendered subject +
// body live, with a "missing vars" warning row when applicable. Pure
// render — no side effect.
//
// Flow:
//   1. The user clicks Preview on a template row → this modal opens.
//   2. The modal autodetects mustache tokens in the template's subject
//      + body and shows an input for each one (so the admin doesn't
//      have to remember them).
//   3. Live re-render via the BFF /preview route on debounce; results
//      populate the right pane.

import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Eye, X } from 'lucide-react';
import { Button } from '@/components/ui';
import {
  api,
  type NotificationRenderResult,
  type NotificationTemplateRow,
} from '@/lib/api';

interface Props {
  template: NotificationTemplateRow;
  onClose: () => void;
}

const TOKEN_RE =
  /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*default:\s*"([^"]*)"\s*)?\}\}/g;

/** Pull the distinct mustache var names + their inline defaults out of
 *  subject + body so the modal can pre-populate the input rows. */
function extractTokens(template: NotificationTemplateRow): Array<{ name: string; default: string }> {
  const out = new Map<string, string>();
  for (const text of [template.subject ?? '', template.body]) {
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      const name = m[1];
      const def = m[2] ?? '';
      if (!out.has(name)) out.set(name, def);
    }
  }
  return [...out.entries()].map(([name, def]) => ({ name, default: def }));
}

export function NotificationTemplatePreviewModal({ template, onClose }: Props) {
  const tokens = useMemo(() => extractTokens(template), [template]);
  const [vars, setVars] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const t of tokens) init[t.name] = '';
    return init;
  });
  const [debouncedVars, setDebouncedVars] = useState(vars);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounce var input → re-render every 300ms instead of every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedVars(vars), 300);
    return () => clearTimeout(t);
  }, [vars]);

  const preview = useMutation({
    mutationFn: (varsToSend: Record<string, unknown>) =>
      api.notificationTemplatePreview(template.template_id, varsToSend),
  });

  // Re-render whenever debounced vars change
  useEffect(() => {
    preview.mutate(debouncedVars);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedVars]);

  const result: NotificationRenderResult | undefined = preview.data;
  const errMsg =
    preview.error instanceof Error ? preview.error.message : null;

  return (
    <div
      role="dialog"
      aria-label={`Preview — ${template.name}`}
      data-testid="notification-template-preview-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Eye size={16} /> Preview — <span className="font-normal text-muted">{template.name}</span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[280px_1fr]">
          {/* ── Variables (left pane) ── */}
          <div>
            <h4 className="mb-2 text-2xs font-semibold uppercase text-slate-500">
              Variables ({tokens.length})
            </h4>
            {tokens.length === 0 ? (
              <p className="text-2xs italic text-muted">
                This template has no mustache placeholders.
              </p>
            ) : (
              <div className="space-y-2">
                {tokens.map((t) => (
                  <label key={t.name} className="block">
                    <span className="mb-0.5 block font-mono text-2xs text-slate-600">
                      {t.name}
                      {t.default && (
                        <span className="ml-1 normal-case text-muted">
                          (default: <em>{t.default}</em>)
                        </span>
                      )}
                    </span>
                    <input
                      value={vars[t.name] ?? ''}
                      onChange={(e) =>
                        setVars((prev) => ({ ...prev, [t.name]: e.target.value }))
                      }
                      placeholder={t.default || `value for ${t.name}`}
                      className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      data-testid={`preview-var-${t.name}`}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* ── Rendered output (right pane) ── */}
          <div>
            <h4 className="mb-2 text-2xs font-semibold uppercase text-slate-500">
              Rendered output
            </h4>
            {errMsg && (
              <div className="mb-2 rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" role="alert">
                {errMsg}
              </div>
            )}
            {result?.missing_vars && result.missing_vars.length > 0 && (
              <div
                className="mb-2 rounded bg-amber-50 px-2 py-1.5 text-2xs text-amber-700"
                data-testid="preview-missing-vars"
              >
                Missing: <span className="font-mono">{result.missing_vars.join(', ')}</span>
              </div>
            )}
            {template.subject !== null && (
              <div className="mb-2">
                <div className="text-2xs font-semibold uppercase text-slate-500">Subject</div>
                <div
                  className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
                  data-testid="preview-subject"
                >
                  {result?.subject ?? template.subject}
                </div>
              </div>
            )}
            <div>
              <div className="text-2xs font-semibold uppercase text-slate-500">Body</div>
              <pre
                className="whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-sans text-sm"
                data-testid="preview-body"
              >
                {result?.body ?? template.body}
              </pre>
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
