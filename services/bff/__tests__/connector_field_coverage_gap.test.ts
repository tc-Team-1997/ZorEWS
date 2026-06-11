// @ts-nocheck
import { buildConnectorFieldCoverageGap } from '../src/connector_field_coverage_gap';
import { listSchemaConnectorIds } from '../src/connector_schema';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildConnectorFieldCoverageGap', () => {
  it('returns report with generated_at', () => {
    const report = buildConnectorFieldCoverageGap(NOW);
    expect(report.generated_at).toBeDefined();
  });

  it('total_connectors matches catalog size', () => {
    const report = buildConnectorFieldCoverageGap(NOW);
    expect(report.total_connectors).toBe(listSchemaConnectorIds().length);
  });

  it('total_gaps matches gaps array length', () => {
    const report = buildConnectorFieldCoverageGap(NOW);
    expect(report.total_gaps).toBe(report.gaps.length);
  });

  it('each gap has required fields', () => {
    const report = buildConnectorFieldCoverageGap(NOW);
    for (const gap of report.gaps) {
      expect(gap.connector_id).toBeDefined();
      expect(gap.field_name).toBeDefined();
      expect(gap.field_type).toBeDefined();
      expect(['optional_no_default', 'missing_sample']).toContain(gap.gap_reason);
    }
  });

  it('connectors_with_gaps is subset of all connectors', () => {
    const report = buildConnectorFieldCoverageGap(NOW);
    const all = listSchemaConnectorIds();
    for (const cid of report.connectors_with_gaps) {
      expect(all).toContain(cid);
    }
  });

  it('connectors_with_gaps only includes connectors that have gaps', () => {
    const report = buildConnectorFieldCoverageGap(NOW);
    const gapped = new Set(report.gaps.map(g => g.connector_id));
    for (const cid of report.connectors_with_gaps) {
      expect(gapped.has(cid)).toBe(true);
    }
  });

  it('gaps are sorted by connector_id then field_name', () => {
    const report = buildConnectorFieldCoverageGap(NOW);
    for (let i = 1; i < report.gaps.length; i++) {
      const prev = report.gaps[i - 1];
      const curr = report.gaps[i];
      if (prev.connector_id === curr.connector_id) {
        expect(curr.field_name >= prev.field_name).toBe(true);
      } else {
        expect(curr.connector_id >= prev.connector_id).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    const r1 = buildConnectorFieldCoverageGap(NOW);
    const r2 = buildConnectorFieldCoverageGap(NOW);
    expect(r1.total_gaps).toBe(r2.total_gaps);
  });

  it('connectors_with_gaps is sorted asc', () => {
    const report = buildConnectorFieldCoverageGap(NOW);
    const sorted = [...report.connectors_with_gaps].sort();
    expect(report.connectors_with_gaps).toEqual(sorted);
  });
});
