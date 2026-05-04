import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth, type SessionRow } from '@/store/auth';

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

export function SessionsPage() {
  const listMySessions = useAuth((s) => s.listMySessions);
  const revokeSession = useAuth((s) => s.revokeSession);
  const revokeOtherSessions = useAuth((s) => s.revokeOtherSessions);
  const queryClient = useQueryClient();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['my-sessions'],
    queryFn: listMySessions,
  });

  const revokeMut = useMutation({
    mutationFn: (sid: string) => revokeSession(sid),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-sessions'] }),
  });

  const handleRevokeOthers = async () => {
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const r = await revokeOtherSessions(true);
      setBulkResult(
        r.revoked_count === 0
          ? 'No other sessions to sign out.'
          : `Signed out ${r.revoked_count} other session${r.revoked_count === 1 ? '' : 's'}.`,
      );
      await query.refetch();
    } finally {
      setBulkBusy(false);
    }
  };

  const sessions: SessionRow[] = query.data?.sessions ?? [];
  const otherCount = sessions.filter((s) => !s.is_current).length;

  return (
    <div>
      <PageHeader
        title="Active sessions"
        subtitle="Devices currently signed in to your APEX EWS account · revoke any you don't recognise"
      />

      <Panel
        title="Your sessions"
        className="mb-4"
        action={
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw size={14} className="mr-1.5" />
              {query.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button
              type="button"
              onClick={handleRevokeOthers}
              disabled={bulkBusy || otherCount === 0}
              data-testid="revoke-others"
            >
              <LogOut size={14} className="mr-1.5" />
              Sign out other devices
            </Button>
          </div>
        }
      >
        {bulkResult && (
          <p
            role="status"
            data-testid="bulk-result"
            className="text-[12px] text-success bg-success-bg border border-success/20 rounded px-3 py-1.5 mb-3"
          >
            {bulkResult}
          </p>
        )}

        {query.isLoading && <p className="caption">Loading sessions…</p>}
        {query.isError && (
          <p role="alert" className="text-danger text-sm">
            Could not load sessions. Try refreshing.
          </p>
        )}

        {query.data && sessions.length === 0 && (
          <p className="caption">No active sessions found.</p>
        )}

        {query.data && sessions.length > 0 && (
          <ul className="divide-y divide-divider" data-testid="sessions-list">
            {sessions.map((s) => {
              const Icon = deviceIcon(s.user_agent);
              return (
                <li
                  key={s.id}
                  data-testid={`session-row-${s.id}`}
                  className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="w-9 h-9 rounded-md bg-surface-alt flex items-center justify-center shrink-0">
                    <Icon size={16} className="text-action" strokeWidth={1.75} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] text-ink font-medium truncate">{s.user_agent}</p>
                      {s.is_current && (
                        <span
                          data-testid="current-badge"
                          className="text-[10px] uppercase tracking-wide bg-success/10 text-success px-1.5 py-0.5 rounded"
                        >
                          This device
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted mt-0.5">
                      <span className="font-mono">{s.ip}</span> · last active {relTime(s.last_seen_at)} ·
                      signed in {relTime(s.issued_at)}
                    </p>
                  </div>
                  {!s.is_current && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => revokeMut.mutate(s.id)}
                      disabled={revokeMut.isPending && revokeMut.variables === s.id}
                      data-testid={`revoke-${s.id}`}
                    >
                      <Trash2 size={14} className="mr-1.5" />
                      Sign out
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel>
        <p className="caption">
          Each sign-in creates a session that's tracked server-side. Revoking a session
          invalidates its refresh token immediately — that device will need to sign in
          again. Existing access tokens remain valid until their natural 15-minute
          expiry, after which the next request will fail.
        </p>
      </Panel>
    </div>
  );
}
