// web/src/modules/insurance/channelRiskReportAdapter.ts
//
// Export adapter for Insurance Module 7 — Channel Risk.
// This is a multi-panel page (channel-risk leaderboard, channel health,
// mis-selling alerts, complaint analytics) with no single primary table;
// following the recoveryReportAdapter / fraudDetectionReportAdapter precedent
// we export the most representative rendered output — the channel-risk
// leaderboard (ranked agent/broker risk) as a RISK report — plus the channel
// KPI totals strip.
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface ChannelRiskLeaderboardRow {
  agent_id: string;
  agent_name: string;
  channel: string;
  composite_risk: number;
  sub_scores: { persistency: number; fraud: number; complaint: number; mis_selling: number };
  policies_sold_90d: number;
  persistency_13m: number;
  band: string;
  rank: number;
}

export interface ChannelRiskReportSource {
  totals: {
    agents_scored: number;
    high_risk_agents: number;
    critical_agents: number;
    open_mis_selling_alerts: number;
    complaints_30d: number;
    worst_channel: string | null;
  };
  channel_risk_leaderboard: ChannelRiskLeaderboardRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildChannelRiskReportData(src: ChannelRiskReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'risk',
    module: 'channel_risk',
    title: 'Channel Risk Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'High-risk agents', value: String(src.totals.high_risk_agents) },
        { label: 'Open mis-selling alerts', value: String(src.totals.open_mis_selling_alerts) },
        { label: 'Worst channel', value: src.totals.worst_channel ?? 'none' },
      ],
      kpis: [
        { label: 'Agents scored', value: String(src.totals.agents_scored) },
        { label: 'High-risk agents', value: String(src.totals.high_risk_agents) },
        { label: 'Critical agents', value: String(src.totals.critical_agents) },
        { label: 'Open mis-selling alerts', value: String(src.totals.open_mis_selling_alerts) },
        { label: 'Complaints (30d)', value: String(src.totals.complaints_30d) },
      ],
      tables: [{
        name: 'Channel Risk Leaderboard',
        columns: ['Rank', 'Agent ID', 'Agent', 'Channel', 'Composite Risk', 'Persistency (13m)', 'Policies (90d)', 'Band'],
        rows: src.channel_risk_leaderboard.map((a) => [
          a.rank, a.agent_id, a.agent_name, a.channel, a.composite_risk,
          a.persistency_13m, a.policies_sold_90d, a.band,
        ]),
      }],
    },
    record_count: src.channel_risk_leaderboard.length,
  };
}
