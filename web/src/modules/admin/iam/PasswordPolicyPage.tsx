// web/src/modules/admin/iam/PasswordPolicyPage.tsx
//
// IAM Center → Password Policy (Feature 2 / governance surface).
//
// Per-tenant password policy editor (admin-only). Reuses the new
// IPasswordGovernanceStore. Lists currently-expiring users alongside
// so admins can preview the reminder window's blast radius.

import { Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Save } from 'lucide-react';
import { Badge, Button, Input, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, type PasswordPolicy } from '@/lib/api';

export function PasswordPolicyPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<PasswordPolicy>>({});

  if (me && !me.roles.some((r) => r === 'admin')) {
    return <Navigate to="/" replace />;
  }

  const policyQ = useQuery({ queryKey: ['iam.password-policy'], queryFn: () => api.iamPasswordPolicy() });
  const expiringQ = useQuery({ queryKey: ['iam.password-expiring'], queryFn: () => api.iamPasswordExpiring() });

  useEffect(() => {
    if (policyQ.data) setDraft({});
  }, [policyQ.data]);

  const saveMut = useMutation({
    mutationFn: (patch: Partial<PasswordPolicy>) => api.iamPasswordPolicyUpdate(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['iam.password-policy'] });
      qc.invalidateQueries({ queryKey: ['iam.password-expiring'] });
      setDraft({});
    },
  });

  const current = policyQ.data;
  const effective = { ...(current ?? {}), ...draft };
  const dirty = Object.keys(draft).length > 0;

  return (
    <div data-testid="password-policy-page">
      <PageHeader
        title="Password Policy"
        subtitle="Per-tenant password complexity + expiry + lockout rules. Reuses IPasswordGovernanceStore."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4" data-testid="password-policy-kpis">
        <MetricCard label="Min length" value={String(effective.min_len ?? 12)} testId="password-policy-kpi-min-len" />
        <MetricCard label="Expiry days" value={String(effective.expiry_days ?? 90)} testId="password-policy-kpi-expiry" />
        <MetricCard
          label="Expiring soon"
          value={String(expiringQ.data?.users.length ?? 0)}
          tone={(expiringQ.data?.users.length ?? 0) > 0 ? 'warning' : 'neutral'}
          testId="password-policy-kpi-expiring"
        />
        <MetricCard label="Lockout threshold" value={String(effective.lockout_threshold ?? 5)} testId="password-policy-kpi-lockout" />
      </div>

      <Panel className="mb-4" title="Policy editor">
        {policyQ.isLoading ? (
          <p className="text-sm text-muted">Loading policy…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]" data-testid="password-policy-form">
            <NumberField label="min_len (8..128)" value={effective.min_len ?? 12} onChange={(v) => setDraft({ ...draft, min_len: v })} testId="password-policy-min-len" />
            <NumberField label="expiry_days (0..730)" value={effective.expiry_days ?? 90} onChange={(v) => setDraft({ ...draft, expiry_days: v })} testId="password-policy-expiry-days" />
            <NumberField label="history_count (0..50)" value={effective.history_count ?? 5} onChange={(v) => setDraft({ ...draft, history_count: v })} testId="password-policy-history" />
            <NumberField label="lockout_threshold (3..20)" value={effective.lockout_threshold ?? 5} onChange={(v) => setDraft({ ...draft, lockout_threshold: v })} testId="password-policy-lockout" />
            <NumberField label="lockout_window_min (1..1440)" value={effective.lockout_window_min ?? 15} onChange={(v) => setDraft({ ...draft, lockout_window_min: v })} testId="password-policy-window" />
            <NumberField label="reminder_days_before_expiry (0..60)" value={effective.reminder_days_before_expiry ?? 7} onChange={(v) => setDraft({ ...draft, reminder_days_before_expiry: v })} testId="password-policy-reminder" />
            <ToggleField label="require_upper" value={effective.require_upper ?? true} onChange={(v) => setDraft({ ...draft, require_upper: v })} testId="password-policy-upper" />
            <ToggleField label="require_lower" value={effective.require_lower ?? true} onChange={(v) => setDraft({ ...draft, require_lower: v })} testId="password-policy-lower" />
            <ToggleField label="require_digit" value={effective.require_digit ?? true} onChange={(v) => setDraft({ ...draft, require_digit: v })} testId="password-policy-digit" />
            <ToggleField label="require_symbol" value={effective.require_symbol ?? true} onChange={(v) => setDraft({ ...draft, require_symbol: v })} testId="password-policy-symbol" />
          </div>
        )}
        <div className="flex justify-end gap-2 mt-3">
          {dirty && <Button size="sm" variant="ghost" onClick={() => setDraft({})}>Discard</Button>}
          <Button
            size="sm"
            variant="secondary"
            disabled={!dirty || saveMut.isPending}
            onClick={() => saveMut.mutate(draft)}
            data-testid="password-policy-save"
          >
            <Save size={14} className="mr-1" /> Save
          </Button>
        </div>
        {saveMut.isError && <p className="text-xs text-danger mt-2">{(saveMut.error as Error)?.message ?? 'Save failed'}</p>}
        {saveMut.isSuccess && <p className="text-xs text-success mt-2">Policy saved · updated_at echoed below.</p>}
        {current?.updated_at && current.updated_at !== '1970-01-01T00:00:00.000Z' && (
          <p className="text-[11px] text-muted mt-2">Last updated {current.updated_at} by {current.updated_by ?? '—'}</p>
        )}
      </Panel>

      <Panel title="Passwords expiring soon">
        {expiringQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (expiringQ.data?.users.length ?? 0) === 0 ? (
          <p className="text-sm text-muted flex items-center gap-2"><KeyRound size={14} /> No passwords expire within the reminder window.</p>
        ) : (
          <ul className="text-[12px] divide-y divide-divider" data-testid="password-policy-expiring-list">
            {expiringQ.data!.users.map((u) => (
              <li key={u.user_id} className="py-1.5 flex items-center justify-between">
                <span className="font-medium text-ink">{u.user_id}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={u.days_remaining <= 1 ? 'danger' : u.days_remaining <= 7 ? 'warning' : 'neutral'}>{u.days_remaining}d</Badge>
                  <span className="text-[11px] text-muted">{u.expires_at}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function NumberField({ label, value, onChange, testId }: { label: string; value: number; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <Input
        type="number"
        value={String(value)}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(n);
        }}
        data-testid={testId}
      />
    </label>
  );
}

function ToggleField({ label, value, onChange, testId }: { label: string; value: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <label className="flex items-center gap-2 mt-5">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span className="text-xs text-ink">{label}</span>
    </label>
  );
}
