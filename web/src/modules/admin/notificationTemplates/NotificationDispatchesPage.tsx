// Audit log of every notification dispatch (T6 M14.24b). Lives at
// /admin/notification-templates/dispatches. The row pivot
// (?reference=...) drives the SPA story "show me everything we sent
// for case c-001".

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, FilterX, Mail, MessageSquare, Smartphone } from 'lucide-react';
import {
  api,
  type NotificationChannel,
  type NotificationDispatchEntry,
  type NotificationDispatchStatus,
  type NotificationDispatchTrigger,
} from '@/lib/api';
import { Badge, Button, DataTable, Input, type BadgeTone, type Column } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const STATUS_TONE: Record<NotificationDispatchStatus, BadgeTone> = {
  sent: 'success',
  preview: 'neutral',
  failed: 'danger',
};

const CHANNEL_ICON: Record<NotificationChannel, typeof Mail> = {
  EMAIL: Mail,
  SMS: Smartphone,
  IN_APP: MessageSquare,
};

const TRIGGER_LABEL: Record<NotificationDispatchTrigger, string> = {
  admin_test_fire: 'Test fire',
  case_create_pipeline: 'Case create',
  escalation_worker: 'Escalation',
};

type StatusFilter = NotificationDispatchStatus | 'ALL';
type TriggerFilter = NotificationDispatchTrigger | 'ALL';

