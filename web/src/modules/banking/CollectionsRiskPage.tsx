// web/src/modules/banking/CollectionsRiskPage.tsx
//
// Collections Risk / Recovery desk (§2.1.7) — recovery KPI strip + DPD-bucket
// funnel + work-queue (recovery-priority sorted, filterable) + account 360
// modal (recovery-probability factors, PTP history, contact history, record-PTP
// + log-contact actions). Reuses Panel/MetricCard/Badge/Button/PageHeader and
// the established banking-page architecture; MSW-backed in dev like the other
// Bank-EWS modules.

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, PhoneCall, HandCoins } from 'lucide-react';
import {
  api,
  type CollectionsSummaryReport,
  type CollectionsQueueReport,
  type CollectionAccountDetailReport,
  type CollectionsDpdBucket,
  type CollectionsRecoveryStage,
  type CollectionsPtpStatus,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildCollectionsRiskReportData } from './collectionsRiskReportAdapter';

const formatKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

const DPD_LABEL: Record<CollectionsDpdBucket, string> = {
  dpd_1_30: '1–30 DPD',
  dpd_31_60: '31–60 DPD',
  dpd_61_90: '61–90 DPD',
  dpd_90_plus: '90+ DPD',
};
const DPD_ORDER: CollectionsDpdBucket[] = ['dpd_1_30', 'dpd_31_60', 'dpd_61_90', 'dpd_90_plus'];

const DPD_TONE: Record<CollectionsDpdBucket, 'success' | 'blue' | 'warning' | 'danger'> = {
  dpd_1_30: 'success',
  dpd_31_60: 'blue',
  dpd_61_90: 'warning',
  dpd_90_plus: 'danger',
};

const STAGE_LABEL: Record<CollectionsRecoveryStage, string> = {
  soft_reminder: 'Soft reminder',
  hard_reminder: 'Hard reminder',
  field_visit: 'Field visit',
  legal_notice: 'Legal notice',
  settlement_offer: 'Settlement offer',
};
const STAGE_ORDER: CollectionsRecoveryStage[] = [
  'soft_reminder',
  'hard_reminder',
  'field_visit',
  'legal_notice',
  'settlement_offer',
];

const PTP_TONE: Record<CollectionsPtpStatus, 'neutral' | 'blue' | 'success' | 'danger'> = {
  none: 'neutral',
  active: 'blue',
  kept: 'success',
  broken: 'danger',
};

