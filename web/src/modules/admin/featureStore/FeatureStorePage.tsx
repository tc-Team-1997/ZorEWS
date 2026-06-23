// web/src/modules/admin/featureStore/FeatureStorePage.tsx
//
// T2.1.2 — SPA Feature Store explorer. Consumes the T2.1.1 BFF surface:
//   GET /v1/feature-store/catalog
//   GET /v1/feature-store/coverage
//   GET /v1/feature-store/customers/:id/snapshot?at=ISO
//   GET /v1/feature-store/customers/:id/history?feature_name=&since=&until=
//
// 3-pane layout: catalog left (closed-enum reference), input controls
// top-right (customer_id + as-of date), snapshot grid mid-right, per-
// feature history mini-charts at the bottom.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from 'recharts';
import { ArrowDown, ArrowUp, Minus, Database, Search } from 'lucide-react';
import { Button, Input, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { color } from '@/styles/tokens';
import { cn } from '@/lib/cn';
import {
  ALL_FEATURE_NAMES,
  featureStoreApi,
  type FeatureDef,
  type FeatureName,
  type FeatureTrend,
} from './api';

const DEFAULT_CUSTOMER_ID = 'CUST-1';

function fmtValue(def: FeatureDef, v: number): string {
  if (def.value_type === 'enum') {
    return def.enum_labels[Math.max(0, Math.min(def.enum_labels.length - 1, Math.round(v)))] ?? String(v);
  }
  if (def.value_type === 'integer') return v.toLocaleString();
  return v.toFixed(3);
}

function TrendBadge({ trend, polarity }: { trend: FeatureTrend; polarity: FeatureDef['risk_polarity'] }) {
  if (trend === null) return null;
  // For higher_is_worse: rising = bad (red), falling = good (green).
  // For lower_is_worse: rising = good (green), falling = bad (red).
  // Neutral: blue regardless.
  let cls = 'text-muted bg-divider';
  let Icon = Minus;
  if (trend === 'rising') {
    Icon = ArrowUp;
    if (polarity === 'higher_is_worse') cls = 'text-danger bg-danger/10';
    else if (polarity === 'lower_is_worse') cls = 'text-success bg-success/10';
    else cls = 'text-action bg-action/10';
  } else if (trend === 'falling') {
    Icon = ArrowDown;
    if (polarity === 'higher_is_worse') cls = 'text-success bg-success/10';
    else if (polarity === 'lower_is_worse') cls = 'text-danger bg-danger/10';
    else cls = 'text-action bg-action/10';
  }
  return (
    <span
      data-testid="trend-badge"
      data-trend={trend}
      data-polarity={polarity}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
        cls,
      )}
    >
      <Icon className="w-3 h-3" />
      {trend}
    </span>
  );
}

