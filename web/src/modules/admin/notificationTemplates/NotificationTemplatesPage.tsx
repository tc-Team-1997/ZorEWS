import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, Mail, MessageSquare, Pencil, Plus, Send, Smartphone, Trash2 } from 'lucide-react';
import {
  api,
  type NotificationChannel,
  type NotificationTemplateRow,
  type NotificationTemplateStatus,
} from '@/lib/api';
import {
  Badge,
  Button,
  DataTable,
  Input,
  type BadgeTone,
  type Column,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { NotificationTemplateFormModal } from './NotificationTemplateFormModal';
import { NotificationTemplatePreviewModal } from './NotificationTemplatePreviewModal';
import { NotificationTemplateTestFireModal } from './NotificationTemplateTestFireModal';

const STATUS_TONE: Record<NotificationTemplateStatus, BadgeTone> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  ARCHIVED: 'neutral',
};

const CHANNEL_ICON: Record<NotificationChannel, typeof Mail> = {
  EMAIL: Mail,
  SMS: Smartphone,
  IN_APP: MessageSquare,
};

const CHANNEL_TONE: Record<NotificationChannel, BadgeTone> = {
  EMAIL: 'blue',
  SMS: 'warning',
  IN_APP: 'neutral',
};

type StatusFilter = NotificationTemplateStatus | 'ALL';
type ChannelFilter = NotificationChannel | 'ALL';

