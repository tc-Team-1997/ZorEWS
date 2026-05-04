import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CheckCircle2,
  AlertTriangle,
  PlayCircle,
  Search,
  Send,
  SlidersHorizontal,
  XCircle,
  ShieldCheck,
  Archive,
  History,
  Layers,
  Sparkles,
  FlaskConical,
  X,
} from 'lucide-react';
import {
  api,
  type BacktestResult,
  type RuleConditionNode,
  type RuleListResponse,
  type RuleNotifyRole,
  type RuleProduct,
  type RuleTransition,
  type RuleV2,
  type RuleV2State,
  type RulePerformance,
  type RulePerformanceStatus,
  type BankingVariable,
} from '@/lib/api';
import { Badge, type BadgeTone, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';
import { color } from '@/styles/tokens';
import { cn } from '@/lib/cn';

// ── Maps + tones ──────────────────────────────────────────────────────

const STATE_TONE: Record<RuleV2State, BadgeTone> = {
  draft: 'neutral',
  pending_review: 'warning',
  approved: 'blue',
  active: 'success',
  rejected: 'danger',
  deprecated: 'neutral',
};

const PERF_TONE: Record<RulePerformanceStatus, BadgeTone> = {
  performing: 'success',
  underperforming: 'danger',
  deprecated: 'neutral',
  no_data: 'neutral',
};

const PRODUCT_LABEL: Record<RuleProduct, string> = {
  home_loan: 'Home loan',
  auto_loan: 'Auto loan',
  personal_loan: 'Personal loan',
  credit_card: 'Credit card',
  msme: 'MSME',
  agri: 'Agri / KCC',
};

const STATE_OPTIONS: { value: '' | RuleV2State; label: string }[] = [
  { value: '', label: 'All states' },
  { value: 'draft', label: 'Draft' },
  { value: 'pending_review', label: 'Pending review' },
  { value: 'approved', label: 'Approved' },
  { value: 'active', label: 'Active' },
  { value: 'deprecated', label: 'Deprecated' },
];

const PRODUCT_OPTIONS: { value: '' | RuleProduct; label: string }[] = [
  { value: '', label: 'All products' },
  { value: 'home_loan', label: PRODUCT_LABEL.home_loan },
  { value: 'auto_loan', label: PRODUCT_LABEL.auto_loan },
  { value: 'personal_loan', label: PRODUCT_LABEL.personal_loan },
  { value: 'credit_card', label: PRODUCT_LABEL.credit_card },
  { value: 'msme', label: PRODUCT_LABEL.msme },
  { value: 'agri', label: PRODUCT_LABEL.agri },
];

const TRANSITION_LABEL: Record<RuleTransition, string> = {
  submit: 'Submit for review',
  approve: 'Approve',
  reject: 'Reject',
  activate: 'Activate',
  deprecate: 'Deprecate',
  edit: 'Edit',
};

const TRANSITION_ICON: Record<RuleTransition, typeof Send> = {
  submit: Send,
  approve: CheckCircle2,
  reject: XCircle,
  activate: PlayCircle,
  deprecate: Archive,
  edit: Sparkles,
};

// ── Page ──────────────────────────────────────────────────────────────

export function RuleConfigPage() {
  const [stateFilter, setStateFilter] = useState<'' | RuleV2State>('');
  const [productFilter, setProductFilter] = useState<'' | RuleProduct>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  useChatContext({ page: 'rules' });

  // Search is URL-synced (?q=) so an analyst can deep-link or share a
  // narrowed list. Empty string = no search.
  const search = searchParams.get('q') ?? '';
  const setSearch = (next: string) => {
    const sp = new URLSearchParams(searchParams);
    if (next.trim()) sp.set('q', next);
    else sp.delete('q');
    setSearchParams(sp, { replace: true });
  };

  const { data, isLoading } = useQuery<RuleListResponse>({
    queryKey: ['rules.v2', stateFilter, productFilter],
    queryFn: () =>
      api.rulesV2({
        state: stateFilter || undefined,
        product: productFilter || undefined,
      }),
  });

  const variables = useQuery({
    queryKey: ['rules.variables'],
    queryFn: api.ruleVariables,
  });

  const allItems = data?.items ?? [];

  // Search is applied client-side over the server-filtered list. Lower-case
  // substring match against the rule name + id so analysts can search by
  // either ("salary" or "r-22"). The server-side filters (state, product)
  // already reduced the dataset; search further narrows it.
  const items = useMemo(() => {
    if (!search.trim()) return allItems;
    const needle = search.trim().toLowerCase();
    return allItems.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.id.toLowerCase().includes(needle),
    );
  }, [allItems, search]);

  const open = items.find((r) => r.id === openId) ?? items[0];

  const filtersActive =
    stateFilter !== '' || productFilter !== '' || search.trim() !== '';

  const counts = useMemo(() => {
    const c = { active: 0, pending_review: 0, draft: 0, performing: 0, underperforming: 0 };
    for (const r of items) {
      if (r.state === 'active') c.active++;
      if (r.state === 'pending_review') c.pending_review++;
      if (r.state === 'draft') c.draft++;
      if (r.performance.status === 'performing') c.performing++;
      if (r.performance.status === 'underperforming') c.underperforming++;
    }
    return c;
  }, [items]);

  return (
    <div>
      <PageHeader
        title="Rule Configuration"
        subtitle={
          isLoading
            ? 'Loading rules…'
            : filtersActive
              ? `${items.length} of ${allItems.length} rule${allItems.length === 1 ? '' : 's'} match · maker-checker live · backtest + performance`
              : `${items.length} rule${items.length === 1 ? '' : 's'} · maker-checker live · backtest + performance`
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-4">
        <MetricCard label="Active" value={counts.active} tone="success" />
        <MetricCard label="Pending review" value={counts.pending_review} tone="warning" />
        <MetricCard label="Draft" value={counts.draft} tone="neutral" />
        <MetricCard label="Performing" value={counts.performing} tone="success" />
        <MetricCard
          label="Underperforming"
          value={counts.underperforming}
          tone={counts.underperforming > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <Panel
        title="Filters"
        action={<SlidersHorizontal size={14} className="text-muted" />}
        className="mb-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block sm:col-span-1">
            <span className="label">Search</span>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
              />
              <input
                type="text"
                className="input pl-8 pr-8"
                placeholder="Name or rule id…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="filter-search"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  data-testid="filter-search-clear"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink-sub p-0.5 rounded"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </label>
          <label className="block">
            <span className="label">Lifecycle state</span>
            <select
              className="input"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value as '' | RuleV2State)}
              data-testid="filter-state"
            >
              {STATE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Product</span>
            <select
              className="input"
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value as '' | RuleProduct)}
              data-testid="filter-product"
            >
              {PRODUCT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 items-start">
        {/*
         * Sticky list panel on xl screens — stays in view as the
         * detail's long sub-panels scroll. Capped at viewport height
         * minus the page padding (~6rem) with internal scroll so 17+
         * rules don't push the list off-screen.
         */}
        <div
          className="xl:col-span-2 xl:sticky xl:top-4 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto xl:pr-2 space-y-2"
          data-testid="rule-list"
        >
          {items.map((r) => (
            <RuleListRow
              key={r.id}
              rule={r}
              perf={r.performance}
              isOpen={open?.id === r.id}
              onClick={() => setOpenId(r.id)}
            />
          ))}
          {items.length === 0 && !isLoading && (
            <EmptyState
              hasFilters={filtersActive}
              onClear={() => {
                setStateFilter('');
                setProductFilter('');
                setSearch('');
              }}
            />
          )}
        </div>

        <div className="xl:col-span-3 min-w-0">
          {open ? (
            <RuleDetailPanel
              rule={open}
              variables={variables.data?.categories ?? null}
            />
          ) : (
            <Panel>
              <p className="caption">Select a rule from the list to inspect it.</p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Empty state shown when the list filters return zero rules. If filters
 * are active, surface a "Clear filters" affordance so the user isn't
 * stuck wondering why the list is empty.
 */
function EmptyState({
  hasFilters,
  onClear,
}: {
  hasFilters: boolean;
  onClear: () => void;
}) {
  return (
    <Panel>
      <div className="text-center py-6" data-testid="rule-list-empty">
        <div className="w-10 h-10 mx-auto rounded-full bg-divider flex items-center justify-center mb-3">
          <Search size={18} className="text-muted" />
        </div>
        <p className="text-[13px] text-ink font-medium mb-1">
          {hasFilters ? 'No rules match these filters' : 'No rules to display'}
        </p>
        <p className="text-[12px] text-muted mb-3">
          {hasFilters
            ? 'Try widening the filter set or clearing the search.'
            : 'New rules will appear here as they are created.'}
        </p>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={onClear} data-testid="rule-list-empty-clear">
            Clear filters
          </Button>
        )}
      </div>
    </Panel>
  );
}

// ── List row ──────────────────────────────────────────────────────────

// Outcome severity → left-edge color strip. Lets analysts scan the list
// for "where are the criticals?" without reading individual rule names.
const SEVERITY_STRIP: Record<string, string> = {
  critical: 'bg-danger',
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-success',
};

function RuleListRow({
  rule,
  perf,
  isOpen,
  onClick,
}: {
  rule: RuleV2;
  perf: RulePerformance;
  isOpen: boolean;
  onClick: () => void;
}) {
  const stripClass = SEVERITY_STRIP[rule.outcome.severity] ?? 'bg-divider';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`rule-row-${rule.id}`}
      aria-pressed={isOpen}
      className={cn(
        'w-full text-left rounded-lg border bg-surface relative overflow-hidden transition-all focus:outline-none focus:ring-2 focus:ring-brand-blue/40',
        // Stronger active-state cue: thicker border + ring + lift.
        isOpen
          ? 'border-action shadow-md ring-1 ring-action/20'
          : 'border-divider hover:border-action/60 hover:shadow-sm',
      )}
    >
      {/* Outcome-severity strip on the left edge — wider when the row
          is open so the active state reads at a glance. */}
      <span
        aria-hidden
        className={cn('absolute top-0 left-0 bottom-0', stripClass, isOpen ? 'w-1.5' : 'w-1')}
      />
      <div className={cn('px-4 py-3', isOpen ? 'pl-5' : 'pl-4')}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink truncate">{rule.name}</p>
            <p className="text-[10px] text-muted mt-0.5">
              <span className="font-mono">{rule.id}</span> · v{rule.version} · {rule.family}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge tone={STATE_TONE[rule.state]} className="uppercase tracking-wide text-[9px]">
              {rule.state.replace('_', ' ')}
            </Badge>
            {rule.state === 'active' && (
              <Badge tone={PERF_TONE[perf.status]} className="text-[9px]">
                {perf.status}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {rule.applicable_products.length === 0 ? (
            <span className="text-[10px] text-muted">All products</span>
          ) : (
            rule.applicable_products.map((p) => (
              <span
                key={p}
                className="text-[10px] px-1.5 py-[1px] rounded bg-divider text-ink-sub"
              >
                {PRODUCT_LABEL[p]}
              </span>
            ))
          )}
          {rule.state === 'active' && (
            <span className="text-[10px] text-muted ml-auto">
              {perf.triggers_month}/mo · TP {perf.true_positive_rate}%
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────

/**
 * Tabs that group the detail sub-panels. Order = visual order in the
 * tablist; the first tab is the default. Tab state is URL-synced via
 * ?tab= so refresh + share-links preserve the analyst's current view.
 *
 * Switching the open rule does NOT reset the tab — if the analyst is
 * comparing Audit trails across rules, they want to stay on Audit when
 * picking a different row in the list.
 */
type DetailTab = 'overview' | 'workflow' | 'backtest' | 'performance' | 'audit';

const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'performance', label: 'Performance' },
  { id: 'audit', label: 'Audit' },
];

function isDetailTab(v: string | null): v is DetailTab {
  return DETAIL_TABS.some((t) => t.id === v);
}

function RuleDetailPanel({
  rule,
  variables,
}: {
  rule: RuleV2 & { performance: RulePerformance; legal_transitions: RuleTransition[] };
  variables: Record<string, BankingVariable[]> | null;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: DetailTab = isDetailTab(tabParam) ? tabParam : 'overview';
  const setTab = (next: DetailTab) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'overview') sp.delete('tab');
    else sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <div className="space-y-4">
      {/* Always-visible header — name + state + identity stats. The
          tabbed card sits below; switching tabs doesn't change which
          rule is in focus. */}
      <Panel
        title={rule.name}
        action={
          <Badge tone={STATE_TONE[rule.state]} className="uppercase tracking-wide">
            {rule.state.replace('_', ' ')}
          </Badge>
        }
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Stat label="Version" value={`v${rule.version}`} />
          <Stat label="Owner" value={rule.owner_id} mono />
          <Stat label="Family" value={rule.family} />
          <Stat
            label="Updated"
            value={new Date(rule.updated_at).toLocaleDateString()}
          />
        </div>
        {rule.regulatory_ref && (
          <p className="text-[11px] text-muted">
            <span className="font-medium text-ink-sub">Regulatory ref:</span>{' '}
            {rule.regulatory_ref}
          </p>
        )}
      </Panel>

      {/* Unified tabbed card — tabs sit as a header strip on top of the
          shared card; the active tab's content fills the body. The
          tablist is sticky inside the card so it stays in view as
          long sub-sections (audit timelines, backtest charts) scroll
          past. Sub-components inside use the bare <Section> helper
          rather than nested <Panel>s so the visual is one card, not
          panels-within-panels. */}
      <section
        className="card overflow-hidden"
        data-testid="detail-tab-card"
        aria-labelledby="rule-detail-tabs-label"
      >
        <span id="rule-detail-tabs-label" className="sr-only">
          Rule detail sections
        </span>
        <div
          role="tablist"
          aria-label="Rule detail sections"
          data-testid="detail-tablist"
          className="sticky top-0 z-10 flex flex-wrap gap-1.5 px-3 py-2 bg-surface/95 backdrop-blur-sm border-b border-divider"
        >
          {DETAIL_TABS.map((t) => {
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={isActive}
                aria-controls={`tabpanel-${t.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setTab(t.id)}
                data-testid={`detail-tab-${t.id}`}
                className={cn(
                  'text-[12px] px-3 py-1.5 rounded-input border transition-colors focus:outline-none focus:ring-2 focus:ring-brand-blue/40',
                  isActive
                    ? 'border-action bg-action text-white shadow-sm'
                    : 'border-divider bg-surface text-ink-sub hover:border-action/60 hover:text-action',
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="p-5">
          {activeTab === 'overview' && (
            <div
              role="tabpanel"
              id="tabpanel-overview"
              aria-labelledby="tab-overview"
              className="space-y-5 divide-y divide-divider [&>:not(:first-child)]:pt-5"
            >
              <PlainEnglishPreview rule={rule} variables={variables} />
              <VisualBuilder rule={rule} variables={variables} />
            </div>
          )}
          {activeTab === 'workflow' && (
            <div role="tabpanel" id="tabpanel-workflow" aria-labelledby="tab-workflow">
              <MakerCheckerPanel rule={rule} />
            </div>
          )}
          {activeTab === 'backtest' && (
            <div role="tabpanel" id="tabpanel-backtest" aria-labelledby="tab-backtest">
              <BacktestPanel ruleId={rule.id} />
            </div>
          )}
          {activeTab === 'performance' && (
            <div role="tabpanel" id="tabpanel-performance" aria-labelledby="tab-performance">
              <PerformancePanel perf={rule.performance} state={rule.state} />
            </div>
          )}
          {activeTab === 'audit' && (
            <div role="tabpanel" id="tabpanel-audit" aria-labelledby="tab-audit">
              <AuditPanel rule={rule} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Bare section block used INSIDE the tabbed-card body. Provides a small
 * header (title + optional action) and a content slot, but no card
 * chrome of its own — the outer card owns the chrome. Use this rather
 * than <Panel> for any sub-component that lives inside a tab.
 */
function Section({
  title,
  action,
  children,
  testId,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title && <h3 className="section-title">{title}</h3>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={cn('text-[13px] text-ink mt-0.5', mono && 'font-mono')}>{value}</p>
    </div>
  );
}

// ── Plain-English preview ─────────────────────────────────────────────

function PlainEnglishPreview({
  rule,
  variables,
}: {
  rule: RuleV2;
  variables: Record<string, BankingVariable[]> | null;
}) {
  const variableMap = useMemo(() => {
    const m = new Map<string, BankingVariable>();
    if (variables) {
      for (const arr of Object.values(variables)) for (const v of arr) m.set(v.id, v);
    }
    return m;
  }, [variables]);

  const sentence = formatNode(rule.conditions, variableMap);
  const outcome = `mark them as ${rule.outcome.severity.toUpperCase()} risk, alert priority ${rule.outcome.alert_priority}, notify ${rule.outcome.notify_roles.join(', ')}`;

  return (
    <Section title="Plain-English preview" testId="plain-english">
      <p className="text-[13px] text-ink leading-relaxed">
        <span className="font-medium">If</span> {sentence},{' '}
        <span className="font-medium">then</span> {outcome}.
      </p>
    </Section>
  );
}

function formatNode(node: RuleConditionNode, vars: Map<string, BankingVariable>): string {
  if (node.kind === 'leaf') {
    const v = vars.get(node.condition.variable_id);
    const label = v?.label ?? node.condition.variable_id;
    const val = Array.isArray(node.condition.value)
      ? node.condition.value.join(', ')
      : String(node.condition.value);
    const window = node.condition.window_days ? ` in the last ${node.condition.window_days} days` : '';
    return `${label} ${OP_LABEL[node.condition.op]} ${val}${window}`;
  }
  if (node.op === 'NOT') {
    return `NOT (${node.children.map((c) => formatNode(c, vars)).join(', ')})`;
  }
  return node.children.map((c) => formatNode(c, vars)).join(` ${node.op} `);
}

const OP_LABEL: Record<string, string> = {
  '>': 'is greater than',
  '>=': 'is at least',
  '<': 'is less than',
  '<=': 'is at most',
  '==': 'equals',
  '!=': 'is not',
  in: 'is one of',
  not_in: 'is not one of',
  between: 'is between',
};

// ── Visual builder (read-only condition tree) ─────────────────────────

function VisualBuilder({
  rule,
  variables,
}: {
  rule: RuleV2;
  variables: Record<string, BankingVariable[]> | null;
}) {
  const variableMap = useMemo(() => {
    const m = new Map<string, BankingVariable>();
    if (variables) {
      for (const arr of Object.values(variables)) for (const v of arr) m.set(v.id, v);
    }
    return m;
  }, [variables]);

  return (
    <Section
      title="Visual builder"
      action={<span className="caption">Read-only preview</span>}
    >
      <div data-testid="visual-builder">
        <NodeRenderer node={rule.conditions} vars={variableMap} depth={0} />
      </div>
      <div className="mt-4 pt-3 border-t border-divider">
        <p className="text-[11px] uppercase tracking-wide text-muted mb-2">Outcome</p>
        <div className="flex flex-wrap gap-2 items-center">
          <Badge tone={severityTone(rule.outcome.severity)} className="uppercase">
            {rule.outcome.severity}
          </Badge>
          <span className="text-[11px] text-muted">priority</span>
          <span className="font-mono text-[11px] text-ink">{rule.outcome.alert_priority}</span>
          <span className="text-[11px] text-muted">notify</span>
          {rule.outcome.notify_roles.map((r: RuleNotifyRole) => (
            <span
              key={r}
              className="text-[10px] px-1.5 py-[1px] rounded bg-divider text-ink-sub"
            >
              {r}
            </span>
          ))}
        </div>
      </div>
      {variables && (
        <details className="mt-4">
          <summary className="text-[12px] text-action font-medium cursor-pointer">
            Variable library ({Object.values(variables).flat().length} variables)
          </summary>
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
            {Object.entries(variables).map(([cat, vars]) => (
              <div key={cat} className="rounded border border-divider p-2">
                <p className="text-[10px] uppercase tracking-wide text-muted mb-1">{cat}</p>
                <ul className="space-y-1">
                  {vars.map((v) => (
                    <li key={v.id} title={v.description}>
                      <span className="font-mono text-ink-sub">{v.id}</span>
                      <span className="text-muted"> · {v.refresh}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}
    </Section>
  );
}

function NodeRenderer({
  node,
  vars,
  depth,
}: {
  node: RuleConditionNode;
  vars: Map<string, BankingVariable>;
  depth: number;
}) {
  if (node.kind === 'leaf') {
    const v = vars.get(node.condition.variable_id);
    return (
      <div className="flex items-center gap-2 text-[12px] py-1">
        <Layers size={12} className="text-muted" />
        <span className="font-medium text-ink">{v?.label ?? node.condition.variable_id}</span>
        <span className="font-mono text-muted">{node.condition.op}</span>
        <span className="font-mono text-ink">
          {Array.isArray(node.condition.value)
            ? `[${node.condition.value.join(', ')}]`
            : String(node.condition.value)}
        </span>
        {node.condition.window_days && (
          <span className="text-[10px] text-muted">· {node.condition.window_days}d window</span>
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'rounded border-l-2 pl-3 my-1',
        node.op === 'AND' ? 'border-action' : node.op === 'OR' ? 'border-warning' : 'border-danger',
      )}
      style={{ marginLeft: depth > 0 ? '12px' : 0 }}
    >
      <p className="text-[10px] uppercase tracking-wide text-muted mb-0.5">{node.op}</p>
      {node.children.map((c, i) => (
        <NodeRenderer key={i} node={c} vars={vars} depth={depth + 1} />
      ))}
    </div>
  );
}

function severityTone(s: string): BadgeTone {
  if (s === 'critical') return 'danger';
  if (s === 'high') return 'danger';
  if (s === 'medium') return 'warning';
  return 'success';
}

// ── Maker-checker actions ─────────────────────────────────────────────

function MakerCheckerPanel({
  rule,
}: {
  rule: RuleV2 & { legal_transitions: RuleTransition[] };
}) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const transition = useMutation({
    mutationFn: ({ t, c }: { t: RuleTransition; c?: string }) =>
      api.ruleTransition(rule.id, t, c),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules.v2'] });
      setComment('');
      setError(null);
    },
    onError: (e: Error) => setError(e.message ?? 'Transition failed'),
  });

  const fire = (t: RuleTransition) => {
    if (t === 'reject' && !comment.trim()) {
      setError('Reject requires a reason.');
      return;
    }
    transition.mutate({ t, c: t === 'reject' ? comment : undefined });
  };

  return (
    <Section title="Maker-checker" action={<ShieldCheck size={14} className="text-success" />}>
      <div className="text-[12px] mb-3">
        <p className="text-ink-sub">
          Owner: <span className="font-mono">{rule.owner_id}</span>
        </p>
        {rule.submitted_by && (
          <p className="text-ink-sub">
            Submitted by: <span className="font-mono">{rule.submitted_by}</span>
          </p>
        )}
        {rule.approved_by && (
          <p className="text-ink-sub">
            Approved by: <span className="font-mono">{rule.approved_by}</span>
          </p>
        )}
      </div>

      {rule.legal_transitions.includes('reject') && (
        <div className="mb-3">
          <label className="label">Reject reason (required for reject)</label>
          <input
            className="input"
            placeholder="Threshold too loose; please tighten before resubmitting"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="reject-comment"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2" data-testid="transition-actions">
        {rule.legal_transitions.length === 0 && (
          <p className="caption">No transitions available from {rule.state}.</p>
        )}
        {rule.legal_transitions.map((t) => {
          const Icon = TRANSITION_ICON[t];
          const variant: 'primary' | 'secondary' | 'ghost' =
            t === 'reject' || t === 'deprecate'
              ? 'ghost'
              : t === 'submit' || t === 'activate'
                ? 'primary'
                : 'secondary';
          return (
            <Button
              key={t}
              type="button"
              variant={variant}
              size="sm"
              onClick={() => fire(t)}
              disabled={transition.isPending}
              data-testid={`transition-${t}`}
            >
              <Icon size={12} className="mr-1.5" />
              {TRANSITION_LABEL[t]}
            </Button>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}

// ── Backtest panel ────────────────────────────────────────────────────

function BacktestPanel({ ruleId }: { ruleId: string }) {
  const backtest = useMutation({
    mutationFn: () => api.ruleBacktest(ruleId),
  });

  return (
    <Section
      title="Backtest"
      action={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => backtest.mutate()}
          disabled={backtest.isPending}
          data-testid="run-backtest"
        >
          <FlaskConical size={12} className="mr-1.5" />
          {backtest.isPending ? 'Running…' : 'Run 12-month backtest'}
        </Button>
      }
    >
      {!backtest.data && !backtest.isPending && (
        <p className="caption">
          Re-runs the rule against the last 12 months of synthetic history. Returns alert
          volume, true/false positive split, coverage, and average days-to-default.
        </p>
      )}
      {backtest.isError && (
        <p role="alert" className="text-[12px] text-danger">
          Backtest failed: {(backtest.error as Error)?.message}
        </p>
      )}
      {backtest.data && <BacktestView result={backtest.data} />}
    </Section>
  );
}

function BacktestView({ result }: { result: BacktestResult }) {
  return (
    <div data-testid="backtest-result">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <MetricCard label="Total alerts" value={result.total_alerts} tone="blue" />
        <MetricCard
          label="True positives"
          value={result.true_positives}
          tone="success"
          sub={`Precision ${result.precision_pct}%`}
        />
        <MetricCard
          label="False positives"
          value={result.false_positives}
          tone={result.false_positives > result.true_positives ? 'danger' : 'neutral'}
        />
        <MetricCard
          label="Coverage"
          value={`${result.coverage_pct}%`}
          tone="warning"
          sub={`Avg lead ${result.avg_days_to_default} days`}
        />
      </div>
      <div className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={result.monthly_volume}>
            <CartesianGrid stroke={color.divider} vertical={false} />
            <XAxis dataKey="month" stroke={color.muted} tick={{ fontSize: 10 }} />
            <YAxis stroke={color.muted} tick={{ fontSize: 10 }} />
            <ChartTooltip />
            <Bar dataKey="count" fill={color.blue} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="caption mt-2">
        Window: <span className="font-mono">{result.window_start}</span> →{' '}
        <span className="font-mono">{result.window_end}</span>
      </p>
    </div>
  );
}

// ── Performance panel ─────────────────────────────────────────────────

function PerformancePanel({ perf, state }: { perf: RulePerformance; state: RuleV2State }) {
  return (
    <Section
      title="Live performance"
      action={
        state === 'active' ? (
          <Badge tone={PERF_TONE[perf.status]} className="uppercase">
            {perf.status}
          </Badge>
        ) : (
          <span className="caption">No data — rule is {state.replace('_', ' ')}</span>
        )
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="performance-grid">
        <MetricCard label="Triggers today" value={perf.triggers_today} tone="blue" />
        <MetricCard label="Triggers (7d)" value={perf.triggers_week} tone="blue" />
        <MetricCard
          label="True-positive rate"
          value={`${perf.true_positive_rate}%`}
          tone="success"
        />
        <MetricCard
          label="False-positive rate"
          value={`${perf.false_positive_rate}%`}
          tone={perf.false_positive_rate > 50 ? 'danger' : 'neutral'}
        />
      </div>
      <div className="mt-3 pt-3 border-t border-divider grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <p className="text-muted">Avg days to default after alert</p>
          <p className="text-ink font-medium tabular">{perf.avg_days_to_default} days</p>
        </div>
        <div>
          <p className="text-muted">Officer "useful" rating</p>
          <p className="text-ink font-medium tabular">{perf.officer_useful_pct}%</p>
        </div>
      </div>
    </Section>
  );
}

// ── Audit trail ───────────────────────────────────────────────────────

function AuditPanel({ rule }: { rule: RuleV2 }) {
  const ICON: Record<string, typeof CheckCircle2> = {
    created: Sparkles,
    edited: Sparkles,
    submitted: Send,
    approved: CheckCircle2,
    rejected: XCircle,
    activated: PlayCircle,
    deprecated: Archive,
  };
  const TONE: Record<string, string> = {
    created: 'text-action',
    edited: 'text-action',
    submitted: 'text-warning',
    approved: 'text-success',
    rejected: 'text-danger',
    activated: 'text-success',
    deprecated: 'text-muted',
  };
  return (
    <Section title="Audit trail" action={<History size={14} className="text-muted" />}>
      <ol className="space-y-2.5" data-testid="audit-trail">
        {[...rule.audit].reverse().map((a, i) => {
          const Icon = ICON[a.kind] ?? AlertTriangle;
          return (
            <li key={i} className="flex items-start gap-2.5">
              <Icon size={14} className={cn('mt-[2px]', TONE[a.kind] ?? 'text-muted')} />
              <div className="flex-1 min-w-0">
                <p className="text-[12px] text-ink">
                  <span className="font-medium capitalize">{a.kind}</span>{' '}
                  <span className="text-muted">→ {a.to_state.replace('_', ' ')}</span>
                </p>
                <p className="text-[10px] text-muted">
                  <span className="font-mono">{a.actor_id}</span> ({a.actor_role}) ·{' '}
                  {new Date(a.ts).toLocaleString()}
                  {a.version && ` · v${a.version}`}
                </p>
                {a.comment && (
                  <p className="text-[11px] text-ink-sub mt-1 italic">"{a.comment}"</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
