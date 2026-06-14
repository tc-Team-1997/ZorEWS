// web/src/modules/customers/BorrowerWatchPage.tsx
//
// Module 2.1 — Borrower Watch.
//
// The single most important credit-officer screen. Per spec:
//   - Stressed Borrowers table ranked by AI EWS score (0-100), server-side sort
//   - Filters: sector / segment / region / severity / watchlist-only / EWS range
//   - 360° Borrower modal — tabbed deep-dive (Overview / Ratios / Account /
//     Alerts / SMA / Cases / Notes)
//   - Watchlist add/remove with custom tag
//   - Multi-select cohort actions: add cohort to watchlist, bulk export CSV,
//     build CMA pack
//   - Sector analysis from borrower, Compare to Sector, Issue Notice
//
// Wired to:
//   GET  /v1/customers?mode=&sector=&...&sort=ews_score&order=desc
//   GET  /v1/customers/:id/360            (M11.6 — already shipped)
//   GET  /v1/risk-profile/:customer_id    (T3.7 — already shipped)
//   GET/POST/DELETE /v1/watchlist         (M4.7 — already shipped)
//   POST /v1/banking/cohort/cma-pack      (Module 2.1 — new)
//   POST /v1/notices/issue                (M15.4 — already shipped)

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, BookOpen, CheckCircle2, Download, ExternalLink, Eye, FileText,
  Plus, ShieldCheck, Star, TrendingUp, X,
} from 'lucide-react';
import {
  api,
  type BorrowerListReportShape,
  type BorrowerRegion,
  type BorrowerSector,
  type BorrowerSegment,
  type BorrowerSeverity,
  type BorrowerSortKey,
  type BorrowerWatchRowShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildBorrowerWatchReportData } from './borrowerWatchReportAdapter';

const SECTORS: BorrowerSector[] = ['manufacturing', 'services', 'retail', 'agriculture', 'real_estate', 'msme', 'corporate', 'consumer'];
const SEGMENTS: BorrowerSegment[] = ['retail', 'sme', 'corporate', 'priority_sector'];
const REGIONS: BorrowerRegion[] = ['north', 'south', 'east', 'west', 'central', 'northeast'];
const SEVERITIES: BorrowerSeverity[] = ['S1', 'S2', 'S3'];
const SEVERITY_TONE: Record<BorrowerSeverity, BadgeTone> = { S1: 'danger', S2: 'warning', S3: 'neutral' };

