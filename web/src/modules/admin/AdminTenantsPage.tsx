import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Lock, Trash2 } from 'lucide-react';
import { api, type Tenant, type TenantCreateInput, type TenantVertical } from '@/lib/api';
import { Badge, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';

/**
 * Tenants admin page (T4.24 Phase 12).
 *
 * Lists every configured tenant + lets admins create / delete. PATCH UI
 * (rename, channel changes) deliberately omitted for v1 — that's
 * post-prototype polish; the BFF endpoint exists and CLI/curl callers
 * can still use it.
 *
 * BANK_DEMO is system-protected and the delete button is hidden for it.
 */
const VERTICALS: ReadonlyArray<TenantVertical> = ['banking', 'insurance'];
const COMMON_CHANNELS = ['LOS', 'MOBILE', 'BRANCH', 'API', 'AGENT_PORTAL'] as const;

export function AdminTenantsPage() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['tenants'], queryFn: api.tenantList });
  useChatContext({ page: 'unknown' });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tenants'] });

  const create = useMutation({
    mutationFn: api.tenantCreate,
    onSuccess: () => refresh(),
  });

  const remove = useMutation({
    mutationFn: api.tenantDelete,
    onSuccess: () => refresh(),
  });

  return (
    <div>
      <PageHeader
        title="Tenants"
        subtitle="Multi-tenant registry — admin only"
      />

      <CreateTenantForm
        onSubmit={(input) => create.mutate(input)}
        isPending={create.isPending}
        error={create.error}
      />

      <Panel
        title="Configured tenants"
        className="mt-4"
        action={
          <span className="text-2xs text-muted">
            {list.data ? `${list.data.total} total` : 'loading…'}
          </span>
        }
      >
        {list.isLoading && <p className="caption">Loading…</p>}
        {list.isError && (
          <p role="alert" className="text-[12px] text-danger">
            {(list.error as Error)?.message ?? 'Failed to load tenants.'}
          </p>
        )}
        {list.data && list.data.items.length === 0 && (
          <p className="caption">No tenants yet — create one above.</p>
        )}
        {list.data && list.data.items.length > 0 && (
          <ul className="divide-y divide-divider" data-testid="tenant-list">
            {list.data.items.map((tenant) => (
              <TenantRow
                key={tenant.tenant_id}
                tenant={tenant}
                onDelete={() => {
                  if (
                    window.confirm(
                      `Delete tenant "${tenant.tenant_id}"? This cannot be undone.`,
                    )
                  ) {
                    remove.mutate(tenant.tenant_id, {
                      onError: (e: unknown) => {
                        const msg = e instanceof Error ? e.message : 'delete failed';
                        window.alert(msg);
                      },
                    });
                  }
                }}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function CreateTenantForm({
  onSubmit,
  isPending,
  error,
}: {
  onSubmit: (input: TenantCreateInput) => void;
  isPending: boolean;
  error: unknown;
}) {
  const [tenantId, setTenantId] = useState('');
  const [name, setName] = useState('');
  const [vertical, setVertical] = useState<TenantVertical>('banking');
  const [channels, setChannels] = useState<Set<string>>(new Set(['API']));

  const toggleChannel = (c: string) => {
    setChannels((s) => {
      const next = new Set(s);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId.trim() || !name.trim() || channels.size === 0) return;
    onSubmit({
      tenant_id: tenantId.trim(),
      name: name.trim(),
      vertical,
      channels_allowed: Array.from(channels),
    });
    setTenantId('');
    setName('');
    setVertical('banking');
    setChannels(new Set(['API']));
  };

  const errorMsg =
    error && typeof error === 'object' && 'message' in error
      ? String((error as Error).message)
      : null;

  return (
    <Panel title="New tenant" action={<Building2 size={14} className="text-muted" />}>
      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input
            label="Tenant ID"
            placeholder="ACME_BANK"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value.toUpperCase())}
            pattern="[A-Z][A-Z0-9_]{1,31}"
            required
            data-testid="tenant-create-id"
          />
          <Input
            label="Display name"
            placeholder="ACME Bank Ltd"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            data-testid="tenant-create-name"
          />
        </div>
        <div>
          <label className="field-label">Vertical</label>
          <div className="flex gap-2">
            {VERTICALS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVertical(v)}
                aria-pressed={vertical === v}
                data-testid={`tenant-create-vertical-${v}`}
                className={
                  vertical === v
                    ? 'btn-secondary'
                    : 'btn-ghost'
                }
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <fieldset>
          <legend className="text-xs text-ink-sub mb-2">Channels allowed</legend>
          <div className="flex flex-wrap gap-2">
            {COMMON_CHANNELS.map((c) => (
              <label
                key={c}
                className="flex items-center gap-2 cursor-pointer rounded border border-divider px-3 py-1.5 text-[12px] hover:border-brand-blue/40"
              >
                <input
                  type="checkbox"
                  checked={channels.has(c)}
                  onChange={() => toggleChannel(c)}
                  className="accent-brand-blue"
                  data-testid={`tenant-create-channel-${c}`}
                />
                <span className="font-mono">{c}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {errorMsg && (
          <p role="alert" className="text-[12px] text-danger">
            {errorMsg}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            loading={isPending}
            disabled={!tenantId.trim() || !name.trim() || channels.size === 0}
            data-testid="tenant-create-submit"
          >
            Create tenant
          </Button>
        </div>
      </form>
    </Panel>
  );
}

const SYSTEM_TENANTS = new Set(['BANK_DEMO']);

function TenantRow({
  tenant,
  onDelete,
}: {
  tenant: Tenant;
  onDelete: () => void;
}) {
  const isSystem = SYSTEM_TENANTS.has(tenant.tenant_id);
  return (
    <li className="py-3" data-testid={`tenant-row-${tenant.tenant_id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-ink font-medium text-[13px] font-mono">{tenant.tenant_id}</p>
            <Badge tone={tenant.vertical === 'insurance' ? 'purple' : 'neutral'}>
              {tenant.vertical}
            </Badge>
            {!tenant.active && <Badge tone="warning">inactive</Badge>}
            {isSystem && (
              <Badge tone="neutral" className="uppercase tracking-wide">
                <Lock size={10} className="inline mr-1 -mt-0.5" />
                system
              </Badge>
            )}
          </div>
          <p className="text-[13px] text-ink-sub mt-0.5">{tenant.name}</p>
          <p className="text-2xs text-muted mt-0.5">
            channels: <span className="font-mono">{tenant.channels_allowed.join(', ')}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isSystem && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete tenant ${tenant.tenant_id}`}
              data-testid={`tenant-delete-${tenant.tenant_id}`}
              className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger-bg/50 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
