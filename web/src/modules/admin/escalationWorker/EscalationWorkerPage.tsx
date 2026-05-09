// SPA admin page for the M14.25 escalation worker (M14.25c).
//
// Lets ops:
//   1. Build a synthetic open-case list (id + category + priority +
//      age in minutes, with quick-fill presets so the common cases
//      are 1 click away).
//   2. Click Preview → POST /v1/admin/escalations/preview, see the
//      due[] table with rendered subject/body for each level.
//   3. Click Run tick → POST /v1/admin/escalations/tick, see the
//      dispatched[] confirmation. Subsequent ticks at the same time
//      are no-ops (already_dispatched_count goes up).
//
// No real CmsCaseSource yet — that's M14.25b's cron wrapper. For now
// this page is the manual-trigger UX so ops can validate scenario +
// matrix + template wiring end-to-end.

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Mail, MessageSquare, Plus, Send, Smartphone, Trash2, Zap } from 'lucide-react';
import {
  api,
  type EscalationDueRow,
  type EscalationOpenCase,
  type EscalationPreviewResult,
  type EscalationTickResult,
  type NotificationChannel,
} from '@/lib/api';
import { useAuth } from '@/store/auth';
import {
  Badge,
  Button,
  DataTable,
  Input,
  type BadgeTone,
  type Column,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const PRIORITY_TONE: Record<EscalationOpenCase['priority'], BadgeTone> = {
  P1: 'danger',
  P2: 'warning',
  P3: 'blue',
  P4: 'neutral',
};

const CHANNEL_ICON: Record<NotificationChannel, typeof Mail> = {
  EMAIL: Mail,
  SMS: Smartphone,
  IN_APP: MessageSquare,
};

interface CaseRow {
  /** Local id for the form-state key only; not sent to server. */
  uid: string;
  case_id: string;
  case_category: string;
  priority: EscalationOpenCase['priority'];
  /** Age in minutes-since-now — converted to opened_at on submit. */
  age_minutes: string;
}

const PRESETS: ReadonlyArray<{ label: string; row: Omit<CaseRow, 'uid'> }> = [
  { label: 'Fraud P1 · 30m old', row: { case_id: 'C-FRAUD-001', case_category: 'fraud', priority: 'P1', age_minutes: '30' } },
  { label: 'Fraud P1 · 90m old', row: { case_id: 'C-FRAUD-002', case_category: 'fraud', priority: 'P1', age_minutes: '90' } },
  { label: 'Fraud P1 · 5h old',  row: { case_id: 'C-FRAUD-003', case_category: 'fraud', priority: 'P1', age_minutes: '300' } },
  { label: 'KYC P3 · 10h old',   row: { case_id: 'C-KYC-001',   case_category: 'kyc',   priority: 'P3', age_minutes: '600' } },
  { label: 'Lapse P1 · 2h old (BIL)', row: { case_id: 'P-BIL-001', case_category: 'lapse', priority: 'P1', age_minutes: '120' } },
];

let _uidCounter = 1;
const newUid = () => `c-${_uidCounter++}-${Math.random().toString(36).slice(2, 6)}`;

export function EscalationWorkerPage() {
  const me = useAuth((s) => s.user);
  const isAdmin = !!me?.roles.includes('admin');

  const [cases, setCases] = useState<CaseRow[]>(() => [
    { uid: newUid(), ...PRESETS[1].row },
  ]);
  const [validation, setValidation] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<EscalationPreviewResult | null>(null);
  const [tickResult, setTickResult] = useState<EscalationTickResult | null>(null);

  const updateRow = (uid: string, patch: Partial<CaseRow>) => {
    setCases((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  };
  const removeRow = (uid: string) => setCases((prev) => prev.filter((r) => r.uid !== uid));
  const addRow = () =>
    setCases((prev) => [
      ...prev,
      { uid: newUid(), case_id: '', case_category: 'fraud', priority: 'P1', age_minutes: '60' },
    ]);
  const addPreset = (preset: (typeof PRESETS)[number]) =>
    setCases((prev) => [...prev, { uid: newUid(), ...preset.row }]);

  const buildPayload = (): EscalationOpenCase[] | null => {
    setValidation(null);
    const out: EscalationOpenCase[] = [];
    for (let i = 0; i < cases.length; i++) {
      const r = cases[i];
      if (!r.case_id.trim()) {
        setValidation(`Row ${i + 1}: case_id required`);
        return null;
      }
      if (!r.case_category.trim()) {
        setValidation(`Row ${i + 1}: case_category required`);
        return null;
      }
      const ageN = Number(r.age_minutes);
      if (!Number.isFinite(ageN) || ageN < 0) {
        setValidation(`Row ${i + 1}: age must be a non-negative number`);
        return null;
      }
      const opened_at = new Date(Date.now() - ageN * 60_000).toISOString();
      out.push({
        case_id: r.case_id.trim(),
        case_category: r.case_category.trim(),
        priority: r.priority,
        opened_at,
      });
    }
    return out;
  };

  const preview = useMutation({
    mutationFn: api.escalationsPreview,
    onSuccess: (data) => {
      setPreviewResult(data);
      setTickResult(null);
    },
  });
  const tick = useMutation({
    mutationFn: api.escalationsTick,
    onSuccess: (data) => {
      setTickResult(data);
      setPreviewResult(null);
    },
  });

  const onPreview = () => {
    const payload = buildPayload();
    if (!payload) return;
    preview.mutate(payload);
  };
  const onTick = () => {
    const payload = buildPayload();
    if (!payload) return;
    tick.mutate(payload);
  };

  const lastErr = preview.error || tick.error;
  const lastErrMsg =
    lastErr instanceof Error ? lastErr.message : lastErr ? String(lastErr) : null;

  const result = tickResult ?? previewResult;
  const dueRows = result?.due ?? [];

  const dueColumns: Column<EscalationDueRow & { id: string }>[] = useMemo(
    () => [
      {
        key: 'case',
        header: 'Case',
        render: (r) => (
          <div className="flex flex-col">
            <span className="font-mono font-medium">{r.case_id}</span>
            <span className="text-2xs text-muted">
              {r.case_category} ·{' '}
              <Badge tone={PRIORITY_TONE[r.priority]} className="text-2xs">{r.priority}</Badge>
              {' · '}{r.case_age_minutes}m old
            </span>
          </div>
        ),
        width: 200,
      },
      {
        key: 'level',
        header: 'Escalation',
        render: (r) => (
          <div className="flex flex-col">
            <span className="font-medium">L{r.level} → {r.role}</span>
            <span className="text-2xs text-muted">at {r.after_minutes}m</span>
          </div>
        ),
        width: 160,
      },
      {
        key: 'channel',
        header: 'Channel',
        render: (r) => {
          const Icon = CHANNEL_ICON[r.channel];
          return (
            <div className="flex flex-col">
              <span className="text-2xs">
                <Icon className="mr-0.5 inline h-3 w-3" /> {r.channel}
              </span>
              <span className="text-2xs text-muted">{r.template_name}</span>
            </div>
          );
        },
        width: 140,
      },
      {
        key: 'rendered',
        header: 'Rendered',
        render: (r) => (
          <div className="flex flex-col gap-0.5">
            {r.rendered_subject !== null && (
              <span className="text-2xs">
                <span className="font-semibold">Subject:</span> {r.rendered_subject}
              </span>
            )}
            <span className="text-2xs whitespace-pre-wrap">
              {r.rendered_body.length > 240 ? `${r.rendered_body.slice(0, 240)}…` : r.rendered_body}
            </span>
            {r.missing_vars.length > 0 && (
              <span className="text-2xs text-amber-700">
                missing: <span className="font-mono">{r.missing_vars.join(', ')}</span>
              </span>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        title="Escalation worker"
        subtitle="Preview / tick the M14.25 worker against synthetic open cases. Real cron-driven trigger lands in M14.25b."
      />

      {/* ── Synthetic open-case form ── */}
      <div className="mb-4 rounded-md border border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Open cases ({cases.length})</h3>
          <div className="flex gap-1">
            <Button onClick={addRow} variant="ghost" data-testid="esc-worker-add-row">
              <Plus className="mr-1 h-3 w-3" /> Add row
            </Button>
          </div>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <span className="text-2xs text-muted">Quick-fill:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => addPreset(p)}
              className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-2xs text-slate-700 hover:bg-slate-100"
              data-testid={`esc-worker-preset-${p.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="space-y-1.5">
          {cases.length === 0 && (
            <p className="text-2xs italic text-muted">No cases — add a row or pick a preset above.</p>
          )}
          {cases.map((r, i) => (
            <div
              key={r.uid}
              className="grid grid-cols-[1fr_1fr_80px_120px_24px] items-center gap-2"
              data-testid={`esc-worker-case-row-${i}`}
            >
              <Input
                value={r.case_id}
                onChange={(e) => updateRow(r.uid, { case_id: e.target.value })}
                placeholder="case_id"
                className="text-sm"
                data-testid={`esc-worker-case-id-${i}`}
              />
              <Input
                value={r.case_category}
                onChange={(e) => updateRow(r.uid, { case_category: e.target.value })}
                placeholder="case_category"
                className="text-sm"
                data-testid={`esc-worker-case-category-${i}`}
              />
              <select
                value={r.priority}
                onChange={(e) =>
                  updateRow(r.uid, { priority: e.target.value as CaseRow['priority'] })
                }
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                data-testid={`esc-worker-case-priority-${i}`}
              >
                {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <Input
                type="number"
                min={0}
                value={r.age_minutes}
                onChange={(e) => updateRow(r.uid, { age_minutes: e.target.value })}
                placeholder="age (min)"
                className="text-sm tabular-nums"
                data-testid={`esc-worker-case-age-${i}`}
              />
              <button
                type="button"
                onClick={() => removeRow(r.uid)}
                className="text-rose-500 hover:text-rose-700"
                aria-label={`Remove row ${i + 1}`}
                data-testid={`esc-worker-case-remove-${i}`}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        {validation && (
          <div
            className="mt-2 rounded bg-rose-50 px-2 py-1.5 text-2xs text-rose-700"
            data-testid="esc-worker-validation"
          >
            {validation}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Button
            onClick={onPreview}
            disabled={preview.isPending || cases.length === 0}
            data-testid="esc-worker-preview"
          >
            <Zap className="mr-1 h-3 w-3" /> Preview
          </Button>
          {isAdmin && (
            <Button
              onClick={onTick}
              disabled={tick.isPending || cases.length === 0}
              data-testid="esc-worker-tick"
            >
              <Send className="mr-1 h-3 w-3" /> Run tick
            </Button>
          )}
          {!isAdmin && (
            <span className="text-2xs text-muted">
              Tick is admin-only. Preview is allowed for supervisor.
            </span>
          )}
        </div>
      </div>

      {/* ── Result panel ── */}
      {lastErrMsg && (
        <div className="mb-3 rounded bg-rose-50 px-3 py-2 text-2xs text-rose-700" role="alert">
          {lastErrMsg}
        </div>
      )}
      {result && (
        <div className="mb-3 rounded-md border border-slate-200 bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center gap-3 text-2xs">
            <span data-testid="esc-worker-stat-inspected">
              <strong>Inspected:</strong> {result.cases_inspected}
            </span>
            <span data-testid="esc-worker-stat-no-scenario">
              <strong>No scenario:</strong> {result.cases_with_no_scenario}
            </span>
            <span data-testid="esc-worker-stat-archived">
              <strong>Archived rule:</strong> {result.cases_with_archived_escalation}
            </span>
            <span data-testid="esc-worker-stat-already">
              <strong>Already dispatched:</strong> {result.already_dispatched_count}
            </span>
            {tickResult && (
              <span data-testid="esc-worker-stat-dispatched">
                <strong>Dispatched now:</strong>{' '}
                <Badge tone="success" className="text-2xs">
                  {tickResult.dispatched.length}
                </Badge>
              </span>
            )}
          </div>
        </div>
      )}

      {dueRows.length > 0 ? (
        <DataTable
          columns={dueColumns}
          data={dueRows.map((r, i) => ({ ...r, id: `${r.case_id}-${r.level}-${i}` }))}
        />
      ) : result ? (
        <p className="py-8 text-center text-sm text-muted" data-testid="esc-worker-due-empty">
          Nothing due — either every case is too young, no scenario matches, or all due levels
          have already been dispatched.
        </p>
      ) : null}
    </div>
  );
}
