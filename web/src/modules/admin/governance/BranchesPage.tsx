// web/src/modules/admin/governance/BranchesPage.tsx
//
// Enterprise Tenant Governance — branches admin page (T11-style).
//
// Lists every branch with filters (tenant_id, country_code, active_only).
// Header chips for the per-branch metadata. Inline edit/delete actions.
// Drives the BFF /v1/governance/branches CRUD.

import { useMemo, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  AlertCircle,
  Building2,
  Globe,
} from 'lucide-react';
import { Badge, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { HttpError } from '@/lib/http';
import {
  api,
  type GovernanceBranch,
  type GovernanceBranchInput,
  type GovernanceBranchPatch,
} from '@/lib/api';

interface EditingState {
  row: GovernanceBranch | null;
  fields: {
    tenant_id: string;
    country_code: string;
    code: string;
    name: string;
    city: string;
    state: string;
    address: string;
    phone: string;
    email: string;
    active: boolean;
  };
}

function humanizeError(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: { message?: string } } | undefined;
    if (body?.error?.message) return body.error.message;
  }
  return fallback;
}

function newDraft(): EditingState['fields'] {
  return {
    tenant_id: '',
    country_code: 'IN',
    code: '',
    name: '',
    city: '',
    state: '',
    address: '',
    phone: '',
    email: '',
    active: true,
  };
}

function draftFromRow(row: GovernanceBranch): EditingState['fields'] {
  return {
    tenant_id: row.tenant_id,
    country_code: row.country_code,
    code: row.code,
    name: row.name,
    city: row.city ?? '',
    state: row.state ?? '',
    address: row.address ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    active: row.active,
  };
}

