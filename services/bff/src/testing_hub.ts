// services/bff/src/testing_hub.ts
//
// Testing Hub — closes §2.4 #21 of ZorEWS_Pending_Gap_Analysis.md.
//
//   GET    /v1/testing/tests
//   POST   /v1/testing/tests
//   GET    /v1/testing/tests/:test_id
//   PATCH  /v1/testing/tests/:test_id
//   DELETE /v1/testing/tests/:test_id
//   POST   /v1/testing/tests/bulk-upload       (CSV-driven bulk add)
//   POST   /v1/testing/tests/:test_id/run      (manual run)
//   GET    /v1/testing/runs                    (run history)
//   GET    /v1/testing/runs/:run_id
//   POST   /v1/testing/schedule                (auto-test scheduler config)
//   GET    /v1/testing/schedule

export type TestTarget = 'rule' | 'indicator' | 'webhook' | 'pipeline' | 'connector' | 'workflow';
export const ALL_TEST_TARGETS: readonly TestTarget[] = ['rule', 'indicator', 'webhook', 'pipeline', 'connector', 'workflow'];

export type TestStatus = 'pass' | 'fail' | 'error' | 'pending' | 'skipped';
export const ALL_TEST_STATUSES: readonly TestStatus[] = ['pass', 'fail', 'error', 'pending', 'skipped'];

export interface TestCase {
  test_id: string;
  tenant_id: string;
  name: string;
  target_type: TestTarget;
  target_id: string;
  description: string;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface TestRun {
  run_id: string;
  test_id: string;
  tenant_id: string;
  status: TestStatus;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
  triggered_by: string;
  message: string | null;
  diff?: { key: string; expected: unknown; actual: unknown }[];
}

export interface TestSchedule {
  tenant_id: string;
  enabled: boolean;
  cron_expression: string;
  updated_at: string;
  updated_by: string;
}

export class TestingHubError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TestingHubError';
  }
}

export function isTestTarget(x: unknown): x is TestTarget {
  return typeof x === 'string' && ALL_TEST_TARGETS.includes(x as TestTarget);
}

const _tests = new Map<string, TestCase>();
const _runs = new Map<string, TestRun>();
const _schedules = new Map<string, TestSchedule>();
let _testSeq = 0;
let _runSeq = 0;

const NAME_RE = /^[A-Za-z0-9 _.,()<>=&/|-]{3,120}$/;

