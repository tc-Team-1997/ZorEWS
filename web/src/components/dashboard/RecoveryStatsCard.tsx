// web/src/components/dashboard/RecoveryStatsCard.tsx
//
// Compact admin-only summary tile for the Recovery Center, mounted on
// the dashboard. Shows current archived/restored/purged counts + a
// deep-link into /admin/recycle-bin. Quietly renders nothing when the
// caller isn't admin so non-admin dashboards stay unchanged.
//
// Data flow:
//   - useAuth() → role check (admin only)
//   - api.recoveryStats() via React Query
//   - On error/empty: render an "empty" line so the panel chrome stays
//     consistent across all admins (not a layout-shifting null).

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Trash2, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel } from '@/components/ui';
import { useAuth } from '@/store/auth';

export function RecoveryStatsCard() {
  const { user } = useAuth();
  const isAdmin = user?.roles.includes('admin' as never) === true;

  // Always-call hook (Rules of Hooks); short-circuit afterwards.
  const q = useQuery({
    queryKey: ['recovery-stats'],
    queryFn: () => api.recoveryStats(),
    enabled: isAdmin,
    staleTime: 60_000,
  });

  if (!isAdmin) return null;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-slate-500" aria-hidden />
          Recovery Center
        </span>
      }
      action={
        <Link
          to="/admin/recycle-bin"
          className="inline-flex items-center gap-1 text-[11px] text-action hover:underline focus:outline-none focus:ring-2 focus:ring-action/30 rounded"
          data-testid="recovery-stats-card-open"
        >
          Open <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>
      }
      data-testid="recovery-stats-card"
    >
      {q.isLoading && (
        <div className="py-3 text-[12px] text-muted">Loading…</div>
      )}
      {q.isError && (
        <div className="py-3 text-[12px] text-danger" data-testid="recovery-stats-card-error">
          Couldn't load recovery stats.
        </div>
      )}
      {q.data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Stat label="Recoverable" value={q.data.by_status.archived} tone="warning" />
            <Stat label="Restored" value={q.data.by_status.restored} tone="success" />
            <Stat label="Permanently deleted" value={q.data.by_status.purged} tone="muted" />
          </div>
          {q.data.most_recent_at && (
            <p className="mt-2 text-[11px] text-muted" data-testid="recovery-stats-card-last">
              Most recent deletion: {new Date(q.data.most_recent_at).toLocaleString()}
            </p>
          )}
          {q.data.total === 0 && (
            <p
              className="mt-2 text-[11px] text-muted"
              data-testid="recovery-stats-card-empty"
            >
              No soft-deleted records yet across {q.data.adapters.length} adopting{' '}
              {q.data.adapters.length === 1 ? 'module' : 'modules'}.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'warning' | 'success' | 'muted';
}) {
  const cls =
    tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-ink';
  return (
    <div className="rounded-md border border-divider px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-[18px] tabular font-semibold mt-0.5 ${cls}`}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}
