// web/src/modules/admin/RecycleBinPage.tsx
//
// Recovery Center — centralised view of every soft-deleted record
// across all adopting services. Today: webhook_subscription +
// saved_scenario (Phase 1). Future: case, alert, user, etc. as each
// service adopts the pattern (see docs/recovery-center.md).
//
// UX:
//   - Header with stats tile (total / by status / most recent)
//   - Status tabs: Archived (default) / Restored / Purged
//   - Module + entity filter chips (only adapters with rows render chips)
//   - Table per row with restore + purge buttons (admin only)
//   - Restore confirms; purge double-confirms (irreversible)
//   - Expandable JSON payload preview

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Filter,
  RefreshCw,
  RotateCcw,
  Trash2,
  Trash,
} from 'lucide-react';
import { api, type DeletedRecord, type RecoveryStatus } from '@/lib/api';
import { Badge, Button, Modal, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const STATUS_TABS: { key: RecoveryStatus; label: string }[] = [
  { key: 'archived', label: 'Recoverable' },
  { key: 'restored', label: 'Restored' },
  { key: 'purged', label: 'Permanently deleted' },
];

export function RecycleBinPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<RecoveryStatus>('archived');
  const [moduleFilter, setModuleFilter] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [restoreTarget, setRestoreTarget] = useState<DeletedRecord | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<DeletedRecord | null>(null);

  const listQ = useQuery({
    queryKey: ['recovery-list', { status, moduleFilter, entityFilter }],
    queryFn: () =>
      api.recoveryList({
        status,
        module: (moduleFilter as never) ?? undefined,
        entity_type: entityFilter ?? undefined,
        page_size: 100,
      }),
  });
  const statsQ = useQuery({
    queryKey: ['recovery-stats'],
    queryFn: () => api.recoveryStats(),
  });

  const restoreMut = useMutation({
    mutationFn: (recovery_id: string) => api.recoveryRestore(recovery_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recovery-list'] });
      qc.invalidateQueries({ queryKey: ['recovery-stats'] });
      setRestoreTarget(null);
    },
  });
  const purgeMut = useMutation({
    mutationFn: (recovery_id: string) => api.recoveryPurge(recovery_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recovery-list'] });
      qc.invalidateQueries({ queryKey: ['recovery-stats'] });
      setPurgeTarget(null);
    },
  });

  const items = listQ.data?.items ?? [];
  const total = listQ.data?.total ?? 0;

  const moduleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of items) m.set(r.module, (m.get(r.module) ?? 0) + 1);
    return m;
  }, [items]);

  const entityCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of items) m.set(r.entity_type, (m.get(r.entity_type) ?? 0) + 1);
    return m;
  }, [items]);

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="Recovery Center"
        subtitle="Soft-deleted records from every adopting module. Restore reinserts with the original ID; purge is permanent."
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ['recovery-list'] });
              qc.invalidateQueries({ queryKey: ['recovery-stats'] });
            }}
            data-testid="recycle-bin-refresh"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />

      {/* Stats strip */}
      {statsQ.data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="recycle-bin-stats">
          <StatTile label="Total archived (all time)" value={statsQ.data.total.toLocaleString()} />
          <StatTile
            label="Recoverable"
            value={statsQ.data.by_status.archived.toLocaleString()}
            tone="warning"
          />
          <StatTile
            label="Restored"
            value={statsQ.data.by_status.restored.toLocaleString()}
            tone="success"
          />
          <StatTile
            label="Permanently deleted"
            value={statsQ.data.by_status.purged.toLocaleString()}
            tone="muted"
          />
        </div>
      )}

      {/* Status tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200" role="tablist" aria-label="Recovery status">
        {STATUS_TABS.map((t) => {
          const active = status === t.key;
          const count = statsQ.data?.by_status?.[t.key] ?? 0;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setStatus(t.key)}
              data-testid={`recycle-bin-tab-${t.key}`}
              className={`px-3 py-2 text-[12px] -mb-px border-b-2 transition-colors ${
                active
                  ? 'border-action text-action font-semibold'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t.label}
              <span className="ml-1 text-[10px] text-slate-400">{count.toLocaleString()}</span>
            </button>
          );
        })}
      </div>

      {/* Filter chips */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-slate-400" aria-hidden />
            Filters
          </span>
        }
        action={
          (moduleFilter || entityFilter) && (
            <button
              type="button"
              className="text-[11px] text-muted hover:text-ink"
              onClick={() => {
                setModuleFilter(null);
                setEntityFilter(null);
              }}
              data-testid="recycle-bin-clear-filters"
            >
              Clear
            </button>
          )
        }
      >
        <div className="flex flex-wrap gap-1.5 text-[11px]" data-testid="recycle-bin-filters">
          <span className="text-muted mr-1">Module:</span>
          {[...moduleCounts.entries()].sort().map(([mod, n]) => (
            <FilterChip
              key={mod}
              label={`${mod} · ${n}`}
              active={moduleFilter === mod}
              onClick={() => setModuleFilter(moduleFilter === mod ? null : mod)}
              testId={`recycle-bin-filter-module-${mod}`}
            />
          ))}
          {moduleCounts.size === 0 && <span className="text-[11px] text-muted">(no modules)</span>}
          <span className="text-muted ml-3 mr-1">Entity:</span>
          {[...entityCounts.entries()].sort().map(([ent, n]) => (
            <FilterChip
              key={ent}
              label={`${ent} · ${n}`}
              active={entityFilter === ent}
              onClick={() => setEntityFilter(entityFilter === ent ? null : ent)}
              testId={`recycle-bin-filter-entity-${ent}`}
            />
          ))}
          {entityCounts.size === 0 && <span className="text-[11px] text-muted">(no entities)</span>}
        </div>
      </Panel>

      {/* List */}
      <Panel
        title={
          <span>
            {STATUS_TABS.find((t) => t.key === status)?.label}{' '}
            <span className="text-muted font-normal text-[11px]">
              · {total.toLocaleString()} record{total === 1 ? '' : 's'}
            </span>
          </span>
        }
      >
        {listQ.isLoading ? (
          <div className="py-12 text-center text-[12px] text-muted">Loading…</div>
        ) : listQ.isError ? (
          <div className="py-12 text-center text-[12px] text-danger" data-testid="recycle-bin-error">
            Couldn't load deleted records.
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-[12px] text-muted" data-testid="recycle-bin-empty">
            {status === 'archived'
              ? 'No recoverable records. Deleted items will show up here.'
              : status === 'restored'
                ? 'No restored records yet.'
                : 'No permanently-deleted records.'}
          </div>
        ) : (
          <table className="w-full text-[12px]" data-testid="recycle-bin-table">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="py-1.5"></th>
                <th className="text-left py-1.5 font-medium">Module / entity</th>
                <th className="text-left py-1.5 font-medium">Original ID</th>
                <th className="text-left py-1.5 font-medium">Deleted by</th>
                <th className="text-left py-1.5 font-medium">When</th>
                <th className="text-right py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const isExp = expanded.has(r.recovery_id);
                return (
                  <RowFragment
                    key={r.recovery_id}
                    record={r}
                    expanded={isExp}
                    onToggle={() => {
                      const next = new Set(expanded);
                      if (next.has(r.recovery_id)) next.delete(r.recovery_id);
                      else next.add(r.recovery_id);
                      setExpanded(next);
                    }}
                    onRestore={() => setRestoreTarget(r)}
                    onPurge={() => setPurgeTarget(r)}
                    isMutating={restoreMut.isPending || purgeMut.isPending}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {/* Restore confirm modal */}
      <Modal
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        ariaLabel="Restore deleted record"
        size="lg"
        testId="recycle-bin-restore-modal"
      >
        {restoreTarget && (
          <div className="p-5">
            <h3 className="text-base font-semibold mb-2">Restore this record?</h3>
            <p className="text-[12px] text-muted mb-3">
              Re-inserts <code className="bg-slate-100 px-1 rounded">{restoreTarget.entity_type}</code> with
              its original ID <code className="bg-slate-100 px-1 rounded">{restoreTarget.original_id}</code>{' '}
              back into <code className="bg-slate-100 px-1 rounded">{restoreTarget.original_table}</code>.
              If a record with that ID was re-created since deletion, restore fails with a 409 conflict.
            </p>
            {restoreMut.isError && (
              <div className="mb-3 rounded border border-rose-300 bg-rose-50 p-2 text-[12px] text-rose-700">
                {(restoreMut.error as Error)?.message ?? 'Restore failed.'}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRestoreTarget(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => restoreMut.mutate(restoreTarget.recovery_id)}
                disabled={restoreMut.isPending}
                data-testid="recycle-bin-restore-confirm"
              >
                <RotateCcw className="h-4 w-4" /> Restore
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Purge confirm modal */}
      <Modal
        open={purgeTarget !== null}
        onClose={() => setPurgeTarget(null)}
        ariaLabel="Permanently delete record"
        size="lg"
        testId="recycle-bin-purge-modal"
      >
        {purgeTarget && (
          <div className="p-5">
            <div className="mb-3 flex items-center gap-2 text-danger">
              <AlertTriangle className="h-5 w-5" aria-hidden />
              <h3 className="text-base font-semibold">Permanently delete?</h3>
            </div>
            <p className="text-[12px] text-muted mb-3">
              This is irreversible. The recovery record stays in the audit log
              (marked <code className="bg-slate-100 px-1 rounded">purged</code>) but the payload can no longer be restored.
            </p>
            <p className="text-[12px] mb-3">
              <span className="text-muted">Will permanently delete:</span>{' '}
              <code className="bg-slate-100 px-1 rounded">{purgeTarget.entity_type}</code> /{' '}
              <code className="bg-slate-100 px-1 rounded">{purgeTarget.original_id}</code>
            </p>
            {purgeMut.isError && (
              <div className="mb-3 rounded border border-rose-300 bg-rose-50 p-2 text-[12px] text-rose-700">
                {(purgeMut.error as Error)?.message ?? 'Purge failed.'}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPurgeTarget(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => purgeMut.mutate(purgeTarget.recovery_id)}
                disabled={purgeMut.isPending}
                data-testid="recycle-bin-purge-confirm"
              >
                <Trash className="h-4 w-4" /> Delete permanently
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function StatTile({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: string;
  tone?: 'muted' | 'warning' | 'success' | 'danger';
}) {
  const cls =
    tone === 'warning'
      ? 'text-warning'
      : tone === 'success'
        ? 'text-success'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-ink';
  return (
    <div className="rounded-md border border-divider px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-[18px] tabular font-semibold mt-0.5 ${cls}`}>{value}</div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
        active
          ? 'border-action bg-action/10 text-action'
          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}

function RowFragment({
  record,
  expanded,
  onToggle,
  onRestore,
  onPurge,
  isMutating,
}: {
  record: DeletedRecord;
  expanded: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onPurge: () => void;
  isMutating: boolean;
}) {
  return (
    <>
      <tr className="border-b border-divider/40 hover:bg-slate-50">
        <td className="py-1.5 align-top">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Toggle payload preview"
            data-testid={`recycle-bin-toggle-${record.recovery_id}`}
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </td>
        <td className="py-1.5 align-top">
          <div className="text-ink font-medium">{record.entity_type}</div>
          <div className="text-muted text-[10px]">
            {record.module} · {record.original_table}
          </div>
        </td>
        <td className="py-1.5 align-top">
          <code className="bg-slate-100 px-1 rounded text-[11px]">{record.original_id}</code>
        </td>
        <td className="py-1.5 align-top text-ink">{record.deleted_by}</td>
        <td className="py-1.5 align-top text-muted tabular">
          {new Date(record.deleted_at).toLocaleString()}
        </td>
        <td className="py-1.5 align-top text-right whitespace-nowrap">
          {record.status === 'archived' ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRestore}
                disabled={isMutating}
                data-testid={`recycle-bin-restore-${record.recovery_id}`}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Restore
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onPurge}
                disabled={isMutating}
                data-testid={`recycle-bin-purge-${record.recovery_id}`}
                className="text-danger ml-1"
              >
                <Trash2 className="h-3.5 w-3.5" /> Purge
              </Button>
            </>
          ) : (
            <Badge tone={record.status === 'restored' ? 'success' : 'neutral'}>
              {record.status}
            </Badge>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50">
          <td></td>
          <td colSpan={5} className="py-2">
            <pre
              className="overflow-x-auto rounded border border-slate-200 bg-white p-2 text-[11px] text-slate-700"
              data-testid={`recycle-bin-payload-${record.recovery_id}`}
            >
              {JSON.stringify(record.payload, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
