// web/src/modules/admin/masters/MasterEntityPage.tsx
//
// Phase 9 T11 — reusable master entity CRUD page.
//
// One component renders the admin surface for ANY master entity
// registered in services/bff/src/masters/registry.ts. The entity slug
// comes from the route param (/admin/masters/:entity) — the page
// fetches the schema dynamically + renders form inputs per
// Phase9MasterField.type (string/integer/number/boolean/enum), then a
// rowtable with edit/delete actions per row.
//
// Adding a 26th entity needs ZERO frontend changes — declare the
// schema in the BFF registry + add a nav entry pointing to
// /admin/masters/<new-entity>.

import { useState, type FormEvent } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Save, Trash2, X, AlertCircle } from 'lucide-react';
import { Badge, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { api, type Phase9MasterField, type Phase9MasterRow } from '@/lib/api';

interface EditingState {
  /** Row being edited (null = creating a new row, undefined = closed). */
  row: Phase9MasterRow | null;
  fields: Record<string, unknown>;
}

function humanizeError(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: { message?: string } } | undefined;
    if (body?.error?.message) return body.error.message;
  }
  return fallback;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Phase9MasterField;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const label = field.label ?? field.name;
  if (field.type === 'enum') {
    return (
      <label className="block">
        <span className="block text-[11px] font-medium text-ink mb-1">
          {label}{field.required && <span className="text-danger ml-0.5">*</span>}
        </span>
        <select
          className="input"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`master-field-${field.name}`}
        >
          <option value="">— select —</option>
          {field.enum_values?.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.type === 'boolean') {
    return (
      <label className="block">
        <span className="block text-[11px] font-medium text-ink mb-1">{label}</span>
        <select
          className="input"
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(e) =>
            onChange(e.target.value === 'true' ? true : e.target.value === 'false' ? false : undefined)
          }
          data-testid={`master-field-${field.name}`}
        >
          <option value="">— select —</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
    );
  }
  if (field.type === 'integer' || field.type === 'number') {
    return (
      <label className="block">
        <span className="block text-[11px] font-medium text-ink mb-1">
          {label}{field.required && <span className="text-danger ml-0.5">*</span>}
        </span>
        <Input
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange(undefined);
            } else {
              const n = field.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
              onChange(Number.isFinite(n) ? n : undefined);
            }
          }}
          data-testid={`master-field-${field.name}`}
        />
      </label>
    );
  }
  // default: string
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-ink mb-1">
        {label}{field.required && <span className="text-danger ml-0.5">*</span>}
        {field.max_length && (
          <span className="text-[10px] text-muted ml-1">(max {field.max_length})</span>
        )}
      </span>
      <Input
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        maxLength={field.max_length}
        data-testid={`master-field-${field.name}`}
      />
    </label>
  );
}

