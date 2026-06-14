// web/src/modules/ai/HybridRulesPanel.tsx
//
// T7 — AI Rule + ML Hybrid Support (architecture only).
//
// Authoring + dry-run surface for hybrid rules that combine a deterministic
// metric condition with an AI-score threshold, e.g.:
//   IF DPD > 90 AND ai_score(pd_xgb_v3) > 0.82 THEN CREATE_ALERT (critical)
//
// This is the config/authoring layer ONLY. There is no live orchestrator
// firing these rules — `Dry-run` evaluates a rule against a supplied set of
// metric values + AI scores and shows per-condition pass/fail + would_fire,
// with zero side effects. A future orchestrator consumes these definitions.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Pencil, Plus, Power, RefreshCw, Trash2, X } from 'lucide-react';
import { Badge, Button, DialogFooter, EnterpriseDialog, MetricCard, Panel } from '@/components/ui';
import {
  api,
  type HybridActionShape,
  type HybridConditionShape,
  type HybridDomainShape,
  type HybridLogicShape,
  type HybridOpShape,
  type HybridPreviewResultShape,
  type HybridRuleShape,
  type HybridSeverityShape,
  type HybridStatusShape,
} from '@/lib/api';

const DOMAINS: HybridDomainShape[] = ['banking', 'insurance'];
const LOGICS: HybridLogicShape[] = ['AND', 'OR'];
const ACTIONS: HybridActionShape[] = ['create_alert', 'open_case', 'notify', 'escalate'];
const SEVERITIES: HybridSeverityShape[] = ['critical', 'high', 'medium', 'low'];
const OPS: HybridOpShape[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const OP_SYM: Record<HybridOpShape, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
};

const STATUS_TONE: Record<HybridStatusShape, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  draft: 'warning',
  disabled: 'neutral',
};
const SEVERITY_TONE: Record<HybridSeverityShape, 'danger' | 'warning' | 'blue' | 'neutral'> = {
  critical: 'danger',
  high: 'warning',
  medium: 'blue',
  low: 'neutral',
};

// Local-render expression mirroring the BFF `ruleExpression()`.
function exprOf(rule: {
  logic: HybridLogicShape;
  conditions: HybridConditionShape[];
  action: HybridActionShape;
  severity: HybridSeverityShape;
}): string {
  const lhs = rule.conditions
    .map((c) =>
      c.kind === 'metric'
        ? `${c.field} ${OP_SYM[c.op]} ${c.value}`
        : `ai_score(${c.model_ref}) ${OP_SYM[c.op]} ${c.threshold}`,
    )
    .join(` ${rule.logic} `);
  return `IF ${lhs} THEN ${rule.action.toUpperCase()} (${rule.severity})`;
}

