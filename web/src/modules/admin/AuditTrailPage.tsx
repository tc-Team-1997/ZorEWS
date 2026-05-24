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
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
  Copy,
  Link2,
} from 'lucide-react';
import {
  api,
  type AuditEventQuery,
  type AuditOutcome,
  type AuditResourceType,
  type AuditSeverity,
} from '@/lib/api';
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
              <div className="grid grid-cols-2 gap-3 text-sm">
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
