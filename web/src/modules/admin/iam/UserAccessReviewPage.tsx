// web/src/modules/admin/iam/UserAccessReviewPage.tsx
//
// IAM Center → Access Review (Feature 4).
//
// Per-user 360 panel: country, domain, tenant, branch, department, role(s),
// RBAC summary across 7 actions (View/Create/Edit/Delete/Approve/Export/
// Configure). Composes existing surfaces — IUserStore + DBAC resolver +
// T6 permission_matrix.

import { Navigate, Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Eye, ArrowRight, ShieldCheck, X, Check } from 'lucide-react';
import { Badge, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api, type AccessReviewSummary } from '@/lib/api';

const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'] as const;
type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export function UserAccessReviewPage() {
  const me = useAuth((s) => s.user);
  const adminListUsers = useAuth((s) => s.adminListUsers);
  const { username } = useParams<{ username?: string }>();

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor')) {
    return <Navigate to="/" replace />;
  }

  const usersQ = useQuery({ queryKey: ['admin.users'], queryFn: adminListUsers });
  const reviewQ = useQuery({
    queryKey: ['iam.access-review', username],
    queryFn: () => api.iamAccessReview(username!),
    enabled: !!username,
  });

  // List mode — no username param → show user picker
  if (!username) {
    const users = usersQ.data ?? [];
    return (
      <div data-testid="user-access-review-page">
        <PageHeader title="Access Review" subtitle="Pick a user to inspect their full IAM context + RBAC matrix." />
        <Panel title={`${users.length} users`}>
          {usersQ.isLoading ? <p className="text-sm text-muted">Loading…</p> : (
            <ul className="text-[12px] divide-y divide-divider" data-testid="user-access-review-list">
              {users.map((u) => (
                <li key={u.id} className="py-2 flex items-center justify-between" data-testid={`user-access-review-pick-${u.id}`}>
                  <div>
                    <div className="font-medium text-ink">{u.display_name || u.username}</div>
                    <div className="text-[10.5px] text-muted">{u.username} · {u.role}</div>
                  </div>
                  <Link
                    to={`/admin/iam/access-review/${encodeURIComponent(u.username)}`}
                    className="inline-flex items-center gap-1 text-action hover:underline text-[11px]"
                  >
                    Review <ArrowRight size={11} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    );
  }

  // Drill mode
  const review = reviewQ.data;
  return (
    <div data-testid="user-access-review-page">
      <PageHeader
        title={`Access Review — ${username}`}
        subtitle="Country / domain / tenant / branch / department / role + RBAC summary across 7 actions."
      />

      {reviewQ.isLoading ? (
        <Panel><p className="text-sm text-muted">Loading…</p></Panel>
      ) : !review ? (
        <Panel><p className="text-sm text-muted flex items-center gap-2"><Eye size={14} /> User not found.</p></Panel>
      ) : (
        <>
          <Panel className="mb-4" title="IAM context">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-[12px]" data-testid="access-review-context">
              <Field label="Username" value={review.username} />
              <Field label="Display name" value={review.display_name ?? '—'} />
              <Field label="Status" value={<Badge tone={review.status === 'active' ? 'success' : review.status === 'locked' ? 'danger' : 'neutral'}>{review.status}</Badge>} />
              <Field label="Country" value={review.country ?? '—'} />
              <Field label="Domain" value={review.domain ?? '—'} />
              <Field label="Tenant" value={review.tenant_id} />
              <Field label="Branch" value={review.branch_id ?? '—'} />
              <Field label="Department" value={review.department ?? '—'} />
              <Field label="Role(s)" value={review.roles.join(', ')} />
              <Field label="Last login" value={review.last_login_at ?? '—'} />
              <Field label="Last logout" value={review.last_logout_at ?? '—'} />
              <Field label="Active sessions" value={String(review.active_session_count ?? 0)} />
            </div>
          </Panel>

          <Panel title="RBAC summary (7 actions × granted modules)">
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]" data-testid="access-review-rbac">
                <thead className="text-[10px] uppercase tracking-wide text-muted border-b border-divider">
                  <tr>
                    <th className="text-left py-1.5 px-2">Module</th>
                    {PERMISSION_ACTIONS.map((a) => (
                      <th key={a} className="text-center py-1.5 px-2">{a}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(review.rbac_modules ?? []).map((mod) => (
                    <tr key={mod.module_id} className="border-b border-divider/60" data-testid={`access-review-rbac-${mod.module_id}`}>
                      <td className="py-1 px-2 font-medium text-ink">{mod.module_id}</td>
                      {PERMISSION_ACTIONS.map((a) => (
                        <td key={a} className="text-center py-1 px-2">
                          {mod.granted_actions.includes(a as PermissionAction) ? (
                            <Check size={12} className="inline text-success" />
                          ) : (
                            <X size={12} className="inline text-muted/40" />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {(review.rbac_modules ?? []).length === 0 && (
                <p className="text-[11px] text-muted py-3">No modules granted to this user's role.</p>
              )}
            </div>
            <p className="text-[10.5px] text-muted mt-3 flex items-center gap-1">
              <ShieldCheck size={11} /> Reuses the T6 enterprise permission matrix (7 actions × ~25 modules) — no new RBAC ops added.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wide text-muted">{label}</div>
      <div className="text-ink mt-0.5">{value}</div>
    </div>
  );
}

export type { AccessReviewSummary };
