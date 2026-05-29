// web/src/modules/admin/JobSchedulerConfigPage.tsx
//
// Configuration — Job & Scheduler Config (MASTER SETUP spec screen #19).
//
// A single consolidated ops view of every scheduled platform job (ingestion /
// reporting / ml / workflow / data_quality / system) with frequency,
// last-run-status, enable toggle, and a run-now trigger. Today these jobs live
// scattered across ingestion connectors, report schedules, AI retraining, and
// the escalation worker — this screen unifies them.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, History, Pause, Play, PlayCircle, RefreshCw, X } from 'lucide-react';
import { Badge, Button, MetricCard, Modal, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  api,
  type JobCategoryShape,
  type JobFrequencyShape,
  type JobRunStatusShape,
  type ScheduledJobShape,
} from '@/lib/api';

const CATEGORIES: (JobCategoryShape | 'all')[] = ['all', 'ingestion', 'reporting', 'ml', 'workflow', 'data_quality', 'system'];
const FREQUENCIES: JobFrequencyShape[] = ['realtime', 'every_5min', 'every_15min', 'hourly', 'every_6h', 'daily', 'weekly', 'monthly'];
const FREQ_LABEL: Record<JobFrequencyShape, string> = {
  realtime: 'Realtime',
  every_5min: 'Every 5 min',
  every_15min: 'Every 15 min',
  hourly: 'Hourly',
  every_6h: 'Every 6 h',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};
const STATUS_TONE: Record<JobRunStatusShape, 'success' | 'danger' | 'warning' | 'blue' | 'neutral'> = {
  success: 'success',
  failure: 'danger',
  partial: 'warning',
  running: 'blue',
  never_run: 'neutral',
};

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function JobSchedulerConfigPage() {
  const qc = useQueryClient();
  const [category, setCategory] = useState<JobCategoryShape | 'all'>('all');
  const [historyJob, setHistoryJob] = useState<ScheduledJobShape | null>(null);

  const user = useAuth((s) => s.user);
  const canEdit = user?.roles.includes('admin') ?? false;

  const jobsQ = useQuery({
    queryKey: ['jsc-jobs', category],
    queryFn: () => api.scheduledJobs(category === 'all' ? {} : { category }),
  });
  const summaryQ = useQuery({ queryKey: ['jsc-summary'], queryFn: () => api.scheduledJobSummary() });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['jsc-jobs'] });
    qc.invalidateQueries({ queryKey: ['jsc-summary'] });
  };

  const updateMut = useMutation({
    mutationFn: ({ job_id, patch }: { job_id: string; patch: { enabled?: boolean; frequency?: JobFrequencyShape } }) =>
      api.scheduledJobUpdate(job_id, patch),
    onSuccess: invalidate,
  });
  const runMut = useMutation({
    mutationFn: (job_id: string) => api.scheduledJobRun(job_id),
    onSuccess: invalidate,
  });

  const jobs = jobsQ.data?.jobs ?? [];
  const summary = summaryQ.data;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Job & Scheduler Config"
        subtitle="Every scheduled platform job — frequency · last run · controls"
        actions={
          <Button variant="ghost" onClick={invalidate} data-testid="jsc-refresh">
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Total jobs" value={String(summary?.total_jobs ?? 0)} testId="jsc-kpi-total" />
        <MetricCard label="Enabled" value={String(summary?.enabled_count ?? 0)} tone="success" testId="jsc-kpi-enabled" />
        <MetricCard label="Failing" value={String(summary?.failing_count ?? 0)} tone={summary && summary.failing_count > 0 ? 'danger' : 'success'} testId="jsc-kpi-failing" />
        <MetricCard label="Overdue" value={String(summary?.overdue_count ?? 0)} tone={summary && summary.overdue_count > 0 ? 'warning' : 'success'} testId="jsc-kpi-overdue" />
      </div>

      {summary && summary.attention_required.length > 0 && (
        <div className="rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning" data-testid="jsc-attention">
          <AlertTriangle size={14} className="inline mr-1" />
          {summary.attention_required.length} job{summary.attention_required.length === 1 ? '' : 's'} need attention:{' '}
          {summary.attention_required.slice(0, 3).map((a) => a.name).join(', ')}
          {summary.attention_required.length > 3 && ` +${summary.attention_required.length - 3} more`}
        </div>
      )}

      <Panel
        title="Scheduled jobs"
        action={
          <div className="flex flex-wrap items-center gap-1">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                data-testid={`jsc-filter-${c}`}
                className={`rounded px-2 py-1 text-xs font-medium ${
                  category === c ? 'bg-action text-white' : 'text-muted hover:text-ink'
                }`}
              >
                {c === 'all' ? 'All' : c}
              </button>
            ))}
          </div>
        }
      >
        {jobsQ.isLoading ? (
          <p className="text-sm text-muted">Loading jobs…</p>
        ) : jobs.length === 0 ? (
          <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted" data-testid="jsc-empty">
            No jobs in this category.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="jsc-table">
            <thead className="text-left text-xs uppercase text-muted">
              <tr className="border-b border-divider/40">
                <th className="py-2">Job</th>
                <th className="w-28">Category</th>
                <th className="w-32">Frequency</th>
                <th className="w-28">Last run</th>
                <th className="w-40">Next run</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <JobRow
                  key={j.job_id}
                  j={j}
                  canEdit={canEdit}
                  onFreq={(frequency) => updateMut.mutate({ job_id: j.job_id, patch: { frequency } })}
                  onToggle={(enabled) => updateMut.mutate({ job_id: j.job_id, patch: { enabled } })}
                  onRun={() => runMut.mutate(j.job_id)}
                  onHistory={() => setHistoryJob(j)}
                  running={runMut.isPending && runMut.variables === j.job_id}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {historyJob && <JobHistoryModal job={historyJob} onClose={() => setHistoryJob(null)} />}
    </div>
  );
}

