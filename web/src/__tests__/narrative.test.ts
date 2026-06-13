import { describe, test, expect } from 'vitest';
import { buildExecutiveNarrative } from '@/lib/export/narrative';
import type { ReportData } from '@/lib/export/types';

function data(over: Partial<ReportData['sections']> = {}, subject?: { id: string; name: string }): ReportData {
  return {
    report_type: 'customer', module: 'customer_360', title: 'Customer Report',
    subject,
    meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin', generated_at: '2026-06-13T10:00:00Z', report_id: 'EXP-1' },
    sections: { summary: [], kpis: [], ...over },
    record_count: 0,
  };
}

describe('buildExecutiveNarrative', () => {
  test('names the subject + mentions KPIs', () => {
    const n = buildExecutiveNarrative(data(
      { kpis: [{ label: 'Open Alerts', value: '3' }, { label: 'Open Cases', value: '1' }] },
      { id: 'c-101', name: 'Acme Ltd' },
    ));
    expect(n).toContain('Acme Ltd');
    expect(n).toMatch(/Open Alerts: 3/);
    expect(n.length).toBeGreaterThan(20);
  });

  test('falls back to module title when no subject', () => {
    const n = buildExecutiveNarrative(data({ summary: [{ label: 'Total Alerts', value: '12' }] }));
    expect(n).toContain('Customer Report');
    expect(n).toContain('Total Alerts: 12');
  });

  test('handles empty sections without throwing', () => {
    const n = buildExecutiveNarrative(data());
    expect(typeof n).toBe('string');
    expect(n.length).toBeGreaterThan(0);
  });

  test('deterministic — same input yields same output', () => {
    const d = data({ kpis: [{ label: 'X', value: '5' }] }, { id: 'c-1', name: 'Z' });
    expect(buildExecutiveNarrative(d)).toBe(buildExecutiveNarrative(d));
  });
});
