// web/src/modules/admin/governance/ComplianceRulesPage.tsx
//
// Enterprise Tenant Governance — compliance rules admin page.
//
// Per-country regulator rules registry. Filter by country / regulator /
// domain / active. Inline edit/delete. Same shape as BranchesPage but
// for compliance rules.

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
  ScrollText,
  ExternalLink,
} from 'lucide-react';
import { Badge, Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { HttpError } from '@/lib/http';
import {
  api,
  GOVERNANCE_DOMAINS,
  COMPLIANCE_SEVERITIES,
  COMPLIANCE_REQUIREMENT_KINDS,
  type ComplianceRule,
  type ComplianceRuleInput,
  type ComplianceRulePatch,
  type ComplianceSeverity,
  type ComplianceRequirementKind,
  type GovernanceDomain,
} from '@/lib/api';

interface DraftFields {
  country_code: string;
  regulator: string;
  rule_code: string;
  title: string;
  description: string;
  domain: GovernanceDomain;
  requirement_kind: ComplianceRequirementKind;
  severity: ComplianceSeverity;
  source_url: string;
  active: boolean;
}

interface EditingState {
  row: ComplianceRule | null;
  fields: DraftFields;
}

function newDraft(): DraftFields {
  return {
    country_code: 'IN',
    regulator: 'RBI',
    rule_code: '',
    title: '',
    description: '',
    domain: 'banking',
    requirement_kind: 'reporting',
    severity: 'mandatory',
    source_url: '',
    active: true,
  };
}

function draftFromRow(r: ComplianceRule): DraftFields {
  return {
    country_code: r.country_code,
    regulator: r.regulator,
    rule_code: r.rule_code,
    title: r.title,
    description: r.description,
    domain: r.domain,
    requirement_kind: r.requirement_kind,
    severity: r.severity,
    source_url: r.source_url ?? '',
    active: r.active,
  };
}

function humanizeError(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    const body = err.body as { error?: { message?: string } } | undefined;
    if (body?.error?.message) return body.error.message;
  }
  return fallback;
}

const severityTone: Record<ComplianceSeverity, 'danger' | 'warning' | 'neutral'> = {
  mandatory: 'danger',
  recommended: 'warning',
  advisory: 'neutral',
};

