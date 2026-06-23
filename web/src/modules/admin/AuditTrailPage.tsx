// web/src/modules/admin/AuditTrailPage.tsx
//
// G2 — Compliance-grade audit trail (Monday Playbook H9).
//
// Distinct from /admin/audit-log which shows AUTH-SVC events only
// (login/lockout/etc). This page consumes the BFF M15.1 surface:
//   GET /v1/audit/events      — paginated, multi-axis filtered
//   GET /v1/audit/events/:id  — single event w/ full payload + hash chain
//   GET /v1/audit/summary     — aggregate counts
//   GET /v1/audit/integrity   — hash-chain tamper-evidence verdict
//
// Drives Act 6 of the demo: filter table + click → detail modal showing
// payload JSON (with copy), correlation_id drill (filters list), and
// prev_hash + current_hash monospace block proving integrity.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Trash2,
  X,
  Copy,
  Download,
  Link2,
  Plus,
} from 'lucide-react';
import {
  api,
  type AuditEventQuery,
  type AuditOutcome,
  type AuditResourceType,
  type AuditSeverity,
  type AuditEvidenceBuildInput,
  type AuditRetentionStrategy,
  type AuditRetentionPolicyCreateInput,
} from '@/lib/api';
import {
  downloadAuditEventsCsv,
  downloadAuditEventsPdf,
  downloadAuditEventsXlsx,
} from '@/lib/auditExport';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const RESOURCE_TYPES: { value: '' | AuditResourceType; label: string }[] = [
  { value: '', label: 'All resource types' },
  { value: 'user', label: 'User' },
  { value: 'session', label: 'Session' },
  { value: 'config', label: 'Config' },
  { value: 'case', label: 'Case' },
  { value: 'alert', label: 'Alert' },
  { value: 'report', label: 'Report' },
  { value: 'scenario', label: 'Scenario' },
  { value: 'rule', label: 'Rule' },
  { value: 'integration', label: 'Integration' },
  { value: 'system', label: 'System' },
];

const OUTCOMES: { value: '' | AuditOutcome; label: string }[] = [
  { value: '', label: 'All outcomes' },
  { value: 'success', label: 'Success' },
  { value: 'failure', label: 'Failure' },
  { value: 'denied', label: 'Denied' },
];

