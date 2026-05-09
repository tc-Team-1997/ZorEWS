// Shared modal for create + edit. Distinguished by `mode`:
//   'create' — channel + locale fully editable
//   'edit'   — channel + locale frozen (FK + DB unique constraints)

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui';
import type {
  NotificationChannel,
  NotificationTemplateCreateInput,
  NotificationTemplateRow,
  NotificationTemplateUpdateInput,
} from '@/lib/api';

const CHANNELS: NotificationChannel[] = ['EMAIL', 'SMS', 'IN_APP'];

interface PropsCreate {
  mode: 'create';
  existing: ReadonlyArray<NotificationTemplateRow>;
  onClose: () => void;
  onSubmit: (input: NotificationTemplateCreateInput) => void;
  isPending: boolean;
  error: unknown;
}
interface PropsEdit {
  mode: 'edit';
  row: NotificationTemplateRow;
  onClose: () => void;
  onSubmit: (patch: NotificationTemplateUpdateInput) => void;
  isPending: boolean;
  error: unknown;
}
type Props = PropsCreate | PropsEdit;

export function NotificationTemplateFormModal(props: Props) {
  const isEdit = props.mode === 'edit';
  const initial = isEdit ? props.row : null;

  const [name, setName] = useState(initial?.name ?? '');
  const [channel, setChannel] = useState<NotificationChannel>(initial?.channel ?? 'EMAIL');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [locale, setLocale] = useState(initial?.locale ?? 'en-IN');
  const [validation, setValidation] = useState<string | null>(null);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  // SMS forces subject to null (DB CHECK)
  useEffect(() => {
    if (channel === 'SMS' && subject !== '') setSubject('');
  }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const dupHint = useMemo(() => {
    if (isEdit) return null;
    const target = name.trim().toLowerCase();
    if (!target) return null;
    const ex = (props as PropsCreate).existing.find(
      (r) => r.deleted_at === null && r.name.toLowerCase() === target && r.locale === locale,
    );
    return ex
      ? `Already used in locale ${locale} (${ex.status.toLowerCase()}). Pick a different name or change locale.`
      : null;
  }, [isEdit, props, name, locale]);

  const submit = () => {
    setValidation(null);
    if (!name.trim()) {
      setValidation('Name is required');
      return;
    }
    if (name.trim().length > 120) {
      setValidation('Name max 120 chars');
      return;
    }
    if (channel !== 'SMS' && !subject.trim()) {
      setValidation(`Subject required for ${channel} channel`);
      return;
    }
    if (channel !== 'SMS' && subject.trim().length > 200) {
      setValidation('Subject max 200 chars');
      return;
    }
    if (!body.trim() || body.length > 10000) {
      setValidation('Body length must be 1..10000');
      return;
    }
    if (isEdit) {
      const patch: NotificationTemplateUpdateInput = {};
      const r = (props as PropsEdit).row;
      if (name.trim() !== r.name) patch.name = name.trim();
      if (channel !== 'SMS') {
        const newSubject = subject.trim();
        if (newSubject !== (r.subject ?? '')) patch.subject = newSubject;
      }
      if (body !== r.body) patch.body = body;
      if (locale !== r.locale) patch.locale = locale;
      if (Object.keys(patch).length === 0) {
        setValidation('No changes to save');
        return;
      }
      (props as PropsEdit).onSubmit(patch);
      return;
    }
    if (dupHint) {
      setValidation(dupHint);
      return;
    }
    (props as PropsCreate).onSubmit({
      name: name.trim(),
      channel,
      subject: channel === 'SMS' ? null : subject.trim(),
      body,
      locale,
    });
  };

  const errMsg =
    props.error instanceof Error
      ? props.error.message
      : props.error
        ? String(props.error)
        : null;

  return (
    <div
      role="dialog"
      aria-label={isEdit ? 'Edit notification template' : 'Create notification template'}
      data-testid="notification-template-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={props.onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-base font-semibold">
            {isEdit ? 'Edit template' : 'New notification template'}
          </h3>
          <button
            type="button"
            onClick={props.onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 p-4 text-sm">
          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1"
              placeholder="e.g. Lapse warning — Agent SMS"
              data-testid="tpl-name"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">
                Channel {isEdit && <em className="ml-1 normal-case text-muted">(locked)</em>}
              </span>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as NotificationChannel)}
                disabled={isEdit}
                className="w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-50 disabled:text-slate-500"
                data-testid="tpl-channel"
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">Locale</span>
              <input
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1"
                placeholder="en-IN"
                data-testid="tpl-locale"
              />
            </label>
          </div>

          {channel !== 'SMS' && (
            <label className="block">
              <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">
                Subject
              </span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1"
                placeholder="e.g. New case {{case_number}} assigned to you"
                data-testid="tpl-subject"
              />
              <span className="mt-1 block text-2xs text-muted">
                Mustache placeholders allowed — e.g. <code>{'{{case_number}}'}</code>
              </span>
            </label>
          )}

          {channel === 'SMS' && (
            <div className="rounded bg-amber-50 px-2 py-1.5 text-2xs text-amber-700">
              SMS templates have no subject (DB-enforced).
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-2xs font-semibold uppercase text-slate-500">Body</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
              placeholder="Hi {{rm_name}}, ..."
              data-testid="tpl-body"
            />
            <span className="mt-1 block text-2xs text-muted">
              {body.length}/10000 chars
            </span>
          </label>

          {dupHint && !validation && (
            <div className="rounded bg-amber-50 px-2 py-1.5 text-2xs text-amber-700">{dupHint}</div>
          )}
          {validation && (
            <div className="rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" data-testid="tpl-validation">
              {validation}
            </div>
          )}
          {errMsg && !validation && (
            <div className="rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700" data-testid="tpl-error">
              {errMsg}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={props.isPending} data-testid="tpl-save">
            {isEdit ? 'Save changes' : 'Create draft'}
          </Button>
        </div>
      </div>
    </div>
  );
}
