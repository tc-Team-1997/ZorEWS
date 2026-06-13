// web/src/modules/banking/BorrowerTimelinePage.tsx
//
// Borrower Timeline (§2.1.9) — a per-borrower chronological RISK-event stream.
// Summary header (current risk band, trajectory, peak DPD) + event-type filter
// chips + a severity-coded vertical timeline. Distinct from the CMS case
// timelines (single-case state ladder) — this is the borrower's whole risk
// journey across products. URL-synced via ?customer_id= and ?event_type=;
// MSW-backed in dev like the other Bank-EWS modules.

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import {
  api,
  type BorrowerTimelineReport,
  type TimelineEventType,
  type TimelineSeverity,
  type BorrowerRiskBand,
  type BorrowerTrajectory,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { buildBorrowerTimelineReportData } from './borrowerTimelineReportAdapter';

const SEV_TONE: Record<TimelineSeverity, 'success' | 'warning' | 'danger'> = {
  info: 'success',
  warning: 'warning',
  critical: 'danger',
};
const SEV_RAIL: Record<TimelineSeverity, string> = {
  info: 'border-success bg-success',
  warning: 'border-warning bg-warning',
  critical: 'border-danger bg-danger',
};

const BAND_TONE: Record<BorrowerRiskBand, 'success' | 'blue' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'blue',
  high: 'warning',
  critical: 'danger',
};

const TRAJ_TONE: Record<BorrowerTrajectory, 'success' | 'neutral' | 'danger'> = {
  improving: 'success',
  stable: 'neutral',
  deteriorating: 'danger',
};

const TYPE_LABEL: Record<TimelineEventType, string> = {
  account_opened: 'Account opened',
  repayment: 'Repayment',
  dpd_change: 'DPD change',
  sma_reclassification: 'SMA reclass.',
  rule_fired: 'Rule fired',
  alert_raised: 'Alert raised',
  ratio_breach: 'Ratio breach',
  bureau_update: 'Bureau update',
  limit_change: 'Limit change',
  restructuring: 'Restructuring',
  case_opened: 'Case opened',
  case_closed: 'Case closed',
};

