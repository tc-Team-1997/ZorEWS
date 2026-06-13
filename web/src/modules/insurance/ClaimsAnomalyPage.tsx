// web/src/modules/insurance/ClaimsAnomalyPage.tsx
//
// Insurance EWS — Module 2: Claims Anomaly.
//
// Suspicious-claim triage. 4 widgets per the spec (suspicious claims queue
// · fraud score distribution · claims heatmap · SIU investigation queue)
// + an ad-hoc claim-analysis drawer. Backed by
// /v1/insurance/claims-anomaly/{dashboard,suspicious,analyze}.

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
  Cell,
} from 'recharts';
import { ShieldAlert, Search, Siren, X } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  ClaimsAnomalyDashboardShape,
  ClaimAnomalyRowShape,
  AnomalySeverityShape,
  ClaimAnalysisResultShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, Modal, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { buildClaimsAnomalyReportData } from './claimsAnomalyReportAdapter';
import { color } from '@/styles/tokens';

const fmtKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const SEV_TONE: Record<AnomalySeverityShape, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

const CLAIM_TYPES = ['health', 'motor', 'life', 'property', 'travel'];
const REGIONS = ['North', 'South', 'East', 'West', 'Central'];

// Heat colour for the claims heatmap — pale → orange → red as score rises.
function heatBg(score: number): string {
  if (score === 0) return '#F7F6F2';
  if (score >= 0.75) return 'rgba(226,75,74,0.85)';
  if (score >= 0.5) return 'rgba(245,121,59,0.75)';
  if (score >= 0.25) return 'rgba(239,159,39,0.6)';
  return 'rgba(33,150,243,0.35)';
}

