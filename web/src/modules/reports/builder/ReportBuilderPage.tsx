// web/src/modules/reports/builder/ReportBuilderPage.tsx
//
// T4.6.5 — Self-service report builder page. Three-pane layout:
//   - Left: saved-reports list (collapsible by visibility tier).
//   - Middle: source picker + filter tree + group_by + metrics.
//   - Right: preview pane showing compiled SQL (admin) + projection +
//     "Run report" CTA.
//
// T4.6.6 (next session) wires the section configurator (chart/table/
// grid) + drill-down + PDF/Excel export buttons. This commit ships the
// foundation + an inline raw-table preview so the page is usable today.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, RefreshCw, Database, FileDown } from 'lucide-react';
import { Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { SavedReportsList } from './SavedReportsList';
import { FilterTreeBuilder } from './FilterTreeBuilder';
import {
  reportsBuilderApi,
  type CreateSavedReportInput,
  type FilterNode,
  type ReportDataSource,
  type ReportDefinition,
  type ReportResult,
  type ReportVisibility,
  type SavedReport,
} from './api';

export function ReportBuilderPage(): JSX.Element {
  const qc = useQueryClient();
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterNode | undefined>(undefined);
  const [limit, setLimit] = useState<number>(100);
  const [reportName, setReportName] = useState<string>('');
  const [reportDescription, setReportDescription] = useState<string>('');
  const [visibility, setVisibility] = useState<ReportVisibility>('private');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Catalog (platform-static — fetch once).
  const catalogQuery = useQuery({
    queryKey: ['report-builder', 'sources'],
    queryFn: () => reportsBuilderApi.listSources(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Saved reports for this tenant.
  const savedQuery = useQuery({
    queryKey: ['report-builder', 'saved'],
    queryFn: () => reportsBuilderApi.listSaved(),
  });

  // Selected source object (resolved from catalog).
  const selectedSource: ReportDataSource | null = useMemo(() => {
    if (!selectedSourceId || !catalogQuery.data) return null;
    return catalogQuery.data.sources.find((s) => s.source_id === selectedSourceId) ?? null;
  }, [selectedSourceId, catalogQuery.data]);

  // Build the current ReportDefinition from local state.
  const definition: ReportDefinition | null = useMemo(() => {
    if (!selectedSourceId) return null;
    return {
      source_id: selectedSourceId,
      filters,
      limit,
    };
  }, [selectedSourceId, filters, limit]);

  // Run mutation.
  const runMutation = useMutation({
    mutationFn: (def: ReportDefinition) => reportsBuilderApi.run(def),
    onError: (err: Error) => {
      setRunError(err.message || 'Failed to run report');
    },
    onSuccess: () => setRunError(null),
  });

  // Save mutation.
  const saveMutation = useMutation({
    mutationFn: (input: CreateSavedReportInput) => reportsBuilderApi.createSaved(input),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['report-builder', 'saved'] });
      setSelectedReportId(saved.report_id);
    },
  });

  // Delete mutation.
  const deleteMutation = useMutation({
    mutationFn: (id: string) => reportsBuilderApi.deleteSaved(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['report-builder', 'saved'] });
    },
  });

  // CSV export.
  const handleExportCsv = async () => {
    if (!definition) return;
    try {
      const blob = await reportsBuilderApi.exportCsv(definition);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `report-${definition.source_id.replace(/\W+/g, '_')}-${date}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setRunError((err as Error).message || 'CSV export failed');
    }
  };

  // Load saved definition into the builder state.
  const handleSelectSaved = (saved: SavedReport) => {
    setSelectedReportId(saved.report_id);
    setSelectedSourceId(saved.definition.source_id);
    setFilters(saved.definition.filters);
    setLimit(saved.definition.limit ?? 100);
    setReportName(saved.name);
    setReportDescription(saved.description);
    setVisibility(saved.visibility);
    setRunError(null);
    runMutation.reset();
  };

  // Reset to blank.
  const handleNewReport = () => {
    setSelectedReportId(null);
    setSelectedSourceId(null);
    setFilters(undefined);
    setLimit(100);
    setReportName('');
    setReportDescription('');
    setVisibility('private');
    setRunError(null);
    runMutation.reset();
  };

  const handleSave = () => {
    if (!definition || !reportName.trim()) return;
    saveMutation.mutate({
      name: reportName.trim(),
      description: reportDescription.trim() || undefined,
      definition,
      visibility,
    });
  };

  const handleDelete = (report: SavedReport) => {
    deleteMutation.mutate(report.report_id);
    if (selectedReportId === report.report_id) handleNewReport();
  };

  const result: ReportResult | undefined = runMutation.data;

  return (
    <div className="space-y-4" data-testid="report-builder-page">
      <PageHeader
        title="Report builder"
        subtitle="Build custom reports against the data warehouse. Saved configurations are role-scoped."
      />

      <div className="grid grid-cols-12 gap-4 min-h-[600px]">
        {/* Left: saved reports */}
        <aside className="col-span-12 md:col-span-3">
          <SavedReportsList
            reports={savedQuery.data?.reports ?? []}
            selected_id={selectedReportId}
            onSelect={handleSelectSaved}
            onDelete={handleDelete}
            onNew={handleNewReport}
            loading={savedQuery.isLoading}
            error={savedQuery.error?.message ?? null}
          />
        </aside>

        {/* Middle: builder */}
        <section className="col-span-12 md:col-span-5 space-y-3">
          <Panel data-testid="source-picker-panel">
            <h2 className="text-sm font-semibold text-ink mb-3 flex items-center gap-1.5">
              <Database className="h-4 w-4" aria-hidden />
              Data source
            </h2>
            {catalogQuery.isLoading && (
              <p className="text-xs text-ink-muted">Loading sources…</p>
            )}
            {catalogQuery.error && (
              <p className="text-xs text-danger">Failed to load sources</p>
            )}
            {catalogQuery.data && (
              <>
                <select
                  value={selectedSourceId ?? ''}
                  onChange={(e) => {
                    setSelectedSourceId(e.target.value || null);
                    setFilters(undefined);
                  }}
                  className="w-full text-sm border border-divider rounded px-2 py-1.5 bg-surface"
                  aria-label="Data source"
                  data-testid="source-select"
                >
                  <option value="">— select source —</option>
                  {catalogQuery.data.sources.map((s) => (
                    <option key={s.source_id} value={s.source_id}>
                      {s.display_name}
                    </option>
                  ))}
                </select>
                {selectedSource && (
                  <p className="text-xs text-ink-muted mt-2" data-testid="source-description">
                    {selectedSource.description}
                  </p>
                )}
              </>
            )}
          </Panel>

          {selectedSource && (
            <Panel data-testid="filter-panel">
              <h2 className="text-sm font-semibold text-ink mb-3">Filters</h2>
              <FilterTreeBuilder
                source={selectedSource}
                node={filters}
                onChange={setFilters}
              />
            </Panel>
          )}

          {selectedSource && (
            <Panel data-testid="save-panel">
              <h2 className="text-sm font-semibold text-ink mb-3">Save report</h2>
              <div className="space-y-2">
                <Input
                  value={reportName}
                  onChange={(e) => setReportName(e.target.value)}
                  placeholder="Report name (required)"
                  data-testid="save-name-input"
                />
                <Input
                  value={reportDescription}
                  onChange={(e) => setReportDescription(e.target.value)}
                  placeholder="Description (optional)"
                  data-testid="save-description-input"
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-xs text-ink-muted">Visibility:</label>
                  <select
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value as ReportVisibility)}
                    className="text-xs border border-divider rounded px-2 py-1 bg-surface"
                    data-testid="visibility-select"
                  >
                    <option value="private">Private (only me)</option>
                    <option value="tenant">Tenant (everyone in tenant)</option>
                    <option value="role">Role (specific roles — requires reports:share)</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-ink-muted">Limit:</label>
                  <Input
                    type="number"
                    value={limit}
                    onChange={(e) => setLimit(Math.max(1, Math.min(10000, parseInt(e.target.value, 10) || 100)))}
                    className="w-24 text-xs"
                    min={1}
                    max={10000}
                    data-testid="limit-input"
                  />
                  <span className="text-xs text-ink-muted">(max 10000)</span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSave}
                  disabled={!reportName.trim() || saveMutation.isPending}
                  data-testid="save-btn"
                >
                  <Save className="h-3 w-3 mr-1" aria-hidden />
                  {selectedReportId ? 'Save as new' : 'Save report'}
                </Button>
                {saveMutation.error && (
                  <p className="text-xs text-danger" role="alert" data-testid="save-error">
                    {(saveMutation.error as Error).message}
                  </p>
                )}
              </div>
            </Panel>
          )}
        </section>

        {/* Right: preview + run */}
        <section className="col-span-12 md:col-span-4 space-y-3">
          <Panel data-testid="run-panel">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink">Run report</h2>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => definition && runMutation.mutate(definition)}
                  disabled={!definition || runMutation.isPending}
                  data-testid="run-btn"
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${runMutation.isPending ? 'animate-spin' : ''}`} aria-hidden />
                  Run
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleExportCsv}
                  disabled={!definition}
                  data-testid="export-csv-btn"
                >
                  <FileDown className="h-3 w-3 mr-1" aria-hidden />
                  CSV
                </Button>
              </div>
            </div>

            {!definition && (
              <p className="text-xs text-ink-muted italic">
                Select a data source to start building.
              </p>
            )}

            {runError && (
              <div
                role="alert"
                className="text-xs text-danger bg-danger/5 p-2 rounded mb-2"
                data-testid="run-error"
              >
                {runError}
              </div>
            )}

            {result && (
              <div className="space-y-2" data-testid="run-result">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-muted">
                    {result.total_rows} of {result.candidate_rows} candidates
                  </span>
                  <span className="text-ink-muted">{result.duration_ms}ms</span>
                </div>
                {result.sql && (
                  <details className="text-xs" data-testid="run-sql-details">
                    <summary className="text-ink-muted cursor-pointer">Compiled SQL (admin)</summary>
                    <pre className="bg-divider/30 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap break-all">
                      {result.sql}
                    </pre>
                  </details>
                )}
                <div className="overflow-x-auto border border-divider rounded">
                  <table className="text-xs w-full" data-testid="result-table">
                    <thead className="bg-divider/40">
                      <tr>
                        {result.projection.map((col) => (
                          <th key={col} className="text-left px-2 py-1 font-medium">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 50).map((row, i) => (
                        <tr key={i} className="border-t border-divider hover:bg-divider/20">
                          {result.projection.map((col) => (
                            <td key={col} className="px-2 py-1 text-ink">
                              {formatCell(row[col])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {result.rows.length > 50 && (
                    <p className="text-xs text-ink-muted p-2 text-center bg-divider/10">
                      Showing first 50 of {result.rows.length} rows — export CSV for full set.
                    </p>
                  )}
                </div>
              </div>
            )}
          </Panel>
        </section>
      </div>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}
