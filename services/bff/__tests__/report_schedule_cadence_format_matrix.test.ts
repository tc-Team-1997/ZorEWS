// T6 M12.17 — Report schedule cadence × format cross-tab matrix.

import request from 'supertest';
import { buildReportScheduleCadenceFormatMatrix } from '../src/report_schedule_cadence_format_matrix';
import {
  VALID_CADENCES,
  InMemoryReportScheduleStore,
  type ReportScheduleEntry,
  type ReportScheduleStore,
  type ScheduleCadence,
} from '../src/report_schedules';
import { ALL_REPORT_FORMATS } from '../src/report_format_distribution';
import type { ReportFormat } from '../src/reports_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin', reportScheduleStore?: ReportScheduleStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    reportScheduleStore,
  });
}

let nextSchedSeq = 1;
function makeSchedule(
  cadence: ScheduleCadence,
  format: ReportFormat,
  enabled: boolean = true,
): ReportScheduleEntry {
  return {
    schedule_id: `sch-${String(nextSchedSeq++).padStart(4, '0')}`,
    tenant_id: 'BIL',
    report_id: 'portfolio_snapshot_daily',
    name: 'Test',
    cadence,
    format,
    hour_utc: 6,
    day_of_week: cadence === 'weekly' ? 1 : null,
    day_of_month: cadence === 'monthly' ? 1 : null,
    recipients: ['ops@bil.example.com'],
    enabled,
    parameters: {},
    created_by: 'alice',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    next_run_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
    last_run_at: null,
    tz: 'UTC',
  };
}

