// web/src/modules/admin/CaseTypeSetupPage.tsx
//
// Master Setup — Case Management Setup (MASTER SETUP spec screen #13).
//
// Per-tenant case-type master. Each type carries a default Priority (P1-P4),
// an SLA in hours, and a default Assigned Team. When the CMS opens a case of
// a given type these defaults seed the case. This is the editable TYPE
// catalogue the CMS case-creation picker draws from.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge, Button, Input, MetricCard, Modal, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  api,
  type CasePriorityShape,
  type CaseTypeShape,
} from '@/lib/api';

const PRIORITIES: CasePriorityShape[] = ['P1', 'P2', 'P3', 'P4'];
const PRIORITY_TONE: Record<CasePriorityShape, 'danger' | 'warning' | 'blue' | 'neutral'> = {
  P1: 'danger',
  P2: 'warning',
  P3: 'blue',
  P4: 'neutral',
};
const PRIORITY_FILTERS: (CasePriorityShape | 'all')[] = ['all', 'P1', 'P2', 'P3', 'P4'];

function fmtSla(hours: number): string {
  if (hours < 24) return `${hours}h`;
  const d = hours / 24;
  return Number.isInteger(d) ? `${d}d` : `${hours}h`;
}

export function CaseTypeSetupPage() {
  const qc = useQueryClient();
  const [priorityFilter, setPriorityFilter] = useState<CasePriorityShape | 'all'>('all');
  const [showCreate, setShowCreate] = useState(false);

  const user = useAuth((s) => s.user);
  const canEdit = user?.roles.includes('admin') ?? false;

  const listQ = useQuery({
    queryKey: ['cty-list', priorityFilter],
    queryFn: () => api.caseTypes(priorityFilter === 'all' ? {} : { priority: priorityFilter }),
  });
  const summaryQ = useQuery({ queryKey: ['cty-summary'], queryFn: () => api.caseTypeSummary() });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cty-list'] });
    qc.invalidateQueries({ queryKey: ['cty-summary'] });
  };

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.caseTypeDelete(id),
    onSuccess: invalidate,
  });

  const types = listQ.data?.case_types ?? [];
  const summary = summaryQ.data;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Case Management Setup"
        subtitle="Case types — default priority · SLA · assigned team"
        actions={
          canEdit ? (
            <Button variant="primary" onClick={() => setShowCreate(true)} data-testid="cty-create-btn">
              <Plus size={14} /> Add case type
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Case types" value={String(summary?.total ?? 0)} testId="cty-kpi-total" />
        <MetricCard label="Enabled" value={String(summary?.enabled_count ?? 0)} tone="success" testId="cty-kpi-enabled" />
        <MetricCard label="Fastest SLA" value={summary?.fastest_sla_hours != null ? fmtSla(summary.fastest_sla_hours) : '—'} testId="cty-kpi-fastest" />
        <MetricCard label="Slowest SLA" value={summary?.slowest_sla_hours != null ? fmtSla(summary.slowest_sla_hours) : '—'} testId="cty-kpi-slowest" />
      </div>

      <Panel
        title="Case types"
        action={
          <div className="flex items-center gap-2">
            {PRIORITY_FILTERS.map((p) => (
              <button
                key={p}
                onClick={() => setPriorityFilter(p)}
                data-testid={`cty-filter-${p}`}
                className={`rounded px-2 py-1 text-xs font-medium ${
                  priorityFilter === p ? 'bg-action text-white' : 'text-muted hover:text-ink'
                }`}
              >
                {p === 'all' ? 'All' : p}
              </button>
            ))}
            <Button variant="ghost" onClick={invalidate} data-testid="cty-refresh">
              <RefreshCw size={14} /> Refresh
            </Button>
          </div>
        }
      >
        {listQ.isLoading ? (
          <p className="text-sm text-muted">Loading case types…</p>
        ) : types.length === 0 ? (
          <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted" data-testid="cty-empty">
            No case types match this filter.{canEdit && ' Click Add case type to register one.'}
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="cty-table">
            <thead className="text-left text-xs uppercase text-muted">
              <tr className="border-b border-divider/40">
                <th className="py-2">Case type</th>
                <th className="w-20">Priority</th>
                <th className="w-20">SLA</th>
                <th>Assigned team</th>
                <th className="w-24">Status</th>
                {canEdit && <th className="w-16"></th>}
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <CaseTypeRow
                  key={t.case_type_id}
                  t={t}
                  canEdit={canEdit}
                  onChanged={invalidate}
                  onDelete={() => {
                    if (window.confirm(`Delete case type "${t.name}"? This cannot be undone.`)) {
                      deleteMut.mutate(t.case_type_id);
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {showCreate && (
        <CreateCaseTypeModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            setShowCreate(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function CaseTypeRow({
  t,
  canEdit,
  onChanged,
  onDelete,
}: {
  t: CaseTypeShape;
  canEdit: boolean;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const updateMut = useMutation({
    mutationFn: (patch: Parameters<typeof api.caseTypeUpdate>[1]) => api.caseTypeUpdate(t.case_type_id, patch),
    onSuccess: onChanged,
  });

  return (
    <tr className="border-b border-divider/40 hover:bg-divider/10" data-testid={`cty-row-${t.code}`}>
      <td className="py-2">
        <div className="font-medium">{t.name}</div>
        <div className="text-xs text-muted">
          <code className="rounded bg-divider/20 px-1">{t.code}</code>
          {t.description && <span> · {t.description}</span>}
        </div>
      </td>
      <td>
        {canEdit ? (
          <select
            value={t.priority}
            onChange={(e) => updateMut.mutate({ priority: e.target.value as CasePriorityShape })}
            className="rounded border border-divider px-1 py-0.5 text-xs"
            data-testid={`cty-priority-${t.code}`}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : (
          <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge>
        )}
      </td>
      <td className="font-mono text-xs">{fmtSla(t.sla_hours)}</td>
      <td className="text-sm">{t.assigned_team}</td>
      <td>
        {canEdit ? (
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={t.enabled}
              onChange={(e) => updateMut.mutate({ enabled: e.target.checked })}
              data-testid={`cty-enabled-${t.code}`}
            />
            {t.enabled ? 'Enabled' : 'Disabled'}
          </label>
        ) : (
          <Badge tone={t.enabled ? 'success' : 'neutral'}>{t.enabled ? 'enabled' : 'disabled'}</Badge>
        )}
      </td>
      {canEdit && (
        <td className="text-right">
          <Button variant="ghost" onClick={onDelete} aria-label={`Delete ${t.code}`} data-testid={`cty-delete-${t.code}`}>
            <Trash2 size={12} />
          </Button>
        </td>
      )}
    </tr>
  );
}

function CreateCaseTypeModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<CasePriorityShape>('P2');
  const [slaHours, setSlaHours] = useState('24');
  const [team, setTeam] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () =>
      api.caseTypeCreate({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim() || null,
        priority,
        sla_hours: Number(slaHours),
        assigned_team: team.trim(),
      }),
    onSuccess,
    onError: (e: unknown) => {
      const x = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setErr(x.response?.data?.error?.message ?? x.message ?? 'Create failed');
    },
  });

  const armed =
    code.trim().length >= 2 && name.trim().length >= 1 && team.trim().length >= 1 && Number.isFinite(Number(slaHours)) && Number(slaHours) > 0;

  return (
    <Modal open onClose={onClose} ariaLabel="Add case type" size="lg" testId="cty-create-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add case type</h2>
        </header>
        {err && (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger" data-testid="cty-create-error">
            <AlertTriangle size={14} className="inline mr-1" /> {err}
          </div>
        )}
        <Input label="Code (uppercase A-Z 0-9 _)" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. AML_ESCALATION" data-testid="cty-create-code" />
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" data-testid="cty-create-name" />
        <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="cty-create-desc" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-muted">Priority</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as CasePriorityShape)}
              className="w-full rounded border border-divider p-2 text-sm"
              data-testid="cty-create-priority"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <Input label="SLA (hours)" type="number" value={slaHours} onChange={(e) => setSlaHours(e.target.value)} data-testid="cty-create-sla" />
        </div>
        <Input label="Assigned team" value={team} onChange={(e) => setTeam(e.target.value)} placeholder="e.g. Fraud Desk" data-testid="cty-create-team" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => m.mutate()} disabled={!armed || m.isPending} data-testid="cty-create-submit">
            {m.isPending ? 'Creating…' : 'Create case type'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
