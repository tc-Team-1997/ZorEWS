import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { BadgeTone } from './Badge';

/**
 * Aurora KPI card — premium glass surface (P0d primitive migration) with
 * optional sparkline + trend chip (P0h, per refined spec: "Add small trend
 * indicators, mini sparkline support"). All new props are additive optional
 * so every existing call site renders unchanged.
 */
export type TrendDirection = 'up' | 'down' | 'flat';
export type TrendTone = 'success' | 'danger' | 'neutral';

export interface MetricTrend {
  /** Direction picks the icon (TrendingUp / TrendingDown / Minus). */
  direction: TrendDirection;
  /** Display string (e.g. "+12%" / "-3.4%" / "0"). Rendered as-is. */
  value: string;
  /** Color tone for the chip background + text. Defaults derived from direction. */
  tone?: TrendTone;
}

interface Props {
  label: string;
  value: string | number;
  sub?: string;
  tone?: BadgeTone;
  /** When set, the card becomes a clickable link to this route. */
  to?: string;
  /** Override the auto-generated aria-label ("{label}: {value}"). */
  ariaLabel?: string;
  testId?: string;
  /** Optional trend chip rendered below the value. */
  trend?: MetricTrend;
  /** Optional numeric series → inline SVG sparkline below the value. */
  series?: readonly number[];
}

const toneStyles: Record<BadgeTone, string> = {
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger:  'bg-danger-bg  text-danger',
  blue:    'bg-brand-skyLight text-brand-blue',
  purple:  'bg-purple-bg text-purple',
  neutral: 'bg-divider    text-ink-sub',
};

const trendToneStyles: Record<TrendTone, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  danger:  'bg-rose-50    text-rose-700',
  neutral: 'bg-aurora-tint text-aurora-ink-sub',
};

/** Default tone from direction when caller doesn't override. */
function defaultTrendTone(d: TrendDirection): TrendTone {
  return d === 'up' ? 'success' : d === 'down' ? 'danger' : 'neutral';
}

/** Pure SVG sparkline path. Returns '' when series too short. */
export function buildSparkPath(series: readonly number[], width = 88, height = 24): string {
  if (series.length < 2) return '';
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const stepX = width / (series.length - 1);
  return series
    .map((v, i) => {
      const x = (i * stepX).toFixed(2);
      const y = ((height - 2) - ((v - min) / range) * (height - 4)).toFixed(2);
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');
}

function Sparkline({ series, stroke }: { series: readonly number[]; stroke: string }) {
  const W = 88;
  const H = 24;
  const path = buildSparkPath(series, W, H);
  if (!path) return null;
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="overflow-visible"
      aria-hidden="true"
      data-testid="metric-sparkline"
    >
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrendChip({ trend }: { trend: MetricTrend }) {
  const tone = trend.tone ?? defaultTrendTone(trend.direction);
  const Icon = trend.direction === 'up' ? TrendingUp : trend.direction === 'down' ? TrendingDown : Minus;
  return (
    <span
      data-testid="metric-trend"
      data-trend-direction={trend.direction}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        trendToneStyles[tone],
      )}
    >
      <Icon size={11} strokeWidth={2.25} aria-hidden="true" />
      <span className="tabular">{trend.value}</span>
    </span>
  );
}

export function MetricCard({ label, value, sub, tone = 'neutral', to, ariaLabel, testId, trend, series }: Props) {
  // Sparkline stroke color tracks the trend tone (success/danger/neutral),
  // falling back to aurora-indigo when no trend is provided.
  const sparkStroke = trend
    ? (trend.tone ?? defaultTrendTone(trend.direction)) === 'success'
      ? '#10B981'
      : (trend.tone ?? defaultTrendTone(trend.direction)) === 'danger'
        ? '#EF4444'
        : '#6366F1'
    : '#6366F1';

  const body = (
    <>
      <p className="text-xs text-aurora-ink-sub mb-2">{label}</p>
      <p className="text-2xl font-bold text-aurora-ink leading-tight tracking-tight tabular">{value}</p>
      {(trend || series) && (
        <div className="mt-2 flex items-center gap-2">
          {trend && <TrendChip trend={trend} />}
          {series && series.length >= 2 && <Sparkline series={series} stroke={sparkStroke} />}
        </div>
      )}
      {sub && (
        <span className={cn('inline-block mt-2 rounded-[10px] px-2 py-[3px] text-[10px] font-medium', toneStyles[tone])}>
          {sub}
        </span>
      )}
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        data-testid={testId}
        aria-label={ariaLabel ?? `${label}: ${value}`}
        className="card p-4 min-h-[96px] block transition-all hover:border-aurora-indigo/40 hover:shadow-float focus:outline-none focus:ring-2 focus:ring-aurora-indigo/30 focus:border-aurora-indigo/40 cursor-pointer no-underline"
      >
        {body}
      </Link>
    );
  }

  return (
    <div className="card p-4 min-h-[96px]" data-testid={testId}>
      {body}
    </div>
  );
}
