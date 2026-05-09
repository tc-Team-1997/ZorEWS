import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  AlertTriangle,
  Copy,
  GitCompare,
  PlayCircle,
  Plus,
  Sparkles,
  Trash2,
  PowerOff,
  ShieldCheck,
} from 'lucide-react';
import { http } from '@/lib/http';
import { Badge, type BadgeTone, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { rulesPlusApi } from './rulesPlusApi';

// ── Types (mirror BFF EwsRule shape) ─────────────────────────────────

type AlertSeverity = 'RED' | 'ORANGE' | 'YELLOW' | 'GREEN';
type EwsRuleCategory =
  | 'credit'
  | 'lapse'
  | 'fraud'
  | 'kyc'
  | 'transaction'
  | 'agent'
  | 'ops'
  | 'concentration'
  | 'behaviour'
  | 'score';
type EwsRuleState = 'draft' | 'pending_review' | 'active' | 'deprecated';
type EwsOperator = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'in' | 'not_in' | 'between';
type EwsLogic = 'AND' | 'OR';

interface EwsCondition {
  field: string;
  operator: EwsOperator;
  value?: number | string | (number | string)[];
  range?: [number, number];
}

interface EwsRule {
  rule_id: string;
  tenant_id: string;
  name: string;
  category: EwsRuleCategory;
  description: string;
  conditions: EwsCondition[];
  logic: EwsLogic;
  action: { alert_severity: AlertSeverity; weight: number; recommended_action?: string };
  is_active: boolean;
  state: EwsRuleState;
  version: number;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  deprecated_at: string | null;
}

interface EwsIndicator {
  id: string;
  name: string;
  display_name: string;
  domain: string;
  type: 'count' | 'percent' | 'ratio' | 'days' | 'amount' | 'flag' | 'enum';
  description: string;
  range?: { min: number; max: number };
  enum_values?: string[];
}

// ── Tones ─────────────────────────────────────────────────────────────

const SEVERITY_TONE: Record<AlertSeverity, BadgeTone> = {
  RED: 'danger',
  ORANGE: 'warning',
  YELLOW: 'neutral',
  GREEN: 'success',
};

const STATE_TONE: Record<EwsRuleState, BadgeTone> = {
  draft: 'neutral',
  pending_review: 'warning',
  active: 'success',
  deprecated: 'neutral',
};

const OPERATORS: EwsOperator[] = ['>', '>=', '<', '<=', '==', '!=', 'in', 'not_in', 'between'];

const CATEGORIES: EwsRuleCategory[] = [
  'credit', 'lapse', 'fraud', 'kyc', 'transaction',
  'agent', 'ops', 'concentration', 'behaviour', 'score',
];

// ── API ──────────────────────────────────────────────────────────────

// Tolerant body extractor — http.ts auto-unwraps the {header, body}
// envelope at the response interceptor, so `r.data` is normally the body.
// Tests mock http.get directly with `{ data: { body: T } }` (the raw
// envelope shape), so this helper peeks inside `body` if present.
function bodyOf<T>(r: { data: T | { body: T } }): T {
  const d = r.data as { body?: T } | T;
  if (d && typeof d === 'object' && 'body' in d && (d as { body: T }).body !== undefined) {
    return (d as { body: T }).body;
  }
  return d as T;
}

const ewsApi = {
  list: () =>
    http.get<{ items: EwsRule[]; total: number }>('/v1/ews/rules')
      .then((r) => bodyOf(r).items),
  indicators: () =>
    http.get<{ items: EwsIndicator[] }>('/v1/ews/rules/indicators')
      .then((r) => bodyOf(r).items),
  create: (rule: unknown) =>
    http.post<EwsRule>('/v1/ews/rules', rule).then((r) => bodyOf(r)),
  remove: (id: string) =>
    http.delete<EwsRule>(`/v1/ews/rules/${id}`).then((r) => bodyOf(r)),
  activate: (id: string) =>
    http.post<EwsRule>(`/v1/ews/rules/${id}/activate`, {}).then((r) => bodyOf(r)),
  test: (id: string, values: Record<string, number | string>) =>
    http
      .post<{ matched: boolean; matched_indicators: string[]; score_impact: number; alert_severity: AlertSeverity }>(
        `/v1/ews/rules/${id}/test`,
        { values },
      )
      .then((r) => bodyOf(r)),
};

// ── Component ────────────────────────────────────────────────────────

export function EwsRuleBuilderPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const rulesQ = useQuery({ queryKey: ['ews-rules'], queryFn: ewsApi.list });
  const indicatorsQ = useQuery({ queryKey: ['ews-indicators'], queryFn: ewsApi.indicators });

  const [showCreate, setShowCreate] = useState(false);
  const [testRule, setTestRule] = useState<EwsRule | null>(null);
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof ewsApi.test>> | null>(null);
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  // RP-2: clone-flow state. (Diff viewer is now its own routable page
  // at /rules/ews/:rule_id/diff — no modal state needed here.)
  const [cloneSource, setCloneSource] = useState<EwsRule | null>(null);
  const [cloneNewId, setCloneNewId] = useState('');
  const [cloneNewName, setCloneNewName] = useState('');
  const [cloneError, setCloneError] = useState<string | null>(null);

  const cloneMut = useMutation({
    mutationFn: ({ src, new_rule_id, new_name }: { src: string; new_rule_id: string; new_name?: string }) =>
      rulesPlusApi.clone(src, new_rule_id, new_name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ews-rules'] });
      setCloneSource(null);
      setCloneNewId('');
      setCloneNewName('');
      setCloneError(null);
    },
    onError: (e: unknown) => {
      const msg =
        (e as { response?: { data?: { error?: { message?: string } } } })?.response
          ?.data?.error?.message ?? 'Clone failed';
      setCloneError(msg);
    },
  });

  const createMut = useMutation({
    mutationFn: ewsApi.create,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ews-rules'] });
      setShowCreate(false);
    },
  });
  const removeMut = useMutation({
    mutationFn: ewsApi.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ews-rules'] }),
  });
  const activateMut = useMutation({
    mutationFn: ewsApi.activate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ews-rules'] }),
  });
  const testMut = useMutation({
    mutationFn: ({ id, values }: { id: string; values: Record<string, number | string> }) =>
      ewsApi.test(id, values),
    onSuccess: (data) => setTestResult(data),
  });

  const indicatorByName = useMemo(() => {
    const m = new Map<string, EwsIndicator>();
    for (const i of indicatorsQ.data ?? []) m.set(i.name, i);
    return m;
  }, [indicatorsQ.data]);

  const rules = rulesQ.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="EWS Rule Builder"
        subtitle="Operator-authored rules that fire when an indicator crosses a threshold."
        actions={
          <>
            <Link
              to="/rules/ews/wizard"
              className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-100"
            >
              <Sparkles size={14} /> 4-step wizard
            </Link>
            <Button onClick={() => setShowCreate(true)}>
              <Plus size={16} /> New rule
            </Button>
          </>
        }
      />

      <Panel title={`Rules (${rules.length})`}>
        <div className="mb-3 text-xs text-slate-500">
          Active rules evaluate on every /v1/ews/rules/evaluate call. Draft rules don't fire.
        </div>
        {rulesQ.isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : rules.length === 0 ? (
          <div className="text-sm text-slate-500">
            No rules yet. Click <span className="font-medium">New rule</span> to author one,
            or seed the 10 brief defaults from the BFF.
          </div>
        ) : (
          <div className="grid gap-3">
            {rules.map((r) => (
              <div
                key={r.rule_id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-500">{r.rule_id}</span>
                    <Badge tone={STATE_TONE[r.state]}>{r.state}</Badge>
                    <Badge tone={SEVERITY_TONE[r.action.alert_severity]}>
                      {r.action.alert_severity}
                    </Badge>
                    <span className="text-xs text-slate-400">w={r.action.weight}</span>
                  </div>
                  <div className="mt-1 text-sm font-medium">{r.name}</div>
                  <div className="text-xs text-slate-500">{r.description}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {r.conditions.length} condition{r.conditions.length === 1 ? '' : 's'} ·{' '}
                    {r.logic} · {r.category}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setTestRule(r);
                      setTestValues({});
                      setTestResult(null);
                    }}
                  >
                    <PlayCircle size={14} /> Test
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => navigate(`/rules/ews/${encodeURIComponent(r.rule_id)}/diff`)}
                    title="View version diff (RP-1)"
                    data-testid={`open-diff-${r.rule_id}`}
                  >
                    <GitCompare size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setCloneSource(r);
                      setCloneNewId(`${r.rule_id}_COPY`);
                      setCloneNewName(`${r.name} (copy)`);
                      setCloneError(null);
                    }}
                    title="Clone rule"
                  >
                    <Copy size={14} />
                  </Button>
                  {r.state === 'draft' || r.state === 'pending_review' ? (
                    <Button onClick={() => activateMut.mutate(r.rule_id)}>
                      <ShieldCheck size={14} /> Activate
                    </Button>
                  ) : null}
                  {r.state !== 'deprecated' ? (
                    <Button
                      variant="ghost"
                      onClick={() => removeMut.mutate(r.rule_id)}
                      title="Soft-delete (state→deprecated)"
                    >
                      <PowerOff size={14} />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {showCreate ? (
        <CreateRuleForm
          indicators={indicatorsQ.data ?? []}
          onCancel={() => setShowCreate(false)}
          onSubmit={(input) => createMut.mutate(input)}
          submitting={createMut.isPending}
          error={createMut.error}
        />
      ) : null}

      {testRule ? (
        <TestRulePanel
          rule={testRule}
          indicatorByName={indicatorByName}
          values={testValues}
          onChangeValue={(field, value) =>
            setTestValues((prev) => ({ ...prev, [field]: value }))
          }
          onRun={() => {
            const coerced: Record<string, number | string> = {};
            for (const [k, v] of Object.entries(testValues)) {
              const n = Number(v);
              coerced[k] = Number.isFinite(n) && v.trim() !== '' ? n : v;
            }
            testMut.mutate({ id: testRule.rule_id, values: coerced });
          }}
          onClose={() => {
            setTestRule(null);
            setTestResult(null);
          }}
          result={testResult}
          submitting={testMut.isPending}
        />
      ) : null}

      {cloneSource ? (
        <div
          data-testid="clone-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-md bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-center gap-2">
              <Copy size={16} />
              <h3 className="text-base font-semibold">Clone {cloneSource.rule_id}</h3>
            </div>
            <div className="mb-3 text-xs text-slate-500">
              Creates a draft copy preserving conditions + action. New rule starts at semver 0.1.0.
            </div>
            <label className="mb-2 block text-xs">
              <span className="font-semibold uppercase text-slate-500">New rule_id</span>
              <input
                value={cloneNewId}
                onChange={(e) => setCloneNewId(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm font-mono"
                placeholder="RULE_FOO_002"
              />
            </label>
            <label className="mb-3 block text-xs">
              <span className="font-semibold uppercase text-slate-500">
                New name (optional)
              </span>
              <input
                value={cloneNewName}
                onChange={(e) => setCloneNewName(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            {cloneError ? (
              <div className="mb-2 rounded bg-rose-50 p-2 text-xs text-rose-700">
                {cloneError}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCloneSource(null)}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  cloneMut.mutate({
                    src: cloneSource.rule_id,
                    new_rule_id: cloneNewId,
                    new_name: cloneNewName || undefined,
                  })
                }
                disabled={!cloneNewId || cloneMut.isPending}
              >
                <Copy size={12} /> Clone
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── CreateRuleForm ───────────────────────────────────────────────────

function CreateRuleForm({
  indicators,
  onCancel,
  onSubmit,
  submitting,
  error,
}: {
  indicators: EwsIndicator[];
  onCancel: () => void;
  onSubmit: (input: unknown) => void;
  submitting: boolean;
  error: unknown;
}) {
  const [ruleId, setRuleId] = useState('RULE_NEW_001');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<EwsRuleCategory>('credit');
  const [logic, setLogic] = useState<EwsLogic>('AND');
  const [severity, setSeverity] = useState<AlertSeverity>('YELLOW');
  const [weight, setWeight] = useState(15);
  const [recommendedAction, setRecommendedAction] = useState('');
  const [conditions, setConditions] = useState<EwsCondition[]>([
    { field: indicators[0]?.name ?? '', operator: '>=', value: 0 },
  ]);

  return (
    <Panel title="New rule">
      <div className="mb-3 text-xs text-slate-500">
        Compose the conditions and severity. Rules land in 'draft' state — activate them once tested.
      </div>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="rule_id"
            value={ruleId}
            onChange={setRuleId}
            placeholder="RULE_FOO_001"
          />
          <Input label="name" value={name} onChange={setName} />
        </div>
        <Input
          label="description"
          value={description}
          onChange={setDescription}
          textarea
        />
        <div className="grid grid-cols-3 gap-3">
          <Select
            label="category"
            value={category}
            onChange={(v) => setCategory(v as EwsRuleCategory)}
            options={CATEGORIES}
          />
          <Select
            label="logic"
            value={logic}
            onChange={(v) => setLogic(v as EwsLogic)}
            options={['AND', 'OR']}
          />
          <Select
            label="alert_severity"
            value={severity}
            onChange={(v) => setSeverity(v as AlertSeverity)}
            options={['RED', 'ORANGE', 'YELLOW', 'GREEN']}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="weight (1-100)"
            value={String(weight)}
            onChange={(v) => setWeight(Math.max(1, Math.min(100, Number(v) || 1)))}
          />
          <Input
            label="recommended_action"
            value={recommendedAction}
            onChange={setRecommendedAction}
            placeholder="optional"
          />
        </div>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-slate-500">
              Conditions ({logic})
            </span>
            <Button
              variant="ghost"
              onClick={() =>
                setConditions((prev) => [
                  ...prev,
                  { field: indicators[0]?.name ?? '', operator: '>=', value: 0 },
                ])
              }
              disabled={conditions.length >= 12}
            >
              <Plus size={12} /> Add condition
            </Button>
          </div>
          <div className="grid gap-2">
            {conditions.map((c, idx) => (
              <ConditionRow
                key={idx}
                condition={c}
                indicators={indicators}
                onChange={(next) =>
                  setConditions((prev) => prev.map((p, i) => (i === idx ? next : p)))
                }
                onRemove={() =>
                  setConditions((prev) => prev.filter((_, i) => i !== idx))
                }
                canRemove={conditions.length > 1}
              />
            ))}
          </div>
        </div>
        {error ? (
          <div className="flex items-center gap-2 rounded-md bg-rose-50 p-2 text-sm text-rose-700">
            <AlertTriangle size={14} />
            {(error as { response?: { data?: { error?: { message?: string } } } })?.response?.data
              ?.error?.message ?? 'Create failed'}
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            onClick={() =>
              onSubmit({
                rule_id: ruleId,
                name,
                category,
                description,
                conditions,
                logic,
                action: {
                  alert_severity: severity,
                  weight,
                  ...(recommendedAction
                    ? { recommended_action: recommendedAction }
                    : {}),
                },
              })
            }
            disabled={submitting || !name || !description}
          >
            <CheckCircle2 size={14} /> Save draft
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Panel>
  );
}

// ── ConditionRow ─────────────────────────────────────────────────────

function ConditionRow({
  condition,
  indicators,
  onChange,
  onRemove,
  canRemove,
}: {
  condition: EwsCondition;
  indicators: EwsIndicator[];
  onChange: (c: EwsCondition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const ind = indicators.find((i) => i.name === condition.field);
  const isEnum = ind?.type === 'enum';
  const isBetween = condition.operator === 'between';

  return (
    <div className="grid grid-cols-[1fr_120px_1fr_auto] gap-2">
      <select
        value={condition.field}
        onChange={(e) => onChange({ ...condition, field: e.target.value })}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
      >
        {indicators.map((i) => (
          <option key={i.name} value={i.name}>
            {i.display_name} ({i.name})
          </option>
        ))}
      </select>
      <select
        value={condition.operator}
        onChange={(e) =>
          onChange({ ...condition, operator: e.target.value as EwsOperator })
        }
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm font-mono"
      >
        {(isEnum
          ? (['==', '!=', 'in', 'not_in'] as EwsOperator[])
          : OPERATORS
        ).map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      {isBetween ? (
        <div className="flex gap-1">
          <input
            type="number"
            value={condition.range?.[0] ?? 0}
            onChange={(e) =>
              onChange({
                ...condition,
                range: [Number(e.target.value), condition.range?.[1] ?? 0],
              })
            }
            className="w-20 rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="min"
          />
          <input
            type="number"
            value={condition.range?.[1] ?? 0}
            onChange={(e) =>
              onChange({
                ...condition,
                range: [condition.range?.[0] ?? 0, Number(e.target.value)],
              })
            }
            className="w-20 rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="max"
          />
        </div>
      ) : (
        <input
          type={isEnum ? 'text' : 'number'}
          value={
            condition.value === undefined
              ? ''
              : Array.isArray(condition.value)
                ? condition.value.join(',')
                : String(condition.value)
          }
          onChange={(e) => {
            const raw = e.target.value;
            if (condition.operator === 'in' || condition.operator === 'not_in') {
              const arr = raw.split(',').map((v) => v.trim()).filter(Boolean);
              const coerced = arr.map((v) => (isEnum ? v : Number(v) || v));
              onChange({ ...condition, value: coerced });
            } else if (isEnum) {
              onChange({ ...condition, value: raw });
            } else {
              onChange({ ...condition, value: Number(raw) });
            }
          }}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          placeholder={
            isEnum && ind?.enum_values
              ? ind.enum_values.join(' | ')
              : ind?.range
                ? `${ind.range.min}–${ind.range.max}`
                : 'value'
          }
        />
      )}
      <Button
        variant="ghost"
        onClick={onRemove}
        disabled={!canRemove}
        title="Remove condition"
      >
        <Trash2 size={12} />
      </Button>
    </div>
  );
}

// ── TestRulePanel ─────────────────────────────────────────────────────

function TestRulePanel({
  rule,
  indicatorByName,
  values,
  onChangeValue,
  onRun,
  onClose,
  result,
  submitting,
}: {
  rule: EwsRule;
  indicatorByName: Map<string, EwsIndicator>;
  values: Record<string, string>;
  onChangeValue: (field: string, value: string) => void;
  onRun: () => void;
  onClose: () => void;
  result: { matched: boolean; matched_indicators: string[]; score_impact: number; alert_severity: AlertSeverity } | null;
  submitting: boolean;
}) {
  const fields = Array.from(new Set(rule.conditions.map((c) => c.field)));
  return (
    <Panel title={`Test ${rule.rule_id}`}>
      <div className="mb-3 text-xs text-slate-500">
        Run this rule against ad-hoc indicator values. Does NOT record telemetry.
      </div>
      <div className="grid gap-3">
        {fields.map((f) => {
          const ind = indicatorByName.get(f);
          return (
            <div key={f} className="grid grid-cols-[1fr_2fr] items-center gap-3">
              <div className="text-xs">
                <div className="font-medium">{ind?.display_name ?? f}</div>
                <div className="font-mono text-slate-400">{f}</div>
              </div>
              <input
                type={ind?.type === 'enum' ? 'text' : 'number'}
                value={values[f] ?? ''}
                onChange={(e) => onChangeValue(f, e.target.value)}
                className="rounded border border-slate-300 px-2 py-1 text-sm"
                placeholder={
                  ind?.range
                    ? `${ind.range.min}–${ind.range.max}`
                    : ind?.enum_values?.join(' | ') ?? ''
                }
              />
            </div>
          );
        })}
        <div className="flex gap-2">
          <Button onClick={onRun} disabled={submitting}>
            <PlayCircle size={14} /> Run test
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {result ? (
          <div
            className={`rounded-md border p-3 ${
              result.matched
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                : 'border-slate-300 bg-slate-50 text-slate-700'
            }`}
          >
            <div className="font-semibold">
              {result.matched ? 'MATCH' : 'NO MATCH'} — score impact{' '}
              {result.score_impact}
            </div>
            {result.matched ? (
              <div className="mt-1 text-xs">
                Fired indicators: {result.matched_indicators.join(', ')}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

// ── Mini-Input + Select ──────────────────────────────────────────────

function Input({
  label,
  value,
  onChange,
  placeholder,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  textarea?: boolean;
}) {
  return (
    <label className="block text-xs">
      <span className="font-semibold uppercase text-slate-500">{label}</span>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
          rows={2}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
        />
      )}
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="block text-xs">
      <span className="font-semibold uppercase text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
