import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';
import { api, type IntegrationStatus } from '@/lib/api';

function StatusBadge({ status }: { status: 'up' | 'down' }) {
  if (status === 'up') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[10px] bg-success-bg text-success px-2 py-[3px] text-[11px] font-medium">
        <CheckCircle2 size={12} /> Up
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[10px] bg-danger-bg text-danger px-2 py-[3px] text-[11px] font-medium">
      <XCircle size={12} /> Down
    </span>
  );
}

export function IntegrationsPage() {
  const query = useQuery({
    queryKey: ['integrations.health'],
    queryFn: api.integrationsHealth,
    refetchInterval: 15_000,
  });
  useChatContext({ page: 'unknown' });

  const upCount = query.data?.integrations.filter((i) => i.status === 'up').length ?? 0;
  const total = query.data?.integrations.length ?? 0;
  const allUp = total > 0 && upCount === total;
  const avgLatency =
    query.data && query.data.integrations.length > 0
      ? Math.round(
          query.data.integrations.reduce((acc, i) => acc + i.latency_ms, 0) /
            query.data.integrations.length,
        )
      : 0;

  return (
    <div>
      <PageHeader
        title="Integrations"
        subtitle="Upstream connectivity · CBS · AML · IFRS 9 · Collection"
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <MetricCard
          label="Upstreams up"
          value={`${upCount} / ${total}`}
          tone={allUp ? 'success' : 'danger'}
        />
        <MetricCard
          label="Average probe latency"
          value={query.data ? `${avgLatency} ms` : '—'}
          tone="neutral"
          sub="Across all probes (last refresh)"
        />
        <MetricCard
          label="Mock base URL"
          value={query.data?.base_url ?? '—'}
          tone="blue"
          sub="Set MOCKS_BASE_URL on bff to override"
        />
      </div>

      <Panel
        title="Connectivity matrix"
        action={
          <Button
            type="button"
            variant="ghost"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw size={14} className="mr-1.5" />
            {query.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        {query.isLoading && <p className="caption">Probing upstreams…</p>}
        {query.isError && (
          <p role="alert" className="text-danger text-sm">
            {(query.error as Error)?.message ?? 'Health probe failed.'}
          </p>
        )}
        {query.data && (
          <table className="w-full text-[12px]" data-testid="integrations-table">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="text-left py-2 font-medium">Upstream</th>
                <th className="text-left py-2 font-medium">Probe</th>
                <th className="text-right py-2 font-medium">Latency</th>
                <th className="text-right py-2 font-medium">HTTP</th>
                <th className="text-right py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {query.data.integrations.map((row) => (
                <IntegrationRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        )}

        {query.data && (
          <p className="caption mt-3">
            Probed {new Date(query.data.generated_at).toLocaleString()} · auto-refresh 15s · set
            <span className="font-mono ml-1">MOCK_&lt;UPSTREAM&gt;_ERROR_RATE=0.5</span> on the
            integration-mocks service to inject failures.
          </p>
        )}
      </Panel>
    </div>
  );
}

function IntegrationRow({ row }: { row: IntegrationStatus }) {
  return (
    <tr className="border-b border-divider/40" data-testid={`integration-row-${row.id}`}>
      <td className="py-2">
        <div className="font-medium text-ink">{row.label}</div>
        <div className="text-[10px] text-muted font-mono">{row.id}</div>
      </td>
      <td className="text-sub font-mono text-[11px]">{row.probe_url}</td>
      <td className="text-right tabular text-sub">{row.latency_ms} ms</td>
      <td className="text-right tabular text-sub">{row.http_status || '—'}</td>
      <td className="text-right">
        <StatusBadge status={row.status} />
        {row.message && <div className="text-[10px] text-danger mt-0.5">{row.message}</div>}
      </td>
    </tr>
  );
}
