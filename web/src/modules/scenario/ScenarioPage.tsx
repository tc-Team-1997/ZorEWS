import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Bookmark,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  FileType,
  GitCompare,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';
import {
  api,
  type IfrsStage,
  type ScenarioResult,
  type SegmentRiskRow,
  type ShockInputs,
  type StageMigration,
} from '@/lib/api';
import { color } from '@/styles/tokens';
import {
  type SavedScenario,
  deleteScenario,
  listSaved,
  refreshSavedFromApi,
  saveScenario,
} from '@/lib/savedScenarios';
import {
  downloadScenarioCsv,
  downloadScenarioPdf,
  downloadScenarioXlsx,
} from '@/lib/scenarioExport';
import { SCENARIO_TEMPLATES, type ScenarioTemplate } from '@/lib/scenarioTemplates';

const DEFAULTS: ShockInputs = { gdp: 0, rate: 0, fx: 0 };

const PRODUCT_LABEL: Record<string, string> = {
  mortgage: 'Mortgage',
  auto: 'Auto',
  personal: 'Personal',
  sme: 'SME',
};

const STAGE_LABEL: Record<IfrsStage, string> = {
  1: 'Stage 1',
  2: 'Stage 2',
  3: 'Stage 3',
};

const STAGE_DESCRIPTION: Record<IfrsStage, string> = {
  1: 'Performing · 12-month ECL',
  2: 'SICR · lifetime ECL',
  3: 'Credit-impaired · lifetime ECL',
};

function fmtKes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} Bn`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)} K`;
  return n.toLocaleString();
}

