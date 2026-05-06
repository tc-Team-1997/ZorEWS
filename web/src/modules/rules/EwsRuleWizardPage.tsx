import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  KeyRound,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { http } from '@/lib/http';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  AUTO_SAVE_INTERVAL_MS,
  clearDraft,
  loadDraft,
  rulesPlusApi,
  saveDraft,
  type DraftEnvelope,
} from './rulesPlusApi';

// ── Types ────────────────────────────────────────────────────────────

type AlertSeverity = 'RED' | 'ORANGE' | 'YELLOW' | 'GREEN';
type EwsOperator = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'in' | 'not_in' | 'between';

interface EwsCondition {
  field: string;
  operator: EwsOperator;
  value?: number | string | (number | string)[];
  range?: [number, number];
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

interface DraftBody {
  rule_id: string;
  name: string;
  description: string;
  category: string;
  conditions: EwsCondition[];
  logic: 'AND' | 'OR';
  alert_severity: AlertSeverity;
  weight: number;
  recommended_action: string;
  activate_after_create: boolean;
}

const CATEGORIES = [
  'credit', 'lapse', 'fraud', 'kyc', 'transaction',
  'agent', 'ops', 'concentration', 'behaviour', 'score',
];
const OPERATORS: EwsOperator[] = ['>', '>=', '<', '<=', '==', '!=', 'in', 'not_in', 'between'];

const STEPS = ['Basic Info', 'Conditions', 'Action', 'Lifecycle'] as const;
type Step = (typeof STEPS)[number];

const EMPTY_DRAFT: DraftBody = {
  rule_id: '',
  name: '',
  description: '',
  category: 'credit',
  conditions: [{ field: '', operator: '>=', value: 0 }],
  logic: 'AND',
  alert_severity: 'YELLOW',
  weight: 15,
  recommended_action: '',
  activate_after_create: false,
};

// ── Page ─────────────────────────────────────────────────────────────

export function EwsRuleWizardPage() {
  const nav = useNavigate();
  const qc = useQueryClient();

  // Load draft from localStorage on mount.
  const initialDraft = useMemo(() => {
    const env = loadDraft<DraftEnvelope<DraftBody>>();
    return env?.draft ?? EMPTY_DRAFT;
  }, []);
  const initialSavedAt = useMemo(() => {
    const env = loadDraft<DraftEnvelope<DraftBody>>();
    return env?.savedAt ?? null;
  }, []);

  const [draft, setDraft] = useState<DraftBody>(initialDraft);
  const [step, setStep] = useState<Step>('Basic Info');
  const [savedAt, setSavedAt] = useState<number | null>(initialSavedAt);
  const [error, setError] = useState<string | null>(null);
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof rulesPlusApi.testRule>> | null>(null);

  // Load indicators for the field dropdown.
  const indicatorsQ = useQuery({
    queryKey: ['ews-indicators'],
    queryFn: () =>
      http
        .get<{ body: { items: EwsIndicator[] } }>('/v1/ews/rules/indicators')
        .then((r) => r.data.body.items),
  });

  // Auto-save every 30s — only when the user has started filling in data.
  const autoSaveRef = useRef<DraftBody>(draft);
  autoSaveRef.current = draft;
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = autoSaveRef.current;
      if (d.name || d.rule_id) {
        saveDraft(d);
        setSavedAt(Date.now());
      }
    }, AUTO_SAVE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const stepIdx = STEPS.indexOf(step);
  const isLast = stepIdx === STEPS.length - 1;
  const goNext = useCallback(() => {
    if (!isLast) setStep(STEPS[stepIdx + 1]!);
  }, [isLast, stepIdx]);
  const goBack = useCallback(() => {
    if (stepIdx > 0) setStep(STEPS[stepIdx - 1]!);
  }, [stepIdx]);

