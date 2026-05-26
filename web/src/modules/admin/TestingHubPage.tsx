// web/src/modules/admin/TestingHubPage.tsx
//
// M6.3 — Testing Hub
//
// Built-in test framework. QA owns the cases; no vendor change request
// needed to add a test. Composes the BFF /v1/testing/* surface:
//   - GET/POST /v1/testing/cases
//   - GET/PUT/DELETE /v1/testing/cases/:id
//   - POST /v1/testing/cases/:id/run
//   - POST /v1/testing/run-all       ← M6.3 NEW (per-case audit fan-out)
//   - POST /v1/testing/bulk-upload
//   - GET/POST /v1/testing/schedules
//   - GET /v1/testing/runs
//
// Spec acceptance proven: a scheduled / run-all run writes per-case
// events to the audit trail (verified by the BFF smoke).

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Beaker,
  CheckCircle2,
  Circle,
  Clock,
  Edit3,
  FileUp,
  Play,
  PlayCircle,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  ALL_TESTING_TARGETS,
  type TestingCase,
  type TestingCaseCreateInput,
  type TestingRun,
  type TestingRunAllReport,
  type TestingStatus,
  type TestingTarget,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const TARGET_LABELS: Record<TestingTarget, string> = {
  rule: 'Rule',
  indicator: 'Indicator',
  webhook: 'Webhook',
  pipeline: 'Pipeline',
  connector: 'Connector',
  workflow: 'Workflow',
};

