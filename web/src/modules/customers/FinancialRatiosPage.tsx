// web/src/modules/customers/FinancialRatiosPage.tsx
//
// Module 2.3 — Financial Ratios.
//
// 7 BFF endpoints back this screen — 5 already shipped pre-M2.3 + 2 new:
//   GET  /v1/banking/ratios/master                                    (pre-existing)
//   GET  /v1/banking/ratios/thresholds                                (pre-existing)
//   PUT  /v1/banking/ratios/thresholds/:code                          (pre-existing)
//   GET  /v1/banking/ratios/customer/:customer_id                     (pre-existing)
//   GET  /v1/banking/ratios/sector-benchmark?sector=                  (pre-existing)
//   POST /v1/banking/cma/pack                                         (pre-existing)
//   GET  /v1/banking/ratios/customer/:id/history?ratio_code=          (M2.3 new — slice)
//   GET  /v1/banking/ratios/notes / POST notes                        (M2.3 new — notes)

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText, Settings2, Sigma, StickyNote, X } from 'lucide-react';
import { Panel, Button, Input, MetricCard, Badge } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildFinancialRatiosReportData } from './financialRatiosReportAdapter';
import { api } from '@/lib/api';
import type {
  RatioCode,
  RatioBand,
  RatioMasterShape,
  RatioThresholdsListShape,
  CustomerRatioBundleShape,
  RatioHistorySliceShape,
  RatioNotesListShape,
  CmaPackResultShape,
} from '@/lib/api';

const SAMPLE_COHORT: readonly string[] = [
  'c-101', 'c-106', 'c-115', 'c-118', 'c-100', 'c-102', 'c-103', 'c-105', 'c-110', 'c-120',
];

const BAND_TONE: Record<RatioBand, BadgeTone> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
};
const BAND_CELL: Record<RatioBand, string> = {
  green: 'bg-success/10 text-success border-success/30',
  amber: 'bg-warning/10 text-warning border-warning/30',
  red: 'bg-danger/10 text-danger border-danger/30',
};

function fmtVal(value: number, unit: '×' | 'ratio' | 'days'): string {
  if (unit === 'days') return `${value}d`;
  if (unit === '×') return `${value}×`;
  return value.toFixed(2);
}

