import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Send,
  Trash2,
  Webhook,
  XCircle,
} from 'lucide-react';
import {
  api,
  type WebhookDelivery,
  type WebhookEventType,
  type WebhookSubscriptionCreated,
  type WebhookSubscriptionView,
} from '@/lib/api';
import { Badge, type BadgeTone, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';

const ALL_EVENTS: ReadonlyArray<{ value: WebhookEventType; description: string }> = [
  { value: 'alert.created', description: 'Fires when /v1/ews/evaluate returns a High-risk score.' },
  { value: 'alert.updated', description: 'Reserved — case lifecycle events that update an alert.' },
  { value: 'case.assigned', description: 'Reserved — fires when a case is assigned to an officer.' },
  { value: 'case.closed', description: 'Reserved — fires when a case is closed (with outcome).' },
  { value: 'scenario.run', description: 'Fires after every /v1/scenario/run with the headline numbers.' },
  { value: 'webhook.test', description: 'Synthetic event — only fired by the "Test" button below.' },
];

const STATUS_TONE: Record<NonNullable<WebhookSubscriptionView['last_delivery_status']>, BadgeTone> =
  {
    success: 'success',
    failed: 'danger',
  };

export function WebhooksPage() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['webhooks'], queryFn: api.webhookList });
  const [secretReveal, setSecretReveal] = useState<WebhookSubscriptionCreated | null>(null);
  useChatContext({ page: 'unknown' });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['webhooks'] });

  const create = useMutation({
    mutationFn: api.webhookCreate,
    onSuccess: (sub) => {
      // Show the secret once — admin must copy it before closing the dialog.
      setSecretReveal(sub);
      void refresh();
    },
  });

  const remove = useMutation({
    mutationFn: api.webhookDelete,
    onSuccess: () => refresh(),
  });

  return (
    <div>
      <PageHeader
        title="Webhooks"
        subtitle="Push APEX events (alerts, scenarios) to external systems · admin only"
      />

      <CreateForm
        onSubmit={(input) => create.mutate(input)}
        isPending={create.isPending}
        error={create.error}
      />

      {secretReveal && (
        <SecretRevealDialog
          subscription={secretReveal}
          onClose={() => setSecretReveal(null)}
        />
      )}

      <Panel title="Subscriptions" className="mt-4" action={
        <span className="text-2xs text-muted">
          {list.data ? `${list.data.items.length} active` : 'loading…'}
        </span>
      }>
        {list.isLoading && <p className="caption">Loading…</p>}
        {list.isError && (
          <p role="alert" className="text-[12px] text-danger">
            {(list.error as Error)?.message ?? 'Failed to load subscriptions.'}
          </p>
        )}
        {list.data && list.data.items.length === 0 && (
          <p className="caption">
            No webhook subscriptions yet. Create one above to start delivering APEX events to an
            external system.
          </p>
        )}
        {list.data && list.data.items.length > 0 && (
          <ul className="divide-y divide-divider" data-testid="webhook-list">
            {list.data.items.map((sub) => (
              <SubscriptionRow
                key={sub.id}
                subscription={sub}
                onDelete={() => {
                  if (window.confirm(`Delete webhook subscription "${sub.name}"?`)) {
                    remove.mutate(sub.id);
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
  onSubmit: (input: { name: string; url: string; events: WebhookEventType[] }) => void;
  isPending: boolean;
  error: unknown;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<Set<WebhookEventType>>(new Set(['alert.created']));

  const toggleEvent = (e: WebhookEventType) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim() || selected.size === 0) return;
    onSubmit({ name: name.trim(), url: url.trim(), events: Array.from(selected) });
    setName('');
    setUrl('');
    setSelected(new Set(['alert.created']));
  };

  const errorMsg =
    error && typeof error === 'object' && 'message' in error
      ? String((error as Error).message)
      : null;

  return (
    <Panel title="New subscription" action={<Webhook size={14} className="text-muted" />}>
      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input
            label="Name"
            placeholder="AML hub"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            data-testid="webhook-create-name"
          />
          <Input
            label="URL"
            placeholder="https://aml.example.com/apex/events"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            required
            data-testid="webhook-create-url"
          />
        </div>
        <fieldset>
          <legend className="text-xs text-ink-sub mb-2">Events to subscribe</legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {ALL_EVENTS.map(({ value, description }) => (
              <label
                key={value}
                className="flex items-start gap-2 cursor-pointer rounded border border-divider p-2 hover:border-brand-blue/40"
              >
                <input
                  type="checkbox"
                  checked={selected.has(value)}
                  onChange={() => toggleEvent(value)}
                  className="mt-0.5 accent-brand-blue"
                  data-testid={`webhook-event-${value}`}
                />
                <div className="min-w-0">
                  <div className="text-[13px] font-mono text-ink">{value}</div>
                  <div className="text-2xs text-muted">{description}</div>
                </div>
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
            disabled={!name.trim() || !url.trim() || selected.size === 0}
            data-testid="webhook-create-submit"
          >
            Create subscription
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function SecretRevealDialog({
  subscription,
  onClose,
}: {
  subscription: WebhookSubscriptionCreated;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(subscription.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback path — execCommand is deprecated but works in test envs
      // where Clipboard API isn't available.
      setCopied(false);
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="webhook-secret-title"
      data-testid="webhook-secret-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-6"
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-warning-bg flex items-center justify-center shrink-0">
            <AlertCircle size={18} className="text-warning" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h2 id="webhook-secret-title" className="text-base font-semibold text-ink leading-snug">
              Copy your signing secret now
            </h2>
            <p className="text-[13px] text-sub mt-1">
              This is the only time the secret will be shown. Store it in your secrets manager —
              you can&apos;t retrieve it later.
            </p>
          </div>
        </div>
        <div className="rounded border border-divider bg-page p-3 font-mono text-[11px] break-all text-ink mb-3" data-testid="webhook-secret-value">
          {subscription.secret}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCopy} data-testid="webhook-secret-copy">
            <Copy size={14} className="mr-1" /> {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={onClose} data-testid="webhook-secret-close">
            I&apos;ve stored it
          </Button>
        </div>
      </div>
    </div>
  );
}

function SubscriptionRow({
  subscription,
  onDelete,
}: {
  subscription: WebhookSubscriptionView;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const deliveriesQ = useQuery({
    queryKey: ['webhook.deliveries', subscription.id],
    queryFn: () => api.webhookDeliveries(subscription.id),
    enabled: expanded,
  });

  const testFire = useMutation({
    mutationFn: () => api.webhookTestFire(subscription.id),
    onSuccess: () => {
      // Refresh both the subscription's deliveries log and the parent
      // list (so last_delivery_at + last_delivery_status update).
      void queryClient.invalidateQueries({ queryKey: ['webhook.deliveries', subscription.id] });
      void queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });

  const lastStatus = subscription.last_delivery_status;
  const lastAt = subscription.last_delivery_at
    ? new Date(subscription.last_delivery_at).toLocaleString()
    : 'never delivered';

  return (
    <li className="py-3" data-testid={`webhook-row-${subscription.id}`}>
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-start gap-2 text-left flex-1 min-w-0 hover:bg-divider/30 rounded px-2 py-1 -mx-2"
          aria-expanded={expanded}
          data-testid={`webhook-row-toggle-${subscription.id}`}
        >
          {expanded ? (
            <ChevronDown size={14} className="mt-1 text-muted shrink-0" />
          ) : (
            <ChevronRight size={14} className="mt-1 text-muted shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-ink font-medium text-[13px]">{subscription.name}</p>
              {lastStatus && (
                <Badge tone={STATUS_TONE[lastStatus]} className="uppercase tracking-wide">
                  last: {lastStatus}
                </Badge>
              )}
            </div>
            <p className="text-2xs text-muted font-mono mt-0.5 truncate">{subscription.url}</p>
            <p className="text-2xs text-muted mt-0.5">
              {subscription.events.join(', ')} · {lastAt}
            </p>
          </div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            onClick={() => testFire.mutate()}
            loading={testFire.isPending}
            data-testid={`webhook-test-${subscription.id}`}
          >
            <Send size={14} className="mr-1" /> Test
          </Button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete webhook subscription: ${subscription.name}`}
            data-testid={`webhook-delete-${subscription.id}`}
            className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger-bg/50 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 ml-6 pl-3 border-l border-divider">
          <p className="text-2xs text-muted mb-2">Recent deliveries (newest first, max 50)</p>
          {deliveriesQ.isLoading && <p className="caption">Loading…</p>}
          {deliveriesQ.data && deliveriesQ.data.items.length === 0 && (
            <p className="caption">No deliveries yet — click Test to send a webhook.test event.</p>
          )}
          {deliveriesQ.data && deliveriesQ.data.items.length > 0 && (
            <ul className="space-y-1.5" data-testid={`webhook-deliveries-${subscription.id}`}>
              {deliveriesQ.data.items.map((d) => (
                <DeliveryRow key={d.id} delivery={d} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function DeliveryRow({ delivery }: { delivery: WebhookDelivery }) {
  const ok = delivery.status === 'success';
  const ts = useMemo(() => new Date(delivery.completed_at).toLocaleTimeString(), [delivery.completed_at]);
  return (
    <li className="flex items-start gap-2 text-[12px]" data-testid={`webhook-delivery-${delivery.id}`}>
      {ok ? (
        <CheckCircle2 size={12} className="text-success shrink-0 mt-0.5" />
      ) : (
        <XCircle size={12} className="text-danger shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <span className="font-mono text-2xs text-muted">{ts}</span>{' '}
        <span className="font-mono text-ink">{delivery.event_type}</span>
        <span className="text-2xs text-muted">
          {' '}
          · HTTP {delivery.response_status} · {delivery.attempts} attempt
          {delivery.attempts === 1 ? '' : 's'}
        </span>
      </div>
    </li>
  );
}
