// web/src/modules/admin/DataIngestionPage.tsx
//
// Module 1.1 — Data Ingestion (Source Feeds management).
//
// Spec deliverables:
//   - Source Feeds table (name / type / schedule / last sync / last status
//     / row-count 24h / owner; per-row: Sync now, View runs, Pause/Resume, Edit)
//   - Schema Drift Detection card
//   - Failure Log
//   - Source Editor modal (Add / Edit)
//
// Wired to:
//   GET    /v1/ingestion/connectors
//   POST   /v1/ingestion/connectors                  (Add)
//   PATCH  /v1/ingestion/connectors/:id              (Edit)
//   POST   /v1/ingestion/connectors/:id/run          (Sync now)
//   POST   /v1/ingestion/connectors/:id/{pause,resume}
//   GET    /v1/ingestion/connectors/:id/runs
//   GET    /v1/ingestion/connectors/schema-drift     (Schema Drift card)
//   GET    /v1/ingestion/health                      (KPI strip)

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Database,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import {
  api,
  type IngestionConnector,
  type IngestionConnectorCreateInput,
  type IngestionConnectorRun,
  type IngestionConnectorType,
  type IngestionConnectorUpdateInput,
  type IngestionSchemaDriftRow,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const TYPE_LABELS: Record<IngestionConnectorType, string> = {
  kafka_stream: 'Kafka stream',
  batch_csv: 'Batch CSV',
  rest_api: 'REST API',
  soap_api: 'SOAP API',
  sftp_drop: 'SFTP drop',
};

function statusTone(s: IngestionConnector['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  if (s === 'healthy') return 'success';
  if (s === 'degraded') return 'warning';
  if (s === 'failing') return 'danger';
  return 'neutral';
}

function fmtTs(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

export function DataIngestionPage() {
  const qc = useQueryClient();

  const connectors = useQuery({
    queryKey: ['ingestion.connectors'],
    queryFn: api.ingestionConnectors,
  });
  const health = useQuery({
    queryKey: ['ingestion.health'],
    queryFn: api.ingestionHealth,
  });
  const drift = useQuery({
    queryKey: ['ingestion.schemaDrift'],
    queryFn: api.ingestionSchemaDrift,
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<IngestionConnector | null>(null);
  const [runsTarget, setRunsTarget] = useState<IngestionConnector | null>(null);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['ingestion.connectors'] });
    qc.invalidateQueries({ queryKey: ['ingestion.health'] });
    qc.invalidateQueries({ queryKey: ['ingestion.schemaDrift'] });
  };

  const syncMut = useMutation({
    mutationFn: (id: string) => api.ingestionRunNow(id),
    onSuccess: refreshAll,
  });
  const pauseMut = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      paused ? api.ingestionResume(id) : api.ingestionPause(id),
    onSuccess: refreshAll,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data Ingestion"
        subtitle="Source Feeds management — connectors, schema drift, failure log."
        actions={
          <Button
            onClick={() => {
              setEditorTarget(null);
              setEditorOpen(true);
            }}
            data-testid="ingestion-add-source"
          >
            <Plus className="size-4" aria-hidden /> Add source
          </Button>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard
          label="Total connectors"
          value={health.data ? health.data.total_connectors.toString() : '—'}
          sub="Across all source types"
          testId="kpi-ingestion-total"
        />
        <MetricCard
          label="Healthy"
          value={health.data ? (health.data.by_status.healthy ?? 0).toString() : '—'}
          sub="Sources up + within SLA"
          tone="success"
          testId="kpi-ingestion-healthy"
        />
        <MetricCard
          label="Attention required"
          value={health.data ? health.data.attention_required.length.toString() : '—'}
          sub="Degraded / failing / paused"
          tone="warning"
          testId="kpi-ingestion-attention"
        />
        <MetricCard
          label="Schema drift"
          value={drift.data ? drift.data.drifted_count.toString() : '—'}
          sub={
            drift.data
              ? `${drift.data.clean_count} clean of ${drift.data.total_connectors}`
              : 'scanning…'
          }
          tone={drift.data && drift.data.drifted_count > 0 ? 'warning' : 'success'}
          testId="kpi-ingestion-drift"
        />
      </div>

      {/* Source Feeds table */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Activity className="size-4 text-action" aria-hidden /> Source Feeds
          </span>
        }
        action={
          <Button variant="ghost" onClick={refreshAll}>
            <RefreshCw className="size-4" aria-hidden /> Refresh
          </Button>
        }
        data-testid="ingestion-source-feeds-panel"
      >
        {connectors.isLoading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : connectors.data && connectors.data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No connectors configured.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="ingestion-source-feeds-table">
              <thead className="text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="px-3 py-2">Source name</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Schedule</th>
                  <th className="px-3 py-2">Last sync</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Rows last 24h</th>
                  <th className="px-3 py-2">Owner</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connectors.data?.items.map((c) => (
                  <tr key={c.id} className="border-t border-divider" data-testid={`ingestion-row-${c.id}`}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{c.name}</div>
                      <div className="text-xs text-muted">
                        {c.source_system} · {c.id}
                        {c.is_custom && <Badge tone="blue">custom</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">{TYPE_LABELS[c.type] ?? c.type}</td>
                    <td className="px-3 py-2 text-xs text-muted">{c.schedule}</td>
                    <td className="px-3 py-2 text-xs tabular-nums">{fmtTs(c.last_run_at)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">
                      {c.last_run_records ? c.last_run_records.toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">{c.owner_user_id ?? '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          className="rounded-md border border-divider bg-surface px-2 py-0.5 text-xs hover:border-action/40"
                          onClick={() => syncMut.mutate(c.id)}
                          disabled={syncMut.isPending}
                          data-testid={`ingestion-sync-${c.id}`}
                          title="Sync now"
                        >
                          <RefreshCw className="size-3" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-divider bg-surface px-2 py-0.5 text-xs hover:border-action/40"
                          onClick={() => setRunsTarget(c)}
                          data-testid={`ingestion-runs-${c.id}`}
                          title="View runs"
                        >
                          Runs
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-divider bg-surface px-2 py-0.5 text-xs hover:border-action/40"
                          onClick={() => pauseMut.mutate({ id: c.id, paused: c.status === 'paused' })}
                          disabled={pauseMut.isPending}
                          data-testid={`ingestion-pause-${c.id}`}
                          title={c.status === 'paused' ? 'Resume' : 'Pause'}
                        >
                          {c.status === 'paused' ? <Play className="size-3" /> : <Pause className="size-3" />}
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-divider bg-surface px-2 py-0.5 text-xs hover:border-action/40"
                          onClick={() => {
                            setEditorTarget(c);
                            setEditorOpen(true);
                          }}
                          data-testid={`ingestion-edit-${c.id}`}
                          title="Edit"
                        >
                          <Settings className="size-3" />
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

      {/* Schema Drift Detection card */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Database className="size-4 text-warning" aria-hidden /> Schema Drift Detection
          </span>
        }
        data-testid="ingestion-schema-drift-panel"
      >
        {drift.isLoading ? (
          <p className="py-3 text-sm text-muted">Loading…</p>
        ) : drift.data && drift.data.drifted_count === 0 ? (
          <div className="rounded-md border border-success/20 bg-success/5 px-3 py-2 text-sm" data-testid="drift-empty">
            <p className="font-medium text-success">No schema drift detected.</p>
            <p className="text-muted mt-0.5">
              All {drift.data.total_connectors} connectors match the platform schema baseline.
            </p>
          </div>
        ) : drift.data ? (
          <ul className="space-y-1.5" data-testid="drift-rows">
            {drift.data.drifted_rows.map((r: IngestionSchemaDriftRow) => (
              <li
                key={r.connector_id}
                className="flex items-center justify-between rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm"
                data-testid={`drift-row-${r.connector_id}`}
              >
                <div className="min-w-0">
                  <p className="font-medium text-ink">{r.name}</p>
                  <p className="text-xs text-muted">
                    {r.source_system} · {r.overrides_count} tenant-added field
                    {r.overrides_count === 1 ? '' : 's'}
                    {r.tenant_added_fields.length > 0
                      ? `: ${r.tenant_added_fields.slice(0, 3).join(', ')}${r.tenant_added_fields.length > 3 ? `, +${r.tenant_added_fields.length - 3} more` : ''}`
                      : ''}
                  </p>
                </div>
                <Badge tone="warning">drift</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-sm text-muted">Failed to load drift summary.</p>
        )}
      </Panel>

      {/* Failure Log */}
      <FailureLogPanel
        connectors={connectors.data?.items ?? []}
      />

      {editorOpen && (
        <SourceEditorModal
          target={editorTarget}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false);
            refreshAll();
          }}
        />
      )}

      {runsTarget && (
        <RunsModal connector={runsTarget} onClose={() => setRunsTarget(null)} />
      )}
    </div>
  );
}

// ─── Failure Log (aggregates failed runs across connectors) ────────────

function FailureLogPanel({ connectors }: { connectors: IngestionConnector[] }) {
  // Pull last 30 runs per connector, surface only failures + partials.
  const failures = useQuery({
    queryKey: ['ingestion.failureLog', connectors.map((c) => c.id).join(',')],
    queryFn: async () => {
      const all: (IngestionConnectorRun & { connector_name: string; connector_id: string })[] = [];
      for (const c of connectors) {
        try {
          const res = await api.ingestionConnectorRuns(c.id, 30);
          for (const r of res.items) {
            if (r.status === 'failure' || r.status === 'partial') {
              all.push({ ...r, connector_name: c.name, connector_id: c.id });
            }
          }
        } catch {
          /* connector lookup may 404 if registry shrank since list — ignore */
        }
      }
      all.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
      return all.slice(0, 20);
    },
    enabled: connectors.length > 0,
  });

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-danger" aria-hidden /> Failure Log
        </span>
      }
      data-testid="ingestion-failure-log-panel"
    >
      {failures.isLoading ? (
        <p className="py-3 text-sm text-muted">Loading…</p>
      ) : failures.data && failures.data.length === 0 ? (
        <p className="py-3 text-sm text-muted" data-testid="failures-empty">
          No failures in the last 30 runs per connector.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="failure-rows">
          {failures.data?.map((f) => (
            <li
              key={f.run_id}
              className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm"
              data-testid={`failure-row-${f.run_id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-ink">{f.connector_name}</p>
                <Badge tone={f.status === 'failure' ? 'danger' : 'warning'}>{f.status}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {fmtTs(f.started_at)} · {f.records_failed.toLocaleString()} rows failed
              </p>
              {f.error_message && (
                <code className="mt-1 block break-all rounded bg-ink/5 px-2 py-1 text-2xs font-mono">
                  {f.error_message}
                </code>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ─── Runs modal ────────────────────────────────────────────────────────

function RunsModal({ connector, onClose }: { connector: IngestionConnector; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['ingestion.runs', connector.id],
    queryFn: () => api.ingestionConnectorRuns(connector.id, 50),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      data-testid="ingestion-runs-modal"
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-divider px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{connector.name} — runs</h2>
            <p className="text-xs text-muted">{connector.id}</p>
          </div>
          <button className="rounded p-1 hover:bg-divider/50" onClick={onClose} aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-2 px-6 py-4">
          {data?.items.length === 0 && <p className="text-sm text-muted">No runs recorded yet.</p>}
          {data?.items.map((r) => (
            <div
              key={r.run_id}
              className="flex items-center justify-between rounded-md border border-divider bg-surface px-3 py-2 text-sm"
            >
              <div>
                <div className="font-medium text-ink">{fmtTs(r.started_at)}</div>
                <div className="text-xs text-muted">
                  {r.records_processed.toLocaleString()} processed · {r.records_failed.toLocaleString()} failed ·{' '}
                  {r.triggered_manually ? 'manual' : 'scheduled'}
                </div>
              </div>
              <Badge tone={r.status === 'success' ? 'success' : r.status === 'failure' ? 'danger' : 'warning'}>
                {r.status}
              </Badge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Source Editor modal (Add / Edit) ─────────────────────────────────

const VALID_TYPES: IngestionConnectorType[] = [
  'kafka_stream',
  'batch_csv',
  'rest_api',
  'soap_api',
  'sftp_drop',
];

function SourceEditorModal({
  target,
  onClose,
  onSaved,
}: {
  target: IngestionConnector | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!target;
  const [id, setId] = useState(target?.id ?? '');
  const [name, setName] = useState(target?.name ?? '');
  const [sourceSystem, setSourceSystem] = useState(target?.source_system ?? '');
  const [type, setType] = useState<IngestionConnectorType>(target?.type ?? 'rest_api');
  const [schedule, setSchedule] = useState(target?.schedule ?? 'daily 06:00');
  const [description, setDescription] = useState(target?.description ?? '');
  const [owner, setOwner] = useState(target?.owner_user_id ?? '');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const idDisabled = isEdit;

  const createMut = useMutation({
    mutationFn: (input: IngestionConnectorCreateInput) => api.ingestionCreateConnector(input),
    onSuccess: onSaved,
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: { message?: string } } }; message?: string })?.response?.data?.error?.message
        ?? (e as Error).message
        ?? 'Save failed';
      setErrorMsg(msg);
    },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: IngestionConnectorUpdateInput }) =>
      api.ingestionUpdateConnector(id, patch),
    onSuccess: onSaved,
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: { message?: string } } }; message?: string })?.response?.data?.error?.message
        ?? (e as Error).message
        ?? 'Save failed';
      setErrorMsg(msg);
    },
  });

  const submit = () => {
    setErrorMsg(null);
    if (isEdit) {
      updateMut.mutate({
        id: target!.id,
        patch: {
          name: name || undefined,
          source_system: sourceSystem || undefined,
          type,
          schedule: schedule || undefined,
          description: description || undefined,
          owner_user_id: owner || null,
        },
      });
    } else {
      createMut.mutate({
        id: id.trim(),
        name: name.trim(),
        source_system: sourceSystem.trim(),
        type,
        schedule: schedule.trim(),
        description: description.trim() || undefined,
        owner_user_id: owner.trim() || null,
      });
    }
  };

  const valid = useMemo(() => {
    if (isEdit) return name.trim().length > 0;
    return (
      /^[a-z][a-z0-9_]{2,63}$/.test(id) &&
      name.trim().length > 0 &&
      sourceSystem.trim().length > 0 &&
      schedule.trim().length > 0
    );
  }, [id, name, sourceSystem, schedule, isEdit]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      data-testid="ingestion-source-editor"
    >
      <div
        className="w-full max-w-lg rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-divider px-6 py-4">
          <h2 className="text-lg font-semibold">{isEdit ? 'Edit source' : 'Add new source'}</h2>
          <button className="rounded p-1 hover:bg-divider/50" onClick={onClose} aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-3 px-6 py-4">
          <Field label="Connector ID">
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              disabled={idDisabled}
              placeholder="e.g. gst_returns"
              data-testid="editor-id"
              className="w-full rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm outline-none disabled:opacity-60"
            />
            {!idDisabled && (
              <p className="mt-0.5 text-2xs text-muted">
                Lowercase letters, digits, underscores. 3-64 chars. Must start with a letter.
              </p>
            )}
          </Field>
          <Field label="Display name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. GST GSTR-3B Pull"
              data-testid="editor-name"
              className="w-full rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm outline-none"
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Source system">
              <input
                type="text"
                value={sourceSystem}
                onChange={(e) => setSourceSystem(e.target.value)}
                placeholder="e.g. GSTN"
                data-testid="editor-source"
                className="w-full rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm outline-none"
              />
            </Field>
            <Field label="Type">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as IngestionConnectorType)}
                data-testid="editor-type"
                className="w-full rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm"
              >
                {VALID_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Schedule">
            <input
              type="text"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="e.g. daily 06:00 OR every 5 min"
              data-testid="editor-schedule"
              className="w-full rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm outline-none"
            />
          </Field>
          <Field label="Owner (username)">
            <input
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="e.g. ravi.risk"
              data-testid="editor-owner"
              className="w-full rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm outline-none"
            />
          </Field>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              data-testid="editor-description"
              className="w-full rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm outline-none"
            />
          </Field>
          {errorMsg && (
            <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger" data-testid="editor-error">
              {errorMsg}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-divider px-6 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || createMut.isPending || updateMut.isPending} data-testid="editor-save">
            {isEdit ? 'Save changes' : 'Add source'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-ink">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
