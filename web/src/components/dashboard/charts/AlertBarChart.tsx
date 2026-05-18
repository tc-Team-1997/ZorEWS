// web/src/components/dashboard/charts/AlertBarChart.tsx
//
// Reusable bar chart: same shape regardless of which dimension the
// caller asks for. Renders a stable-ordered axis (when supplied),
// fires onSelect(value) when a bar is clicked.
//
// Performance notes:
//   - aggregation is memoised against (alerts, dimension)
//   - the empty state short-circuits before paying for ResponsiveContainer
//   - parent owns React Query — we don't re-fetch on dimension switch

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ALERT_RISK_BANDS,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  aggregate,
  type AlertDimension,
} from '@/lib/alertDimensions';
import type { Alert } from '@/lib/api';
import { color } from '@/styles/tokens';

// Colour mapping shared with the existing dashboard so the new section
// reads as part of the same visual system.
const COLOR_BY_SEVERITY: Record<string, string> = {
  critical: color.danger,
  high: color.warning,
  medium: color.sky,
  low: color.success,
};

const COLOR_BY_STATUS: Record<string, string> = {
  open: color.danger,
  in_progress: color.warning,
  acked: color.success,
};

function fillFor(dim: AlertDimension, value: string): string {
  if (dim === 'severity' || dim === 'risk_band') {
    return COLOR_BY_SEVERITY[value] ?? color.blue;
  }
  if (dim === 'status') return COLOR_BY_STATUS[value] ?? color.blue;
  return color.blue;
}

function orderFor(dim: AlertDimension): readonly string[] | undefined {
  if (dim === 'severity') return ALERT_SEVERITIES;
  if (dim === 'risk_band') return ALERT_RISK_BANDS;
  if (dim === 'status') return ALERT_STATUSES;
  return undefined;
}

export interface AlertBarChartProps {
  alerts: readonly Alert[];
  dimension: AlertDimension;
  selected?: string | null;
  onSelect?: (value: string | null) => void;
  /** Test id appended to the chart container. Default: alert-bar-chart */
  testId?: string;
  /** Height in px. Default 220. */
  height?: number;
}

export function AlertBarChart({
  alerts,
  dimension,
  selected = null,
  onSelect,
  testId = 'alert-bar-chart',
  height = 220,
}: AlertBarChartProps) {
  const buckets = useMemo(
    () => aggregate(alerts, dimension, { order: orderFor(dimension) }),
    [alerts, dimension],
  );

  if (buckets.length === 0 || buckets.every((b) => b.count === 0)) {
    return (
      <div
        data-testid={`${testId}-empty`}
        className="flex h-full min-h-[120px] items-center justify-center text-muted text-[12px]"
      >
        No alerts in this window — nothing to chart yet.
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height }} data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={[...buckets]}
          onClick={(state) => {
            const value = (
              state as { activePayload?: { payload?: { value?: string } }[] }
            )?.activePayload?.[0]?.payload?.value;
            if (!value) return;
            onSelect?.(selected === value ? null : value);
          }}
        >
          <CartesianGrid stroke={color.divider} strokeDasharray="3 3" />
          <XAxis dataKey="value" stroke={color.muted} fontSize={11} interval={0} />
          <YAxis stroke={color.muted} fontSize={11} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: color.surface,
              border: `1px solid ${color.divider}`,
              fontSize: 12,
            }}
            formatter={(v) => [Number(v).toLocaleString(), 'alerts']}
            labelFormatter={(l) => String(l)}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]} cursor="pointer">
            {buckets.map((b) => (
              <Cell
                key={b.value}
                fill={fillFor(dimension, b.value)}
                opacity={selected && selected !== b.value ? 0.35 : 1}
                data-testid={`${testId}-cell-${b.value}`}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
