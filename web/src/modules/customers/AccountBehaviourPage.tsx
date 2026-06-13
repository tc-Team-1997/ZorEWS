// web/src/modules/customers/AccountBehaviourPage.tsx
//
// Module 2.2 — Account Behaviour (AI).
// 4 BFF endpoints back this screen:
//   GET  /v1/banking/accounts/signals?customer_id=&watchlist_only=&status=
//   GET  /v1/banking/accounts/:account_id/patterns
//   GET  /v1/banking/accounts/:account_id/transactions   (M2.2 net-new — alias to M14.7 finance ledger)
//   POST /v1/banking/accounts/:account_id/block          (4-eyes maker-checker)
//   POST /v1/banking/accounts/signals/:signal_id/{dismiss,review}

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ExternalLink, ShieldOff, Star, X, Wallet } from 'lucide-react';
import { Panel, Button, Input, MetricCard, Badge } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { buildAccountBehaviourReportData } from './accountBehaviourReportAdapter';
import { api } from '@/lib/api';
import type {
  AccountSignalShape,
  AccountSignalsReportShape,
  AccountSignalSeverity,
  AccountSignalStatus,
  AccountPatternsReportShape,
  AccountTransactionsShape,
} from '@/lib/api';

import type { BadgeTone } from '@/components/ui';

const SEV_TONE: Record<AccountSignalSeverity, BadgeTone> = {
  critical: 'danger',
  high: 'warning',
  medium: 'blue',
  low: 'success',
};

const STATUS_TONE: Record<AccountSignalStatus, BadgeTone> = {
  new: 'blue',
  reviewed: 'success',
  dismissed: 'neutral',
};

function fmtINR(value: number): string {
  if (Math.abs(value) >= 10_000_000) return `₹${(value / 10_000_000).toFixed(2)} Cr`;
  if (Math.abs(value) >= 100_000) return `₹${(value / 100_000).toFixed(2)} L`;
  return `₹${value.toLocaleString('en-IN')}`;
}