export function ClaimsAnomalyPage() {
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  const { data, isLoading } = useQuery<ClaimsAnomalyDashboardShape>({
    queryKey: ['insurance', 'claims-anomaly', 'dashboard'],
    queryFn: () => api.insuranceClaimsAnomalyDashboard(),
  });

  return (
    <div>
      <PageHeader
        title="Claims Anomaly"
        subtitle="Anomaly scoring · fraud probability · SIU queue automation"
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setAnalyzeOpen(true)} data-testid="claim-analyze-open">
              <Search size={15} className="mr-1.5 -ml-0.5" /> Analyze claim
            </Button>
            {/* Enterprise export (P3) — RBAC-gated; renders null without
                reports:export. Reports the suspicious-claims queue + anomaly KPI totals. */}
            <ExportButton
              module="claims_anomaly"
              reportType="risk"
              adapter={(config) =>
                buildClaimsAnomalyReportData(
                  {
                    totals: {
                      claims_scored: data?.totals.claims_scored ?? 0,
                      suspicious_claims: data?.totals.suspicious_claims ?? 0,
                      critical_count: data?.totals.critical_count ?? 0,
                      siu_open_cases: data?.totals.siu_open_cases ?? 0,
                      suspicious_amount_kes: data?.totals.suspicious_amount_kes ?? 0,
                      mean_anomaly_score: data?.totals.mean_anomaly_score ?? 0,
                    },
                    suspicious_claims_queue: data?.suspicious_claims_queue ?? [],
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
          <p className="caption" data-testid="claims-loading">Loading claims intelligence…</p>
        </Panel>
      ) : (
        <div className="space-y-5" data-testid="claims-dashboard">
          {/* ── KPI row ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard label="Claims scored" value={data.totals.claims_scored.toLocaleString()} />
            <MetricCard
              label="Suspicious"
              value={data.totals.suspicious_claims.toLocaleString()}
              tone="warning"
              sub={`${data.totals.critical_count} critical`}
            />
            <MetricCard label="SIU open cases" value={data.totals.siu_open_cases} tone="danger" />
            <MetricCard label="Suspicious amount" value={fmtKES(data.totals.suspicious_amount_kes)} tone="danger" />
            <MetricCard label="Mean anomaly" value={fmtPct(data.totals.mean_anomaly_score)} tone="blue" />
          </div>

          {/* ── Fraud score distribution ────────────────────────────── */}
          <Panel>
            <h2 className="section-title mb-3">Fraud score distribution</h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.fraud_score_distribution} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
                <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip formatter={(v: number) => [v, 'Claims']} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {data.fraud_score_distribution.map((b) => (
                    <Cell
                      key={b.range}
                      fill={b.min >= 0.6 ? color.danger : b.min >= 0.4 ? color.warning : color.blue}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Panel>

          {/* ── Claims heatmap ──────────────────────────────────────── */}
          <Panel>
            <h2 className="section-title mb-3">Claims heatmap — type × region (suspicious)</h2>
            <div className="overflow-x-auto">
              <table className="text-xs" data-testid="claims-heatmap">
                <thead>
                  <tr>
                    <th className="p-1.5 text-left text-muted font-medium"></th>
                    {REGIONS.map((rg) => (
                      <th key={rg} className="p-1.5 text-center text-muted font-medium">{rg}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CLAIM_TYPES.map((ct) => (
                    <tr key={ct}>
                      <td className="p-1.5 capitalize font-medium text-ink-sub">{ct}</td>
                      {REGIONS.map((rg) => {
                        const cell = data.claims_heatmap.find((c) => c.claim_type === ct && c.region === rg);
                        const score = cell?.mean_anomaly_score ?? 0;
                        const cnt = cell?.suspicious_count ?? 0;
                        return (
                          <td key={rg} className="p-1">
                            <div
                              className="h-11 w-16 rounded flex flex-col items-center justify-center"
                              style={{ background: heatBg(score) }}
                              title={`${ct} · ${rg}: ${cnt} suspicious · mean ${fmtPct(score)}`}
                            >
                              <span className="font-semibold text-[13px]">{cnt}</span>
                              {cnt > 0 && <span className="text-[9px] opacity-70">{fmtPct(score)}</span>}
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

          {/* ── Suspicious claims queue ─────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <ShieldAlert size={16} className="text-danger" />
              <h2 className="section-title">Suspicious claims queue</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="suspicious-claims-table">
                <thead>
                  <tr className="text-left text-xs text-muted border-b border-divider">
                    <th className="py-2 pr-3 font-medium">Claim</th>
                    <th className="py-2 pr-3 font-medium">Customer</th>
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium text-right">Amount</th>
                    <th className="py-2 pr-3 font-medium text-right">Anomaly</th>
                    <th className="py-2 pr-3 font-medium text-right">Fraud prob.</th>
                    <th className="py-2 pr-3 font-medium">Severity</th>
                    <th className="py-2 font-medium">Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {data.suspicious_claims_queue.map((c: ClaimAnomalyRowShape) => (
                    <tr key={c.claim_id} className="border-b border-divider/60 hover:bg-surface-alt">
                      <td className="py-2 pr-3 font-mono text-xs">{c.claim_id}</td>
                      <td className="py-2 pr-3">{c.customer_name}</td>
                      <td className="py-2 pr-3 capitalize">{c.claim_type}</td>
                      <td className="py-2 pr-3 text-right tabular">{fmtKES(c.claim_amount_kes)}</td>
                      <td className="py-2 pr-3 text-right tabular font-semibold">{fmtPct(c.anomaly_score)}</td>
                      <td className="py-2 pr-3 text-right tabular">{fmtPct(c.fraud_probability)}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={SEV_TONE[c.severity]}>{c.severity}</Badge>
                      </td>
                      <td className="py-2 text-[11px] text-ink-sub">
                        {c.anomaly_reasons.map((r) => r.replace(/_/g, ' ')).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* ── SIU investigation queue ─────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <Siren size={16} className="text-danger" />
              <h2 className="section-title">SIU investigation queue</h2>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="siu-queue">
              {data.siu_investigation_queue.map((s) => (
                <div key={s.siu_case_id} className="rounded-card border border-divider p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-muted">{s.claim_id}</span>
                    <Badge tone={SEV_TONE[s.priority]}>{s.priority}</Badge>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="capitalize">{s.state}</span>
                    <span className="font-semibold text-danger">{fmtPct(s.fraud_probability)}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-sub">
                    {s.assigned_to ? `Assigned: ${s.assigned_to}` : 'Unassigned'}
                  </p>
                </div>
              ))}
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

// ── Ad-hoc claim analyzer ─────────────────────────────────────────────

function AnalyzeModal({ onClose }: { onClose: () => void }) {
  const [customerId, setCustomerId] = useState('CUST-DEMO-1');
  const [claims90, setClaims90] = useState(3);
  const [amountRatio, setAmountRatio] = useState(1.5);
  const [sigMatch, setSigMatch] = useState(0.8);
  const [isDup, setIsDup] = useState(false);

  const analyze = useMutation<ClaimAnalysisResultShape, Error>({
    mutationFn: () =>
      api.insuranceClaimsAnomalyAnalyze({
        customer_id: customerId,
        claims_in_90d: claims90,
        amount_vs_policy_avg: amountRatio,
        signature_match_score: sigMatch,
        is_duplicate: isDup,
      }),
  });
  const result = analyze.data;

  return (
    <Modal open onClose={onClose} ariaLabel="Analyze claim" size="md" testId="claim-analyze">
      <div className="space-y-3" data-testid="claim-analyze-modal">
        <div className="flex items-center justify-between border-b border-divider pb-3">
          <h2 className="section-title">Analyze claim for anomalies</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <Field label="Customer ID">
          <input className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Claims in 90d">
            <input type="number" min={0} className="input" value={claims90} onChange={(e) => setClaims90(Number(e.target.value))} />
          </Field>
          <Field label="Amount vs policy avg (×)">
            <input type="number" min={0} step={0.1} className="input" value={amountRatio} onChange={(e) => setAmountRatio(Number(e.target.value))} />
          </Field>
          <Field label="Signature match (0–1)">
            <input type="number" min={0} max={1} step={0.1} className="input" value={sigMatch} onChange={(e) => setSigMatch(Number(e.target.value))} />
          </Field>
          <Field label="Duplicate?">
            <select className="input" value={isDup ? 'yes' : 'no'} onChange={(e) => setIsDup(e.target.value === 'yes')}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
        </div>

        <Button onClick={() => analyze.mutate()} disabled={analyze.isPending} data-testid="claim-analyze-run">
          {analyze.isPending ? 'Scoring…' : 'Score anomaly'}
        </Button>

        {result && (
          <div className="mt-2 rounded-card border border-divider p-4" data-testid="claim-analyze-result">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Anomaly score</span>
              <span className="text-2xl font-bold tabular">{fmtPct(result.anomaly_score)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Severity</span>
              <Badge tone={SEV_TONE[result.severity]}>{result.severity}</Badge>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">SIU recommended</span>
              <Badge tone={result.siu_recommended ? 'danger' : 'success'}>
                {result.siu_recommended ? 'Yes — queue to SIU' : 'No'}
              </Badge>
            </div>
            {result.anomaly_reasons.length > 0 && (
              <>
                <p className="mt-3 text-xs font-medium text-muted">Anomaly reasons</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {result.anomaly_reasons.map((r) => (
                    <Badge key={r} tone="warning">{r.replace(/_/g, ' ')}</Badge>
                  ))}
                </div>
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