describe('M12.17 — buildReportScheduleCadenceFormatMatrix', () => {
  test('empty input → 20 empty cells + all marginals at 0', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_schedules).toBe(0);
    expect(m.total_enabled).toBe(0);
    expect(m.total_disabled).toBe(0);
    expect(m.total_cadences).toBe(5);
    expect(m.total_formats).toBe(4);
    expect(m.rows.length).toBe(5);
    expect(m.columns.length).toBe(4);
    for (const row of m.rows) {
      expect(row.total).toBe(0);
      expect(row.enabled_count).toBe(0);
      expect(row.disabled_count).toBe(0);
      expect(row.schedule_ids).toEqual([]);
      expect(row.formats_without.length).toBe(4);
    }
    for (const col of m.columns) {
      expect(col.total).toBe(0);
      expect(col.cadences_without.length).toBe(5);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_versatile_cadence).toBeNull();
    expect(m.most_universal_format).toBeNull();
    expect(m.empty_cells.length).toBe(20);
  });

  test('rows in canonical VALID_CADENCES order', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [], NOW);
    expect(m.rows.map((r) => r.cadence)).toEqual([...VALID_CADENCES]);
  });

  test('columns in canonical ALL_REPORT_FORMATS order', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [], NOW);
    expect(m.columns.map((c) => c.format)).toEqual([...ALL_REPORT_FORMATS]);
  });

  test('single schedule lands in correct cell', () => {
    const m = buildReportScheduleCadenceFormatMatrix(
      'BIL',
      [makeSchedule('daily', 'pdf')],
      NOW,
    );
    expect(m.total_schedules).toBe(1);
    expect(m.total_enabled).toBe(1);
    const dailyRow = m.rows.find((r) => r.cadence === 'daily')!;
    expect(dailyRow.total).toBe(1);
    expect(dailyRow.by_format.pdf).toBe(1);
    expect(dailyRow.enabled_count).toBe(1);
    expect(dailyRow.disabled_count).toBe(0);
    const pdfCol = m.columns.find((c) => c.format === 'pdf')!;
    expect(pdfCol.total).toBe(1);
    expect(pdfCol.by_cadence.daily).toBe(1);
    expect(pdfCol.enabled_count).toBe(1);
  });

  test('disabled schedule increments disabled_count only', () => {
    const m = buildReportScheduleCadenceFormatMatrix(
      'BIL',
      [makeSchedule('daily', 'pdf', false)],
      NOW,
    );
    expect(m.total_enabled).toBe(0);
    expect(m.total_disabled).toBe(1);
  });

  test('every by_format key present per row', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [makeSchedule('daily', 'pdf')], NOW);
    for (const row of m.rows) {
      for (const f of ALL_REPORT_FORMATS) {
        expect(row.by_format[f]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(row.by_format).length).toBe(4);
    }
  });

  test('every by_cadence key present per col', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [], NOW);
    for (const col of m.columns) {
      for (const c of VALID_CADENCES) {
        expect(col.by_cadence[c]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(col.by_cadence).length).toBe(5);
    }
  });

  test('Σ row.by_format = row.total partition', () => {
    const entries = [
      makeSchedule('daily', 'pdf'),
      makeSchedule('daily', 'csv'),
      makeSchedule('daily', 'pdf'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    for (const row of m.rows) {
      const sum = ALL_REPORT_FORMATS.reduce((a, f) => a + row.by_format[f], 0);
      expect(sum).toBe(row.total);
    }
  });

  test('Σ col.by_cadence = col.total partition', () => {
    const entries = [
      makeSchedule('daily', 'pdf'),
      makeSchedule('weekly', 'pdf'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    for (const col of m.columns) {
      const sum = VALID_CADENCES.reduce((a, c) => a + col.by_cadence[c], 0);
      expect(sum).toBe(col.total);
    }
  });

  test('grand-total Σ rows = Σ cols = total_schedules', () => {
    const entries = [
      makeSchedule('daily', 'pdf'),
      makeSchedule('weekly', 'csv'),
      makeSchedule('monthly', 'xlsx'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    const rowSum = m.rows.reduce((a, r) => a + r.total, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(m.total_schedules);
    expect(colSum).toBe(m.total_schedules);
    expect(rowSum).toBe(3);
  });

  test('cell cross-check row.by_format[X] === col[X].by_cadence[cadence]', () => {
    const entries = [
      makeSchedule('daily', 'pdf'),
      makeSchedule('daily', 'pdf'),
      makeSchedule('daily', 'csv'),
      makeSchedule('weekly', 'pdf'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    for (const row of m.rows) {
      for (const f of ALL_REPORT_FORMATS) {
        const fromRow = row.by_format[f];
        const col = m.columns.find((c) => c.format === f)!;
        const fromCol = col.by_cadence[row.cadence];
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('schedule_ids per row sorted asc + cross-format aggregation', () => {
    const entries = [
      makeSchedule('daily', 'pdf'),
      makeSchedule('daily', 'csv'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    const dailyRow = m.rows.find((r) => r.cadence === 'daily')!;
    expect(dailyRow.schedule_ids.length).toBe(2);
    const sorted = [...dailyRow.schedule_ids].sort((a, b) => a.localeCompare(b));
    expect(dailyRow.schedule_ids).toEqual(sorted);
  });

  test('schedule_ids per col sorted asc', () => {
    const entries = [
      makeSchedule('daily', 'pdf'),
      makeSchedule('weekly', 'pdf'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    const pdfCol = m.columns.find((c) => c.format === 'pdf')!;
    expect(pdfCol.schedule_ids.length).toBe(2);
    const sorted = [...pdfCol.schedule_ids].sort((a, b) => a.localeCompare(b));
    expect(pdfCol.schedule_ids).toEqual(sorted);
  });

  test('formats_without per row canonical order', () => {
    const m = buildReportScheduleCadenceFormatMatrix(
      'BIL',
      [makeSchedule('daily', 'pdf')],
      NOW,
    );
    const dailyRow = m.rows.find((r) => r.cadence === 'daily')!;
    expect(dailyRow.formats_without.length).toBe(3);
    expect(dailyRow.formats_without).toEqual(
      ALL_REPORT_FORMATS.filter((f) => f !== 'pdf'),
    );
  });

  test('cadences_without per col canonical order', () => {
    const m = buildReportScheduleCadenceFormatMatrix(
      'BIL',
      [makeSchedule('daily', 'pdf')],
      NOW,
    );
    const pdfCol = m.columns.find((c) => c.format === 'pdf')!;
    expect(pdfCol.cadences_without.length).toBe(4);
    expect(pdfCol.cadences_without).toEqual(
      VALID_CADENCES.filter((c) => c !== 'daily'),
    );
  });

  test('peak_cell formula', () => {
    const entries = [
      // daily/pdf: 3
      makeSchedule('daily', 'pdf'),
      makeSchedule('daily', 'pdf'),
      makeSchedule('daily', 'pdf'),
      // weekly/csv: 1
      makeSchedule('weekly', 'csv'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    expect(m.peak_cell).toEqual({ cadence: 'daily', format: 'pdf', count: 3 });
  });

  test('peak_cell canonical iteration tie-break', () => {
    const entries = [
      // Tied at 1: weekly/csv + monthly/json
      makeSchedule('weekly', 'csv'),
      makeSchedule('monthly', 'json'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    // Canonical iteration: cadences first (daily/weekly/monthly/...), then formats
    // weekly (#2 in VALID_CADENCES) iterates before monthly (#3) → weekly wins.
    expect(m.peak_cell?.cadence).toBe('weekly');
    expect(m.peak_cell?.format).toBe('csv');
  });

  test('peak_cell null on empty', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('most_versatile_cadence = highest distinct formats', () => {
    const entries = [
      // daily spans 3 formats
      makeSchedule('daily', 'pdf'),
      makeSchedule('daily', 'csv'),
      makeSchedule('daily', 'json'),
      // weekly in 1 format but 4 schedules
      makeSchedule('weekly', 'pdf'),
      makeSchedule('weekly', 'pdf'),
      makeSchedule('weekly', 'pdf'),
      makeSchedule('weekly', 'pdf'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    expect(m.most_versatile_cadence).toBe('daily');
  });

  test('most_versatile_cadence canonical tie-break', () => {
    const entries = [
      // daily + weekly each span 2 formats
      makeSchedule('daily', 'pdf'),
      makeSchedule('daily', 'csv'),
      makeSchedule('weekly', 'pdf'),
      makeSchedule('weekly', 'csv'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    // daily (#1) wins canonical tie-break over weekly (#2)
    expect(m.most_versatile_cadence).toBe('daily');
  });

  test('most_versatile_cadence null on empty', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [], NOW);
    expect(m.most_versatile_cadence).toBeNull();
  });

  test('most_universal_format = highest distinct cadences', () => {
    const entries = [
      // pdf spans 3 cadences
      makeSchedule('daily', 'pdf'),
      makeSchedule('weekly', 'pdf'),
      makeSchedule('monthly', 'pdf'),
      // csv in 1 cadence
      makeSchedule('daily', 'csv'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    expect(m.most_universal_format).toBe('pdf');
  });

  test('most_universal_format canonical tie-break (json wins at tied)', () => {
    const entries = [
      // json and csv each span 2 cadences
      makeSchedule('daily', 'json'),
      makeSchedule('weekly', 'json'),
      makeSchedule('daily', 'csv'),
      makeSchedule('weekly', 'csv'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    // json iterates first in ALL_REPORT_FORMATS → wins
    expect(m.most_universal_format).toBe('json');
  });

  test('most_universal_format null on empty', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [], NOW);
    expect(m.most_universal_format).toBeNull();
  });

  test('empty_cells in canonical cadence × format row-major order', () => {
    const entries = [
      makeSchedule('daily', 'pdf'),
      makeSchedule('weekly', 'csv'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    // 5×4 = 20 cells; 2 populated, 18 empty
    expect(m.empty_cells.length).toBe(18);
    // First should be (daily, json) (daily is first cadence; json is first format)
    expect(m.empty_cells[0]).toEqual({ cadence: 'daily', format: 'json' });
  });

  test('out-of-enum cadence skipped', () => {
    const entries = [
      { ...makeSchedule('daily', 'pdf'), cadence: 'bogus' as never },
      makeSchedule('weekly', 'csv'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    expect(m.total_schedules).toBe(1);
  });

  test('out-of-enum format skipped', () => {
    const entries = [
      { ...makeSchedule('daily', 'pdf'), format: 'bogus' as never },
      makeSchedule('weekly', 'csv'),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    expect(m.total_schedules).toBe(1);
  });

  test('mixed enabled/disabled cohort partition', () => {
    const entries = [
      makeSchedule('daily', 'pdf', true),
      makeSchedule('daily', 'pdf', true),
      makeSchedule('daily', 'pdf', false),
    ];
    const m = buildReportScheduleCadenceFormatMatrix('BIL', entries, NOW);
    expect(m.total_schedules).toBe(3);
    expect(m.total_enabled).toBe(2);
    expect(m.total_disabled).toBe(1);
    const dailyRow = m.rows.find((r) => r.cadence === 'daily')!;
    expect(dailyRow.enabled_count).toBe(2);
    expect(dailyRow.disabled_count).toBe(1);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildReportScheduleCadenceFormatMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

describe('M12.17 — GET /v1/reports/schedules/cadence-format-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin', new InMemoryReportScheduleStore());
    const r = await request(app)
      .get('/v1/reports/schedules/cadence-format-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_schedules).toBe(0);
    expect(r.body.body.rows.length).toBe(5);
    expect(r.body.body.columns.length).toBe(4);
  });

  test('populated reflects schedules', async () => {
    const store = new InMemoryReportScheduleStore();
    store.create(
      'BIL',
      {
        report_id: 'portfolio_snapshot_daily',
        name: 'Daily PDF',
        cadence: 'daily',
        format: 'pdf',
        hour_utc: 6,
        recipients: ['ops@bil.example.com'],
      },
      'alice',
      NOW,
    );
    store.create(
      'BIL',
      {
        report_id: 'portfolio_snapshot_daily',
        name: 'Daily PDF #2',
        cadence: 'daily',
        format: 'pdf',
        hour_utc: 8,
        recipients: ['ops@bil.example.com'],
      },
      'alice',
      NOW,
    );
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/reports/schedules/cadence-format-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_schedules).toBe(2);
    expect(r.body.body.peak_cell.cadence).toBe('daily');
    expect(r.body.body.peak_cell.format).toBe('pdf');
    expect(r.body.body.peak_cell.count).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner', new InMemoryReportScheduleStore());
    const r = await request(app)
      .get('/v1/reports/schedules/cadence-format-matrix')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryReportScheduleStore();
    store.create(
      'BIL',
      {
        report_id: 'portfolio_snapshot_daily',
        name: 'Daily PDF',
        cadence: 'daily',
        format: 'pdf',
        hour_utc: 6,
        recipients: ['ops@bil.example.com'],
      },
      'alice',
      NOW,
    );
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/reports/schedules/cadence-format-matrix')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_schedules).toBe(0);
  });

  test('M12.16 /recipient-distribution sibling regression still 200', async () => {
    const { app } = makeTestApp('admin', new InMemoryReportScheduleStore());
    const r = await request(app)
      .get('/v1/reports/schedules/recipient-distribution')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M12.9 /cadence-stats sibling regression still 200', async () => {
    const { app } = makeTestApp('admin', new InMemoryReportScheduleStore());
    const r = await request(app)
      .get('/v1/reports/schedules/cadence-stats')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
