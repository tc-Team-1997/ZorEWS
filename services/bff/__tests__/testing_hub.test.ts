// services/bff/__tests__/testing_hub.test.ts

import {
  ALL_TEST_TARGETS,
  ALL_TEST_STATUSES,
  listTestCases,
  getTestCase,
  createTestCase,
  updateTestCase,
  deleteTestCase,
  bulkUploadTests,
  runTestCase,
  listTestRuns,
  getTestSchedule,
  setTestSchedule,
  _resetTestingHubStore,
  TestingHubError,
} from '../src/testing_hub';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetTestingHubStore());

describe('enums', () => {
  it('6 targets / 5 statuses', () => {
    expect(ALL_TEST_TARGETS).toHaveLength(6);
    expect(ALL_TEST_STATUSES).toHaveLength(5);
  });
});

describe('CRUD', () => {
  it('create + list + get + update + delete', () => {
    const t = createTestCase('BANK_DEMO', { name: 'Test rule R-1', target_type: 'rule', target_id: 'R-1', inputs: { foo: 'bar' }, expected: { fires: true } }, 'alice', NOW);
    expect(t.test_id).toMatch(/^tst-BANK_DEMO-\d+$/);
    expect(t.enabled).toBe(true);
    expect(listTestCases('BANK_DEMO')).toHaveLength(1);
    expect(getTestCase('BANK_DEMO', t.test_id)).not.toBeNull();
    const u = updateTestCase('BANK_DEMO', t.test_id, { enabled: false }, NOW);
    expect(u.enabled).toBe(false);
    expect(deleteTestCase('BANK_DEMO', t.test_id)).toBe(true);
    expect(getTestCase('BANK_DEMO', t.test_id)).toBeNull();
  });

  it('filters by target_type + enabled_only', () => {
    createTestCase('BANK_DEMO', { name: 'r-1', target_type: 'rule', target_id: 'R-1' }, 'a', NOW);
    createTestCase('BANK_DEMO', { name: 'i-1', target_type: 'indicator', target_id: 'I-1', enabled: false }, 'a', NOW);
    expect(listTestCases('BANK_DEMO', { target_type: 'rule' })).toHaveLength(1);
    expect(listTestCases('BANK_DEMO', { enabled_only: true })).toHaveLength(1);
  });

  it('rejects bad target_type', () => {
    expect(() => createTestCase('BANK_DEMO', { name: 'X-1', target_type: 'bogus' as 'rule', target_id: 'R-1' }, 'a', NOW)).toThrow(TestingHubError);
  });

  it('cross-tenant operations are scoped', () => {
    const t = createTestCase('BANK_DEMO', { name: 'r-1', target_type: 'rule', target_id: 'R-1' }, 'a', NOW);
    expect(getTestCase('BIL', t.test_id)).toBeNull();
    expect(deleteTestCase('BIL', t.test_id)).toBe(false);
  });
});

describe('bulk upload', () => {
  it('parses CSV + creates rows + records skipped', () => {
    const csv = `name,target_type,target_id,description
Test alpha,rule,R-1,first
Test beta,indicator,I-1,second
Bad row,bogus_type,X,malformed`;
    const out = bulkUploadTests('BANK_DEMO', csv, 'alice', NOW);
    expect(out.total).toBe(3);
    expect(out.created_count).toBe(2);
    expect(out.skipped_count).toBe(1);
  });

  it('rejects missing required columns', () => {
    expect(() => bulkUploadTests('BANK_DEMO', `name\nA`, 'alice', NOW)).toThrow(TestingHubError);
  });

  it('rejects header-only csv', () => {
    expect(() => bulkUploadTests('BANK_DEMO', 'name,target_type,target_id', 'alice', NOW)).toThrow(TestingHubError);
  });
});

describe('runs', () => {
  it('run produces deterministic pass/fail + records run', () => {
    const t = createTestCase('BANK_DEMO', { name: 'r-1', target_type: 'rule', target_id: 'R-1', expected: { fires: true } }, 'a', NOW);
    const r = runTestCase('BANK_DEMO', t.test_id, 'alice', NOW);
    expect(['pass', 'fail']).toContain(r.status);
    expect(listTestRuns('BANK_DEMO', { test_id: t.test_id })).toHaveLength(1);
  });

  it('rejects run on disabled test', () => {
    const t = createTestCase('BANK_DEMO', { name: 'r-1', target_type: 'rule', target_id: 'R-1', enabled: false }, 'a', NOW);
    expect(() => runTestCase('BANK_DEMO', t.test_id, 'alice', NOW)).toThrow(/disabled/);
  });

  it('rejects unknown test + missing triggered_by', () => {
    const t = createTestCase('BANK_DEMO', { name: 'r-1', target_type: 'rule', target_id: 'R-1' }, 'a', NOW);
    expect(() => runTestCase('BANK_DEMO', 'bogus', 'alice', NOW)).toThrow(TestingHubError);
    expect(() => runTestCase('BANK_DEMO', t.test_id, '', NOW)).toThrow(TestingHubError);
  });
});

describe('schedule', () => {
  it('default off + set + retrieve', () => {
    expect(getTestSchedule('BANK_DEMO').enabled).toBe(false);
    setTestSchedule('BANK_DEMO', { enabled: true, cron_expression: '0 6 * * *' }, 'alice', NOW);
    expect(getTestSchedule('BANK_DEMO').enabled).toBe(true);
    expect(getTestSchedule('BANK_DEMO').cron_expression).toBe('0 6 * * *');
  });

  it('rejects invalid cron + missing actor', () => {
    expect(() => setTestSchedule('BANK_DEMO', { enabled: true, cron_expression: 'invalid' }, 'a', NOW)).toThrow(TestingHubError);
    expect(() => setTestSchedule('BANK_DEMO', { enabled: true, cron_expression: '0 6 * * *' }, '', NOW)).toThrow(TestingHubError);
  });
});
