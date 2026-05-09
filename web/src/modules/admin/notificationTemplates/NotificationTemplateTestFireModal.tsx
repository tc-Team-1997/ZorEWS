// Test-fire modal (T6 M14.24b). Same vars input as Preview but adds:
//   - recipient field (required — admin types an email/phone for log)
//   - reference field (optional — e.g. "case:c-001" for log pivot)
//   - refuse_when_missing checkbox (when ticked, the BFF returns 422
//     instead of dispatching when missing vars are detected)
// On success, shows the dispatch entry id + recorded status so the
// admin can immediately verify it landed in the dispatches log.

import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Send, X } from 'lucide-react';
import { Badge, Button, type BadgeTone } from '@/components/ui';
import {
  api,
  type NotificationDispatchEntry,
  type NotificationRenderResult,
  type NotificationTemplateRow,
} from '@/lib/api';

interface Props {
  template: NotificationTemplateRow;
  onClose: () => void;
  /** Optional — if the parent wants a refresh after a successful dispatch. */
  onSent?: (entry: NotificationDispatchEntry) => void;
}

const TOKEN_RE =
  /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*default:\s*"([^"]*)"\s*)?\}\}/g;

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

const STATUS_TONE: Record<NotificationDispatchEntry['status'], BadgeTone> = {
  sent: 'success',
  preview: 'neutral',
  failed: 'danger',
};

export function NotificationTemplateTestFireModal({ template, onClose, onSent }: Props) {
  const tokens = useMemo(() => extractTokens(template), [template]);
  const [vars, setVars] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const t of tokens) init[t.name] = '';
    return init;
  });
  const [recipient, setRecipient] = useState('');
  const [reference, setReference] = useState('');
  const [refuseMissing, setRefuseMissing] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fire = useMutation({
    mutationFn: () =>
      api.notificationTemplateTestFire(template.template_id, {
        vars,
        recipient: recipient.trim(),
        reference: reference.trim() || null,
        refuse_when_missing: refuseMissing,
      }),
    onSuccess: (data) => {
      onSent?.(data.dispatch);
    },
  });

  const submit = () => {
    setValidation(null);
    if (!recipient.trim()) return setValidation('Recipient is required');
    if (recipient.length > 200) return setValidation('Recipient max 200 chars');
    fire.mutate();
  };

  const result: NotificationRenderResult | undefined = fire.data?.rendered;
  const dispatch: NotificationDispatchEntry | undefined = fire.data?.dispatch;
  const errMsg =
    fire.error instanceof Error ? fire.error.message : null;

  return (
    <div
      role="dialog"
      aria-label={`Test fire — ${template.name}`}
      data-testid="notification-template-test-fire-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Send size={16} /> Test fire — <span className="font-normal text-muted">{template.name}</span>
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
          {/* ── Inputs (left pane) ── */}
          <div className="space-y-2">
            <label className="block">
              <span className="mb-0.5 block text-2xs font-semibold uppercase text-slate-500">
                Recipient (required)
              </span>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder={template.channel === 'EMAIL' ? 'alice@bank.com' : '+91 ...'}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                data-testid="testfire-recipient"
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-2xs font-semibold uppercase text-slate-500">
                Reference (optional)
              </span>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="case:c-001"
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                data-testid="testfire-reference"
              />
              <span className="mt-0.5 block text-2xs text-muted">
                Lets you pivot from a case to all its dispatches in the log.
              </span>
            </label>
            <label className="flex items-center gap-1.5 text-2xs">
              <input
                type="checkbox"
                checked={refuseMissing}
                onChange={(e) => setRefuseMissing(e.target.checked)}
                data-testid="testfire-refuse-missing"
              />
              Refuse to send if any var is missing
            </label>
            <hr className="my-2 border-slate-200" />
            <h4 className="text-2xs font-semibold uppercase text-slate-500">
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
                      data-testid={`testfire-var-${t.name}`}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* ── Result (right pane) ── */}
          <div>
            {!fire.isSuccess && !fire.isError && (
              <p className="py-8 text-center text-2xs italic text-muted">
                Fill in the recipient + variables on the left, then click
                <strong className="px-1">Send test</strong>.
              </p>
            )}
            {validation && (
              <div className="mb-2 rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" data-testid="testfire-validation">
                {validation}
              </div>
            )}
            {errMsg && (
              <div className="mb-2 rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" data-testid="testfire-error">
                {errMsg}
              </div>
            )}
            {dispatch && (
              <div
                className="mb-3 flex items-center gap-2 rounded bg-emerald-50 px-2 py-1.5 text-2xs text-emerald-700"
                data-testid="testfire-dispatch-confirm"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Logged dispatch <span className="font-mono">{dispatch.dispatch_id.slice(0, 16)}…</span>
                <Badge tone={STATUS_TONE[dispatch.status]} className="text-2xs uppercase">
                  {dispatch.status}
                </Badge>
              </div>
            )}
            {result?.missing_vars && result.missing_vars.length > 0 && (
              <div
                className="mb-2 rounded bg-amber-50 px-2 py-1.5 text-2xs text-amber-700"
                data-testid="testfire-missing-vars"
              >
                Missing: <span className="font-mono">{result.missing_vars.join(', ')}</span>
              </div>
            )}
            {result && template.subject !== null && (
              <div className="mb-2">
                <div className="text-2xs font-semibold uppercase text-slate-500">Subject</div>
                <div
                  className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
                  data-testid="testfire-subject"
                >
                  {result.subject}
                </div>
              </div>
            )}
            {result && (
              <div>
                <div className="text-2xs font-semibold uppercase text-slate-500">Body</div>
                <pre
                  className="whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-sans text-sm"
                  data-testid="testfire-body"
                >
                  {result.body}
                </pre>
              </div>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={submit} disabled={fire.isPending} data-testid="testfire-send">
            <Send className="mr-1 h-3 w-3" /> Send test
          </Button>
        </div>
      </div>
    </div>
  );
}
