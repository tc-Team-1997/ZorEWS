import { describe, test, expect } from 'vitest';
import { buildChannelRiskReportData } from '@/modules/insurance/channelRiskReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildChannelRiskReportData', () => {
  test('maps the channel risk leaderboard into ReportData (risk report)', () => {
    const data = buildChannelRiskReportData({
      totals: {
        agents_scored: 1_240,
        high_risk_agents: 38,
        critical_agents: 9,
        open_mis_selling_alerts: 14,
        complaints_30d: 210,
        worst_channel: 'online',
      },
      channel_risk_leaderboard: [
        { agent_id: 'AG-1', agent_name: 'Doreen W', channel: 'online', composite_risk: 0.88, sub_scores: { persistency: 0.7, fraud: 0.9, complaint: 0.6, mis_selling: 0.95 }, policies_sold_90d: 42, persistency_13m: 0.55, band: 'critical', rank: 1 },
        { agent_id: 'AG-2', agent_name: 'Evans O', channel: 'broker', composite_risk: 0.72, sub_scores: { persistency: 0.6, fraud: 0.5, complaint: 0.8, mis_selling: 0.7 }, policies_sold_90d: 31, persistency_13m: 0.62, band: 'elevated', rank: 2 },
        { agent_id: 'AG-3', agent_name: 'Faith M', channel: 'agent', composite_risk: 0.41, sub_scores: { persistency: 0.4, fraud: 0.3, complaint: 0.5, mis_selling: 0.45 }, policies_sold_90d: 58, persistency_13m: 0.81, band: 'watch', rank: 3 },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.module).toBe('channel_risk');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(3);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical agents')?.value).toBe('9');
    expect(data.record_count).toBe(3);
  });
});
