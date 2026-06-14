// web/src/modules/insurance/ClaimInvestigationPage.tsx
//
// Insurance EWS — Module 8: Claim Investigation Panel (SIU workspace).
//
// Makes the read-only suspicious-claims queue actionable: open an investigation
// from a flagged claim, work the 6-state lifecycle, add notes + evidence/
// attachments, link EWS alerts, escalate to the SIU lead, and record a fraud
// decision. Two panels (suspicious queue + open investigations) + a detail
// workspace modal. Backed by /v1/insurance/siu/*; MSW-backed in dev.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, FileSearch, Paperclip, Link2, ArrowUpCircle } from 'lucide-react';
import {
  api,
  type SiuQueueShape,
  type SiuListShape,
  type SiuInvestigationShape,
  type SiuStatusShape,
  type SiuDecisionShape,
  type SiuEvidenceTypeShape,
} from '@/lib/api';
import { Badge, Button, EnterpriseDialog, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const fmtKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

const STATUS_TONE: Record<SiuStatusShape, BadgeTone> = {
  triage: 'blue',
  evidence_gathering: 'warning',
  awaiting_response: 'warning',
  review: 'purple',
  decision: 'warning',
  closed: 'neutral',
};
const STATUS_LABEL: Record<SiuStatusShape, string> = {
  triage: 'Triage',
  evidence_gathering: 'Evidence gathering',
  awaiting_response: 'Awaiting response',
  review: 'Review',
  decision: 'Decision',
  closed: 'Closed',
};
// Legal next-states per the BFF state machine.
const NEXT: Record<SiuStatusShape, SiuStatusShape[]> = {
  triage: ['evidence_gathering', 'closed'],
  evidence_gathering: ['awaiting_response', 'review', 'closed'],
  awaiting_response: ['evidence_gathering', 'review', 'closed'],
  review: ['decision', 'evidence_gathering', 'closed'],
  decision: ['closed', 'review'],
  closed: ['evidence_gathering'],
};
const DECISIONS: SiuDecisionShape[] = ['fraud_confirmed', 'fraud_unsubstantiated', 'partial_fraud', 'data_quality'];
const EVIDENCE_TYPES: SiuEvidenceTypeShape[] = ['document', 'photo', 'statement', 'system_record', 'external_report'];

function anomalyTone(score: number): BadgeTone {
  if (score >= 0.85) return 'danger';
  if (score >= 0.65) return 'warning';
  return 'blue';
}

export function ClaimInvestigationPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const { data: queue } = useQuery<SiuQueueShape>({ queryKey: ['siu.queue'], queryFn: () => api.siuQueue() });
  const { data: list } = useQuery<SiuListShape>({ queryKey: ['siu.list'], queryFn: () => api.siuList() });

  const openMut = useMutation({
    mutationFn: (claim_id: string) => api.siuOpen({ claim_id }),
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ['siu.queue'] });
      qc.invalidateQueries({ queryKey: ['siu.list'] });
      setSelected(inv.investigation_id);
    },
  });

  const openCount = list?.items.filter((i) => i.status !== 'closed').length ?? 0;
  const escalatedCount = list?.items.filter((i) => i.escalated).length ?? 0;
  const confirmedCount = list?.items.filter((i) => i.decision === 'fraud_confirmed').length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Claim Investigation (SIU)"
        subtitle="Special Investigation Unit workspace. Open investigations from the suspicious-claims queue, gather evidence, link alerts, escalate, and record fraud decisions through a governed lifecycle."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard label="Suspicious claims" value={queue?.total.toString() ?? '—'} tone="warning" testId="siu-kpi-queue" />
        <MetricCard label="Open investigations" value={openCount.toString()} tone="blue" testId="siu-kpi-open" />
        <MetricCard label="Escalated" value={escalatedCount.toString()} tone="danger" testId="siu-kpi-escalated" />
        <MetricCard label="Fraud confirmed" value={confirmedCount.toString()} tone="danger" testId="siu-kpi-confirmed" />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Suspicious claims queue */}
        <Panel title="Suspicious claims queue" action={<span className="text-xs text-ink-subtle">worst-first by anomaly score</span>}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="siu-queue-table">
              <thead className="text-left text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-3">Claim / Claimant</th>
                  <th className="pb-2 pr-3 text-right">Amount</th>
                  <th className="pb-2 pr-3 text-right">Score</th>
                  <th className="pb-2 pr-3">Reasons</th>
                  <th className="pb-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {queue?.claims.map((c) => (
                  <tr key={c.claim_id} data-testid={`siu-queue-${c.claim_id}`} className="border-t border-divider align-top">
                    <td className="py-2 pr-3">
                      <div className="font-mono text-xs">{c.claim_id}</div>
                      <div className="text-xs text-ink-subtle">{c.claimant_name} · {c.product}</div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtKES(c.claim_amount_kes)}</td>
                    <td className="py-2 pr-3 text-right">
                      <Badge tone={anomalyTone(c.anomaly_score)}>{c.anomaly_score.toFixed(2)}</Badge>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {c.suspicion_reasons.map((r) => (
                          <span key={r} className="rounded bg-divider/30 px-1.5 py-0.5 text-[10px] text-ink-subtle">{r.replace(/_/g, ' ')}</span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {c.has_open_investigation ? (
                        <span className="text-xs text-success">● investigating</span>
                      ) : (
                        <Button variant="ghost" onClick={() => openMut.mutate(c.claim_id)} disabled={openMut.isPending} data-testid={`siu-open-${c.claim_id}`}>
                          <FileSearch className="mr-1 size-4" />
                          Investigate
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Open investigations */}
        <Panel title="Investigations" action={list ? <span className="text-xs text-ink-subtle">{list.total} total</span> : null}>
          {!list || list.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-subtle" data-testid="siu-list-empty">
              No investigations yet — open one from the queue.
            </p>
          ) : (
            <ul className="divide-y divide-divider" data-testid="siu-list">
              {list.items.map((inv) => (
                <li key={inv.investigation_id}>
                  <button
                    onClick={() => setSelected(inv.investigation_id)}
                    data-testid={`siu-inv-${inv.investigation_id}`}
                    className="flex w-full items-center gap-3 py-3 text-left hover:bg-action/5"
                  >
                    <ShieldAlert className={`size-4 ${inv.escalated ? 'text-danger' : 'text-ink-subtle'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{inv.claimant_name} · <span className="font-mono text-xs">{inv.claim_id}</span></div>
                      <div className="text-xs text-ink-subtle">{inv.product} · {fmtKES(inv.claim_amount_kes)}</div>
                    </div>
                    <Badge tone={STATUS_TONE[inv.status]}>{STATUS_LABEL[inv.status]}</Badge>
                    {inv.decision && <Badge tone={inv.decision === 'fraud_confirmed' ? 'danger' : 'neutral'}>{inv.decision.replace(/_/g, ' ')}</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {selected && <InvestigationModal investigation_id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function InvestigationModal({ investigation_id, onClose }: { investigation_id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<SiuInvestigationShape>({
    queryKey: ['siu.inv', investigation_id],
    queryFn: () => api.siuGet(investigation_id),
  });

  const [noteBody, setNoteBody] = useState('');
  const [evType, setEvType] = useState<SiuEvidenceTypeShape>('document');
  const [evTitle, setEvTitle] = useState('');
  const [evRef, setEvRef] = useState('');
  const [alertId, setAlertId] = useState('');
  const [decision, setDecision] = useState<SiuDecisionShape>('fraud_confirmed');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['siu.inv', investigation_id] });
    qc.invalidateQueries({ queryKey: ['siu.list'] });
    qc.invalidateQueries({ queryKey: ['siu.queue'] });
  };

  const statusMut = useMutation({
    mutationFn: (input: { status: SiuStatusShape; decision?: SiuDecisionShape }) => api.siuSetStatus(investigation_id, input),
    onSuccess: invalidate,
  });
  const noteMut = useMutation({ mutationFn: () => api.siuAddNote(investigation_id, noteBody), onSuccess: () => { setNoteBody(''); invalidate(); } });
  const evMut = useMutation({ mutationFn: () => api.siuAddEvidence(investigation_id, { type: evType, title: evTitle, attachment_ref: evRef || undefined }), onSuccess: () => { setEvTitle(''); setEvRef(''); invalidate(); } });
  const escMut = useMutation({ mutationFn: () => api.siuEscalate(investigation_id), onSuccess: invalidate });
  const linkMut = useMutation({ mutationFn: () => api.siuLinkAlert(investigation_id, alertId), onSuccess: () => { setAlertId(''); invalidate(); } });

  return (
    <EnterpriseDialog open onClose={onClose} title={data ? `Investigation — ${data.claim_id}` : 'Investigation'} size="lg" testId="siu-detail-modal">
      {isLoading || !data ? (
        <p className="text-sm text-ink-subtle">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{data.claimant_name}</span>
            <Badge tone={STATUS_TONE[data.status]}>{STATUS_LABEL[data.status]}</Badge>
            <Badge tone={anomalyTone(data.anomaly_score)}>anomaly {data.anomaly_score.toFixed(2)}</Badge>
            {data.escalated && <Badge tone="danger">Escalated</Badge>}
            {data.decision && <Badge tone={data.decision === 'fraud_confirmed' ? 'danger' : 'neutral'}>{data.decision.replace(/_/g, ' ')}</Badge>}
            <span className="text-xs text-ink-subtle">{data.product} · {fmtKES(data.claim_amount_kes)} · {data.policy_id}</span>
          </div>

          {/* Lifecycle controls */}
          <div className="rounded-lg border border-divider p-4" data-testid="siu-lifecycle">
            <div className="mb-2 text-xs font-semibold uppercase text-ink-subtle">Move to</div>
            <div className="flex flex-wrap items-center gap-2">
              {NEXT[data.status].filter((s) => s !== 'closed').map((s) => (
                <Button key={s} variant="ghost" onClick={() => statusMut.mutate({ status: s })} disabled={statusMut.isPending} data-testid={`siu-to-${s}`}>
                  {STATUS_LABEL[s]}
                </Button>
              ))}
              {NEXT[data.status].includes('closed') && (
                <div className="flex items-center gap-2">
                  {(data.status === 'review' || data.status === 'decision') && (
                    <select value={decision} onChange={(e) => setDecision(e.target.value as SiuDecisionShape)} data-testid="siu-decision-select" className="rounded border border-divider bg-surface px-2 py-1 text-sm">
                      {DECISIONS.map((d) => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}
                    </select>
                  )}
                  <Button
                    variant="danger"
                    onClick={() => statusMut.mutate({ status: 'closed', decision: data.status === 'review' || data.status === 'decision' ? decision : undefined })}
                    disabled={statusMut.isPending}
                    data-testid="siu-close"
                  >
                    Close
                  </Button>
                </div>
              )}
              {!data.escalated && (
                <Button variant="ghost" onClick={() => escMut.mutate()} disabled={escMut.isPending} data-testid="siu-escalate">
                  <ArrowUpCircle className="mr-1 size-4" />
                  Escalate to SIU lead
                </Button>
              )}
            </div>
          </div>

          {/* Evidence */}
          <Panel title={`Evidence (${data.evidence.length})`}>
            {data.evidence.length === 0 ? (
              <p className="text-sm text-ink-subtle">No evidence attached.</p>
            ) : (
              <ul className="space-y-2" data-testid="siu-evidence-list">
                {data.evidence.map((ev) => (
                  <li key={ev.evidence_id} className="flex items-start gap-2 text-sm">
                    <Paperclip className="mt-0.5 size-4 text-ink-subtle" />
                    <div>
                      <span className="font-medium">{ev.title}</span> <span className="text-xs text-ink-subtle">({ev.type.replace(/_/g, ' ')})</span>
                      {ev.description && <div className="text-xs text-ink-subtle">{ev.description}</div>}
                      {ev.attachment_ref && <div className="font-mono text-xs text-action">{ev.attachment_ref}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 grid grid-cols-1 gap-2 border-t border-divider pt-3 md:grid-cols-4">
              <select value={evType} onChange={(e) => setEvType(e.target.value as SiuEvidenceTypeShape)} data-testid="siu-ev-type" className="rounded border border-divider bg-surface px-2 py-1 text-sm">
                {EVIDENCE_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
              <input value={evTitle} onChange={(e) => setEvTitle(e.target.value)} placeholder="Evidence title" data-testid="siu-ev-title" className="rounded border border-divider bg-surface px-2 py-1 text-sm md:col-span-2" />
              <input value={evRef} onChange={(e) => setEvRef(e.target.value)} placeholder="Attachment ref (optional)" data-testid="siu-ev-ref" className="rounded border border-divider bg-surface px-2 py-1 text-sm" />
            </div>
            <div className="mt-2">
              <Button onClick={() => evMut.mutate()} disabled={evMut.isPending || !evTitle.trim()} data-testid="siu-ev-add">Add evidence</Button>
            </div>
          </Panel>

          {/* Linked alerts */}
          <Panel title={`Linked alerts (${data.linked_alerts.length})`}>
            <div className="flex flex-wrap gap-2" data-testid="siu-linked-alerts">
              {data.linked_alerts.length === 0 ? (
                <span className="text-sm text-ink-subtle">No alerts linked.</span>
              ) : (
                data.linked_alerts.map((a) => <span key={a} className="rounded bg-divider/40 px-1.5 py-0.5 font-mono text-xs">{a}</span>)
              )}
            </div>
            <div className="mt-3 flex items-end gap-2 border-t border-divider pt-3">
              <input value={alertId} onChange={(e) => setAlertId(e.target.value)} placeholder="a-700001" data-testid="siu-link-input" className="rounded border border-divider bg-surface px-2 py-1 text-sm" />
              <Button variant="ghost" onClick={() => linkMut.mutate()} disabled={linkMut.isPending || !alertId.trim()} data-testid="siu-link-add">
                <Link2 className="mr-1 size-4" />
                Link alert
              </Button>
            </div>
          </Panel>

          {/* Notes thread */}
          <Panel title={`Investigation notes (${data.notes.length})`}>
            {data.notes.length === 0 ? (
              <p className="text-sm text-ink-subtle">No notes yet.</p>
            ) : (
              <ul className="space-y-2" data-testid="siu-notes-list">
                {data.notes.map((n) => (
                  <li key={n.note_id} className="border-l-2 border-divider pl-3 text-sm">
                    <div className="text-ink">{n.body}</div>
                    <div className="text-xs text-ink-subtle">{n.author} · {new Date(n.ts).toLocaleString()}</div>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex items-end gap-2 border-t border-divider pt-3">
              <textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="Add an investigation note…" data-testid="siu-note-input" rows={2} className="flex-1 rounded border border-divider bg-surface px-2 py-1 text-sm" />
              <Button onClick={() => noteMut.mutate()} disabled={noteMut.isPending || !noteBody.trim()} data-testid="siu-note-add">Add note</Button>
            </div>
          </Panel>
        </div>
      )}
    </EnterpriseDialog>
  );
}