const SEVERITIES: { value: '' | AuditSeverity; label: string }[] = [
  { value: '', label: 'All severities' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

function outcomeTone(o: AuditOutcome): 'success' | 'warning' | 'danger' {
  return o === 'success' ? 'success' : o === 'denied' ? 'danger' : 'warning';
}

function severityTone(s: AuditSeverity): 'success' | 'warning' | 'danger' {
  return s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'success';
}

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function AuditTrailPage() {
  const [filters, setFilters] = useState<AuditEventQuery>({
    page: 1,
    page_size: 25,
  });
  const [detailId, setDetailId] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ['audit.summary', 30],
    queryFn: () => api.auditSummary(30),
  });

  const integrity = useQuery({
    queryKey: ['audit.integrity'],
    queryFn: () => api.auditIntegrity(),
  });

  const events = useQuery({
    queryKey: ['audit.events', filters],
    queryFn: () => api.auditEvents(filters),
  });

  const total = events.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Trail"
        subtitle="Immutable cryptographic ledger — SHA-256 hash-chained for tamper evidence (RBI Cyber Resilience §4.3)."
        actions={
          <div className="flex items-center gap-2" data-testid="audit-export-row">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadAuditEventsCsv(events.data?.items ?? [])}
              disabled={!events.data?.items?.length}
              data-testid="audit-export-csv"
              title={
                events.data?.items?.length
                  ? `Export ${events.data.items.length} filtered event(s) as CSV`
                  : 'No events to export'
              }
            >
              <Download size={13} strokeWidth={2} /> CSV
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadAuditEventsPdf(events.data?.items ?? [])}
              disabled={!events.data?.items?.length}
              data-testid="audit-export-pdf"
              title={
                events.data?.items?.length
                  ? `Export ${events.data.items.length} filtered event(s) as PDF`
                  : 'No events to export'
              }
            >
              <Download size={13} strokeWidth={2} /> PDF
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void downloadAuditEventsXlsx(events.data?.items ?? []);
              }}
              disabled={!events.data?.items?.length}
              data-testid="audit-export-xlsx"
              title={
                events.data?.items?.length
                  ? `Export ${events.data.items.length} filtered event(s) as Excel`
                  : 'No events to export'
              }
            >
              <Download size={13} strokeWidth={2} /> Excel
            </Button>
          </div>
        }
      />

      {/* Stats + integrity */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard
          label="Events (last 30 days)"
          value={summary.data ? summary.data.total.toString() : '—'}
          sub="All resource types"
          testId="audit-kpi-total"
        />
        <MetricCard
          label="Critical events"
          value={summary.data ? (summary.data.by_severity.critical ?? 0).toString() : '—'}
          sub="Last 30 days"
          tone="danger"
          testId="audit-kpi-critical"
        />
        <MetricCard
          label="Denied actions"
          value={summary.data ? (summary.data.by_outcome.denied ?? 0).toString() : '—'}
          sub="Policy-blocked attempts"
          tone="warning"
          testId="audit-kpi-denied"
        />
        <MetricCard
          label="Chain integrity"
          value={
            integrity.data ? (integrity.data.valid ? 'VALID' : 'BROKEN') : '—'
          }
          sub={
            integrity.data
              ? `${integrity.data.total_events} events · last_hash ${integrity.data.last_hash.slice(0, 8)}…`
              : 'verifying…'
          }
          tone={integrity.data ? (integrity.data.valid ? 'success' : 'danger') : undefined}
          testId="audit-kpi-integrity"
        />
      </div>

      {/* Filters */}
      <Panel title="Filter">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4" data-testid="audit-filters">
          <div className="flex items-center gap-2 rounded-input border border-divider bg-surface px-2.5 py-1.5">
            <Search size={14} className="text-muted" aria-hidden />
            <input
              type="text"
              placeholder="Actor (e.g. alice.admin)"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
              value={filters.actor_username ?? ''}
              onChange={(e) =>
                setFilters((f) => ({ ...f, actor_username: e.target.value || undefined, page: 1 }))
              }
              data-testid="audit-filter-actor"
            />
          </div>
          <select
            className="rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm text-ink"
            value={filters.resource_type ?? ''}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                resource_type: (e.target.value || undefined) as AuditResourceType | undefined,
                page: 1,
              }))
            }
            data-testid="audit-filter-resource"
          >
            {RESOURCE_TYPES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm text-ink"
            value={filters.outcome ?? ''}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                outcome: (e.target.value || undefined) as AuditOutcome | undefined,
                page: 1,
              }))
            }
            data-testid="audit-filter-outcome"
          >
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm text-ink"
            value={filters.severity ?? ''}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                severity: (e.target.value || undefined) as AuditSeverity | undefined,
                page: 1,
              }))
            }
            data-testid="audit-filter-severity"
          >
            {SEVERITIES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {(filters.correlation_id || filters.resource_id) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {filters.correlation_id && (
              <Badge tone="warning">
                Correlation: {filters.correlation_id.slice(0, 12)}…{' '}
                <button
                  className="ml-1 hover:underline"
                  onClick={() => setFilters((f) => ({ ...f, correlation_id: undefined, page: 1 }))}
                >
                  ✕
                </button>
              </Badge>
            )}
            {filters.resource_id && (
              <Badge tone="warning">
                Resource ID: {filters.resource_id}{' '}
                <button
                  className="ml-1 hover:underline"
                  onClick={() => setFilters((f) => ({ ...f, resource_id: undefined, page: 1 }))}
                >
                  ✕
                </button>
              </Badge>
            )}
          </div>
        )}
      </Panel>

      {/* Event table */}
      <Panel
        title={`Events (${total.toLocaleString()})`}
        data-testid="audit-events-panel"
      >
        {events.isLoading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : events.data && events.data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No events match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="audit-events-table">
              <thead className="text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="px-3 py-2">Timestamp</th>
                  <th className="px-3 py-2">Actor</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Resource</th>
                  <th className="px-3 py-2">Outcome</th>
                  <th className="px-3 py-2">Severity</th>
                </tr>
              </thead>
              <tbody>
                {events.data?.items.map((e) => (
                  <tr
                    key={e.event_id}
                    className="cursor-pointer border-t border-divider hover:bg-action/5"
                    onClick={() => setDetailId(e.event_id)}
                    data-testid={`audit-row-${e.event_id}`}
                  >
                    <td className="px-3 py-2 tabular-nums text-xs">{fmtTs(e.ts)}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{e.actor_username}</div>
                      <div className="text-xs text-muted">{e.actor_role}</div>
                    </td>
                    <td className="px-3 py-2">
                      <code className="rounded bg-divider/30 px-1.5 py-0.5 text-xs">{e.action}</code>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-xs text-muted">{e.resource_type}</span>
                      <div className="text-xs text-ink">{e.resource_id}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={outcomeTone(e.outcome)}>{e.outcome}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={severityTone(e.severity)}>{e.severity}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* M6.2 — Evidence Packages + Retention Policies */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <EvidencePackagesPanel currentFilters={filters} />
        <RetentionPoliciesPanel />
      </div>

      {detailId && (
        <AuditEventDetailModal
          eventId={detailId}
          onClose={() => setDetailId(null)}
          onDrillCorrelation={(corr) => {
            setFilters((f) => ({ ...f, correlation_id: corr, page: 1 }));
            setDetailId(null);
          }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────

function AuditEventDetailModal({
  eventId,
  onClose,
  onDrillCorrelation,
}: {
  eventId: string;
  onClose: () => void;
  onDrillCorrelation: (correlation_id: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['audit.event', eventId],
    queryFn: () => api.auditEvent(eventId),
  });

  const payloadJson = useMemo(() => {
    if (!data) return '';
    // pretty-print the full event (less hash fields rendered separately)
    return JSON.stringify(data, null, 2);
  }, [data]);

  const copyPayload = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(payloadJson).catch(() => {
        /* clipboard blocked — ignore */
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      data-testid="audit-detail-modal"
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-divider px-6 py-4">
          <div className="flex items-center gap-2">
            <Shield className="size-5 text-action" aria-hidden />
            <h2 className="text-lg font-semibold">Audit event</h2>
          </div>
          <button className="rounded p-1 hover:bg-divider/50" onClick={onClose} aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5">
          {data ? (
            <>
              {/* Header summary */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <MetricCard label="Event ID" value={data.event_id.slice(0, 16) + '…'} sub={fmtTs(data.ts)} />
                <MetricCard label="Actor" value={data.actor_username} sub={data.actor_role} />
                <MetricCard
                  label="Outcome"
                  value={data.outcome}
                  sub={`Severity: ${data.severity}`}
                  tone={
                    data.outcome === 'success' ? 'success' : data.outcome === 'denied' ? 'danger' : 'warning'
                  }
                />
              </div>

              {/* Action + resource */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded-md border border-divider bg-surface p-3">
                  <p className="text-xs text-muted">Action</p>
                  <code className="text-sm font-medium">{data.action}</code>
                </div>
                <div className="rounded-md border border-divider bg-surface p-3">
                  <p className="text-xs text-muted">Resource</p>
                  <p className="text-sm">
                    <span className="text-muted">{data.resource_type}</span> · {data.resource_id}
                  </p>
                </div>
              </div>

              {/* Correlation drill */}
              {data.correlation_id && (
                <div className="flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
                  <div>
                    <p className="text-xs text-muted">Correlation ID</p>
                    <code className="text-xs">{data.correlation_id}</code>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => onDrillCorrelation(data.correlation_id as string)}
                    data-testid="audit-drill-correlation"
                  >
                    <Link2 className="size-4" aria-hidden /> View related events
                  </Button>
                </div>
              )}

              {/* Full payload */}
              <Panel
                title="Full event payload"
                action={
                  <Button variant="ghost" onClick={copyPayload} data-testid="audit-copy-payload">
                    <Copy className="size-4" aria-hidden /> Copy
                  </Button>
                }
              >
                <pre
                  className="max-h-72 overflow-auto rounded bg-ink/5 p-3 font-mono text-[11px] leading-snug"
                  data-testid="audit-payload-json"
                >
                  {payloadJson}
                </pre>
              </Panel>

              {/* Hash chain */}
              <Panel title="Hash chain (SHA-256)">
                <div className="space-y-2 text-xs">
                  <div className="flex items-start gap-2 rounded border border-divider bg-surface p-2.5">
                    <ShieldCheck className="size-3.5 shrink-0 text-success" aria-hidden />
                    <div className="flex-1 min-w-0">
                      <p className="text-muted">Previous block hash</p>
                      <code className="block break-all font-mono text-[11px]" data-testid="audit-prev-hash">
                        {data.prev_hash || 'GENESIS'}
                      </code>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 rounded border border-action/30 bg-action/5 p-2.5">
                    <ShieldAlert className="size-3.5 shrink-0 text-action" aria-hidden />
                    <div className="flex-1 min-w-0">
                      <p className="text-muted">This event hash</p>
                      <code className="block break-all font-mono text-[11px]" data-testid="audit-this-hash">
                        {data.hash}
                      </code>
                    </div>
                  </div>
                  <p className="pt-1 text-xs text-muted">
                    Each event's hash is SHA-256 of (event fields + prev_hash). Tamper any field on any
                    event and `/v1/audit/integrity` reports the break.
                  </p>
                </div>
              </Panel>
            </>
          ) : (
            <p className="text-sm text-muted">Loading event…</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// M6.2 — Evidence Packages panel
//
// Bundle filtered events into an immutable package for regulator
// submission. The current filter state from the page is offered as the
// default — operators can also tighten it before submitting. Each
// package carries chain-verified integrity + size + event count.
// ──────────────────────────────────────────────────────────────────────

function EvidencePackagesPanel({ currentFilters }: { currentFilters: AuditEventQuery }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['audit.evidence.list'],
    queryFn: () => api.auditEvidenceList(),
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AuditEvidenceBuildInput>(() => ({
    actor_username: currentFilters.actor_username || '',
    action: currentFilters.action || '',
    resource_type: currentFilters.resource_type || '',
    outcome: currentFilters.outcome || '',
    severity: currentFilters.severity || '',
  }));
  const [buildError, setBuildError] = useState<string | null>(null);

  const buildMut = useMutation({
    mutationFn: (input: AuditEvidenceBuildInput) => api.auditEvidenceBuild(input),
    onSuccess: () => {
      setBuildError(null);
      qc.invalidateQueries({ queryKey: ['audit.evidence.list'] });
      setOpen(false);
    },
    onError: (err) => {
      setBuildError(err instanceof Error ? err.message : 'Failed to build package.');
    },
  });

  const items = list.data?.items ?? [];

  return (
    <Panel
      title="Evidence packages"
      action={
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setForm({
              actor_username: currentFilters.actor_username || '',
              action: currentFilters.action || '',
              resource_type: currentFilters.resource_type || '',
              outcome: currentFilters.outcome || '',
              severity: currentFilters.severity || '',
            });
            setBuildError(null);
            setOpen(true);
          }}
          data-testid="audit-build-evidence-btn"
        >
          <Plus size={13} className="mr-1" />
          Build package
        </Button>
      }
    >
      {list.isLoading && (
        <div className="h-20 w-full animate-pulse rounded bg-surface-alt" />
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="text-sm text-muted" data-testid="audit-evidence-empty">
          No packages yet. Build one from the current filter view for
          regulator submission.
        </div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-divider" data-testid="audit-evidence-list">
          {items.map((p) => (
            <li
              key={p.package_id}
              className="flex items-start justify-between gap-3 py-2"
              data-testid={`audit-evidence-row-${p.package_id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Archive size={13} className="text-action" aria-hidden />
                  <code className="text-xs font-semibold text-ink">{p.package_id}</code>
                  {p.integrity.chain_verified ? (
                    <Badge tone="success" className="text-[10px]">
                      <ShieldCheck size={9} className="mr-0.5 inline" />
                      verified
                    </Badge>
                  ) : (
                    <Badge tone="danger" className="text-[10px]">
                      <ShieldAlert size={9} className="mr-0.5 inline" />
                      broken
                    </Badge>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted">
                  <span data-testid={`audit-evidence-count-${p.package_id}`}>
                    {p.event_count} events
                  </span>{' '}
                  · {(p.size_bytes / 1024).toFixed(1)} KB · {fmtTs(p.generated_at)} ·{' '}
                  by {p.generated_by}
                </div>
              </div>
              <a
                href={`/v1/audit/evidence/${encodeURIComponent(p.package_id)}/summary.txt`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded border border-divider px-2 py-1 text-xs text-ink hover:border-action hover:text-action"
                title="Download printable summary"
              >
                <Download size={11} />
                .txt
              </a>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => setOpen(false)}
          data-testid="audit-evidence-modal"
        >
          <div
            className="w-full max-w-lg rounded-lg bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-divider px-5 py-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Archive size={16} className="text-action" />
                Build evidence package
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted hover:bg-divider/30"
                aria-label="close"
              >
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <p className="text-xs text-muted">
                Snapshot every event matching these filters into an
                immutable, chain-verified package. Submit to the regulator
                with the .txt summary attached.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-xs font-semibold text-muted">Actor</span>
                  <input
                    type="text"
                    value={form.actor_username ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, actor_username: e.target.value }))}
                    className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                    data-testid="audit-evidence-form-actor"
                  />
                </label>
                <label className="block">
                  <span className="block text-xs font-semibold text-muted">Action</span>
                  <input
                    type="text"
                    value={form.action ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}
                    className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                    placeholder="e.g. config.update"
                    data-testid="audit-evidence-form-action"
                  />
                </label>
                <label className="block">
                  <span className="block text-xs font-semibold text-muted">Resource type</span>
                  <select
                    value={form.resource_type ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, resource_type: e.target.value }))}
                    className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                    data-testid="audit-evidence-form-resource"
                  >
                    {RESOURCE_TYPES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-xs font-semibold text-muted">Severity</span>
                  <select
                    value={form.severity ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
                    className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                    data-testid="audit-evidence-form-severity"
                  >
                    {SEVERITIES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {buildError && (
                <p className="text-xs text-danger" data-testid="audit-evidence-form-error">
                  {buildError}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-divider px-5 py-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={buildMut.isPending}
                onClick={() => {
                  // Strip empty strings so the BFF doesn't treat them as filters
                  const clean: AuditEvidenceBuildInput = {};
                  for (const [k, v] of Object.entries(form)) {
                    if (v && String(v).trim()) {
                      (clean as Record<string, string>)[k] = String(v).trim();
                    }
                  }
                  buildMut.mutate(clean);
                }}
                data-testid="audit-evidence-form-submit"
              >
                {buildMut.isPending ? 'Building…' : 'Build package'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ──────────────────────────────────────────────────────────────────────
// M6.2 — Retention Policies panel
//
// Per-scope retention configuration. Strategies are a closed enum
// (count_cap / time_window / never_purge) declared by the BFF, so the
// SPA loads them dynamically — no drift if the catalog evolves.
// ──────────────────────────────────────────────────────────────────────

function RetentionPoliciesPanel() {
  const qc = useQueryClient();
  const strategies = useQuery({
    queryKey: ['audit.retention.strategies'],
    queryFn: () => api.auditRetentionStrategies(),
    staleTime: 5 * 60_000,
  });
  const list = useQuery({
    queryKey: ['audit.retention.list'],
    queryFn: () => api.auditRetentionList(),
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AuditRetentionPolicyCreateInput>({
    policy_id: '',
    scope: 'audit_trail',
    strategy: 'time_window',
    retention_days: 365,
  });
  const [formError, setFormError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (input: AuditRetentionPolicyCreateInput) => api.auditRetentionCreate(input),
    onSuccess: () => {
      setFormError(null);
      qc.invalidateQueries({ queryKey: ['audit.retention.list'] });
      setOpen(false);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : 'Failed to create policy.');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (policy_id: string) => api.auditRetentionDelete(policy_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['audit.retention.list'] }),
  });

  const items = list.data?.items ?? [];
  const validStrategies = (strategies.data?.strategies ?? [
    'count_cap',
    'time_window',
    'never_purge',
  ]) as AuditRetentionStrategy[];
  const validScopes = strategies.data?.scopes ?? ['audit_trail'];

  return (
    <Panel
      title="Retention policies"
      action={
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setForm({
              policy_id: `pol-${Date.now()}`,
              scope: 'audit_trail',
              strategy: 'time_window',
              retention_days: 365,
            });
            setFormError(null);
            setOpen(true);
          }}
          data-testid="audit-retention-new-btn"
        >
          <Plus size={13} className="mr-1" />
          New policy
        </Button>
      }
    >
      {list.isLoading && (
        <div className="h-20 w-full animate-pulse rounded bg-surface-alt" />
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="text-sm text-muted" data-testid="audit-retention-empty">
          No policies. Default is unbounded (production = WORM bucket).
          Add a per-scope policy to compact the audit ledger.
        </div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-divider" data-testid="audit-retention-list">
          {items.map((p) => (
            <li
              key={p.policy_id}
              className="flex items-start justify-between gap-3 py-2"
              data-testid={`audit-retention-row-${p.policy_id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Timer size={13} className="text-action" aria-hidden />
                  <code className="text-xs font-semibold text-ink">{p.policy_id}</code>
                  <Badge tone={p.active ? 'success' : 'neutral'} className="text-[10px]">
                    {p.active ? 'active' : 'inactive'}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-muted">
                  scope: <code>{p.scope}</code> · strategy:{' '}
                  <code>{p.strategy}</code>{' '}
                  {p.strategy === 'time_window' && p.retention_days != null && (
                    <>· retain {p.retention_days} days</>
                  )}
                  {p.strategy === 'count_cap' && p.max_events != null && (
                    <>· cap {p.max_events.toLocaleString()} events</>
                  )}
                  {p.notes && <span className="block italic">{p.notes}</span>}
                </div>
              </div>
              <button
                onClick={() => {
                  if (window.confirm(`Delete retention policy "${p.policy_id}"?`)) {
                    deleteMut.mutate(p.policy_id);
                  }
                }}
                className="rounded p-1 text-muted hover:bg-divider/30 hover:text-danger"
                aria-label={`Delete policy ${p.policy_id}`}
                data-testid={`audit-retention-delete-${p.policy_id}`}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={() => setOpen(false)}
          data-testid="audit-retention-modal"
        >
          <div
            className="w-full max-w-md rounded-lg bg-surface shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-divider px-5 py-3">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Timer size={16} className="text-action" />
                New retention policy
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted hover:bg-divider/30"
                aria-label="close"
              >
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <label className="block">
                <span className="block text-xs font-semibold text-muted">Policy ID</span>
                <input
                  type="text"
                  value={form.policy_id}
                  onChange={(e) => setForm((f) => ({ ...f, policy_id: e.target.value }))}
                  className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm font-mono"
                  data-testid="audit-retention-form-id"
                />
              </label>
              <label className="block">
                <span className="block text-xs font-semibold text-muted">Scope</span>
                <select
                  value={form.scope}
                  onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as 'audit_trail' }))}
                  className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                  data-testid="audit-retention-form-scope"
                >
                  {validScopes.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs font-semibold text-muted">Strategy</span>
                <select
                  value={form.strategy}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, strategy: e.target.value as AuditRetentionStrategy }))
                  }
                  className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                  data-testid="audit-retention-form-strategy"
                >
                  {validStrategies.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              {form.strategy === 'time_window' && (
                <label className="block">
                  <span className="block text-xs font-semibold text-muted">
                    Retention days
                  </span>
                  <input
                    type="number"
                    value={form.retention_days ?? 365}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, retention_days: Number(e.target.value) || null }))
                    }
                    min={1}
                    className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                    data-testid="audit-retention-form-days"
                  />
                </label>
              )}
              {form.strategy === 'count_cap' && (
                <label className="block">
                  <span className="block text-xs font-semibold text-muted">Max events</span>
                  <input
                    type="number"
                    value={form.max_events ?? 1_000_000}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, max_events: Number(e.target.value) || null }))
                    }
                    min={1}
                    className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                    data-testid="audit-retention-form-cap"
                  />
                </label>
              )}
              <label className="block">
                <span className="block text-xs font-semibold text-muted">Notes</span>
                <input
                  type="text"
                  value={form.notes ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  className="mt-0.5 w-full rounded border border-divider bg-surface px-2 py-1 text-sm"
                  placeholder="Compliance rationale"
                />
              </label>
              {formError && (
                <p className="text-xs text-danger" data-testid="audit-retention-form-error">
                  {formError}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-divider px-5 py-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={createMut.isPending}
                onClick={() => {
                  // Trim notes; honour the strategy-specific field
                  const clean: AuditRetentionPolicyCreateInput = {
                    policy_id: form.policy_id.trim(),
                    scope: form.scope,
                    strategy: form.strategy,
                  };
                  if (form.strategy === 'time_window') clean.retention_days = form.retention_days;
                  if (form.strategy === 'count_cap') clean.max_events = form.max_events;
                  if (form.notes && form.notes.trim()) clean.notes = form.notes.trim();
                  createMut.mutate(clean);
                }}
                data-testid="audit-retention-form-submit"
              >
                {createMut.isPending ? 'Saving…' : 'Create policy'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