const TYPE_ORDER: TimelineEventType[] = [
  'account_opened',
  'repayment',
  'dpd_change',
  'sma_reclassification',
  'rule_fired',
  'alert_raised',
  'ratio_breach',
  'bureau_update',
  'limit_change',
  'restructuring',
  'case_opened',
  'case_closed',
];

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export function BorrowerTimelinePage() {
  const [params, setParams] = useSearchParams();
  const customerId = params.get('customer_id') || 'c-200000';
  const eventType = (params.get('event_type') as TimelineEventType | null) ?? null;
  const [draftId, setDraftId] = useState(customerId);

  const { data, isLoading } = useQuery<BorrowerTimelineReport>({
    queryKey: ['borrower.timeline', customerId, eventType],
    queryFn: () => api.borrowerTimeline(customerId, { event_type: eventType ?? undefined }),
  });

  const setCustomer = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('customer_id', id.trim());
    next.delete('event_type');
    setParams(next);
  };
  const setEventType = (t: TimelineEventType | null) => {
    const next = new URLSearchParams(params);
    if (t) next.set('event_type', t);
    else next.delete('event_type');
    setParams(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Borrower Timeline"
        subtitle="The borrower's whole risk journey across products — DPD changes, SMA reclassifications, rule firings, alerts, ratio breaches, repayments, restructurings and recovery cases — in one chronological view."
        actions={
          /* Enterprise export (P2) — RBAC-gated; renders null without
             reports:export. Single-borrower report: reports the risk-event
             stream (post event-type filter) + journey summary, stamping the
             borrower as the report subject. */
          <ExportButton
            module="borrower_timeline"
            reportType="customer"
            adapter={(config) =>
              buildBorrowerTimelineReportData(
                {
                  customer_id: data?.customer_id ?? customerId,
                  customer_name: data?.customer_name ?? customerId,
                  summary: {
                    current_risk_band: data?.current_risk_band ?? '—',
                    trajectory: data?.trajectory ?? '—',
                    peak_dpd: data?.peak_dpd ?? 0,
                    total_events: data?.total_events ?? 0,
                    critical_events: data?.by_severity.critical ?? 0,
                  },
                  events: data?.events ?? [],
                  meta: { tenant_id: 'BANK_DEMO', generated_by: 'operator', role: 'admin' },
                },
                config,
              )
            }
          />
        }
      />

      {/* Borrower selector */}
      <Panel title="Borrower">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftId.trim()) setCustomer(draftId);
          }}
        >
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase text-ink-subtle">Customer ID</span>
            <input
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              data-testid="bt-customer-input"
              placeholder="c-200000"
              className="w-56 rounded border border-divider bg-surface px-2 py-1"
            />
          </label>
          <Button type="submit" data-testid="bt-customer-apply">
            <Search className="mr-1 size-4" />
            Load timeline
          </Button>
          {data && (
            <Link
              to={`/customers/${encodeURIComponent(customerId)}`}
              className="ml-auto text-sm text-action hover:underline"
              data-testid="bt-customer-link"
            >
              Open risk profile →
            </Link>
          )}
        </form>
      </Panel>

      {/* Summary header */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <MetricCard label="Current risk band" value={data ? data.current_risk_band.toUpperCase() : '—'} tone={data ? BAND_TONE[data.current_risk_band] : undefined} testId="bt-kpi-band" />
        <MetricCard label="Trajectory" value={data ? data.trajectory : '—'} tone={data ? TRAJ_TONE[data.trajectory] : undefined} testId="bt-kpi-trajectory" />
        <MetricCard label="Peak DPD" value={data?.peak_dpd.toString() ?? '—'} testId="bt-kpi-peak-dpd" />
        <MetricCard label="Total events" value={data?.total_events.toString() ?? '—'} testId="bt-kpi-total" />
        <MetricCard label="Critical events" value={data?.by_severity.critical.toString() ?? '—'} tone="danger" testId="bt-kpi-critical" />
      </div>

      {/* Event-type filter chips */}
      {data && (
        <div className="flex flex-wrap items-center gap-2" data-testid="bt-type-filters">
          <span className="text-xs font-medium uppercase text-ink-subtle">Event type:</span>
          <button
            type="button"
            aria-pressed={eventType === null}
            onClick={() => setEventType(null)}
            data-testid="bt-type-all"
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              eventType === null ? 'border-action bg-action/10 text-action' : 'border-divider text-ink-subtle hover:text-ink'
            }`}
          >
            All ({data.total_events})
          </button>
          {TYPE_ORDER.filter((t) => data.by_type[t] > 0).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={eventType === t}
              onClick={() => setEventType(eventType === t ? null : t)}
              data-testid={`bt-type-${t}`}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                eventType === t ? 'border-action bg-action/10 text-action' : 'border-divider text-ink-subtle hover:text-ink'
              }`}
            >
              {TYPE_LABEL[t]} ({data.by_type[t]})
            </button>
          ))}
        </div>
      )}

      {/* Timeline */}
      <Panel
        title={data ? `Risk journey — ${data.customer_name}` : 'Risk journey'}
        action={data ? <span className="text-xs text-ink-subtle">{data.returned_count} of {data.total_events} events</span> : null}
      >
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : !data || data.events.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-subtle" data-testid="bt-empty">
            No events match the current filter.
          </p>
        ) : (
          <ol className="relative space-y-1 border-l border-divider pl-6" data-testid="bt-timeline">
            {data.events.map((ev) => (
              <li key={ev.event_id} data-testid={`bt-event-${ev.event_id}`} className="relative pb-4">
                <span
                  className={`absolute -left-[1.65rem] mt-1 size-3 rounded-full border-2 ${SEV_RAIL[ev.severity]}`}
                  aria-hidden
                />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{ev.title}</span>
                  <Badge tone={SEV_TONE[ev.severity]}>{ev.severity}</Badge>
                  <span className="text-xs text-ink-subtle">{TYPE_LABEL[ev.event_type]}</span>
                  <span className="ml-auto text-xs tabular-nums text-ink-subtle">{fmtDate(ev.occurred_at)}</span>
                </div>
                <p className="mt-1 text-sm text-ink-subtle">{ev.description}</p>
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  {ev.linked_ref && (
                    <span className="rounded bg-divider/40 px-1.5 py-0.5 font-mono text-ink-subtle">{ev.linked_ref}</span>
                  )}
                  {Object.entries(ev.metadata).map(([k, v]) => (
                    <span key={k} className="rounded bg-divider/20 px-1.5 py-0.5 text-ink-subtle">
                      {k.replace(/_/g, ' ')}: <span className="font-medium text-ink">{String(v)}</span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
