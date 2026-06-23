// web/src/modules/rules/RulesEnginePage.tsx
//
// Module 5.2 — Rules Engine.
//
// Central rule authoring + template library that powers Validation
// Rules, Anomaly patterns, Fraud rules, and EWS indicators.
//
// Tabbed UI over 5 surfaces (every backend route already shipped —
// this page is the unified SPA front for them):
//   • Templates   — library gallery (M5.1 RULE_TEMPLATES, 12 seed rows)
//   • Custom      — tenant-created templates + clone-from-library
//   • Indicators  — full EWS indicator catalogue
//   • Simulator   — POST /v1/rules/simulate, shows pass/fail/samples
//                   per spec acceptance
//   • Scenarios   — M16.1 scenario library
//
// All actions cross-link to the existing /rules + /rules/ews/* pages
// (RuleConfigPage, EwsRuleBuilderPage, EwsRuleWizardPage, EwsRuleDiffPage).

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Copy,
  ExternalLink,
  FlaskConical,
  Layers,
  Library,
  ListTree,
  Play,
  // RefreshCw,
  Sparkles,
} from 'lucide-react';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  api,
  type CustomRuleTemplate,
  type EwsIndicatorRow,
  type RuleSimulationResult,
  type RuleTemplate,
  type ScenarioPresetRow,
} from '@/lib/api';

const SEVERITY_TONE: Record<string, 'success' | 'warning' | 'danger' | 'blue'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};
const VERTICAL_TONE: Record<string, 'blue' | 'success' | 'warning'> = {
  banking: 'blue',
  insurance: 'warning',
  both: 'success',
};

type Tab = 'templates' | 'custom' | 'indicators' | 'simulator' | 'scenarios';

export function RulesEnginePage() {
  const [tab, setTab] = useState<Tab>('templates');

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Rules Engine"
        subtitle="Templates · custom rules · indicators · simulator · scenarios"
        actions={
          <Link
            to="/rules/ews"
            className="inline-flex items-center gap-1 rounded border border-divider px-3 py-1.5 text-sm hover:border-action hover:text-action"
            data-testid="re-link-ews-builder"
          >
            EWS Rule Builder <ExternalLink size={12} />
          </Link>
        }
      />

      <div className="flex flex-wrap gap-1 border-b border-divider/40" role="tablist">
        <TabBtn id="templates" active={tab} setActive={setTab} icon={<Library size={14} />}>
          Templates
        </TabBtn>
        <TabBtn id="custom" active={tab} setActive={setTab} icon={<Copy size={14} />}>
          Custom
        </TabBtn>
        <TabBtn id="indicators" active={tab} setActive={setTab} icon={<ListTree size={14} />}>
          Indicators
        </TabBtn>
        <TabBtn id="simulator" active={tab} setActive={setTab} icon={<FlaskConical size={14} />}>
          Simulator
        </TabBtn>
        <TabBtn id="scenarios" active={tab} setActive={setTab} icon={<Layers size={14} />}>
          Scenarios
        </TabBtn>
      </div>

      {tab === 'templates' && <TemplatesTab />}
      {tab === 'custom' && <CustomTab />}
      {tab === 'indicators' && <IndicatorsTab />}
      {tab === 'simulator' && <SimulatorTab />}
      {tab === 'scenarios' && <ScenariosTab />}
    </div>
  );
}

