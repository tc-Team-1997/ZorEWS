// web/src/modules/insurance/PolicyTimelinePage.tsx
//
// Insurance EWS — Module 9: Policy Timeline.
//
// The policy's whole lifecycle + risk journey — premium history, claims,
// anomaly flags, alerts, underwriting events, retention actions, lapse
// warnings, reinstatements and surrenders — in one chronological view for
// the retention / SIU analyst. Insurance analog of the banking Borrower
// Timeline; the drill-through target in the Policy → Profile → Timeline flow.
// Backed by /v1/insurance/policies/:policy_id/timeline; MSW-backed in dev.

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import {
  api,
  type PolicyTimelineShape,
  type PolicyEventTypeShape,
  type PolicyEventSeverityShape,
  type PolicyStatusShape,
  type LapseRiskBandShape,
  type PersistencyTrajectoryShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const fmtKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const SEV_TONE: Record<PolicyEventSeverityShape, BadgeTone> = {
  info: 'success',
  warning: 'warning',
  critical: 'danger',
};
const SEV_RAIL: Record<PolicyEventSeverityShape, string> = {
  info: 'border-success bg-success',
  warning: 'border-warning bg-warning',
  critical: 'border-danger bg-danger',
};

const STATUS_TONE: Record<PolicyStatusShape, BadgeTone> = {
  in_force: 'success',
  lapsed: 'danger',
  surrendered: 'danger',
  matured: 'neutral',
};
const BAND_TONE: Record<LapseRiskBandShape, BadgeTone> = {
  low: 'success',
  medium: 'blue',
  high: 'warning',
  critical: 'danger',
};
const TRAJ_TONE: Record<PersistencyTrajectoryShape, BadgeTone> = {
  improving: 'success',
  stable: 'neutral',
  deteriorating: 'danger',
};

const TYPE_LABEL: Record<PolicyEventTypeShape, string> = {
  policy_issued: 'Issued',
  premium_paid: 'Premium paid',
  premium_missed: 'Premium missed',
  grace_period: 'Grace period',
  renewal: 'Renewal',
  claim_filed: 'Claim filed',
  claim_settled: 'Claim settled',
  claim_rejected: 'Claim rejected',
  anomaly_flagged: 'Anomaly flagged',
  alert_raised: 'Alert raised',
  underwriting_event: 'Underwriting',
  retention_action: 'Retention',
  lapse_warning: 'Lapse warning',
  reinstatement: 'Reinstatement',
  surrender: 'Surrender',
};

const TYPE_ORDER: PolicyEventTypeShape[] = [
  'policy_issued',
  'premium_paid',
  'premium_missed',
  'grace_period',
  'renewal',
  'claim_filed',
  'claim_settled',
  'claim_rejected',
  'anomaly_flagged',
  'alert_raised',
  'underwriting_event',
  'retention_action',
  'lapse_warning',
  'reinstatement',
  'surrender',
];

export function PolicyTimelinePage() {
  const [params, setParams] = useSearchParams();
  const policyId = params.get('policy_id') || 'POL-BANK_DEMO-100001';
  const eventType = (params.get('event_type') as PolicyEventTypeShape | null) ?? null;
  const [draftId, setDraftId] = useState(policyId);

  const { data, isLoading } = useQuery<PolicyTimelineShape>({
    queryKey: ['policy.timeline', policyId, eventType],
    queryFn: () => api.insurancePolicyTimeline(policyId, { event_type: eventType ?? undefined }),
  });

  const setPolicy = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('policy_id', id.trim());
    next.delete('event_type');
    setParams(next);
  };
  const setEventType = (t: PolicyEventTypeShape | null) => {
    const next = new URLSearchParams(params);
    if (t) next.set('event_type', t);
    else next.delete('event_type');
    setParams(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Policy Timeline"
        subtitle="The policy's whole lifecycle + risk journey — premium history, claims, anomaly flags, alerts, underwriting events, retention actions, lapse warnings, reinstatements and surrenders — in one chronological view."
      />

      <Panel title="Policy">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftId.trim()) setPolicy(draftId);
          }}
        >
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase text-ink-subtle">Policy ID</span>
            <input
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              data-testid="pt-policy-input"
              placeholder="POL-BANK_DEMO-100001"
              className="w-72 rounded border border-divider bg-surface px-2 py-1"
            />
          </label>
          <Button type="submit" data-testid="pt-policy-apply">
            <Search className="mr-1 size-4" />
            Load timeline
          </Button>
          {data && (
            <span className="ml-auto text-sm text-ink-subtle" data-testid="pt-policy-meta">
              {data.policyholder_name} · {data.product} · {data.channel}
            </span>
          )}
        </form>
      </Panel>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Policy status" value={data ? data.policy_status.replace(/_/g, ' ') : '—'} tone={data ? STATUS_TONE[data.policy_status] : undefined} testId="pt-kpi-status" />
        <MetricCard label="Lapse risk" value={data ? data.lapse_risk_band.toUpperCase() : '—'} tone={data ? BAND_TONE[data.lapse_risk_band] : undefined} testId="pt-kpi-band" />
        <MetricCard label="Persistency" value={data ? data.persistency_trajectory : '—'} tone={data ? TRAJ_TONE[data.persistency_trajectory] : undefined} testId="pt-kpi-trajectory" />
        <MetricCard label="Premium paid" value={data ? fmtKES(data.total_premium_paid_kes) : '—'} testId="pt-kpi-premium" />
        <MetricCard label="Claims (settled/filed)" value={data ? `${data.claims_settled}/${data.claims_filed}` : '—'} testId="pt-kpi-claims" />
        <MetricCard label="Peak anomaly" value={data ? data.peak_anomaly_score.toFixed(2) : '—'} tone={data && data.peak_anomaly_score >= 0.75 ? 'danger' : undefined} testId="pt-kpi-anomaly" />
      </div>

      {data && (
        <div className="flex flex-wrap items-center gap-2" data-testid="pt-type-filters">
          <span className="text-xs font-medium uppercase text-ink-subtle">Event type:</span>
          <button
            type="button"
            aria-pressed={eventType === null}
            onClick={() => setEventType(null)}
            data-testid="pt-type-all"
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
              data-testid={`pt-type-${t}`}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                eventType === t ? 'border-action bg-action/10 text-action' : 'border-divider text-ink-subtle hover:text-ink'
              }`}
            >
              {TYPE_LABEL[t]} ({data.by_type[t]})
            </button>
          ))}
        </div>
      )}

      <Panel
        title={data ? `Lifecycle — ${data.policy_id}` : 'Lifecycle'}
        action={data ? <span className="text-xs text-ink-subtle">{data.returned_count} of {data.total_events} events</span> : null}
      >
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : !data || data.events.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-subtle" data-testid="pt-empty">
            No events match the current filter.
          </p>
        ) : (
          <ol className="relative space-y-1 border-l border-divider pl-6" data-testid="pt-timeline">
            {data.events.map((ev) => (
              <li key={ev.event_id} data-testid={`pt-event-${ev.event_id}`} className="relative pb-4">
                <span className={`absolute -left-[1.65rem] mt-1 size-3 rounded-full border-2 ${SEV_RAIL[ev.severity]}`} aria-hidden />
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
