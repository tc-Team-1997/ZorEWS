import { mergeSeverity, bucketFor } from '../src/severity';
import type { RiskLevel, Severity } from '../src/types';

describe('severity merge — FR-ALERT-2 matrix', () => {
  // rule severity rows × score level columns. critical always wins.
  const cases: Array<[Severity, RiskLevel | null, Severity]> = [
    ['low',      null,    'low'],
    ['low',      'Low',    'low'],
    ['low',      'Medium', 'medium'],
    ['low',      'High',   'high'],

    ['medium',   null,     'medium'],
    ['medium',   'Low',    'medium'],
    ['medium',   'Medium', 'medium'],
    ['medium',   'High',   'high'],

    ['high',     null,     'high'],
    ['high',     'Low',    'high'],
    ['high',     'Medium', 'high'],
    ['high',     'High',   'high'],

    ['critical', null,     'critical'],
    ['critical', 'Low',    'critical'],
    ['critical', 'Medium', 'critical'],
    ['critical', 'High',   'critical'],
  ];

  test.each(cases)(
    'mergeSeverity(rule=%s, score=%s) === %s',
    (rule, score, expected) => {
      expect(mergeSeverity(rule, score)).toBe(expected);
    },
  );

  test('bucket mapping: critical+high → critical; medium → medium; low → low', () => {
    expect(bucketFor('critical')).toBe('critical');
    expect(bucketFor('high')).toBe('critical');
    expect(bucketFor('medium')).toBe('medium');
    expect(bucketFor('low')).toBe('low');
  });
});
