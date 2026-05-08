import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import {
  api,
  SLA_BUCKET_SLUG,
  type SlaBreachMatrix,
  type SlaBucket,
} from '@/lib/api';
import { Badge, Button, Panel } from '@/components/ui';

export interface SLABreachMatrixProps {
  /** Filter passthrough — wired to query params on the backend. */
  branch?: string;
  business_unit?: string;
  /** Auto-refresh interval. Default 60s. Set to 0 to disable. */
  refreshIntervalMs?: number;
  /**
   * Click navigation target builder. Defaults to
   * /cms/cases?ageBucket=<slug>&breached=true (per BAC §3.1.9.1.4).
   */
  hrefForBucket?: (slug: string) => string;
  /** Override for tests + Storybook. */
  fixture?: SlaBreachMatrix;
}

const TONE_BY_BREACH_PCT = (pct: number): { ring: string; bg: string; text: string } => {
  if (pct >= 75) return { ring: 'ring-rose-300',    bg: 'bg-rose-50',    text: 'text-rose-700' };
  if (pct >= 25) return { ring: 'ring-amber-300',   bg: 'bg-amber-50',   text: 'text-amber-700' };
  if (pct > 0)   return { ring: 'ring-yellow-300',  bg: 'bg-yellow-50',  text: 'text-yellow-700' };
  return         { ring: 'ring-emerald-300', bg: 'bg-emerald-50', text: 'text-emerald-700' };
};

export function SLABreachMatrix({
  branch,
  business_unit,
  refreshIntervalMs = 60_000,
  hrefForBucket,
  fixture,
}: SLABreachMatrixProps) {
  const navigate = useNavigate();
  const params = useMemo(
    () => ({
      ...(branch ? { branch } : {}),
      ...(business_unit ? { business_unit } : {}),
    }),
    [branch, business_unit],
  );

  const q = useQuery({
    queryKey: ['dashboard.sla-breach-matrix', params],
    queryFn: () => api.slaBreachMatrix(params),
    refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    staleTime: refreshIntervalMs > 0 ? Math.max(0, refreshIntervalMs - 1000) : Infinity,
    initialData: fixture,
    enabled: !fixture,
  });

  const data = fixture ?? q.data;

  // ── Loading skeleton ─────────────────────────────────────────────
  if (!data && q.isLoading) {
    return (
      <Panel
        title="SLA Breach Matrix"
        action={<span className="text-2xs text-muted">Open cases by age bucket · live</span>}
      >
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading SLA breach matrix"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
          data-testid="sla-matrix-loading"
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-slate-100 animate-pulse rounded-md" />
          ))}
        </div>
      </Panel>
    );
  }

  // ── Error state ──────────────────────────────────────────────────
  if (q.isError) {
    return (
      <Panel
        title="SLA Breach Matrix"
        action={<span className="text-2xs text-muted">Open cases by age bucket · live</span>}
      >
        <div
          role="alert"
          className="bg-rose-50 border border-rose-200 rounded-md p-4 text-sm text-rose-800 flex items-start gap-3"
          data-testid="sla-matrix-error"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-medium">Could not load SLA matrix</div>
            <div className="text-xs mt-1">
              {q.error instanceof Error ? q.error.message : 'Unknown error'}
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() => void q.refetch()}
            data-testid="sla-matrix-retry"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Retry
          </Button>
        </div>
      </Panel>
    );
  }

  if (!data) return null;

  const totalOpen = data.buckets.reduce((s, b) => s + b.total_open, 0);

  // ── Empty state ──────────────────────────────────────────────────
  if (totalOpen === 0) {
    return (
      <Panel
        title="SLA Breach Matrix"
        action={<span className="text-2xs text-muted">Open cases by age bucket · live</span>}
      >
        <div
          className="text-center py-10 text-sm text-muted"
          data-testid="sla-matrix-empty"
        >
          No open cases at this time.
          <div className="text-2xs mt-1">
            Generated {new Date(data.generatedAt).toLocaleString()}
          </div>
        </div>
      </Panel>
    );
  }

  const buildHref = (slug: string) => {
    if (hrefForBucket) return hrefForBucket(slug);
    const sp = new URLSearchParams();
    sp.set('ageBucket', slug);
    sp.set('breached', 'true');
    if (business_unit) sp.set('business_unit', business_unit);
    if (branch) sp.set('branch', branch);
    return `/cms/cases?${sp.toString()}`;
  };

  return (
    <Panel
      title="SLA Breach Matrix"
      action={
        <span className="text-2xs text-muted">
          {totalOpen} open · generated {new Date(data.generatedAt).toLocaleTimeString()}
        </span>
      }
    >
      <div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
        data-testid="sla-matrix-grid"
      >
        {data.buckets.map((b) => (
          <BucketTile
            key={b.label}
            bucket={b}
            href={buildHref(SLA_BUCKET_SLUG[b.label])}
            onNavigate={navigate}
          />
        ))}
      </div>

      {(data.uncategorised_count > 0 || data.unresolved_count > 0) && (
        <div className="mt-3 text-2xs text-muted flex flex-wrap gap-3">
          {data.uncategorised_count > 0 && (
            <span data-testid="sla-matrix-uncategorised">
              <strong>{data.uncategorised_count}</strong> uncategorised case{data.uncategorised_count === 1 ? '' : 's'} fell through to default_fallback
            </span>
          )}
          {data.unresolved_count > 0 && (
            <span data-testid="sla-matrix-unresolved">
              <strong>{data.unresolved_count}</strong> unresolved case{data.unresolved_count === 1 ? '' : 's'} have no matching sla_config
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

function BucketTile({
  bucket,
  href,
  onNavigate,
}: {
  bucket: SlaBucket;
  href: string;
  onNavigate: (to: string) => void;
}) {
  const tone = TONE_BY_BREACH_PCT(bucket.breach_pct);
  const slug = SLA_BUCKET_SLUG[bucket.label];

  return (
    <button
      type="button"
      onClick={() => onNavigate(href)}
      className={`text-left rounded-md border bg-white hover:shadow-sm transition-shadow p-3 ring-1 ${tone.ring} focus:outline-none focus:ring-2 focus:ring-blue-500`}
      aria-label={`${bucket.label}: ${bucket.total_open} open, ${bucket.breached} breached, ${bucket.breach_pct}%`}
      data-testid={`sla-tile-${slug}`}
    >
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-2xs uppercase tracking-wide text-muted">{bucket.label}</span>
        <span className={`text-2xs font-semibold ${tone.text}`}>
          {bucket.breach_pct.toFixed(1)}%
        </span>
      </div>
      <div className={`text-2xl font-semibold ${tone.text}`}>
        {bucket.breached}
        <span className="text-xs text-muted ml-1 font-normal">
          / {bucket.total_open} open
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {bucket.severity_split.high > 0 && (
          <Badge tone="danger" className="text-2xs">
            {bucket.severity_split.high} high
          </Badge>
        )}
        {bucket.severity_split.medium > 0 && (
          <Badge tone="warning" className="text-2xs">
            {bucket.severity_split.medium} med
          </Badge>
        )}
        {bucket.severity_split.low > 0 && (
          <Badge tone="neutral" className="text-2xs">
            {bucket.severity_split.low} low
          </Badge>
        )}
      </div>
      <div className={`mt-2 text-2xs ${tone.bg} ${tone.text} -mx-3 -mb-3 px-3 py-1.5 rounded-b-md`}>
        Click to view breached →
      </div>
    </button>
  );
}
