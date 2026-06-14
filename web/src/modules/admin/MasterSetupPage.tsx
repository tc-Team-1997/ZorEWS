// web/src/modules/admin/MasterSetupPage.tsx
//
// Module 5.1 — Master Setup.
//
// Single source of truth for reference / master data. Tabbed UI over
// the 16 master_types served by the unified /v1/master/:type CRUD
// surface (services/bff/src/missing_masters.ts):
//
//   countries (proxy to geographies master — separate from missing_masters
//             since it predates this module), currencies, source_types,
//   severity_levels, borrower_segments, regulators, financial_ratios,
//   review_cadences, reference_data, roles_master, reassign_basis,
//   reassign_teams, recipients, schedule_formats, schedule_frequencies,
//   ai_models, rule_categories.
//
// Per-row "where used" modal queries /:type/:id/where-used; delete is
// pre-flighted then refused with 409 EWS_409_in_use if references exist.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  // Search icon reserved for future search-action
  Trash2,
} from 'lucide-react';
import { Badge, Button, Input, Modal, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  api,
  type MasterRow,
  type WhereUsedReport,
} from '@/lib/api';

interface MasterTab {
  id: string;
  label: string;
  description: string;
  required_attrs: string[];
}

// The catalogue mirrors REQUIRED_ATTRS in missing_masters.ts. Keys are
// the master_type strings the BFF accepts on /v1/master/:type.
const TABS: MasterTab[] = [
  { id: 'currencies', label: 'Currencies', description: 'ISO currency with decimals + rounding rules', required_attrs: ['symbol', 'decimals'] },
  { id: 'source_types', label: 'Source Types', description: 'Source connector type catalog', required_attrs: ['category'] },
  { id: 'severity_levels', label: 'Severity Levels', description: 'S1/S2/S3 definitions with colour codes', required_attrs: ['rank'] },
  { id: 'borrower_segments', label: 'Borrower Segments', description: 'Retail / SME / Corporate / Large Corporate / NBFC', required_attrs: [] },
  { id: 'regulators', label: 'Regulators', description: 'RBI, IRDAI, RMA, CBK, MAS — per-country', required_attrs: ['country', 'framework'] },
  { id: 'financial_ratios', label: 'Financial Ratios', description: 'Ratio definitions used in Financial Ratios screen', required_attrs: ['formula', 'polarity'] },
  { id: 'review_cadences', label: 'Review Cadences', description: 'daily/weekly/monthly/quarterly/annual', required_attrs: ['interval_days'] },
  { id: 'reference_data', label: 'Reference Data', description: 'Generic key-value reference data', required_attrs: ['namespace'] },
  { id: 'roles_master', label: 'Roles', description: 'RBAC role definitions', required_attrs: [] },
  { id: 'reassign_basis', label: 'Reassign Basis', description: 'Used in case reassignment', required_attrs: [] },
  { id: 'reassign_teams', label: 'Reassign Teams', description: 'Branch/department teams for reassignment', required_attrs: ['team_lead'] },
  { id: 'recipients', label: 'Recipients', description: 'Email/SMS/push recipient groups', required_attrs: ['channel', 'address'] },
  { id: 'schedule_formats', label: 'Schedule Formats', description: 'Report output formats (pdf, excel, csv)', required_attrs: ['mime_type'] },
  { id: 'schedule_frequencies', label: 'Schedule Frequencies', description: 'Reports scheduler frequencies', required_attrs: ['interval_days'] },
  { id: 'ai_models', label: 'AI Model Config', description: 'Per-model default config overrides', required_attrs: ['model_type'] },
  { id: 'rule_categories', label: 'Rule Categories', description: 'Operator-defined rule categories', required_attrs: [] },
];