export function NotificationTemplatesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('ALL');
  const [editing, setEditing] = useState<NotificationTemplateRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<NotificationTemplateRow | null>(null);
  const [testFiring, setTestFiring] = useState<NotificationTemplateRow | null>(null);

  const list = useQuery({
    queryKey: ['notification-templates', statusFilter, channelFilter],
    queryFn: () =>
      api.notificationTemplatesList({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        channel: channelFilter === 'ALL' ? undefined : channelFilter,
        include_deleted: statusFilter === 'ARCHIVED' || statusFilter === 'ALL',
        page_size: 200,
      }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['notification-templates'] });

  const create = useMutation({
    mutationFn: api.notificationTemplateCreate,
    onSuccess: () => {
      setCreating(false);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof api.notificationTemplateUpdate>[1] }) =>
      api.notificationTemplateUpdate(input.id, input.patch),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const activate = useMutation({
    mutationFn: api.notificationTemplateActivate,
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: api.notificationTemplateArchive,
    onSuccess: refresh,
  });

  const filtered = useMemo(() => {
    const items = list.data?.items ?? [];
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.subject ?? '').toLowerCase().includes(q) ||
        r.body.toLowerCase().includes(q),
    );
  }, [list.data?.items, search]);

  const counts = useMemo(() => {
    const items = list.data?.items ?? [];
    return {
      all: items.length,
      draft: items.filter((r) => r.status === 'DRAFT').length,
      active: items.filter((r) => r.status === 'ACTIVE').length,
      archived: items.filter((r) => r.status === 'ARCHIVED').length,
    };
  }, [list.data?.items]);

  const columns: Column<NotificationTemplateRow & { id: string }>[] = [
    {
      key: 'channel',
      header: 'Channel',
      render: (r) => {
        const Icon = CHANNEL_ICON[r.channel];
        return (
          <Badge tone={CHANNEL_TONE[r.channel]} className="text-2xs uppercase tracking-wide">
            <Icon className="mr-1 inline h-3 w-3" /> {r.channel}
          </Badge>
        );
      },
      width: 120,
    },
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium">{r.name}</span>
          <span className="text-2xs text-muted">
            <span className="font-mono">{r.locale}</span>
            {r.subject && <span> · {truncate(r.subject, 60)}</span>}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge tone={STATUS_TONE[r.status]} className="uppercase tracking-wide text-2xs">
          {r.status.toLowerCase()}
        </Badge>
      ),
      width: 110,
    },
    {
      key: 'updated',
      header: 'Updated',
      render: (r) => (
        <div className="flex flex-col text-2xs">
          <span>{new Date(r.updated_at).toLocaleDateString()}</span>
          <span className="text-muted">{r.updated_by ?? r.created_by}</span>
        </div>
      ),
      width: 130,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          {r.deleted_at === null && (
            <button
              type="button"
              onClick={() => setPreviewing(r)}
              className="text-2xs text-slate-700 hover:underline inline-flex items-center gap-1"
              data-testid={`tpl-preview-${r.template_id}`}
            >
              <Eye className="w-3 h-3" /> Preview
            </button>
          )}
          {r.deleted_at === null && r.status !== 'ARCHIVED' && (
            <>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => setTestFiring(r)}
                className="text-2xs text-violet-700 hover:underline inline-flex items-center gap-1"
                data-testid={`tpl-testfire-${r.template_id}`}
              >
                <Send className="w-3 h-3" /> Test fire
              </button>
            </>
          )}
          {r.deleted_at === null && (
            <>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => setEditing(r)}
                className="text-2xs text-blue-600 hover:underline inline-flex items-center gap-1"
                data-testid={`tpl-edit-${r.template_id}`}
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
            </>
          )}
          {r.status === 'DRAFT' && (
            <>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => activate.mutate(r.template_id)}
                className="text-2xs text-emerald-700 hover:underline inline-flex items-center gap-1"
                disabled={activate.isPending}
                data-testid={`tpl-activate-${r.template_id}`}
              >
                <CheckCircle2 className="w-3 h-3" /> Activate
              </button>
            </>
          )}
          {r.deleted_at === null && (
            <>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => archive.mutate(r.template_id)}
                className="text-2xs text-rose-600 hover:underline inline-flex items-center gap-1"
                disabled={archive.isPending}
                data-testid={`tpl-archive-${r.template_id}`}
              >
                <Trash2 className="w-3 h-3" /> Archive
              </button>
            </>
          )}
        </div>
      ),
      width: 360,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Notification Templates"
        subtitle="EMAIL · SMS · IN_APP templates referenced by case scenarios + escalation flows"
        actions={
          <Button onClick={() => setCreating(true)} data-testid="tpl-new">
            <Plus className="w-4 h-4 mr-1" /> New template
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
        {(['ALL', 'DRAFT', 'ACTIVE', 'ARCHIVED'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`text-left rounded-md border px-3 py-2 ${
              statusFilter === s ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'
            }`}
            onClick={() => setStatusFilter(s)}
            data-testid={`tpl-pivot-${s.toLowerCase()}`}
          >
            <div className="text-2xs uppercase tracking-wide text-muted">
              {s === 'ALL' ? 'All' : s.toLowerCase()}
            </div>
            <div className="text-2xl font-semibold">
              {s === 'ALL'
                ? counts.all
                : s === 'DRAFT'
                  ? counts.draft
                  : s === 'ACTIVE'
                    ? counts.active
                    : counts.archived}
            </div>
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name / subject / body…"
          className="w-72"
          data-testid="tpl-search"
        />
        <div className="flex gap-1">
          {(['ALL', 'EMAIL', 'SMS', 'IN_APP'] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannelFilter(c)}
              className={`rounded border px-2 py-1 text-2xs uppercase tracking-wide ${
                channelFilter === c
                  ? 'border-blue-400 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600'
              }`}
              data-testid={`tpl-channel-filter-${c.toLowerCase()}`}
            >
              {c === 'ALL' ? 'all channels' : c.toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading ? (
        <p className="py-6 text-center text-sm text-muted">Loading templates…</p>
      ) : list.isError ? (
        <p className="py-6 text-center text-sm text-rose-700" role="alert">
          Failed to load templates: {(list.error as Error)?.message}
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted" data-testid="tpl-empty">
          No templates match the current filters.
        </p>
      ) : (
        <DataTable
          columns={columns}
          data={filtered.map((r) => ({ ...r, id: r.template_id }))}
        />
      )}

      {creating && (
        <NotificationTemplateFormModal
          mode="create"
          existing={list.data?.items ?? []}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
          isPending={create.isPending}
          error={create.error}
        />
      )}
      {editing && (
        <NotificationTemplateFormModal
          mode="edit"
          row={editing}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => update.mutate({ id: editing.template_id, patch })}
          isPending={update.isPending}
          error={update.error}
        />
      )}
      {previewing && (
        <NotificationTemplatePreviewModal
          template={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}
      {testFiring && (
        <NotificationTemplateTestFireModal
          template={testFiring}
          onClose={() => setTestFiring(null)}
          onSent={() =>
            queryClient.invalidateQueries({ queryKey: ['notification-dispatches'] })
          }
        />
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