export function HybridRulesPanel({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const [domainFilter, setDomainFilter] = useState<HybridDomainShape | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<HybridStatusShape | 'all'>('all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<HybridRuleShape | null>(null);
  const [dryRun, setDryRun] = useState<HybridRuleShape | null>(null);

  const rulesQ = useQuery({
    queryKey: ['aiwb-hybrid', domainFilter, statusFilter],
    queryFn: () =>
      api.aiHybridRules({
        domain: domainFilter === 'all' ? undefined : domainFilter,
        status: statusFilter === 'all' ? undefined : statusFilter,
      }),
  });

  const transitionMut = useMutation({
    mutationFn: ({ rule_id, status }: { rule_id: string; status: HybridStatusShape }) =>
      api.aiHybridRuleUpdate(rule_id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['aiwb-hybrid'] }),
  });
  const deleteMut = useMutation({
    mutationFn: (rule_id: string) => api.aiHybridRuleDelete(rule_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['aiwb-hybrid'] }),
  });

  const rules = rulesQ.data?.items ?? [];
  const activeCount = rules.filter((r) => r.status === 'active').length;
  const draftCount = rules.filter((r) => r.status === 'draft').length;
  const disabledCount = rules.filter((r) => r.status === 'disabled').length;

  return (
    <Panel
      title="Hybrid rules (metric + AI-score)"
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => qc.invalidateQueries({ queryKey: ['aiwb-hybrid'] })}
          >
            <RefreshCw size={14} /> Refresh
          </Button>
          {canEdit && (
            <Button
              onClick={() => {
                setEditing(null);
                setShowForm(true);
              }}
              data-testid="aiwb-hybrid-new-btn"
            >
              <Plus size={14} /> New hybrid rule
            </Button>
          )}
        </div>
      }
    >
      <p className="mb-4 rounded border border-dashed border-divider bg-divider/5 p-3 text-xs text-muted">
        Authoring surface only. Hybrid rules combine a deterministic metric threshold with an AI-score
        gate. There is no live orchestrator firing these — use <strong>Dry-run</strong> to evaluate a
        rule against supplied values with zero side effects.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Total rules" value={rules.length.toString()} testId="aiwb-hybrid-kpi-total" />
        <MetricCard label="Active" value={activeCount.toString()} tone="success" testId="aiwb-hybrid-kpi-active" />
        <MetricCard label="Draft" value={draftCount.toString()} tone="warning" testId="aiwb-hybrid-kpi-draft" />
        <MetricCard label="Disabled" value={disabledCount.toString()} testId="aiwb-hybrid-kpi-disabled" />
      </div>

      <div className="flex gap-2 mb-3 text-sm">
        <select
          value={domainFilter}
          onChange={(e) => setDomainFilter(e.target.value as HybridDomainShape | 'all')}
          className="rounded border border-divider px-2 py-1"
          data-testid="aiwb-hybrid-filter-domain"
        >
          <option value="all">All domains</option>
          {DOMAINS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as HybridStatusShape | 'all')}
          className="rounded border border-divider px-2 py-1"
          data-testid="aiwb-hybrid-filter-status"
        >
          <option value="all">All statuses</option>
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="disabled">disabled</option>
        </select>
      </div>

      {rulesQ.isLoading ? (
        <p className="text-sm text-muted">Loading hybrid rules…</p>
      ) : rules.length === 0 ? (
        <p
          className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted"
          data-testid="aiwb-hybrid-empty"
        >
          No hybrid rules match these filters.
        </p>
      ) : (
        <div className="space-y-2" data-testid="aiwb-hybrid-list">
          {rules.map((r) => (
            <HybridRuleRow
              key={r.rule_id}
              r={r}
              canEdit={canEdit}
              onEdit={() => {
                setEditing(r);
                setShowForm(true);
              }}
              onDryRun={() => setDryRun(r)}
              onTransition={(status) => transitionMut.mutate({ rule_id: r.rule_id, status })}
              onDelete={() => {
                if (window.confirm(`Delete "${r.name}"? This cannot be undone.`)) {
                  deleteMut.mutate(r.rule_id);
                }
              }}
            />
          ))}
        </div>
      )}

      {showForm && (
        <HybridRuleFormModal
          editing={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['aiwb-hybrid'] });
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      {dryRun && <HybridDryRunModal rule={dryRun} onClose={() => setDryRun(null)} />}
    </Panel>
  );
}

