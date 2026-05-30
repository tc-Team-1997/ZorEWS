// web/src/modules/admin/rbac/PermissionMatrixPage.tsx
//
// Enterprise Permission Matrix editor (T11-style admin page).
//
// Renders a role × module × action grid that admins can toggle in place.
// Backed by the 049 overlay routes — additive on top of the existing
// `requireRole('op')` matrix.json gate. The new matrix gates UI
// elements via the useCan() hook + new routes via
// requireModulePermission() middleware on the BFF.
//
// Page surface:
//   1. Role picker (10 enterprise roles).
//   2. Grouped module grid (by category: dashboard/banking/insurance/…)
//      with one checkbox per (module × action).
//   3. Toggle one cell or Save All — bulk-PUT sends only changed cells.
//   4. Audit summary chip — "12 modules · 47 granted cells".

import { useMemo, useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckSquare, Square, ShieldCheck, RefreshCw, Save, AlertCircle, Loader2 } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { HttpError } from '@/lib/http';
import {
  api,
  RBAC_ACTIONS,
  type RbacAction,
  type RbacGrantsBody,
  type RbacGrantsGrid,
  type RbacModuleDef,
} from '@/lib/api';

function humanizeError(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: { message?: string } } | undefined;
    if (body?.error?.message) return body.error.message;
  }
  return fallback;
}

function emptyGrid(modules: readonly RbacModuleDef[]): RbacGrantsGrid {
  const out: RbacGrantsGrid = {};
  for (const m of modules) {
    out[m.id] = {} as Record<RbacAction, boolean>;
    for (const a of RBAC_ACTIONS) out[m.id][a] = false;
  }
  return out;
}

function gridsEqual(a: RbacGrantsGrid, b: RbacGrantsGrid): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? {};
    const bv = b[k] ?? {};
    for (const act of RBAC_ACTIONS) {
      if ((av[act] ?? false) !== (bv[act] ?? false)) return false;
    }
  }
  return true;
}

function diffGrants(prev: RbacGrantsGrid, next: RbacGrantsGrid): RbacGrantsBody {
  const out: RbacGrantsBody = {};
  for (const m of Object.keys(next)) {
    for (const act of RBAC_ACTIONS) {
      const before = prev[m]?.[act] ?? false;
      const after = next[m]?.[act] ?? false;
      if (before !== after) {
        out[m] ??= {};
        out[m][act] = after;
      }
    }
  }
  return out;
}

function countGranted(grid: RbacGrantsGrid): number {
  let n = 0;
  for (const m of Object.keys(grid)) {
    for (const act of RBAC_ACTIONS) if (grid[m]?.[act]) n++;
  }
  return n;
}

