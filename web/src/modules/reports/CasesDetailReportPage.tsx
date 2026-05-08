// Cases Report — row-level detail (BAC §3.1.8).
//
// The companion page to the existing aggregate /reports view. Same SLA
// breach math the dashboard SLA Breach Matrix uses (BAC §3.1.9.1.4),
// surfaced as a sortable, paginated grid with CSV/XLSX/PDF export and
// per-user saved filter presets.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bookmark,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  FileType,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  api,
  type CasesDetailAgeBucket,
  type CasesDetailFilter,
  type CasesDetailFormat,
  type CasesDetailRow,
  type CasesDetailSeverity,
  type CasesDetailSort,
  type CasesSavedFilter,
} from '@/lib/api';

const AGE_BUCKETS: { value: CasesDetailAgeBucket; label: string }[] = [
  { value: 'ALL', label: 'All ages' },
  { value: '0-7d', label: '0-7 days' },
  { value: '8-30d', label: '8-30 days' },
  { value: '31-90d', label: '31-90 days' },
  { value: '90+d', label: '90+ days' },
];

const SEVERITIES: CasesDetailSeverity[] = ['high', 'medium', 'low'];

const STATUSES = [
  'OPEN',
  'ASSIGNED',
  'INVESTIGATING',
  'PENDING_APPROVAL',
  'ESCALATED',
  'CLOSED',
];

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const EXPORT_FORMATS: {
  value: Exclude<CasesDetailFormat, 'json'>;
  label: string;
  icon: typeof FileText;
}[] = [
  { value: 'csv', label: 'CSV', icon: FileText },
  { value: 'xlsx', label: 'Excel (XLSX)', icon: FileSpreadsheet },
  { value: 'pdf', label: 'PDF', icon: FileType },
];

// ── Filter parsing — round-trip the URL ───────────────────────────────

function readFilterFromUrl(sp: URLSearchParams): CasesDetailFilter {
  const f: CasesDetailFilter = {};
  const ab = sp.get('ageBucket');
  if (ab && ab !== 'ALL' && AGE_BUCKETS.some((b) => b.value === ab)) {
    f.ageBucket = ab as Exclude<CasesDetailAgeBucket, 'ALL'>;
  }
  if (sp.get('breached') === 'true') f.breached = true;
  const from = sp.get('from'); if (from) f.from = from;
  const to = sp.get('to'); if (to) f.to = to;
  const branch = sp.get('branch'); if (branch) f.branch = branch;
  const status = sp.get('status'); if (status) f.status = status.split(',');
  const severity = sp.get('severity');
  if (severity) f.severity = severity.split(',') as CasesDetailSeverity[];
  const q = sp.get('q'); if (q) f.q = q;
  const sort = sp.get('sort'); if (sort) f.sort = sort as CasesDetailSort;
  const dir = sp.get('dir'); if (dir === 'asc' || dir === 'desc') f.dir = dir;
  const page = sp.get('page'); if (page) f.page = Number(page);
  const ps = sp.get('page_size'); if (ps) f.page_size = Number(ps);
  return f;
}

function writeFilterToUrl(sp: URLSearchParams, f: CasesDetailFilter): URLSearchParams {
  const out = new URLSearchParams(sp);
  const drop = (k: string) => out.delete(k);
  drop('ageBucket'); drop('breached'); drop('from'); drop('to');
  drop('branch'); drop('status'); drop('severity'); drop('q');
  drop('sort'); drop('dir'); drop('page'); drop('page_size');
  if (f.ageBucket) out.set('ageBucket', f.ageBucket);
  if (f.breached) out.set('breached', 'true');
  if (f.from) out.set('from', f.from);
  if (f.to) out.set('to', f.to);
  if (f.branch) out.set('branch', f.branch);
  if (f.status?.length) out.set('status', f.status.join(','));
  if (f.severity?.length) out.set('severity', f.severity.join(','));
  if (f.q) out.set('q', f.q);
  if (f.sort) out.set('sort', f.sort);
  if (f.dir) out.set('dir', f.dir);
  if (f.page && f.page > 1) out.set('page', String(f.page));
  if (f.page_size) out.set('page_size', String(f.page_size));
  return out;
}

// ── Page ───────────────────────────────────────────────────────────────

