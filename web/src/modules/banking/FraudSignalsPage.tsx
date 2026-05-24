// web/src/modules/banking/FraudSignalsPage.tsx
//
// Module 2.6 — Fraud Signals (AI).
//
// 8 BFF endpoints back this screen (all pre-existing per cross-cutting #1):
//   GET    /v1/fraud/cases?status=&priority=&assignee=
//   POST   /v1/fraud/cases                                   (create)
//   GET    /v1/fraud/cases/:case_id
//   PATCH  /v1/fraud/cases/:case_id                          (update status / assignee)
//   GET    /v1/fraud/rules?enabled_only=
//   POST   /v1/fraud/rules                                   (create)
//   POST   /v1/fraud/cases/:case_id/sar                      (SAR — audit fan-out + lock)
//   POST   /v1/fraud/cases/:case_id/vigilance                (refer — audit fan-out + lock)

import { useState, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertOctagon,
  Eye,
  FileWarning,
  Plus,
  Shield,
  ShieldAlert,
  X,
} from 'lucide-react';
import { Badge, Button, Input, MetricCard, Panel } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { api } from '@/lib/api';
import type {
  FraudCaseShape,
  FraudCaseStatus,
  FraudCategory,
  FraudCasesListShape,
  FraudPriority,
  FraudRuleShape,
  FraudRulesListShape,
} from '@/lib/api';

const STATUS_TONE: Record<FraudCaseStatus, BadgeTone> = {
  open: 'warning',
  investigating: 'blue',
  reported: 'danger',
  closed: 'success',
  false_positive: 'neutral',
};

const PRIORITY_TONE: Record<FraudPriority, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const CATEGORIES: FraudCategory[] = [
  'identity_theft',
  'cheque_fraud',
  'card_fraud',
  'cyber_fraud',
  'loan_fraud',
  'account_takeover',
  'staff_collusion',
  'other',
];

const fmtKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

