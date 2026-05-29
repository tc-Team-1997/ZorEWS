// web/src/modules/ai/ExplainabilityPage.tsx
//
// Module 4.3 — Explainability.
//
// Per-prediction drill-through for credit-decision auditability.
//
// Layout:
//   - Search bar (prediction_id) at top.
//   - "How to read this" onboarding card (collapsible).
//   - Sample Explanation card — top-5 features with weight bars,
//     natural-language summary, counterfactual.
//   - Trust Signals panel — 5 indicators with red/amber/green tone.
//   - Feature Importance modal — full ranking (opens on button click).
//   - Export to PDF — client-side via jspdf + autotable (mirrors the
//     scenario + reports M3.3 pattern).
//
// Acceptance enforcement:
//   - 24-month age cap is enforced by the BFF (410 EWS_410_explanation_expired);
//     the page renders a clear "expired" empty-state when that fires.
//   - PDF export captures every panel a regulator would need (model
//     id + version + observed PD + every feature contribution + trust
//     signals + generated_at timestamp).

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  FileDown,
  HelpCircle,
  Layers,
  Search,
  XCircle,
} from 'lucide-react';
import { Badge, Button, Input, MetricCard, Modal, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  api,
  type ExplanationReport,
  type FeatureImportanceReport,
  type TrustSignalReport,
  type PredictionLogTrailShape,
  type PredictionLogEntryShape,
  type PredictionLogActionShape,
} from '@/lib/api';

const BAND_TONE: Record<string, 'success' | 'warning' | 'danger' | 'blue'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};

const STATUS_TONE: Record<'green' | 'amber' | 'red', 'success' | 'warning' | 'danger'> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
};

const STATUS_ICON: Record<'green' | 'amber' | 'red', JSX.Element> = {
  green: <CheckCircle2 size={14} className="text-success" />,
  amber: <AlertTriangle size={14} className="text-warning" />,
  red: <XCircle size={14} className="text-danger" />,
};

