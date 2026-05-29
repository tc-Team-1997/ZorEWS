// web/src/modules/admin/AccessControlConfigPage.tsx
//
// Configuration — Access Control Config (MASTER SETUP spec screen #20).
//
// Read-only viewer over the canonical RBAC matrix (infra/rbac/matrix.json).
// Operators see the role roster, per-role grant counts, and the full
// role × operation grid grouped by resource. There is no edit affordance —
// the matrix is version-controlled + CI-gated, not mutated at runtime — so
// this screen is the human-readable lens onto the authorisation contract.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Minus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { api, type AccessMatrixRowShape, type RbacRoleShape } from '@/lib/api';

const ROLE_LABEL: Record<RbacRoleShape, string> = {
  admin: 'Admin',
  risk_analyst: 'Risk Analyst',
  supervisor: 'Supervisor',
  collection_officer: 'Collection Officer',
  field_officer: 'Field Officer',
};

export function AccessControlConfigPage() {
  const [roleFilter, setRoleFilter] = useState<RbacRoleShape | 'all'>('all');

  const overviewQ = useQuery({ queryKey: ['acc-overview'], queryFn: () => api.accessControlOverview() });
  const matrixQ = useQuery({ queryKey: ['acc-matrix'], queryFn: () => api.accessControlMatrix() });

  const overview = overviewQ.data;
  const matrix = matrixQ.data;
  const roles = matrix?.roles ?? overview?.roles ?? [];

  // Group matrix rows by resource for the grid sections.
  const grouped = useMemo(() => {
    const rows = matrix?.rows ?? [];
    const byResource = new Map<string, AccessMatrixRowShape[]>();
    for (const r of rows) {
      const list = byResource.get(r.resource);
      if (list) list.push(r);
      else byResource.set(r.resource, [r]);
    }
    return Array.from(byResource.entries())
      .map(([resource, opRows]) => ({ resource, rows: opRows }))
      .sort((a, b) => a.resource.localeCompare(b.resource));
  }, [matrix]);

  const refresh = () => {
    overviewQ.refetch();
    matrixQ.refetch();
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Access Control Config"
        subtitle="RBAC matrix — roles · permissions · module access (read-only)"
        actions={
          <Button variant="ghost" onClick={refresh} data-testid="acc-refresh">
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Roles" value={String(overview?.total_roles ?? 0)} testId="acc-kpi-roles" />
        <MetricCard label="Operations" value={String(overview?.total_operations ?? 0)} testId="acc-kpi-operations" />
        <MetricCard label="Resources" value={String(overview?.total_resources ?? 0)} testId="acc-kpi-resources" />
        <MetricCard label="Matrix version" value={overview?.version ?? '—'} tone="blue" testId="acc-kpi-version" />
      </div>

      <div className="rounded border border-divider/60 bg-action/5 p-3 text-sm text-muted" data-testid="acc-readonly-note">
        <ShieldCheck size={14} className="inline mr-1 text-action" />
        The matrix is version-controlled in <code className="text-ink">infra/rbac/matrix.json</code> and enforced by a CI gate.
        This screen is read-only — edits land via a reviewed change to that file, not at runtime.
      </div>

      <Panel
        title={
          <span className="flex items-center gap-2">
            Roles <Badge tone="neutral">{overview?.role_summaries.length ?? 0} configured</Badge>
          </span>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3" data-testid="acc-role-cards">
          {(overview?.role_summaries ?? []).map((rs) => (
            <button
              key={rs.role}
              onClick={() => setRoleFilter((r) => (r === rs.role ? 'all' : rs.role))}
              data-testid={`acc-role-card-${rs.role}`}
              className={`rounded border p-3 text-left transition ${
                roleFilter === rs.role ? 'border-action bg-action/5 ring-1 ring-action/20' : 'border-divider/60 hover:border-action/40'
              }`}
              aria-pressed={roleFilter === rs.role}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">{ROLE_LABEL[rs.role]}</span>
                <Badge tone="blue">{rs.operation_count} ops</Badge>
              </div>
              {rs.description && <div className="mt-1 text-xs text-muted">{rs.description}</div>}
            </button>
          ))}
        </div>
      </Panel>

      <Panel
        title="Permission matrix"
        action={
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => setRoleFilter('all')}
              data-testid="acc-filter-all"
              className={`rounded px-2 py-1 text-xs font-medium ${roleFilter === 'all' ? 'bg-action text-white' : 'text-muted hover:text-ink'}`}
            >
              All roles
            </button>
            {roles.map((role) => (
              <button
                key={role}
                onClick={() => setRoleFilter(role)}
                data-testid={`acc-filter-${role}`}
                className={`rounded px-2 py-1 text-xs font-medium ${roleFilter === role ? 'bg-action text-white' : 'text-muted hover:text-ink'}`}
              >
                {ROLE_LABEL[role]}
              </button>
            ))}
          </div>
        }
      >
        {matrixQ.isLoading ? (
          <p className="text-sm text-muted">Loading matrix…</p>
        ) : grouped.length === 0 ? (
          <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted" data-testid="acc-empty">
            No operations in the matrix.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="acc-matrix-table">
              <thead className="text-left text-xs uppercase text-muted">
                <tr className="border-b border-divider/40">
                  <th className="py-2">Operation</th>
                  {roles
                    .filter((role) => roleFilter === 'all' || role === roleFilter)
                    .map((role) => (
                      <th key={role} className="w-28 text-center">{ROLE_LABEL[role]}</th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {grouped.map((group) => (
                  <RoleResourceSection
                    key={group.resource}
                    resource={group.resource}
                    rows={group.rows}
                    roles={roles.filter((role) => roleFilter === 'all' || role === roleFilter)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function RoleResourceSection({
  resource,
  rows,
  roles,
}: {
  resource: string;
  rows: AccessMatrixRowShape[];
  roles: RbacRoleShape[];
}) {
  return (
    <>
      <tr className="bg-divider/10" data-testid={`acc-resource-${resource}`}>
        <td colSpan={roles.length + 1} className="py-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted">
          {resource} <span className="font-normal normal-case">· {rows.length} ops</span>
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.operation} className="border-b border-divider/40 hover:bg-divider/10" data-testid={`acc-row-${row.operation}`}>
          <td className="py-2">
            <span className="font-mono text-xs text-ink">{row.action}</span>
          </td>
          {roles.map((role) => (
            <td key={role} className="text-center">
              {row.by_role[role] ? (
                <span data-testid={`acc-cell-${row.operation}-${role}`} className="inline-flex text-emerald-600" aria-label="granted">
                  <Check size={15} />
                </span>
              ) : (
                <span data-testid={`acc-cell-${row.operation}-${role}`} className="inline-flex text-divider" aria-label="denied">
                  <Minus size={15} />
                </span>
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
