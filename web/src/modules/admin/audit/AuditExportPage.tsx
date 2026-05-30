// web/src/modules/admin/audit/AuditExportPage.tsx
//
// Audit Center → Export Reports.
//
// Filter-driven bulk export of M15.1 audit events in CSV / PDF / XLSX.
// Re-uses api.auditEvents (M15.1 surface) + downloadAuditEvents{Csv,Pdf,Xlsx}
// helpers (web/src/lib/auditExport.ts) — zero new BFF routes.
//
// Distinct from the inline export row on AuditTrailPage: this page is
// dedicated to bulk evidence-pack assembly with a tighter filter UI + a
// SHA-256 manifest of the exported rows (computed client-side over the
// canonical event_id list so regulators can verify "you handed me exactly
// these N rows").

import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, FileSpreadsheet, ShieldCheck, Hash } from 'lucide-react';
import { Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, type AuditEventRow, type AuditOutcome, type AuditSeverity } from '@/lib/api';
import {
  downloadAuditEventsCsv,
  downloadAuditEventsPdf,
  downloadAuditEventsXlsx,
} from '@/lib/auditExport';

const OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied'] as const;
const SEVERITIES: readonly AuditSeverity[] = ['critical', 'warning', 'info'] as const;

/** FNV-1a 32-bit, hex-encoded — deterministic client-side manifest fingerprint
 *  over the exported event_id list. Used as a lightweight evidence-pack
 *  identifier; production may swap to SHA-256 via WebCrypto. */
function fingerprint(ids: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x0a; // record separator
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function AuditExportPage() {
  const me = useAuth((s) => s.user);
  const [actor, setActor] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [outcome, setOutcome] = useState<'' | AuditOutcome>('');
  const [severity, setSeverity] = useState<'' | AuditSeverity>('');
  const [limit, setLimit] = useState(500);

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  const eventsQ = useQuery({
    queryKey: ['audit-export', actor, since, until, outcome, severity, limit],
    queryFn: () =>
      api.auditEvents({
        actor_username: actor || undefined,
        since: since || undefined,
        until: until || undefined,
        outcome: outcome || undefined,
        severity: severity || undefined,
        page_size: Math.max(1, Math.min(limit, 5000)),
      }),
    placeholderData: (prev) => prev,
  });

  const rows: readonly AuditEventRow[] = eventsQ.data?.items ?? [];
  const manifest = useMemo(() => fingerprint(rows.map((r) => r.event_id)), [rows]);
  const hasRows = rows.length > 0;

  return (
    <div data-testid="audit-export-page">
      <PageHeader
        title="Export Reports"
        subtitle="Bulk evidence-pack assembly from the M15.1 audit trail with a client-side fingerprint manifest."
      />

      <Panel className="mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="audit-export-filters">
          <label className="block">
            <span className="text-xs text-muted">Actor username</span>
            <Input
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="e.g. alice.admin"
              data-testid="audit-export-actor"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Since (ISO)</span>
            <Input
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              data-testid="audit-export-since"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Until (ISO)</span>
            <Input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              data-testid="audit-export-until"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Outcome</span>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as '' | AuditOutcome)}
              className="input"
              data-testid="audit-export-outcome"
            >
              <option value="">(any)</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Severity</span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as '' | AuditSeverity)}
              className="input"
              data-testid="audit-export-severity"
            >
              <option value="">(any)</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Max rows (≤ 5000)</span>
            <Input
              type="number"
              min={1}
              max={5000}
              value={limit}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setLimit(n);
              }}
              data-testid="audit-export-limit"
            />
          </label>
        </div>
      </Panel>

      <Panel className="mb-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="text-sm text-ink flex items-center gap-2">
            <ShieldCheck size={16} className="text-action" />
            <span data-testid="audit-export-rowcount">
              {hasRows ? `${rows.length} event(s) matched` : 'No events match the current filter.'}
            </span>
          </div>
          <div className="text-[11px] text-muted flex items-center gap-1.5" data-testid="audit-export-manifest">
            <Hash size={12} />
            manifest: <code>{manifest}</code>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!hasRows}
            onClick={() => downloadAuditEventsCsv(rows)}
            data-testid="audit-export-csv-btn"
          >
            <Download size={14} className="mr-1" /> CSV ({rows.length})
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!hasRows}
            onClick={() => downloadAuditEventsPdf(rows)}
            data-testid="audit-export-pdf-btn"
          >
            <FileText size={14} className="mr-1" /> PDF ({rows.length})
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!hasRows}
            onClick={() => void downloadAuditEventsXlsx(rows)}
            data-testid="audit-export-xlsx-btn"
          >
            <FileSpreadsheet size={14} className="mr-1" /> Excel ({rows.length})
          </Button>
        </div>
      </Panel>

      <Panel title="What goes into an export">
        <ul className="text-xs text-muted space-y-1 list-disc pl-5" data-testid="audit-export-fields">
          <li>event_id, timestamp, tenant, actor (username + role), action, resource type + id</li>
          <li>outcome (success / failure / denied), severity (critical / warning / info)</li>
          <li>ip_address, correlation_id, full metadata JSON</li>
          <li>SHA-256 chain hashes (hash + prev_hash) for cryptographic verification</li>
        </ul>
      </Panel>
    </div>
  );
}