export function ExplainabilityPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const initial = params.get('prediction_id') ?? '';
  const [pidInput, setPidInput] = useState(initial);
  const [activePid, setActivePid] = useState(initial);
  const [showHelp, setShowHelp] = useState(true);
  const [showImportance, setShowImportance] = useState(false);

  const explanationQ = useQuery<ExplanationReport, Error>({
    queryKey: ['m43-explanation', activePid],
    queryFn: () => api.aiPredictionExplanation(activePid),
    enabled: activePid.length > 0,
    retry: false,
  });
  const trustQ = useQuery<TrustSignalReport, Error>({
    queryKey: ['m43-trust', activePid],
    queryFn: () => api.aiPredictionTrustSignals(activePid),
    enabled: activePid.length > 0,
    retry: false,
  });
  const importanceQ = useQuery<FeatureImportanceReport, Error>({
    queryKey: ['m43-importance', activePid],
    queryFn: () => api.aiPredictionFeatureImportance(activePid),
    enabled: activePid.length > 0 && showImportance,
    retry: false,
  });

  const errCode = useMemo(() => {
    const errs = [explanationQ.error, trustQ.error].filter(Boolean) as { message: string }[];
    if (errs.length === 0) return null;
    // The http interceptor wraps non-2xx as HttpError(status, message, body).
    // body carries the {header, error: {code, message, severity}} envelope.
    const e0 = errs[0] as unknown as {
      status?: number;
      body?: { error?: { code?: string; message?: string } };
      message?: string;
    };
    return {
      code: e0.body?.error?.code,
      message: e0.body?.error?.message ?? e0.message ?? 'request failed',
      status: e0.status,
    };
  }, [explanationQ.error, trustQ.error]);

  const submit = () => {
    const v = pidInput.trim();
    setActivePid(v);
    setParams(v ? { prediction_id: v } : {}, { replace: true });
  };

  const exportPdf = async () => {
    if (!explanationQ.data) return;
    const { downloadExplanationPdf } = await import('./explainabilityExport');
    downloadExplanationPdf({
      explanation: explanationQ.data,
      trust: trustQ.data,
      importance: importanceQ.data ?? null,
    });
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Explainability"
        subtitle="Per-prediction feature importance, SHAP-style contributions, trust signals"
        actions={
          <Button
            variant="ghost"
            onClick={() => setShowHelp((v) => !v)}
            data-testid="ex-toggle-help"
          >
            <HelpCircle size={14} /> {showHelp ? 'Hide' : 'Show'} guide
          </Button>
        }
      />

      <Panel title="Find prediction">
        <div className="flex gap-2">
          <Input
            value={pidInput}
            onChange={(e) => setPidInput(e.target.value)}
            placeholder="Paste a prediction_id (UUIDv4)"
            data-testid="ex-search-input"
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <Button variant="primary" onClick={submit} data-testid="ex-search-btn">
            <Search size={14} /> Find
          </Button>
          {explanationQ.data && (
            <Button variant="ghost" onClick={exportPdf} data-testid="ex-export-pdf">
              <FileDown size={14} /> Export PDF
            </Button>
          )}
        </div>
      </Panel>

      {showHelp && (
        <Panel title="How to read this" data-testid="ex-help-card">
          <div className="text-sm text-muted space-y-2">
            <p>
              <strong>Sample Explanation:</strong> the top 5 features that drove the prediction.
              Each weight is a SHAP-style contribution — positive (up arrow) raises the model's
              probability of default, negative (down arrow) protects against it.
            </p>
            <p>
              <strong>Trust Signals:</strong> five governance indicators (drift, calibration,
              cohort size, feature freshness, training freshness). Green = within target,
              amber = watch, red = action required. The overall band is the worst of the five.
            </p>
            <p>
              <strong>Counterfactual:</strong> the minimal feature change that would shift the
              prediction down a band — useful for explaining to a customer what would improve
              their position.
            </p>
            <p>
              <strong>Audit retention:</strong> explanations are reconstructable for any
              prediction made in the last 24 months. Older requests return{' '}
              <code className="text-action">EWS_410_explanation_expired</code>.
            </p>
          </div>
        </Panel>
      )}

      {!activePid && (
        <Panel title="No prediction selected" data-testid="ex-empty">
          <p className="text-sm text-muted">
            Paste a prediction_id above to load its explanation. You can find prediction_ids on
            the customer risk profile page, alert detail view, or via{' '}
            <code className="text-action">GET /v1/ai/predictions?customer_id=…</code>.
          </p>
        </Panel>
      )}

      {activePid && errCode && (
        <Panel title="Unable to load explanation" data-testid="ex-error">
          <div className="rounded border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
            <AlertTriangle size={14} className="inline mr-1" />
            <strong>{errCode.code ?? `HTTP ${errCode.status}`}</strong>: {errCode.message}
            {errCode.code === 'EWS_410_explanation_expired' && (
              <p className="mt-2 text-muted">
                This prediction is older than the 24-month audit window. Regulatory submission
                must use a fresh re-scoring rather than archived explanations.
              </p>
            )}
          </div>
        </Panel>
      )}

      {activePid && explanationQ.data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Predicted PD"
              value={`${(explanationQ.data.pd * 100).toFixed(1)}%`}
              tone={BAND_TONE[explanationQ.data.band] ?? 'blue'}
              testId="ex-kpi-pd"
            />
            <MetricCard
              label="Band"
              value={explanationQ.data.band.toUpperCase()}
              tone={BAND_TONE[explanationQ.data.band] ?? 'blue'}
            />
            <MetricCard
              label="Base PD"
              value={`${(explanationQ.data.base_pd_population * 100).toFixed(1)}%`}
              sub="population mean"
            />
            <MetricCard
              label="Model"
              value={explanationQ.data.model_version}
              sub={explanationQ.data.model_id}
            />
          </div>

          <Panel
            title="Sample Explanation — top 5 contributing features"
            data-testid="ex-sample-card"
            action={
              <Button
                variant="ghost"
                onClick={() => setShowImportance(true)}
                data-testid="ex-open-importance"
              >
                <Layers size={14} /> Full ranking
              </Button>
            }
          >
            <ul className="space-y-3">
              {explanationQ.data.top_features.map((f) => (
                <FeatureRow
                  key={f.feature_name}
                  feature={f}
                  maxAbs={Math.max(
                    ...explanationQ.data!.top_features.map((x) => Math.abs(x.weight)),
                  )}
                />
              ))}
            </ul>
            <div className="mt-4 rounded border border-divider/40 bg-divider/5 p-3 text-sm">
              <strong>Counterfactual:</strong>{' '}
              {explanationQ.data.counterfactual.description}. PD would shift to{' '}
              <Badge tone={BAND_TONE[explanationQ.data.counterfactual.resulting_band] ?? 'blue'}>
                {explanationQ.data.counterfactual.resulting_band}
              </Badge>{' '}
              (
              {(explanationQ.data.counterfactual.resulting_pd * 100).toFixed(1)}
              %).
            </div>
          </Panel>

          <Panel
            title={`Trust signals — overall: ${trustQ.data?.overall ?? '…'}`}
            data-testid="ex-trust-card"
          >
            {trustQ.isLoading && <p className="text-sm text-muted">Loading…</p>}
            {trustQ.data && (
              <table className="w-full text-sm" data-testid="ex-trust-table">
                <thead className="text-left text-xs uppercase text-muted">
                  <tr className="border-b border-divider/40">
                    <th className="py-2">Signal</th>
                    <th>Status</th>
                    <th>Value</th>
                    <th>Threshold</th>
                  </tr>
                </thead>
                <tbody>
                  {trustQ.data.signals.map((s) => (
                    <tr
                      key={s.signal}
                      className="border-b border-divider/40 hover:bg-divider/10"
                      data-testid={`ex-trust-row-${s.signal}`}
                    >
                      <td className="py-2">
                        <div className="font-medium">{s.signal.replace(/_/g, ' ')}</div>
                        <div className="text-xs text-muted">{s.description}</div>
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-1">
                          {STATUS_ICON[s.status]}
                          <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                        </span>
                      </td>
                      <td className="text-xs font-mono">{s.value}</td>
                      <td className="text-xs">{s.threshold}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <PredictionAuditPanel pid={activePid} />
        </>
      )}

      {showImportance && (
        <FeatureImportanceModal
          prediction_id={activePid}
          report={importanceQ.data ?? null}
          isLoading={importanceQ.isLoading}
          error={importanceQ.error}
          onClose={() => setShowImportance(false)}
        />
      )}

      {/* hidden link for tests to verify nav from other pages */}
      <button
        type="button"
        className="hidden"
        onClick={() => navigate('/ai/explainability')}
        data-testid="ex-back-to-self"
      />
    </div>
  );
}

// T7 M8 — prediction audit-action trail (compliance log). Shows every user
// action + system event against this prediction, and lets an operator record
// an action (acknowledge / escalate / dismiss / override) inline.
const AUDIT_ACTION_TONE: Record<PredictionLogActionShape, 'success' | 'warning' | 'danger' | 'blue' | 'neutral'> = {
  created: 'neutral',
  viewed: 'neutral',
  acknowledged: 'success',
  overridden: 'warning',
  escalated: 'danger',
  dismissed: 'neutral',
  alert_triggered: 'danger',
  feedback_recorded: 'blue',
};
const OPERATOR_ACTIONS: PredictionLogActionShape[] = ['acknowledged', 'escalated', 'dismissed', 'overridden'];

function PredictionAuditPanel({ pid }: { pid: string }) {
  const qc = useQueryClient();
  const [action, setAction] = useState<PredictionLogActionShape>('acknowledged');
  const [note, setNote] = useState('');
  const trailQ = useQuery<PredictionLogTrailShape, Error>({
    queryKey: ['ex-audit', pid],
    queryFn: () => api.aiPredictionLog(pid),
    enabled: pid.length > 0,
    retry: false,
  });
  const recordMut = useMutation({
    mutationFn: () => api.aiPredictionLogRecord(pid, { action, note: note.trim() || undefined }),
    onSuccess: () => {
      setNote('');
      qc.invalidateQueries({ queryKey: ['ex-audit', pid] });
    },
  });

  return (
    <Panel title="Prediction audit log" data-testid="ex-audit-card">
      <p className="mb-3 text-xs text-muted">
        Compliance trail — every action + system event against this model decision, with actor and timestamp.
      </p>
      {trailQ.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !trailQ.data || trailQ.data.items.length === 0 ? (
        <p className="text-sm text-muted" data-testid="ex-audit-empty">No audit entries yet.</p>
      ) : (
        <ul className="space-y-2" data-testid="ex-audit-trail">
          {trailQ.data.items.map((e: PredictionLogEntryShape) => (
            <li key={e.log_id} className="flex items-start gap-3 border-l-2 border-divider/50 pl-3 text-sm" data-testid={`ex-audit-row-${e.action}`}>
              <Badge tone={AUDIT_ACTION_TONE[e.action]}>{e.action.replace(/_/g, ' ')}</Badge>
              <div className="min-w-0 flex-1">
                <div className="text-ink">
                  <span className="font-medium">{e.actor}</span>
                  {e.actor_role && <span className="text-xs text-muted"> · {e.actor_role}</span>}
                  {e.triggered_alert_id && <span className="ml-2 font-mono text-xs text-danger">→ {e.triggered_alert_id}</span>}
                </div>
                {e.note && <div className="text-xs text-muted">{e.note}</div>}
                <div className="text-[11px] text-muted">{new Date(e.created_at).toLocaleString()}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-divider/40 pt-3">
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as PredictionLogActionShape)}
          data-testid="ex-audit-action"
          className="rounded border border-divider bg-surface px-2 py-1.5 text-sm"
        >
          {OPERATOR_ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" data-testid="ex-audit-note" />
        <Button variant="primary" onClick={() => recordMut.mutate()} disabled={recordMut.isPending} data-testid="ex-audit-record">
          Record action
        </Button>
      </div>
    </Panel>
  );
}

function FeatureRow({
  feature,
  maxAbs,
}: {
  feature: ExplanationReport['top_features'][number];
  maxAbs: number;
}) {
  const pct = maxAbs === 0 ? 0 : (Math.abs(feature.weight) / maxAbs) * 100;
  const up = feature.direction === 'up';
  return (
    <li
      className="grid grid-cols-12 gap-3 items-center"
      data-testid={`ex-feature-${feature.feature_name}`}
    >
      <div className="col-span-4">
        <div className="text-sm font-medium">{feature.display_name}</div>
        <div className="text-xs text-muted">
          {feature.group} · observed {feature.observed_value}
        </div>
      </div>
      <div className="col-span-6">
        <div className="h-2 w-full rounded bg-divider/40 overflow-hidden">
          <div
            className={up ? 'h-full bg-danger' : 'h-full bg-success'}
            style={{ width: `${pct.toFixed(1)}%` }}
            data-testid={`ex-feature-bar-${feature.feature_name}`}
          />
        </div>
      </div>
      <div className="col-span-2 text-right">
        {up ? (
          <ArrowUpRight size={14} className="text-danger inline mr-1" />
        ) : (
          <ArrowDownRight size={14} className="text-success inline mr-1" />
        )}
        <span className="font-mono text-sm">{feature.weight.toFixed(3)}</span>
      </div>
    </li>
  );
}

function FeatureImportanceModal({
  prediction_id,
  report,
  isLoading,
  error,
  onClose,
}: {
  prediction_id: string;
  report: FeatureImportanceReport | null;
  isLoading: boolean;
  error: Error | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel="Full feature importance"
      size="2xl"
      testId="ex-importance-modal"
    >
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Feature importance — full ranking</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <XCircle size={16} />
          </Button>
        </header>
        <p className="text-xs text-muted font-mono">prediction: {prediction_id}</p>
        {isLoading && <p className="text-sm text-muted">Loading full ranking…</p>}
        {error && (
          <p className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            <AlertTriangle size={14} className="inline mr-1" />
            Could not load feature importance: {error.message}
          </p>
        )}
        {report && (
          <>
            <div className="text-xs text-muted">
              Total features: {report.total_features} · model {report.model_version}
            </div>
            <table className="w-full text-sm" data-testid="ex-importance-table">
              <thead className="text-left text-xs uppercase text-muted">
                <tr className="border-b border-divider/40">
                  <th className="py-2">Rank</th>
                  <th>Feature</th>
                  <th>Group</th>
                  <th>Direction</th>
                  <th>|Weight|</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {report.features.map((f) => (
                  <tr
                    key={f.feature_name}
                    className="border-b border-divider/40 hover:bg-divider/10"
                    data-testid={`ex-importance-row-${f.feature_name}`}
                  >
                    <td className="py-2 font-mono">{f.rank}</td>
                    <td>
                      <div className="font-medium">{f.display_name}</div>
                      <div className="text-xs text-muted">{f.observed_value}</div>
                    </td>
                    <td className="text-xs">{f.group}</td>
                    <td>
                      <Badge tone={f.direction === 'up' ? 'danger' : 'success'}>
                        {f.direction === 'up' ? '↑ raises PD' : '↓ protective'}
                      </Badge>
                    </td>
                    <td className="text-xs font-mono">{f.abs_weight.toFixed(3)}</td>
                    <td className="text-xs">{(f.pct_of_total * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Modal>
  );
}
