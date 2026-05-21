// web/src/modules/admin/streamingLatency/StreamingLatencyPage.tsx
//
// T2.12.1.SPA — Streaming Latency dashboard. Consumes:
//   GET /v1/streaming/latency
//   GET /v1/streaming/events
//
// Proves the EWS.docx §3.5 / docs/slos.md tier-1 SLO of
// p95(indicator-observed → alert-created) < 60s. Shows the
// target_p95_60s_met boolean as the headline banner + 4 latency
// KPI cards + per-indicator rollup table + recent-events table.

import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, XCircle, Zap } from 'lucide-react';
import { MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/cn';
import { streamingLatencyApi, type IndicatorLatencyRow, type StreamingProcessingRecord } from './api';

const SLO_BUDGET_MS = 60_000;

function fmtMs(v: number | null): string {
  if (v === null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${v}ms`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtTs(s: string): string {
  return s.slice(11, 19); // HH:MM:SS UTC
}

function SloBanner({
  met,
  p95,
  sample_size,
}: {
  met: boolean;
  p95: number | null;
  sample_size: number;
}) {
  if (sample_size === 0) {
    return (
      <div
        data-testid="slo-banner"
        data-met="vacuous"
        className="rounded-md border border-divider bg-divider/30 px-4 py-3 flex items-center gap-3"
      >
        <Activity className="w-5 h-5 text-muted" />
        <div>
          <div className="text-sm font-medium text-ink">No streaming events yet</div>
          <div className="text-xs text-muted">
            SLO target: p95 &lt; 60s — vacuously met until the first event lands.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      data-testid="slo-banner"
      data-met={String(met)}
      className={cn(
        'rounded-md border px-4 py-3 flex items-center gap-3',
        met ? 'border-success/40 bg-success/5' : 'border-danger/40 bg-danger/5',
      )}
    >
      {met ? (
        <CheckCircle2 className="w-5 h-5 text-success" data-testid="slo-icon-ok" />
      ) : (
        <XCircle className="w-5 h-5 text-danger" data-testid="slo-icon-breached" />
      )}
      <div className="flex-1">
        <div className="text-sm font-semibold text-ink">
          {met ? 'SLO met: p95 < 60s' : 'SLO breached: p95 ≥ 60s'}
        </div>
        <div className="text-xs text-muted">
          Observed p95 = <span className="font-mono">{fmtMs(p95)}</span> · {sample_size} sampled
          event{sample_size === 1 ? '' : 's'}
        </div>
      </div>
    </div>
  );
}

function IndicatorRollupTable({ rows }: { rows: IndicatorLatencyRow[] }) {
  if (rows.length === 0) {
    return <div className="text-xs text-muted">No indicator activity in window.</div>;
  }
  return (
    <div className="overflow-x-auto" data-testid="indicator-table">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-divider">
            <th className="text-left py-1.5 px-2 font-medium">Indicator</th>
            <th className="text-right py-1.5 px-2 font-medium">Count</th>
            <th className="text-right py-1.5 px-2 font-medium">p50</th>
            <th className="text-right py-1.5 px-2 font-medium">p95</th>
            <th className="text-right py-1.5 px-2 font-medium">Max</th>
            <th className="text-right py-1.5 px-2 font-medium">Under 60s</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr
              key={r.indicator_id}
              data-testid={`indicator-row-${r.indicator_id}`}
              className="border-b border-divider/40 last:border-0"
            >
              <td className="py-1.5 px-2">{r.indicator_id}</td>
              <td className="text-right py-1.5 px-2">{r.count}</td>
              <td className="text-right py-1.5 px-2">{fmtMs(r.median_total_ms)}</td>
              <td
                className={cn(
                  'text-right py-1.5 px-2',
                  r.p95_total_ms >= SLO_BUDGET_MS ? 'text-danger font-semibold' : '',
                )}
              >
                {fmtMs(r.p95_total_ms)}
              </td>
              <td className="text-right py-1.5 px-2">{fmtMs(r.max_total_ms)}</td>
              <td
                className={cn(
                  'text-right py-1.5 px-2',
                  r.percentage_under_60s < 0.95 ? 'text-danger' : 'text-success',
                )}
              >
                {fmtPct(r.percentage_under_60s)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentEventsTable({ events }: { events: StreamingProcessingRecord[] }) {
  if (events.length === 0) {
    return <div className="text-xs text-muted">No events recorded.</div>;
  }
  return (
    <div className="overflow-x-auto" data-testid="events-table">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-divider">
            <th className="text-left py-1.5 px-2 font-medium">Processed</th>
            <th className="text-left py-1.5 px-2 font-medium">Indicator</th>
            <th className="text-left py-1.5 px-2 font-medium">Customer</th>
            <th className="text-right py-1.5 px-2 font-medium">Ingest</th>
            <th className="text-right py-1.5 px-2 font-medium">Process</th>
            <th className="text-right py-1.5 px-2 font-medium">Total</th>
            <th className="text-left py-1.5 px-2 font-medium">SLO</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {events.map((e) => {
            const overSlo = e.total_latency_ms >= SLO_BUDGET_MS;
            return (
              <tr
                key={e.event_id}
                data-testid={`event-row-${e.event_id}`}
                className="border-b border-divider/40 last:border-0"
              >
                <td className="py-1.5 px-2">{fmtTs(e.processed_at)}</td>
                <td className="py-1.5 px-2">{e.indicator_id}</td>
                <td className="py-1.5 px-2">{e.customer_id}</td>
                <td className="text-right py-1.5 px-2">{fmtMs(e.ingest_latency_ms)}</td>
                <td className="text-right py-1.5 px-2">{fmtMs(e.processing_latency_ms)}</td>
                <td
                  className={cn(
                    'text-right py-1.5 px-2 font-semibold',
                    overSlo ? 'text-danger' : 'text-ink',
                  )}
                >
                  {fmtMs(e.total_latency_ms)}
                </td>
                <td className="py-1.5 px-2">
                  {overSlo ? (
                    <span className="text-danger">✕</span>
                  ) : (
                    <span className="text-success">✓</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StreamingLatencyPage() {
  const summaryQ = useQuery({
    queryKey: ['streaming-latency'],
    queryFn: () => streamingLatencyApi.summary(),
    refetchInterval: 10_000, // ops dashboard — refresh every 10s
  });

  const eventsQ = useQuery({
    queryKey: ['streaming-events', 50],
    queryFn: () => streamingLatencyApi.events(50),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-4" data-testid="streaming-latency-page">
      <PageHeader
        title="Streaming Latency"
        subtitle="Real-time alert path SLO · target p95 (indicator-observed → alert-created) < 60s"
      />

      <SloBanner
        met={summaryQ.data?.target_p95_60s_met ?? true}
        p95={summaryQ.data?.p95_total_ms ?? null}
        sample_size={summaryQ.data?.sample_size ?? 0}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="kpi-cards">
        <MetricCard
          testId="kpi-p50"
          label="p50 (total)"
          value={fmtMs(summaryQ.data?.median_total_ms ?? null)}
          sub={`Min ${fmtMs(summaryQ.data?.min_total_ms ?? null)}`}
        />
        <MetricCard
          testId="kpi-p95"
          label="p95 (total)"
          value={fmtMs(summaryQ.data?.p95_total_ms ?? null)}
          sub={`SLO ${SLO_BUDGET_MS / 1000}s`}
          tone={summaryQ.data?.target_p95_60s_met === false ? 'danger' : 'neutral'}
        />
        <MetricCard
          testId="kpi-max"
          label="Max (total)"
          value={fmtMs(summaryQ.data?.max_total_ms ?? null)}
        />
        <MetricCard
          testId="kpi-mean"
          label="Mean (total)"
          value={fmtMs(summaryQ.data?.mean_total_ms ?? null)}
          sub={`${summaryQ.data?.sample_size ?? 0} events`}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel
          title={
            <span className="inline-flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> Per-indicator rollup
            </span>
          }
          data-testid="indicator-panel"
        >
          {summaryQ.isLoading && <div className="text-xs text-muted">Loading…</div>}
          {summaryQ.data && <IndicatorRollupTable rows={summaryQ.data.by_indicator} />}
        </Panel>

        <Panel title="Recent events" data-testid="events-panel">
          {eventsQ.isLoading && <div className="text-xs text-muted">Loading…</div>}
          {eventsQ.data && <RecentEventsTable events={eventsQ.data.events} />}
        </Panel>
      </div>
    </div>
  );
}