export function CasesDetailReportPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const filter = useMemo<CasesDetailFilter>(
    () => ({ page: 1, page_size: 50, ...readFilterFromUrl(searchParams) }),
    [searchParams],
  );

  // Local input state (debounce-applied to URL on blur / Apply)
  const [draftQ, setDraftQ] = useState(filter.q ?? '');
  const [draftBranch, setDraftBranch] = useState(filter.branch ?? '');
  useEffect(() => { setDraftQ(filter.q ?? ''); }, [filter.q]);
  useEffect(() => { setDraftBranch(filter.branch ?? ''); }, [filter.branch]);

  const update = (patch: Partial<CasesDetailFilter>, opts: { resetPage?: boolean } = {}) => {
    const next: CasesDetailFilter = { ...filter, ...patch };
    if (opts.resetPage !== false) next.page = 1;
    setSearchParams(writeFilterToUrl(searchParams, next), { replace: true });
  };

  const reportQ = useQuery({
    queryKey: ['cases-detail', filter],
    queryFn: () => api.casesDetailReport(filter),
  });

  const filtersQ = useQuery({
    queryKey: ['cases-saved-filters'],
    queryFn: () => api.listCasesSavedFilters(),
  });

  // Apply default saved filter on first load if URL has no filter set
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current) return;
    if (!filtersQ.data) return;
    const def = filtersQ.data.find((f) => f.is_default);
    const urlIsEmpty = Array.from(searchParams.keys()).length === 0;
    if (def && urlIsEmpty) {
      setSearchParams(writeFilterToUrl(searchParams, def.filters), { replace: true });
    }
    appliedDefault.current = true;
  }, [filtersQ.data, searchParams, setSearchParams]);

  const items = reportQ.data?.items ?? [];
  const total = reportQ.data?.total ?? 0;
  const page = filter.page ?? 1;
  const pageSize = filter.page_size ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const onSort = (col: CasesDetailSort) => {
    if (filter.sort === col) {
      update({ dir: filter.dir === 'asc' ? 'desc' : 'asc' }, { resetPage: false });
    } else {
      update({ sort: col, dir: 'desc' }, { resetPage: false });
    }
  };

  const breachedCount = items.filter((r) => r.is_breached).length;

  // ── Export ──────────────────────────────────────────────────────────

  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<CasesDetailFormat | null>(null);
  const exportMut = useMutation({
    mutationFn: (format: Exclude<CasesDetailFormat, 'json'>) =>
      api.downloadCasesDetailReport(filter, format),
    onMutate: (format) => {
      setExporting(format);
      setExportError(null);
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 413) {
        setExportError(
          'Result set is too large for this format. Narrow the filter or pick a different format.',
        );
      } else if (status === 403) {
        setExportError('Your role can view but not export this report.');
      } else {
        setExportError((err as Error)?.message ?? 'Export failed.');
      }
    },
    onSettled: () => setExporting(null),
  });

  // ── Saved filters ────────────────────────────────────────────────────

  const [showSavedMenu, setShowSavedMenu] = useState(false);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [savedName, setSavedName] = useState('');
  const [savedShared, setSavedShared] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);

  const createMut = useMutation({
    mutationFn: () =>
      api.createCasesSavedFilter({
        name: savedName.trim(),
        filters: filter,
        is_shared: savedShared,
        is_default: savedDefault,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cases-saved-filters'] });
      setShowSaveForm(false);
      setSavedName('');
      setSavedShared(false);
      setSavedDefault(false);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteCasesSavedFilter(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cases-saved-filters'] });
    },
  });

  const applySavedFilter = (saved: CasesSavedFilter) => {
    setSearchParams(writeFilterToUrl(new URLSearchParams(), saved.filters), { replace: true });
    setShowSavedMenu(false);
  };

  const clearAll = () => {
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cases Report — row-level detail"
        subtitle="Per-case view with the same SLA breach math the dashboard uses · BAC §3.1.8"
      />

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <Panel>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end">
          {/* Search */}
          <div className="md:col-span-3">
            <label htmlFor="cdr-search" className="block text-xs font-medium text-slate-500 mb-1">
              Search (case # or borrower)
            </label>
            <div className="relative">
              <Search size={14} className="absolute left-2 top-2.5 text-slate-400" />
              <input
                id="cdr-search"
                value={draftQ}
                onChange={(e) => setDraftQ(e.target.value)}
                onBlur={() => update({ q: draftQ.trim() || undefined })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') update({ q: draftQ.trim() || undefined });
                }}
                placeholder="C-001, borrower name…"
                className="w-full rounded border border-slate-300 pl-7 pr-2 py-1.5 text-sm"
              />
            </div>
          </div>

          {/* Age bucket */}
          <div className="md:col-span-2">
            <label htmlFor="cdr-age-bucket" className="block text-xs font-medium text-slate-500 mb-1">
              Age bucket
            </label>
            <select
              id="cdr-age-bucket"
              value={filter.ageBucket ?? 'ALL'}
              onChange={(e) =>
                update({
                  ageBucket:
                    e.target.value === 'ALL'
                      ? undefined
                      : (e.target.value as Exclude<CasesDetailAgeBucket, 'ALL'>),
                })
              }
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              {AGE_BUCKETS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>

          {/* From / To */}
          <div className="md:col-span-2">
            <label htmlFor="cdr-from" className="block text-xs font-medium text-slate-500 mb-1">
              Created from
            </label>
            <input
              id="cdr-from"
              type="date"
              value={filter.from?.slice(0, 10) ?? ''}
              onChange={(e) =>
                update({ from: e.target.value ? `${e.target.value}T00:00:00Z` : undefined })
              }
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="cdr-to" className="block text-xs font-medium text-slate-500 mb-1">
              to
            </label>
            <input
              id="cdr-to"
              type="date"
              value={filter.to?.slice(0, 10) ?? ''}
              onChange={(e) =>
                update({ to: e.target.value ? `${e.target.value}T23:59:59Z` : undefined })
              }
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>

          {/* Branch */}
          <div className="md:col-span-2">
            <label htmlFor="cdr-branch" className="block text-xs font-medium text-slate-500 mb-1">
              Branch
            </label>
            <input
              id="cdr-branch"
              value={draftBranch}
              onChange={(e) => setDraftBranch(e.target.value)}
              onBlur={() => update({ branch: draftBranch.trim() || undefined })}
              placeholder="BR-NRB-01"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>

          {/* Breached toggle */}
          <div className="md:col-span-1 flex items-center gap-2 pb-1">
            <input
              id="breached-toggle"
              type="checkbox"
              checked={filter.breached === true}
              onChange={(e) => update({ breached: e.target.checked || undefined })}
              className="h-4 w-4"
            />
            <label htmlFor="breached-toggle" className="text-xs text-slate-700">
              Breached only
            </label>
          </div>
        </div>

        {/* Status + Severity multi-select chips */}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="font-medium text-slate-500">Status:</span>
          {STATUSES.map((s) => {
            const on = filter.status?.includes(s) ?? false;
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  const next = new Set(filter.status ?? []);
                  if (next.has(s)) next.delete(s); else next.add(s);
                  update({ status: next.size ? Array.from(next) : undefined });
                }}
                className={`rounded-full border px-2 py-0.5 ${
                  on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-600'
                }`}
              >
                {s}
              </button>
            );
          })}
          <span className="ml-3 font-medium text-slate-500">Severity:</span>
          {SEVERITIES.map((sv) => {
            const on = filter.severity?.includes(sv) ?? false;
            return (
              <button
                key={sv}
                type="button"
                onClick={() => {
                  const next = new Set(filter.severity ?? []);
                  if (next.has(sv)) next.delete(sv); else next.add(sv);
                  update({
                    severity: next.size ? (Array.from(next) as CasesDetailSeverity[]) : undefined,
                  });
                }}
                className={`rounded-full border px-2 py-0.5 capitalize ${
                  on ? 'border-rose-500 bg-rose-50 text-rose-700' : 'border-slate-300 text-slate-600'
                }`}
              >
                {sv}
              </button>
            );
          })}
        </div>

        {/* Action row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={clearAll}>
            <X size={14} /> Clear filters
          </Button>
          <Button
            variant="ghost"
            onClick={() => void reportQ.refetch()}
            disabled={reportQ.isFetching}
          >
            <RefreshCw size={14} className={reportQ.isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>

          {/* Saved filter dropdown */}
          <div className="relative">
            <Button variant="ghost" onClick={() => setShowSavedMenu((v) => !v)}>
              <Bookmark size={14} /> Saved filters{' '}
              <span className="text-slate-500">({filtersQ.data?.length ?? 0})</span>
              <ChevronDown size={14} />
            </Button>
            {showSavedMenu && (
              <div
                role="menu"
                data-testid="saved-filter-menu"
                className="absolute z-10 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg"
              >
                {(filtersQ.data ?? []).length === 0 ? (
                  <p className="p-3 text-xs text-slate-500">No saved filters yet.</p>
                ) : (
                  <ul className="max-h-64 overflow-auto py-1">
                    {(filtersQ.data ?? []).map((f) => (
                      <li
                        key={f.filter_id}
                        className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50"
                      >
                        <button
                          onClick={() => applySavedFilter(f)}
                          className="flex-1 text-left"
                          data-testid={`apply-filter-${f.filter_id}`}
                        >
                          <span className="font-medium">{f.name}</span>
                          {f.is_default && (
                            <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-700">
                              default
                            </span>
                          )}
                          {f.is_shared && (
                            <span className="ml-1 rounded bg-emerald-100 px-1 text-[10px] text-emerald-700">
                              shared
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => deleteMut.mutate(f.filter_id)}
                          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          aria-label={`Delete saved filter ${f.name}`}
                          title="Delete saved filter"
                        >
                          <Trash2 size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="border-t border-slate-200 p-2">
                  {!showSaveForm ? (
                    <Button
                      variant="ghost"
                      onClick={() => setShowSaveForm(true)}
                      data-testid="open-save-form"
                    >
                      <Save size={14} /> Save current filters as preset
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <input
                        autoFocus
                        value={savedName}
                        onChange={(e) => setSavedName(e.target.value)}
                        placeholder="Preset name (1-80 chars)"
                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={savedShared}
                          onChange={(e) => setSavedShared(e.target.checked)}
                        />{' '}
                        Share with tenant
                      </label>
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={savedDefault}
                          onChange={(e) => setSavedDefault(e.target.checked)}
                        />{' '}
                        Set as default (auto-apply on open)
                      </label>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => createMut.mutate()}
                          disabled={!savedName.trim() || createMut.isPending}
                        >
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setShowSaveForm(false);
                            setSavedName('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Spacer + export */}
          <div className="ml-auto flex items-center gap-2">
            {EXPORT_FORMATS.map(({ value, label, icon: Icon }) => (
              <Button
                key={value}
                variant="ghost"
                onClick={() => exportMut.mutate(value)}
                disabled={exporting !== null}
                data-testid={`export-${value}`}
                title={`Download ${label}`}
              >
                <Icon size={14} />
                <span className="hidden md:inline">{label}</span>
                {exporting === value && (
                  <RefreshCw size={12} className="animate-spin" />
                )}
              </Button>
            ))}
          </div>
        </div>

        {exportError && (
          <div
            role="alert"
            className="mt-3 flex items-center gap-2 rounded-md bg-rose-50 p-2 text-sm text-rose-700"
          >
            <AlertTriangle size={14} />
            {exportError}
            <button
              onClick={() => setExportError(null)}
              className="ml-auto rounded p-1 hover:bg-rose-100"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </Panel>

      {/* ── Result summary ─────────────────────────────────────────── */}
      <Panel>
        <div className="mb-2 flex items-baseline gap-3 text-sm">
          <span data-testid="cdr-row-count">
            {total.toLocaleString()} {total === 1 ? 'case' : 'cases'}
          </span>
          {breachedCount > 0 && (
            <span className="text-rose-700">
              <Download size={12} className="mr-1 inline" />
              {breachedCount} breached on this page
            </span>
          )}
          <span className="ml-auto text-xs text-slate-500">
            Generated{' '}
            {reportQ.data?.generated_at
              ? new Date(reportQ.data.generated_at).toLocaleString()
              : '—'}
          </span>
        </div>

        {/* ── Grid ──────────────────────────────────────────────────── */}
        {reportQ.isLoading ? (
          <p className="py-6 text-center text-sm text-slate-500">Loading…</p>
        ) : reportQ.isError ? (
          <p className="py-6 text-center text-sm text-rose-600" role="alert">
            {(reportQ.error as Error)?.message ?? 'Failed to load report.'}
          </p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No cases match these filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <tr>
                  <SortHeader
                    label="Case #"
                    col="case_number"
                    sort={filter.sort}
                    dir={filter.dir}
                    onSort={onSort}
                  />
                  <th className="py-2 pr-3">Borrower</th>
                  <th className="py-2 pr-3">Product</th>
                  <SortHeader
                    label="Created"
                    col="created_at"
                    sort={filter.sort}
                    dir={filter.dir}
                    onSort={onSort}
                  />
                  <SortHeader
                    label="Age"
                    col="age_days"
                    sort={filter.sort}
                    dir={filter.dir}
                    onSort={onSort}
                    align="right"
                  />
                  <SortHeader
                    label="SLA"
                    col="sla_target_days"
                    sort={filter.sort}
                    dir={filter.dir}
                    onSort={onSort}
                    align="right"
                  />
                  <th className="py-2 pr-3">Breach</th>
                  <SortHeader
                    label="Severity"
                    col="severity"
                    sort={filter.sort}
                    dir={filter.dir}
                    onSort={onSort}
                  />
                  <SortHeader
                    label="Status"
                    col="status"
                    sort={filter.sort}
                    dir={filter.dir}
                    onSort={onSort}
                  />
                  <th className="py-2 pr-3">Assigned</th>
                  <th className="py-2 pr-3">Branch</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <CaseDetailRow key={r.case_id} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Pagination footer ───────────────────────────────────── */}
        {total > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
            <span>
              Page {page} of {totalPages} · rows {(page - 1) * pageSize + 1}-
              {Math.min(page * pageSize, total)} of {total.toLocaleString()}
            </span>
            <Button
              variant="ghost"
              onClick={() => update({ page: Math.max(1, page - 1) }, { resetPage: false })}
              disabled={page <= 1}
            >
              ← Previous
            </Button>
            <Button
              variant="ghost"
              onClick={() => update({ page: Math.min(totalPages, page + 1) }, { resetPage: false })}
              disabled={page >= totalPages}
            >
              Next →
            </Button>
            <span className="ml-auto">Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => update({ page_size: Number(e.target.value) })}
              className="rounded border border-slate-300 px-1 py-0.5"
            >
              {PAGE_SIZE_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function SortHeader({
  label,
  col,
  sort,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  col: CasesDetailSort;
  sort?: CasesDetailSort;
  dir?: 'asc' | 'desc';
  onSort: (c: CasesDetailSort) => void;
  align?: 'left' | 'right';
}) {
  const active = sort === col;
  const arrow = active ? (dir === 'asc' ? '↑' : '↓') : '';
  return (
    <th
      className={`py-2 pr-3 cursor-pointer select-none ${align === 'right' ? 'text-right' : ''}`}
      onClick={() => onSort(col)}
      data-testid={`sort-${col}`}
    >
      {label} <span className="text-slate-400">{arrow}</span>
    </th>
  );
}

function CaseDetailRow({ r }: { r: CasesDetailRow }) {
  const breach = r.is_breached;
  return (
    <tr
      className={`border-b border-slate-100 ${breach ? 'bg-rose-50' : 'hover:bg-slate-50'}`}
      data-testid={`row-${r.case_id}`}
      data-breached={breach || undefined}
    >
      <td className="py-2 pr-3 font-mono text-xs">
        <Link to={`/cms/cases/${r.case_id}`} className="text-blue-600 hover:underline">
          {r.case_number}
        </Link>
      </td>
      <td className="py-2 pr-3">
        {r.borrower.name ?? <span className="text-slate-400">—</span>}
        {r.borrower.id && (
          <div className="text-[10px] text-slate-500 font-mono">{r.borrower.id}</div>
        )}
      </td>
      <td className="py-2 pr-3 text-slate-600">{r.product ?? '—'}</td>
      <td className="py-2 pr-3 text-xs text-slate-500">
        {new Date(r.created_at).toLocaleDateString()}
      </td>
      <td className="py-2 pr-3 text-right tabular">{r.age_days.toFixed(1)}d</td>
      <td className="py-2 pr-3 text-right tabular text-slate-500">
        {r.sla_target_days != null ? `${r.sla_target_days}d` : '—'}
      </td>
      <td className="py-2 pr-3">
        {breach ? (
          <Badge tone="danger">YES</Badge>
        ) : (
          <span className="text-xs text-slate-400">no</span>
        )}
      </td>
      <td className="py-2 pr-3">
        <SeverityBadge severity={r.severity} />
      </td>
      <td className="py-2 pr-3 text-xs">{r.status}</td>
      <td className="py-2 pr-3 text-xs text-slate-600">
        {r.assignee_display_name ?? r.assigned_to ?? '—'}
      </td>
      <td className="py-2 pr-3 text-xs text-slate-500">{r.branch ?? '—'}</td>
    </tr>
  );
}

function SeverityBadge({ severity }: { severity: CasesDetailSeverity }) {
  const tone =
    severity === 'high' ? 'danger' : severity === 'medium' ? 'warning' : 'neutral';
  return <Badge tone={tone as never}>{severity}</Badge>;
}