export function ComplianceRulesPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [filterCountry, setFilterCountry] = useState('');
  const [filterRegulator, setFilterRegulator] = useState('');
  const [filterDomain, setFilterDomain] = useState<'' | GovernanceDomain>('');
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['governance', 'rules', filterCountry, filterRegulator, filterDomain],
    queryFn: () =>
      api.governanceListRules({
        country_code: filterCountry || undefined,
        regulator: filterRegulator || undefined,
        domain: (filterDomain as GovernanceDomain) || undefined,
      }),
    enabled: me?.roles.includes('admin') ?? false,
  });

  const createMut = useMutation({
    mutationFn: (input: ComplianceRuleInput) => api.governanceCreateRule(input),
    onSuccess: () => {
      setEditing(null);
      setFormError(null);
      qc.invalidateQueries({ queryKey: ['governance', 'rules'] });
    },
    onError: (err) => setFormError(humanizeError(err, 'Create failed.')),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ComplianceRulePatch }) =>
      api.governancePatchRule(id, patch),
    onSuccess: () => {
      setEditing(null);
      setFormError(null);
      qc.invalidateQueries({ queryKey: ['governance', 'rules'] });
    },
    onError: (err) => setFormError(humanizeError(err, 'Update failed.')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.governanceDeleteRule(id),
    onSuccess: () => {
      setRowError(null);
      qc.invalidateQueries({ queryKey: ['governance', 'rules'] });
    },
    onError: (err) => setRowError(humanizeError(err, 'Delete failed.')),
  });

  if (me && !me.roles.includes('admin')) return <Navigate to="/" replace />;

  function startCreate() {
    setEditing({ row: null, fields: newDraft() });
    setFormError(null);
  }
  function startEdit(r: ComplianceRule) {
    setEditing({ row: r, fields: draftFromRow(r) });
    setFormError(null);
  }
  function cancel() {
    setEditing(null);
    setFormError(null);
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    if (editing.row) {
      // Update path uses ComplianceRulePatch (subset of fields).
      const patch: ComplianceRulePatch = {
        title: editing.fields.title.trim(),
        description: editing.fields.description.trim(),
        requirement_kind: editing.fields.requirement_kind,
        severity: editing.fields.severity,
        source_url: editing.fields.source_url.trim() || null,
        active: editing.fields.active,
      };
      updateMut.mutate({ id: editing.row.rule_id, patch });
    } else {
      const input: ComplianceRuleInput = {
        country_code: editing.fields.country_code.trim(),
        regulator: editing.fields.regulator.trim(),
        rule_code: editing.fields.rule_code.trim(),
        title: editing.fields.title.trim(),
        description: editing.fields.description.trim(),
        domain: editing.fields.domain,
        requirement_kind: editing.fields.requirement_kind,
        severity: editing.fields.severity,
        source_url: editing.fields.source_url.trim() || null,
        active: editing.fields.active,
      };
      createMut.mutate(input);
    }
  }
  function onDelete(r: ComplianceRule) {
    if (typeof window !== 'undefined' && !window.confirm(`Delete rule ${r.rule_code}?`)) return;
    deleteMut.mutate(r.rule_id);
  }

  const rows = q.data?.rules ?? [];
  const distinctCountries = useMemo(() => Array.from(new Set(rows.map((r) => r.country_code))).sort(), [rows]);
  const distinctRegulators = useMemo(() => Array.from(new Set(rows.map((r) => r.regulator))).sort(), [rows]);

  return (
    <div data-testid="compliance-rules-page">
      <PageHeader
        title="Compliance Rules"
        subtitle={
          q.isLoading
            ? 'Loading…'
            : q.isError
              ? 'Failed to load.'
              : `${rows.length} ${rows.length === 1 ? 'rule' : 'rules'} · ${distinctRegulators.length} regulators · ${distinctCountries.length} countries`
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ['governance', 'rules'] })}>
              <RefreshCw size={14} className="mr-1.5" />
              Refresh
            </Button>
            <Button onClick={startCreate} data-testid="rules-new-row">
              <Plus size={14} className="mr-1.5" />
              New rule
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="rules-filters">
          <label className="block">
            <span className="block text-[11px] font-medium text-ink mb-1">Country</span>
            <select
              className="input"
              value={filterCountry}
              onChange={(e) => setFilterCountry(e.target.value)}
              data-testid="rules-filter-country"
            >
              <option value="">All countries</option>
              {distinctCountries.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium text-ink mb-1">Regulator</span>
            <select
              className="input"
              value={filterRegulator}
              onChange={(e) => setFilterRegulator(e.target.value)}
              data-testid="rules-filter-regulator"
            >
              <option value="">All regulators</option>
              {distinctRegulators.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[11px] font-medium text-ink mb-1">Domain</span>
            <select
              className="input"
              value={filterDomain}
              onChange={(e) => setFilterDomain(e.target.value as '' | GovernanceDomain)}
              data-testid="rules-filter-domain"
            >
              <option value="">All domains</option>
              {GOVERNANCE_DOMAINS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      {editing && (
        <Panel
          title={editing.row ? `Edit ${editing.row.rule_code}` : 'Create compliance rule'}
          className="mb-4"
          action={
            <Button variant="ghost" onClick={cancel}>
              <X size={14} className="mr-1.5" />
              Cancel
            </Button>
          }
        >
          <form onSubmit={onSubmit} className="space-y-3" data-testid="rules-form">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Country code *</span>
                <Input
                  type="text"
                  value={editing.fields.country_code}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, country_code: e.target.value } } : s))}
                  disabled={!!editing.row}
                  required
                  data-testid="rules-field-country_code"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Regulator *</span>
                <Input
                  type="text"
                  value={editing.fields.regulator}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, regulator: e.target.value } } : s))}
                  disabled={!!editing.row}
                  required
                  data-testid="rules-field-regulator"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Rule code *</span>
                <Input
                  type="text"
                  value={editing.fields.rule_code}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, rule_code: e.target.value } } : s))}
                  disabled={!!editing.row}
                  required
                  data-testid="rules-field-rule_code"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Title *</span>
                <Input
                  type="text"
                  value={editing.fields.title}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, title: e.target.value } } : s))}
                  required
                  data-testid="rules-field-title"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Domain</span>
                <select
                  className="input"
                  value={editing.fields.domain}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, domain: e.target.value as GovernanceDomain } } : s))}
                  disabled={!!editing.row}
                  data-testid="rules-field-domain"
                >
                  {GOVERNANCE_DOMAINS.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Requirement kind</span>
                <select
                  className="input"
                  value={editing.fields.requirement_kind}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, requirement_kind: e.target.value as ComplianceRequirementKind } } : s))}
                  data-testid="rules-field-requirement_kind"
                >
                  {COMPLIANCE_REQUIREMENT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Severity</span>
                <select
                  className="input"
                  value={editing.fields.severity}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, severity: e.target.value as ComplianceSeverity } } : s))}
                  data-testid="rules-field-severity"
                >
                  {COMPLIANCE_SEVERITIES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-ink mb-1">Source URL</span>
                <Input
                  type="url"
                  value={editing.fields.source_url}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, source_url: e.target.value } } : s))}
                />
              </label>
              <label className="block md:col-span-2">
                <span className="block text-[11px] font-medium text-ink mb-1">Description *</span>
                <textarea
                  className="input min-h-[80px]"
                  value={editing.fields.description}
                  onChange={(e) => setEditing((s) => (s ? { ...s, fields: { ...s.fields, description: e.target.value } } : s))}
                  required
                  data-testid="rules-field-description"
                />
              </label>
            </div>
            {formError && (
              <p role="alert" className="flex items-center gap-2 text-sm text-danger" data-testid="rules-form-error">
                <AlertCircle size={14} /> {formError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
              <Button
                type="submit"
                loading={createMut.isPending || updateMut.isPending}
                data-testid="rules-save"
              >
                <Save size={14} className="mr-1.5" /> Save
              </Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel title="Compliance rules">
        {q.isLoading ? (
          <p className="caption">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="caption" data-testid="rules-empty">No rules match the filters.</p>
        ) : (
          <div className="overflow-x-auto" data-testid="rules-table">
            <table className="min-w-full text-sm">
              <thead className="border-b border-divider bg-divider/10 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Rule</th>
                  <th className="px-3 py-2">Country / Regulator</th>
                  <th className="px-3 py-2">Domain</th>
                  <th className="px-3 py-2">Requirement</th>
                  <th className="px-3 py-2">Severity</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.rule_id}
                    data-testid={`rules-row-${r.rule_id}`}
                    className="border-b border-divider/30 last:border-b-0"
                  >
                    <td className="px-3 py-2 text-xs">
                      <div className="font-medium text-ink">{r.rule_code}</div>
                      <div className="text-muted">{r.title}</div>
                      {r.source_url && (
                        <a href={r.source_url} target="_blank" rel="noreferrer" className="text-action inline-flex items-center gap-1 text-[11px] mt-0.5">
                          source <ExternalLink size={10} />
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-medium">{r.country_code}</div>
                      <div className="text-muted inline-flex items-center gap-1">
                        <ScrollText size={12} /> {r.regulator}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <Badge tone={r.domain === 'both' ? 'neutral' : r.domain === 'banking' ? 'blue' : 'success'}>
                        {r.domain}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.requirement_kind}</td>
                    <td className="px-3 py-2">
                      <Badge tone={severityTone[r.severity]}>{r.severity}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(r)}
                          data-testid={`rules-edit-${r.rule_id}`}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onDelete(r)}
                          disabled={deleteMut.isPending}
                          data-testid={`rules-delete-${r.rule_id}`}
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