function fmtPct(n: number, digits = 2): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtSigned(n: number, digits = 2, suffix = ''): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}${suffix}`;
}

function shocksEqual(a: ShockInputs, b: ShockInputs): boolean {
  return a.gdp === b.gdp && a.rate === b.rate && a.fx === b.fx;
}

type ExportFormat = 'csv' | 'pdf' | 'xlsx';

const EXPORT_FORMATS: ReadonlyArray<{
  value: ExportFormat;
  label: string;
  icon: typeof FileText;
}> = [
  { value: 'pdf', label: 'PDF — board / regulator submission', icon: FileType },
  { value: 'xlsx', label: 'Excel — multi-sheet workbook', icon: FileSpreadsheet },
  { value: 'csv', label: 'CSV — flat data', icon: FileText },
];

export function ScenarioPage() {
  const [shock, setShock] = useState<ShockInputs>(DEFAULTS);
  const [saved, setSaved] = useState<SavedScenario[]>(() => listSaved());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  useChatContext({ page: 'scenario' });

  const run = useMutation({
    mutationFn: (s: ShockInputs) => api.runScenario(s),
  });
  const result = run.data;
  const isShocked = shock.gdp !== 0 || shock.rate !== 0 || shock.fx !== 0;

  // On mount, pull the canonical list from the BFF (`app_scenario.saved_scenarios`,
  // T4.18). useState() seeded from localStorage gives instant first-render;
  // this background refresh reconciles with the server so cross-device saves
  // are visible. Falls back to the local cache silently when the API is
  // unreachable (offline dev / BFF down).
  useEffect(() => {
    let cancelled = false;
    void refreshSavedFromApi().then((list) => {
      if (!cancelled) setSaved(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-tab sync — pick up saves made in another browser tab.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'apex.ews.saved_scenarios') setSaved(listSaved());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Close the export dropdown on outside click + Escape. Mirrors the
  // pattern used in ReportsPage so the keyboard escape route is consistent.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExportMenuOpen(false);
        const trigger = exportMenuRef.current?.querySelector<HTMLButtonElement>(
          '[data-testid="scenario-export-trigger"]',
        );
        trigger?.focus();
      }
    };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [exportMenuOpen]);

  const onExport = async (format: ExportFormat) => {
    if (!result) return;
    setExportMenuOpen(false);
    setExporting(format);
    try {
      if (format === 'csv') downloadScenarioCsv(result);
      else if (format === 'pdf') downloadScenarioPdf(result);
      else if (format === 'xlsx') await downloadScenarioXlsx(result);
    } finally {
      setExporting(null);
    }
  };

  const onApplyTemplate = (tpl: ScenarioTemplate) => {
    setShock(tpl.inputs);
    run.reset();
  };

  const onSave = () => {
    setSaveError(null);
    if (!result) return;
    const name = window.prompt('Name this scenario:');
    if (name === null) return;
    try {
      saveScenario(name, shock, result);
      setSaved(listSaved());
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };

  const onLoad = (id: string) => {
    const entry = saved.find((s) => s.id === id);
    if (!entry) return;
    setShock(entry.inputs);
    run.mutate(entry.inputs);
  };

  const onDelete = (id: string) => {
    if (!window.confirm('Delete this saved scenario?')) return;
    deleteScenario(id);
    setSaved(listSaved());
    // Drop the deleted id from any in-progress compare selection.
    setCompareIds((ids) => ids.filter((i) => i !== id));
  };

  const onToggleCompare = (id: string) => {
    setCompareIds((ids) => {
      if (ids.includes(id)) return ids.filter((i) => i !== id);
      // Cap at 2: bumping the oldest pick when a third is selected so the
      // user never has to manually de-select before picking a fresh pair.
      if (ids.length >= 2) return [ids[1], id];
      return [...ids, id];
    });
  };

  const compareScenarios = useMemo(() => {
    return compareIds
      .map((id) => saved.find((s) => s.id === id))
      .filter((s): s is SavedScenario => s !== undefined);
  }, [compareIds, saved]);

  return (
    <div>
      <PageHeader
        title="Scenario Simulation"
        subtitle="Macro stress test · portfolio-wide PD re-run · 240 synthetic accounts"
      />

      <TemplatesRow currentInputs={shock} onApply={onApplyTemplate} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <Panel title="Macro shock inputs" className="lg:col-span-2">
          <div className="space-y-5">
            <Slider
              label="GDP shock"
              unit="%"
              min={-8}
              max={4}
              step={0.5}
              value={shock.gdp}
              onChange={(gdp) => setShock((s) => ({ ...s, gdp }))}
            />
            <Slider
              label="Rate shock"
              unit="bps"
              min={-200}
              max={400}
              step={25}
              value={shock.rate}
              onChange={(rate) => setShock((s) => ({ ...s, rate }))}
            />
            <Slider
              label="FX shock (KES vs USD)"
              unit="%"
              min={-10}
              max={20}
              step={1}
              value={shock.fx}
              onChange={(fx) => setShock((s) => ({ ...s, fx }))}
            />
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setShock(DEFAULTS);
                run.reset();
              }}
            >
              Reset
            </Button>
            <Button
              variant="ghost"
              onClick={onSave}
              disabled={!result}
              data-testid="scenario-save"
            >
              <Save size={14} className="mr-1" /> Save
            </Button>
            <div ref={exportMenuRef} className="relative">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setExportMenuOpen((v) => !v)}
                disabled={!result || exporting !== null}
                data-testid="scenario-export-trigger"
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
              >
                <Download size={14} className="mr-1" />
                {exporting ? `Exporting ${exporting.toUpperCase()}…` : 'Export'}
                <ChevronDown size={12} className="ml-1.5" />
              </Button>
              {exportMenuOpen && (
                <div
                  role="menu"
                  data-testid="scenario-export-menu"
                  className="absolute right-0 mt-1 w-72 z-20 rounded-md border border-divider bg-white shadow-lg ring-1 ring-black/5 py-1"
                >
                  {EXPORT_FORMATS.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      role="menuitem"
                      data-testid={`scenario-export-${value}`}
                      onClick={() => onExport(value)}
                      className="w-full flex items-start gap-2.5 text-left px-3 py-2 text-[13px] text-ink hover:bg-surface-alt transition-colors"
                    >
                      <Icon size={16} className="mt-0.5 shrink-0 text-action" strokeWidth={1.75} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button onClick={() => run.mutate(shock)} disabled={run.isPending}>
              {run.isPending ? 'Running…' : 'Run scenario'}
            </Button>
          </div>
          {run.isError && (
            <p role="alert" className="mt-3 text-[12px] text-danger">
              {(run.error as Error)?.message ?? 'Scenario run failed.'}
            </p>
          )}
          {saveError && (
            <p role="alert" className="mt-3 text-[12px] text-danger" data-testid="scenario-save-error">
              {saveError}
            </p>
          )}
        </Panel>

        <Panel title="Notes">
          <p className="caption">
            Stress engine maps shocks → segment-specific PD multipliers (income-band elasticity for
            GDP, product + tenor weight for rate, FX-exposed flag for currency). Returns the
            baseline-vs-stressed view across the full portfolio in one call.
          </p>
        </Panel>
      </div>

      <SavedScenariosPanel
        saved={saved}
        compareIds={compareIds}
        onLoad={onLoad}
        onDelete={onDelete}
        onToggleCompare={onToggleCompare}
      />

      {compareScenarios.length === 2 && (
        <ComparePanel
          left={compareScenarios[0]}
          right={compareScenarios[1]}
          onClose={() => setCompareIds([])}
        />
      )}

      {result && <ResultsView result={result} isShocked={isShocked} />}
    </div>
  );
}

/**
 * One-click presets above the sliders. Active state highlights the
 * template whose inputs match the current sliders so the user knows
 * what they've applied (and doesn't re-click the same preset by accident).
 */
function TemplatesRow({
  currentInputs,
  onApply,
}: {
  currentInputs: ShockInputs;
  onApply: (tpl: ScenarioTemplate) => void;
}) {
  return (
    <Panel
      title="Templates"
      action={
        <span className="text-2xs text-muted">
          one-click pre-defined macro stress scenarios
        </span>
      }
    >
      <div className="flex flex-wrap gap-2" data-testid="scenario-templates">
        {SCENARIO_TEMPLATES.map((tpl) => {
          const active = shocksEqual(tpl.inputs, currentInputs);
          return (
            <button
              key={tpl.id}
              type="button"
              onClick={() => onApply(tpl)}
              aria-pressed={active}
              title={tpl.description}
              data-testid={`scenario-template-${tpl.id}`}
              className={
                active
                  ? 'rounded-input border border-brand-blue bg-brand-blue text-white px-3 py-1.5 text-[12px] font-medium transition-colors'
                  : 'rounded-input border border-divider bg-surface text-ink-sub hover:border-brand-blue/40 hover:text-brand-blue px-3 py-1.5 text-[12px] font-medium transition-colors'
              }
            >
              {tpl.label}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function SavedScenariosPanel({
  saved,
  compareIds,
  onLoad,
  onDelete,
  onToggleCompare,
}: {
  saved: SavedScenario[];
  compareIds: string[];
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleCompare: (id: string) => void;
}) {
  if (saved.length === 0) return null;
  return (
    <Panel
      title="Saved scenarios"
      className="mt-4"
      action={
        <span className="text-2xs text-muted">
          stored locally · {saved.length} of 20 max · pick 2 to compare
        </span>
      }
    >
      <ul className="divide-y divide-divider" data-testid="saved-scenarios-list">
        {saved.map((s) => {
          const checked = compareIds.includes(s.id);
          return (
            <li key={s.id} className="flex items-center justify-between py-2 gap-3">
              <label className="flex items-center gap-2 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleCompare(s.id)}
                  aria-label={`Select for comparison: ${s.name}`}
                  data-testid={`scenario-compare-toggle-${s.id}`}
                  className="accent-brand-blue"
                />
              </label>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Bookmark size={12} className="text-brand-blue shrink-0" />
                  <p className="text-ink font-medium text-[13px] truncate">{s.name}</p>
                </div>
                <p className="text-2xs text-muted mt-0.5">
                  {new Date(s.saved_at).toLocaleString()} · GDP{' '}
                  {s.inputs.gdp > 0 ? '+' : ''}
                  {s.inputs.gdp}% · Rate {s.inputs.rate > 0 ? '+' : ''}
                  {s.inputs.rate} bps · FX {s.inputs.fx > 0 ? '+' : ''}
                  {s.inputs.fx}%
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  onClick={() => onLoad(s.id)}
                  data-testid={`scenario-load-${s.id}`}
                >
                  Load
                </Button>
                <button
                  type="button"
                  onClick={() => onDelete(s.id)}
                  aria-label={`Delete saved scenario: ${s.name}`}
                  data-testid={`scenario-delete-${s.id}`}
                  className="p-1.5 rounded text-muted hover:text-danger hover:bg-danger-bg/50 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {compareIds.length === 1 && (
        <p className="text-2xs text-muted mt-2">
          1 selected — pick a second saved scenario to compare side-by-side.
        </p>
      )}
    </Panel>
  );
}

/**
 * Side-by-side delta of two saved scenarios. Renders the headline metrics
 * and the deltas between them. We deliberately keep this terse — for the
 * full per-scenario detail the user can Load each one.
 */
function ComparePanel({
  left,
  right,
  onClose,
}: {
  left: SavedScenario;
  right: SavedScenario;
  onClose: () => void;
}) {
  const rows: Array<{
    label: string;
    leftVal: string;
    rightVal: string;
    delta: string;
    deltaTone: 'danger' | 'success' | 'neutral';
  }> = [];

  const pushPctRow = (label: string, l: number, r: number, worseIsHigher = true) => {
    const deltaPct = (r - l) * 100;
    const tone: 'danger' | 'success' | 'neutral' =
      deltaPct === 0
        ? 'neutral'
        : worseIsHigher
          ? deltaPct > 0
            ? 'danger'
            : 'success'
          : deltaPct > 0
            ? 'success'
            : 'danger';
    rows.push({
      label,
      leftVal: fmtPct(l),
      rightVal: fmtPct(r),
      delta: `${fmtSigned(deltaPct, 2)} pp`,
      deltaTone: tone,
    });
  };

  const pushKesRow = (label: string, l: number, r: number) => {
    const delta = r - l;
    rows.push({
      label,
      leftVal: `KES ${fmtKes(l)}`,
      rightVal: `KES ${fmtKes(r)}`,
      delta: `${delta >= 0 ? '+' : ''}KES ${fmtKes(delta)}`,
      deltaTone: delta === 0 ? 'neutral' : delta > 0 ? 'danger' : 'success',
    });
  };

  pushKesRow('Stressed ECL', left.result.stressed_ecl_kes, right.result.stressed_ecl_kes);
  pushKesRow('ECL impact', left.result.ecl_delta_kes, right.result.ecl_delta_kes);
  pushPctRow(
    'Stressed portfolio PD',
    left.result.stressed_portfolio_pd,
    right.result.stressed_portfolio_pd,
  );
  pushPctRow('Stressed NPA share', left.result.stressed_npa_pct, right.result.stressed_npa_pct);
  rows.push({
    label: 'Accounts in Stage 3 (stressed)',
    leftVal: String(left.result.stressed_stages.stage_3),
    rightVal: String(right.result.stressed_stages.stage_3),
    delta: `${
      right.result.stressed_stages.stage_3 - left.result.stressed_stages.stage_3 >= 0 ? '+' : ''
    }${right.result.stressed_stages.stage_3 - left.result.stressed_stages.stage_3}`,
    deltaTone:
      right.result.stressed_stages.stage_3 === left.result.stressed_stages.stage_3
        ? 'neutral'
        : right.result.stressed_stages.stage_3 > left.result.stressed_stages.stage_3
          ? 'danger'
          : 'success',
  });

  return (
    <Panel
      title="Scenario comparison"
      className="mt-4"
      action={
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comparison"
          data-testid="compare-close"
          className="p-1.5 rounded text-muted hover:text-ink-sub hover:bg-divider/60 transition-colors"
        >
          <X size={14} />
        </button>
      }
    >
      <div className="flex items-center gap-2 mb-3 text-2xs text-muted">
        <GitCompare size={12} />
        <span>Side-by-side comparison of two saved scenarios.</span>
      </div>
      <table className="w-full text-[12px]" data-testid="compare-table">
        <thead className="text-muted">
          <tr className="border-b border-divider">
            <th className="text-left py-2 font-medium">Metric</th>
            <th className="text-right py-2 font-medium" data-testid="compare-left-name">
              {left.name}
            </th>
            <th className="text-right py-2 font-medium" data-testid="compare-right-name">
              {right.name}
            </th>
            <th className="text-right py-2 font-medium">Δ (right − left)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-divider/40">
              <td className="py-2 font-medium text-ink">{row.label}</td>
              <td className="text-right tabular text-sub">{row.leftVal}</td>
              <td className="text-right tabular text-sub">{row.rightVal}</td>
              <td
                className={`text-right tabular font-semibold ${
                  row.deltaTone === 'danger'
                    ? 'text-danger'
                    : row.deltaTone === 'success'
                      ? 'text-success'
                      : 'text-sub'
                }`}
              >
                {row.delta}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function ResultsView({ result, isShocked }: { result: ScenarioResult; isShocked: boolean }) {
  const eclTone: 'danger' | 'success' | 'neutral' =
    result.ecl_delta_kes > 0 ? 'danger' : result.ecl_delta_kes < 0 ? 'success' : 'neutral';
  const pdDeltaPp = (result.stressed_portfolio_pd - result.baseline_portfolio_pd) * 100;
  const npaDeltaPp = (result.stressed_npa_pct - result.baseline_npa_pct) * 100;

  return (
    <div className="mt-6 space-y-4" data-testid="scenario-results">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Portfolio PD"
          value={fmtPct(result.stressed_portfolio_pd)}
          sub={`Baseline ${fmtPct(result.baseline_portfolio_pd)} · ${fmtSigned(pdDeltaPp, 2, ' pp')}`}
          tone={pdDeltaPp > 0 ? 'danger' : pdDeltaPp < 0 ? 'success' : 'blue'}
          testId="kpi-portfolio-pd"
        />
        <MetricCard
          label="NPA share (Stage 3)"
          value={fmtPct(result.stressed_npa_pct)}
          sub={`Baseline ${fmtPct(result.baseline_npa_pct)} · ${fmtSigned(npaDeltaPp, 2, ' pp')}`}
          tone={npaDeltaPp > 0 ? 'danger' : npaDeltaPp < 0 ? 'success' : 'neutral'}
          testId="kpi-npa-pct"
        />
        <MetricCard
          label="Stressed ECL"
          value={`KES ${fmtKes(result.stressed_ecl_kes)}`}
          sub={isShocked ? 'After macro shock' : 'Same as baseline'}
          tone={eclTone === 'danger' ? 'danger' : 'neutral'}
        />
        <MetricCard
          label="ECL impact"
          value={`${result.ecl_delta_kes >= 0 ? '+' : ''}KES ${fmtKes(result.ecl_delta_kes)}`}
          sub={
            result.baseline_ecl_kes > 0
              ? `${((result.ecl_delta_kes / result.baseline_ecl_kes) * 100).toFixed(1)}% vs baseline`
              : '—'
          }
          tone={eclTone}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Portfolio size"
          value={result.portfolio_size.toLocaleString()}
          sub={`Total EAD: KES ${fmtKes(result.total_ead_kes)}`}
          tone="blue"
        />
        <MetricCard
          label="Baseline ECL"
          value={`KES ${fmtKes(result.baseline_ecl_kes)}`}
          sub="EAD × PD × LGD"
          tone="neutral"
        />
        <MetricCard
          label="Stage 3 (stressed)"
          value={result.stressed_stages.stage_3.toLocaleString()}
          sub={`Baseline ${result.baseline_stages.stage_3} · ${fmtSigned(
            result.stressed_stages.stage_3 - result.baseline_stages.stage_3,
            0,
          )}`}
          tone={
            result.stressed_stages.stage_3 > result.baseline_stages.stage_3 ? 'danger' : 'neutral'
          }
        />
        <MetricCard
          label="Stage 1 (stressed)"
          value={result.stressed_stages.stage_1.toLocaleString()}
          sub={`Baseline ${result.baseline_stages.stage_1} · ${fmtSigned(
            result.stressed_stages.stage_1 - result.baseline_stages.stage_1,
            0,
          )}`}
          tone={
            result.stressed_stages.stage_1 < result.baseline_stages.stage_1 ? 'warning' : 'success'
          }
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Risk-band migration">
          <div className="h-[260px]" data-testid="band-migration-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={[
                  {
                    band: 'Low PD',
                    baseline: result.baseline_bands.low,
                    stressed: result.stressed_bands.low,
                  },
                  {
                    band: 'Medium PD',
                    baseline: result.baseline_bands.medium,
                    stressed: result.stressed_bands.medium,
                  },
                  {
                    band: 'High PD',
                    baseline: result.baseline_bands.high,
                    stressed: result.stressed_bands.high,
                  },
                ]}
                margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke={color.divider} vertical={false} />
                <XAxis dataKey="band" stroke={color.muted} tick={{ fontSize: 11 }} />
                <YAxis stroke={color.muted} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="baseline" name="Baseline" fill={color.muted} radius={[3, 3, 0, 0]} />
                <Bar dataKey="stressed" name="Stressed" fill={color.danger} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="caption mt-2">
            Bars show account counts in each PD band before vs. after the shock. Migrations from
            low/medium → high indicate the macro stress is biting.
          </p>
        </Panel>

        <Panel title="Segment summary (weighted PD)">
          <table className="w-full text-[12px]" data-testid="segment-heatmap">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="text-left py-2 font-medium">Product</th>
                <th className="text-right py-2 font-medium">Accounts</th>
                <th className="text-right py-2 font-medium">Baseline PD</th>
                <th className="text-right py-2 font-medium">Stressed PD</th>
                <th className="text-right py-2 font-medium">ECL Δ</th>
              </tr>
            </thead>
            <tbody>
              {result.segments.map((s) => (
                <tr key={s.segment} className="border-b border-divider/40">
                  <td className="py-2 font-medium text-ink">
                    {PRODUCT_LABEL[s.segment] ?? s.segment}
                  </td>
                  <td className="text-right tabular text-sub">{s.accounts}</td>
                  <td className="text-right tabular text-sub">{fmtPct(s.baseline_pd)}</td>
                  <td className="text-right tabular text-ink">{fmtPct(s.stressed_pd)}</td>
                  <td
                    className={`text-right tabular ${
                      s.ecl_delta_kes > 0
                        ? 'text-danger'
                        : s.ecl_delta_kes < 0
                          ? 'text-success'
                          : 'text-sub'
                    }`}
                  >
                    {s.ecl_delta_kes >= 0 ? '+' : ''}
                    {fmtKes(s.ecl_delta_kes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <SegmentRiskHeatmap rows={result.segment_risk_matrix} />

      <IfrsStagePanels result={result} />

      <Panel title="Top affected customers">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]" data-testid="top-affected">
            <thead className="text-muted">
              <tr className="border-b border-divider">
                <th className="text-left py-2 font-medium">Customer</th>
                <th className="text-left py-2 font-medium">Product</th>
                <th className="text-right py-2 font-medium">Baseline PD</th>
                <th className="text-right py-2 font-medium">Stressed PD</th>
                <th className="text-right py-2 font-medium">PD Δ (pp)</th>
                <th className="text-right py-2 font-medium">EAD</th>
                <th className="text-right py-2 font-medium">ECL Δ</th>
              </tr>
            </thead>
            <tbody>
              {result.top_affected.map((c) => (
                <tr
                  key={c.customer_id}
                  className="border-b border-divider/40 hover:bg-brand-skyLight/50"
                  data-testid={`top-affected-row-${c.customer_id}`}
                >
                  <td className="py-2">
                    <Link
                      to={`/customers/${c.customer_id}`}
                      className="block hover:text-brand-blue focus:outline-none focus:ring-2 focus:ring-brand-blue/40 rounded"
                      data-testid={`top-affected-link-${c.customer_id}`}
                    >
                      <div className="font-medium text-ink">{c.name}</div>
                      <div className="text-[10px] text-muted">{c.customer_id}</div>
                    </Link>
                  </td>
                  <td className="text-sub capitalize">{c.product}</td>
                  <td className="text-right tabular text-sub">{fmtPct(c.baseline_pd)}</td>
                  <td className="text-right tabular text-ink">{fmtPct(c.stressed_pd)}</td>
                  <td
                    className={`text-right tabular ${
                      c.pd_delta_pp > 0 ? 'text-danger' : 'text-success'
                    }`}
                  >
                    {c.pd_delta_pp >= 0 ? '+' : ''}
                    {c.pd_delta_pp.toFixed(2)}
                  </td>
                  <td className="text-right tabular text-sub">KES {fmtKes(c.ead_kes)}</td>
                  <td
                    className={`text-right tabular ${
                      c.ecl_delta_kes > 0 ? 'text-danger' : 'text-success'
                    }`}
                  >
                    {c.ecl_delta_kes >= 0 ? '+' : ''}
                    {fmtKes(c.ecl_delta_kes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="caption mt-2">
          Click a customer to open their full risk profile (SHAP reasons, balance trend, exposure).
        </p>
      </Panel>

    </div>
  );
}

/**
 * 2D heatmap: rows = product segment, cols = Low / Medium / High PD bands.
 * Each cell shows two numbers (baseline → stressed) and is colored by the
 * stressed count's intensity vs. the matrix-wide max. The color also
 * encodes direction — red gradient if the stressed count is ≥ baseline
 * (no improvement on this dimension), green if stressed is lower.
 */
function SegmentRiskHeatmap({ rows }: { rows: SegmentRiskRow[] }) {
  const bandKeys: ReadonlyArray<keyof SegmentRiskRow['baseline']> = ['low', 'medium', 'high'];
  const maxCell = Math.max(
    1,
    ...rows.flatMap((r) => bandKeys.map((b) => r.stressed[b])),
  );

  const cellColor = (baseline: number, stressed: number): string => {
    if (stressed === 0 && baseline === 0) return 'transparent';
    const intensity = Math.min(1, stressed / maxCell);
    if (stressed > baseline) {
      // Deteriorated — red gradient.
      return `rgba(220, 38, 38, ${0.10 + intensity * 0.45})`;
    }
    if (stressed < baseline) {
      // Improved — green gradient.
      return `rgba(22, 163, 74, ${0.10 + intensity * 0.45})`;
    }
    // Unchanged — soft neutral.
    return `rgba(100, 116, 139, ${0.05 + intensity * 0.20})`;
  };

  return (
    <Panel title="Segments × Risk Level heatmap">
      <table
        className="w-full text-[12px] border-separate border-spacing-1"
        data-testid="segment-risk-heatmap"
      >
        <thead className="text-muted">
          <tr>
            <th className="text-left py-1 font-medium">Segment</th>
            <th className="text-center py-1 font-medium">Low PD</th>
            <th className="text-center py-1 font-medium">Medium PD</th>
            <th className="text-center py-1 font-medium">High PD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.segment}>
              <td className="py-1 font-medium text-ink capitalize">
                {PRODUCT_LABEL[row.segment] ?? row.segment}
              </td>
              {bandKeys.map((band) => {
                const baseline = row.baseline[band];
                const stressed = row.stressed[band];
                return (
                  <td
                    key={band}
                    className="rounded text-center py-2 px-2 align-middle"
                    style={{ background: cellColor(baseline, stressed) }}
                    data-testid={`heatmap-cell-${row.segment}-${band}`}
                  >
                    <div className="text-ink font-semibold tabular">{stressed}</div>
                    <div className="text-2xs text-muted tabular">
                      base {baseline}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="caption mt-3">
        Each cell shows the stressed account count above the baseline count. Red = the cell
        deteriorated under the shock; green = improved; neutral = unchanged.
      </p>
    </Panel>
  );
}

/**
 * Two side-by-side panels:
 *   - "IFRS 9 stage distribution" — grouped bars, baseline vs stressed,
 *     using stage nomenclature (Stage 1 / 2 / 3) instead of PD bands.
 *   - "Stage migration matrix" — 3x3 table showing per-account
 *     transitions, color-coded by direction.
 */
function IfrsStagePanels({ result }: { result: ScenarioResult }) {
  const stageData = ([1, 2, 3] as const).map((s) => ({
    stage: STAGE_LABEL[s],
    description: STAGE_DESCRIPTION[s],
    baseline: result.baseline_stages[`stage_${s}` as const],
    stressed: result.stressed_stages[`stage_${s}` as const],
  }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Panel title="IFRS 9 stage distribution">
        <div className="h-[260px]" data-testid="ifrs-stage-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stageData} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={color.divider} vertical={false} />
              <XAxis dataKey="stage" stroke={color.muted} tick={{ fontSize: 11 }} />
              <YAxis stroke={color.muted} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(v: number) => `${v} accounts`}
                labelFormatter={(label, payload) => {
                  const row = payload?.[0]?.payload as { description?: string } | undefined;
                  return row?.description ? `${label} — ${row.description}` : String(label);
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="baseline" name="Baseline" fill={color.muted} radius={[3, 3, 0, 0]} />
              <Bar dataKey="stressed" name="Stressed" fill={color.danger} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="caption mt-2">
          Stage 1 = performing, 12-month ECL · Stage 2 = significant credit deterioration, lifetime
          ECL · Stage 3 = credit-impaired. Movement Stage 1 → 2 is the regulatory trigger that
          forces the bank to recognise lifetime ECL on the loan.
        </p>
      </Panel>

      <Panel title="Stage migration matrix">
        <StageMigrationTable migration={result.stage_migration} />
        <p className="caption mt-3">
          Rows = baseline stage, columns = stressed stage. The diagonal is "no migration"; cells
          above the diagonal are deteriorations (more ECL); below are improvements.
        </p>
      </Panel>
    </div>
  );
}

function StageMigrationTable({ migration }: { migration: StageMigration }) {
  const rows: Array<{ from: IfrsStage; cells: Array<{ to: IfrsStage; count: number }> }> = (
    [1, 2, 3] as const
  ).map((from) => ({
    from,
    cells: ([1, 2, 3] as const).map((to) => ({
      to,
      count: migration[`s${from}` as 's1' | 's2' | 's3'][`s${to}` as 's1' | 's2' | 's3'],
    })),
  }));

  const offDiagMax = Math.max(
    1,
    ...rows.flatMap((r) => r.cells.filter((c) => c.to !== r.from).map((c) => c.count)),
  );

  return (
    <table className="w-full text-[12px]" data-testid="stage-migration-matrix">
      <thead className="text-muted">
        <tr className="border-b border-divider">
          <th className="text-left py-2 font-medium">From \ To</th>
          {([1, 2, 3] as const).map((to) => (
            <th key={to} className="text-right py-2 font-medium">
              Stage {to}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ from, cells }) => (
          <tr key={from} className="border-b border-divider/40">
            <td className="py-2 font-medium text-ink">Stage {from}</td>
            {cells.map(({ to, count }) => {
              const isDiagonal = from === to;
              const isWorse = to > from;
              const isBetter = to < from;
              const intensity = count > 0 ? Math.min(1, count / offDiagMax) : 0;
              const bg = isDiagonal
                ? 'transparent'
                : isWorse
                  ? `rgba(220, 38, 38, ${0.08 + intensity * 0.32})`
                  : `rgba(22, 163, 74, ${0.08 + intensity * 0.32})`;
              const textCls = isDiagonal
                ? 'text-ink-sub'
                : isWorse
                  ? 'text-danger font-semibold'
                  : isBetter
                    ? 'text-success font-semibold'
                    : 'text-ink-sub';
              return (
                <td
                  key={to}
                  className={`text-right tabular py-2 px-2 ${textCls}`}
                  style={{ background: bg }}
                  data-testid={`stage-cell-${from}-${to}`}
                >
                  {count}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Slider({
  label,
  unit,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-ink-sub">{label}</span>
        <span className="text-xs text-ink tabular">
          {value > 0 ? `+${value}` : value} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-blue"
      />
    </label>
  );
}