export function PermissionMatrixPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [selectedRole, setSelectedRole] = useState<string>('');
  const [draft, setDraft] = useState<RbacGrantsGrid>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  const rolesQ = useQuery({
    queryKey: ['rbac', 'roles'],
    queryFn: () => api.rbacListRoles(),
    enabled: me?.roles.includes('admin') ?? false,
  });

  const modulesQ = useQuery({
    queryKey: ['rbac', 'modules'],
    queryFn: () => api.rbacListModules(),
    enabled: me?.roles.includes('admin') ?? false,
  });

  const actionsQ = useQuery({
    queryKey: ['rbac', 'actions'],
    queryFn: () => api.rbacListActions(),
    enabled: me?.roles.includes('admin') ?? false,
  });

  // Default-select the first role once we have the list.
  useEffect(() => {
    if (!selectedRole && rolesQ.data?.roles?.length) {
      setSelectedRole(rolesQ.data.roles[0]);
    }
  }, [rolesQ.data, selectedRole]);

  const gridQ = useQuery({
    queryKey: ['rbac', 'matrix', selectedRole],
    queryFn: () => api.rbacGetRoleGrid(selectedRole),
    enabled: !!selectedRole && (me?.roles.includes('admin') ?? false),
  });

  // Reset the draft whenever the server grid arrives.
  useEffect(() => {
    if (gridQ.data?.permissions) {
      setDraft(JSON.parse(JSON.stringify(gridQ.data.permissions)) as RbacGrantsGrid);
      setSaveError(null);
    }
  }, [gridQ.data]);

  const modulesByCategory = useMemo(() => {
    const out: Record<string, RbacModuleDef[]> = {};
    for (const m of modulesQ.data?.modules ?? []) {
      out[m.category] ??= [];
      out[m.category].push(m);
    }
    return out;
  }, [modulesQ.data]);

  const isDirty = useMemo(() => {
    const server = gridQ.data?.permissions ?? emptyGrid(modulesQ.data?.modules ?? []);
    return !gridsEqual(server, draft);
  }, [gridQ.data, draft, modulesQ.data]);

  const saveMut = useMutation({
    mutationFn: () => {
      const server = gridQ.data?.permissions ?? emptyGrid(modulesQ.data?.modules ?? []);
      const changed = diffGrants(server, draft);
      return api.rbacPutRoleGrid(selectedRole, changed);
    },
    onSuccess: () => {
      setSaveError(null);
      qc.invalidateQueries({ queryKey: ['rbac', 'matrix', selectedRole] });
      qc.invalidateQueries({ queryKey: ['rbac-me'] });
    },
    onError: (err) => setSaveError(humanizeError(err, 'Save failed.')),
  });

  if (me && !me.roles.includes('admin')) return <Navigate to="/" replace />;

  const grantedCount = countGranted(draft);
  const totalCells = (modulesQ.data?.modules?.length ?? 0) * RBAC_ACTIONS.length;
  const loading = rolesQ.isLoading || modulesQ.isLoading || actionsQ.isLoading;

  function toggle(module_id: string, action: RbacAction) {
    setDraft((d) => ({
      ...d,
      [module_id]: { ...(d[module_id] ?? {}), [action]: !(d[module_id]?.[action] ?? false) } as Record<RbacAction, boolean>,
    }));
  }

  function selectAllForModule(module_id: string, on: boolean) {
    setDraft((d) => {
      const row: Record<RbacAction, boolean> = { ...(d[module_id] ?? {}) } as Record<RbacAction, boolean>;
      for (const a of RBAC_ACTIONS) row[a] = on;
      return { ...d, [module_id]: row };
    });
  }

  function revert() {
    if (gridQ.data?.permissions) {
      setDraft(JSON.parse(JSON.stringify(gridQ.data.permissions)) as RbacGrantsGrid);
      setSaveError(null);
    }
  }

  return (
    <div data-testid="permission-matrix-page">
      <PageHeader
        title="Permission Matrix"
        subtitle={
          loading
            ? 'Loading…'
            : `${grantedCount} of ${totalCells} cells granted · ${modulesQ.data?.modules?.length ?? 0} modules × ${RBAC_ACTIONS.length} actions`
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ['rbac'] })}>
              <RefreshCw size={14} className="mr-1.5" />
              Refresh
            </Button>
            <Button
              onClick={revert}
              variant="ghost"
              disabled={!isDirty}
              data-testid="permission-matrix-revert"
            >
              Revert
            </Button>
            <Button
              onClick={() => saveMut.mutate()}
              disabled={!isDirty || saveMut.isPending}
              loading={saveMut.isPending}
              data-testid="permission-matrix-save"
            >
              <Save size={14} className="mr-1.5" />
              Save changes
            </Button>
          </div>
        }
      />

      {saveError && (
        <p
          role="alert"
          className="mb-3 rounded border border-danger/20 bg-danger-bg px-3 py-2 text-sm text-danger"
          data-testid="permission-matrix-save-error"
        >
          {saveError}
        </p>
      )}

      <Panel title="Role" className="mb-4">
        <div className="flex flex-wrap gap-2" data-testid="permission-matrix-role-picker">
          {(rolesQ.data?.roles ?? []).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                if (isDirty && !window.confirm('Discard unsaved changes?')) return;
                setSelectedRole(r);
              }}
              className={
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors ' +
                (r === selectedRole
                  ? 'border-action bg-action text-white'
                  : 'border-divider bg-surface text-ink hover:border-action hover:text-action')
              }
              data-testid={`permission-matrix-role-${r}`}
              aria-pressed={r === selectedRole}
            >
              {r}
            </button>
          ))}
        </div>
      </Panel>

      {!selectedRole && (
        <Panel>
          <p className="caption">Pick a role above to edit its permission grid.</p>
        </Panel>
      )}

      {selectedRole && gridQ.isLoading && (
        <Panel>
          <Loader2 className="animate-spin" />
        </Panel>
      )}

      {selectedRole && gridQ.isError && (
        <Panel>
          <p className="text-danger text-sm">
            <AlertCircle size={14} className="inline mr-1" />
            Failed to load role grid.
          </p>
        </Panel>
      )}

      {selectedRole && gridQ.data && (
        <div className="space-y-4">
          {Object.entries(modulesByCategory).map(([category, modules]) => (
            <Panel key={category} title={category}>
              <div className="overflow-x-auto">
                <table
                  className="min-w-full text-sm"
                  data-testid={`permission-matrix-table-${category}`}
                >
                  <thead className="border-b border-divider bg-divider/10 text-left text-xs uppercase text-muted">
                    <tr>
                      <th className="px-3 py-2 w-72">Module</th>
                      {(actionsQ.data?.actions ?? []).map((a) => (
                        <th key={a.id} className="px-3 py-2 text-center">
                          {a.label}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-right">All</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modules.map((m) => {
                      const rowAll = RBAC_ACTIONS.every((a) => draft[m.id]?.[a]);
                      return (
                        <tr
                          key={m.id}
                          className="border-b border-divider/30 last:border-b-0"
                          data-testid={`permission-matrix-row-${m.id}`}
                        >
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium text-ink text-[13px]">{m.label}</div>
                            <div className="text-[11px] text-muted leading-tight">{m.description}</div>
                            <div className="mt-1">
                              <Badge tone={m.domain === 'both' ? 'neutral' : m.domain === 'banking' ? 'blue' : 'success'}>
                                {m.domain}
                              </Badge>
                            </div>
                          </td>
                          {(actionsQ.data?.actions ?? []).map((a) => {
                            const granted = !!draft[m.id]?.[a.id];
                            return (
                              <td key={a.id} className="px-3 py-2 text-center">
                                <button
                                  type="button"
                                  onClick={() => toggle(m.id, a.id)}
                                  aria-pressed={granted}
                                  aria-label={`${m.label} ${a.label}`}
                                  className="inline-flex items-center justify-center"
                                  data-testid={`permission-cell-${m.id}-${a.id}`}
                                >
                                  {granted ? (
                                    <CheckSquare size={18} className="text-action" />
                                  ) : (
                                    <Square size={18} className="text-muted" />
                                  )}
                                </button>
                              </td>
                            );
                          })}
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => selectAllForModule(m.id, !rowAll)}
                              className="text-[11px] underline-offset-2 hover:underline text-action"
                              data-testid={`permission-row-toggle-${m.id}`}
                            >
                              {rowAll ? 'Clear' : 'All'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          ))}

          <Panel>
            <p className="caption flex items-center gap-2">
              <ShieldCheck size={14} className="text-success" />
              The legacy <code>requireRole('op')</code> middleware is unchanged.
              This matrix adds an overlay — new routes use{' '}
              <code>requireModulePermission(module, action)</code>; the SPA{' '}
              <code>useCan(module, action)</code> hook gates UI elements off the
              same data.
            </p>
          </Panel>
        </div>
      )}
    </div>
  );
}
