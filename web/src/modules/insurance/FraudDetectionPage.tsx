// web/src/modules/insurance/FraudDetectionPage.tsx
//
// Insurance EWS — Module 3: Fraud Detection (network / ring).
//
// 4 widgets per the spec (fraud network graph · high-risk providers ·
// fraud ring detection · identity risk analysis) + an ad-hoc fraud-analysis
// drawer. Backed by /v1/insurance/fraud/{dashboard,high-risk,analyze}.
//
// The network graph is rendered as an SVG force-free radial layout — nodes
// placed on a circle, edges drawn as chords. Good enough to read the ring
// shape without a heavy graph-layout dependency.

import { useState, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Network, Building2, Fingerprint, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  FraudDashboardShape,
  FraudGraphNodeShape,
  FraudGraphEdgeShape,
  FraudSeverityShape,
  FraudAnalysisResultShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, Modal, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { color } from '@/styles/tokens';

const fmtKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;

const SEV_TONE: Record<FraudSeverityShape, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};
const RING_TONE: Record<string, BadgeTone> = {
  detected: 'warning',
  investigating: 'blue',
  confirmed: 'danger',
  dismissed: 'neutral',
};
const NODE_COLOR: Record<string, string> = {
  customer: color.blue,
  provider: color.danger ?? '#E24B4A',
  hospital: '#F5793B',
  garage: color.warning ?? '#EF9F27',
  agent: color.sky,
  bank_account: '#7C5CFC',
};