function humanize(s: string): string {
  return s.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function FraudSignalsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<FraudCaseStatus | ''>('');
  const [priorityFilter, setPriorityFilter] = useState<FraudPriority | ''>('');
  const [openCase, setOpenCase] = useState<FraudCaseShape | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [sarFor, setSarFor] = useState<FraudCaseShape | null>(null);
  const [vigilanceFor, setVigilanceFor] = useState<FraudCaseShape | null>(null);

  const casesQ = useQuery({
    queryKey: ['fraud.cases', statusFilter, priorityFilter],
    queryFn: () =>
      api.fraudCasesList({
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
      }) as Promise<FraudCasesListShape>,
  });

  const cases = casesQ.data?.cases ?? [];
  const stats = {
    total: cases.length,
    open: cases.filter((c) => c.status === 'open').length,
    investigating: cases.filter((c) => c.status === 'investigating').length,
    reported: cases.filter((c) => c.status === 'reported').length,
    exposure: cases.reduce((acc, c) => acc + (c.amount_kes ?? 0), 0),
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Fraud Signals"
        subtitle="AI-scored fraud cases — cheque kiting, account takeover, mule accounts, identity + document fraud. SAR + vigilance referral with audit lock."
        actions={
          <Button variant="ghost" onClick={() => setRulesOpen(true)} data-testid="fraud-open-rules">
            <Shield className="h-4 w-4 mr-2" /> Manage rules
          </Button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <MetricCard testId="fraud-kpi-total" label="Active cases" value={stats.total} />
        <MetricCard testId="fraud-kpi-open" label="Open" value={stats.open} tone="warning" />
        <MetricCard testId="fraud-kpi-investigating" label="Investigating" value={stats.investigating} />
        <MetricCard testId="fraud-kpi-reported" label="SAR filed" value={stats.reported} tone="danger" />
        <MetricCard testId="fraud-kpi-exposure" label="Exposure at risk" value={fmtKES(stats.exposure)} />
      </div>

      <Panel>
        <div className="flex flex-wrap items-end gap-3" data-testid="fraud-filter-bar">
          <div>
            <label className="text-xs text-ink-subtle">Status</label>
            <select
              data-testid="fraud-status-filter"
              className="h-9 rounded border border-divider bg-surface px-2 text-sm w-44"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as FraudCaseStatus | '')}
            >
              <option value="">Any</option>
              <option value="open">Open</option>
              <option value="investigating">Investigating</option>
              <option value="reported">SAR filed</option>
              <option value="closed">Closed</option>
              <option value="false_positive">False positive</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-ink-subtle">Priority</label>
            <select
              data-testid="fraud-priority-filter"
              className="h-9 rounded border border-divider bg-surface px-2 text-sm w-32"
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as FraudPriority | '')}
            >
              <option value="">Any</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          {(statusFilter || priorityFilter) && (
            <Button
              variant="ghost"
              data-testid="fraud-clear-filters"
              onClick={() => {
                setStatusFilter('');
                setPriorityFilter('');
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </Panel>

      <Panel title={`Active fraud cases (${cases.length})`}>
        {casesQ.isLoading ? (
          <div className="text-sm text-ink-subtle">Loading cases…</div>
        ) : cases.length === 0 ? (
          <div className="py-6 text-center text-sm text-ink-subtle">No fraud cases matching the current filters.</div>
        ) : (
          <div className="overflow-x-auto" data-testid="fraud-cases-table">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-ink-subtle">
                <tr>
                  <th className="text-left px-2 py-2">Case ID</th>
                  <th className="text-left px-2 py-2">Customer</th>
                  <th className="text-left px-2 py-2">Fraud type</th>
                  <th className="text-left px-2 py-2">Priority</th>
                  <th className="text-right px-2 py-2">Exposure (KES)</th>
                  <th className="text-left px-2 py-2">Status</th>
                  <th className="text-left px-2 py-2">Assignee</th>
                  <th className="text-left px-2 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.case_id} className="border-t border-divider hover:bg-surface-2/40">
                    <td className="px-2 py-1.5 font-mono text-xs">{c.case_id}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{c.customer_id ?? '—'}</div>
                      <div className="text-xs text-ink-subtle font-mono">{c.account_id ?? '—'}</div>
                    </td>
                    <td className="px-2 py-1.5">{humanize(c.category)}</td>
                    <td className="px-2 py-1.5"><Badge tone={PRIORITY_TONE[c.priority]}>{c.priority}</Badge></td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmtKES(c.amount_kes)}</td>
                    <td className="px-2 py-1.5">
                      <Badge tone={STATUS_TONE[c.status]}>{humanize(c.status)}</Badge>
                      {c.sar_id && <span className="ml-1 text-xs text-danger">SAR</span>}
                      {c.vigilance_ref && <span className="ml-1 text-xs text-warning">VIG</span>}
                    </td>
                    <td className="px-2 py-1.5 text-xs">{c.assignee ?? <span className="text-ink-subtle">unassigned</span>}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-1 text-xs">
                        <button
                          data-testid={`fraud-open-${c.case_id}`}
                          className="text-action hover:underline"
                          onClick={() => setOpenCase(c)}
                        >
                          Open
                        </button>
                        <span className="text-ink-subtle">·</span>
                        <button
                          data-testid={`fraud-sar-${c.case_id}`}
                          className="text-danger hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                          disabled={!!c.sar_id}
                          title={c.sar_id ? `SAR already filed: ${c.sar_id}` : 'Draft & submit SAR'}
                          onClick={() => setSarFor(c)}
                        >
                          SAR
                        </button>
                        <span className="text-ink-subtle">·</span>
                        <button
                          data-testid={`fraud-vigilance-${c.case_id}`}
                          className="text-warning hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                          disabled={!!c.vigilance_ref}
                          title={c.vigilance_ref ? `Already referred: ${c.vigilance_ref}` : 'Refer to vigilance'}
                          onClick={() => setVigilanceFor(c)}
                        >
                          Vigilance
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {openCase && (
        <CaseDetailModal
          case_={openCase}
          onClose={() => setOpenCase(null)}
          onStatusChange={async (next) => {
            await api.fraudCaseUpdate(openCase.case_id, { status: next });
            await qc.invalidateQueries({ queryKey: ['fraud.cases'] });
            setOpenCase(null);
          }}
        />
      )}

      {rulesOpen && <RulesManagerModal onClose={() => setRulesOpen(false)} />}

      {sarFor && (
        <SarModal
          case_={sarFor}
          onClose={() => setSarFor(null)}
          onDone={() => qc.invalidateQueries({ queryKey: ['fraud.cases'] })}
        />
      )}

      {vigilanceFor && (
        <VigilanceModal
          case_={vigilanceFor}
          onClose={() => setVigilanceFor(null)}
          onDone={() => qc.invalidateQueries({ queryKey: ['fraud.cases'] })}
        />
      )}
    </div>
  );
}

// ─── Case detail modal ────────────────────────────────────────────────

function CaseDetailModal({
  case_,
  onClose,
  onStatusChange,
}: {
  case_: FraudCaseShape;
  onClose: () => void;
  onStatusChange: (next: FraudCaseStatus) => Promise<void>;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" data-testid="fraud-case-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Fraud case — {case_.case_id}</h3>
            <div className="text-xs text-ink-subtle">
              {humanize(case_.category)} · priority {case_.priority} · {humanize(case_.status)}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="fraud-case-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <KV label="Customer" value={case_.customer_id ?? '—'} />
            <KV label="Account" value={case_.account_id ?? '—'} />
            <KV label="Detected at" value={new Date(case_.detected_at).toLocaleString()} />
            <KV label="Exposure" value={fmtKES(case_.amount_kes)} />
            <KV label="Opened by" value={case_.opened_by} />
            <KV label="Assignee" value={case_.assignee ?? 'unassigned'} />
          </div>

          <div>
            <div className="text-xs text-ink-subtle mb-1">Description</div>
            <div className="rounded border border-divider p-2 bg-surface-2 text-sm whitespace-pre-wrap">
              {case_.description || '— no description —'}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <KV
              label="SAR (Suspicious Activity Report)"
              value={
                case_.sar_id ? (
                  <span className="font-mono text-danger">{case_.sar_id}</span>
                ) : (
                  <span className="text-ink-subtle italic">not filed</span>
                )
              }
            />
            <KV
              label="Vigilance referral"
              value={
                case_.vigilance_ref ? (
                  <span className="font-mono text-warning">{case_.vigilance_ref}</span>
                ) : (
                  <span className="text-ink-subtle italic">not referred</span>
                )
              }
            />
          </div>

          {/* Status transition controls */}
          <div className="border-t border-divider pt-3">
            <div className="text-xs text-ink-subtle mb-1">Move to status</div>
            <div className="flex flex-wrap gap-2">
              {(['investigating', 'reported', 'closed', 'false_positive'] as FraudCaseStatus[]).map((s) => (
                <Button
                  key={s}
                  variant={case_.status === s ? 'primary' : 'ghost'}
                  data-testid={`fraud-status-${s}`}
                  disabled={case_.status === s}
                  onClick={() => onStatusChange(s)}
                >
                  {humanize(s)}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-ink-subtle">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

// ─── Rules editor ─────────────────────────────────────────────────────

function RulesManagerModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const rulesQ = useQuery({
    queryKey: ['fraud.rules'],
    queryFn: () => api.fraudRulesList() as Promise<FraudRulesListShape>,
  });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    category: 'identity_theft' as FraudCategory,
    condition_pseudocode: '',
    threshold: 0.75,
    enabled: true,
  });

  const createMut = useMutation({
    mutationFn: () => api.fraudRuleCreate(draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fraud.rules'] });
      setCreating(false);
      setDraft({ name: '', category: 'identity_theft', condition_pseudocode: '', threshold: 0.75, enabled: true });
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" data-testid="fraud-rules-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Fraud rules — manage detection</h3>
            <div className="text-xs text-ink-subtle">CRUD on rule-based detectors. AI ensemble runs alongside.</div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="fraud-rules-close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => setCreating((b) => !b)}
              data-testid="fraud-rule-new-btn"
            >
              <Plus className="h-4 w-4 mr-2" /> {creating ? 'Cancel' : 'New rule'}
            </Button>
          </div>

          {creating && (
            <div className="rounded border border-divider p-3 space-y-2" data-testid="fraud-rule-form">
              <Input
                placeholder="Rule name"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                data-testid="fraud-rule-name"
              />
              <select
                className="h-9 rounded border border-divider bg-surface px-2 text-sm w-full"
                value={draft.category}
                onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as FraudCategory }))}
                data-testid="fraud-rule-category"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
                  </option>
                ))}
              </select>
              <textarea
                className="w-full h-20 rounded border border-divider bg-surface px-2 py-1 text-sm"
                placeholder="Condition pseudocode — e.g. cheque_kiting_score > 0.85 AND distinct_branches_7d ≥ 3"
                value={draft.condition_pseudocode}
                onChange={(e) => setDraft((d) => ({ ...d, condition_pseudocode: e.target.value }))}
                data-testid="fraud-rule-condition"
              />
              <div className="flex gap-3 items-center">
                <label className="text-xs">Threshold</label>
                <Input
                  type="number"
                  step="0.01"
                  value={String(draft.threshold)}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setDraft((d) => ({ ...d, threshold: parseFloat(e.target.value) || 0 }))
                  }
                  data-testid="fraud-rule-threshold"
                  className="w-32"
                />
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
                  />
                  Enabled
                </label>
                <div className="ml-auto">
                  <Button
                    variant="primary"
                    onClick={() => createMut.mutate()}
                    disabled={
                      draft.name.trim().length === 0 ||
                      draft.condition_pseudocode.trim().length === 0 ||
                      createMut.isPending
                    }
                    data-testid="fraud-rule-save"
                  >
                    Save rule
                  </Button>
                </div>
              </div>
            </div>
          )}

          {rulesQ.data && (
            <div className="overflow-x-auto" data-testid="fraud-rules-table">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-xs text-ink-subtle">
                  <tr>
                    <th className="text-left px-2 py-2">Name</th>
                    <th className="text-left px-2 py-2">Category</th>
                    <th className="text-left px-2 py-2">Condition</th>
                    <th className="text-right px-2 py-2">Threshold</th>
                    <th className="text-left px-2 py-2">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {rulesQ.data.rules.map((r: FraudRuleShape) => (
                    <tr key={r.rule_id} className="border-t border-divider">
                      <td className="px-2 py-1.5">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-ink-subtle font-mono">{r.rule_id}</div>
                      </td>
                      <td className="px-2 py-1.5">{humanize(r.category)}</td>
                      <td className="px-2 py-1.5 font-mono text-xs">{r.condition_pseudocode}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{r.threshold}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? 'on' : 'off'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SAR modal — draft + submit (locks after first submission) ────────

function SarModal({
  case_,
  onClose,
  onDone,
}: {
  case_: FraudCaseShape;
  onClose: () => void;
  onDone: () => void;
}) {
  const [summary, setSummary] = useState('');
  const [receipt, setReceipt] = useState<{ sar_id: string; fiu_reference: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submitMut = useMutation({
    mutationFn: () => api.fraudCaseSarSubmit(case_.case_id, summary),
    onSuccess: (r) => {
      setReceipt({ sar_id: r.sar_id, fiu_reference: r.fiu_reference });
      setSubmitError(null);
      onDone();
    },
    onError: (e: Error) => setSubmitError(e.message || 'submission failed'),
  });

  const alreadyLocked = !!case_.sar_id || !!receipt;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-xl w-full max-h-[90vh] overflow-y-auto" data-testid="fraud-sar-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <FileWarning className="h-4 w-4 text-danger" /> Suspicious Activity Report
            </h3>
            <div className="text-xs text-ink-subtle">Case {case_.case_id} · {humanize(case_.category)}</div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="fraud-sar-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {alreadyLocked && (
            <div className="rounded bg-success/10 text-success border border-success/30 p-2 text-sm" data-testid="fraud-sar-receipt">
              SAR filed · ID <span className="font-mono">{receipt?.sar_id ?? case_.sar_id}</span> · FIU reference{' '}
              <span className="font-mono">{receipt?.fiu_reference ?? '—'}</span>. Draft locked.
            </div>
          )}
          {!alreadyLocked && (
            <>
              <div className="text-xs text-ink-subtle">
                SAR summary (≥ 20 chars per RBI Master Directions on Frauds 2016 §A.2). On submit, an audit event
                is recorded and this draft locks — further edits require a fresh case.
              </div>
              <textarea
                data-testid="fraud-sar-summary"
                className="w-full h-32 rounded border border-divider bg-surface px-2 py-1 text-sm"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Describe the suspicious pattern + recommended action…"
              />
              <div className="text-xs text-ink-subtle text-right">{summary.length} / 20 chars min</div>
              {submitError && (
                <div className="text-sm text-danger" data-testid="fraud-sar-error">{submitError}</div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={summary.trim().length < 20 || submitMut.isPending}
                  onClick={() => submitMut.mutate()}
                  data-testid="fraud-sar-submit"
                >
                  <AlertOctagon className="h-4 w-4 mr-2" /> Submit SAR
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Vigilance referral modal ─────────────────────────────────────────

function VigilanceModal({
  case_,
  onClose,
  onDone,
}: {
  case_: FraudCaseShape;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [receipt, setReceipt] = useState<{ vigilance_ref: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitMut = useMutation({
    mutationFn: () => api.fraudCaseVigilanceRefer(case_.case_id, reason),
    onSuccess: (r) => {
      setReceipt({ vigilance_ref: r.vigilance_ref });
      setError(null);
      onDone();
    },
    onError: (e: Error) => setError(e.message || 'referral failed'),
  });

  const alreadyLocked = !!case_.vigilance_ref || !!receipt;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-md w-full" data-testid="fraud-vigilance-modal">
        <div className="border-b border-divider px-4 py-3 flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-warning" /> Refer to vigilance
          </h3>
          <button onClick={onClose} aria-label="Close" data-testid="fraud-vigilance-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {alreadyLocked ? (
            <div className="rounded bg-success/10 text-success border border-success/30 p-2 text-sm" data-testid="fraud-vigilance-receipt">
              Referred to vigilance · <span className="font-mono">{receipt?.vigilance_ref ?? case_.vigilance_ref}</span>
            </div>
          ) : (
            <>
              <div className="text-xs text-ink-subtle">
                Reason (≥ 10 chars). Audit event is recorded; this referral locks.
              </div>
              <textarea
                data-testid="fraud-vigilance-reason"
                className="w-full h-20 rounded border border-divider bg-surface px-2 py-1 text-sm"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this case being escalated to internal vigilance?"
              />
              {error && (
                <div className="text-sm text-danger" data-testid="fraud-vigilance-error">{error}</div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={reason.trim().length < 10 || submitMut.isPending}
                  onClick={() => submitMut.mutate()}
                  data-testid="fraud-vigilance-submit"
                >
                  <Eye className="h-4 w-4 mr-2" /> Refer
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default FraudSignalsPage;