function HybridRuleRow({
  r,
  canEdit,
  onEdit,
  onDryRun,
  onTransition,
  onDelete,
}: {
  r: HybridRuleShape;
  canEdit: boolean;
  onEdit: () => void;
  onDryRun: () => void;
  onTransition: (status: HybridStatusShape) => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="rounded border border-divider bg-surface p-3"
      data-testid={`aiwb-hybrid-row-${r.rule_id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-semibold">{r.name}</span>
            <Badge tone="blue">{r.domain}</Badge>
            <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
            <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
            <span className="text-xs text-muted">{r.action}</span>
          </div>
          <code
            className="block text-xs font-mono text-ink/80 bg-divider/10 rounded px-2 py-1"
            data-testid={`aiwb-hybrid-expr-${r.rule_id}`}
          >
            {exprOf(r)}
          </code>
          <div className="text-xs text-muted mt-1">
            {r.conditions.length} condition{r.conditions.length === 1 ? '' : 's'} · {r.logic} · updated{' '}
            {new Date(r.updated_at).toLocaleDateString()}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button variant="ghost" onClick={onDryRun} data-testid={`aiwb-hybrid-dryrun-${r.rule_id}`}>
            <FlaskConical size={12} /> Dry-run
          </Button>
          {canEdit && (
            <>
              <Button variant="ghost" onClick={onEdit} data-testid={`aiwb-hybrid-edit-${r.rule_id}`}>
                <Pencil size={12} />
              </Button>
              {r.status !== 'active' && (
                <Button
                  variant="ghost"
                  onClick={() => onTransition('active')}
                  data-testid={`aiwb-hybrid-activate-${r.rule_id}`}
                  title="Activate"
                >
                  <Power size={12} />
                </Button>
              )}
              {r.status === 'active' && (
                <Button
                  variant="ghost"
                  onClick={() => onTransition('disabled')}
                  data-testid={`aiwb-hybrid-disable-${r.rule_id}`}
                  title="Disable"
                >
                  <Power size={12} className="text-rose-600" />
                </Button>
              )}
              <Button variant="ghost" onClick={onDelete} data-testid={`aiwb-hybrid-delete-${r.rule_id}`}>
                <Trash2 size={12} />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Builder modal ───────────────────────────────────────────────────

interface DraftCondition {
  kind: 'metric' | 'ai_score';
  field: string; // metric field OR model_ref
  op: HybridOpShape;
  threshold: string; // value OR threshold, as text for the input
}

function newCondition(kind: 'metric' | 'ai_score'): DraftCondition {
  return { kind, field: '', op: 'gt', threshold: '' };
}

function toCondition(d: DraftCondition): HybridConditionShape {
  const num = Number(d.threshold);
  return d.kind === 'metric'
    ? { kind: 'metric', field: d.field.trim(), op: d.op, value: num }
    : { kind: 'ai_score', model_ref: d.field.trim(), op: d.op, threshold: num };
}

function fromCondition(c: HybridConditionShape): DraftCondition {
  return c.kind === 'metric'
    ? { kind: 'metric', field: c.field, op: c.op, threshold: String(c.value) }
    : { kind: 'ai_score', field: c.model_ref, op: c.op, threshold: String(c.threshold) };
}

function HybridRuleFormModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: HybridRuleShape | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [domain, setDomain] = useState<HybridDomainShape>(editing?.domain ?? 'banking');
  const [logic, setLogic] = useState<HybridLogicShape>(editing?.logic ?? 'AND');
  const [action, setAction] = useState<HybridActionShape>(editing?.action ?? 'create_alert');
  const [severity, setSeverity] = useState<HybridSeverityShape>(editing?.severity ?? 'critical');
  const [conditions, setConditions] = useState<DraftCondition[]>(
    editing?.conditions.map(fromCondition) ?? [
      { kind: 'metric', field: 'DPD', op: 'gt', threshold: '90' },
      { kind: 'ai_score', field: 'pd_xgb_v3', op: 'gt', threshold: '0.82' },
    ],
  );
  const [error, setError] = useState<string | null>(null);

  const built = conditions.map(toCondition);
  const allValid =
    name.trim().length >= 3 &&
    conditions.length > 0 &&
    conditions.every((c) => c.field.trim().length > 0 && Number.isFinite(Number(c.threshold)) && c.threshold.trim() !== '');

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        domain,
        logic,
        conditions: built,
        action,
        severity,
      };
      if (editing) {
        return api.aiHybridRuleUpdate(editing.rule_id, payload);
      }
      return api.aiHybridRuleCreate(payload);
    },
    onSuccess: onSaved,
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      setError(err.response?.data?.error?.message ?? err.message ?? 'Save failed');
    },
  });

  const updateCond = (i: number, patch: Partial<DraftCondition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title={editing ? 'Edit hybrid rule' : 'New hybrid rule'}
      size="md"
      testId="aiwb-hybrid-form-modal"
      footer={
        <DialogFooter
          onCancel={onClose}
          primary={
            <Button
              onClick={() => saveMut.mutate()}
              disabled={!allValid || saveMut.isPending}
              data-testid="aiwb-hybrid-form-save"
            >
              {saveMut.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
            </Button>
          }
        />
      }
    >
      <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. High-DPD + high-PD → critical alert"
                className="w-full rounded border border-divider p-2 text-sm"
                data-testid="aiwb-hybrid-form-name"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Domain</label>
              <select
                value={domain}
                onChange={(e) => setDomain(e.target.value as HybridDomainShape)}
                className="w-full rounded border border-divider p-2 text-sm"
                data-testid="aiwb-hybrid-form-domain"
              >
                {DOMAINS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Logic</label>
              <select
                value={logic}
                onChange={(e) => setLogic(e.target.value as HybridLogicShape)}
                className="w-full rounded border border-divider p-2 text-sm"
                data-testid="aiwb-hybrid-form-logic"
              >
                {LOGICS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Action</label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as HybridActionShape)}
                className="w-full rounded border border-divider p-2 text-sm"
                data-testid="aiwb-hybrid-form-action"
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Severity</label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as HybridSeverityShape)}
                className="w-full rounded border border-divider p-2 text-sm"
                data-testid="aiwb-hybrid-form-severity"
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-muted">Description</label>
            <input
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line summary (optional)"
              className="w-full rounded border border-divider p-2 text-sm"
              data-testid="aiwb-hybrid-form-description"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-semibold uppercase text-muted">Conditions</label>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  onClick={() => setConditions((cs) => [...cs, newCondition('metric')])}
                  data-testid="aiwb-hybrid-form-add-metric"
                >
                  <Plus size={11} /> Metric
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConditions((cs) => [...cs, newCondition('ai_score')])}
                  data-testid="aiwb-hybrid-form-add-aiscore"
                >
                  <Plus size={11} /> AI score
                </Button>
              </div>
            </div>
            <div className="space-y-2" data-testid="aiwb-hybrid-form-conditions">
              {conditions.map((c, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded border border-divider p-2"
                  data-testid={`aiwb-hybrid-form-cond-${i}`}
                >
                  <Badge tone={c.kind === 'metric' ? 'blue' : 'purple'}>
                    {c.kind === 'metric' ? 'metric' : 'ai_score'}
                  </Badge>
                  <input
                    value={c.field}
                    onChange={(e) => updateCond(i, { field: e.target.value })}
                    placeholder={c.kind === 'metric' ? 'field (e.g. DPD)' : 'model_ref (e.g. pd_xgb_v3)'}
                    className="flex-1 rounded border border-divider p-1 text-sm font-mono"
                    data-testid={`aiwb-hybrid-form-cond-field-${i}`}
                  />
                  <select
                    value={c.op}
                    onChange={(e) => updateCond(i, { op: e.target.value as HybridOpShape })}
                    className="rounded border border-divider p-1 text-sm"
                    data-testid={`aiwb-hybrid-form-cond-op-${i}`}
                  >
                    {OPS.map((o) => (
                      <option key={o} value={o}>
                        {OP_SYM[o]}
                      </option>
                    ))}
                  </select>
                  <input
                    value={c.threshold}
                    onChange={(e) => updateCond(i, { threshold: e.target.value })}
                    placeholder="value"
                    inputMode="decimal"
                    className="w-24 rounded border border-divider p-1 text-sm font-mono"
                    data-testid={`aiwb-hybrid-form-cond-value-${i}`}
                  />
                  <button
                    onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))}
                    aria-label="Remove condition"
                    className="rounded p-1 hover:bg-divider/40"
                    data-testid={`aiwb-hybrid-form-cond-remove-${i}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {allValid && (
            <code
              className="block text-xs font-mono text-ink/80 bg-divider/10 rounded px-2 py-1.5"
              data-testid="aiwb-hybrid-form-expr"
            >
              {exprOf({ logic, conditions: built, action, severity })}
            </code>
          )}

          {error && (
            <p
              className="rounded bg-rose-50 border border-rose-200 p-2 text-sm text-rose-700"
              data-testid="aiwb-hybrid-form-error"
            >
              {error}
            </p>
          )}
        </div>
    </EnterpriseDialog>
  );
}

// ─── Dry-run modal ───────────────────────────────────────────────────

function HybridDryRunModal({ rule, onClose }: { rule: HybridRuleShape; onClose: () => void }) {
  // Seed input rows from the rule's own conditions so the operator can tweak
  // values rather than retype every metric/model_ref.
  const [metrics, setMetrics] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    rule.conditions.forEach((c) => {
      if (c.kind === 'metric') m[c.field] = '';
    });
    return m;
  });
  const [scores, setScores] = useState<Record<string, string>>(() => {
    const s: Record<string, string> = {};
    rule.conditions.forEach((c) => {
      if (c.kind === 'ai_score') s[c.model_ref] = '';
    });
    return s;
  });
  const [result, setResult] = useState<HybridPreviewResultShape | null>(null);

  const runMut = useMutation({
    mutationFn: () => {
      const m: Record<string, number> = {};
      Object.entries(metrics).forEach(([k, v]) => {
        if (v.trim() !== '' && Number.isFinite(Number(v))) m[k] = Number(v);
      });
      const s: Record<string, number> = {};
      Object.entries(scores).forEach(([k, v]) => {
        if (v.trim() !== '' && Number.isFinite(Number(v))) s[k] = Number(v);
      });
      return api.aiHybridRulePreviewSaved(rule.rule_id, { metrics: m, ai_scores: s });
    },
    onSuccess: (r) => setResult(r),
  });

  const metricKeys = Object.keys(metrics);
  const scoreKeys = Object.keys(scores);

  return (
    <EnterpriseDialog
      open
      onClose={onClose}
      title={`Dry-run: ${rule.name}`}
      size="lg"
      testId="aiwb-hybrid-dryrun-modal"
      footer={
        <DialogFooter
          onCancel={onClose}
          cancelLabel="Close"
          primary={
            <Button
              onClick={() => runMut.mutate()}
              disabled={runMut.isPending}
              data-testid="aiwb-hybrid-dryrun-run"
            >
              <FlaskConical size={14} /> {runMut.isPending ? 'Evaluating…' : 'Evaluate'}
            </Button>
          }
        />
      }
    >
        <code className="block text-xs font-mono text-ink/80 bg-divider/10 rounded px-2 py-1.5 mb-4">
          {exprOf(rule)}
        </code>

        <p className="mb-3 text-xs text-muted">
          Supply observed values. Evaluation is side-effect free — it does not create alerts or cases.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {metricKeys.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase text-muted mb-1">Metrics</div>
              <div className="space-y-2">
                {metricKeys.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <span className="w-28 font-mono text-xs truncate">{k}</span>
                    <input
                      value={metrics[k]}
                      onChange={(e) => setMetrics((m) => ({ ...m, [k]: e.target.value }))}
                      inputMode="decimal"
                      className="flex-1 rounded border border-divider p-1 text-sm font-mono"
                      data-testid={`aiwb-hybrid-dryrun-metric-${k}`}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          {scoreKeys.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase text-muted mb-1">AI scores</div>
              <div className="space-y-2">
                {scoreKeys.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <span className="w-28 font-mono text-xs truncate">{k}</span>
                    <input
                      value={scores[k]}
                      onChange={(e) => setScores((s) => ({ ...s, [k]: e.target.value }))}
                      inputMode="decimal"
                      className="flex-1 rounded border border-divider p-1 text-sm font-mono"
                      data-testid={`aiwb-hybrid-dryrun-score-${k}`}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {result && (
          <div data-testid="aiwb-hybrid-dryrun-result">
            <div
              className={`mb-3 rounded p-3 text-sm font-semibold ${
                result.matched
                  ? 'bg-rose-50 border border-rose-200 text-rose-700'
                  : 'bg-emerald-50 border border-emerald-200 text-emerald-700'
              }`}
              data-testid="aiwb-hybrid-dryrun-verdict"
            >
              {result.matched && result.would_fire
                ? `WOULD FIRE → ${result.would_fire.action.toUpperCase()} (${result.would_fire.severity})`
                : 'WOULD NOT FIRE'}
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr className="border-b border-divider/40">
                  <th className="py-1">Condition</th>
                  <th>Observed</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                {result.condition_results.map((cr, i) => (
                  <tr
                    key={i}
                    className="border-b border-divider/40"
                    data-testid={`aiwb-hybrid-dryrun-cond-${i}`}
                  >
                    <td className="py-1 font-mono text-xs">
                      {cr.condition.kind === 'metric'
                        ? `${cr.condition.field} ${OP_SYM[cr.condition.op]} ${cr.condition.value}`
                        : `ai_score(${cr.condition.model_ref}) ${OP_SYM[cr.condition.op]} ${cr.condition.threshold}`}
                    </td>
                    <td className="text-xs font-mono">{cr.observed ?? '—'}</td>
                    <td>
                      <Badge tone={cr.matched ? 'success' : 'neutral'}>{cr.matched ? 'pass' : 'fail'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </EnterpriseDialog>
  );
}