export function FraudDetectionPage() {
  const [analyzeOpen, setAnalyzeOpen] = useState(false);

  const { data, isLoading } = useQuery<FraudDashboardShape>({
    queryKey: ['insurance', 'fraud', 'dashboard'],
    queryFn: () => api.insuranceFraudDashboard(),
  });

  return (
    <div>
      <PageHeader
        title="Fraud Detection"
        subtitle="Network analysis · ring detection · provider collusion · identity fraud"
        actions={
          <Button onClick={() => setAnalyzeOpen(true)} data-testid="fraud-analyze-open">
            <Search size={15} className="mr-1.5 -ml-0.5" /> Analyze entity
          </Button>
        }
      />

      {isLoading || !data ? (
        <Panel>
          <p className="caption" data-testid="fraud-loading">Loading fraud network…</p>
        </Panel>
      ) : (
        <div className="space-y-5" data-testid="fraud-dashboard">
          {/* ── KPI row ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard label="Entities tracked" value={data.totals.entities_tracked.toLocaleString()} />
            <MetricCard label="Flagged" value={data.totals.flagged_entities.toLocaleString()} tone="warning" />
            <MetricCard label="Fraud rings" value={data.totals.fraud_rings} tone="danger" />
            <MetricCard label="Open cases" value={data.totals.open_fraud_cases} tone="danger" />
            <MetricCard label="Est. exposure" value={fmtKES(data.totals.estimated_exposure_kes)} tone="danger" />
          </div>

          {/* ── Fraud network graph ─────────────────────────────────── */}
          <Panel>
            <div className="mb-3 flex items-center gap-2">
              <Network size={16} className="text-brand-blue" />
              <h2 className="section-title">Fraud network graph — {data.fraud_network_graph.label}</h2>
            </div>
            <NetworkGraph
              nodes={data.fraud_network_graph.nodes}
              edges={data.fraud_network_graph.edges}
            />
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
              {Object.entries(NODE_COLOR).map(([k, c]) => (
                <span key={k} className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} /> {k.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          </Panel>

          {/* ── Fraud ring detection ────────────────────────────────── */}
          <Panel>
            <h2 className="section-title mb-3">Fraud ring detection</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="fraud-rings-table">
                <thead>
                  <tr className="text-left text-xs text-muted border-b border-divider">
                    <th className="py-2 pr-3 font-medium">Ring</th>
                    <th className="py-2 pr-3 font-medium text-right">Entities</th>
                    <th className="py-2 pr-3 font-medium text-right">Edges</th>
                    <th className="py-2 pr-3 font-medium text-right">Risk</th>
                    <th className="py-2 pr-3 font-medium text-right">Exposure</th>
                    <th className="py-2 pr-3 font-medium">Method</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fraud_ring_detection.map((r) => (
                    <tr key={r.network_id} className="border-b border-divider/60 hover:bg-surface-alt">
                      <td className="py-2 pr-3">{r.label}</td>
                      <td className="py-2 pr-3 text-right tabular">{r.entity_count}</td>
                      <td className="py-2 pr-3 text-right tabular">{r.edge_count}</td>
                      <td className="py-2 pr-3 text-right tabular font-semibold">{fmtPct(r.ring_risk_score)}</td>
                      <td className="py-2 pr-3 text-right tabular">{fmtKES(r.estimated_exposure_kes)}</td>
                      <td className="py-2 pr-3 text-[11px] text-ink-sub">{r.detection_method.replace(/_/g, ' ')}</td>
                      <td className="py-2">
                        <Badge tone={RING_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* ── High-risk providers + Identity risk ─────────────────── */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Panel>
              <div className="mb-3 flex items-center gap-2">
                <Building2 size={16} className="text-danger" />
                <h2 className="section-title">High-risk providers</h2>
              </div>
              <div className="space-y-2" data-testid="high-risk-providers">
                {data.high_risk_providers.map((p) => (
                  <div key={p.entity_id} className="flex items-center justify-between gap-3 rounded border border-divider p-2.5">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        <span className="text-muted mr-1.5">#{p.rank}</span>
                        {p.display_name}
                      </p>
                      <p className="text-[11px] text-muted capitalize">
                        {p.entity_type} · {p.linked_claims} claims · {p.linked_entities} links
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-semibold text-sm text-danger tabular">{fmtPct(p.risk_score)}</p>
                      <p className="text-[11px] text-muted">{fmtKES(p.estimated_exposure_kes)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel>
              <div className="mb-3 flex items-center gap-2">
                <Fingerprint size={16} className="text-danger" />
                <h2 className="section-title">Identity risk analysis</h2>
              </div>
              <div className="space-y-2" data-testid="identity-risk">
                {data.identity_risk_analysis.map((r) => (
                  <div key={r.customer_id} className="flex items-center justify-between gap-3 rounded border border-divider p-2.5">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{r.customer_name}</p>
                      <p className="text-[11px] text-ink-sub">
                        {r.signals.map((s) => s.replace(/_/g, ' ')).join(', ') || '—'}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <Badge tone={SEV_TONE[r.severity]}>{r.severity}</Badge>
                      <p className="text-[11px] text-muted mt-0.5">{fmtPct(r.identity_risk_score)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <p className="caption text-right">
            Model {data.model_version} · generated {new Date(data.generated_at).toLocaleString()}
          </p>
        </div>
      )}

      {analyzeOpen && <AnalyzeModal onClose={() => setAnalyzeOpen(false)} />}
    </div>
  );
}

// ── SVG radial network graph ───────────────────────────────────────────

function NetworkGraph({ nodes, edges }: { nodes: FraudGraphNodeShape[]; edges: FraudGraphEdgeShape[] }) {
  const W = 640;
  const H = 320;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 36;

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const n = Math.max(1, nodes.length);
    nodes.forEach((node, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      map.set(node.entity_id, { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) });
    });
    return map;
  }, [nodes, cx, cy, R]);

  if (nodes.length === 0) {
    return <p className="caption" data-testid="fraud-network-graph">No ring detected.</p>;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 340 }} data-testid="fraud-network-graph">
      {edges.map((e, i) => {
        const a = positions.get(e.source_entity_id);
        const b = positions.get(e.target_entity_id);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="#c8d2e0"
            strokeWidth={Math.max(0.5, e.weight * 2.5)}
            opacity={0.55}
          />
        );
      })}
      {nodes.map((node) => {
        const p = positions.get(node.entity_id)!;
        const r = 6 + node.risk_score * 7;
        return (
          <g key={node.entity_id}>
            <circle
              cx={p.x}
              cy={p.y}
              r={r}
              fill={NODE_COLOR[node.entity_type] ?? color.blue}
              opacity={node.flagged ? 0.95 : 0.55}
              stroke={node.flagged ? '#7a1410' : 'transparent'}
              strokeWidth={node.flagged ? 1.5 : 0}
            >
              <title>{`${node.display_name} (${node.entity_type}) · risk ${fmtPct(node.risk_score)}`}</title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}

// ── Ad-hoc entity analyzer ─────────────────────────────────────────────

function AnalyzeModal({ onClose }: { onClose: () => void }) {
  const [customerId, setCustomerId] = useState('CUST-DEMO-1');
  const [sharedAcc, setSharedAcc] = useState(2);
  const [coClaim, setCoClaim] = useState(3);
  const [referral, setReferral] = useState(2);
  const [idMismatch, setIdMismatch] = useState(0.4);
  const [priorFraud, setPriorFraud] = useState(false);

  const analyze = useMutation<FraudAnalysisResultShape, Error>({
    mutationFn: () =>
      api.insuranceFraudAnalyze({
        customer_id: customerId,
        shared_bank_accounts: sharedAcc,
        co_claim_count: coClaim,
        provider_referral_count: referral,
        identity_mismatch_score: idMismatch,
        prior_confirmed_fraud: priorFraud,
      }),
  });
  const result = analyze.data;

  return (
    <Modal open onClose={onClose} ariaLabel="Analyze entity for fraud" size="md" testId="fraud-analyze">
      <div className="space-y-3" data-testid="fraud-analyze-modal">
        <div className="flex items-center justify-between border-b border-divider pb-3">
          <h2 className="section-title">Analyze entity for fraud</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <Field label="Customer / entity ID">
          <input className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Shared bank accounts">
            <input type="number" min={0} className="input" value={sharedAcc} onChange={(e) => setSharedAcc(Number(e.target.value))} />
          </Field>
          <Field label="Co-claim count">
            <input type="number" min={0} className="input" value={coClaim} onChange={(e) => setCoClaim(Number(e.target.value))} />
          </Field>
          <Field label="Provider referrals">
            <input type="number" min={0} className="input" value={referral} onChange={(e) => setReferral(Number(e.target.value))} />
          </Field>
          <Field label="Identity mismatch (0–1)">
            <input type="number" min={0} max={1} step={0.1} className="input" value={idMismatch} onChange={(e) => setIdMismatch(Number(e.target.value))} />
          </Field>
          <Field label="Prior confirmed fraud?">
            <select className="input" value={priorFraud ? 'yes' : 'no'} onChange={(e) => setPriorFraud(e.target.value === 'yes')}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
        </div>

        <Button onClick={() => analyze.mutate()} disabled={analyze.isPending} data-testid="fraud-analyze-run">
          {analyze.isPending ? 'Scoring…' : 'Score fraud risk'}
        </Button>

        {result && (
          <div className="mt-2 rounded-card border border-divider p-4" data-testid="fraud-analyze-result">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Fraud probability</span>
              <span className="text-2xl font-bold tabular">{fmtPct(result.fraud_probability)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Severity</span>
              <Badge tone={SEV_TONE[result.severity]}>{result.severity}</Badge>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Likely type</span>
              <Badge tone="warning">{result.likely_fraud_type.replace(/_/g, ' ')}</Badge>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-muted">Ring membership</span>
              <span className="font-semibold tabular text-danger">{fmtPct(result.ring_membership_likelihood)}</span>
            </div>
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