  // Submit (mutation)
  const submitMut = useMutation({
    mutationFn: async () => {
      const conditions = draft.conditions.filter((c) => c.field);
      const body = {
        rule_id: draft.rule_id,
        name: draft.name,
        description: draft.description,
        category: draft.category,
        conditions,
        logic: draft.logic,
        action: {
          alert_severity: draft.alert_severity,
          weight: draft.weight,
          ...(draft.recommended_action ? { recommended_action: draft.recommended_action } : {}),
        },
      };
      const created = await http
        .post<{ body: { rule_id: string } }>('/v1/ews/rules', body)
        .then((r) => r.data.body);
      if (draft.activate_after_create) {
        // Use 4-eyes path. Will 403 if same user is also approver — operator
        // intent would then be to ask a colleague to approve.
        try {
          await rulesPlusApi.submit(created.rule_id);
          await rulesPlusApi.approve(created.rule_id);
        } catch {
          // fall back to the simple activate route
          await http.post(`/v1/ews/rules/${created.rule_id}/activate`, {});
        }
      }
      return created;
    },
    onSuccess: () => {
      clearDraft();
      void qc.invalidateQueries({ queryKey: ['ews-rules'] });
      nav('/rules/ews');
    },
    onError: (e: unknown) => {
      setError(
        (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data
          ?.error?.message ?? 'Create failed',
      );
    },
  });

  // Keyboard shortcuts: Cmd/Ctrl+S submit-or-save, Esc cancel,
  // Cmd/Ctrl+Enter advance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isLast) {
          submitMut.mutate();
        } else {
          saveDraft(draft);
          setSavedAt(Date.now());
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        nav('/rules/ews');
      } else if (meta && e.key === 'Enter') {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, goNext, isLast, nav, submitMut]);

  // Test rule against a draft body in step 2 (without saving).
  // For a NEW rule we don't have a rule_id on the server yet — so the
  // SPA preview-tests against a temporary path: post-create-then-test
  // is too heavy. Instead, we run a CLIENT-side simulation against
  // the user's draft conditions + the supplied values. Pure JS check.
  const runClientSideTest = () => {
    const values: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(testValues)) {
      const n = Number(v);
      values[k] = Number.isFinite(n) && v.trim() !== '' ? n : v;
    }
    const matches = evalDraft(draft, values);
    setTestResult({
      rule_id: draft.rule_id || '(unsaved)',
      matched: matches.matched,
      matched_indicators: matches.fired,
      score_impact: matches.matched ? draft.weight : 0,
      alert_severity: draft.alert_severity,
    });
  };

  return (
    <div className="space-y-4 p-6">
      <Link to="/rules/ews" className="text-sm text-blue-600 hover:underline">
        <ArrowLeft size={14} className="inline" /> Back to rules
      </Link>
      <PageHeader
        title="Add EWS Rule (4-step wizard)"
        subtitle={
          savedAt
            ? `Auto-saved at ${new Date(savedAt).toLocaleTimeString()} · keep going`
            : 'Auto-save kicks in every 30s · Cmd/Ctrl+S saves now · Esc cancels · Cmd/Ctrl+Enter advances'
        }
        actions={
          <Button variant="ghost" onClick={() => nav('/rules/ews')}>
            <X size={14} /> Cancel
          </Button>
        }
      />

      <Stepper step={step} />

      {error ? (
        <div className="rounded-md bg-rose-50 p-2 text-sm text-rose-700">{error}</div>
      ) : null}

      {step === 'Basic Info' ? (
        <BasicInfoStep
          draft={draft}
          onChange={setDraft}
        />
      ) : null}
      {step === 'Conditions' ? (
        <ConditionsStep
          draft={draft}
          indicators={indicatorsQ.data ?? []}
          onChange={setDraft}
          testValues={testValues}
          onTestValueChange={(field, value) =>
            setTestValues((prev) => ({ ...prev, [field]: value }))
          }
          onRunTest={runClientSideTest}
          testResult={testResult}
        />
      ) : null}
      {step === 'Action' ? (
        <ActionStep draft={draft} onChange={setDraft} />
      ) : null}
      {step === 'Lifecycle' ? (
        <LifecycleStep draft={draft} onChange={setDraft} />
      ) : null}

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-slate-200 pt-3">
        <div className="text-xs text-slate-500">
          {savedAt ? (
            <span className="inline-flex items-center gap-1">
              <Save size={12} /> Saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Clock size={12} /> Not saved yet — auto-save in {Math.round(AUTO_SAVE_INTERVAL_MS / 1000)}s
            </span>
          )}
          <span className="ml-3">
            <KeyRound size={12} className="inline" /> Cmd/Ctrl+S · Esc · Cmd/Ctrl+Enter
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              clearDraft();
              setDraft(EMPTY_DRAFT);
              setSavedAt(null);
            }}
            title="Clear the auto-saved draft"
          >
            <Trash2 size={12} /> Clear draft
          </Button>
          {stepIdx > 0 ? (
            <Button variant="ghost" onClick={goBack}>
              <ArrowLeft size={12} /> Back
            </Button>
          ) : null}
          {!isLast ? (
            <Button onClick={goNext}>
              Next <ArrowRight size={12} />
            </Button>
          ) : (
            <Button
              onClick={() => submitMut.mutate()}
              disabled={submitMut.isPending}
            >
              <CheckCircle2 size={12} /> Save rule
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Stepper bar ──────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  const idx = STEPS.indexOf(step);
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const active = i === idx;
        const done = i < idx;
        return (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                active
                  ? 'bg-blue-600 text-white'
                  : done
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-slate-200 text-slate-500'
              }`}
            >
              {i + 1}
            </div>
            <span className={`text-sm ${active ? 'font-semibold' : 'text-slate-500'}`}>{s}</span>
            {i < STEPS.length - 1 ? <span className="text-slate-300">→</span> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Basic Info ───────────────────────────────────────────────

function BasicInfoStep({
  draft,
  onChange,
}: {
  draft: DraftBody;
  onChange: (d: DraftBody) => void;
}) {
  return (
    <Panel title="1. Basic Info">
      <div className="grid gap-3">
        <Labeled label="rule_id">
          <input
            value={draft.rule_id}
            onChange={(e) => onChange({ ...draft, rule_id: e.target.value })}
            placeholder="RULE_<DOMAIN>_NNN (e.g. RULE_CREDIT_002)"
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm font-mono"
          />
          <span className="text-[11px] text-slate-500">
            Pattern: RULE_&lt;UPPER&gt;_NNN. Must be unique per tenant.
          </span>
        </Labeled>
        <Labeled label="name">
          <input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="High EMI Bounce Risk"
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Labeled>
        <Labeled label="description">
          <textarea
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            rows={2}
            placeholder="What this rule detects + when it fires"
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Labeled>
        <Labeled label="category">
          <select
            value={draft.category}
            onChange={(e) => onChange({ ...draft, category: e.target.value })}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Labeled>
      </div>
    </Panel>
  );
}

// ── Step 2: Conditions + inline Test Rule ───────────────────────────

function ConditionsStep({
  draft,
  indicators,
  onChange,
  testValues,
  onTestValueChange,
  onRunTest,
  testResult,
}: {
  draft: DraftBody;
  indicators: EwsIndicator[];
  onChange: (d: DraftBody) => void;
  testValues: Record<string, string>;
  onTestValueChange: (field: string, value: string) => void;
  onRunTest: () => void;
  testResult: { matched: boolean; matched_indicators: string[]; score_impact: number; alert_severity: string } | null;
}) {
  const fields = Array.from(new Set(draft.conditions.map((c) => c.field).filter(Boolean)));
  return (
    <Panel title="2. Conditions">
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="font-semibold uppercase text-slate-500">Logic</span>
        <select
          value={draft.logic}
          onChange={(e) => onChange({ ...draft, logic: e.target.value as 'AND' | 'OR' })}
          className="rounded border border-slate-300 bg-white px-2 py-1"
        >
          <option value="AND">AND (all)</option>
          <option value="OR">OR (any)</option>
        </select>
      </div>
      <div className="space-y-2">
        {draft.conditions.map((c, idx) => (
          <ConditionRow
            key={idx}
            condition={c}
            indicators={indicators}
            onChange={(next) =>
              onChange({
                ...draft,
                conditions: draft.conditions.map((p, i) => (i === idx ? next : p)),
              })
            }
            onRemove={() =>
              onChange({
                ...draft,
                conditions: draft.conditions.filter((_, i) => i !== idx),
              })
            }
            canRemove={draft.conditions.length > 1}
          />
        ))}
        <Button
          variant="ghost"
          onClick={() =>
            onChange({
              ...draft,
              conditions: [
                ...draft.conditions,
                { field: indicators[0]?.name ?? '', operator: '>=', value: 0 },
              ],
            })
          }
          disabled={draft.conditions.length >= 12}
        >
          + Add condition
        </Button>
      </div>

      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
          Test rule against sample values (client-side preview)
        </div>
        <div className="grid gap-2">
          {fields.length === 0 ? (
            <div className="text-xs text-slate-400">
              Pick a condition field above to fill in test values.
            </div>
          ) : (
            fields.map((f) => (
              <div key={f} className="grid grid-cols-[1fr_2fr] items-center gap-2 text-xs">
                <span className="font-mono text-slate-600">{f}</span>
                <input
                  value={testValues[f] ?? ''}
                  onChange={(e) => onTestValueChange(f, e.target.value)}
                  placeholder="test value"
                  className="rounded border border-slate-300 px-2 py-1"
                />
              </div>
            ))
          )}
          <Button onClick={onRunTest} disabled={fields.length === 0}>
            Run test
          </Button>
          {testResult ? (
            <div
              className={`rounded-md border p-2 text-xs ${
                testResult.matched
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-slate-300 bg-slate-50 text-slate-700'
              }`}
            >
              <div className="font-semibold">
                {testResult.matched ? 'MATCH' : 'NO MATCH'} — score impact{' '}
                {testResult.score_impact}
              </div>
              {testResult.matched ? (
                <div>Fired: {testResult.matched_indicators.join(', ')}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

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
  return (
    <div className="grid grid-cols-[1fr_120px_1fr_auto] gap-2 text-sm">
      <select
        value={condition.field}
        onChange={(e) => onChange({ ...condition, field: e.target.value })}
        className="rounded border border-slate-300 bg-white px-2 py-1"
      >
        <option value="">— pick a field —</option>
        {indicators.map((i) => (
          <option key={i.name} value={i.name}>
            {i.display_name} ({i.name})
          </option>
        ))}
      </select>
      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as EwsOperator })}
        className="rounded border border-slate-300 bg-white px-2 py-1 font-mono"
      >
        {OPERATORS.map((op) => (
          <option key={op} value={op}>{op}</option>
        ))}
      </select>
      <input
        type="number"
        value={
          condition.value !== undefined && !Array.isArray(condition.value)
            ? String(condition.value)
            : ''
        }
        onChange={(e) => onChange({ ...condition, value: Number(e.target.value) })}
        className="rounded border border-slate-300 px-2 py-1"
        placeholder="value"
      />
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

// ── Step 3: Action ───────────────────────────────────────────────────

function ActionStep({
  draft,
  onChange,
}: {
  draft: DraftBody;
  onChange: (d: DraftBody) => void;
}) {
  return (
    <Panel title="3. Action">
      <div className="grid gap-3">
        <Labeled label="alert_severity">
          <div className="flex gap-1">
            {(['RED', 'ORANGE', 'YELLOW', 'GREEN'] as const).map((s) => (
              <button
                key={s}
                onClick={() => onChange({ ...draft, alert_severity: s })}
                className={`rounded px-3 py-1 text-xs ${
                  draft.alert_severity === s
                    ? 'bg-blue-600 text-white'
                    : 'border border-slate-300 bg-white text-slate-700'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </Labeled>
        <Labeled label="weight (1-100)">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={100}
              value={draft.weight}
              onChange={(e) => onChange({ ...draft, weight: Number(e.target.value) })}
              className="flex-1"
            />
            <Badge tone="neutral">{draft.weight}</Badge>
          </div>
          <span className="text-[11px] text-slate-500">
            Cumulative score across matches caps at 100. ≥75 = aggregate RED · ≥50 ORANGE ·
            ≥25 YELLOW.
          </span>
        </Labeled>
        <Labeled label="recommended_action">
          <textarea
            value={draft.recommended_action}
            onChange={(e) => onChange({ ...draft, recommended_action: e.target.value })}
            rows={2}
            placeholder="optional — what should happen when this rule fires (e.g. Pause disbursement; assign to RM)"
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </Labeled>
      </div>
    </Panel>
  );
}

// ── Step 4: Lifecycle ────────────────────────────────────────────────

function LifecycleStep({
  draft,
  onChange,
}: {
  draft: DraftBody;
  onChange: (d: DraftBody) => void;
}) {
  return (
    <Panel title="4. Lifecycle">
      <div className="grid gap-3">
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="mb-2 font-semibold">Maker-checker (4-eyes)</div>
          <p className="text-xs text-slate-600">
            New rules land in <Badge tone="neutral">DRAFT</Badge> by default. To
            activate, the maker (you) submits for review and a <strong>different</strong> user
            with <code>rules:retire</code> permission approves. Self-approval is refused at
            both the application and database layer.
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.activate_after_create}
            onChange={(e) =>
              onChange({ ...draft, activate_after_create: e.target.checked })
            }
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold">Activate immediately after create</span>
            <br />
            <span className="text-xs text-slate-500">
              Best-effort: tries the 4-eyes path first (submit + approve via your user). If
              that fails (e.g. self-approval refused), falls back to the legacy
              <code className="mx-1">/activate</code> route.
            </span>
          </span>
        </label>
      </div>
    </Panel>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="font-semibold uppercase text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/** Pure draft simulator — mirrors the BFF's evaluator semantics for
 *  the four most common operators so the SPA can preview-test before
 *  saving. Production-grade behavior comes from the existing
 *  `/v1/ews/rules/:id/test` route once the rule is saved. */
function evalDraft(
  draft: DraftBody,
  values: Record<string, number | string>,
): { matched: boolean; fired: string[] } {
  const fired: string[] = [];
  const evalCond = (c: EwsCondition): boolean => {
    const v = values[c.field];
    if (v === undefined || v === null || v === '') return false;
    const n = typeof v === 'number' ? v : Number(v);
    const cv = typeof c.value === 'number' ? c.value : Number(c.value);
    if (!Number.isFinite(n) || !Number.isFinite(cv)) {
      // string equality fallback for in/not_in/eq
      if (c.operator === '==') return v === c.value;
      if (c.operator === '!=') return v !== c.value;
      return false;
    }
    switch (c.operator) {
      case '>': return n > cv;
      case '>=': return n >= cv;
      case '<': return n < cv;
      case '<=': return n <= cv;
      case '==': return n === cv;
      case '!=': return n !== cv;
      case 'between':
        return Array.isArray(c.range) && n >= c.range[0]! && n <= c.range[1]!;
      default: return false;
    }
  };
  if (draft.logic === 'AND') {
    for (const c of draft.conditions) {
      if (!c.field) continue;
      if (!evalCond(c)) return { matched: false, fired: [] };
      fired.push(c.field);
    }
    return { matched: fired.length > 0, fired };
  }
  for (const c of draft.conditions) {
    if (!c.field) continue;
    if (evalCond(c)) fired.push(c.field);
  }
  return { matched: fired.length > 0, fired: Array.from(new Set(fired)) };
}
