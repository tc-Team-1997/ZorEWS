import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import {
  api,
  type OverrideStatus,
  type UserAccessOverride,
} from '@/lib/api';
import { Badge, Button, DataTable, Input, Panel, type BadgeTone, type Column } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { OverrideFormModal } from './OverrideFormModal';
import { OverrideDetailPanel } from './OverrideDetailPanel';

const STATUS_TONE: Record<OverrideStatus, BadgeTone> = {
  PENDING_APPROVAL: 'warning',
  ACTIVE: 'success',
  REJECTED: 'danger',
  REVOKED: 'neutral',
  EXPIRED: 'neutral',
};

const STATUS_LABEL: Record<OverrideStatus, string> = {
  PENDING_APPROVAL: 'Pending approval',
  ACTIVE: 'Active',
  REJECTED: 'Rejected',
  REVOKED: 'Revoked',
  EXPIRED: 'Expired',
};

export function UserAccessOverrideListPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<OverrideStatus | 'ALL'>('ALL');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<UserAccessOverride | null>(null);

  const list = useQuery({
    queryKey: ['uao', 'list', statusFilter],
    queryFn: () =>
      api.uaoList({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        page_size: 200,
      }),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['uao'] });
  };

  const create = useMutation({
    mutationFn: api.uaoCreate,
    onSuccess: () => {
      setShowCreate(false);
      refresh();
    },
  });

  const filtered = useMemo(() => {
    const items = list.data?.items ?? [];
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (o) =>
        o.user_id.toLowerCase().includes(q) ||
        o.module_path.toLowerCase().includes(q) ||
        o.reason.toLowerCase().includes(q),
    );
  }, [list.data?.items, search]);

  const counts = useMemo(() => {
    const items = list.data?.items ?? [];
    return {
      all: items.length,
      pending: items.filter((o) => o.status === 'PENDING_APPROVAL').length,
      active: items.filter((o) => o.status === 'ACTIVE').length,
    };
  }, [list.data?.items]);

  const columns: Column<UserAccessOverride>[] = [
    {
      key: 'user',
      header: 'User',
      render: (o) => (
        <div className="flex flex-col">
          <span className="font-medium">{o.user_id}</span>
          <Link
            to={`/admin/user-access-override/users/${encodeURIComponent(o.user_id)}/effective-access`}
            className="text-2xs text-blue-600 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            View effective access →
          </Link>
        </div>
      ),
    },
    {
      key: 'module',
      header: 'Module',
      render: (o) => <span className="font-mono text-xs">{o.module_path}</span>,
    },
    {
      key: 'override',
      header: 'Override',
      render: (o) => (
        <div className="flex flex-col gap-1">
          <Badge tone={o.override_type === 'GRANT' ? 'success' : 'danger'} className="w-fit">
            {o.override_type}
          </Badge>
          <span className="text-2xs text-muted">{o.permission_type}</span>
        </div>
      ),
      width: 120,
    },
    {
      key: 'status',
      header: 'Status',
      render: (o) => (
        <Badge tone={STATUS_TONE[o.status]} className="uppercase tracking-wide">
          {STATUS_LABEL[o.status]}
        </Badge>
      ),
      width: 160,
    },
    {
      key: 'effective',
      header: 'Effective',
      render: (o) => (
        <div className="flex flex-col text-2xs">
          <span>{new Date(o.effective_from).toLocaleDateString()}</span>
          <span className="text-muted">→ {o.effective_till ? new Date(o.effective_till).toLocaleDateString() : 'permanent'}</span>
        </div>
      ),
      width: 130,
    },
    {
      key: 'maker_checker',
      header: 'Maker · Checker',
      render: (o) => (
        <div className="flex flex-col text-2xs">
          <span>maker: <span className="font-mono">{o.created_by}</span></span>
          <span>
            checker:{' '}
            <span className="font-mono">{o.approved_by ?? o.rejected_by ?? '—'}</span>
          </span>
        </div>
      ),
      width: 200,
    },
    {
      key: 'updated',
      header: 'Last modified',
      render: (o) => (
        <span className="text-2xs text-muted">{new Date(o.updated_at).toLocaleString()}</span>
      ),
      width: 160,
    },
  ];

  return (
    <div>
      <PageHeader
        title="User Access Override"
        subtitle="Per-user EWS access override · BAC §3.1.6 / §3.1.7 · maker-checker"
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <button
          type="button"
          className={`text-left rounded-md border px-3 py-2 ${
            statusFilter === 'ALL' ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'
          }`}
          onClick={() => setStatusFilter('ALL')}
        >
          <div className="text-2xs uppercase tracking-wide text-muted">All</div>
          <div className="text-2xl font-semibold">{counts.all}</div>
        </button>
        <button
          type="button"
          className={`text-left rounded-md border px-3 py-2 ${
            statusFilter === 'PENDING_APPROVAL' ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-white'
          }`}
          onClick={() => setStatusFilter('PENDING_APPROVAL')}
        >
          <div className="text-2xs uppercase tracking-wide text-muted">Pending approval</div>
          <div className="text-2xl font-semibold text-amber-700">{counts.pending}</div>
        </button>
        <button
          type="button"
          className={`text-left rounded-md border px-3 py-2 ${
            statusFilter === 'ACTIVE' ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 bg-white'
          }`}
          onClick={() => setStatusFilter('ACTIVE')}
        >
          <div className="text-2xs uppercase tracking-wide text-muted">Active</div>
          <div className="text-2xl font-semibold text-emerald-700">{counts.active}</div>
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <Input
          placeholder="Search by user, module path, or reason"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
          aria-label="search"
          data-testid="uao-search"
        />
        <div className="flex-1" />
        <Button onClick={() => setShowCreate(true)} data-testid="uao-add">
          <Plus className="w-4 h-4 mr-1" />
          Add access override
        </Button>
      </div>

      <Panel>
        <DataTable
          columns={columns as Column<UserAccessOverride & { id: string }>[]}
          data={filtered.map((o) => ({ ...o, id: o.override_id }))}
          onRowClick={(r) => setSelected(r)}
          empty={list.isLoading ? 'Loading…' : 'No overrides match the filters'}
        />
      </Panel>

      {showCreate && (
        <OverrideFormModal
          mode="create"
          onClose={() => setShowCreate(false)}
          onSubmit={(input) => create.mutate(input)}
          isPending={create.isPending}
          error={create.error}
        />
      )}

      {selected && (
        <OverrideDetailPanel
          override={selected}
          onClose={() => setSelected(null)}
          onChange={() => {
            setSelected(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// Tiny named-export icons used by the detail panel — re-exported here so
// tests can render mocks without importing lucide-react directly.
export { CheckCircle2, ShieldCheck, Trash2, XCircle };