function statusTone(s: TestingStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  if (s === 'pass') return 'success';
  if (s === 'fail') return 'danger';
  if (s === 'error') return 'danger';
  if (s === 'skipped') return 'warning';
  return 'neutral';
}

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function TestingHubPage() {
  const qc = useQueryClient();
  const [targetFilter, setTargetFilter] = useState<TestingTarget | ''>('');
  const [editing, setEditing] = useState<TestingCase | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [failureModal, setFailureModal] = useState<TestingRun | null>(null);
  const [lastReport, setLastReport] = useState<TestingRunAllReport | null>(null);

  const casesQ = useQuery({
    queryKey: ['testing.cases', targetFilter],
    queryFn: () => api.testingCasesList(targetFilter || undefined),
  });
  const runsQ = useQuery({
    queryKey: ['testing.runs'],
    queryFn: () => api.testingRuns(),
  });
  const schedQ = useQuery({
    queryKey: ['testing.schedules'],
    queryFn: () => api.testingSchedules(),
  });

  const cases = casesQ.data?.cases ?? [];
  const runs = runsQ.data?.runs ?? [];
  const schedule = schedQ.data?.schedules?.[0];

  // Map test_id → most-recent run for the library status column
  const lastRunByCase = useMemo(() => {
    const m = new Map<string, TestingRun>();
    for (const r of runs) {
      const existing = m.get(r.test_id);
      if (!existing || r.started_at > existing.started_at) m.set(r.test_id, r);
    }
    return m;
  }, [runs]);

  const runOneMut = useMutation({
    mutationFn: (case_id: string) => api.testingCaseRun(case_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['testing.runs'] });
    },
  });
  const runAllMut = useMutation({
    mutationFn: () => api.testingRunAll('manual'),
    onSuccess: (report) => {
      setLastReport(report);
      qc.invalidateQueries({ queryKey: ['testing.runs'] });
    },
  });
  const createMut = useMutation({
    mutationFn: (input: TestingCaseCreateInput) => api.testingCaseCreate(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['testing.cases'] });
      setCreating(false);
    },
  });
  const updateMut = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<TestingCaseCreateInput> & { enabled?: boolean };
    }) => api.testingCaseUpdate(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['testing.cases'] });
      setEditing(null);
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.testingCaseDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['testing.cases'] }),
  });
  const bulkMut = useMutation({
    mutationFn: (csv: string) => api.testingBulkUpload(csv),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['testing.cases'] });
      setBulkOpen(false);
    },
  });
  const scheduleMut = useMutation({
    mutationFn: (body: { enabled: boolean; cron_expression: string }) =>
      api.testingScheduleSet(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['testing.schedules'] }),
  });

  // KPI tiles
  const total = cases.length;
  const enabledCount = cases.filter((c) => c.enabled).length;
  const passCount = runs.filter((r) => r.status === 'pass').length;
  const failCount = runs.filter((r) => r.status === 'fail' || r.status === 'error').length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Testing Hub"
        subtitle="Built-in test framework — QA owns the test cases; results captured to the audit trail."
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setBulkOpen(true)}
              data-testid="th-bulk-btn"
            >
              <FileUp size={13} className="mr-1" />
              Bulk upload
            </Button>
            <Button
              variant="primary"
              onClick={() => runAllMut.mutate()}
              disabled={runAllMut.isPending || enabledCount === 0}
              data-testid="th-run-all-btn"
            >
              <PlayCircle size={14} className="mr-1" />
              {runAllMut.isPending ? 'Running…' : 'Run all'}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard testId="th-kpi-total" label="Test cases" value={String(total)} sub={`${enabledCount} enabled`} />
        <MetricCard testId="th-kpi-passes" label="Passes" value={String(passCount)} sub="Across history" tone="success" />
        <MetricCard testId="th-kpi-failures" label="Failures" value={String(failCount)} sub="Across history" tone={failCount > 0 ? 'danger' : 'neutral'} />
        <MetricCard
          testId="th-kpi-schedule"
          label="Auto-run schedule"
          value={schedule?.enabled ? 'ON' : 'OFF'}
          sub={schedule?.cron_expression ?? '—'}
          tone={schedule?.enabled ? 'success' : 'neutral'}
        />
      </div>

      {/* Last run report */}
      {lastReport && (
        <Panel title={`Last run-all report (${lastReport.report_id})`} action={
          <Button size="sm" variant="ghost" onClick={() => setLastReport(null)}>
            <X size={12} />
          </Button>
        }>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="th-last-report">
            <div className="rounded border border-divider px-3 py-2">
              <div className="text-xs text-muted">Total</div>
              <div className="text-lg font-semibold">{lastReport.total_tests}</div>
            </div>
            <div className="rounded border border-success/30 bg-success/5 px-3 py-2">
              <div className="text-xs text-muted">Passed</div>
              <div className="text-lg font-semibold text-success">{lastReport.total_pass}</div>
            </div>
            <div className="rounded border border-danger/30 bg-danger/5 px-3 py-2">
              <div className="text-xs text-muted">Failed</div>
              <div className="text-lg font-semibold text-danger">{lastReport.total_fail}</div>
            </div>
            <div className="rounded border border-warning/30 px-3 py-2">
              <div className="text-xs text-muted">Errored</div>
              <div className="text-lg font-semibold">{lastReport.total_error}</div>
            </div>
            <div className="rounded border border-divider px-3 py-2">
              <div className="text-xs text-muted">Duration</div>
              <div className="text-lg font-semibold">{lastReport.duration_ms} ms</div>
            </div>
          </div>
        </Panel>
      )}

      {/* Cases library */}
      <Panel
        title="Test case library"
        action={
          <div className="flex items-center gap-2">
            <select
              value={targetFilter}
              onChange={(e) => setTargetFilter(e.target.value as TestingTarget | '')}
              className="rounded border border-divider bg-surface px-2 py-1 text-xs"
              data-testid="th-filter-target"
            >
              <option value="">All targets</option>
              {ALL_TESTING_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {TARGET_LABELS[t]}
                </option>
              ))}
            </select>
            <Button size="sm" variant="primary" onClick={() => setCreating(true)} data-testid="th-new-case-btn">
              <Plus size={13} className="mr-1" />
              New case
            </Button>
          </div>
        }
      >
        {casesQ.isLoading && (
          <div className="h-20 w-full animate-pulse rounded bg-surface-alt" />
        )}
        {!casesQ.isLoading && cases.length === 0 && (
          <div className="text-sm text-muted" data-testid="th-cases-empty">
            No test cases yet. Add one with "New case" or import a batch
            via "Bulk upload".
          </div>
        )}
        {cases.length > 0 && (
          <div className="overflow-x-auto" data-testid="th-cases-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-3 py-2 font-medium">Last run</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {cases.map((tc) => {
                  const lastRun = lastRunByCase.get(tc.test_id);
                  return (
                    <tr
                      key={tc.test_id}
                      className="border-t border-divider"
                      data-testid={`th-case-row-${tc.test_id}`}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {tc.enabled ? (
                            <CheckCircle2 size={12} className="text-success" aria-hidden />
                          ) : (
                            <Circle size={12} className="text-muted" aria-hidden />
                          )}
                          <span className="font-medium text-ink">{tc.name}</span>
                        </div>
                        {tc.description && (
                          <div className="text-xs text-muted">{tc.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone="neutral">
                          {TARGET_LABELS[tc.target_type] ?? tc.target_type}
                        </Badge>{' '}
                        <code className="text-xs">{tc.target_id}</code>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {lastRun ? fmtTs(lastRun.started_at) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {lastRun ? (
                          <button
                            onClick={() => {
                              if (lastRun.status === 'fail' || lastRun.status === 'error') {
                                setFailureModal(lastRun);
                              }
                            }}
                            disabled={lastRun.status !== 'fail' && lastRun.status !== 'error'}
                            className="disabled:cursor-default"
                          >
                            <Badge tone={statusTone(lastRun.status)}>
                              {lastRun.status}
                            </Badge>
                          </button>
                        ) : (
                          <span className="text-xs text-muted">never run</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => runOneMut.mutate(tc.test_id)}
                            disabled={!tc.enabled || runOneMut.isPending}
                            data-testid={`th-run-${tc.test_id}`}
                            aria-label={`Run ${tc.name}`}
                            title="Run test"
                          >
                            <Play size={12} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditing(tc)}
                            data-testid={`th-edit-${tc.test_id}`}
                            aria-label={`Edit ${tc.name}`}
                            title="Edit test"
                          >
                            <Edit3 size={12} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (window.confirm(`Delete "${tc.name}"?`)) {
                                deleteMut.mutate(tc.test_id);
                              }
                            }}
                            data-testid={`th-delete-${tc.test_id}`}
                            aria-label={`Delete ${tc.name}`}
                            title="Delete test"
                          >
                            <Trash2 size={12} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Schedule panel */}
      <Panel
        title="Auto-run schedule"
        action={
          <Button
            size="sm"
            variant={schedule?.enabled ? 'secondary' : 'primary'}
            onClick={() => {
              if (!schedule) return;
              scheduleMut.mutate({
                enabled: !schedule.enabled,
                cron_expression: schedule.cron_expression,
              });
            }}
            disabled={scheduleMut.isPending || !schedule}
            data-testid="th-schedule-toggle"
          >
            <Clock size={13} className="mr-1" />
            {schedule?.enabled ? 'Disable' : 'Enable'}
          </Button>
        }
      >
        {schedule && (
          <div className="text-sm" data-testid="th-schedule-detail">
            Status:{' '}
            <Badge tone={schedule.enabled ? 'success' : 'neutral'}>
              {schedule.enabled ? 'enabled' : 'disabled'}
            </Badge>{' '}
            · Cron: <code className="text-xs">{schedule.cron_expression}</code>
            {schedule.updated_at && (
              <span className="ml-2 text-xs text-muted">
                last changed {fmtTs(schedule.updated_at)} by {schedule.updated_by || 'system'}
              </span>
            )}
          </div>
        )}
      </Panel>

      {creating && (
        <CaseModal
          title="New test case"
          testid="th-create-modal"
          onClose={() => setCreating(false)}
          onSubmit={(input) => createMut.mutate(input)}
          submitting={createMut.isPending}
        />
      )}
      {editing && (
        <CaseModal
          title={`Edit ${editing.name}`}
          testid="th-edit-modal"
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={(input) =>
            updateMut.mutate({
              id: editing.test_id,
              patch: {
                name: input.name,
                description: input.description,
                inputs: input.inputs,
                expected: input.expected,
                enabled: input.enabled,
              },
            })
          }
          submitting={updateMut.isPending}
        />
      )}
      {bulkOpen && (
        <BulkUploadModal
          onClose={() => setBulkOpen(false)}
          onSubmit={(csv) => bulkMut.mutate(csv)}
          submitting={bulkMut.isPending}
        />
      )}
      {failureModal && (
        <FailureModal run={failureModal} onClose={() => setFailureModal(null)} />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Modals
// ──────────────────────────────────────────────────────────────────────

function CaseModal({
  title,
  testid,
  initial,
  onClose,
  onSubmit,
  submitting,
}: {
  title: string;
  testid: string;
  initial?: TestingCase;
  onClose: () => void;
  onSubmit: (input: TestingCaseCreateInput) => void;
  submitting: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [targetType, setTargetType] = useState<TestingTarget>(initial?.target_type ?? 'rule');
  const [targetId, setTargetId] = useState(initial?.target_id ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [inputsJson, setInputsJson] = useState(
    JSON.stringify(initial?.inputs ?? {}, null, 2),
  );
  const [expectedJson, setExpectedJson] = useState(
    JSON.stringify(initial?.expected ?? {}, null, 2),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    let inputs: Record<string, unknown>;
    let expected: Record<string, unknown>;
    try {
      inputs = JSON.parse(inputsJson);
      expected = JSON.parse(expectedJson);
    } catch (e) {
      setError(`Inputs/Expected must be valid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
      return;
    }
    onSubmit({ name, target_type: targetType, target_id: targetId, description, inputs, expected, enabled });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      data-testid={testid}
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-divider px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Beaker size={16} className="text-action" aria-hidden />
            {title}
          </h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-divider/30" aria-label="close">
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <label className="block">
            <span className="block text-xs font-semibold text-muted">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
              data-testid={`${testid}-name`}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-xs font-semibold text-muted">Target type</span>
              <select
                value={targetType}
                onChange={(e) => setTargetType(e.target.value as TestingTarget)}
                className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                disabled={!!initial}
                data-testid={`${testid}-target-type`}
              >
                {ALL_TESTING_TARGETS.map((t) => (
                  <option key={t} value={t}>
                    {TARGET_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-muted">Target ID</span>
              <input
                type="text"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                disabled={!!initial}
                className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm font-mono"
                placeholder="e.g. RULE-001"
                data-testid={`${testid}-target-id`}
              />
            </label>
          </div>
          <label className="block">
            <span className="block text-xs font-semibold text-muted">Description</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
              data-testid={`${testid}-description`}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-muted">
              Inputs (JSON)
            </span>
            <textarea
              value={inputsJson}
              onChange={(e) => setInputsJson(e.target.value)}
              rows={4}
              className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-xs font-mono"
              data-testid={`${testid}-inputs`}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-muted">
              Expected (JSON)
            </span>
            <textarea
              value={expectedJson}
              onChange={(e) => setExpectedJson(e.target.value)}
              rows={4}
              className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-xs font-mono"
              data-testid={`${testid}-expected`}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              data-testid={`${testid}-enabled`}
            />
            <span className="text-sm">Enabled (included in Run all)</span>
          </label>
          {error && (
            <p className="text-xs text-danger" data-testid={`${testid}-error`}>
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-divider px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={submitting} onClick={handleSubmit} data-testid={`${testid}-submit`}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function BulkUploadModal({
  onClose,
  onSubmit,
  submitting,
}: {
  onClose: () => void;
  onSubmit: (csv: string) => void;
  submitting: boolean;
}) {
  const [csv, setCsv] = useState('name,target_type,target_id,description\nMy test,rule,RULE-001,Example');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      data-testid="th-bulk-modal"
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-divider px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <FileUp size={16} className="text-action" aria-hidden />
            Bulk upload tests (CSV)
          </h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-divider/30" aria-label="close">
            <X size={14} />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="mb-2 text-xs text-muted">
            CSV columns: <code>name,target_type,target_id,description</code>. First row
            is the header.
          </p>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={10}
            className="w-full rounded border border-divider bg-surface px-2 py-1 text-xs font-mono"
            data-testid="th-bulk-textarea"
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-divider px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={submitting} onClick={() => onSubmit(csv)} data-testid="th-bulk-submit">
            {submitting ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FailureModal({ run, onClose }: { run: TestingRun; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      data-testid="th-failure-modal"
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-divider px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Beaker size={16} className="text-danger" aria-hidden />
            Test failure
          </h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-divider/30" aria-label="close">
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="text-sm">
            <Badge tone={statusTone(run.status)}>{run.status}</Badge>
            <span className="ml-2 text-xs text-muted">
              run {run.run_id} · {run.duration_ms} ms · started {fmtTs(run.started_at)}
            </span>
          </div>
          {run.message && (
            <p className="rounded bg-divider/20 p-2 text-sm text-ink">{run.message}</p>
          )}
          {run.diff && run.diff.length > 0 && (
            <div className="space-y-1" data-testid="th-failure-diff">
              <div className="text-xs font-semibold text-muted">Assertion diff</div>
              {run.diff.map((d, idx) => (
                <div key={idx} className="rounded border border-divider px-2 py-1 text-xs">
                  <code className="font-mono">{d.key}</code>:{' '}
                  <span className="text-success">expected {JSON.stringify(d.expected)}</span>{' '}
                  · <span className="text-danger">actual {JSON.stringify(d.actual)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end border-t border-divider px-5 py-3">
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
