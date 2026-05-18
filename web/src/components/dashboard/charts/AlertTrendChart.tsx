// web/src/components/dashboard/charts/AlertTrendChart.tsx
//
// Reusable timeline chart for alert volume over `created_at`. Daily
// buckets, oldest-first. Click a point to drill into that day.
//
// Architecture parity with AlertBarChart: parent owns React Query,
// we just slice + render. Pure-function aggregation memoised.

import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { aggregateTimeline } from '@/lib/alertDimensions';
import type { Alert } from '@/lib/api';
import { color } from '@/styles/tokens';

export interface AlertTrendChartProps {
  alerts: readonly Alert[];
  selected?: string | null;
  onSelect?: (date: string | null) => void;
  testId?: string;
  height?: number;
}

export function AlertTrendChart({
  alerts,
  selected = null,
  onSelect,
  testId = 'alert-trend-chart',
  height = 220,
}: AlertTrendChartProps) {
  const series = useMemo(() => aggregateTimeline(alerts), [alerts]);

  if (series.length === 0) {
    return (
      <div
        data-testid={`${testId}-empty`}
        className="flex h-full min-h-[120px] items-center justify-center text-muted text-[12px]"
      >
        No timestamped alerts to plot.
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height }} data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={[...series]}
          onClick={(state) => {
            const date = (
              state as { activePayload?: { payload?: { date?: string } }[] }
            )?.activePayload?.[0]?.payload?.date;
            if (!date) return;
            onSelect?.(selected === date ? null : date);
          }}
        >
          <CartesianGrid stroke={color.divider} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            stroke={color.muted}
            fontSize={10}
            tickFormatter={(d: string) => d.slice(5)} // MM-DD
          />
          <YAxis stroke={color.muted} fontSize={11} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: color.surface,
              border: `1px solid ${color.divider}`,
              fontSize: 12,
            }}
            formatter={(v) => [Number(v).toLocaleString(), 'alerts']}
          />
          <Line
            type="monotone"
            dataKey="count"
            stroke={color.blue}
            strokeWidth={2}
            dot={(props) => {
              const { cx, cy, payload, index } = props as {
                cx: number;
                cy: number;
                payload: { date: string };
                index: number;
              };
              const isSelected = selected === payload.date;
              return (
                <circle
                  key={`dot-${index}`}
                  cx={cx}
                  cy={cy}
                  r={isSelected ? 5 : 3}
                  fill={color.blue}
                  stroke={isSelected ? color.danger : 'transparent'}
                  strokeWidth={isSelected ? 2 : 0}
                  cursor="pointer"
                  data-testid={`${testId}-dot-${payload.date}`}
                />
              );
            }}
            activeDot={{ r: 6, fill: color.blue, cursor: 'pointer' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