export function MasterSetupPage() {
  const [activeTab, setActiveTab] = useState<string>(TABS[0]!.id);
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<MasterRow | null>(null);
  const [whereUsedTarget, setWhereUsedTarget] = useState<MasterRow | null>(null);

  const user = useAuth((s) => s.user);
  const canMutate = user?.roles.includes('admin') ?? false;

  const tab = useMemo(() => TABS.find((t) => t.id === activeTab) ?? TABS[0]!, [activeTab]);

  const qc = useQueryClient();
  const listQ = useQuery({
    queryKey: ['m51-master', activeTab, q],
    queryFn: () => api.masterList(activeTab, q ? { q } : {}),
  });
  const records = listQ.data?.records ?? [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Master Setup"
        subtitle="Reference data — single source of truth across the app"
        actions={
          canMutate ? (
            <Button
              variant="primary"
              onClick={() => setShowCreate(true)}
              data-testid="ms-create-btn"
            >
              <Plus size={14} /> Add {tab.label}
            </Button>
          ) : null
        }
      />

      <Panel title="Masters">
        <div className="flex flex-wrap gap-1 border-b border-divider/40 mb-4" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              onClick={() => {
                setActiveTab(t.id);
                setQ('');
              }}
              className={`px-3 py-2 text-sm border-b-2 transition-colors ${
                activeTab === t.id
                  ? 'border-action text-action font-medium'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
              data-testid={`ms-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted mb-4">{tab.description}</p>

        <div className="flex gap-2 mb-4">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by code or name…"
            data-testid="ms-search"
          />
          <Button
            variant="ghost"
            onClick={() => qc.invalidateQueries({ queryKey: ['m51-master', activeTab] })}
            data-testid="ms-refresh"
          >
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>

        {listQ.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : records.length === 0 ? (
          <p
            className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted"
            data-testid="ms-empty"
          >
            No {tab.label.toLowerCase()} records yet.
            {canMutate && ` Click Add ${tab.label} to register the first row.`}
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="ms-table">
            <thead className="text-left text-xs uppercase text-muted">
              <tr className="border-b border-divider/40">
                <th className="py-2">Code</th>
                <th>Name</th>
                <th>Attributes</th>
                <th>Status</th>
                <th>Updated</th>
                {canMutate && <th></th>}
              </tr>
            </thead>
            <tbody>
              {records.map((row) => (
                <tr
                  key={row.record_id}
                  className="border-b border-divider/40 hover:bg-divider/10"
                  data-testid={`ms-row-${row.code}`}
                >
                  <td className="py-2 font-mono text-xs">{row.code}</td>
                  <td>
                    <div className="font-medium">{row.name}</div>
                    {row.description && (
                      <div className="text-xs text-muted">{row.description}</div>
                    )}
                  </td>
                  <td className="text-xs">
                    <code className="rounded bg-divider/20 px-2 py-0.5">
                      {Object.entries(row.attributes)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ') || '—'}
                    </code>
                  </td>
                  <td>
                    <Badge tone={row.enabled ? 'success' : 'danger'}>
                      {row.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </td>
                  <td className="text-xs">
                    {new Date(row.updated_at).toLocaleDateString()}
                  </td>
                  {canMutate && (
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          onClick={() => setWhereUsedTarget(row)}
                          data-testid={`ms-where-used-${row.code}`}
                          aria-label={`Where used: ${row.code}`}
                        >
                          <Eye size={12} />
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setEditTarget(row)}
                          data-testid={`ms-edit-${row.code}`}
                          aria-label={`Edit ${row.code}`}
                        >
                          <Pencil size={12} />
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setWhereUsedTarget(row)}
                          data-testid={`ms-delete-${row.code}`}
                          aria-label={`Delete ${row.code}`}
                          title="Delete (opens where-used pre-flight)"
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {showCreate && (
        <CreateModal
          tab={tab}
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['m51-master', activeTab] });
          }}
        />
      )}
      {editTarget && (
        <EditModal
          tab={tab}
          row={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => {
            setEditTarget(null);
            qc.invalidateQueries({ queryKey: ['m51-master', activeTab] });
          }}
        />
      )}
      {whereUsedTarget && (
        <WhereUsedModal
          tab={tab}
          row={whereUsedTarget}
          onClose={() => setWhereUsedTarget(null)}
          onDeleted={() => {
            setWhereUsedTarget(null);
            qc.invalidateQueries({ queryKey: ['m51-master', activeTab] });
          }}
        />
      )}
    </div>
  );
}

type ParseResult =
  | { ok: true; value: Record<string, string | number | boolean> }
  | { ok: false; error: string };

function parseAttributes(raw: string): ParseResult {
  // Parse "k=v, k2=v2" — coerce numeric + boolean literals.
  if (!raw.trim()) return { ok: true, value: {} };
  const out: Record<string, string | number | boolean> = {};
  for (const pair of raw.split(',')) {
    const p = pair.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 0) return { ok: false, error: `attribute "${p}" missing '='` };
    const k = p.slice(0, eq).trim();
    const vRaw = p.slice(eq + 1).trim();
    if (!k) return { ok: false, error: `empty key in "${p}"` };
    if (vRaw === 'true') out[k] = true;
    else if (vRaw === 'false') out[k] = false;
    else if (vRaw !== '' && !Number.isNaN(Number(vRaw))) out[k] = Number(vRaw);
    else out[k] = vRaw;
  }
  return { ok: true, value: out };
}

function CreateModal({
  tab,
  onClose,
  onSuccess,
}: {
  tab: MasterTab;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [attrsRaw, setAttrsRaw] = useState(
    tab.required_attrs.map((a) => `${a}=`).join(', '),
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => {
      const parsed = parseAttributes(attrsRaw);
      if (!parsed.ok) throw new Error(parsed.error);
      return api.masterCreate(tab.id, {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim() || undefined,
        attributes: parsed.value,
      });
    },
    onSuccess,
    onError: (err: unknown) => {
      const e = err as { body?: { error?: { message?: string } }; message?: string };
      setErrMsg(e.body?.error?.message ?? e.message ?? 'Create failed');
    },
  });

  return (
    <Modal open onClose={onClose} ariaLabel={`Add ${tab.label}`} size="lg" testId="ms-create-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add {tab.label}</h2>
        </header>
        <p className="text-xs text-muted">{tab.description}</p>
        {errMsg && (
          <div
            className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
            data-testid="ms-create-error"
          >
            <AlertTriangle size={14} className="inline mr-1" /> {errMsg}
          </div>
        )}
        <Input
          label="Code (uppercase, A-Z 0-9 _ )"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. INR"
          data-testid="ms-create-code"
        />
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Display name"
          data-testid="ms-create-name"
        />
        <Input
          label="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="ms-create-desc"
        />
        <label className="block text-xs text-muted">
          Attributes — {tab.required_attrs.length === 0
            ? 'none required'
            : `required: ${tab.required_attrs.join(', ')}`}
          <textarea
            value={attrsRaw}
            onChange={(e) => setAttrsRaw(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm font-mono"
            placeholder="key=value, key2=value2"
            data-testid="ms-create-attrs"
          />
          <span className="text-xs text-muted block mt-1">
            Numbers + booleans auto-coerced. Use comma to separate.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => m.mutate()}
            disabled={m.isPending || !code.trim() || !name.trim()}
            data-testid="ms-create-submit"
          >
            {m.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EditModal({
  tab,
  row,
  onClose,
  onSuccess,
}: {
  tab: MasterTab;
  row: MasterRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description);
  const [enabled, setEnabled] = useState(row.enabled);
  const [attrsRaw, setAttrsRaw] = useState(
    Object.entries(row.attributes)
      .map(([k, v]) => `${k}=${v}`)
      .join(', '),
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => {
      const parsed = parseAttributes(attrsRaw);
      if (!parsed.ok) throw new Error(parsed.error);
      return api.masterUpdate(tab.id, row.record_id, {
        name,
        description,
        attributes: parsed.value,
        enabled,
      });
    },
    onSuccess,
    onError: (err: unknown) => {
      const e = err as { body?: { error?: { message?: string } }; message?: string };
      setErrMsg(e.body?.error?.message ?? e.message ?? 'Update failed');
    },
  });

  return (
    <Modal open onClose={onClose} ariaLabel={`Edit ${row.code}`} size="lg" testId="ms-edit-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Edit <span className="font-mono">{row.code}</span>
          </h2>
        </header>
        {errMsg && (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            <AlertTriangle size={14} className="inline mr-1" /> {errMsg}
          </div>
        )}
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid="ms-edit-name" />
        <Input
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="ms-edit-desc"
        />
        <label className="block text-xs text-muted">
          Attributes
          <textarea
            value={attrsRaw}
            onChange={(e) => setAttrsRaw(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm font-mono"
            data-testid="ms-edit-attrs"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            data-testid="ms-edit-enabled"
          />
          Enabled
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => m.mutate()}
            disabled={m.isPending}
            data-testid="ms-edit-submit"
          >
            {m.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function WhereUsedModal({
  tab,
  row,
  onClose,
  onDeleted,
}: {
  tab: MasterTab;
  row: MasterRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [deleteErr, setDeleteErr] = useState<{
    code?: string;
    message?: string;
    total?: number;
    references?: WhereUsedReport['references'];
  } | null>(null);

  const usageQ = useQuery({
    queryKey: ['m51-where-used', tab.id, row.record_id],
    queryFn: () => api.masterWhereUsed(tab.id, row.record_id),
    retry: false,
  });

  const del = useMutation({
    mutationFn: () => api.masterDelete(tab.id, row.record_id),
    onSuccess: () => onDeleted(),
    onError: (err: unknown) => {
      const e = err as {
        body?: {
          error?: {
            code?: string;
            message?: string;
            detail?: { total_references?: number; references?: WhereUsedReport['references'] };
          };
        };
        message?: string;
      };
      setDeleteErr({
        code: e.body?.error?.code,
        message: e.body?.error?.message ?? e.message ?? 'Delete failed',
        total: e.body?.error?.detail?.total_references,
        references: e.body?.error?.detail?.references,
      });
    },
  });

  const total = usageQ.data?.total_references ?? 0;
  const canDelete = total === 0 && !del.isPending;

  return (
    <Modal open onClose={onClose} ariaLabel={`Where used: ${row.code}`} size="2xl" testId="ms-whereused-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Where used: <span className="font-mono">{row.code}</span>
          </h2>
        </header>
        <p className="text-xs text-muted">{tab.label} · {row.name}</p>
        {usageQ.isLoading ? (
          <p className="text-sm text-muted">Loading references…</p>
        ) : (
          <>
            <div
              className={`rounded border p-3 text-sm ${
                total === 0
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-warning/40 bg-warning/10 text-warning'
              }`}
              data-testid="ms-whereused-summary"
            >
              {total === 0 ? (
                <>
                  No references found — this row is safe to delete.
                </>
              ) : (
                <>
                  <AlertTriangle size={14} className="inline mr-1" />
                  In use by <strong>{total}</strong> record{total === 1 ? '' : 's'} —
                  delete will be refused with <code>EWS_409_in_use</code>.
                </>
              )}
            </div>
            {usageQ.data && usageQ.data.references.length > 0 && (
              <table className="w-full text-sm" data-testid="ms-whereused-table">
                <thead className="text-left text-xs uppercase text-muted">
                  <tr className="border-b border-divider/40">
                    <th className="py-2">Resource</th>
                    <th>ID</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {usageQ.data.references.map((ref, i) => (
                    <tr
                      key={`${ref.resource_type}-${ref.resource_id}-${i}`}
                      className="border-b border-divider/40"
                    >
                      <td className="py-2 text-xs">{ref.resource_type}</td>
                      <td className="text-xs font-mono">{ref.resource_id}</td>
                      <td className="text-xs">{ref.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {deleteErr && (
              <div className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
                <AlertTriangle size={14} className="inline mr-1" />
                <strong>{deleteErr.code}</strong>: {deleteErr.message}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button
                variant="danger"
                onClick={() => del.mutate()}
                disabled={!canDelete}
                data-testid="ms-whereused-delete"
              >
                {del.isPending ? 'Deleting…' : 'Delete row'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
