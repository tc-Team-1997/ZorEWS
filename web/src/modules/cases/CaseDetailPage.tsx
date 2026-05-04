import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type CaseActionKind,
  type CaseDetail,
  type CaseOutcome,
  type CaseState,
  type LogActionInput,
} from '@/lib/api';
import { HttpError } from '@/lib/http';
import { Badge, type BadgeTone, Button, Input, Panel, statusTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';

const STATE_TONE: Record<CaseState, BadgeTone> = {
  open: 'blue',
  assigned: 'warning',
  in_action: 'purple',
  monitored: 'success',
  closed: 'neutral',
};

const ACTION_KINDS: { value: CaseActionKind; label: string }[] = [
  { value: 'call', label: 'Call' },
  { value: 'visit', label: 'Field visit' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
  { value: 'note', label: 'Note' },
];

const OUTCOMES: { value: CaseOutcome; label: string }[] = [
  { value: 'cured', label: 'Cured' },
  { value: 'cured_temp', label: 'Cured (temp)' },
  { value: 'defaulted', label: 'Defaulted' },
];

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function CaseDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: caseDetail, isLoading, isError, error } = useQuery({
    queryKey: ['case', id],
    queryFn: () => api.case(id),
    enabled: Boolean(id),
  });

  const refresh = (next: CaseDetail) => {
    qc.setQueryData(['case', id], next);
    qc.invalidateQueries({ queryKey: ['cases'] });
  };

  useChatContext({
    page: 'case',
    entity: caseDetail
      ? {
          type: 'case',
          id: caseDetail.id,
          label: caseDetail.customer.name,
          facts: {
            state: caseDetail.state,
            severity: caseDetail.severity,
            action_count: caseDetail.actions?.length ?? 0,
            outcome: caseDetail.outcome ?? null,
          },
        }
      : undefined,
  });

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Case" subtitle="Loading…" />
      </div>
    );
  }
  if (isError || !caseDetail) {
    const message = error instanceof HttpError ? error.message : 'Case not found';
    return (
      <div>
        <PageHeader
          title="Case"
          subtitle={message}
          actions={
            <Link to="/cases">
              <Button variant="ghost" size="sm">
                ← All cases
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Case ${caseDetail.id}`}
        subtitle={caseDetail.reason_summary ?? caseDetail.rule.name}
        actions={
          <Link to="/cases">
            <Button variant="ghost" size="sm">
              ← All cases
            </Button>
          </Link>
        }
      />

      <CaseHeader caseDetail={caseDetail} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_22rem]">
        <ActionTimeline caseDetail={caseDetail} onUpdated={refresh} />
        <LifecycleControls caseDetail={caseDetail} onUpdated={refresh} />
      </div>
    </div>
  );
}

function CaseHeader({ caseDetail }: { caseDetail: CaseDetail }) {
  return (
    <Panel>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
        <Field label="State">
          <Badge tone={STATE_TONE[caseDetail.state]} className="uppercase tracking-wide">
            {caseDetail.state.replace('_', ' ')}
          </Badge>
        </Field>
        <Field label="Severity">
          <Badge tone={statusTone(caseDetail.severity)} className="uppercase tracking-wide">
            {caseDetail.severity}
          </Badge>
        </Field>
        <Field label="Assignee">
          {caseDetail.assignee ? (
            <Badge tone="neutral">{caseDetail.assignee}</Badge>
          ) : (
            <span className="text-2xs text-muted">unassigned</span>
          )}
        </Field>
        <Field label="Outcome">
          {caseDetail.outcome ? (
            <Badge tone={statusTone(caseDetail.outcome)} className="uppercase tracking-wide">
              {caseDetail.outcome.replace('_', ' ')}
            </Badge>
          ) : (
            <span className="text-2xs text-muted">—</span>
          )}
        </Field>

        <Field label="Customer">
          <Link to={`/customers/${caseDetail.customer.id}`} className="text-brand-blue hover:underline">
            {caseDetail.customer.name}
          </Link>
          <p className="text-2xs text-muted">{caseDetail.customer.id}</p>
        </Field>
        <Field label="Origin alert">
          <span className="font-mono text-xs text-ink-sub">{caseDetail.alert_id}</span>
        </Field>
        <Field label="Rule">
          <span className="text-sm text-ink-sub">{caseDetail.rule.name}</span>
          <p className="font-mono text-2xs text-muted">{caseDetail.rule.id}</p>
        </Field>
        <Field label="Loan">
          {caseDetail.loan_id ? (
            <span className="font-mono text-xs text-ink-sub">{caseDetail.loan_id}</span>
          ) : (
            <span className="text-2xs text-muted">—</span>
          )}
        </Field>

        <Field label="Created">
          <span className="text-xs text-ink-sub">{fmtTs(caseDetail.created_at)}</span>
        </Field>
        <Field label="Updated">
          <span className="text-xs text-ink-sub">{fmtTs(caseDetail.updated_at)}</span>
        </Field>
        <Field label="Closed">
          {caseDetail.closed_at ? (
            <span className="text-xs text-ink-sub">{fmtTs(caseDetail.closed_at)}</span>
          ) : (
            <span className="text-2xs text-muted">—</span>
          )}
        </Field>
      </dl>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label mb-1">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ActionTimeline({
  caseDetail,
  onUpdated,
}: {
  caseDetail: CaseDetail;
  onUpdated: (c: CaseDetail) => void;
}) {
  const closed = caseDetail.state === 'closed';
  const canLog = !closed && caseDetail.state !== 'open';

  return (
    <Panel
      title="Actions"
      action={
        canLog ? null : (
          <span className="text-2xs text-muted">
            {closed ? 'Case closed' : 'Assign first to log actions'}
          </span>
        )
      }
    >
      <ol aria-label="action timeline" className="space-y-3">
        {caseDetail.actions.length === 0 && (
          <li className="text-2xs text-muted">No actions logged yet.</li>
        )}
        {caseDetail.actions.map((a) => (
          <li key={a.action_id} className="flex gap-3">
            <Badge tone="purple" className="uppercase tracking-wide">
              {a.kind}
            </Badge>
            <div className="flex-1">
              <p className="text-sm text-ink">
                <span className="text-ink-sub">{a.officer_id}</span>
                <span className="ml-2 text-2xs text-muted">{fmtTs(a.ts)}</span>
              </p>
              {a.outcome_note && <p className="mt-1 text-xs text-ink-sub">{a.outcome_note}</p>}
              {a.gps && (
                <p className="mt-1 font-mono text-2xs text-muted">
                  GPS {a.gps.lat.toFixed(4)}, {a.gps.lng.toFixed(4)}
                  {a.gps.accuracy_m != null ? ` ±${a.gps.accuracy_m}m` : ''}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {canLog && (
        <div className="mt-5 border-t border-divider pt-4">
          <ActionForm caseId={caseDetail.id} onUpdated={onUpdated} />
        </div>
      )}
    </Panel>
  );
}

function ActionForm({
  caseId,
  onUpdated,
}: {
  caseId: string;
  onUpdated: (c: CaseDetail) => void;
}) {
  const [kind, setKind] = useState<CaseActionKind>('call');
  const [officerId, setOfficerId] = useState('');
  const [note, setNote] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: LogActionInput) => api.logAction(caseId, input),
    onSuccess: (next) => {
      onUpdated(next);
      setNote('');
      setGpsLat('');
      setGpsLng('');
      setError(null);
    },
    onError: (err) => setError(err instanceof HttpError ? err.message : 'Could not log action'),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!officerId.trim()) {
      setError('Officer id is required');
      return;
    }
    let gps: LogActionInput['gps'] = null;
    if (gpsLat || gpsLng) {
      const lat = Number(gpsLat);
      const lng = Number(gpsLng);
      if (Number.isNaN(lat) || Number.isNaN(lng)) {
        setError('GPS lat/lng must be numbers');
        return;
      }
      gps = { lat, lng, accuracy_m: null };
    }
    mutation.mutate({
      kind,
      officer_id: officerId.trim(),
      outcome_note: note.trim() || null,
      gps,
    });
  };

  return (
    <form aria-label="log action" onSubmit={onSubmit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block">
          <span className="label">Kind</span>
          <select
            aria-label="action kind"
            className="input"
            value={kind}
            onChange={(e) => setKind(e.target.value as CaseActionKind)}
          >
            {ACTION_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Officer id"
          name="officer_id"
          value={officerId}
          onChange={(e) => setOfficerId(e.target.value)}
          placeholder="e.g. fiona.field"
          required
        />
      </div>
      <Input
        label="Note"
        name="outcome_note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Outcome / next step"
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="GPS lat (optional)"
          name="gps_lat"
          inputMode="decimal"
          value={gpsLat}
          onChange={(e) => setGpsLat(e.target.value)}
        />
        <Input
          label="GPS lng (optional)"
          name="gps_lng"
          inputMode="decimal"
          value={gpsLng}
          onChange={(e) => setGpsLng(e.target.value)}
        />
      </div>
      {error && <p className="field-error">{error}</p>}
      <Button type="submit" loading={mutation.isPending} size="sm">
        Log action
      </Button>
    </form>
  );
}

function LifecycleControls({
  caseDetail,
  onUpdated,
}: {
  caseDetail: CaseDetail;
  onUpdated: (c: CaseDetail) => void;
}) {
  const [assignee, setAssignee] = useState('');
  const [outcome, setOutcome] = useState<CaseOutcome>('cured');
  const [closeNote, setCloseNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onError = (err: unknown) =>
    setError(err instanceof HttpError ? err.message : 'Action failed');

  const assignMut = useMutation({
    mutationFn: () => api.assignCase(caseDetail.id, assignee.trim()),
    onSuccess: (next) => {
      onUpdated(next);
      setAssignee('');
      setError(null);
    },
    onError,
  });

  const monitorMut = useMutation({
    mutationFn: () => api.monitorCase(caseDetail.id),
    onSuccess: (next) => {
      onUpdated(next);
      setError(null);
    },
    onError,
  });

  const closeMut = useMutation({
    mutationFn: () =>
      api.closeCase(caseDetail.id, { outcome, note: closeNote.trim() || null }),
    onSuccess: (next) => {
      onUpdated(next);
      setCloseNote('');
      setError(null);
    },
    onError,
  });

  const closed = caseDetail.state === 'closed';
  const canAssign = caseDetail.state === 'open';
  const canMonitor = caseDetail.state === 'in_action';

  return (
    <Panel title="Lifecycle">
      <div className="space-y-4">
        <div>
          <p className="label mb-2">Assign</p>
          <div className="flex gap-2">
            <Input
              name="assignee"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="user id (e.g. ravi.risk)"
              disabled={!canAssign}
              aria-label="assignee"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (!assignee.trim()) {
                  setError('User id is required');
                  return;
                }
                assignMut.mutate();
              }}
              disabled={!canAssign || assignMut.isPending}
              loading={assignMut.isPending}
            >
              Assign
            </Button>
          </div>
          {!canAssign && !closed && (
            <p className="mt-1 text-2xs text-muted">Already assigned.</p>
          )}
        </div>

        <div>
          <p className="label mb-2">Move to monitoring</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => monitorMut.mutate()}
            disabled={!canMonitor || monitorMut.isPending}
            loading={monitorMut.isPending}
          >
            Mark as monitored
          </Button>
          {!canMonitor && !closed && (
            <p className="mt-1 text-2xs text-muted">Available once an action has been logged.</p>
          )}
        </div>

        <div className="border-t border-divider pt-4">
          <p className="label mb-2">Close case</p>
          <label className="block">
            <span className="label">Outcome</span>
            <select
              aria-label="outcome"
              className="input"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as CaseOutcome)}
              disabled={closed}
            >
              {OUTCOMES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="Note (optional)"
            name="close_note"
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value)}
            disabled={closed}
            className="mt-2"
          />
          <Button
            size="sm"
            variant="danger"
            onClick={() => closeMut.mutate()}
            disabled={closed || closeMut.isPending}
            loading={closeMut.isPending}
            className="mt-3"
          >
            Close case
          </Button>
        </div>

        {error && <p className="field-error">{error}</p>}
      </div>
    </Panel>
  );
}