export function NotificationDispatchesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('ALL');
  const [referenceFilter, setReferenceFilter] = useState(
    () => searchParams.get('reference') ?? '',
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Reference filter is also URL-bound so the case-detail page can
  // deep-link here with ?reference=case:<case_id> (M14.24c follow-on
  // wiring; for now the field is a manual input).
  const updateReference = (next: string) => {
    setReferenceFilter(next);
    const params = new URLSearchParams(searchParams);
    if (next.trim()) params.set('reference', next.trim());
    else params.delete('reference');
    setSearchParams(params, { replace: true });
  };

  const list = useQuery({
    queryKey: ['notification-dispatches', statusFilter, triggerFilter, referenceFilter],
    queryFn: () =>
      api.notificationDispatchesList({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        trigger: triggerFilter === 'ALL' ? undefined : triggerFilter,
        reference: referenceFilter.trim() || undefined,
        page_size: 200,
      }),
  });

  const counts = useMemo(() => {
    const items = list.data?.items ?? [];
    return {
      all: items.length,
      sent: items.filter((r) => r.status === 'sent').length,
      preview: items.filter((r) => r.status === 'preview').length,
      failed: items.filter((r) => r.status === 'failed').length,
    };
  }, [list.data?.items]);

  const items = list.data?.items ?? [];

  const columns: Column<NotificationDispatchEntry & { id: string }>[] = [
    {
      key: 'expand',
      header: '',
      render: (r) => (
        <button
          type="button"
          onClick={() => setExpanded((p) => ({ ...p, [r.dispatch_id]: !p[r.dispatch_id] }))}
          aria-label={expanded[r.dispatch_id] ? 'Collapse' : 'Expand'}
          className="text-slate-400 hover:text-slate-700"
        >
          {expanded[r.dispatch_id] ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
      ),
      width: 30,
    },
    {
      key: 'when',
      header: 'When',
      render: (r) => (
        <div className="flex flex-col text-2xs">
          <span>{new Date(r.performed_at).toLocaleString()}</span>
          <span className="text-muted">by {r.performed_by}</span>
        </div>
      ),
      width: 160,
    },
    {
      key: 'template',
      header: 'Template',
      render: (r) => {
        const Icon = CHANNEL_ICON[r.channel];
        return (
          <div className="flex flex-col">
            <span className="font-medium">{r.template_name}</span>
            <span className="text-2xs text-muted">
              <Icon className="mr-0.5 inline h-3 w-3" /> {r.channel}
              {' · '}
              <span className="font-mono">{r.template_id.slice(0, 18)}…</span>
            </span>
          </div>
        );
      },
    },
    {
      key: 'recipient',
      header: 'Recipient',
      render: (r) => <span className="text-2xs">{r.recipient}</span>,
      width: 200,
    },
    {
      key: 'reference',
      header: 'Reference',
      render: (r) => (
        <span className="font-mono text-2xs">
          {r.reference ?? <em className="text-muted not-italic">—</em>}
        </span>
      ),
      width: 160,
    },
    {
      key: 'trigger',
      header: 'Trigger',
      render: (r) => (
        <Badge tone="neutral" className="text-2xs uppercase">
          {TRIGGER_LABEL[r.trigger]}
        </Badge>
      ),
      width: 110,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <Badge tone={STATUS_TONE[r.status]} className="text-2xs uppercase">
            {r.status}
          </Badge>
          {r.missing_vars.length > 0 && (
            <span className="text-2xs text-amber-700">
              {r.missing_vars.length} missing var{r.missing_vars.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      ),
      width: 130,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Notification dispatches"
        subtitle="Audit log — every test-fire / case-create / escalation send. Use Reference to pivot from a case to its notifications."
      />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
        {(['ALL', 'sent', 'preview', 'failed'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`text-left rounded-md border px-3 py-2 ${
              statusFilter === s ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'
            }`}
            onClick={() => setStatusFilter(s)}
            data-testid={`disp-pivot-${s.toLowerCase()}`}
          >
            <div className="text-2xs uppercase tracking-wide text-muted">
              {s === 'ALL' ? 'All' : s}
            </div>
            <div className="text-2xl font-semibold">
              {s === 'ALL'
                ? counts.all
                : s === 'sent'
                  ? counts.sent
                  : s === 'preview'
                    ? counts.preview
                    : counts.failed}
            </div>
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={referenceFilter}
          onChange={(e) => updateReference(e.target.value)}
          placeholder="Reference, e.g. case:c-001"
          className="w-72"
          data-testid="disp-reference"
        />
        {referenceFilter && (
          <button
            type="button"
            onClick={() => updateReference('')}
            className="inline-flex items-center gap-1 text-2xs text-slate-600 hover:underline"
            data-testid="disp-reference-clear"
          >
            <FilterX className="h-3 w-3" /> Clear
          </button>
        )}
        <div className="flex gap-1">
          {(['ALL', 'admin_test_fire', 'case_create_pipeline', 'escalation_worker'] as const).map(
            (t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTriggerFilter(t)}
                className={`rounded border px-2 py-1 text-2xs uppercase tracking-wide ${
                  triggerFilter === t
                    ? 'border-blue-400 bg-blue-50 text-blue-700'
                    : 'border-slate-200 bg-white text-slate-600'
                }`}
                data-testid={`disp-trigger-${t.toLowerCase()}`}
              >
                {t === 'ALL' ? 'all triggers' : TRIGGER_LABEL[t]}
              </button>
            ),
          )}
        </div>
      </div>

      {list.isLoading ? (
        <p className="py-6 text-center text-sm text-muted">Loading dispatches…</p>
      ) : list.isError ? (
        <p className="py-6 text-center text-sm text-rose-700" role="alert">
          Failed to load: {(list.error as Error)?.message}
        </p>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted" data-testid="disp-empty">
          No dispatches match the current filters. Trigger a test from the
          Notification Templates page to see entries here.
        </p>
      ) : (
        <>
          <DataTable
            columns={columns}
            data={items.map((r) => ({ ...r, id: r.dispatch_id }))}
          />
          {/* Expanded panel: rendered subject/body for the selected entry. */}
          {items.map((r) =>
            expanded[r.dispatch_id] ? (
              <div
                key={`exp-${r.dispatch_id}`}
                className="mt-2 rounded border border-slate-200 bg-slate-50 p-3"
                data-testid={`disp-expanded-${r.dispatch_id}`}
              >
                <div className="mb-1 text-2xs font-semibold uppercase text-slate-500">
                  Rendered output — {r.template_name}
                </div>
                {r.rendered_subject !== null && (
                  <div className="mb-2">
                    <div className="text-2xs font-semibold uppercase text-slate-500">Subject</div>
                    <div className="rounded border border-slate-200 bg-white px-2 py-1 text-sm">
                      {r.rendered_subject}
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-2xs font-semibold uppercase text-slate-500">Body</div>
                  <pre className="whitespace-pre-wrap rounded border border-slate-200 bg-white px-2 py-1 font-sans text-sm">
                    {r.rendered_body}
                  </pre>
                </div>
                {r.status_reason && (
                  <p className="mt-2 text-2xs italic text-amber-700">{r.status_reason}</p>
                )}
              </div>
            ) : null,
          )}
        </>
      )}
    </div>
  );
}