export function MasterEntityPage() {
  const { entity } = useParams<{ entity: string }>();
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['master-entity', entity],
    queryFn: () => api.mastersFwListRows(entity!),
    enabled: !!entity && (me?.roles.includes('admin') ?? false),
  });

  const createMut = useMutation({
    mutationFn: (fields: Record<string, unknown>) => api.mastersFwCreateRow(entity!, fields),
    onSuccess: () => {
      setEditing(null);
      setFormError(null);
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['master-entity', entity] });
    },
    onError: (err) => setFormError(humanizeError(err, 'Create failed.')),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: Record<string, unknown> }) =>
      api.mastersFwUpdateRow(entity!, id, fields),
    onSuccess: () => {
      setEditing(null);
      setFormError(null);
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['master-entity', entity] });
    },
    onError: (err) => setFormError(humanizeError(err, 'Update failed.')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.mastersFwDeleteRow(entity!, id),
    onSuccess: () => {
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['master-entity', entity] });
    },
    onError: (err) => setRowError(humanizeError(err, 'Delete failed.')),
  });

  // Render the form columns from the schema so the page works for any
  // entity without per-entity coding.
  const fields: Phase9MasterField[] = q.data?.fields ?? [];

  if (me && !me.roles.includes('admin')) {
    return <Navigate to="/" replace />;
  }
  if (!entity) {
    return <Navigate to="/admin/masters" replace />;
  }

  function startCreate() {
    setEditing({ row: null, fields: {} });
    setFormError(null);
  }
  function startEdit(row: Phase9MasterRow) {
    setEditing({ row, fields: { ...row.fields } });
    setFormError(null);
  }
  function cancelEdit() {
    setEditing(null);
    setFormError(null);
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    if (editing.row) {
      updateMut.mutate({ id: editing.row.id, fields: editing.fields });
    } else {
      createMut.mutate(editing.fields);
    }
  }
  function onDelete(row: Phase9MasterRow) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete this ${q.data?.label ?? 'row'}?`)) {
      return;
    }
    deleteMut.mutate(row.id);
  }

  const title = q.data?.label_plural ?? entity;
  const rows = q.data?.rows ?? [];

  return (
    <div data-testid={`master-entity-page-${entity}`}>
      <PageHeader
        title={title}
        subtitle={
          q.isLoading
            ? 'Loading…'
            : q.isError
              ? 'Failed to load.'
              : `${rows.length} ${rows.length === 1 ? q.data?.label?.toLowerCase() : q.data?.label_plural?.toLowerCase()} · ${
                  q.data?.tenant_scoped ? 'tenant-scoped' : 'platform-static'
                }`
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => qc.invalidateQueries({ queryKey: ['master-entity', entity] })}
            >
              <RefreshCw size={14} className="mr-1.5" />
              Refresh
            </Button>
            <Button onClick={startCreate} data-testid="master-new-row">
              <Plus size={14} className="mr-1.5" />
              New {q.data?.label ?? 'row'}
            </Button>
          </div>
        }
      />

      {rowError && (
        <p role="alert" className="mb-3 rounded border border-danger/20 bg-danger-bg px-3 py-2 text-sm text-danger">
          {rowError}
        </p>
      )}

      {editing && (
        <Panel
          title={editing.row ? `Edit ${q.data?.label}` : `Create ${q.data?.label}`}
          className="mb-4"
          action={
            <Button variant="ghost" onClick={cancelEdit}>
              <X size={14} className="mr-1.5" />
              Cancel
            </Button>
          }
        >
          <form onSubmit={onSubmit} className="space-y-3" data-testid="master-form">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {fields.map((f) => (
                <FieldInput
                  key={f.name}
                  field={f}
                  value={editing.fields[f.name]}
                  onChange={(next) =>
                    setEditing((s) =>
                      s ? { ...s, fields: { ...s.fields, [f.name]: next } } : s,
                    )
                  }
                />
              ))}
            </div>
            {formError && (
              <p role="alert" className="flex items-center gap-2 text-sm text-danger" data-testid="master-form-error">
                <AlertCircle size={14} /> {formError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={createMut.isPending || updateMut.isPending}
                data-testid="master-save"
              >
                <Save size={14} className="mr-1.5" />
                Save
              </Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel title="Rows">
        {q.isLoading ? (
          <p className="caption">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="caption" data-testid="master-empty">
            No rows yet. Click "New {q.data?.label}" to add one.
          </p>
        ) : (
          <div className="overflow-x-auto" data-testid="master-table">
            <table className="min-w-full text-sm">
              <thead className="border-b border-divider bg-divider/10 text-left text-xs uppercase text-muted">
                <tr>
                  {fields.map((f) => (
                    <th key={f.name} className="px-3 py-2">{f.label ?? f.name}</th>
                  ))}
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={`master-row-${row.id}`}
                    className="border-b border-divider/30 last:border-b-0"
                  >
                    {fields.map((f) => (
                      <td key={f.name} className="px-3 py-2 text-xs">
                        {renderCell(row.fields[f.name])}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-xs">
                      <div className="font-medium">{row.updated_by}</div>
                      <div className="text-muted">
                        {new Date(row.updated_at).toLocaleString()}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(row)}
                          data-testid={`master-edit-${row.id}`}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDelete(row)}
                          disabled={deleteMut.isPending}
                          data-testid={`master-delete-${row.id}`}
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

function renderCell(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span className="text-muted">—</span>;
  if (typeof v === 'boolean') {
    return <Badge tone={v ? 'success' : 'neutral'}>{String(v)}</Badge>;
  }
  return String(v);
}