function humanizeType(t: string): string {
  return t.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AccountBehaviourPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();

  const customer_id = params.get('customer_id') ?? '';
  const watchlist_only = params.get('watchlist_only') === 'true';
  const statusFilter = (params.get('status') ?? '') as AccountSignalStatus | '';

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const signalsQ = useQuery({
    queryKey: ['account-signals', customer_id, watchlist_only, statusFilter],
    queryFn: () =>
      api.accountSignals({
        customer_id: customer_id || undefined,
        watchlist_only: watchlist_only || undefined,
        status: statusFilter || undefined,
      }) as Promise<AccountSignalsReportShape>,
  });

  const [openSignal, setOpenSignal] = useState<AccountSignalShape | null>(null);
  const [patternsFor, setPatternsFor] = useState<string | null>(null);
  const [blockFor, setBlockFor] = useState<{ account_id: string; reason: string } | null>(null);

  const dismissMut = useMutation({
    mutationFn: (sid: string) => api.accountSignalDismiss(sid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account-signals'] }),
  });
  const reviewMut = useMutation({
    mutationFn: (sid: string) => api.accountSignalReview(sid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account-signals'] }),
  });

  const report = signalsQ.data;
  const kpis = useMemo(() => {
    if (!report) return null;
    return {
      total: report.total,
      critical: report.by_severity.critical ?? 0,
      high: report.by_severity.high ?? 0,
      watchlisted: report.signals.filter((s) => s.is_watchlisted).length,
      newCount: report.by_status.new ?? 0,
    };
  }, [report]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Account Behaviour"
        subtitle="AI-scored account-level signals — cash-flow drops, salary stops, OD frequency, balance trends, large unusual debits."
        actions={
          /* Enterprise export (P2) — RBAC-gated; renders null without
             reports:export. Feeds the post-filter `report.signals` + KPI
             strip so the export honours active customer/status/watchlist
             filters. BFF stamps tenant/actor server-side. */
          <ExportButton
            module="account_behaviour"
            reportType="risk"
            adapter={(config) =>
              buildAccountBehaviourReportData(
                {
                  signals: (report?.signals ?? []).map((s) => ({
                    signal_id: s.signal_id,
                    account_id: s.account_id,
                    customer_id: s.customer_id,
                    customer_name: s.customer_name,
                    signal_type: s.signal_type,
                    severity: s.severity,
                    score: s.score,
                    observed_at: s.observed_at,
                    description: s.description,
                    is_watchlisted: s.is_watchlisted,
                    status: s.status,
                  })),
                  kpis: {
                    total: kpis?.total ?? 0,
                    critical: kpis?.critical ?? 0,
                    high: kpis?.high ?? 0,
                    watchlisted: kpis?.watchlisted ?? 0,
                    newCount: kpis?.newCount ?? 0,
                  },
                  meta: { tenant_id: 'BANK_DEMO', generated_by: 'operator', role: 'admin' },
                },
                config,
              )
            }
          />
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        <MetricCard testId="kpi-total" label="Total signals" value={kpis?.total ?? 0} />
        <MetricCard testId="kpi-critical" label="Critical" value={kpis?.critical ?? 0} tone="danger" />
        <MetricCard testId="kpi-high" label="High" value={kpis?.high ?? 0} tone="warning" />
        <MetricCard testId="kpi-watchlisted" label="On watchlist" value={kpis?.watchlisted ?? 0} />
        <MetricCard testId="kpi-new" label="New (awaiting review)" value={kpis?.newCount ?? 0} />
      </div>

      {/* Filter bar */}
      <Panel>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end" data-testid="ab-filter-bar">
          <div>
            <label className="text-xs text-ink-muted">Customer ID</label>
            <Input
              data-testid="ab-customer-input"
              value={customer_id}
              onChange={(e) => setParam('customer_id', e.target.value)}
              placeholder="e.g. c-101"
            />
          </div>
          <div>
            <label className="text-xs text-ink-muted">Status</label>
            <select
              data-testid="ab-status-select"
              className="h-9 rounded-md border border-divider bg-surface px-2 text-sm w-full"
              value={statusFilter}
              onChange={(e) => setParam('status', e.target.value)}
            >
              <option value="">Any</option>
              <option value="new">New</option>
              <option value="reviewed">Reviewed</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input
              data-testid="ab-watchlist-toggle"
              type="checkbox"
              checked={watchlist_only}
              onChange={(e) => setParam('watchlist_only', e.target.checked ? 'true' : '')}
            />
            <label className="text-sm">Watchlist only</label>
          </div>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
              data-testid="ab-clear-filters"
            >
              Clear
            </Button>
          </div>
        </div>
      </Panel>

      {/* Signals table */}
      <Panel>
        <div className="overflow-x-auto" data-testid="ab-signals-table">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-ink-muted">
              <tr>
                <th className="text-left px-2 py-2">Account</th>
                <th className="text-left px-2 py-2">Borrower</th>
                <th className="text-left px-2 py-2">Signal type</th>
                <th className="text-right px-2 py-2">AI score</th>
                <th className="text-left px-2 py-2">Detected at</th>
                <th className="text-left px-2 py-2">Status</th>
                <th className="text-left px-2 py-2">Severity</th>
                <th className="text-left px-2 py-2">Watchlist</th>
                <th className="text-left px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {signalsQ.isLoading && (
                <tr><td colSpan={9} className="px-2 py-3 text-center text-ink-muted text-xs">Loading signals…</td></tr>
              )}
              {!signalsQ.isLoading && (report?.signals.length ?? 0) === 0 && (
                <tr><td colSpan={9} className="px-2 py-3 text-center text-ink-muted text-xs">No signals matching the current filters.</td></tr>
              )}
              {(report?.signals ?? []).map((r) => (
                <tr key={r.signal_id} className="border-t border-divider hover:bg-surface-2/50">
                  <td className="px-2 py-1.5 font-mono text-xs">{r.account_id}</td>
                  <td className="px-2 py-1.5">
                    <Link to={`/customers/${r.customer_id}`} className="font-medium hover:underline">
                      {r.customer_name}
                    </Link>
                    <div className="text-xs text-ink-muted">{r.customer_id}</div>
                  </td>
                  <td className="px-2 py-1.5">{humanizeType(r.signal_type)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{Math.round(r.score * 100)}</td>
                  <td className="px-2 py-1.5 text-xs">{new Date(r.observed_at).toLocaleString()}</td>
                  <td className="px-2 py-1.5"><Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge></td>
                  <td className="px-2 py-1.5"><Badge tone={SEV_TONE[r.severity]}>{r.severity}</Badge></td>
                  <td className="px-2 py-1.5">{r.is_watchlisted ? <Star className="h-4 w-4 text-warning" /> : null}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1 flex-wrap text-xs">
                      <button
                        data-testid={`ab-open-${r.signal_id}`}
                        className="text-action hover:underline"
                        onClick={() => setOpenSignal(r)}
                      >
                        Open
                      </button>
                      <span className="text-ink-muted">·</span>
                      <button
                        data-testid={`ab-patterns-${r.signal_id}`}
                        className="text-action hover:underline"
                        onClick={() => setPatternsFor(r.account_id)}
                      >
                        Patterns
                      </button>
                      {r.status === 'new' && (
                        <>
                          <span className="text-ink-muted">·</span>
                          <button
                            data-testid={`ab-review-${r.signal_id}`}
                            className="text-success hover:underline"
                            onClick={() => reviewMut.mutate(r.signal_id)}
                          >
                            Review
                          </button>
                          <span className="text-ink-muted">·</span>
                          <button
                            data-testid={`ab-dismiss-${r.signal_id}`}
                            className="text-warning hover:underline"
                            onClick={() => dismissMut.mutate(r.signal_id)}
                          >
                            Dismiss
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {openSignal && (
        <AccountDetailModal
          signal={openSignal}
          onClose={() => setOpenSignal(null)}
          onBlock={(acct) => {
            setBlockFor({ account_id: acct, reason: '' });
            setOpenSignal(null);
          }}
        />
      )}

      {patternsFor && (
        <PatternsModal account_id={patternsFor} onClose={() => setPatternsFor(null)} />
      )}

      {blockFor && (
        <BlockModal
          account_id={blockFor.account_id}
          initialReason={blockFor.reason}
          onClose={() => setBlockFor(null)}
        />
      )}
    </div>
  );
}

// ─── Account detail modal — txns + signal context + block CTA ──────────

function AccountDetailModal({
  signal,
  onClose,
  onBlock,
}: {
  signal: AccountSignalShape;
  onClose: () => void;
  onBlock: (account_id: string) => void;
}) {
  const txnsQ = useQuery({
    queryKey: ['account-txns', signal.account_id],
    queryFn: () => api.accountTransactions(signal.account_id, { page_size: 25 }) as Promise<AccountTransactionsShape>,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" data-testid="ab-detail-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Account {signal.account_id}</h3>
            <div className="text-xs text-ink-muted">
              {signal.customer_name} ({signal.customer_id}) · {humanizeType(signal.signal_type)} · score {Math.round(signal.score * 100)}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="ab-close-detail">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="rounded border border-divider p-3 bg-surface-2 text-sm">
            <div className="font-medium mb-1">Signal description</div>
            <div className="text-ink-muted">{signal.description}</div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-medium text-sm">Recent transactions</h4>
              <Link
                to={`/customers/${signal.customer_id}`}
                className="text-xs text-action hover:underline inline-flex items-center gap-1"
              >
                Open borrower 360 <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
            {txnsQ.isLoading ? (
              <div className="text-xs text-ink-muted">Loading…</div>
            ) : (
              <div className="border border-divider rounded overflow-hidden" data-testid="ab-txns-table">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-xs text-ink-muted">
                    <tr>
                      <th className="text-left px-2 py-1.5">Posted</th>
                      <th className="text-left px-2 py-1.5">Type</th>
                      <th className="text-right px-2 py-1.5">Amount</th>
                      <th className="text-right px-2 py-1.5">Balance after</th>
                      <th className="text-left px-2 py-1.5">Narrative</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(txnsQ.data?.items ?? []).map((e) => (
                      <tr key={e.entry_id} className="border-t border-divider">
                        <td className="px-2 py-1 text-xs">{new Date(e.posted_at).toLocaleDateString()}</td>
                        <td className="px-2 py-1">
                          <Badge tone={e.type === 'debit' ? 'danger' : 'success'}>{e.type}</Badge>
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-xs">{fmtINR(e.amount_kes)}</td>
                        <td className="px-2 py-1 text-right font-mono text-xs">{fmtINR(e.balance_kes_after)}</td>
                        <td className="px-2 py-1 text-xs text-ink-muted">{e.narrative}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="primary"
              data-testid="ab-block-cta"
              onClick={() => onBlock(signal.account_id)}
            >
              <ShieldOff className="h-4 w-4 mr-2" /> Initiate block (4-eyes)
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Patterns modal — 4 mini sparklines of behavioural patterns ────────

function PatternsModal({ account_id, onClose }: { account_id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['account-patterns', account_id],
    queryFn: () => api.accountPatterns(account_id) as Promise<AccountPatternsReportShape>,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" data-testid="ab-patterns-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Behavioural patterns — {account_id}</h3>
            <div className="text-xs text-ink-muted">12-month trailing series · anomaly score per pattern</div>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {(q.data?.patterns ?? []).map((p) => {
            const maxV = Math.max(1, ...p.series.map((s) => s.value));
            return (
              <div key={p.pattern_type} className="border border-divider rounded p-3" data-testid={`ab-pattern-${p.pattern_type}`}>
                <div className="flex justify-between items-baseline mb-2">
                  <div className="font-medium text-sm">{p.label}</div>
                  <Badge tone={p.anomaly_score >= 0.5 ? 'danger' : p.anomaly_score >= 0.25 ? 'warning' : 'success'}>
                    {Math.round(p.anomaly_score * 100)}
                  </Badge>
                </div>
                <div className="flex items-end gap-0.5 h-12">
                  {p.series.map((s, i) => (
                    <div
                      key={i}
                      className="flex-1 bg-action/40 rounded-sm"
                      style={{ height: `${Math.max(2, (s.value / maxV) * 100)}%` }}
                      title={`${s.date}: ${fmtINR(s.value)}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── 4-eyes block modal ─────────────────────────────────────────────────

function BlockModal({
  account_id,
  initialReason,
  onClose,
}: {
  account_id: string;
  initialReason: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const [result, setResult] = useState<{ request_id: string; status: string } | null>(null);
  const proposeMut = useMutation({
    mutationFn: () => api.accountBlockPropose(account_id, reason),
    onSuccess: (r) => setResult({ request_id: r.request_id, status: r.status }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-md w-full" data-testid="ab-block-modal">
        <div className="border-b border-divider px-4 py-3 flex items-center justify-between">
          <h3 className="font-semibold">Initiate account block</h3>
          <button onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-ink-muted">
            Account: <span className="font-mono">{account_id}</span>. 4-eyes approval: a separate checker must approve before the block takes effect.
          </div>
          <div>
            <label className="text-xs text-ink-muted">Reason (≥ 5 chars)</label>
            <textarea
              data-testid="ab-block-reason"
              className="w-full h-20 rounded border border-divider bg-surface px-2 py-1 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {result && (
            <div className="rounded bg-success/10 text-success border border-success/30 p-2 text-sm" data-testid="ab-block-receipt">
              Block proposed: <span className="font-mono">{result.request_id}</span> ({result.status}) — awaiting checker approval.
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={reason.trim().length < 5 || proposeMut.isPending || !!result}
              onClick={() => proposeMut.mutate()}
              data-testid="ab-block-submit"
            >
              <Wallet className="h-4 w-4 mr-2" /> Propose block
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AccountBehaviourPage;