export function FinancialRatiosPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();

  const masterQ = useQuery({
    queryKey: ['ratios-master'],
    queryFn: () => api.ratiosMaster() as Promise<RatioMasterShape>,
    staleTime: 5 * 60_000,
  });
  const thresholdsQ = useQuery({
    queryKey: ['ratios-thresholds'],
    queryFn: () => api.ratiosThresholds() as Promise<RatioThresholdsListShape>,
  });

  // Watchlist data — fetch one CustomerRatioBundle per cohort id.
  const cohort = SAMPLE_COHORT;
  const bundleQueries = cohort.map((cid) => ({
    cid,
    q: useQuery({
      queryKey: ['ratios-customer', cid],
      queryFn: () => api.ratiosByCustomer(cid) as Promise<CustomerRatioBundleShape>,
    }),
  }));

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showThresholds, setShowThresholds] = useState(false);
  const [detail, setDetail] = useState<{ customer_id: string; ratio_code: RatioCode } | null>(null);
  const [cmaResult, setCmaResult] = useState<CmaPackResultShape | null>(null);
  const [cmaError, setCmaError] = useState<string | null>(null);

  const cmaMut = useMutation({
    mutationFn: (ids: string[]) => api.buildCmaPack(ids, ['II', 'III', 'IV', 'V']),
    onSuccess: (p) => {
      setCmaResult(p);
      setCmaError(null);
    },
    onError: (e: Error) => setCmaError(e.message || 'CMA build failed'),
  });

  const kpis = useMemo(() => {
    const total = bundleQueries.filter((b) => b.q.data).length;
    let red = 0;
    let amber = 0;
    let green = 0;
    for (const b of bundleQueries) {
      if (!b.q.data) continue;
      if (b.q.data.worst_band === 'red') red++;
      else if (b.q.data.worst_band === 'amber') amber++;
      else green++;
    }
    return { total, red, amber, green };
  }, [bundleQueries]);

  const toggleSelect = (cid: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Financial Ratios"
        subtitle="Per-borrower ratio watchlist with colour banding vs threshold + sector trend. Configure thresholds, drill ratio history, build CMA packs for credit committee."
        actions={
          /* Enterprise export (P2) — RBAC-gated; renders null without
             reports:export. Reports the loaded ratio cohort (the same rows
             the watchlist table renders) + the colour-band KPI strip, with
             a ratio column per master ratio code. */
          <ExportButton
            module="financial_ratios"
            reportType="risk"
            adapter={(config) =>
              buildFinancialRatiosReportData(
                {
                  ratioCodes: (masterQ.data?.ratios ?? []).map((r) => r.code),
                  rows: bundleQueries
                    .filter((b) => b.q.data)
                    .map(({ cid, q }) => {
                      const b = q.data!;
                      const values: Record<string, number | undefined> = {};
                      for (const r of masterQ.data?.ratios ?? []) {
                        values[r.code] = b.current[r.code]?.value;
                      }
                      return {
                        customer_id: cid,
                        customer_name: b.customer_name,
                        sector: b.sector,
                        worst_band: b.worst_band,
                        values,
                      };
                    }),
                  kpis,
                  meta: { tenant_id: 'BANK_DEMO', generated_by: me?.username ?? 'operator', role: me?.roles?.[0] ?? 'admin' },
                },
                config,
              )
            }
          />
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetricCard testId="fr-kpi-cohort" label="Cohort size" value={kpis.total} />
        <MetricCard testId="fr-kpi-red" label="Red (critical)" value={kpis.red} tone="danger" />
        <MetricCard testId="fr-kpi-amber" label="Amber (watch)" value={kpis.amber} tone="warning" />
        <MetricCard testId="fr-kpi-green" label="Green (healthy)" value={kpis.green} />
      </div>

      {/* Action bar */}
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3" data-testid="fr-action-bar">
          <div className="text-sm">
            <span className="font-medium">{selected.size}</span> selected
            {selected.size > 0 && (
              <span className="text-ink-muted ml-2">— pick up to 50 borrowers for CMA pack</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              data-testid="fr-thresholds-btn"
              onClick={() => setShowThresholds(true)}
            >
              <Settings2 className="h-4 w-4 mr-2" /> Thresholds
            </Button>
            <Button
              variant="primary"
              disabled={selected.size === 0 || cmaMut.isPending}
              onClick={() => cmaMut.mutate(Array.from(selected))}
              data-testid="fr-build-cma-btn"
            >
              <FileText className="h-4 w-4 mr-2" /> Build CMA pack
            </Button>
          </div>
        </div>
        {cmaError && (
          <div className="mt-2 text-sm text-danger" data-testid="fr-cma-error">{cmaError}</div>
        )}
        {cmaResult && (
          <div className="mt-2 rounded bg-success/10 text-success border border-success/30 p-2 text-sm" data-testid="fr-cma-receipt">
            Pack <span className="font-mono">{cmaResult.pack_id}</span> ready for{' '}
            <b>{cmaResult.cohort_size}</b> borrower(s) · forms {cmaResult.forms.join('/')} · size{' '}
            {(cmaResult.size_bytes / 1024).toFixed(1)} KB
            {'  '}
            <button
              data-testid="fr-cma-print"
              className="ml-2 underline"
              onClick={() => {
                const w = window.open('', '_blank');
                if (w) {
                  w.document.write(cmaResult.html);
                  w.document.close();
                  setTimeout(() => w.print(), 400);
                }
              }}
            >
              Open + print
            </button>
          </div>
        )}
      </Panel>

      {/* Watchlist table */}
      <Panel>
        <div className="overflow-x-auto" data-testid="fr-watchlist-table">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-ink-muted">
              <tr>
                <th className="text-left px-2 py-2 w-8">Pick</th>
                <th className="text-left px-2 py-2">Borrower</th>
                <th className="text-left px-2 py-2">Sector</th>
                {(masterQ.data?.ratios ?? []).map((r) => (
                  <th key={r.code} className="text-right px-2 py-2" title={r.formula}>
                    {r.code}
                  </th>
                ))}
                <th className="text-left px-2 py-2">Worst</th>
              </tr>
            </thead>
            <tbody>
              {bundleQueries.map(({ cid, q }) => {
                const b = q.data;
                return (
                  <tr key={cid} className="border-t border-divider hover:bg-surface-2/40">
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        data-testid={`fr-pick-${cid}`}
                        checked={selected.has(cid)}
                        onChange={() => toggleSelect(cid)}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      {b ? (
                        <Link to={`/customers/${cid}`} className="font-medium hover:underline">
                          {b.customer_name}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">…</span>
                      )}
                      <div className="text-xs text-ink-muted font-mono">{cid}</div>
                    </td>
                    <td className="px-2 py-1.5 text-xs">{b?.sector ?? '…'}</td>
                    {(masterQ.data?.ratios ?? []).map((r) => {
                      const v = b?.current[r.code];
                      if (!v) return <td key={r.code} className="px-2 py-1.5">…</td>;
                      return (
                        <td key={r.code} className="px-1 py-1">
                          <button
                            data-testid={`fr-cell-${cid}-${r.code}`}
                            className={`w-full px-2 py-1 rounded border text-right font-mono text-xs hover:ring-2 hover:ring-action ${BAND_CELL[v.band]}`}
                            onClick={() => setDetail({ customer_id: cid, ratio_code: r.code })}
                            title={`${r.name}\nValue: ${fmtVal(v.value, r.unit)} (${v.band})\nThresholds: warn=${v.warning_threshold}, crit=${v.critical_threshold}`}
                          >
                            {fmtVal(v.value, r.unit)}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5">
                      {b ? <Badge tone={BAND_TONE[b.worst_band]}>{b.worst_band}</Badge> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {showThresholds && masterQ.data && (
        <ThresholdsModal
          master={masterQ.data}
          thresholds={thresholdsQ.data ?? null}
          onClose={() => setShowThresholds(false)}
          onSave={async (code, warning, critical) => {
            await api.ratiosSetThreshold(code, warning, critical);
            await qc.invalidateQueries({ queryKey: ['ratios-thresholds'] });
            await qc.invalidateQueries({ queryKey: ['ratios-customer'] });
          }}
          onClear={async (code) => {
            await api.ratiosClearThreshold(code);
            await qc.invalidateQueries({ queryKey: ['ratios-thresholds'] });
            await qc.invalidateQueries({ queryKey: ['ratios-customer'] });
          }}
        />
      )}

      {detail && (
        <RatioDetailModal
          customer_id={detail.customer_id}
          ratio_code={detail.ratio_code}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

// ─── Thresholds editor ─────────────────────────────────────────────────

function ThresholdsModal({
  master,
  thresholds,
  onClose,
  onSave,
  onClear,
}: {
  master: RatioMasterShape;
  thresholds: RatioThresholdsListShape | null;
  onClose: () => void;
  onSave: (code: string, warning: number, critical: number) => Promise<void>;
  onClear: (code: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, { warning: string; critical: string }>>({});

  useEffect(() => {
    const seed: Record<string, { warning: string; critical: string }> = {};
    for (const r of master.ratios) {
      const ovr = thresholds?.entries.find((e) => e.code === r.code);
      seed[r.code] = {
        warning: String(ovr?.warning ?? r.default_warning),
        critical: String(ovr?.critical ?? r.default_critical),
      };
    }
    setDrafts(seed);
  }, [master, thresholds]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" data-testid="fr-thresholds-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Ratio thresholds</h3>
            <div className="text-xs text-ink-muted">Per-ratio warning + critical bands. Tenant overrides shipped via M13.1 config store.</div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="fr-thresholds-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs text-ink-muted">
            <tr>
              <th className="text-left px-2 py-2">Ratio</th>
              <th className="text-right px-2 py-2">Warning</th>
              <th className="text-right px-2 py-2">Critical</th>
              <th className="text-left px-2 py-2">Source</th>
              <th className="text-right px-2 py-2 w-44">Actions</th>
            </tr>
          </thead>
          <tbody>
            {master.ratios.map((r) => {
              const ovr = thresholds?.entries.find((e) => e.code === r.code);
              const d = drafts[r.code] ?? { warning: String(r.default_warning), critical: String(r.default_critical) };
              return (
                <tr key={r.code} className="border-t border-divider">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{r.code}</div>
                    <div className="text-xs text-ink-muted">{r.name}</div>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Input
                      value={d.warning}
                      onChange={(e) => setDrafts((s) => ({ ...s, [r.code]: { ...d, warning: e.target.value } }))}
                      data-testid={`fr-thr-warning-${r.code}`}
                      className="w-24 inline-block"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Input
                      value={d.critical}
                      onChange={(e) => setDrafts((s) => ({ ...s, [r.code]: { ...d, critical: e.target.value } }))}
                      data-testid={`fr-thr-critical-${r.code}`}
                      className="w-24 inline-block"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    <Badge tone={ovr ? 'warning' : 'neutral'}>{ovr ? 'override' : 'default'}</Badge>
                  </td>
                  <td className="px-2 py-1.5 text-right space-x-1">
                    <button
                      data-testid={`fr-thr-save-${r.code}`}
                      className="text-xs text-action hover:underline"
                      onClick={() => onSave(r.code, parseFloat(d.warning), parseFloat(d.critical))}
                    >
                      Save
                    </button>
                    <span className="text-ink-muted">·</span>
                    <button
                      data-testid={`fr-thr-clear-${r.code}`}
                      className="text-xs text-warning hover:underline"
                      onClick={() => onClear(r.code)}
                      disabled={!ovr}
                    >
                      Clear
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Ratio detail — history line + sector benchmark overlay + notes ───

function RatioDetailModal({
  customer_id,
  ratio_code,
  onClose,
}: {
  customer_id: string;
  ratio_code: RatioCode;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const sliceQ = useQuery({
    queryKey: ['ratio-slice', customer_id, ratio_code],
    queryFn: () => api.ratiosHistory(customer_id, ratio_code) as Promise<RatioHistorySliceShape>,
  });
  const notesQ = useQuery({
    queryKey: ['ratio-notes', customer_id, ratio_code],
    queryFn: () => api.ratiosNotesList({ customer_id, ratio_code }) as Promise<RatioNotesListShape>,
  });
  const [newNote, setNewNote] = useState('');
  const addNoteMut = useMutation({
    mutationFn: () => api.ratiosNotesAdd(customer_id, ratio_code, newNote),
    onSuccess: () => {
      setNewNote('');
      qc.invalidateQueries({ queryKey: ['ratio-notes', customer_id, ratio_code] });
    },
  });

  const slice = sliceQ.data;
  const def = slice?.ratio_def;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" data-testid="fr-detail-modal">
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Sigma className="h-4 w-4" /> {ratio_code} — {slice?.customer_name ?? customer_id}
            </h3>
            <div className="text-xs text-ink-muted">{def ? `${def.name} · ${def.formula}` : 'Loading…'}</div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="fr-detail-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          {slice && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <div className="text-xs text-ink-muted">Current</div>
                  <div className="text-xl font-mono">{fmtVal(slice.current.value, def?.unit ?? '×')}</div>
                  <Badge tone={BAND_TONE[slice.current.band]}>{slice.current.band}</Badge>
                </div>
                <div>
                  <div className="text-xs text-ink-muted">Sector median</div>
                  <div className="text-lg font-mono">{fmtVal(slice.sector_benchmark.median, def?.unit ?? '×')}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-muted">Sector P25 – P75</div>
                  <div className="text-sm font-mono">
                    {fmtVal(slice.sector_benchmark.p25, def?.unit ?? '×')} – {fmtVal(slice.sector_benchmark.p75, def?.unit ?? '×')}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ink-muted">vs Sector</div>
                  <Badge
                    tone={
                      slice.trend_vs_sector === 'better' ? 'success' : slice.trend_vs_sector === 'worse' ? 'danger' : 'neutral'
                    }
                  >
                    {slice.trend_vs_sector === 'better' ? '▲ better' : slice.trend_vs_sector === 'worse' ? '▼ worse' : '→ on par'}
                  </Badge>
                </div>
              </div>

              <div className="rounded border border-divider p-3" data-testid="fr-detail-chart">
                <div className="text-xs text-ink-muted mb-1">12-month history (bars) vs sector median (dashed)</div>
                <HistoryChart points={slice.history} median={slice.sector_benchmark.median} unit={def?.unit ?? '×'} />
              </div>

              <div>
                <h4 className="font-medium text-sm flex items-center gap-2 mb-2">
                  <StickyNote className="h-4 w-4" /> Notes
                </h4>
                <div className="space-y-2 max-h-44 overflow-y-auto" data-testid="fr-notes-list">
                  {(notesQ.data?.notes ?? []).length === 0 && (
                    <div className="text-xs text-ink-muted italic">No notes yet.</div>
                  )}
                  {(notesQ.data?.notes ?? []).map((n) => (
                    <div key={n.note_id} className="text-sm rounded border border-divider p-2">
                      <div className="text-xs text-ink-muted">
                        <span className="font-medium">{n.author}</span> · {new Date(n.created_at).toLocaleString()}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap">{n.body}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <Input
                    data-testid="fr-note-input"
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder="Add a note (≤ 1000 chars)…"
                    className="flex-1"
                  />
                  <Button
                    variant="primary"
                    disabled={newNote.trim().length === 0 || addNoteMut.isPending}
                    onClick={() => addNoteMut.mutate()}
                    data-testid="fr-note-submit"
                  >
                    Add note
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Tiny self-contained bar+line chart for the history modal.
function HistoryChart({
  points,
  median,
  unit,
}: {
  points: { date: string; value: number; band: 'green' | 'amber' | 'red' }[];
  median: number;
  unit: '×' | 'ratio' | 'days';
}) {
  if (!points.length) return <div className="text-xs text-ink-muted">No history</div>;
  const max = Math.max(median, ...points.map((p) => p.value));
  return (
    <div className="flex items-end gap-1 h-32">
      {points.map((p, i) => {
        const h = Math.max(4, (p.value / max) * 100);
        const colour =
          p.band === 'red' ? 'bg-danger/70' : p.band === 'amber' ? 'bg-warning/70' : 'bg-success/70';
        return (
          <div key={i} className="flex-1 relative" title={`${p.date}: ${fmtVal(p.value, unit)} (${p.band})`}>
            <div className={`${colour} rounded-t`} style={{ height: `${h}%` }} />
            {/* Sector median dashed reference */}
            <div
              className="absolute left-0 right-0 border-t border-dashed border-ink-muted"
              style={{ bottom: `${(median / max) * 100}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

export default FinancialRatiosPage;