export function BranchesPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [filterTenant, setFilterTenant] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['governance', 'branches', filterTenant, filterCountry, activeOnly],
    queryFn: () =>
      api.governanceListBranches({
        tenant_id: filterTenant || undefined,
        country_code: filterCountry || undefined,
        active_only: activeOnly || undefined,
      }),
    enabled: me?.roles.includes('admin') ?? false,
  });

  const createMut = useMutation({
    mutationFn: (input: GovernanceBranchInput) => api.governanceCreateBranch(input),
    onSuccess: () => {
      setEditing(null);
      setFormError(null);
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['governance', 'branches'] });
    },
    onError: (err) => setFormError(humanizeError(err, 'Create failed.')),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: GovernanceBranchPatch }) =>
      api.governancePatchBranch(id, patch),
    onSuccess: () => {
      setEditing(null);
      setFormError(null);
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['governance', 'branches'] });
    },
    onError: (err) => setFormError(humanizeError(err, 'Update failed.')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.governanceDeleteBranch(id),
    onSuccess: () => {
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['governance', 'branches'] });
    },
    onError: (err) => setRowError(humanizeError(err, 'Delete failed.')),
  });

  if (me && !me.roles.includes('admin')) return <Navigate to="/" replace />;

  function startCreate() {
    setEditing({ row: null, fields: newDraft() });
    setFormError(null);
  }
  function startEdit(row: GovernanceBranch) {
    setEditing({ row, fields: draftFromRow(row) });
    setFormError(null);
  }
  function cancel() {
    setEditing(null);
    setFormError(null);
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const base = {
      tenant_id: editing.fields.tenant_id.trim(),
      country_code: editing.fields.country_code.trim(),
      code: editing.fields.code.trim(),
      name: editing.fields.name.trim(),
      city: editing.fields.city.trim() || null,
      state: editing.fields.state.trim() || null,
      address: editing.fields.address.trim() || null,
      phone: editing.fields.phone.trim() || null,
      email: editing.fields.email.trim() || null,
      active: editing.fields.active,
    };
    if (editing.row) {
      updateMut.mutate({ id: editing.row.branch_id, patch: base });
    } else {
      createMut.mutate(base as GovernanceBranchInput);
    }
  }
  function onDelete(row: GovernanceBranch) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete branch ${row.code}?`)) return;
    deleteMut.mutate(row.branch_id);
  }

  const rows = q.data?.branches ?? [];
  const distinctTenants = useMemo(() => Array.from(new Set(rows.map((r) => r.tenant_id))).sort(), [rows]);
  const distinctCountries = useMemo(() => Array.from(new Set(rows.map((r) => r.country_code))).sort(), [rows]);

  return (
    <div data-testid="branches-page">
      <PageHeader
        title="Branches"
        subtitle={
          q.isLoading
            ? 'Loading…'
            : q.isError
              ? 'Failed to load.'
              : `${rows.length} ${rows.length === 1 ? 'branch' : 'branches'} · ${distinctTenants.length} tenants · ${distinctCountries.length} countries`
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ['governance', 'branches'] })}>
              <RefreshCw size={14} className="mr-1.5" />
              Refresh
            </Button>
            <Button onClick={startCreate} data-testid="branches-new-row">
              <Plus size={14} className="mr-1.5" />
              New branch
            </Button>
          </div>
        }
      />

      {rowError && (
        <p role="alert" className="mb-3 rounded border border-danger/20 bg-danger-bg px-3 py-2 text-sm text-danger">
          {rowError}
        </p>
      )}

      <Panel className="mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="branches-filters">
          <label className="block">
            <span className="block text-[11px] font-medium text-ink mb-1">Tenant</span>
            <select
              className="input"
              value={filterTenant}
              onChange={(e) => setFilterTenant(e.target.value)}
              data-testid="branches-filter-tenant"
            >
              <option value="">All tenants</option>
              {distinctTenants.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium text-ink mb-1">Country</span>
            <select
              className="input"
              value={filterCountry}
              onChange={(e) => setFilterCountry(e.target.value)}
              data-testid="branches-filter-country"
            >
              <option value="">All countries</option>
              {distinctCountries.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 mt-6">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
              data-testid="branches-filter-active"
            />
            <span className="text-sm text-ink">Active only</span>
          </label>
        </div>
      </Panel>

      {editing && (
        <Panel
          title={editing.row ? `Edit branch ${editing.row.code}` : 'Create branch'}
          className="mb-4"
          action={
            <Button variant="ghost" onClick={cancel}>
              <X size={14} className="mr-1.5" />
              Cancel
            </Button>
          }
        >
          <form onSubmit={onSubmit} className="space-y-3" data-testid="branches-form">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Tenant ID *</span>
                <Input
                  type="text"
                  value={editing.fields.tenant_id}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, fields: { ...s.fields, tenant_id: e.target.value } } : s))
                  }
                  disabled={!!editing.row}
                  required
                  data-testid="branches-field-tenant_id"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Country code *</span>
                <Input
                  type="text"
                  value={editing.fields.country_code}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, fields: { ...s.fields, country_code: e.target.value } } : s))
                  }
                  disabled={!!editing.row}
                  required
                  data-testid="branches-field-country_code"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Code *</span>
                <Input
                  type="text"
                  value={editing.fields.code}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, fields: { ...s.fields, code: e.target.value } } : s))
                  }
                  required
                  data-testid="branches-field-code"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Name *</span>
                <Input
                  type="text"
                  value={editing.fields.name}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, fields: { ...s.fields, name: e.target.value } } : s))
                  }
                  required
                  data-testid="branches-field-name"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">City</span>
                <Input
                  type="text"
                  value={editing.fields.city}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, fields: { ...s.fields, city: e.target.value } } : s))
                  }
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">State</span>
                <Input
                  type="text"
                  value={editing.fields.state}
                  onChange={(e) =>
                    setEditing((s) => (s ? { ...s, fields: { ...s.fields, state: e.target.value } } : s))
                  }
                />
              </label>
            </div>
            {formError && (
              <p role="alert" className="flex items-center gap-2 text-sm text-danger" data-testid="branches-form-error">
                <AlertCircle size={14} /> {formError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
              <Button
                type="submit"
                loading={createMut.isPending || updateMut.isPending}
                data-testid="branches-save"
              >
                <Save size={14} className="mr-1.5" /> Save
              </Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel title="Branches">
        {q.isLoading ? (
          <p className="caption">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="caption" data-testid="branches-empty">No branches match the filters.</p>
        ) : (
          <div className="overflow-x-auto" data-testid="branches-table">
            <table className="min-w-full text-sm">
              <thead className="border-b border-divider bg-divider/10 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Branch</th>
                  <th className="px-3 py-2">Tenant</th>
                  <th className="px-3 py-2">Country</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.branch_id}
                    data-testid={`branches-row-${row.branch_id}`}
                    className="border-b border-divider/30 last:border-b-0"
                  >
                    <td className="px-3 py-2 text-xs">
                      <div className="font-medium text-ink">{row.code}</div>
                      <div className="text-muted">{row.name}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="inline-flex items-center gap-1">
                        <Building2 size={12} className="text-muted" /> {row.tenant_id}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="inline-flex items-center gap-1">
                        <Globe size={12} className="text-muted" /> {row.country_code}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {[row.city, row.state].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={row.active ? 'success' : 'neutral'}>
                        {row.active ? 'active' : 'inactive'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(row)}
                          data-testid={`branches-edit-${row.branch_id}`}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDelete(row)}
                          disabled={deleteMut.isPending}
                          data-testid={`branches-delete-${row.branch_id}`}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
