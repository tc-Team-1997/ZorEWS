import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  KeyRound,
  Lock,
  LockOpen,
  Plus,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  useAuth,
  type AdminUserRow,
  type Role,
  type SignupResult,
} from '@/store/auth';
import { HttpError } from '@/lib/http';
import {
  Badge,
  type BadgeTone,
  Button,
  type Column,
  DataTable,
  Input,
  Panel,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';

const ROLES: { value: Role; label: string }[] = [
  { value: 'risk_analyst', label: 'Risk analyst' },
  { value: 'field_officer', label: 'Field officer' },
  { value: 'collection_officer', label: 'Collection officer' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'admin', label: 'Administrator' },
];

const ROLE_TONE: Record<Role, BadgeTone> = {
  admin: 'danger',
  supervisor: 'warning',
  risk_analyst: 'blue',
  collection_officer: 'purple',
  field_officer: 'success',
};

const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  supervisor: 'Supervisor',
  risk_analyst: 'Risk analyst',
  collection_officer: 'Collection officer',
  field_officer: 'Field officer',
};

type Mode = { kind: 'idle' } | { kind: 'reset'; username: string } | { kind: 'create' };

interface ResetFields {
  newPassword: string;
  confirmPassword: string;
  error: string | null;
  success: string | null;
}
const EMPTY_RESET: ResetFields = {
  newPassword: '',
  confirmPassword: '',
  error: null,
  success: null,
};

interface CreateFields {
  username: string;
  email: string;
  display_name: string;
  password: string;
  confirm_password: string;
  role: Role;
  error: string | null;
  result: SignupResult | null;
}
const EMPTY_CREATE: CreateFields = {
  username: '',
  email: '',
  display_name: '',
  password: '',
  confirm_password: '',
  role: 'risk_analyst',
  error: null,
  result: null,
};

function humanizeError(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: string; message?: string } | undefined;
    if (err.status === 403) return 'Only administrators can perform this action.';
    if (err.status === 404) return 'User not found.';
    if (err.status === 409 && body?.error === 'cannot_delete_self')
      return "You can't delete your own account.";
    if (err.status === 409 && body?.error === 'cannot_lock_self')
      return "You can't lock your own account.";
    if (err.status === 409 && body?.error === 'username_taken')
      return body.message ?? 'That username is already taken.';
    if (err.status === 409 && body?.error === 'email_taken')
      return body.message ?? 'That email is already in use.';
    if (body?.message) return body.message;
  }
  return fallback;
}

