import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Copy, Key, Trash2 } from 'lucide-react';
import {
  useAuth,
  type ServiceClientCreated,
  type ServiceClientRow,
} from '@/store/auth';
import { Badge, Button, DialogFooter, EnterpriseDialog, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';

/**
 * Service-clients admin page (T4.24 Phase 12).
 *
 * Manages OAuth client_credentials principals stored in
 * app_iam.service_clients (auth-svc). Mirrors the WebhooksPage pattern:
 * the plaintext client_secret is shown ONCE on creation; subsequent
 * reads strip it.
 */
export function AdminServiceClientsPage() {
  const queryClient = useQueryClient();
  const adminListServiceClients = useAuth((s) => s.adminListServiceClients);
  const adminCreateServiceClient = useAuth((s) => s.adminCreateServiceClient);
  const adminDeleteServiceClient = useAuth((s) => s.adminDeleteServiceClient);
  useChatContext({ page: 'unknown' });

  const list = useQuery({
    queryKey: ['service-clients'],
    queryFn: () => adminListServiceClients(),
  });
  const [secretReveal, setSecretReveal] = useState<ServiceClientCreated | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['service-clients'] });

  const create = useMutation({
    mutationFn: (input: {
      tenant_id: string;
      client_id: string;
      display_name: string;
    }) => adminCreateServiceClient(input),
    onSuccess: (created) => {
      setSecretReveal(created);
      void refresh();
    },
  });

  const remove = useMutation({
    mutationFn: ({ tenant_id, client_id }: { tenant_id: string; client_id: string }) =>
      adminDeleteServiceClient(tenant_id, client_id),
    onSuccess: () => refresh(),
  });

  return (
    <div>
      <PageHeader
        title="Service clients"
        subtitle="OAuth client_credentials principals · admin only"
      />

      <CreateForm
        onSubmit={(input) => create.mutate(input)}
        isPending={create.isPending}
        error={create.error}
      />

      {secretReveal && (
        <SecretRevealDialog
          client={secretReveal}
          onClose={() => setSecretReveal(null)}
        />
      )}

      <Panel
        title="Configured clients"
        className="mt-4"
        action={
          <span className="text-2xs text-muted">
            {list.data ? `${list.data.length} total` : 'loading…'}
          </span>
        }
      >
        {list.isLoading && <p className="caption">Loading…</p>}
        {list.isError && (
          <p role="alert" className="text-[12px] text-danger">
            {(list.error as Error)?.message ?? 'Failed to load service clients.'}
          </p>
        )}
        {list.data && list.data.length === 0 && (
          <p className="caption">No service clients yet — create one above.</p>
        )}
        {list.data && list.data.length > 0 && (
          <ul className="divide-y divide-divider" data-testid="service-client-list">
            {list.data.map((c) => (
              <ClientRow
                key={`${c.tenant_id}:${c.client_id}`}
                client={c}
                onDelete={() => {
                  if (
                    window.confirm(
                      `Delete service client "${c.client_id}" for tenant "${c.tenant_id}"?`,
                    )
                  ) {
                    remove.mutate({ tenant_id: c.tenant_id, client_id: c.client_id });
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

function CreateForm({
  onSubmit,
  isPending,
  error,
}: {
  onSubmit: (input: { tenant_id: string; client_id: string; display_name: string }) => void;
  isPending: boolean;
  error: unknown;
}) {
  const [tenantId, setTenantId] = useState('BANK_DEMO');
  const [clientId, setClientId] = useState('');
  const [displayName, setDisplayName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId.trim() || !clientId.trim() || !displayName.trim()) return;
    onSubmit({
      tenant_id: tenantId.trim(),
      client_id: clientId.trim(),
      display_name: displayName.trim(),
    });
    setClientId('');
    setDisplayName('');
  };

  const errorMsg =
    error && typeof error === 'object' && 'message' in error
      ? String((error as Error).message)
      : null;

  return (
    <Panel title="New service client" action={<Key size={14} className="text-muted" />}>
      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="Tenant ID"
            placeholder="BANK_DEMO"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value.toUpperCase())}
            required
            data-testid="service-client-create-tenant"
          />
          <Input
            label="Client ID"
            placeholder="acme-mobile"
            value={clientId}
            onChange={(e) => setClientId(e.target.value.toLowerCase())}
            pattern="[a-z0-9][a-z0-9._-]{2,63}"
            required
            data-testid="service-client-create-id"
          />
          <Input
            label="Display name"
            placeholder="ACME Mobile App"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            data-testid="service-client-create-name"
          />
        </div>
        {errorMsg && (
          <p role="alert" className="text-[12px] text-danger">
            {errorMsg}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            loading={isPending}
            disabled={!tenantId.trim() || !clientId.trim() || !displayName.trim()}
            data-testid="service-client-create-submit"
          >
            Create client
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function SecretRevealDialog({
  client,
  onClose,
}: {
  client: ServiceClientCreated;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(client.client_secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title="Copy your client secret now"
      description="The plaintext secret will not be shown again. Store it in your secrets manager."
      size="md"
      closeOnBackdrop={false}
      closeOnEsc={false}
      testId="service-client-secret-dialog"
      footer={
        <DialogFooter
          secondary={
            <Button variant="secondary" onClick={onCopy} data-testid="service-client-secret-copy">
              <Copy size={14} className="mr-1" /> {copied ? 'Copied' : 'Copy'}
            </Button>
          }
          primary={
            <Button onClick={onClose} data-testid="service-client-secret-close">
              I&apos;ve stored it
            </Button>
          }
        />
      }
    >
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-full bg-warning-bg flex items-center justify-center shrink-0">
          <AlertCircle size={18} className="text-warning" strokeWidth={2} />
        </div>
        <p className="text-[13px] text-sub min-w-0">
          The API call to <code className="font-mono">/oauth/token</code> needs this secret.
          Store it before closing — it cannot be retrieved later.
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-[12px] mb-3">
        <dt className="text-muted">tenant_id</dt>
        <dd className="col-span-2 font-mono text-ink">{client.tenant_id}</dd>
        <dt className="text-muted">client_id</dt>
        <dd className="col-span-2 font-mono text-ink">{client.client_id}</dd>
      </dl>
      <div
        className="rounded border border-divider bg-page p-3 font-mono text-[11px] break-all text-ink"
        data-testid="service-client-secret-value"
      >
        {client.client_secret}
      </div>
    </EnterpriseDialog>
  );
}

function ClientRow({
  client,
  onDelete,
}: {
  client: ServiceClientRow;
  onDelete: () => void;
}) {
  const lastUsed = client.last_used_at
    ? new Date(client.last_used_at).toLocaleString()
    : 'never';
  return (
    <li className="py-3" data-testid={`service-client-row-${client.tenant_id}-${client.client_id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-ink font-medium text-[13px] font-mono">{client.client_id}</p>
            <Badge tone="neutral">{client.tenant_id}</Badge>
            {!client.active && <Badge tone="warning">inactive</Badge>}
          </div>
          <p className="text-[13px] text-ink-sub mt-0.5">{client.display_name}</p>
          <p className="text-2xs text-muted mt-0.5">
            scopes: <span className="font-mono">{client.scopes.length === 0 ? 'default' : client.scopes.join(', ')}</span>
            {' · '}last used: {lastUsed}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete service client ${client.client_id}`}
            data-testid={`service-client-delete-${client.tenant_id}-${client.client_id}`}
            className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger-bg/50 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}