function fmtINR(n: number): string {
  // Indian-grouping format with crore/lakh suffix.
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(1)} Cr`;
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(1)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { hour12: false });
}

function ewsBand(score: number): BadgeTone {
  if (score >= 75) return 'danger';
  if (score >= 50) return 'warning';
  return 'success';
}

function exportRowsCsv(rows: BorrowerWatchRowShape[], name: string): void {
  if (rows.length === 0) return;
  const headers: (keyof BorrowerWatchRowShape)[] = [
    'borrower_id', 'name', 'sector', 'segment', 'region', 'exposure_inr',
    'ews_score', 'severity', 'top_signal', 'last_alert_at', 'watchlist_tag', 'dpd',
  ];
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => {
      const v = r[h];
      const s = v === null || v === undefined ? '' : typeof v === 'string' && /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v);
      return s;
    }).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function BorrowerWatchPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [mode, setMode] = useState<'stressed' | 'all'>('stressed');
  const [sector, setSector] = useState<BorrowerSector | ''>('');
  const [segment, setSegment] = useState<BorrowerSegment | ''>('');
  const [region, setRegion] = useState<BorrowerRegion | ''>('');
  const [severity, setSeverity] = useState<BorrowerSeverity | ''>('');
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [minEws, setMinEws] = useState<string>('');
  const [maxEws, setMaxEws] = useState<string>('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<BorrowerSortKey>('ews_score');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openBorrower, setOpenBorrower] = useState<BorrowerWatchRowShape | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'ratios' | 'signals' | 'alerts' | 'sma' | 'cases' | 'notes'>('overview');
  const [cmaResult, setCmaResult] = useState<{ pack_id: string; cohort_size: number; mean_ews_score: number; total_exposure_inr: number } | null>(null);

  const listQ = useQuery({
    queryKey: ['borrower-list', mode, sector, segment, region, severity, watchlistOnly, minEws, maxEws, search, sortKey, sortOrder],
    queryFn: () => api.borrowerWatchList({
      mode,
      sector: sector || undefined,
      segment: segment || undefined,
      region: region || undefined,
      severity: severity || undefined,
      watchlist_only: watchlistOnly,
      min_ews: minEws ? Number(minEws) : undefined,
      max_ews: maxEws ? Number(maxEws) : undefined,
      search: search || undefined,
      sort: sortKey,
      order: sortOrder,
    }),
  });

  const cmaMut = useMutation({
    mutationFn: (ids: string[]) => api.cohortCmaPack(ids),
    onSuccess: (pack) => {
      setCmaResult({
        pack_id: pack.pack_id,
        cohort_size: pack.cohort_size,
        mean_ews_score: pack.totals.mean_ews_score,
        total_exposure_inr: pack.totals.exposure_inr,
      });
    },
  });

  const report: BorrowerListReportShape | undefined = listQ.data;
  const rows = useMemo(() => report?.items ?? [], [report]);

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelected((s) => {
      if (s.size === rows.length) return new Set();
      return new Set(rows.map((r) => r.borrower_id));
    });
  };

  const clearFilters = () => {
    setSector(''); setSegment(''); setRegion(''); setSeverity('');
    setWatchlistOnly(false); setMinEws(''); setMaxEws(''); setSearch('');
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Borrower Watch"
        subtitle="Per-borrower 360° EWS view — ranked by AI score, server-sorted"
        actions={
          <>
            <Button variant="ghost" onClick={() => exportRowsCsv(rows, `borrower-watch-${new Date().toISOString().slice(0, 10)}`)} disabled={rows.length === 0} data-testid="bw-export">
              <Download size={14} /> Export CSV
            </Button>
            {/* Enterprise export (P2) — RBAC-gated; renders null without
                reports:export. Feeds the post-filter `rows` + KPI totals so
                the export honours active sector/segment/severity/EWS filters. */}
            <ExportButton
              module="borrower_watch"
              reportType="risk"
              adapter={(config) =>
                buildBorrowerWatchReportData(
                  {
                    rows,
                    summary: {
                      total: report?.total ?? rows.length,
                      total_unfiltered: report?.total_unfiltered ?? rows.length,
                      by_severity: {
                        S1: report?.by_severity?.S1 ?? 0,
                        S2: report?.by_severity?.S2 ?? 0,
                        S3: report?.by_severity?.S3 ?? 0,
                      },
                    },
                    meta: { tenant_id: 'BANK_DEMO', generated_by: me?.username ?? 'operator', role: me?.roles?.[0] ?? 'admin' },
                  },
                  config,
                )
              }
            />
          </>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard label="Total (filtered)" value={report?.total ?? 0} sub={`of ${report?.total_unfiltered ?? 0} unfiltered`} testId="bw-kpi-total" />
        <MetricCard label="S1 (critical)" value={report?.by_severity?.S1 ?? 0} sub="EWS ≥ 75" tone="danger" testId="bw-kpi-s1" />
        <MetricCard label="S2 (warning)" value={report?.by_severity?.S2 ?? 0} sub="50 ≤ EWS < 75" tone="warning" testId="bw-kpi-s2" />
        <MetricCard label="S3 (monitor)" value={report?.by_severity?.S3 ?? 0} sub="EWS < 50" testId="bw-kpi-s3" />
      </div>

      {/* Filter bar */}
      <Panel title="Stressed Borrowers" data-testid="bw-table-panel">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'stressed' | 'all')} className="rounded border border-slate-300 px-2 py-1" data-testid="bw-filter-mode">
            <option value="stressed">Stressed only (S1+S2)</option>
            <option value="all">All borrowers</option>
          </select>
          <select value={sector} onChange={(e) => setSector(e.target.value as BorrowerSector | '')} className="rounded border border-slate-300 px-2 py-1" data-testid="bw-filter-sector">
            <option value="">All sectors</option>
            {SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={segment} onChange={(e) => setSegment(e.target.value as BorrowerSegment | '')} className="rounded border border-slate-300 px-2 py-1" data-testid="bw-filter-segment">
            <option value="">All segments</option>
            {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={region} onChange={(e) => setRegion(e.target.value as BorrowerRegion | '')} className="rounded border border-slate-300 px-2 py-1" data-testid="bw-filter-region">
            <option value="">All regions</option>
            {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as BorrowerSeverity | '')} className="rounded border border-slate-300 px-2 py-1" data-testid="bw-filter-severity">
            <option value="">All severities</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1 text-slate-600">
            <input type="checkbox" checked={watchlistOnly} onChange={(e) => setWatchlistOnly(e.target.checked)} data-testid="bw-filter-watchlist" />
            Watchlist only
          </label>
          <label className="flex items-center gap-1 text-slate-600">
            EWS
            <input type="number" value={minEws} onChange={(e) => setMinEws(e.target.value)} placeholder="min" min={0} max={100} className="w-14 rounded border border-slate-300 px-2 py-1" data-testid="bw-filter-min-ews" />
            <span>–</span>
            <input type="number" value={maxEws} onChange={(e) => setMaxEws(e.target.value)} placeholder="max" min={0} max={100} className="w-14 rounded border border-slate-300 px-2 py-1" data-testid="bw-filter-max-ews" />
          </label>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search id or name" className="rounded border border-slate-300 px-2 py-1" data-testid="bw-filter-search" />
          {(sector || segment || region || severity || watchlistOnly || minEws || maxEws || search) && (
            <button type="button" onClick={clearFilters} className="ml-auto text-slate-500 underline hover:text-slate-700" data-testid="bw-filter-clear">
              Clear filters
            </button>
          )}
        </div>

        {/* Cohort action bar */}
        {selected.size > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm" data-testid="bw-cohort-bar">
            <span className="font-medium text-blue-900">{selected.size} selected</span>
            <Button variant="ghost" onClick={() => cmaMut.mutate(Array.from(selected))} disabled={cmaMut.isPending} data-testid="bw-cohort-cma">
              <FileText size={14} /> Build CMA pack
            </Button>
            <Button variant="ghost" onClick={() => exportRowsCsv(rows.filter((r) => selected.has(r.borrower_id)), `cohort-${new Date().toISOString().slice(0, 10)}`)} data-testid="bw-cohort-export">
              <Download size={14} /> Export cohort CSV
            </Button>
            <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-xs text-slate-500 underline">Clear selection</button>
          </div>
        )}

        {cmaResult && (
          <div className="mb-3 flex items-center gap-3 rounded border border-success bg-success-bg px-3 py-2 text-sm" data-testid="bw-cma-result">
            <CheckCircle2 size={16} className="text-success" />
            <span>
              CMA pack built — <span className="font-mono">{cmaResult.pack_id}</span> ·{' '}
              cohort {cmaResult.cohort_size} · mean EWS {cmaResult.mean_ews_score} · exposure {fmtINR(cmaResult.total_exposure_inr)}
            </span>
            <button onClick={() => setCmaResult(null)} className="ml-auto text-xs text-slate-500 hover:text-slate-700">×</button>
          </div>
        )}

        {/* Server-side sort selector */}
        <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
          <span>Sorted by</span>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as BorrowerSortKey)} className="rounded border border-slate-300 px-1 py-0.5" data-testid="bw-sort-key">
            <option value="ews_score">EWS score</option>
            <option value="exposure_inr">Exposure</option>
            <option value="dpd">DPD</option>
            <option value="last_alert_at">Last alert</option>
            <option value="name">Name</option>
          </select>
          <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as 'asc' | 'desc')} className="rounded border border-slate-300 px-1 py-0.5" data-testid="bw-sort-order">
            <option value="desc">desc</option>
            <option value="asc">asc</option>
          </select>
          <span className="text-slate-400">· server-side</span>
        </div>

        {listQ.isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No borrowers match your filters.</div>
        ) : (
          <div className="overflow-x-auto" data-testid="bw-table">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">
                    <input type="checkbox" checked={selected.size > 0 && selected.size === rows.length} onChange={toggleSelectAll} data-testid="bw-select-all" />
                  </th>
                  <th className="px-2 py-1.5">Borrower</th>
                  <th className="px-2 py-1.5">Sector</th>
                  <th className="px-2 py-1.5 text-right">Exposure</th>
                  <th className="px-2 py-1.5 text-right">EWS</th>
                  <th className="px-2 py-1.5">Severity</th>
                  <th className="px-2 py-1.5">Top signal</th>
                  <th className="px-2 py-1.5">Last alert</th>
                  <th className="px-2 py-1.5">Watchlist</th>
                  <th className="px-2 py-1.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.borrower_id} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`bw-row-${r.borrower_id}`}>
                    <td className="px-2 py-2">
                      <input type="checkbox" checked={selected.has(r.borrower_id)} onChange={() => toggleSelect(r.borrower_id)} data-testid={`bw-select-${r.borrower_id}`} />
                    </td>
                    <td className="px-2 py-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="font-mono text-xs text-slate-500">{r.borrower_id}</div>
                    </td>
                    <td className="px-2 py-2 text-xs">{r.sector}</td>
                    <td className="px-2 py-2 text-right font-mono text-xs">{fmtINR(r.exposure_inr)}</td>
                    <td className="px-2 py-2 text-right">
                      <Badge tone={ewsBand(r.ews_score)}>{r.ews_score}</Badge>
                    </td>
                    <td className="px-2 py-2"><Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge></td>
                    <td className="px-2 py-2 text-xs text-slate-600">{r.top_signal}</td>
                    <td className="px-2 py-2 text-xs text-slate-500">{fmtTime(r.last_alert_at)}</td>
                    <td className="px-2 py-2">
                      {r.watchlist_tag ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-warning bg-warning-bg px-2 py-0.5 text-xs text-warning">
                          <Star size={10} /> {r.watchlist_tag}
                        </span>
                      ) : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-2 py-2">
                      <Button variant="ghost" onClick={() => { setOpenBorrower(r); setActiveTab('overview'); }} data-testid={`bw-open-${r.borrower_id}`}>
                        <Eye size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {openBorrower && (
        <BorrowerDetailModal
          borrower={openBorrower}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onClose={() => setOpenBorrower(null)}
          onWatchlistChange={() => qc.invalidateQueries({ queryKey: ['borrower-list'] })}
        />
      )}
    </div>
  );
}

// ── Borrower Detail Modal ──────────────────────────────────────────────

const TABS = ['overview', 'ratios', 'signals', 'alerts', 'sma', 'cases', 'notes'] as const;
type DetailTab = (typeof TABS)[number];

function BorrowerDetailModal({
  borrower,
  activeTab,
  setActiveTab,
  onClose,
  onWatchlistChange,
}: {
  borrower: BorrowerWatchRowShape;
  activeTab: DetailTab;
  setActiveTab: (t: DetailTab) => void;
  onClose: () => void;
  onWatchlistChange: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" data-testid="bw-detail-modal">
      <div className="w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">{borrower.name}</h3>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-xs text-slate-500">{borrower.borrower_id}</span>
              <Badge tone={SEVERITY_TONE[borrower.severity]}>{borrower.severity}</Badge>
              <span className="text-xs text-slate-500">EWS</span>
              <Badge tone={ewsBand(borrower.ews_score)}>{borrower.ews_score}</Badge>
              <span className="text-xs text-slate-500">·</span>
              <span className="font-mono text-xs">{fmtINR(borrower.exposure_inr)}</span>
              <span className="text-xs text-slate-500">·</span>
              <span className="text-xs text-slate-600">{borrower.sector}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700" data-testid="bw-detail-close"><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-slate-200 text-xs" data-testid="bw-detail-tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`-mb-px border-b-2 px-3 py-1.5 font-medium uppercase ${activeTab === tab ? 'border-blue-700 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
              data-testid={`bw-tab-${tab}`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === 'overview' && <OverviewTab borrower={borrower} onWatchlistChange={onWatchlistChange} />}
        {activeTab === 'ratios' && <RatiosTab borrower={borrower} />}
        {activeTab === 'signals' && <SignalsTab borrower={borrower} />}
        {activeTab === 'alerts' && <AlertsTab borrower={borrower} />}
        {activeTab === 'sma' && <SmaTab borrower={borrower} />}
        {activeTab === 'cases' && <CasesTab borrower={borrower} />}
        {activeTab === 'notes' && <NotesTab borrower={borrower} />}
      </div>
    </div>
  );
}