export function AdminUsersPage() {
  const me = useAuth((s) => s.user);
  const adminListUsers = useAuth((s) => s.adminListUsers);
  const adminResetPassword = useAuth((s) => s.adminResetPassword);
  const adminCreateUser = useAuth((s) => s.adminCreateUser);
  const navigate = useNavigate();
  const adminDeleteUser = useAuth((s) => s.adminDeleteUser);
  const adminSetLocked = useAuth((s) => s.adminSetLocked);
  // M6.1 — Users & RBAC: role change endpoint
  const adminSetRole = useAuth((s) => s.adminSetRole);
  const qc = useQueryClient();

  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [reset, setReset] = useState<ResetFields>(EMPTY_RESET);
  const [create, setCreate] = useState<CreateFields>(EMPTY_CREATE);
  const [rowError, setRowError] = useState<string | null>(null);

  useChatContext({ page: 'unknown' });

  const { data: users, isLoading, isError, error } = useQuery({
    queryKey: ['admin.users'],
    queryFn: adminListUsers,
    enabled: me?.roles.includes('admin') ?? false,
  });

  const resetMutation = useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      adminResetPassword(username, password),
    onSuccess: (_d, vars) => {
      setReset((s) => ({
        ...s,
        success: `Password for ${vars.username} has been reset.`,
        newPassword: '',
        confirmPassword: '',
      }));
      qc.invalidateQueries({ queryKey: ['admin.users'] });
    },
    onError: (err) => {
      setReset((s) => ({ ...s, error: humanizeError(err, 'Reset failed.'), success: null }));
    },
  });

  const createMutation = useMutation({
    mutationFn: (input: {
      username: string;
      email: string;
      password: string;
      display_name: string;
      role: Role;
    }) => adminCreateUser(input),
    onSuccess: (data) => {
      setCreate((s) => ({ ...s, error: null, result: data }));
      qc.invalidateQueries({ queryKey: ['admin.users'] });
    },
    onError: (err) => {
      setCreate((s) => ({ ...s, error: humanizeError(err, 'Create failed.'), result: null }));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (username: string) => adminDeleteUser(username),
    onSuccess: () => {
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['admin.users'] });
    },
    onError: (err) => setRowError(humanizeError(err, 'Delete failed.')),
  });

  const lockMutation = useMutation({
    mutationFn: ({ username, locked }: { username: string; locked: boolean }) =>
      adminSetLocked(username, locked),
    onSuccess: () => {
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['admin.users'] });
    },
    onError: (err) => setRowError(humanizeError(err, 'Lock toggle failed.')),
  });

  // M6.1 — Users & RBAC: change a user's role inline. The acceptance
  // contract is that the change takes effect on the target user's
  // next /auth/me call without forcing them to log out.
  const roleMutation = useMutation({
    mutationFn: ({ username, role }: { username: string; role: Role }) =>
      adminSetRole(username, role),
    onSuccess: (data) => {
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['admin.users'] });
      // If the admin just changed their OWN role (shouldn't happen — server
      // refuses with 409 — but belt + braces), refresh the local me cache.
      if (me?.username === data.username) {
        // role change does not invalidate the JWT but /auth/me will return
        // the new value; surface a refresh signal via a separate query.
        qc.invalidateQueries({ queryKey: ['auth.me'] });
      }
    },
    onError: (err) => setRowError(humanizeError(err, 'Role change failed.')),
  });

  // Hard role gate.
  if (me && !me.roles.includes('admin')) {
    return <Navigate to="/" replace />;
  }

  const startReset = (username: string) => {
    setReset(EMPTY_RESET);
    setMode({ kind: 'reset', username });
  };
  const startCreate = () => {
    setCreate(EMPTY_CREATE);
    setMode({ kind: 'create' });
  };
  const closeSide = () => {
    setMode({ kind: 'idle' });
    setReset(EMPTY_RESET);
    setCreate(EMPTY_CREATE);
  };

  const onSubmitReset = (e: FormEvent) => {
    e.preventDefault();
    if (mode.kind !== 'reset') return;
    setReset((s) => ({ ...s, error: null, success: null }));
    if (reset.newPassword.length < 8) {
      setReset((s) => ({ ...s, error: 'Password must be at least 8 characters.' }));
      return;
    }
    if (reset.newPassword !== reset.confirmPassword) {
      setReset((s) => ({ ...s, error: 'Passwords do not match.' }));
      return;
    }
    resetMutation.mutate({ username: mode.username, password: reset.newPassword });
  };

  const onSubmitCreate = (e: FormEvent) => {
    e.preventDefault();
    setCreate((s) => ({ ...s, error: null, result: null }));
    if (!/^[a-z][a-z0-9._-]{2,31}$/.test(create.username.trim().toLowerCase())) {
      setCreate((s) => ({
        ...s,
        error: 'Username must be 3–32 chars, lowercase, start with a letter.',
      }));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(create.email.trim())) {
      setCreate((s) => ({ ...s, error: 'Enter a valid email.' }));
      return;
    }
    if (!create.display_name.trim()) {
      setCreate((s) => ({ ...s, error: 'Full name required.' }));
      return;
    }
    if (create.password.length < 8) {
      setCreate((s) => ({ ...s, error: 'Password must be at least 8 characters.' }));
      return;
    }
    if (create.password !== create.confirm_password) {
      setCreate((s) => ({ ...s, error: 'Passwords do not match.' }));
      return;
    }
    createMutation.mutate({
      username: create.username.trim().toLowerCase(),
      email: create.email.trim().toLowerCase(),
      password: create.password,
      display_name: create.display_name.trim(),
      role: create.role,
    });
  };

  const onDelete = (username: string) => {
    if (!window.confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    deleteMutation.mutate(username);
  };

  const isSelf = (u: AdminUserRow) => u.username === me?.username;

  const columns: Column<AdminUserRow>[] = [
    {
      key: 'username',
      header: 'Username',
      render: (u) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] text-ink">{u.username}</span>
          {u.locked && (
            <Badge tone="neutral" className="text-[10px] inline-flex items-center gap-1">
              <Lock size={10} /> locked
            </Badge>
          )}
          {isSelf(u) && (
            <Badge tone="blue" className="text-[10px]">
              you
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'display_name',
      header: 'Name',
      render: (u) => <span className="text-[13px] text-ink">{u.display_name}</span>,
    },
    {
      key: 'email',
      header: 'Email',
      render: (u) => <span className="text-[12px] text-sub">{u.email}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      width: 200,
      // M6.1 — Users & RBAC: inline role picker. Self-change is refused
      // server-side (409) so the admin can't accidentally demote
      // themselves; we mirror that by disabling the select for the
      // current user. Change is applied via PATCH /auth/users/:u/role
      // and surfaces on the target user's next /auth/me without logout.
      render: (u) => (
        <div className="flex items-center gap-1.5">
          <Badge tone={ROLE_TONE[u.role]} className="text-[11px]">
            {ROLE_LABEL[u.role]}
          </Badge>
          <select
            data-testid={`admin-role-select-${u.username}`}
            aria-label={`Change role for ${u.username}`}
            value={u.role}
            disabled={isSelf(u) || roleMutation.isPending}
            onChange={(e) => {
              const next = e.target.value as Role;
              if (next === u.role) return;
              if (
                !window.confirm(
                  `Change ${u.username}'s role from ${ROLE_LABEL[u.role]} to ${ROLE_LABEL[next]}?\n\nThe change takes effect on their next request (no logout required).`,
                )
              ) {
                return;
              }
              roleMutation.mutate({ username: u.username, role: next });
            }}
            className="border border-divider rounded px-1.5 py-0.5 text-[11px] bg-surface text-ink disabled:opacity-50"
          >
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 280,
      render: (u) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => startReset(u.username)}
            aria-label={`Reset password for ${u.username}`}
            title="Reset password"
          >
            <KeyRound size={13} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => lockMutation.mutate({ username: u.username, locked: !u.locked })}
            disabled={isSelf(u) && !u.locked}
            aria-label={u.locked ? `Unlock ${u.username}` : `Lock ${u.username}`}
            title={u.locked ? 'Unlock account' : 'Lock account'}
          >
            {u.locked ? <LockOpen size={13} /> : <Lock size={13} />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(u.username)}
            disabled={isSelf(u)}
            aria-label={`Delete ${u.username}`}
            title="Delete user"
          >
            <Trash2 size={13} />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle={
          isLoading
            ? 'Loading…'
            : isError
              ? error instanceof HttpError && error.status === 403
                ? 'Forbidden — admin role required.'
                : 'Failed to load users.'
              : `${users?.length ?? 0} user${users?.length === 1 ? '' : 's'} · admin only`
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate('/admin/users/new')}>
              <UserPlus size={14} className="mr-1.5" />
              Full enrolment
            </Button>
            <Button onClick={startCreate}>
              <Plus size={14} className="mr-1.5" />
              New user
            </Button>
          </>
        }
      />

      {rowError && (
        <p
          role="alert"
          className="mb-4 text-[12px] text-danger bg-danger-bg border border-danger/20 rounded px-3 py-2"
        >
          {rowError}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_24rem] gap-5">
        <Panel title="All users">
          <DataTable
            columns={columns}
            data={users ?? []}
            empty={isLoading ? 'Loading users…' : 'No users to show.'}
          />
        </Panel>

        <Panel
          title={
            mode.kind === 'create'
              ? 'Create user'
              : mode.kind === 'reset'
                ? 'Reset password'
                : 'Actions'
          }
        >
          {mode.kind === 'create' ? (
            create.result ? (
              <CreateSuccessPanel result={create.result} onClose={closeSide} />
            ) : (
              <form onSubmit={onSubmitCreate} className="space-y-3" noValidate>
                <Input
                  label="Full name"
                  value={create.display_name}
                  onChange={(e) =>
                    setCreate((s) => ({ ...s, display_name: e.target.value }))
                  }
                  placeholder="Tina Tester"
                  required
                />
                <Input
                  label="Username"
                  value={create.username}
                  onChange={(e) => setCreate((s) => ({ ...s, username: e.target.value }))}
                  autoComplete="off"
                  placeholder="tina.tester"
                  required
                />
                <Input
                  label="Email"
                  type="email"
                  value={create.email}
                  onChange={(e) => setCreate((s) => ({ ...s, email: e.target.value }))}
                  autoComplete="off"
                  placeholder="tina@example.com"
                  required
                />
                <label className="block">
                  <span className="label">Role</span>
                  <select
                    className="input"
                    value={create.role}
                    onChange={(e) =>
                      setCreate((s) => ({ ...s, role: e.target.value as Role }))
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Input
                  label="Initial password"
                  type="password"
                  value={create.password}
                  onChange={(e) => setCreate((s) => ({ ...s, password: e.target.value }))}
                  autoComplete="new-password"
                  required
                />
                <Input
                  label="Confirm password"
                  type="password"
                  value={create.confirm_password}
                  onChange={(e) =>
                    setCreate((s) => ({ ...s, confirm_password: e.target.value }))
                  }
                  autoComplete="new-password"
                  required
                />
                {create.error && (
                  <p
                    role="alert"
                    className="text-[11px] text-danger bg-danger-bg border border-danger/20 rounded px-3 py-1.5"
                  >
                    {create.error}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    className="flex-1"
                    loading={createMutation.isPending}
                  >
                    Create user
                  </Button>
                  <Button type="button" variant="ghost" onClick={closeSide}>
                    Cancel
                  </Button>
                </div>
              </form>
            )
          ) : mode.kind === 'reset' ? (
            <form onSubmit={onSubmitReset} className="space-y-3" noValidate>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted mb-1">User</p>
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded border border-divider bg-surface-alt">
                  <span className="font-mono text-[12px] text-ink">{mode.username}</span>
                  <button
                    type="button"
                    onClick={closeSide}
                    aria-label="Cancel"
                    className="text-muted hover:text-ink transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              <Input
                label="New password"
                type="password"
                value={reset.newPassword}
                onChange={(e) => setReset((s) => ({ ...s, newPassword: e.target.value }))}
                autoComplete="new-password"
                required
              />
              <Input
                label="Confirm new password"
                type="password"
                value={reset.confirmPassword}
                onChange={(e) =>
                  setReset((s) => ({ ...s, confirmPassword: e.target.value }))
                }
                autoComplete="new-password"
                required
              />
              {reset.error && (
                <p
                  role="alert"
                  className="text-[11px] text-danger bg-danger-bg border border-danger/20 rounded px-3 py-1.5"
                >
                  {reset.error}
                </p>
              )}
              {reset.success && (
                <p
                  role="status"
                  className="text-[11px] text-success bg-success-bg border border-success/20 rounded px-3 py-1.5 inline-flex items-center gap-1.5"
                >
                  <Check size={12} /> {reset.success}
                </p>
              )}
              <Button type="submit" className="w-full" loading={resetMutation.isPending}>
                Reset password
              </Button>
              <p className="text-[11px] text-muted leading-relaxed">
                Must be ≥8 chars and include lowercase, uppercase, and a digit or
                symbol. The user will need to sign in again with the new password.
              </p>
            </form>
          ) : (
            <div className="text-center py-6">
              <div className="inline-flex w-12 h-12 rounded-full bg-action-subtle items-center justify-center mb-3">
                <UserPlus size={20} className="text-action" strokeWidth={1.75} />
              </div>
              <p className="text-[13px] text-ink font-medium">No action selected</p>
              <p className="text-[11px] text-muted mt-1 max-w-[280px] mx-auto leading-relaxed">
                Click <span className="font-medium">New user</span> to create one, or
                pick a row action: reset password, lock/unlock, or delete.
              </p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function CreateSuccessPanel({
  result,
  onClose,
}: {
  result: SignupResult;
  onClose: () => void;
}) {
  return (
    <div>
      <p
        role="status"
        className="text-[12px] text-success bg-success-bg border border-success/20 rounded px-3 py-2 inline-flex items-center gap-1.5 mb-3"
      >
        <Check size={12} /> User <span className="font-mono">{result.user.username}</span> created.
      </p>
      <div className="rounded border border-divider bg-surface-alt p-3 mb-3">
        <p className="text-[11px] uppercase tracking-wide text-muted mb-1">Username</p>
        <code data-testid="created-username" className="font-mono text-[12px] text-ink break-all">
          {result.user.username}
        </code>
        <p className="text-[11px] text-muted mt-2 leading-relaxed">
          Share the username and the password you set with the new user. They can
          sign in immediately.
        </p>
      </div>
      <Button type="button" className="w-full" onClick={onClose}>
        Done
      </Button>
    </div>
  );
}
