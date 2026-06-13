// web/src/modules/insurance/UnderwritingDeviationPage.tsx
//
// Insurance EWS — Module 6: Underwriting Deviation.
//
// 4 widgets per the spec (high-risk underwriters · deviation heatmap ·
// medical-waiver analysis · rule-violation alerts) + an ad-hoc proposal
// analyzer. Backed by /v1/insurance/underwriting/{dashboard,analyze,deviations}.

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { Users, Grid3x3, Stethoscope, ShieldAlert, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  UnderwritingDashboardShape,
  DeviationRowShape,
  UwSeverityShape,
  ProposalAnalysisShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, Modal, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { buildUnderwritingReportData } from './underwritingReportAdapter';
import { color } from '@/styles/tokens';

const fmtPct = (n: number) => `${(n * 100).toFixed(0)}%`;
const fmtPct1 = (n: number) => `${(n * 100).toFixed(1)}%`;

const SEV_TONE: Record<UwSeverityShape, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

const DEVIATION_TYPES = ['premium', 'medical_waiver', 'sum_assured', 'rule_violation'];
const CHANNELS = ['agent', 'broker', 'bancassurance', 'direct', 'online'];

// Heat colour scaled by cell count (relative to a soft cap of 6).
function heatBg(count: number): string {
  if (count === 0) return '#F7F6F2';
  const t = Math.min(1, count / 6);
  if (t >= 0.8) return 'rgba(226,75,74,0.85)';
  if (t >= 0.5) return 'rgba(245,121,59,0.7)';
  if (t >= 0.25) return 'rgba(239,159,39,0.55)';
  return 'rgba(33,150,243,0.3)';
}

export function UnderwritingDeviationPage() {
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  const { data, isLoading } = useQuery<UnderwritingDashboardShape>({
    queryKey: ['insurance', 'underwriting', 'dashboard'],
    queryFn: () => api.insuranceUnderwritingDashboard(),
  });

  return (
    <div>
      <PageHeader
        title="Underwriting Deviation"
        subtitle="Guideline breaches · medical waivers · sum-assured limits · underwriter risk"
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setAnalyzeOpen(true)} data-testid="uw-analyze-open">
              <Search size={15} className="mr-1.5 -ml-0.5" /> Analyze proposal
            </Button>
            {/* Enterprise export (P3) — RBAC-gated; renders null without
                reports:export. Reports the rule-violation alerts table + deviation KPI totals. */}
            <ExportButton
              module="underwriting"
              reportType="risk"
              adapter={(config) =>
                buildUnderwritingReportData(
                  {
                    totals: {
                      proposals_reviewed: data?.totals.proposals_reviewed ?? 0,
                      total_deviations: data?.totals.total_deviations ?? 0,
                      open_deviations: data?.totals.open_deviations ?? 0,
                      critical_deviations: data?.totals.critical_deviations ?? 0,
                      medical_waivers: data?.totals.medical_waivers ?? 0,
                      high_risk_underwriters: data?.totals.high_risk_underwriters ?? 0,
                    },
                    rule_violation_alerts: data?.rule_violation_alerts ?? [],
                    meta: { tenant_id: 'BANK_DEMO', generated_by: 'operator', role: 'admin' },
                  },
                  config,
                )
              }
            />
          </div>
        }
      />

      {isLoading || !data ? (
        <Panel>
          <p className="caption" data-testid="uw-loading">Loading underwriting deviations…</p>
        </Panel>
      ) : (
        <div className="space-y-5" data-testid="uw-dashboard">
          {/* ── KPI row ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard label="Proposals reviewed" value={data.totals.proposals_reviewed.toLocaleString()} />
            <MetricCard label="Total deviations" value={data.totals.total_deviations} tone="warning" />
            <MetricCard label="Open" value={data.totals.open_deviations} tone="danger" sub={`${data.totals.critical_deviations} critical`} />
            <MetricCard label="Medical waivers" value={data.totals.medical_waivers} tone="blue" />
            <MetricCard label="High-risk UWs" value={data.totals.high_risk_underwriters} tone="danger" />
          </div>

          {/* ── High-risk underwriters + Deviation heatmap ──────────── */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Panel>
              <div className="mb-3 flex items-center gap-2">
                <Users size={16} className="text-danger" />
                <h2 className="section-title">High-risk underwriters</h2>
              </div>
              <div className="space-y-2" data-testid="high-risk-underwriters">
                {data.high_risk_underwriters.map((u) => (
                  <div key={u.underwriter_id} className="flex items-center justify-between gap-3 rounded border border-divider p-2.5">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        <span className="text-muted mr-1.5">#{u.rank}</span>
                        {u.underwriter_name}
                      </p>
                      <p className="text-[11px] text-muted">
                        {u.deviation_count_90d} deviations · {u.policies_underwritten} policies · {fmtPct1(u.deviation_rate)} rate
                      </p>
                    </div>
                    <span className="font-semibold text-sm text-danger tabular shrink-0">{fmtPct(u.risk_score)}</span>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel>
              <div className="mb-3 flex items-center gap-2">
                <Grid3x3 size={16} className="text-brand-blue" />
                <h2 className="section-title">Deviation heatmap — type × channel</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs" data-testid="deviation-heatmap">
                  <thead>
                    <tr>
                      <th className="p-1.5 text-left text-muted font-medium"></th>
                      {CHANNELS.map((ch) => (
                        <th key={ch} className="p-1 text-center text-muted font-medium capitalize">{ch.slice(0, 4)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DEVIATION_TYPES.map((dt) => (
                      <tr key={dt}>
                        <td className="p-1.5 text-ink-sub font-medium whitespace-nowrap">{dt.replace(/_/g, ' ')}</td>
                        {CHANNELS.map((ch) => {
                          const cell = data.deviation_heatmap.find((c) => c.deviation_type === dt && c.channel === ch);
                          const cnt = cell?.count ?? 0;
                          return (
                            <td key={ch} className="p-1">
                              <div
                                className="h-9 w-12 rounded flex items-center justify-center font-semibold text-[12px]"
                                style={{ background: heatBg(cnt) }}
                                title={`${dt} · ${ch}: ${cnt} deviations`}
                              >
                                {cnt}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          {/* ── Medical waiver analysis ─────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <Stethoscope size={16} className="text-brand-blue" />
              <h2 className="section-title">Medical waiver analysis</h2>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.medical_waiver_analysis} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
                <XAxis dataKey="band" tick={{ fontSize: 11 }} tickFormatter={(b: string) => b.replace(/_/g, ' ')} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip formatter={(v: number, name: string) => [v, name === 'high_sum_assured_waivers' ? 'High-SA waivers' : 'Waivers granted']} />
                <Bar dataKey="waivers_granted" radius={[4, 4, 0, 0]} fill={color.blue} />
                <Bar dataKey="high_sum_assured_waivers" radius={[4, 4, 0, 0]} fill={color.danger} />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-1 flex gap-4 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color.blue }} /> waivers granted</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color.danger }} /> high-sum-assured waivers</span>
            </div>
          </Panel>

          {/* ── Rule violation alerts ───────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <ShieldAlert size={16} className="text-danger" />
              <h2 className="section-title">Rule violation alerts</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="rule-violation-alerts">
                <thead>
                  <tr className="text-left text-xs text-muted border-b border-divider">
                    <th className="py-2 pr-3 font-medium">Policy</th>
                    <th className="py-2 pr-3 font-medium">Underwriter</th>
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium">Rule</th>
                    <th className="py-2 pr-3 font-medium text-right">Deviation</th>
                    <th className="py-2 font-medium">Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rule_violation_alerts.map((d: DeviationRowShape) => (
                    <tr key={d.deviation_id} className="border-b border-divider/60 hover:bg-surface-alt">
                      <td className="py-2 pr-3 font-mono text-xs">{d.policy_id}</td>
                      <td className="py-2 pr-3">{d.underwriter_name}</td>
                      <td className="py-2 pr-3">{d.deviation_type.replace(/_/g, ' ')}</td>
                      <td className="py-2 pr-3 font-mono text-[10.5px] text-ink-sub">{d.rule_code}</td>
                      <td className="py-2 pr-3 text-right tabular">{d.deviation_type === 'medical_waiver' || d.deviation_type === 'rule_violation' ? '—' : fmtPct1(Math.abs(d.deviation_pct))}</td>
                      <td className="py-2">
                        <Badge tone={SEV_TONE[d.severity]}>{d.severity}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <p className="caption text-right">
            Model {data.model_version} · generated {new Date(data.generated_at).toLocaleString()}
          </p>
        </div>
      )}

      {analyzeOpen && <AnalyzeModal onClose={() => setAnalyzeOpen(false)} />}
    </div>
  );
}

// ── Ad-hoc proposal analyzer ───────────────────────────────────────────

function AnalyzeModal({ onClose }: { onClose: () => void }) {
  const [premiumRatio, setPremiumRatio] = useState(0.75);
  const [sumAssuredRatio, setSumAssuredRatio] = useState(1.2);
  const [waiver, setWaiver] = useState(false);
  const [age, setAge] = useState(45);
  const [overrides, setOverrides] = useState(1);

  const analyze = useMutation<ProposalAnalysisShape, Error>({
    mutationFn: () =>
      api.insuranceUnderwritingAnalyze({
        premium_vs_guideline_ratio: premiumRatio,
        sum_assured_vs_limit_ratio: sumAssuredRatio,
        medical_waiver_granted: waiver,
        applicant_age: age,
        rule_overrides: overrides,
      }),
  });
  const result = analyze.data;

  return (
    <Modal open onClose={onClose} ariaLabel="Analyze underwriting proposal" size="md" testId="uw-analyze">
      <div className="space-y-3" data-testid="uw-analyze-modal">
        <div className="flex items-center justify-between border-b border-divider pb-3">
          <h2 className="section-title">Analyze proposal for deviations</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Premium vs guideline (×)">
            <input type="number" min={0} step={0.05} className="input" value={premiumRatio} onChange={(e) => setPremiumRatio(Number(e.target.value))} />
          </Field>
          <Field label="Sum assured vs limit (×)">
            <input type="number" min={0} step={0.05} className="input" value={sumAssuredRatio} onChange={(e) => setSumAssuredRatio(Number(e.target.value))} />
          </Field>
          <Field label="Applicant age">
            <input type="number" min={0} className="input" value={age} onChange={(e) => setAge(Number(e.target.value))} />
          </Field>
          <Field label="Manual rule overrides">
            <input type="number" min={0} className="input" value={overrides} onChange={(e) => setOverrides(Number(e.target.value))} />
          </Field>
          <Field label="Medical waiver granted?">
            <select className="input" value={waiver ? 'yes' : 'no'} onChange={(e) => setWaiver(e.target.value === 'yes')}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
        </div>

        <Button onClick={() => analyze.mutate()} disabled={analyze.isPending} data-testid="uw-analyze-run">
          {analyze.isPending ? 'Analyzing…' : 'Analyze deviations'}
        </Button>

        {result && (
          <div className="mt-2 rounded-card border border-divider p-4" data-testid="uw-analyze-result">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Deviation score</span>
              <span className="text-2xl font-bold tabular">{fmtPct1(result.deviation_score)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Severity</span>
              <Badge tone={SEV_TONE[result.severity]}>{result.severity}</Badge>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Exception approval</span>
              <Badge tone={result.requires_exception_approval ? 'danger' : 'success'}>
                {result.requires_exception_approval ? 'Required' : 'Not required'}
              </Badge>
            </div>
            {result.deviations.length > 0 && (
              <>
                <p className="mt-3 text-xs font-medium text-muted">Detected deviations</p>
                <ul className="mt-1 space-y-1">
                  {result.deviations.map((d) => (
                    <li key={d.deviation_type} className="text-xs flex items-center justify-between gap-2">
                      <span>{d.detail}</span>
                      <span className="tabular text-danger font-semibold">+{fmtPct1(d.contribution)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-3 text-[11px] text-ink-sub leading-snug border-t border-divider pt-2">
              {result.recommended_action}
            </p>
          </div>
        )}
        {analyze.isError && (
          <p className="text-xs text-danger" role="alert">{analyze.error.message}</p>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted mb-1 block">{label}</span>
      {children}
    </label>
  );
}
