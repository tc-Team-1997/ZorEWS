// web/src/modules/reports/builder/ReportSections.tsx
//
// T4.6.6 — Section configurator + renderers (chart/table/kpi).
//
// Section catalog from T4.6.2: chart/table/grid/kpi. Each section has a
// type-specific config bag the BFF doesn't interpret — the SPA owns
// the schema.
//
// Sections take the ReportResult + their config and render against the
// already-computed rows + aggregates. No additional /run round-trip
// needed.

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Plus, Trash2, BarChart3, Table as TableIcon, Activity } from 'lucide-react';
import { Button, MetricCard, Panel } from '@/components/ui';
import { color } from '@/styles/tokens';
import type {
  ReportDataSource,
  ReportResult,
  ReportSection,
  ReportSectionType,
} from './api';

// ─── Section config types ─────────────────────────────────────────────

export interface KpiConfig {
  title?: string;
  /** Column to read from the FIRST row OR aggregate key. */
  field: string;
  /** If true, read from result.aggregates instead of result.rows[0]. */
  from_aggregate?: boolean;
  format?: 'number' | 'currency' | 'percent';
}

export interface TableConfig {
  title?: string;
  /** Optional projection subset; falls back to result.projection. */
  columns?: string[];
  /** Page size. Defaults 25. */
  page_size?: number;
  /** Optional drill-down field. When set + the column is clickable. */
  drill_field?: string;
}

export interface ChartConfig {
  title?: string;
  type: 'bar' | 'line' | 'pie';
  /** X-axis (bar/line) or label (pie) field. */
  x_field: string;
  /** Y-axis numeric field(s). */
  y_fields: string[];
}

export interface GridConfig {
  title?: string;
  columns?: string[];
}

// ─── Section configurator UI ──────────────────────────────────────────

const SECTION_ICONS: Record<ReportSectionType, typeof BarChart3> = {
  chart: BarChart3,
  table: TableIcon,
  grid: TableIcon,
  kpi: Activity,
};

interface ConfiguratorProps {
  source: ReportDataSource;
  result: ReportResult | null;
  sections: ReportSection[];
  onChange: (sections: ReportSection[]) => void;
}

