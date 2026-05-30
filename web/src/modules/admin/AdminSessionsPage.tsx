// web/src/modules/admin/AdminSessionsPage.tsx
//
// Phase 9 T2 — fleet-wide session governance for admins.
//
// Distinct from /profile/sessions (caller's OWN sessions only). This page
// surfaces EVERY session across every user, decorated with username + role
// + revoked-flag. Admin can:
//
//   - filter by status (active / revoked / all)
//   - search by username (client-side substring on the loaded slice)
//   - revoke any single session with an optional reason (e.g. "leaked
//     refresh token") — separate from the M1-partial force-logout that
//     kills EVERY session for a user
//
// Backed by GET /auth/admin/sessions + POST /auth/admin/sessions/:sid/revoke
// (auth-svc routes added today). Each revoke writes a user_force_logout
// audit event with scope=single_session so compliance can distinguish from
// the bulk variant.

import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Laptop,
  RefreshCw,
  Smartphone,
  Trash2,
} from 'lucide-react';
import {
  useAuth,
  type AdminSessionRow,
  type AdminSessionStatus,
} from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Badge, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

function deviceIcon(ua: string) {
  if (/iphone|ipad|android|mobile/i.test(ua)) return Smartphone;
  return Laptop;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

function humanizeError(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: string; message?: string } | undefined;
    if (err.status === 403) return 'Only administrators can revoke sessions.';
    if (err.status === 404) return 'Session not found (may have already been revoked).';
    if (err.status === 409 && body?.error === 'already_revoked')
      return 'Already revoked.';
    if (body?.message) return body.message;
  }
  return fallback;
}

const STATUS_OPTIONS: { value: AdminSessionStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'all', label: 'All' },
];

export function AdminSessionsPage() {
  const me = useAuth((s) => s.user);
  const adminListSessions = useAuth((s) => s.adminListSessions);
  const adminRevokeSession = useAuth((s) => s.adminRevokeSession);
  const qc = useQueryClient();

  const [status, setStatus] = useState<AdminSessionStatus>('active');
  const [usernameSearch, setUsernameSearch] = useState('');
  const [rowError, setRowError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin.sessions', status],
    queryFn: () => adminListSessions({ status, limit: 500 }),
    enabled: me?.roles.includes('admin') ?? false,
  });

  const revokeMutation = useMutation({
    mutationFn: ({ sid, reason }: { sid: string; reason?: string }) =>
      adminRevokeSession(sid, reason),
    onSuccess: () => {
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['admin.sessions'] });
    },
    onError: (err) => setRowError(humanizeError(err, 'Revoke failed.')),
  });

  if (me && !me.roles.includes('admin')) {
    return <Navigate to="/" replace />;
  }

  const rows = data?.sessions ?? [];
  const filteredRows = usernameSearch.trim()
    ? rows.filter((r) =>
        (r.username ?? '').toLowerCase().includes(usernameSearch.trim().toLowerCase()),
      )
    : rows;

  function onRevoke(row: AdminSessionRow) {
    const reason =
      typeof window !== 'undefined'
        ? window.prompt(
            `Revoke session ${row.id} (user: ${row.username ?? 'unknown'})?\nOptional reason for audit trail:`,
            '',
          )
        : '';
    if (reason === null) return; // user cancelled
    revokeMutation.mutate({ sid: row.id, reason: reason || undefined });
  }

  return (
    <div data-testid="admin-sessions-page">
      <PageHeader
        title="Sessions"
        subtitle={
          isLoading
            ? 'Loading…'
            : isError
              ? error instanceof HttpError && error.status === 403
                ? 'Forbidden — admin role required.'
                : 'Failed to load sessions.'
              : `${filteredRows.length} of ${rows.length} session${rows.length === 1 ? '' : 's'} · ${status} · admin only`
        }
        actions={
          <Button
            variant="ghost"
            onClick={() => qc.invalidateQueries({ queryKey: ['admin.sessions'] })}
          >
            <RefreshCw size={14} className="mr-1.5" />
            Refresh
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded border border-divider bg-surface p-0.5">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatus(opt.value)}
              data-testid={`status-filter-${opt.value}`}
              className={`rounded px-3 py-1 text-xs ${
                status === opt.value
                  ? 'bg-action text-white'
                  : 'text-muted hover:bg-divider/30'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <Input
          type="text"
          placeholder="Search by username…"
          value={usernameSearch}
          onChange={(e) => setUsernameSearch(e.target.value)}
          data-testid="admin-sessions-search"
          className="w-64"
        />
      </div>

      {rowError && (
        <p
          role="alert"
          className="mb-3 rounded border border-danger/20 bg-danger-bg px-3 py-2 text-sm text-danger"
          data-testid="admin-sessions-row-error"
        >
          {rowError}
        </p>
      )}

      <Panel title="Fleet sessions">
        {isLoading && <p className="caption">Loading…</p>}
        {!isLoading && filteredRows.length === 0 && (
          <p className="caption" data-testid="admin-sessions-empty">
            No sessions match the current filter.
          </p>
        )}
        {!isLoading && filteredRows.length > 0 && (
          <div className="overflow-x-auto" data-testid="admin-sessions-table">
            <table className="min-w-full text-sm">
              <thead className="border-b border-divider bg-divider/10 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Tenant</th>
                  <th className="px-3 py-2">Session</th>
                  <th className="px-3 py-2">Issued</th>
                  <th className="px-3 py-2">Last seen</th>
                  <th className="px-3 py-2">IP</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((s) => {
                  const Icon = deviceIcon(s.user_agent);
                  return (
                    <tr
                      key={s.id}
                      data-testid={`admin-session-row-${s.id}`}
                      className="border-b border-divider/30 last:border-b-0"
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Icon size={14} className="text-muted" />
                          <span className="font-medium">{s.username ?? '—'}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">{s.role ?? '—'}</td>
                      <td className="px-3 py-2 text-xs">{s.tenant_id ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.id}</td>
                      <td className="px-3 py-2 text-xs">{relTime(s.issued_at)}</td>
                      <td className="px-3 py-2 text-xs">{relTime(s.last_seen_at)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{s.ip}</td>
                      <td className="px-3 py-2">
                        {s.revoked ? (
                          <Badge tone="neutral">revoked</Badge>
                        ) : (
                          <Badge tone="success">active</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onRevoke(s)}
                          disabled={s.revoked || revokeMutation.isPending}
                          aria-label={`Revoke session ${s.id}`}
                          title="Revoke this session"
                          data-testid={`admin-revoke-${s.id}`}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel className="mt-4">
        <p className="caption">
          Distinct from the per-user <strong>Force-logout</strong> action on Users (which kills
          every session for one user), this page lets you revoke a single specific session — e.g.
          when a refresh token leaks on one device but the rest are fine. Every revocation writes
          a <code>user_force_logout</code> audit event with <code>scope=single_session</code>.
        </p>
      </Panel>
    </div>
  );
}
