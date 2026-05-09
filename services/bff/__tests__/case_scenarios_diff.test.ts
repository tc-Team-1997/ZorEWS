// Pure diff helper for case_scenarios — used by the store to populate
// case_scenario_history.diff (T6 M14.18).

import { diffRows } from '../src/admin/case_scenarios_diff';

describe('diffRows (M14.18)', () => {
  const base = {
    name: 'A',
    case_category: 'fraud',
    priority: 'P1',
    trigger_indicator_id: null,
    trigger_threshold: null,
    default_escalation_id: 'e-1',
    notification_template_id: null,
    checklist: [{ title: 'Step 1', required: true }],
    status: 'DRAFT',
  };

  it('returns [] when nothing changed', () => {
    expect(diffRows(base, { ...base })).toEqual([]);
  });

  it('emits replace for a scalar change', () => {
    const after = { ...base, name: 'B' };
    expect(diffRows(base, after)).toEqual([{ op: 'replace', path: '/name', value: 'B' }]);
  });

  it('emits add when null → non-null', () => {
    const after = { ...base, trigger_indicator_id: 'FRD-001', trigger_threshold: 0.85 };
    expect(diffRows(base, after).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { op: 'add', path: '/trigger_indicator_id', value: 'FRD-001' },
      { op: 'add', path: '/trigger_threshold', value: 0.85 },
    ]);
  });

  it('emits remove when non-null → null', () => {
    const before = { ...base, notification_template_id: 't-1' };
    const after = { ...base };
    expect(diffRows(before, after)).toEqual([{ op: 'remove', path: '/notification_template_id' }]);
  });

  it('emits replace for a checklist deep-change (whole-array swap)', () => {
    const after = { ...base, checklist: [{ title: 'New step', required: false }] };
    const ops = diffRows(base, after);
    expect(ops).toEqual([
      {
        op: 'replace',
        path: '/checklist',
        value: [{ title: 'New step', required: false }],
      },
    ]);
  });

  it('does not emit a checklist op when only ordering of equal items differs (sanity)', () => {
    // Arrays compared by index; same content+order → no change.
    expect(diffRows(base, { ...base, checklist: [...base.checklist] })).toEqual([]);
  });

  it('handles before=null (brand new row) → all non-null fields become add', () => {
    const ops = diffRows(null, base);
    const paths = ops.map((o) => o.path).sort();
    expect(ops.every((o) => o.op === 'add')).toBe(true);
    // null fields (trigger_indicator_id, trigger_threshold, notification_template_id) excluded
    expect(paths).toEqual([
      '/case_category',
      '/checklist',
      '/default_escalation_id',
      '/name',
      '/priority',
      '/status',
    ]);
  });

  it('handles after=null (replay safety) → all non-null fields become remove', () => {
    const ops = diffRows(base, null);
    expect(ops.every((o) => o.op === 'remove')).toBe(true);
  });

  it('ignores fields outside the tracked set (e.g. updated_at)', () => {
    const ops = diffRows(
      { ...base, updated_at: '2026-05-01' },
      { ...base, updated_at: '2026-05-09' },
    );
    expect(ops).toEqual([]);
  });
});
