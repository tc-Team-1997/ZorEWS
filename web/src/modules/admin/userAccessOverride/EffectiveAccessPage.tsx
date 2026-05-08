import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { api, type EffectiveAccessRow } from '@/lib/api';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const PERMISSION_TONE: Record<string, 'success' | 'blue' | 'warning' | 'danger'> = {
  VIEW: 'blue',
  EDIT: 'warning',
  APPROVE: 'success',
  FULL: 'danger',
};

export function EffectiveAccessPage() {
  const { user_id } = useParams<{ user_id: string }>();
  const q = useQuery({
    queryKey: ['uao', 'effective', user_id],
    queryFn: () => api.uaoEffectiveAccess(user_id ?? ''),
    enabled: !!user_id,
  });

  return (
    <div>
      <Link to="/admin/user-access-override" className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 mb-2">
        <ArrowLeft className="w-3 h-3" /> Back to override list
      </Link>
      <PageHeader
        title={`Effective access · ${user_id ?? ''}`}
        subtitle="role-based access UNION grants MINUS revokes (resolver output)"
      />

      {q.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {q.error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-md px-3 py-2 text-xs">
          {q.error instanceof Error ? q.error.message : 'Failed to load'}
        </div>
      )}

      {q.data && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Panel title="Roles">
              <div className="flex flex-wrap gap-2">
                {q.data.role_access.roles.map((r) => (
                  <Badge key={r} tone="blue">
                    {r}
                  </Badge>
                ))}
              </div>
              <div className="mt-3 text-xs text-muted">
                Computed at {new Date(q.data.computed_at).toLocaleString()}
              </div>
            </Panel>

            <Panel title="Active overrides">
              {q.data.overrides_applied.length === 0 ? (
                <div className="text-xs text-muted">None in force at this time.</div>
              ) : (
                <ul className="space-y-2">
                  {q.data.overrides_applied.map((o) => (
                    <li key={o.override_id} className="border rounded p-2">
                      <div className="text-xs flex items-center gap-2">
                        <ShieldCheck className="w-3 h-3" />
                        <Badge tone={o.override_type === 'GRANT' ? 'success' : 'danger'}>
                          {o.override_type}
                        </Badge>
                        <span className="font-mono">{o.module_path}</span>
                        <span className="text-muted">/ {o.permission_type}</span>
                      </div>
                      <div className="text-2xs text-muted mt-1">
                        until {o.effective_till ? new Date(o.effective_till).toLocaleDateString() : 'permanent'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Summary">
              <div className="text-xs text-muted">Modules accessible:</div>
              <div className="text-3xl font-semibold">{q.data.effective.length}</div>
              <div className="text-2xs text-muted mt-2">
                Source breakdown: {countSources(q.data.effective)}
              </div>
            </Panel>
          </div>

          <div className="mt-6">
            <Panel title="Effective access (merged)">
              <table className="w-full text-sm">
                <thead className="text-2xs uppercase text-muted">
                  <tr className="text-left">
                    <th className="px-3 py-2">Module</th>
                    <th className="px-3 py-2">Permissions</th>
                    <th className="px-3 py-2">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.effective.map((row) => (
                    <tr key={row.module_path} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">{row.module_path}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1 flex-wrap">
                          {row.permissions.map((p) => (
                            <Badge key={p} tone={PERMISSION_TONE[p] ?? 'neutral'} className="text-2xs">
                              {p}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-2xs">
                        {row.source.split(',').map((s, i) => (
                          <div key={i} className={s.startsWith('override') ? 'text-amber-700' : 'text-muted'}>
                            {s}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function countSources(rows: EffectiveAccessRow[]): string {
  let role = 0;
  let mixed = 0;
  let onlyOverride = 0;
  for (const r of rows) {
    if (r.source === 'role') role++;
    else if (r.source.startsWith('override:')) onlyOverride++;
    else mixed++;
  }
  return `${role} role-only · ${mixed} blended · ${onlyOverride} override-only`;
}
