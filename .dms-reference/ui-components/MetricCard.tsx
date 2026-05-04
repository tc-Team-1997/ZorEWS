import { cn } from '@/lib/cn';
import type { BadgeTone } from './Badge';

interface Props {
  label: string;
  value: string | number;
  sub?: string;
  tone?: BadgeTone;
}

const toneStyles: Record<BadgeTone, string> = {
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger:  'bg-danger-bg  text-danger',
  blue:    'bg-brand-skyLight text-brand-blue',
  purple:  'bg-purple-bg text-purple',
  neutral: 'bg-divider    text-ink-sub',
};

export function MetricCard({ label, value, sub, tone = 'neutral' }: Props) {
  return (
    <div className="card p-4 min-h-[96px]">
      <p className="text-xs text-muted mb-2">{label}</p>
      <p className="text-2xl font-bold text-ink leading-tight tabular">{value}</p>
      {sub && (
        <span className={cn('inline-block mt-2 rounded-[10px] px-2 py-[3px] text-[10px] font-medium', toneStyles[tone])}>
          {sub}
        </span>
      )}
    </div>
  );
}
