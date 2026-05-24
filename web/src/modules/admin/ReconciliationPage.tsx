// web/src/modules/admin/ReconciliationPage.tsx
//
// Module 1.6 — Reconciliation.
//
// Spec deliverables:
//   - Recon by Source table (definitions + their latest run rollup)
//   - Add-definition modal
//   - Mismatches modal w/ per-leg drill-down
//   - Rerun / Accept / Inject-drop affordances (the inject-drop closes
//     the spec acceptance — "deliberate row-drop produces non-zero gap")
//
// Wired to:
//   GET    /v1/recon/definitions
//   POST   /v1/recon/definitions
//   GET    /v1/recon/definitions/:id
//   PATCH  /v1/recon/definitions/:id      (spec says PUT; existing backend uses PATCH)
//   DELETE /v1/recon/definitions/:id
//   POST   /v1/recon/definitions/:id/run
//   GET    /v1/recon/runs
//   GET    /v1/recon/runs/:run_id
//   POST   /v1/recon/runs/:run_id/accept
//   POST   /v1/recon/definitions/:id/inject-drop
//   GET    /v1/recon/dashboard

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, Database, Eye, Plus, RefreshCw, Trash2, X, Zap,
} from 'lucide-react';
import {
  api,
  type ReconDefinitionShape,
  type ReconRunShape,
  type ReconKind,
  type ReconSeverity,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const KIND_OPTIONS: ReconKind[] = ['count_only', 'amount_match', 'set_diff'];
const SEVERITY_OPTIONS: ReconSeverity[] = ['high', 'medium', 'low'];

const STATUS_TONE: Record<string, BadgeTone> = {
  balanced: 'success',
  breaks_found: 'danger',
  error: 'danger',
  running: 'warning',
};
const SEVERITY_TONE: Record<ReconSeverity, BadgeTone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { hour12: false });
}

// gap + gap% helpers are kept in scope for future row-level display; the
// current table reads gap directly from definitions_status.latest_breaks.
function gap(run: ReconRunShape | null): number {
  if (!run) return 0;
  return run.source_only_count + run.target_only_count + run.amount_mismatch_count;
}
void gap;