function OverviewTab({ borrower, onWatchlistChange }: { borrower: BorrowerWatchRowShape; onWatchlistChange: () => void }) {
  const watchedQ = useQuery({
    queryKey: ['watchlist-list-for-detail'],
    queryFn: () => api.watchlistList(),
  });
  const isOnWatchlist = useMemo(() => {
    const items = (watchedQ.data?.items ?? []) as Array<{ customer_id: string }>;
    return items.some((w) => w.customer_id === borrower.borrower_id);
  }, [watchedQ.data, borrower.borrower_id]);

  const [tagInput, setTagInput] = useState(borrower.watchlist_tag ?? 'Manual EWS review');
  const addMut = useMutation({
    mutationFn: () => api.watchlistAdd({ customer_id: borrower.borrower_id, reason: tagInput || 'Watch' }),
    onSuccess: () => { onWatchlistChange(); watchedQ.refetch(); },
  });
  const removeMut = useMutation({
    mutationFn: () => api.watchlistRemove(borrower.borrower_id),
    onSuccess: () => { onWatchlistChange(); watchedQ.refetch(); },
  });

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded border border-slate-200 p-3">
          <div className="text-xs font-semibold text-slate-500">Exposure</div>
          <div className="mt-1 font-mono text-base">{fmtINR(borrower.exposure_inr)}</div>
          <div className="mt-1 text-xs text-slate-500">PD {(borrower.pd * 100).toFixed(1)}% · DPD {borrower.dpd}</div>
        </div>
        <div className="rounded border border-slate-200 p-3">
          <div className="text-xs font-semibold text-slate-500">Profile</div>
          <div className="mt-1 text-sm">{borrower.sector} · {borrower.segment}</div>
          <div className="mt-1 text-xs text-slate-500">{borrower.region} region</div>
        </div>
        <div className="rounded border border-slate-200 p-3">
          <div className="text-xs font-semibold text-slate-500">Watchlist</div>
          {isOnWatchlist ? (
            <>
              <Badge tone="warning">on watchlist</Badge>
              <Button variant="ghost" onClick={() => removeMut.mutate()} disabled={removeMut.isPending} data-testid="bw-watchlist-remove">
                Remove from watchlist
              </Button>
            </>
          ) : (
            <>
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Tag (reason)"
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                data-testid="bw-watchlist-tag"
              />
              <Button onClick={() => addMut.mutate()} disabled={addMut.isPending || !tagInput.trim()} data-testid="bw-watchlist-add">
                <Plus size={14} /> Add to watchlist
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="rounded border border-slate-200 p-3">
        <div className="mb-1 text-xs font-semibold text-slate-500">Top signal</div>
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-warning" />
          {borrower.top_signal}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          to={`/customers/${encodeURIComponent(borrower.borrower_id)}`}
          className="inline-flex items-center gap-1 rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
          data-testid="bw-open-customer-page"
        >
          <ExternalLink size={12} /> Open full 360°
        </Link>
        <Link
          to={`/sectors?focus=${encodeURIComponent(borrower.sector)}`}
          className="inline-flex items-center gap-1 rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
          data-testid="bw-jump-sector"
        >
          <TrendingUp size={12} /> Sector analysis ({borrower.sector})
        </Link>
        <Link
          to={`/sectors/${encodeURIComponent(borrower.sector)}/compare?borrower=${encodeURIComponent(borrower.borrower_id)}`}
          className="inline-flex items-center gap-1 rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
          data-testid="bw-compare-sector"
        >
          <BookOpen size={12} /> Compare to sector
        </Link>
        <Link
          to={`/notices/issue?borrower=${encodeURIComponent(borrower.borrower_id)}`}
          className="inline-flex items-center gap-1 rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50"
          data-testid="bw-issue-notice"
        >
          <FileText size={12} /> Issue notice
        </Link>
        <Link
          to={`/cases/new?customer=${encodeURIComponent(borrower.borrower_id)}`}
          className="inline-flex items-center gap-1 rounded border border-danger bg-danger-bg px-3 py-1.5 text-xs text-danger hover:opacity-90"
          data-testid="bw-escalate"
        >
          <ShieldCheck size={12} /> Escalate to case
        </Link>
      </div>
    </div>
  );
}

function RatiosTab({ borrower }: { borrower: BorrowerWatchRowShape }) {
  const profileQ = useQuery({
    queryKey: ['risk-profile', borrower.borrower_id],
    queryFn: () => api.riskProfile(borrower.borrower_id),
  });
  if (profileQ.isLoading) return <div className="text-sm text-slate-500">Loading ratios…</div>;
  if (profileQ.isError) return <div className="text-sm text-danger">Failed to load profile</div>;
  const p = profileQ.data;
  if (!p) return <div className="text-sm text-slate-500">No profile data.</div>;
  return (
    <div className="space-y-2 text-sm" data-testid="bw-ratios-tab">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="PD" value={`${(p.pd * 100).toFixed(1)}%`} />
        <Stat label="Level" value={p.level} />
        <Stat label="DPD" value={String(p.dpd)} />
        <Stat label="Exposure" value={fmtINR(p.exposure)} />
      </div>
      {p.top_reasons && p.top_reasons.length > 0 && (
        <div className="rounded border border-slate-200 p-3">
          <div className="mb-2 text-xs font-semibold text-slate-500">Top reason codes (SHAP)</div>
          <ul className="space-y-1 text-xs">
            {p.top_reasons.map((r, i) => (
              <li key={i} className="font-mono">{r.feature} = {String(r.value)} · contribution {r.shap_value.toFixed(3)} ({r.direction})</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-200 px-2 py-1.5">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}

function SignalsTab({ borrower }: { borrower: BorrowerWatchRowShape }) {
  return (
    <div className="space-y-2 text-sm" data-testid="bw-signals-tab">
      <div className="rounded border border-slate-200 p-3">
        <div className="text-xs font-semibold text-slate-500">Live signal</div>
        <div className="mt-1 flex items-center gap-2">
          <AlertTriangle size={14} className="text-warning" /> {borrower.top_signal}
        </div>
      </div>
      <div className="text-xs text-slate-500">
        Additional account signals (txn velocity, salary credits, MAB drops) are derived from the customer's
        transaction stream and surfaced in the full <Link to={`/customers/${encodeURIComponent(borrower.borrower_id)}`} className="text-blue-700 underline">/360°</Link> view.
      </div>
    </div>
  );
}

function AlertsTab({ borrower }: { borrower: BorrowerWatchRowShape }) {
  const alertsQ = useQuery({
    queryKey: ['alerts-for-borrower', borrower.borrower_id],
    queryFn: () => api.alerts({ customer_id: borrower.borrower_id }),
  });
  if (alertsQ.isLoading) return <div className="text-sm text-slate-500">Loading alerts…</div>;
  const items = alertsQ.data?.items ?? [];
  return (
    <div className="space-y-2 text-sm" data-testid="bw-alerts-tab">
      {items.length === 0 ? (
        <div className="text-slate-500">No alerts yet for this borrower.</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {items.map((a) => (
            <li key={a.id} className="rounded border border-slate-200 p-2">
              <Badge tone={a.severity === 'critical' ? 'danger' : a.severity === 'high' ? 'warning' : 'neutral'}>{a.severity}</Badge>{' '}
              <span className="ml-1 font-mono text-slate-500">{a.rule.id}</span> · {fmtTime(a.created_at)} · {a.indicators.join(', ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SmaTab({ borrower }: { borrower: BorrowerWatchRowShape }) {
  // SMA = Special Mention Account (RBI classification stage).
  const sma = borrower.dpd < 31 ? 'SMA-0' : borrower.dpd < 61 ? 'SMA-1' : borrower.dpd < 91 ? 'SMA-2' : 'NPA';
  const tone: BadgeTone = sma === 'NPA' ? 'danger' : sma === 'SMA-2' ? 'warning' : sma === 'SMA-1' ? 'warning' : 'success';
  return (
    <div className="space-y-2 text-sm" data-testid="bw-sma-tab">
      <div className="rounded border border-slate-200 p-3">
        <div className="mb-1 text-xs font-semibold text-slate-500">RBI SMA stage</div>
        <Badge tone={tone}>{sma}</Badge>
        <div className="mt-2 text-xs text-slate-500">
          DPD {borrower.dpd} days · {sma === 'SMA-0' ? '< 31 days overdue' : sma === 'SMA-1' ? '31-60 days' : sma === 'SMA-2' ? '61-90 days' : 'NPA (>90 days)'}
        </div>
      </div>
    </div>
  );
}

function CasesTab({ borrower }: { borrower: BorrowerWatchRowShape }) {
  const casesQ = useQuery({
    queryKey: ['cases-for-borrower', borrower.borrower_id],
    queryFn: () => api.cases({ customer_id: borrower.borrower_id }),
  });
  if (casesQ.isLoading) return <div className="text-sm text-slate-500">Loading cases…</div>;
  const items = casesQ.data?.items ?? [];
  return (
    <div className="space-y-2 text-sm" data-testid="bw-cases-tab">
      {items.length === 0 ? (
        <div className="text-slate-500">No cases yet — escalate to create one.</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {items.map((c) => (
            <li key={c.id} className="rounded border border-slate-200 p-2">
              <Badge tone={c.state === 'closed' ? 'success' : 'warning'}>{c.state}</Badge>{' '}
              <span className="ml-1 font-mono">{c.id}</span> · age {c.age_min}m · assignee {c.assignee ?? '—'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NotesTab({ borrower }: { borrower: BorrowerWatchRowShape }) {
  void borrower;
  return (
    <div className="text-sm text-slate-500" data-testid="bw-notes-tab">
      Per-borrower notes — populated from the M9.1 investigation notes thread when an open
      investigation exists. Use the full <span className="font-mono">/customers/:id</span> view
      to add a new note.
    </div>
  );
}