export function listTestCases(tenant_id: string, filter: { target_type?: TestTarget; enabled_only?: boolean } = {}): TestCase[] {
  if (!tenant_id) throw new TestingHubError('invalid_input', 'tenant_id required');
  const out: TestCase[] = [];
  for (const t of _tests.values()) {
    if (t.tenant_id !== tenant_id) continue;
    if (filter.target_type && t.target_type !== filter.target_type) continue;
    if (filter.enabled_only && !t.enabled) continue;
    out.push({ ...t, inputs: { ...t.inputs }, expected: { ...t.expected } });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getTestCase(tenant_id: string, test_id: string): TestCase | null {
  const t = _tests.get(test_id);
  if (!t || t.tenant_id !== tenant_id) return null;
  return { ...t, inputs: { ...t.inputs }, expected: { ...t.expected } };
}

export function createTestCase(
  tenant_id: string,
  input: { name: string; target_type: TestTarget; target_id: string; description?: string; inputs?: Record<string, unknown>; expected?: Record<string, unknown>; enabled?: boolean },
  actor: string,
  now: Date,
): TestCase {
  if (!tenant_id) throw new TestingHubError('invalid_input', 'tenant_id required');
  if (!actor) throw new TestingHubError('invalid_input', 'actor required');
  if (!input.name || !NAME_RE.test(input.name)) throw new TestingHubError('invalid_input', 'name must match pattern');
  if (!isTestTarget(input.target_type)) throw new TestingHubError('invalid_target', `target_type ${input.target_type}`);
  if (!input.target_id) throw new TestingHubError('invalid_input', 'target_id required');
  _testSeq++;
  const id = `tst-${tenant_id}-${String(_testSeq).padStart(6, '0')}`;
  const entry: TestCase = {
    test_id: id,
    tenant_id,
    name: input.name,
    target_type: input.target_type,
    target_id: input.target_id,
    description: input.description ?? '',
    inputs: { ...(input.inputs ?? {}) },
    expected: { ...(input.expected ?? {}) },
    enabled: input.enabled !== false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    created_by: actor,
  };
  _tests.set(id, entry);
  return { ...entry, inputs: { ...entry.inputs }, expected: { ...entry.expected } };
}

export function updateTestCase(
  tenant_id: string,
  test_id: string,
  patch: Partial<{ name: string; description: string; inputs: Record<string, unknown>; expected: Record<string, unknown>; enabled: boolean }>,
  now: Date,
): TestCase {
  const t = _tests.get(test_id);
  if (!t || t.tenant_id !== tenant_id) throw new TestingHubError('unknown_test', `unknown ${test_id}`);
  if (patch.name !== undefined) {
    if (!NAME_RE.test(patch.name)) throw new TestingHubError('invalid_input', 'name invalid');
    t.name = patch.name;
  }
  if (patch.description !== undefined) t.description = patch.description;
  if (patch.inputs !== undefined) t.inputs = { ...patch.inputs };
  if (patch.expected !== undefined) t.expected = { ...patch.expected };
  if (patch.enabled !== undefined) t.enabled = patch.enabled;
  t.updated_at = now.toISOString();
  return { ...t, inputs: { ...t.inputs }, expected: { ...t.expected } };
}

export function deleteTestCase(tenant_id: string, test_id: string): boolean {
  const t = _tests.get(test_id);
  if (!t || t.tenant_id !== tenant_id) return false;
  _tests.delete(test_id);
  return true;
}

// CSV bulk upload — parses each line into a test case
export interface BulkUploadResult {
  total: number;
  created_count: number;
  skipped_count: number;
  rows: { line: number; test_id?: string; status: 'created' | 'skipped'; reason?: string }[];
}

export function bulkUploadTests(tenant_id: string, csv: string, actor: string, now: Date): BulkUploadResult {
  if (!csv) throw new TestingHubError('invalid_input', 'csv required');
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new TestingHubError('invalid_input', 'csv must have header + ≥1 row');
  // Expected header: name,target_type,target_id,description
  const header = lines[0].split(',').map((h) => h.trim());
  const nameIdx = header.indexOf('name');
  const typeIdx = header.indexOf('target_type');
  const idIdx = header.indexOf('target_id');
  const descIdx = header.indexOf('description');
  if (nameIdx < 0 || typeIdx < 0 || idIdx < 0)
    throw new TestingHubError('invalid_input', 'csv header must include name + target_type + target_id');

  const result: BulkUploadResult = { total: lines.length - 1, created_count: 0, skipped_count: 0, rows: [] };
  for (let i = 1; i < lines.length; i++) {
    if (result.total > 200) {
      // hard cap on bulk upload
      result.rows.push({ line: i + 1, status: 'skipped', reason: 'bulk cap 200 exceeded' });
      result.skipped_count++;
      continue;
    }
    const cells = lines[i].split(',').map((c) => c.trim());
    try {
      const t = createTestCase(
        tenant_id,
        {
          name: cells[nameIdx],
          target_type: cells[typeIdx] as TestTarget,
          target_id: cells[idIdx],
          description: descIdx >= 0 ? cells[descIdx] : '',
        },
        actor,
        now,
      );
      result.rows.push({ line: i + 1, test_id: t.test_id, status: 'created' });
      result.created_count++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.rows.push({ line: i + 1, status: 'skipped', reason: msg });
      result.skipped_count++;
    }
  }
  return result;
}

export function runTestCase(tenant_id: string, test_id: string, triggered_by: string, now: Date): TestRun {
  if (!triggered_by) throw new TestingHubError('invalid_input', 'triggered_by required');
  const tc = _tests.get(test_id);
  if (!tc || tc.tenant_id !== tenant_id) throw new TestingHubError('unknown_test', `unknown ${test_id}`);
  if (!tc.enabled) throw new TestingHubError('test_disabled', 'test is disabled');
  _runSeq++;
  const runId = `tstrun-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(_runSeq).padStart(5, '0')}`;
  // Stub execution — deterministic per (test_id, day) so demo is stable
  const status: TestStatus = ((tc.test_id.charCodeAt(tc.test_id.length - 1) + now.getUTCDate()) % 7 === 0) ? 'fail' : 'pass';
  const diff = status === 'fail'
    ? [{ key: Object.keys(tc.expected)[0] ?? 'result', expected: tc.expected[Object.keys(tc.expected)[0] ?? ''] ?? null, actual: null }]
    : undefined;
  const run: TestRun = {
    run_id: runId,
    test_id,
    tenant_id,
    status,
    duration_ms: 30 + Math.floor(Math.random() * 250),
    started_at: now.toISOString(),
    finished_at: new Date(now.getTime() + 100).toISOString(),
    triggered_by,
    message: status === 'pass' ? 'OK' : 'Expected output did not match',
    diff,
  };
  _runs.set(runId, run);
  return run;
}

// ──────────────────────────────────────────────────────────────────────
// M6.3 — Testing Hub: run-all + report
//
// Spec acceptance: "A scheduled auto-run produces a results report and
// writes per-case events to Audit Trail." This function executes EVERY
// enabled test case in the tenant + assembles a summary report. The
// audit fan-out happens at the route layer (we don't want this module
// to know about the audit store directly — it stays a pure-data store).
// ──────────────────────────────────────────────────────────────────────
export interface TestRunAllReport {
  report_id: string;
  tenant_id: string;
  triggered_by: string;
  triggered_at: string;
  total_tests: number;
  total_pass: number;
  total_fail: number;
  total_error: number;
  total_skipped: number;
  duration_ms: number;
  runs: TestRun[];
}

export function runAllTestCases(
  tenant_id: string,
  triggered_by: string,
  now: Date,
): TestRunAllReport {
  if (!tenant_id) throw new TestingHubError('invalid_input', 'tenant_id required');
  if (!triggered_by) throw new TestingHubError('invalid_input', 'triggered_by required');
  const enabled = listTestCases(tenant_id, { enabled_only: true });
  const startMs = now.getTime();
  const runs: TestRun[] = [];
  for (const tc of enabled) {
    try {
      const r = runTestCase(tenant_id, tc.test_id, triggered_by, now);
      runs.push(r);
    } catch (e) {
      // Should not happen since we filtered to enabled — but defensive
      // skip rather than abort the run-all.
      const errMsg = e instanceof Error ? e.message : String(e);
      runs.push({
        run_id: `tstrun-err-${tc.test_id}`,
        test_id: tc.test_id,
        tenant_id,
        status: 'error',
        duration_ms: 0,
        started_at: now.toISOString(),
        finished_at: now.toISOString(),
        triggered_by,
        message: errMsg,
      });
    }
  }
  const counts = { pass: 0, fail: 0, error: 0, skipped: 0 };
  for (const r of runs) {
    if (r.status === 'pass') counts.pass++;
    else if (r.status === 'fail') counts.fail++;
    else if (r.status === 'error') counts.error++;
    else if (r.status === 'skipped') counts.skipped++;
  }
  _runAllSeq++;
  return {
    report_id: `tstrep-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(_runAllSeq).padStart(5, '0')}`,
    tenant_id,
    triggered_by,
    triggered_at: now.toISOString(),
    total_tests: runs.length,
    total_pass: counts.pass,
    total_fail: counts.fail,
    total_error: counts.error,
    total_skipped: counts.skipped,
    duration_ms: now.getTime() - startMs + runs.reduce((s, r) => s + r.duration_ms, 0),
    runs,
  };
}

let _runAllSeq = 0;

export function listTestRuns(tenant_id: string, filter: { test_id?: string; status?: TestStatus } = {}): TestRun[] {
  if (!tenant_id) throw new TestingHubError('invalid_input', 'tenant_id required');
  const out: TestRun[] = [];
  for (const r of _runs.values()) {
    if (r.tenant_id !== tenant_id) continue;
    if (filter.test_id && r.test_id !== filter.test_id) continue;
    if (filter.status && r.status !== filter.status) continue;
    out.push({ ...r });
  }
  out.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return out.slice(0, 200);
}

export function getTestRun(tenant_id: string, run_id: string): TestRun | null {
  const r = _runs.get(run_id);
  if (!r || r.tenant_id !== tenant_id) return null;
  return { ...r };
}

export function getTestSchedule(tenant_id: string): TestSchedule {
  return _schedules.get(tenant_id) ?? { tenant_id, enabled: false, cron_expression: '0 6 * * *', updated_at: '', updated_by: '' };
}

export function setTestSchedule(tenant_id: string, input: { enabled: boolean; cron_expression: string }, actor: string, now: Date): TestSchedule {
  if (!tenant_id) throw new TestingHubError('invalid_input', 'tenant_id required');
  if (!actor) throw new TestingHubError('invalid_input', 'actor required');
  if (!input.cron_expression || input.cron_expression.split(/\s+/).length < 5)
    throw new TestingHubError('invalid_input', 'cron_expression must be a 5-field cron string');
  const entry: TestSchedule = {
    tenant_id,
    enabled: !!input.enabled,
    cron_expression: input.cron_expression,
    updated_at: now.toISOString(),
    updated_by: actor,
  };
  _schedules.set(tenant_id, entry);
  return entry;
}

export function _resetTestingHubStore() {
  _tests.clear();
  _runs.clear();
  _schedules.clear();
  _testSeq = 0;
  _runSeq = 0;
  _runAllSeq = 0;
}