function TabBtn({
  id,
  active,
  setActive,
  icon,
  children,
}: {
  id: Tab;
  active: Tab;
  setActive: (t: Tab) => void;
  icon: JSX.Element;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      onClick={() => setActive(id)}
      className={`inline-flex items-center gap-1 px-3 py-2 text-sm border-b-2 transition-colors ${
        active === id
          ? 'border-action text-action font-medium'
          : 'border-transparent text-muted hover:text-foreground'
      }`}
      data-testid={`re-tab-${id}`}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Templates tab ──────────────────────────────────────────────────────

function TemplatesTab() {
  const [vertical, setVertical] = useState<'all' | 'banking' | 'insurance' | 'both'>('all');
  const [category, setCategory] = useState<string>('');

  const catsQ = useQuery({ queryKey: ['re-cats'], queryFn: () => api.ruleTemplateCategories() });
  const tplQ = useQuery({
    queryKey: ['re-templates', vertical, category],
    queryFn: () =>
      api.ruleTemplates({
        vertical: vertical === 'all' ? undefined : vertical,
        category: category || undefined,
      }),
  });

  return (
    <div className="space-y-4">
      <Panel title="Library gallery">
        <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
          <label className="text-xs text-muted">
            Vertical
            <select
              value={vertical}
              onChange={(e) => setVertical(e.target.value as typeof vertical)}
              className="ml-2 rounded border border-divider px-2 py-1 text-sm"
              data-testid="re-filter-vertical"
            >
              <option value="all">All</option>
              <option value="banking">Banking</option>
              <option value="insurance">Insurance</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label className="text-xs text-muted">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="ml-2 rounded border border-divider px-2 py-1 text-sm"
              data-testid="re-filter-category"
            >
              <option value="">All</option>
              {(catsQ.data?.items ?? []).map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>

        {tplQ.isLoading ? (
          <p className="text-sm text-muted">Loading templates…</p>
        ) : (tplQ.data?.items ?? []).length === 0 ? (
          <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted">
            No templates match the current filter.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="re-templates-table">
            <thead className="text-left text-xs uppercase text-muted">
              <tr className="border-b border-divider/40">
                <th className="py-2">Template</th>
                <th>Vertical</th>
                <th>Category</th>
                <th>Severity</th>
                <th>Indicators</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(tplQ.data?.items ?? []).map((t) => (
                <TemplateRow key={t.id} tpl={t} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function TemplateRow({ tpl }: { tpl: RuleTemplate }) {
  const cloneM = useMutation({
    mutationFn: () => api.ruleTemplateCloneFromLibrary({ source_template_id: tpl.id }),
  });
  return (
    <tr className="border-b border-divider/40 hover:bg-divider/10" data-testid={`re-tpl-${tpl.id}`}>
      <td className="py-2">
        <div className="font-medium">{tpl.name}</div>
        <div className="text-xs text-muted font-mono">{tpl.id}</div>
      </td>
      <td><Badge tone={VERTICAL_TONE[tpl.vertical] ?? 'blue'}>{tpl.vertical}</Badge></td>
      <td className="text-xs">{tpl.category}</td>
      <td><Badge tone={SEVERITY_TONE[tpl.recommended_severity] ?? 'blue'}>{tpl.recommended_severity}</Badge></td>
      <td className="text-xs">{tpl.supporting_indicators.length}</td>
      <td className="text-right">
        <Button
          variant="ghost"
          onClick={() => cloneM.mutate()}
          disabled={cloneM.isPending}
          data-testid={`re-clone-${tpl.id}`}
        >
          {cloneM.isPending ? 'Cloning…' : (
            <>
              <Copy size={12} /> Clone
            </>
          )}
        </Button>
      </td>
    </tr>
  );
}

// ─── Custom tab ──────────────────────────────────────────────────────

function CustomTab() {
  const q = useQuery({ queryKey: ['re-custom'], queryFn: () => api.ruleTemplatesCustomList() });
  return (
    <Panel title="Custom templates (tenant-scoped)">
      {q.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (q.data?.items ?? []).length === 0 ? (
        <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted">
          No custom templates yet. Clone a library template from the Templates tab to start.
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="re-custom-table">
          <thead className="text-left text-xs uppercase text-muted">
            <tr className="border-b border-divider/40">
              <th className="py-2">Name</th>
              <th>Category</th>
              <th>Severity</th>
              <th>Cloned from</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((t: CustomRuleTemplate) => (
              <tr
                key={t.custom_template_id}
                className="border-b border-divider/40"
                data-testid={`re-custom-row-${t.custom_template_id}`}
              >
                <td className="py-2">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-muted font-mono">{t.custom_template_id}</div>
                </td>
                <td className="text-xs">{t.category}</td>
                <td><Badge tone={SEVERITY_TONE[t.recommended_severity] ?? 'blue'}>{t.recommended_severity}</Badge></td>
                <td className="text-xs font-mono">{t.cloned_from ?? '—'}</td>
                <td className="text-xs">
                  {t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ─── Indicators tab ──────────────────────────────────────────────────

function IndicatorsTab() {
  const q = useQuery({ queryKey: ['re-indicators'], queryFn: () => api.ewsRulesIndicators() });
  return (
    <Panel title="EWS indicator catalogue">
      {q.isLoading ? (
        <p className="text-sm text-muted">Loading indicators…</p>
      ) : !q.data || (q.data.items ?? []).length === 0 ? (
        <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted">
          No indicators registered.
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="re-indicators-table">
          <thead className="text-left text-xs uppercase text-muted">
            <tr className="border-b border-divider/40">
              <th className="py-2">ID</th>
              <th>Name</th>
              <th>Family</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {(q.data.items as EwsIndicatorRow[]).map((i) => (
              <tr
                key={i.id}
                className="border-b border-divider/40"
                data-testid={`re-ind-row-${i.id}`}
              >
                <td className="py-2 font-mono text-xs">{i.id}</td>
                <td>{i.name}</td>
                <td className="text-xs">{i.family ?? '—'}</td>
                <td className="text-xs text-muted">{i.description ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ─── Simulator tab ───────────────────────────────────────────────────

function SimulatorTab() {
  const [tplId, setTplId] = useState('');
  const [scnId, setScnId] = useState('');
  const [customers, setCustomers] = useState('500');

  const tplQ = useQuery({ queryKey: ['re-templates-all'], queryFn: () => api.ruleTemplates() });
  const scnQ = useQuery({ queryKey: ['re-scenarios-all'], queryFn: () => api.scenariosLibrary() });

  const simM = useMutation<RuleSimulationResult, Error>({
    mutationFn: () =>
      api.ruleSimulate({
        rule_template_id: tplId,
        scenario_preset_id: scnId,
        customer_count: Number(customers),
      }),
  });
  const result = simM.data;

  const canSim = tplId && scnId && Number(customers) > 0;

  return (
    <div className="space-y-4">
      <Panel title="Rule simulator — pass/fail + sample matches + projected volume">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <label className="text-xs text-muted">
            Template
            <select
              value={tplId}
              onChange={(e) => setTplId(e.target.value)}
              className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm"
              data-testid="re-sim-template"
            >
              <option value="">Pick a template…</option>
              {(tplQ.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.recommended_severity})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Scenario
            <select
              value={scnId}
              onChange={(e) => setScnId(e.target.value)}
              className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm"
              data-testid="re-sim-scenario"
            >
              <option value="">Pick a scenario…</option>
              {(scnQ.data?.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.severity})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Customer count
            <input
              type="number"
              value={customers}
              onChange={(e) => setCustomers(e.target.value)}
              min={10}
              max={10000}
              className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm"
              data-testid="re-sim-customers"
            />
          </label>
        </div>
        <Button
          variant="primary"
          onClick={() => simM.mutate()}
          disabled={!canSim || simM.isPending}
          data-testid="re-sim-run"
        >
          {simM.isPending ? 'Running…' : (
            <>
              <Play size={14} /> Run simulation
            </>
          )}
        </Button>
        {simM.error && (
          <div
            className="mt-3 rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
            data-testid="re-sim-error"
          >
            <AlertTriangle size={14} className="inline mr-1" />
            {simM.error.message}
          </div>
        )}
      </Panel>

      {result && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard
              label="Pass (matched)"
              value={result.pass_count.toString()}
              sub={`of ${result.customer_count}`}
              tone="success"
              testId="re-sim-pass"
            />
            <MetricCard
              label="Fail (not matched)"
              value={result.fail_count.toString()}
              tone="blue"
              testId="re-sim-fail"
            />
            <MetricCard
              label="Fire rate"
              value={`${(result.fire_rate * 100).toFixed(1)}%`}
              sub={`× ${result.amplification.toFixed(2)} vs baseline`}
              tone={result.amplification > 2 ? 'warning' : 'blue'}
              testId="re-sim-rate"
            />
            <MetricCard
              label="Projected alerts / day"
              value={result.projected_alert_volume_per_day.toString()}
              sub="14d population turnover"
              tone={result.projected_alert_volume_per_day > 20 ? 'warning' : 'success'}
              testId="re-sim-volume"
            />
          </div>

          <Panel title="Sample matched records" data-testid="re-sim-samples-panel">
            {result.sample_matched_records.length === 0 ? (
              <p className="text-sm text-muted">
                <Sparkles size={14} className="inline mr-1" />
                Rule fired on zero customers in this scenario.
              </p>
            ) : (
              <table className="w-full text-sm" data-testid="re-sim-samples-table">
                <thead className="text-left text-xs uppercase text-muted">
                  <tr className="border-b border-divider/40">
                    <th className="py-2">Customer</th>
                    <th>Segment</th>
                    <th>Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sample_matched_records.map((rec) => (
                    <tr
                      key={rec.customer_id}
                      className="border-b border-divider/40"
                      data-testid={`re-sim-sample-${rec.customer_id}`}
                    >
                      <td className="py-2 font-mono text-xs">{rec.customer_id}</td>
                      <td className="text-xs">{rec.segment}</td>
                      <td className="text-xs">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 rounded bg-divider/40 overflow-hidden">
                            <div
                              className="h-full bg-action"
                              style={{ width: `${(rec.contribution * 100).toFixed(0)}%` }}
                            />
                          </div>
                          <span className="font-mono">{rec.contribution.toFixed(2)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="By severity" data-testid="re-sim-severity-panel">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <MetricCard label="Critical" value={result.by_severity.critical.toString()} tone="danger" />
              <MetricCard label="High" value={result.by_severity.high.toString()} tone="danger" />
              <MetricCard label="Medium" value={result.by_severity.medium.toString()} tone="warning" />
              <MetricCard label="Low" value={result.by_severity.low.toString()} tone="success" />
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

// ─── Scenarios tab ───────────────────────────────────────────────────

function ScenariosTab() {
  const q = useQuery({ queryKey: ['re-scenarios'], queryFn: () => api.scenariosLibrary() });

  const grouped = useMemo(() => {
    const map = new Map<string, ScenarioPresetRow[]>();
    for (const s of q.data?.items ?? []) {
      const key = s.regulator || 'OTHER';
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    return Array.from(map.entries());
  }, [q.data]);

  return (
    <Panel title="Scenario library">
      {q.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : grouped.length === 0 ? (
        <p className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted">
          No scenarios registered.
        </p>
      ) : (
        <div className="space-y-6">
          {grouped.map(([regulator, items]) => (
            <div key={regulator}>
              <h3 className="text-xs uppercase text-muted mb-2">{regulator}</h3>
              <table className="w-full text-sm" data-testid={`re-scenarios-${regulator}`}>
                <thead className="text-left text-xs uppercase text-muted">
                  <tr className="border-b border-divider/40">
                    <th className="py-2">Scenario</th>
                    <th>Category</th>
                    <th>Severity</th>
                    <th>GDP</th>
                    <th>Rate</th>
                    <th>FX</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-divider/40"
                      data-testid={`re-scenario-row-${s.id}`}
                    >
                      <td className="py-2">
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs text-muted font-mono">{s.id}</div>
                      </td>
                      <td className="text-xs">{s.category}</td>
                      <td>
                        <Badge tone={s.severity === 'severe' ? 'danger' : s.severity === 'moderate' ? 'warning' : 'success'}>
                          {s.severity}
                        </Badge>
                      </td>
                      <td className="text-xs font-mono">{s.shocks.gdp >= 0 ? '+' : ''}{s.shocks.gdp}%</td>
                      <td className="text-xs font-mono">{s.shocks.rate >= 0 ? '+' : ''}{s.shocks.rate}bps</td>
                      <td className="text-xs font-mono">{s.shocks.fx >= 0 ? '+' : ''}{s.shocks.fx}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center justify-end">
        <Link
          to="/scenario"
          className="text-xs text-action hover:underline inline-flex items-center gap-1"
        >
          Run a scenario simulation <ArrowRight size={12} />
        </Link>
      </div>
    </Panel>
  );
}