function Chip({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-action ${
        active
          ? 'border-action bg-action/10 text-action'
          : 'border-divider bg-surface text-ink-subtle hover:border-action/40 hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

export function CollectionsRiskPage() {
  const me = useAuth((s) => s.user);
  const [dpdFilter, setDpdFilter] = useState<CollectionsDpdBucket | null>(null);
  const [stageFilter, setStageFilter] = useState<CollectionsRecoveryStage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const { data: summary } = useQuery<CollectionsSummaryReport>({
    queryKey: ['collections.summary'],
    queryFn: () => api.collectionsSummary(),
  });

  const { data: queue, isLoading } = useQuery<CollectionsQueueReport>({
    queryKey: ['collections.queue', dpdFilter, stageFilter],
    queryFn: () =>
      api.collectionsQueue({
        dpd_bucket: dpdFilter ?? undefined,
        stage: stageFilter ?? undefined,
      }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Collections Risk"
        subtitle="Recovery work-queue ranked by exposure-at-risk. Filter by DPD bucket or recovery stage; open an account for recovery-probability factors, promise-to-pay history, and contact log."
        actions={
          /* Enterprise export (P2) — RBAC-gated; renders null without
             reports:export. Reports the recovery work-queue rows (post
             DPD-bucket / stage filter) + the recovery KPI strip. */
          <ExportButton
            module="collections_risk"
            reportType="recovery"
            adapter={(config) =>
              buildCollectionsRiskReportData(
                {
                  summary: {
                    total_accounts: summary?.total_accounts ?? 0,
                    total_overdue_kes: summary?.total_overdue_kes ?? 0,
                    total_expected_recovery_kes: summary?.total_expected_recovery_kes ?? 0,
                    recovery_rate_pct: summary?.recovery_rate_pct ?? 0,
                    ptp_active_count: summary?.ptp_active_count ?? 0,
                    high_risk_count: summary?.high_risk_count ?? 0,
                  },
                  accounts: queue?.accounts ?? [],
                  meta: { tenant_id: 'BANK_DEMO', generated_by: me?.username ?? 'operator', role: me?.roles?.[0] ?? 'admin' },
                },
                config,
              )
            }
          />
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Accounts in recovery" value={summary?.total_accounts.toString() ?? '—'} testId="coll-kpi-accounts" />
        <MetricCard label="Total overdue" value={summary ? formatKES(summary.total_overdue_kes) : '—'} tone="danger" testId="coll-kpi-overdue" />
        <MetricCard label="Expected recovery" value={summary ? formatKES(summary.total_expected_recovery_kes) : '—'} tone="success" testId="coll-kpi-expected" />
        <MetricCard label="Recovery rate" value={summary ? `${summary.recovery_rate_pct}%` : '—'} testId="coll-kpi-rate" />
        <MetricCard label="Active PTPs" value={summary?.ptp_active_count.toString() ?? '—'} tone="blue" testId="coll-kpi-ptp" />
        <MetricCard label="High-risk (90+/<30% rec)" value={summary?.high_risk_count.toString() ?? '—'} tone="danger" testId="coll-kpi-highrisk" />
      </div>

      {/* DPD funnel — at-a-glance bucket distribution doubling as filters */}
      <Panel title="DPD recovery funnel" action={<span className="text-xs text-ink-subtle">Click a bucket to filter the queue</span>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="coll-dpd-funnel">
          {DPD_ORDER.map((b) => {
            const cell = summary?.by_dpd_bucket[b];
            const active = dpdFilter === b;
            return (
              <button
                key={b}
                type="button"
                data-testid={`coll-dpd-${b}`}
                aria-pressed={active}
                onClick={() => setDpdFilter(active ? null : b)}
                className={`rounded-lg border p-4 text-left transition hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-action ${
                  active ? 'border-action ring-1 ring-action/30' : 'border-divider'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-ink-subtle">{DPD_LABEL[b]}</span>
                  <Badge tone={DPD_TONE[b]}>{cell?.count ?? 0}</Badge>
                </div>
                <div className="mt-2 text-lg font-bold tabular-nums">{cell ? formatKES(cell.overdue_kes) : '—'}</div>
                <div className="text-xs text-ink-subtle">overdue</div>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* Stage filter chips */}
      <div className="flex flex-wrap items-center gap-2" data-testid="coll-stage-filters">
        <span className="text-xs font-medium uppercase text-ink-subtle">Stage:</span>
        <Chip active={stageFilter === null} onClick={() => setStageFilter(null)} testId="coll-stage-all">
          All
        </Chip>
        {STAGE_ORDER.map((s) => (
          <Chip key={s} active={stageFilter === s} onClick={() => setStageFilter(stageFilter === s ? null : s)} testId={`coll-stage-${s}`}>
            {STAGE_LABEL[s]} ({summary?.by_stage[s] ?? 0})
          </Chip>
        ))}
      </div>

      <Panel
        title="Recovery work-queue"
        action={
          queue ? <span className="text-xs text-ink-subtle">{queue.total} accounts · priority-sorted</span> : null
        }
      >
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : queue && queue.accounts.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-subtle" data-testid="coll-queue-empty">
            No accounts match the current filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="coll-queue-table">
              <thead className="text-left text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-3">Customer</th>
                  <th className="pb-2 pr-3">Sector</th>
                  <th className="pb-2 pr-3 text-right">DPD</th>
                  <th className="pb-2 pr-3 text-right">Overdue</th>
                  <th className="pb-2 pr-3 text-right">Recovery prob.</th>
                  <th className="pb-2 pr-3 text-right">Expected</th>
                  <th className="pb-2 pr-3">Stage</th>
                  <th className="pb-2 pr-3">PTP</th>
                  <th className="pb-2 pr-3">Collector</th>
                </tr>
              </thead>
              <tbody>
                {queue?.accounts.map((a) => (
                  <tr
                    key={a.account_id}
                    data-testid={`coll-row-${a.account_id}`}
                    onClick={() => setSelected(a.account_id)}
                    className="cursor-pointer border-t border-divider hover:bg-action/5"
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">{a.customer_name}</div>
                      <div className="text-xs text-ink-subtle">{a.customer_id}</div>
                    </td>
                    <td className="py-2 pr-3 text-ink-subtle">{a.sector.replace(/_/g, ' ')}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <Badge tone={DPD_TONE[a.dpd_bucket]}>{a.dpd}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatKES(a.overdue_kes)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{Math.round(a.recovery_probability * 100)}%</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatKES(a.expected_recovery_kes)}</td>
                    <td className="py-2 pr-3 text-xs">{STAGE_LABEL[a.recovery_stage]}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={PTP_TONE[a.ptp_status]}>{a.ptp_status}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs text-ink-subtle">{a.assigned_collector}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {selected && <CollectionAccountModal account_id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CollectionAccountModal({ account_id, onClose }: { account_id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<CollectionAccountDetailReport>({
    queryKey: ['collections.account', account_id],
    queryFn: () => api.collectionAccount(account_id),
  });

  const [showPtp, setShowPtp] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [ptpAmount, setPtpAmount] = useState('');
  const [ptpDate, setPtpDate] = useState('');
  const [contactChannel, setContactChannel] = useState('call');
  const [contactOutcome, setContactOutcome] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['collections.account', account_id] });
    qc.invalidateQueries({ queryKey: ['collections.queue'] });
    qc.invalidateQueries({ queryKey: ['collections.summary'] });
  };

  const ptpMut = useMutation({
    mutationFn: () =>
      api.collectionsRecordPtp(account_id, { amount_kes: Number(ptpAmount), promised_date: ptpDate }),
    onSuccess: () => {
      setShowPtp(false);
      setPtpAmount('');
      setPtpDate('');
      invalidate();
    },
  });

  const contactMut = useMutation({
    mutationFn: () =>
      api.collectionsLogContact(account_id, { channel: contactChannel, outcome: contactOutcome }),
    onSuccess: () => {
      setShowContact(false);
      setContactOutcome('');
      invalidate();
    },
  });

  return (
    <ModalShell title={`Account: ${account_id}`} onClose={onClose} testId="coll-detail-modal">
      {isLoading || !data ? (
        <p className="text-sm text-ink-subtle">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{data.customer_name}</span>
            <Badge tone={DPD_TONE[data.dpd_bucket]}>{DPD_LABEL[data.dpd_bucket]}</Badge>
            <Badge tone={PTP_TONE[data.ptp_status]}>PTP: {data.ptp_status}</Badge>
            <span className="text-xs text-ink-subtle">{data.sector.replace(/_/g, ' ')}</span>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="DPD" value={data.dpd.toString()} />
            <MetricCard label="Overdue" value={formatKES(data.overdue_kes)} />
            <MetricCard label="Recovery prob." value={`${Math.round(data.recovery_probability * 100)}%`} />
            <MetricCard label="Expected recovery" value={formatKES(data.expected_recovery_kes)} />
          </div>

          {/* Operational actions */}
          <div className="flex flex-wrap gap-2 border-y border-divider py-3">
            <Button variant="ghost" onClick={() => { setShowPtp((v) => !v); setShowContact(false); }} data-testid="coll-action-ptp">
              <HandCoins className="mr-1 size-4" />
              Record promise-to-pay
            </Button>
            <Button variant="ghost" onClick={() => { setShowContact((v) => !v); setShowPtp(false); }} data-testid="coll-action-contact">
              <PhoneCall className="mr-1 size-4" />
              Log contact
            </Button>
          </div>

          {showPtp && (
            <div className="rounded-lg border border-divider bg-surface-alt p-4" data-testid="coll-ptp-form">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-xs uppercase text-ink-subtle">Amount (KES)</span>
                  <input
                    type="number"
                    value={ptpAmount}
                    onChange={(e) => setPtpAmount(e.target.value)}
                    data-testid="coll-ptp-amount"
                    className="w-full rounded border border-divider bg-surface px-2 py-1"
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-xs uppercase text-ink-subtle">Promised date</span>
                  <input
                    type="date"
                    value={ptpDate}
                    onChange={(e) => setPtpDate(e.target.value)}
                    data-testid="coll-ptp-date"
                    className="w-full rounded border border-divider bg-surface px-2 py-1"
                  />
                </label>
              </div>
              <div className="mt-3">
                <Button
                  onClick={() => ptpMut.mutate()}
                  disabled={ptpMut.isPending || !ptpAmount || !ptpDate}
                  data-testid="coll-ptp-submit"
                >
                  Save promise-to-pay
                </Button>
              </div>
            </div>
          )}

          {showContact && (
            <div className="rounded-lg border border-divider bg-surface-alt p-4" data-testid="coll-contact-form">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-xs uppercase text-ink-subtle">Channel</span>
                  <select
                    value={contactChannel}
                    onChange={(e) => setContactChannel(e.target.value)}
                    data-testid="coll-contact-channel"
                    className="w-full rounded border border-divider bg-surface px-2 py-1"
                  >
                    <option value="call">Call</option>
                    <option value="sms">SMS</option>
                    <option value="email">Email</option>
                    <option value="field_visit">Field visit</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-xs uppercase text-ink-subtle">Outcome</span>
                  <input
                    value={contactOutcome}
                    onChange={(e) => setContactOutcome(e.target.value)}
                    data-testid="coll-contact-outcome"
                    placeholder="e.g. promised_payment"
                    className="w-full rounded border border-divider bg-surface px-2 py-1"
                  />
                </label>
              </div>
              <div className="mt-3">
                <Button
                  onClick={() => contactMut.mutate()}
                  disabled={contactMut.isPending || !contactOutcome}
                  data-testid="coll-contact-submit"
                >
                  Log contact attempt
                </Button>
              </div>
            </div>
          )}

          {/* Recovery-probability factors */}
          <Panel title="Recovery-probability factors">
            <ul className="space-y-2" data-testid="coll-factors">
              {data.recovery_factors.map((f, i) => (
                <li key={i} className="flex items-center justify-between text-sm">
                  <span>{f.factor}</span>
                  <Badge tone={f.direction === 'positive' ? 'success' : 'danger'}>
                    {f.direction === 'positive' ? '+' : '−'}
                    {f.weight.toFixed(2)}
                  </Badge>
                </li>
              ))}
            </ul>
          </Panel>

          {/* PTP history */}
          <Panel title="Promise-to-pay history">
            {data.ptp_history.length === 0 ? (
              <p className="text-sm text-ink-subtle">No promises recorded.</p>
            ) : (
              <table className="min-w-full text-sm" data-testid="coll-ptp-history">
                <thead className="text-left text-xs uppercase text-ink-subtle">
                  <tr>
                    <th className="pb-2 pr-3">Recorded</th>
                    <th className="pb-2 pr-3 text-right">Amount</th>
                    <th className="pb-2 pr-3">Promised</th>
                    <th className="pb-2 pr-3">Status</th>
                    <th className="pb-2 pr-3">By</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ptp_history.map((p, i) => (
                    <tr key={i} className="border-t border-divider">
                      <td className="py-2 pr-3 text-ink-subtle">{new Date(p.recorded_at).toLocaleDateString()}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatKES(p.amount_kes)}</td>
                      <td className="py-2 pr-3">{p.promised_date}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={PTP_TONE[p.status]}>{p.status}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-ink-subtle">{p.recorded_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {/* Contact history */}
          <Panel title="Contact history">
            {data.contact_history.length === 0 ? (
              <p className="text-sm text-ink-subtle">No contact attempts logged.</p>
            ) : (
              <table className="min-w-full text-sm" data-testid="coll-contact-history">
                <thead className="text-left text-xs uppercase text-ink-subtle">
                  <tr>
                    <th className="pb-2 pr-3">When</th>
                    <th className="pb-2 pr-3">Channel</th>
                    <th className="pb-2 pr-3">Outcome</th>
                    <th className="pb-2 pr-3">By</th>
                  </tr>
                </thead>
                <tbody>
                  {data.contact_history.map((c, i) => (
                    <tr key={i} className="border-t border-divider">
                      <td className="py-2 pr-3 text-ink-subtle">{new Date(c.contacted_at).toLocaleDateString()}</td>
                      <td className="py-2 pr-3">{c.channel}</td>
                      <td className="py-2 pr-3">{c.outcome}</td>
                      <td className="py-2 pr-3 text-ink-subtle">{c.contacted_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-lg border border-divider bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-ink-subtle hover:bg-divider/40 hover:text-ink"
            aria-label="Close"
            data-testid="modal-close"
          >
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