function JobRow({
  j,
  canEdit,
  onFreq,
  onToggle,
  onRun,
  onHistory,
  running,
}: {
  j: ScheduledJobShape;
  canEdit: boolean;
  onFreq: (f: JobFrequencyShape) => void;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onHistory: () => void;
  running: boolean;
}) {
  return (
    <tr className={`border-b border-divider/40 hover:bg-divider/10 ${!j.enabled ? 'opacity-60' : ''}`} data-testid={`jsc-row-${j.job_id}`}>
      <td className="py-2">
        <div className="font-medium">{j.name}</div>
        <div className="text-xs text-muted">{j.owner_service} · {j.description}</div>
      </td>
      <td className="text-xs">{j.category}</td>
      <td>
        {canEdit ? (
          <select
            value={j.frequency}
            onChange={(e) => onFreq(e.target.value as JobFrequencyShape)}
            className="rounded border border-divider px-1 py-0.5 text-xs"
            data-testid={`jsc-freq-${j.job_id}`}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQ_LABEL[f]}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs">{FREQ_LABEL[j.frequency]}</span>
        )}
      </td>
      <td>
        <span data-testid={`jsc-status-${j.job_id}`}>
          <Badge tone={STATUS_TONE[j.last_run_status]}>{j.last_run_status}</Badge>
        </span>
        {j.consecutive_failures > 0 && <div className="text-xs text-rose-600 mt-0.5">×{j.consecutive_failures}</div>}
      </td>
      <td className="text-xs text-muted">{j.enabled ? fmtWhen(j.next_run_at) : 'paused'}</td>
      <td className="text-right">
        <div className="flex justify-end gap-1">
          <Button variant="ghost" onClick={onHistory} aria-label={`Run history for ${j.name}`} data-testid={`jsc-history-${j.job_id}`}>
            <History size={14} />
          </Button>
          {canEdit && (
            <>
              <Button
                variant="ghost"
                onClick={onRun}
                disabled={!j.enabled || running}
                aria-label={`Run ${j.name} now`}
                data-testid={`jsc-run-${j.job_id}`}
              >
                <PlayCircle size={14} />
              </Button>
              <Button
                variant="ghost"
                onClick={() => onToggle(!j.enabled)}
                aria-label={j.enabled ? `Pause ${j.name}` : `Resume ${j.name}`}
                data-testid={`jsc-toggle-${j.job_id}`}
              >
                {j.enabled ? <Pause size={14} /> : <Play size={14} className="text-emerald-600" />}
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function JobHistoryModal({ job, onClose }: { job: ScheduledJobShape; onClose: () => void }) {
  const runsQ = useQuery({ queryKey: ['jsc-runs', job.job_id], queryFn: () => api.scheduledJobRuns(job.job_id, 20) });
  const statsQ = useQuery({ queryKey: ['jsc-run-stats', job.job_id], queryFn: () => api.scheduledJobRunStats(job.job_id) });
  const stats = statsQ.data;
  const runs = runsQ.data?.runs ?? [];

  return (
    <Modal open onClose={onClose} ariaLabel={`Run history — ${job.name}`} size="lg" testId="jsc-history-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{job.name}</h2>
            <p className="text-xs text-muted">{job.owner_service} · {job.category}</p>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </Button>
        </header>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Total runs" value={String(stats?.total_runs ?? 0)} testId="jsc-stats-total" />
          <MetricCard
            label="Success rate"
            value={stats?.success_rate != null ? `${Math.round(stats.success_rate * 100)}%` : '—'}
            tone={stats && stats.success_rate != null && stats.success_rate >= 0.9 ? 'success' : stats && stats.success_rate != null && stats.success_rate >= 0.7 ? 'warning' : 'danger'}
            testId="jsc-stats-success"
          />
          <MetricCard label="Mean duration" value={stats?.mean_duration_ms != null ? `${stats.mean_duration_ms} ms` : '—'} testId="jsc-stats-duration" />
          <MetricCard label="Last status" value={stats?.last_status ?? 'never_run'} tone={stats?.last_status ? STATUS_TONE[stats.last_status] : 'neutral'} testId="jsc-stats-last" />
        </div>

        {runsQ.isLoading ? (
          <p className="text-sm text-muted">Loading runs…</p>
        ) : runs.length === 0 ? (
          <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted" data-testid="jsc-history-empty">
            No runs recorded yet — this job has never run.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="jsc-history-table">
            <thead className="text-left text-xs uppercase text-muted">
              <tr className="border-b border-divider/40">
                <th className="py-2">Status</th>
                <th>Triggered by</th>
                <th className="w-44">Ran at</th>
                <th className="w-28">Duration</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.run_id} className="border-b border-divider/40" data-testid={`jsc-history-row-${r.run_id}`}>
                  <td className="py-1.5">
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  </td>
                  <td className="text-xs">{r.triggered_by}</td>
                  <td className="text-xs text-muted">{fmtWhen(r.ran_at)}</td>
                  <td className="text-xs font-mono">{r.duration_ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
