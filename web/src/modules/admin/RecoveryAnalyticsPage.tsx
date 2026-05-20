// web/src/modules/admin/RecoveryAnalyticsPage.tsx
//
// Recovery Center Phase 3 — operator analytics view. Consumes
// GET /v1/recovery/analytics?days=N. Renders:
//   - KPI tiles: archives / restores / purges in the window
//   - Days selector (7 / 30 / 90)
//   - Day-by-day stacked bar chart (archives / restores / purges)
//   - Cohort tile: restore_rate + purge_rate + time-to-restore stats
//   - Top actors leaderboard
//   - Per-entity_type table with outstanding_delta highlighting
//   - Per-module rollup
//
// Sibling page to /admin/recycle-bin. Both are admin-only; the
// Recycle Bin handles operational restore/purge work, this page
// answers "what's happening across the platform?"

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowLeft, BarChart3, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const WINDOW_OPTIONS: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

function fmtPct(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

function fmtHours(h: number | null): string {
  if (h === null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function RecoveryAnalyticsPage() {
  const qc = useQueryClient();
  const [days, setDays] = useState(30);

  const q = useQuery({
    queryKey: ['recovery-analytics', days],
    queryFn: () => api.recoveryAnalytics(days),
  });

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="Recovery Center · Analytics"
        subtitle="Daily archive / restore / purge volume + actor leaderboard + cohort restore rates."
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/admin/recycle-bin"
              className="text-[12px] text-muted hover:text-ink inline-flex items-center gap-1"
              data-testid="recovery-analytics-back-link"
            >
              <ArrowLeft className="h-4 w-4" /> Recycle Bin
            </Link>
            <Button
              variant="ghost"
              onClick={() =>
                qc.invalidateQueries({ queryKey: ['recovery-analytics', days] })
              }
              data-testid="recovery-analytics-refresh"
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </div>
        }
      />

      {/* Window selector */}
      <div className="flex items-center gap-1.5" data-testid="recovery-analytics-window-picker">
        <span className="text-[11px] text-muted mr-1">Window:</span>
        {WINDOW_OPTIONS.map((opt) => (
          <button
            key={opt.days}
            type="button"
            onClick={() => setDays(opt.days)}
            aria-pressed={days === opt.days}
            data-testid={`recovery-analytics-window-${opt.days}`}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              days === opt.days
                ? 'border-action bg-action/10 text-action'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {q.isLoading && (
        <div className="py-12 text-center text-[12px] text-muted">Loading…</div>
      )}
      {q.isError && (
        <div
          className="py-12 text-center text-[12px] text-danger"
          data-testid="recovery-analytics-error"
        >
          Couldn't load analytics.
        </div>
      )}

      {q.data && (
        <>
          {/* KPI strip */}
          <div
            className="grid grid-cols-2 sm:grid-cols-3 gap-3"
            data-testid="recovery-analytics-kpis"
          >
            <KpiTile
              label="Archives in window"
              value={q.data.total_archives_in_window.toLocaleString()}
              tone="warning"
            />
            <KpiTile
              label="Restores in window"
              value={q.data.total_restores_in_window.toLocaleString()}
              tone="success"
            />
            <KpiTile
              label="Purges in window"
              value={q.data.total_purges_in_window.toLocaleString()}
              tone="danger"
            />
          </div>

          {/* Daily volume chart */}
          <Panel
            title={
              <span className="flex items-center gap-2">
                <BarChart3 className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                Daily volume ({days} days)
              </span>
            }
          >
            <div data-testid="recovery-analytics-chart" style={{ width: '100%', height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={q.data.by_day.map((b) => ({
                    date: b.date.slice(5), // MM-DD
                    archived: b.by_status.archived,
                    restored: b.by_status.restored,
                    purged: b.by_status.purged,
                  }))}
                  margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="archived" stackId="a" fill="#f59e0b" />
                  <Bar dataKey="restored" stackId="a" fill="#10b981" />
                  <Bar dataKey="purged" stackId="a" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          {/* Cohort + time-to-restore */}
          <Panel title="Restore behaviour">
            <div
              className="grid grid-cols-2 sm:grid-cols-4 gap-3"
              data-testid="recovery-analytics-cohort"
            >
              <KpiTile label="Restore rate" value={fmtPct(q.data.restore_rate)} tone="success" />
              <KpiTile label="Purge rate" value={fmtPct(q.data.purge_rate)} tone="danger" />
              <KpiTile
                label="p50 time-to-restore"
                value={fmtHours(q.data.p50_time_to_restore_hours)}
                tone="muted"
              />
              <KpiTile
                label="p95 time-to-restore"
                value={fmtHours(q.data.p95_time_to_restore_hours)}
                tone="muted"
              />
            </div>
            {q.data.mean_time_to_restore_hours !== null && (
              <p className="mt-2 text-[11px] text-muted">
                Mean time-to-restore: <span className="text-ink">{fmtHours(q.data.mean_time_to_restore_hours)}</span>{' '}
                across {q.data.total_restores_in_window} restore
                {q.data.total_restores_in_window === 1 ? '' : 's'} in the window.
              </p>
            )}
            {q.data.restore_rate === null && (
              <p className="mt-2 text-[11px] text-muted">
                No archives in the window — restore/purge rates apply to the cohort of
                rows archived during the period.
              </p>
            )}
          </Panel>

          {/* Top actors leaderboard */}
          <Panel
            title={
              <span>
                Top operators{' '}
                <span className="text-muted font-normal text-[11px]">
                  · ranked by total ops
                </span>
              </span>
            }
          >
            {q.data.top_actors.length === 0 ? (
              <div
                className="py-6 text-center text-[12px] text-muted"
                data-testid="recovery-analytics-actors-empty"
              >
                No operator activity in the window.
              </div>
            ) : (
              <table className="w-full text-[12px]" data-testid="recovery-analytics-actors">
                <thead className="text-muted">
                  <tr className="border-b border-divider">
                    <th className="text-left py-1.5 font-medium">Operator</th>
                    <th className="text-right py-1.5 font-medium">Archives</th>
                    <th className="text-right py-1.5 font-medium">Restores</th>
                    <th className="text-right py-1.5 font-medium">Purges</th>
                    <th className="text-left py-1.5 font-medium pl-3">Last op</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.top_actors.map((a) => (
                    <tr
                      key={a.actor_username}
                      className="border-b border-divider/40 hover:bg-slate-50"
                      data-testid={`recovery-analytics-actor-${a.actor_username}`}
                    >
                      <td className="py-1.5 text-ink font-medium">{a.actor_username}</td>
                      <td className="py-1.5 text-right tabular">{a.total_archives}</td>
                      <td className="py-1.5 text-right tabular">{a.total_restores}</td>
                      <td className="py-1.5 text-right tabular">{a.total_purges}</td>
                      <td className="py-1.5 text-muted text-[11px] pl-3">
                        {new Date(a.most_recent_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Per-entity_type rollup */}
          <Panel
            title={
              <span>
                Per entity type{' '}
                <span className="text-muted font-normal text-[11px]">
                  · sorted by archive volume; outstanding = archives − restores
                </span>
              </span>
            }
          >
            {q.data.by_entity_type.length === 0 ? (
              <div
                className="py-6 text-center text-[12px] text-muted"
                data-testid="recovery-analytics-entities-empty"
              >
                No entity activity in the window.
              </div>
            ) : (
              <table className="w-full text-[12px]" data-testid="recovery-analytics-entities">
                <thead className="text-muted">
                  <tr className="border-b border-divider">
                    <th className="text-left py-1.5 font-medium">Entity type</th>
                    <th className="text-right py-1.5 font-medium">Archives</th>
                    <th className="text-right py-1.5 font-medium">Restores</th>
                    <th className="text-right py-1.5 font-medium">Purges</th>
                    <th className="text-right py-1.5 font-medium">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.by_entity_type.map((e) => (
                    <tr
                      key={e.entity_type}
                      className="border-b border-divider/40 hover:bg-slate-50"
                      data-testid={`recovery-analytics-entity-${e.entity_type}`}
                    >
                      <td className="py-1.5 text-ink">
                        <code className="bg-slate-100 px-1 rounded text-[11px]">
                          {e.entity_type}
                        </code>
                      </td>
                      <td className="py-1.5 text-right tabular">{e.total_archives}</td>
                      <td className="py-1.5 text-right tabular">{e.total_restores}</td>
                      <td className="py-1.5 text-right tabular">{e.total_purges}</td>
                      <td className="py-1.5 text-right tabular">
                        <Badge
                          tone={
                            e.outstanding_delta > 0
                              ? 'warning'
                              : e.outstanding_delta < 0
                                ? 'success'
                                : 'neutral'
                          }
                        >
                          {e.outstanding_delta > 0 ? '+' : ''}
                          {e.outstanding_delta}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Per-module rollup */}
          <Panel title="Per module">
            {q.data.by_module.length === 0 ? (
              <div className="py-4 text-center text-[12px] text-muted">
                No module activity in the window.
              </div>
            ) : (
              <table className="w-full text-[12px]" data-testid="recovery-analytics-modules">
                <thead className="text-muted">
                  <tr className="border-b border-divider">
                    <th className="text-left py-1.5 font-medium">Module</th>
                    <th className="text-right py-1.5 font-medium">Archives</th>
                    <th className="text-right py-1.5 font-medium">Restores</th>
                    <th className="text-right py-1.5 font-medium">Purges</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.by_module.map((m) => (
                    <tr key={m.module} className="border-b border-divider/40">
                      <td className="py-1.5 text-ink font-medium">{m.module}</td>
                      <td className="py-1.5 text-right tabular">{m.total_archives}</td>
                      <td className="py-1.5 text-right tabular">{m.total_restores}</td>
                      <td className="py-1.5 text-right tabular">{m.total_purges}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <p className="text-[10px] text-muted text-right">
            Window: {new Date(q.data.window_start).toLocaleDateString()} →{' '}
            {new Date(q.data.window_end).toLocaleDateString()} · Generated{' '}
            {new Date(q.data.generated_at).toLocaleTimeString()}
          </p>
        </>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: string;
  tone?: 'muted' | 'warning' | 'success' | 'danger';
}) {
  const cls =
    tone === 'warning'
      ? 'text-warning'
      : tone === 'success'
        ? 'text-success'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-ink';
  return (
    <div className="rounded-md border border-divider px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-[20px] tabular font-semibold mt-0.5 ${cls}`}>{value}</div>
    </div>
  );
}
