import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  api,
  type SlaConfigRow,
  type SlaConfigStatus,
} from '@/lib/api';
import {
  Badge,
  Button,
  DataTable,
  DialogFooter,
  EnterpriseDialog,
  Input,
  Panel,
  type BadgeTone,
  type Column,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { SlaConfigEditModal } from './SlaConfigEditModal';
import { CreateSlaConfigModal } from './CreateSlaConfigModal';

const STATUS_TONE: Record<SlaConfigStatus, BadgeTone> = {
  ACTIVE: 'success',
  SUPERSEDED: 'neutral',
  ARCHIVED: 'neutral',
};

export function SlaConfigPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<SlaConfigStatus | 'ALL'>('ACTIVE');
  const [editing, setEditing] = useState<SlaConfigRow | null>(null);
  const [archiving, setArchiving] = useState<SlaConfigRow | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ['sla-config', statusFilter],
    queryFn: () =>
      api.slaConfigList({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        page_size: 200,
      }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['sla-config'] });

  const update = useMutation({
    mutationFn: (input: { id: string; patch: { sla_target_days?: number; notes?: string | null } }) =>
      api.slaConfigUpdate(input.id, input.patch),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.slaConfigArchive(id),
    onSuccess: () => {
      setArchiving(null);
      refresh();
    },
  });
  const create = useMutation({
    mutationFn: api.slaConfigCreate,
    onSuccess: () => {
      setCreating(false);
      refresh();
    },
  });

  const filtered = useMemo(() => {
    const items = list.data?.items ?? [];
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (r) =>
        r.case_category.toLowerCase().includes(q) ||
        r.priority.toLowerCase().includes(q) ||
        (r.business_unit ?? '').toLowerCase().includes(q) ||
        (r.notes ?? '').toLowerCase().includes(q),
    );
  }, [list.data?.items, search]);

  const counts = useMemo(() => {
    const items = list.data?.items ?? [];
    return {
      all: items.length,
      active: items.filter((r) => r.status === 'ACTIVE').length,
      superseded: items.filter((r) => r.status === 'SUPERSEDED').length,
      archived: items.filter((r) => r.status === 'ARCHIVED').length,
    };
  }, [list.data?.items]);

  const columns: Column<SlaConfigRow & { id: string }>[] = [
    {
      key: 'identity',
      header: 'Category · Priority',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium">{r.case_category}</span>
          <span className="text-2xs text-muted">
            <Badge tone="blue" className="text-2xs mr-1">
              {r.priority}
            </Badge>
            {r.business_unit ? `· ${r.business_unit}` : '· (all BUs)'}
          </span>
        </div>
      ),
      width: 240,
    },
    {
      key: 'target',
      header: 'SLA target',
      render: (r) => (
        <div className="flex flex-col">
          <span className="text-base font-semibold tabular-nums">{r.sla_target_days}d</span>
          {r.sla_target_days < 1 && (
            <span className="text-2xs text-muted">{Math.round(r.sla_target_days * 24)}h</span>
          )}
        </div>
      ),
      width: 110,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge tone={STATUS_TONE[r.status]} className="uppercase tracking-wide text-2xs">
          {r.status.toLowerCase()}
        </Badge>
      ),
      width: 120,
    },
    {
      key: 'effective',
      header: 'Effective',
      render: (r) => (
        <div className="flex flex-col text-2xs">
          <span>{new Date(r.effective_from).toLocaleDateString()}</span>
          <span className="text-muted">→ {r.effective_till ? new Date(r.effective_till).toLocaleDateString() : 'open'}</span>
        </div>
      ),
      width: 130,
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (r) => <span className="text-2xs">{r.notes ?? '—'}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          {r.status === 'ACTIVE' && (
            <>
              <button
                type="button"
                onClick={() => setEditing(r)}
                className="text-2xs text-blue-600 hover:underline inline-flex items-center gap-1"
                data-testid={`sla-edit-${r.sla_config_id}`}
              >
                <Pencil className="w-3 h-3" />
                Edit
              </button>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => setArchiving(r)}
                className="text-2xs text-rose-600 hover:underline inline-flex items-center gap-1"
                data-testid={`sla-archive-${r.sla_config_id}`}
              >
                <Trash2 className="w-3 h-3" />
                Archive
              </button>
            </>
          )}
        </div>
      ),
      width: 160,
    },
  ];

  return (
    <div>
      <PageHeader
        title="SLA Config"
        subtitle="Per-tenant SLA targets · BAC §3.1.6 · edits supersede, never delete"
      />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
        {(['ALL', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`text-left rounded-md border px-3 py-2 ${
              statusFilter === s ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'
            }`}
            onClick={() => setStatusFilter(s)}
            data-testid={`sla-pivot-${s.toLowerCase()}`}
          >
            <div className="text-2xs uppercase tracking-wide text-muted">
              {s === 'ALL' ? 'All' : s.toLowerCase()}
            </div>
            <div className="text-2xl font-semibold">
              {s === 'ALL' ? counts.all : s === 'ACTIVE' ? counts.active : s === 'SUPERSEDED' ? counts.superseded : counts.archived}
            </div>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 mb-4">
        <Input
          placeholder="Search by category, priority, business unit, or notes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
          data-testid="sla-search"
        />
        <div className="flex-1" />
        <Button onClick={() => setCreating(true)} data-testid="sla-add">
          <Plus className="w-4 h-4 mr-1" />
          Add SLA target
        </Button>
      </div>

      <Panel>
        <DataTable
          columns={columns}
          data={filtered.map((r) => ({ ...r, id: r.sla_config_id }))}
          empty={list.isLoading ? 'Loading…' : 'No SLA config rows match the filters'}
        />
      </Panel>

      {editing && (
        <SlaConfigEditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSubmit={(patch) =>
            update.mutate({ id: editing.sla_config_id, patch })
          }
          isPending={update.isPending}
          error={update.error}
        />
      )}

      {archiving && (
        <ArchiveConfirmModal
          row={archiving}
          onClose={() => setArchiving(null)}
          onConfirm={() => archive.mutate(archiving.sla_config_id)}
          isPending={archive.isPending}
          error={archive.error}
        />
      )}

      {creating && (
        <CreateSlaConfigModal
          existing={list.data?.items ?? []}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
          isPending={create.isPending}
          error={create.error}
        />
      )}
    </div>
  );
}

function ArchiveConfirmModal({
  row,
  onClose,
  onConfirm,
  isPending,
  error,
}: {
  row: SlaConfigRow;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
  error: unknown;
}) {
  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title="Archive SLA target"
      size="sm"
      closeOnBackdrop={false}
      testId="sla-archive-dialog"
      footer={
        <DialogFooter
          onCancel={onClose}
          primary={
            <Button onClick={onConfirm} disabled={isPending} data-testid="sla-archive-confirm">
              {isPending ? 'Archiving…' : 'Archive'}
            </Button>
          }
        />
      }
    >
      <p className="text-xs text-muted mb-3">
        Archiving <span className="font-mono">{row.case_category}/{row.priority}/{row.business_unit ?? '*'}</span>{' '}
        drops the SLA target for matching new cases. Existing open
        cases keep their current breach state until the next
        dashboard refresh, when they fall through to{' '}
        <span className="font-mono">default_fallback</span>. The row
        stays in audit history — it does not delete.
      </p>
      {error instanceof Error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-md px-3 py-2 text-xs">
          {error.message}
        </div>
      )}
    </EnterpriseDialog>
  );
}

void Pencil; // keep the symbol referenced for tree-shaking guards