export function SectionConfigurator({
  source,
  result,
  sections,
  onChange,
}: ConfiguratorProps): JSX.Element {
  const addSection = (type: ReportSectionType) => {
    const section_id = `sec-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const defaultConfig = defaultConfigFor(type, source, result);
    onChange([...sections, { section_id, type, config: defaultConfig }]);
  };

  const updateSection = (idx: number, patch: Partial<ReportSection>) => {
    const next = [...sections];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const removeSection = (idx: number) => {
    const next = [...sections];
    next.splice(idx, 1);
    onChange(next);
  };

  const moveSection = (idx: number, direction: -1 | 1) => {
    const target = idx + direction;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };

  return (
    <Panel data-testid="section-configurator">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-ink">Sections</h2>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => addSection('kpi')}
            data-testid="add-kpi-section"
          >
            <Plus className="h-3 w-3 mr-1" aria-hidden />
            KPI
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => addSection('table')}
            data-testid="add-table-section"
          >
            <Plus className="h-3 w-3 mr-1" aria-hidden />
            Table
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => addSection('chart')}
            data-testid="add-chart-section"
          >
            <Plus className="h-3 w-3 mr-1" aria-hidden />
            Chart
          </Button>
        </div>
      </div>

      {sections.length === 0 && (
        <p className="text-xs text-ink-muted italic" data-testid="sections-empty">
          No sections — add KPI / Table / Chart to compose the report layout.
        </p>
      )}

      <ul className="space-y-2">
        {sections.map((s, i) => {
          const Icon = SECTION_ICONS[s.type];
          return (
            <li
              key={s.section_id}
              className="flex items-center justify-between border border-divider rounded px-2 py-1.5"
              data-testid={`section-config-${i}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Icon className="h-3 w-3 text-ink-muted flex-shrink-0" aria-hidden />
                <span className="text-xs font-medium text-ink truncate">
                  {(s.config as { title?: string }).title ?? `${s.type} section`}
                </span>
                <span className="text-[10px] text-ink-muted bg-divider px-1 rounded">{s.type}</span>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => moveSection(i, -1)}
                  disabled={i === 0}
                  className="text-xs text-ink-muted hover:text-ink disabled:opacity-30"
                  aria-label="Move up"
                  data-testid={`section-up-${i}`}
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => moveSection(i, 1)}
                  disabled={i === sections.length - 1}
                  className="text-xs text-ink-muted hover:text-ink disabled:opacity-30"
                  aria-label="Move down"
                  data-testid={`section-down-${i}`}
                >
                  ▼
                </button>
                <SectionEditor
                  section={s}
                  source={source}
                  result={result}
                  onChange={(patch) => updateSection(i, patch)}
                />
                <button
                  type="button"
                  onClick={() => removeSection(i)}
                  className="text-danger hover:text-danger/70"
                  aria-label="Remove section"
                  data-testid={`section-remove-${i}`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ─── Per-section config editor (inline expand) ────────────────────────

function SectionEditor({
  section,
  source,
  result,
  onChange,
}: {
  section: ReportSection;
  source: ReportDataSource;
  result: ReportResult | null;
  onChange: (patch: Partial<ReportSection>) => void;
}): JSX.Element {
  // We use a <details> popover-style for per-section config so the
  // outer list stays compact. Editing the config bag with type-aware
  // controls based on section type.
  return (
    <details className="text-xs" data-testid={`section-editor-${section.section_id}`}>
      <summary className="cursor-pointer text-ink-muted px-1 hover:text-ink">
        ⚙
      </summary>
      <div className="absolute right-2 mt-1 z-10 bg-surface border border-divider rounded shadow-md p-3 min-w-[280px] space-y-2">
        <input
          type="text"
          value={(section.config as { title?: string }).title ?? ''}
          onChange={(e) =>
            onChange({ config: { ...section.config, title: e.target.value } })
          }
          placeholder="Section title (optional)"
          className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
          data-testid={`section-title-input`}
        />
        {section.type === 'kpi' && (
          <KpiConfigEditor
            config={section.config as unknown as KpiConfig}
            source={source}
            result={result}
            onChange={(patch) => onChange({ config: { ...section.config, ...patch } })}
          />
        )}
        {section.type === 'chart' && (
          <ChartConfigEditor
            config={section.config as unknown as ChartConfig}
            source={source}
            result={result}
            onChange={(patch) => onChange({ config: { ...section.config, ...patch } })}
          />
        )}
        {(section.type === 'table' || section.type === 'grid') && (
          <TableConfigEditor
            config={section.config as unknown as TableConfig}
            source={source}
            result={result}
            onChange={(patch) => onChange({ config: { ...section.config, ...patch } })}
          />
        )}
      </div>
    </details>
  );
}

function KpiConfigEditor({
  config,
  result,
  source,
  onChange,
}: {
  config: KpiConfig;
  source: ReportDataSource;
  result: ReportResult | null;
  onChange: (patch: Partial<KpiConfig>) => void;
}): JSX.Element {
  const aggKeys = result ? Object.keys(result.aggregates) : [];
  const numericFields = source.fields.filter(
    (f) => f.type === 'integer' || f.type === 'number',
  );
  return (
    <>
      <label className="block text-[11px] text-ink-muted">From</label>
      <select
        value={config.from_aggregate ? 'aggregate' : 'first_row'}
        onChange={(e) => onChange({ from_aggregate: e.target.value === 'aggregate' })}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
        data-testid="kpi-from-select"
      >
        <option value="first_row">First row value</option>
        <option value="aggregate">Grand-total (aggregate)</option>
      </select>
      <label className="block text-[11px] text-ink-muted">Field</label>
      <select
        value={config.field ?? ''}
        onChange={(e) => onChange({ field: e.target.value })}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
        data-testid="kpi-field-select"
      >
        <option value="">— select —</option>
        {config.from_aggregate
          ? aggKeys.map((k) => <option key={k} value={k}>{k}</option>)
          : numericFields.map((f) => (
              <option key={f.name} value={f.name}>{f.display_name}</option>
            ))}
      </select>
      <label className="block text-[11px] text-ink-muted">Format</label>
      <select
        value={config.format ?? 'number'}
        onChange={(e) => onChange({ format: e.target.value as KpiConfig['format'] })}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
        data-testid="kpi-format-select"
      >
        <option value="number">Number</option>
        <option value="currency">Currency (KES)</option>
        <option value="percent">Percent</option>
      </select>
    </>
  );
}

function ChartConfigEditor({
  config,
  source,
  result,
  onChange,
}: {
  config: ChartConfig;
  source: ReportDataSource;
  result: ReportResult | null;
  onChange: (patch: Partial<ChartConfig>) => void;
}): JSX.Element {
  const projection = result?.projection ?? source.fields.map((f) => f.name);
  const numericFields = source.fields
    .filter((f) => f.type === 'integer' || f.type === 'number')
    .map((f) => f.name);
  // Augment with aggregate metric aliases that may appear in the result.
  const numericChoices = Array.from(
    new Set([
      ...numericFields,
      ...(result ? Object.keys(result.aggregates) : []),
    ]),
  );
  return (
    <>
      <label className="block text-[11px] text-ink-muted">Chart type</label>
      <select
        value={config.type ?? 'bar'}
        onChange={(e) => onChange({ type: e.target.value as ChartConfig['type'] })}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
        data-testid="chart-type-select"
      >
        <option value="bar">Bar</option>
        <option value="line">Line</option>
        <option value="pie">Pie</option>
      </select>
      <label className="block text-[11px] text-ink-muted">X-axis / Label field</label>
      <select
        value={config.x_field ?? ''}
        onChange={(e) => onChange({ x_field: e.target.value })}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
        data-testid="chart-x-select"
      >
        <option value="">— select —</option>
        {projection.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <label className="block text-[11px] text-ink-muted">Y-axis field</label>
      <select
        value={config.y_fields?.[0] ?? ''}
        onChange={(e) => onChange({ y_fields: [e.target.value] })}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
        data-testid="chart-y-select"
      >
        <option value="">— select —</option>
        {numericChoices.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
    </>
  );
}

function TableConfigEditor({
  config,
  source,
  onChange,
}: {
  config: TableConfig;
  source: ReportDataSource;
  result: ReportResult | null;
  onChange: (patch: Partial<TableConfig>) => void;
}): JSX.Element {
  const drillFields = source.drill_targets.map((d) => d.via_field);
  return (
    <>
      <label className="block text-[11px] text-ink-muted">Rows per page</label>
      <input
        type="number"
        value={config.page_size ?? 25}
        min={5}
        max={200}
        onChange={(e) => onChange({ page_size: parseInt(e.target.value, 10) || 25 })}
        className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
        data-testid="table-page-size-input"
      />
      {drillFields.length > 0 && (
        <>
          <label className="block text-[11px] text-ink-muted">Drill-down via</label>
          <select
            value={config.drill_field ?? ''}
            onChange={(e) => onChange({ drill_field: e.target.value || undefined })}
            className="text-xs border border-divider rounded px-2 py-1 bg-surface w-full"
            data-testid="table-drill-select"
          >
            <option value="">— none —</option>
            {drillFields.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </>
      )}
    </>
  );
}

// ─── Renderers ────────────────────────────────────────────────────────

interface RendererProps {
  section: ReportSection;
  source: ReportDataSource;
  result: ReportResult;
  onDrillDown?: (target_source_id: string, via_field: string, value: unknown) => void;
}

export function SectionRenderer({
  section,
  source,
  result,
  onDrillDown,
}: RendererProps): JSX.Element {
  if (section.type === 'kpi') {
    return <KpiSection section={section} result={result} />;
  }
  if (section.type === 'chart') {
    return <ChartSection section={section} result={result} />;
  }
  // table + grid render the same way (grid = no page limit; table = paginated)
  return (
    <TableSection
      section={section}
      source={source}
      result={result}
      onDrillDown={onDrillDown}
    />
  );
}

function KpiSection({
  section,
  result,
}: {
  section: ReportSection;
  result: ReportResult;
}): JSX.Element {
  const config = section.config as unknown as KpiConfig;
  const raw = config.from_aggregate
    ? result.aggregates[config.field]
    : result.rows[0]?.[config.field];

  const label = config.title || `${config.field}${config.from_aggregate ? ' (total)' : ''}`;
  const value = formatKpi(raw, config.format ?? 'number');
  return (
    <div data-testid={`kpi-section-${section.section_id}`}>
      <MetricCard label={label} value={value} />
    </div>
  );
}

function formatKpi(v: unknown, format: 'number' | 'currency' | 'percent'): string {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) {
    return '—';
  }
  if (typeof v !== 'number') return String(v);
  if (format === 'currency') return `KES ${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  if (format === 'percent') return `${(v * 100).toFixed(1)}%`;
  return v.toLocaleString();
}

function ChartSection({
  section,
  result,
}: {
  section: ReportSection;
  result: ReportResult;
}): JSX.Element {
  const config = section.config as unknown as ChartConfig;
  const data = useMemo(
    () =>
      result.rows.map((r, i) => ({
        ...r,
        __key__: i,
      })),
    [result.rows],
  );

  const colors = [color.blue, color.success, color.warning, color.danger, color.sky];

  return (
    <Panel data-testid={`chart-section-${section.section_id}`}>
      {config.title && (
        <h3 className="text-sm font-semibold text-ink mb-3">{config.title}</h3>
      )}
      <div className="w-full" style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          {config.type === 'bar' ? (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke={color.divider} />
              <XAxis dataKey={config.x_field} fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {(config.y_fields ?? []).map((y, i) => (
                <Bar key={y} dataKey={y} fill={colors[i % colors.length]} />
              ))}
            </BarChart>
          ) : config.type === 'line' ? (
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke={color.divider} />
              <XAxis dataKey={config.x_field} fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {(config.y_fields ?? []).map((y, i) => (
                <Line
                  key={y}
                  type="monotone"
                  dataKey={y}
                  stroke={colors[i % colors.length]}
                />
              ))}
            </LineChart>
          ) : (
            <PieChart>
              <Pie
                data={data}
                dataKey={config.y_fields?.[0]}
                nameKey={config.x_field}
                outerRadius={100}
                label
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function TableSection({
  section,
  source,
  result,
  onDrillDown,
}: {
  section: ReportSection;
  source: ReportDataSource;
  result: ReportResult;
  onDrillDown?: (target_source_id: string, via_field: string, value: unknown) => void;
}): JSX.Element {
  const config = section.config as TableConfig;
  const isGrid = section.type === 'grid';
  const pageSize = isGrid ? Number.MAX_SAFE_INTEGER : config.page_size ?? 25;
  const columns = config.columns?.length ? config.columns : result.projection;

  const drill = useMemo(() => {
    if (!config.drill_field) return null;
    const target = source.drill_targets.find((d) => d.via_field === config.drill_field);
    return target ?? null;
  }, [config.drill_field, source.drill_targets]);

  const rows = result.rows.slice(0, pageSize);

  return (
    <Panel data-testid={`table-section-${section.section_id}`}>
      {config.title && (
        <h3 className="text-sm font-semibold text-ink mb-3">{config.title}</h3>
      )}
      <div className="overflow-x-auto border border-divider rounded">
        <table className="text-xs w-full">
          <thead className="bg-divider/40">
            <tr>
              {columns.map((col) => (
                <th key={col} className="text-left px-2 py-1 font-medium">
                  {col}
                </th>
              ))}
              {drill && <th className="text-left px-2 py-1 font-medium">→</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-divider hover:bg-divider/20">
                {columns.map((col) => (
                  <td key={col} className="px-2 py-1 text-ink">
                    {formatRowCell(row[col])}
                  </td>
                ))}
                {drill && (
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() =>
                        onDrillDown?.(drill.to_source_id, drill.via_field, row[drill.via_field])
                      }
                      className="text-action hover:text-action-hover text-[11px] font-medium"
                      data-testid={`drill-${section.section_id}-${i}`}
                    >
                      {drill.display_name}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!isGrid && result.rows.length > pageSize && (
          <p className="text-xs text-ink-muted p-2 text-center bg-divider/10">
            Showing first {pageSize} of {result.rows.length} rows.
          </p>
        )}
      </div>
    </Panel>
  );
}

function formatRowCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}

// ─── Default config helpers ───────────────────────────────────────────

function defaultConfigFor(
  type: ReportSectionType,
  source: ReportDataSource,
  result: ReportResult | null,
): Record<string, unknown> {
  const numericFields = source.fields
    .filter((f) => f.type === 'integer' || f.type === 'number')
    .map((f) => f.name);
  const enumFields = source.fields
    .filter((f) => f.type === 'enum')
    .map((f) => f.name);
  const aggKeys = result ? Object.keys(result.aggregates) : [];

  switch (type) {
    case 'kpi':
      return {
        from_aggregate: aggKeys.length > 0,
        field: aggKeys[0] ?? numericFields[0] ?? '',
        format: 'number',
      } as KpiConfig as never;
    case 'chart':
      return {
        type: 'bar',
        x_field: enumFields[0] ?? source.fields[0]?.name ?? '',
        y_fields: numericFields.slice(0, 1),
      } as ChartConfig as never;
    case 'table':
      return {
        page_size: 25,
        drill_field: source.drill_targets[0]?.via_field,
      } as TableConfig as never;
    case 'grid':
      return {} as GridConfig as never;
  }
}