function FeatureHistoryMiniChart({
  feature,
  customer_id,
}: {
  feature: FeatureDef;
  customer_id: string;
}) {
  const q = useQuery({
    queryKey: ['feature-history', customer_id, feature.name],
    queryFn: () => featureStoreApi.history(customer_id, feature.name),
    enabled: customer_id.length > 0,
  });

  if (q.isLoading) {
    return (
      <Panel className="text-xs text-muted">
        <div className="font-medium text-ink mb-1">{feature.display_name}</div>
        <div>Loading…</div>
      </Panel>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Panel className="text-xs text-muted">
        <div className="font-medium text-ink mb-1">{feature.display_name}</div>
        <div className="text-danger">Failed to load</div>
      </Panel>
    );
  }
  const h = q.data;
  return (
    <Panel data-testid={`history-${feature.name}`} className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-ink">{feature.display_name}</div>
          <div className="text-[10px] text-muted font-mono">{feature.name}</div>
        </div>
        <TrendBadge trend={h.trend} polarity={feature.risk_polarity} />
      </div>
      <div className="h-16">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={h.points} margin={{ top: 2, right: 4, bottom: 2, left: 4 }}>
            <defs>
              <linearGradient id={`grad-${feature.name}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color.blue} stopOpacity={0.5} />
                <stop offset="100%" stopColor={color.blue} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[feature.range[0], feature.range[1]]} />
            <Tooltip
              formatter={(v: number) => fmtValue(feature, v)}
              labelFormatter={(l: string) => l.slice(0, 10)}
              contentStyle={{ fontSize: 10 }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={color.blue}
              strokeWidth={1.5}
              fill={`url(#grad-${feature.name})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 text-[10px]">
        <div>
          <div className="text-muted">min</div>
          <div className="font-mono">{h.min !== null ? fmtValue(feature, h.min) : '—'}</div>
        </div>
        <div>
          <div className="text-muted">mean</div>
          <div className="font-mono">{h.mean !== null ? fmtValue(feature, h.mean) : '—'}</div>
        </div>
        <div>
          <div className="text-muted">max</div>
          <div className="font-mono">{h.max !== null ? fmtValue(feature, h.max) : '—'}</div>
        </div>
      </div>
    </Panel>
  );
}

export function FeatureStorePage() {
  const [customerId, setCustomerId] = useState(DEFAULT_CUSTOMER_ID);
  const [pendingCustomerId, setPendingCustomerId] = useState(DEFAULT_CUSTOMER_ID);
  const [asOf, setAsOf] = useState<string>('');

  const catalogQ = useQuery({
    queryKey: ['feature-catalog'],
    queryFn: () => featureStoreApi.catalog(),
    staleTime: 60_000,
  });

  const coverageQ = useQuery({
    queryKey: ['feature-coverage'],
    queryFn: () => featureStoreApi.coverage(),
    staleTime: 60_000,
  });

  const snapshotQ = useQuery({
    queryKey: ['feature-snapshot', customerId, asOf],
    queryFn: () => featureStoreApi.snapshot(customerId, asOf || undefined),
    enabled: customerId.length > 0,
  });

  const features = catalogQ.data?.features ?? [];

  const featureByName = useMemo(() => {
    const m = new Map<FeatureName, FeatureDef>();
    for (const f of features) m.set(f.name, f);
    return m;
  }, [features]);

  function handleApply() {
    setCustomerId(pendingCustomerId.trim() || DEFAULT_CUSTOMER_ID);
  }

  return (
    <div className="space-y-4" data-testid="feature-store-page">
      <PageHeader
        title="Feature Store"
        subtitle="Point-in-time + time-series PD-model feature lookup · 24-month synthesis window"
      />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* ── Left: catalog + coverage ─────────────────────────────────── */}
        <div className="xl:col-span-3 space-y-4">
          <Panel
            title={
              <span className="inline-flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5" />
                Coverage
              </span>
            }
            data-testid="coverage-panel"
            className="text-xs"
          >
            {coverageQ.data ? (
              <div className="space-y-1">
                <div>
                  <span className="text-muted">Catalog: </span>
                  <span className="font-mono">{coverageQ.data.catalog_size}</span>
                </div>
                <div>
                  <span className="text-muted">Window: </span>
                  <span className="font-mono">{coverageQ.data.window_days}d</span>
                </div>
                <div>
                  <span className="text-muted">Earliest: </span>
                  <span className="font-mono">{coverageQ.data.earliest_observed_at.slice(0, 10)}</span>
                </div>
                <div>
                  <span className="text-muted">Latest: </span>
                  <span className="font-mono">{coverageQ.data.latest_observed_at.slice(0, 10)}</span>
                </div>
              </div>
            ) : (
              <div className="text-muted">Loading…</div>
            )}
          </Panel>
          <Panel title="Catalog" data-testid="catalog-panel">
            <ul className="space-y-1 text-xs">
              {features.map((f) => (
                <li key={f.name} data-testid={`catalog-${f.name}`} className="border-b border-divider/40 pb-1.5 last:border-0">
                  <div className="font-medium text-ink">{f.display_name}</div>
                  <div className="text-muted font-mono text-[10px]">{f.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="px-1 rounded bg-divider/40 text-[9px] uppercase">
                      {f.value_type}
                    </span>
                    {f.risk_polarity !== 'neutral' && (
                      <span
                        className={cn(
                          'px-1 rounded text-[9px]',
                          f.risk_polarity === 'higher_is_worse'
                            ? 'bg-danger/10 text-danger'
                            : 'bg-success/10 text-success',
                        )}
                      >
                        {f.risk_polarity === 'higher_is_worse' ? '↑ risky' : '↓ risky'}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        {/* ── Right: controls + snapshot + history ─────────────────────── */}
        <div className="xl:col-span-9 space-y-4">
          <Panel data-testid="controls-panel">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                handleApply();
              }}
            >
              <label className="flex-1 min-w-[200px]">
                <span className="label">Customer ID</span>
                <Input
                  data-testid="customer-id-input"
                  value={pendingCustomerId}
                  onChange={(e) => setPendingCustomerId(e.target.value)}
                  placeholder="CUST-1"
                />
              </label>
              <label className="flex-1 min-w-[200px]">
                <span className="label">As of (optional, ISO datetime)</span>
                <Input
                  data-testid="as-of-input"
                  type="datetime-local"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value ? `${e.target.value}:00.000Z` : '')}
                />
              </label>
              <Button type="submit" data-testid="apply-btn">
                <Search className="w-4 h-4" />
                Apply
              </Button>
            </form>
          </Panel>

          <Panel
            title="Point-in-time snapshot"
            data-testid="snapshot-panel"
            className="space-y-3"
          >
            {snapshotQ.isLoading && <div className="text-xs text-muted">Loading snapshot…</div>}
            {snapshotQ.isError && (
              <div className="text-xs text-danger" data-testid="snapshot-error">
                Failed to load snapshot. Check customer_id + as-of values.
              </div>
            )}
            {snapshotQ.data && (
              <>
                <div className="text-xs text-muted">
                  <span className="font-mono">{snapshotQ.data.entity_id}</span> @{' '}
                  <span className="font-mono">{snapshotQ.data.observed_at}</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {ALL_FEATURE_NAMES.map((name) => {
                    const def = featureByName.get(name);
                    if (!def) return null;
                    return (
                      <MetricCard
                        key={name}
                        testId={`snapshot-card-${name}`}
                        label={def.display_name}
                        value={fmtValue(def, snapshotQ.data!.features[name])}
                      />
                    );
                  })}
                </div>
              </>
            )}
          </Panel>

          <Panel
            title="24-month history per feature"
            data-testid="history-panel"
            className="space-y-2"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {features.map((f) => (
                <FeatureHistoryMiniChart key={f.name} feature={f} customer_id={customerId} />
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