export function ReconciliationPage() {
  const qc = useQueryClient();
  const [openDef, setOpenDef] = useState<ReconDefinitionShape | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [acceptingRunId, setAcceptingRunId] = useState<string | null>(null);
  const [acceptReason, setAcceptReason] = useState('');
  const [injectFor, setInjectFor] = useState<string | null>(null);
  const [injectKey, setInjectKey] = useState('');

  const defsQ = useQuery({
    queryKey: ['recon-defs'],
    queryFn: api.reconDefList,
  });
  const dashQ = useQuery({
    queryKey: ['recon-dash'],
    queryFn: api.reconDashboard,
  });
  const runsQ = useQuery({
    queryKey: ['recon-runs', openDef?.recon_id],
    queryFn: () => api.reconRunsList({ recon_id: openDef?.recon_id, limit: 10 }),
    enabled: !!openDef,
  });

  const createMut = useMutation({
    mutationFn: api.reconDefCreate,
    onSuccess: () => {
      setShowAdd(false);
      qc.invalidateQueries({ queryKey: ['recon-defs'] });
      qc.invalidateQueries({ queryKey: ['recon-dash'] });
    },
  });
  const deleteMut = useMutation({
    mutationFn: api.reconDefDelete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recon-defs'] });
      qc.invalidateQueries({ queryKey: ['recon-dash'] });
    },
  });
  const runMut = useMutation({
    mutationFn: (id: string) => api.reconDefRun(id),
    onSuccess: (_run, id) => {
      qc.invalidateQueries({ queryKey: ['recon-defs'] });
      qc.invalidateQueries({ queryKey: ['recon-dash'] });
      qc.invalidateQueries({ queryKey: ['recon-runs', id] });
    },
  });
  const acceptMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.reconRunAccept(id, reason),
    onSuccess: () => {
      setAcceptingRunId(null);
      setAcceptReason('');
      qc.invalidateQueries({ queryKey: ['recon-runs'] });
    },
  });
  const injectMut = useMutation({
    mutationFn: ({ id, row_key }: { id: string; row_key: string }) =>
      api.reconInjectDrop(id, row_key, 'staging'),
    onSuccess: () => {
      setInjectFor(null);
      setInjectKey('');
    },
  });

  const dashboard = dashQ.data;
  const defs = defsQ.data?.items ?? [];
  const definitionStatuses = useMemo(() => dashboard?.definitions_status ?? [], [dashboard]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Reconciliation"
        subtitle="Verify data flow Source → Staging → Warehouse by counts, hashes, and totals"
        actions={
          <Button onClick={() => setShowAdd(true)} data-testid="recon-add">
            <Plus size={14} /> Add definition
          </Button>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard
          label="Definitions"
          value={dashboard?.total_definitions ?? 0}
          sub={`${dashboard?.active_definitions ?? 0} active`}
          testId="recon-kpi-defs"
        />
        <MetricCard
          label="Balanced runs"
          value={dashboard?.total_balanced ?? 0}
          sub="all-time"
          tone="success"
          testId="recon-kpi-balanced"
        />
        <MetricCard
          label="Breaks found"
          value={dashboard?.total_breaks_found ?? 0}
          sub="all-time"
          tone="danger"
          testId="recon-kpi-breaks"
        />
        <MetricCard
          label="Breaks (24h)"
          value={dashboard?.total_breaks_24h ?? 0}
          sub="recent gap signals"
          tone="warning"
          testId="recon-kpi-breaks-24h"
        />
      </div>

      {/* Recon by Source table */}
      <Panel title="Recon by Source" data-testid="recon-table-panel">
        {defsQ.isLoading ? (
          <div className="text-sm text-slate-500">Loading definitions…</div>
        ) : defs.length === 0 ? (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            No recon definitions configured yet. Click <b>Add definition</b> to create one.
          </div>
        ) : (
          <div className="overflow-x-auto" data-testid="recon-table">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Recon</th>
                  <th className="px-2 py-1.5">Source → Target</th>
                  <th className="px-2 py-1.5">Kind</th>
                  <th className="px-2 py-1.5">Severity</th>
                  <th className="px-2 py-1.5">Source / Target</th>
                  <th className="px-2 py-1.5">Gap</th>
                  <th className="px-2 py-1.5">Gap %</th>
                  <th className="px-2 py-1.5">Last run</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {defs.map((d) => {
                  const ds = definitionStatuses.find((s) => s.recon_id === d.recon_id);
                  return (
                    <tr key={d.recon_id} className="border-b border-slate-100" data-testid={`recon-row-${d.recon_id}`}>
                      <td className="px-2 py-2">
                        <div className="font-medium">{d.name}</div>
                        <div className="font-mono text-xs text-slate-500">{d.recon_id}</div>
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">
                        {d.source_label}<br />
                        <span className="text-slate-400">→</span> {d.target_label}
                      </td>
                      <td className="px-2 py-2 text-xs">{d.kind}</td>
                      <td className="px-2 py-2"><Badge tone={SEVERITY_TONE[d.severity]}>{d.severity}</Badge></td>
                      <td className="px-2 py-2 text-xs">
                        {ds?.latest_status ? `${ds.latest_breaks ?? 0} of ${ds.latest_breaks !== null ? '—' : '—'}` : '—'}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">{ds?.latest_breaks ?? '—'}</td>
                      <td className="px-2 py-2 font-mono text-xs">
                        {ds?.latest_breaks !== null && ds?.latest_breaks !== undefined ? `${ds.latest_breaks} breaks` : '—'}
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-500">{fmtTime(ds?.latest_at ?? null)}</td>
                      <td className="px-2 py-2">
                        {ds?.latest_status
                          ? <Badge tone={STATUS_TONE[ds.latest_status] ?? 'neutral'}>{ds.latest_status}</Badge>
                          : <span className="text-xs text-slate-400">never run</span>}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" onClick={() => runMut.mutate(d.recon_id)} title="Rerun" data-testid={`recon-run-${d.recon_id}`}>
                            <RefreshCw size={14} className={runMut.isPending && runMut.variables === d.recon_id ? 'animate-spin' : ''} />
                          </Button>
                          <Button variant="ghost" onClick={() => setOpenDef(d)} title="View runs + mismatches" data-testid={`recon-open-${d.recon_id}`}>
                            <Eye size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => { setInjectFor(d.recon_id); setInjectKey(`${d.recon_id}-row-00050`); }}
                            title="Inject staging row-drop (demo)"
                            data-testid={`recon-inject-${d.recon_id}`}
                          >
                            <Zap size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => { if (confirm(`Delete ${d.recon_id}?`)) deleteMut.mutate(d.recon_id); }}
                            title="Delete (soft)"
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Add definition modal */}
      {showAdd && (
        <AddDefinitionModal
          onClose={() => setShowAdd(false)}
          onSubmit={(body) => createMut.mutate(body)}
          isPending={createMut.isPending}
        />
      )}

      {/* Runs / mismatches modal */}
      {openDef && (
        <ReconDetailModal
          def={openDef}
          runs={runsQ.data?.items ?? []}
          isLoading={runsQ.isLoading}
          onClose={() => setOpenDef(null)}
          onAccept={(runId) => setAcceptingRunId(runId)}
        />
      )}

      {/* Accept reason prompt */}
      {acceptingRunId && (
        <AcceptModal
          runId={acceptingRunId}
          reason={acceptReason}
          setReason={setAcceptReason}
          onClose={() => { setAcceptingRunId(null); setAcceptReason(''); }}
          onSubmit={() => acceptMut.mutate({ id: acceptingRunId, reason: acceptReason })}
          isPending={acceptMut.isPending}
        />
      )}

      {/* Inject-drop prompt */}
      {injectFor && (
        <InjectDropModal
          reconId={injectFor}
          rowKey={injectKey}
          setRowKey={setInjectKey}
          onClose={() => { setInjectFor(null); setInjectKey(''); }}
          onSubmit={() => injectMut.mutate({ id: injectFor, row_key: injectKey })}
          isPending={injectMut.isPending}
        />
      )}
    </div>
  );
}

// ── Add Definition Modal ───────────────────────────────────────────────

function AddDefinitionModal({
  onClose,
  onSubmit,
  isPending,
}: {
  onClose: () => void;
  onSubmit: (body: Partial<ReconDefinitionShape>) => void;
  isPending: boolean;
}) {
  const [reconId, setReconId] = useState('');
  const [name, setName] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [targetLabel, setTargetLabel] = useState('');
  const [keyField, setKeyField] = useState('');
  const [amountField, setAmountField] = useState('');
  const [kind, setKind] = useState<ReconKind>('count_only');
  const [severity, setSeverity] = useState<ReconSeverity>('high');

  const canSubmit = reconId.trim() && name.trim() && sourceLabel.trim() && targetLabel.trim() && keyField.trim();

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="recon-add-modal">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <h3 className="font-semibold">Add reconciliation definition</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700"><X size={18} /></button>
        </div>

        <div className="space-y-2 text-sm">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Recon ID (lowercase + underscores)</span>
            <input value={reconId} onChange={(e) => setReconId(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 font-mono" placeholder="rcn_loans_staging" data-testid="recon-add-id" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Display name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5" placeholder="CBS Loans → Staging" data-testid="recon-add-name" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Source label</span>
              <input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 font-mono" placeholder="cbs.loan_book" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Target label</span>
              <input value={targetLabel} onChange={(e) => setTargetLabel(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 font-mono" placeholder="staging.loans" />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Key column (join field)</span>
            <input value={keyField} onChange={(e) => setKeyField(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 font-mono" placeholder="loan_id" />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as ReconKind)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5">
                {KIND_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Severity</span>
              <select value={severity} onChange={(e) => setSeverity(e.target.value as ReconSeverity)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5">
                {SEVERITY_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            {kind === 'amount_match' && (
              <label className="block">
                <span className="text-xs font-medium text-slate-600">Amount field</span>
                <input value={amountField} onChange={(e) => setAmountField(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 font-mono" placeholder="amount" />
              </label>
            )}
          </div>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!canSubmit || isPending}
            onClick={() => onSubmit({
              recon_id: reconId,
              name,
              source_label: sourceLabel,
              target_label: targetLabel,
              key_field: keyField,
              amount_field: kind === 'amount_match' ? amountField : null,
              kind,
              severity,
            })}
            data-testid="recon-add-submit"
          >
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Recon Detail Modal — runs + mismatches drill-down ──────────────────

function ReconDetailModal({
  def,
  runs,
  isLoading,
  onClose,
  onAccept,
}: {
  def: ReconDefinitionShape;
  runs: ReconRunShape[];
  isLoading: boolean;
  onClose: () => void;
  onAccept: (runId: string) => void;
}) {
  const [expandedLeg, setExpandedLeg] = useState<'source' | 'target' | null>(null);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="recon-detail-modal">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="font-semibold">{def.name}</h3>
            <div className="mt-1 font-mono text-xs text-slate-500">
              {def.source_label} → {def.target_label} · key={def.key_field}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700"><X size={18} /></button>
        </div>

        {/* Per-leg modals: 3-card row showing each leg's view */}
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="recon-legs">
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs font-semibold text-slate-500">SOURCE</div>
            <div className="mt-1 font-mono text-sm">{def.source_label}</div>
            <button onClick={() => setExpandedLeg('source')} className="mt-2 text-xs text-blue-700 underline">View →</button>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs font-semibold text-slate-500">TARGET</div>
            <div className="mt-1 font-mono text-sm">{def.target_label}</div>
            <button onClick={() => setExpandedLeg('target')} className="mt-2 text-xs text-blue-700 underline">View →</button>
          </div>
          <div className="rounded border border-slate-200 p-3">
            <div className="text-xs font-semibold text-slate-500">KEY</div>
            <div className="mt-1 font-mono text-sm">{def.key_field}</div>
            <div className="mt-1 text-xs text-slate-500">Severity {def.severity} · {def.kind}</div>
          </div>
        </div>

        {expandedLeg && (
          <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900" data-testid={`recon-leg-${expandedLeg}`}>
            <span className="font-semibold">{expandedLeg.toUpperCase()} view:</span>{' '}
            <span className="font-mono">{expandedLeg === 'source' ? def.source_label : def.target_label}</span>
            {' — '}
            <span className="text-xs text-blue-800">
              In production this would query the live table; the prototype synthesises rows on
              demand via the recon engine's deterministic baseline.
            </span>
            <button onClick={() => setExpandedLeg(null)} className="ml-2 text-xs underline">close</button>
          </div>
        )}

        <h4 className="mb-2 mt-3 text-sm font-semibold">Recent runs</h4>
        {isLoading ? (
          <div className="text-sm text-slate-500">Loading runs…</div>
        ) : runs.length === 0 ? (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
            No runs yet — click Rerun on the parent row.
          </div>
        ) : (
          <div className="space-y-3">
            {runs.map((r) => {
              const breakCount = r.source_only_count + r.target_only_count + r.amount_mismatch_count;
              return (
                <div key={r.run_id} className="rounded border border-slate-200 p-3" data-testid={`recon-run-${r.run_id}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                      <span className="ml-2 text-xs text-slate-500">{fmtTime(r.started_at)}</span>
                      <span className="ml-2 font-mono text-xs text-slate-400">{r.run_id.slice(0, 32)}…</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {r.accepted_at ? (
                        <Badge tone="blue">accepted by {r.accepted_by}</Badge>
                      ) : breakCount > 0 ? (
                        <Button variant="ghost" onClick={() => onAccept(r.run_id)} data-testid={`recon-accept-${r.run_id}`}>
                          <CheckCircle2 size={14} /> Mark accepted
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
                    <Stat label="Source" value={r.source_count.toLocaleString()} />
                    <Stat label="Target" value={r.target_count.toLocaleString()} />
                    <Stat label="Matched" value={r.matched_count.toLocaleString()} />
                    <Stat label="Breaks" value={breakCount.toLocaleString()} tone={breakCount > 0 ? 'danger' : 'success'} />
                  </div>
                  {r.sample_breaks.length > 0 && (
                    <details className="mt-2 rounded border border-slate-200" data-testid={`recon-mismatches-${r.run_id}`}>
                      <summary className="cursor-pointer bg-slate-50 px-2 py-1 text-xs">
                        Mismatches ({r.sample_breaks.length})
                      </summary>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[400px] text-left text-xs">
                          <thead className="border-b border-slate-200 text-slate-500">
                            <tr>
                              <th className="px-2 py-1">Key</th>
                              <th className="px-2 py-1">Kind</th>
                              <th className="px-2 py-1">Source amt</th>
                              <th className="px-2 py-1">Target amt</th>
                              <th className="px-2 py-1">Delta</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.sample_breaks.map((b) => (
                              <tr key={b.key} className="border-b border-slate-100" data-testid={`recon-mismatch-${b.key}`}>
                                <td className="px-2 py-1 font-mono">{b.key}</td>
                                <td className="px-2 py-1">
                                  <Badge tone={b.kind === 'amount_mismatch' ? 'warning' : 'danger'}>{b.kind}</Badge>
                                </td>
                                <td className="px-2 py-1 font-mono">{b.source_amount ?? '—'}</td>
                                <td className="px-2 py-1 font-mono">{b.target_amount ?? '—'}</td>
                                <td className="px-2 py-1 font-mono">{b.delta ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                  {r.accepted_at && r.accepted_reason && (
                    <div className="mt-2 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-900">
                      <span className="font-semibold">Accepted reason:</span> {r.accepted_reason}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: BadgeTone }) {
  return (
    <div className="rounded border border-slate-200 px-2 py-1 text-xs">
      <div className="text-slate-500">{label}</div>
      <div className={tone === 'danger' ? 'font-mono text-danger' : tone === 'success' ? 'font-mono text-success' : 'font-mono'}>
        {value}
      </div>
    </div>
  );
}

// ── Accept Modal ───────────────────────────────────────────────────────

function AcceptModal({
  runId,
  reason,
  setReason,
  onClose,
  onSubmit,
  isPending,
}: {
  runId: string;
  reason: string;
  setReason: (s: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  void runId; // displayed in body if needed
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="recon-accept-modal">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h3 className="mb-2 font-semibold">Mark recon run as accepted</h3>
        <p className="mb-3 text-xs text-slate-500">A reason is required for the audit trail.</p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          placeholder="e.g. Known late EOM batch — accepted by ops"
          data-testid="recon-accept-reason"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!reason.trim() || isPending} onClick={onSubmit} data-testid="recon-accept-submit">
            Confirm accept
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Inject Drop Modal ──────────────────────────────────────────────────

function InjectDropModal({
  reconId,
  rowKey,
  setRowKey,
  onClose,
  onSubmit,
  isPending,
}: {
  reconId: string;
  rowKey: string;
  setRowKey: (s: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="recon-inject-modal">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h3 className="mb-2 flex items-center gap-2 font-semibold">
          <AlertTriangle size={16} className="text-warning" />
          Inject staging row-drop (demo)
        </h3>
        <p className="mb-3 text-xs text-slate-500">
          This deliberately drops a row from the staging leg for <code className="font-mono">{reconId}</code>.
          The next run will surface this key in the mismatches modal. Production swap → real DB row-drop test.
        </p>
        <label className="block text-sm">
          <span className="text-xs font-medium text-slate-600">Row key to drop</span>
          <input
            value={rowKey}
            onChange={(e) => setRowKey(e.target.value)}
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-sm"
            data-testid="recon-inject-key"
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!rowKey.trim() || isPending} onClick={onSubmit} data-testid="recon-inject-submit">
            Inject drop
          </Button>
        </div>
      </div>
    </div>
  );
}

void Database;
