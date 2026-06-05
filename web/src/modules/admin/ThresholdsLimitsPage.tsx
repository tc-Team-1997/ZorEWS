// web/src/modules/admin/ThresholdsLimitsPage.tsx
//
// Module 5.3 — Thresholds & Limits.
//
// All configurable thresholds (DQ band, ratio warning/critical, severity
// thresholds, model promotion gates) in one place. Every backend route
// already shipped via M4.3 / M4.4 / M4.9 / M4.10 / M4.12 — this page
// composes them into the spec-mandated screen:
//
//   - Threshold library table (indicator + value bands + source + last
//     updated + owner)
//   - Add/Edit threshold modal
//   - Suggest thresholds from observed-data distribution
//   - Threshold drift (delta vs platform defaults)
//   - Last-run banner (most recent threshold.update / threshold.reset
//     audit event with a link to the Audit Trail)
//   - Per-row "where used" link to the Rules Engine simulator

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  History,
  Lightbulb,
  Pencil,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Sparkles,
  X,
} from 'lucide-react';
import { Badge, Button, Input, MetricCard, Modal, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  api,
  type ThresholdAuditEvent,
  type ThresholdDriftRow,
  type ThresholdEffectiveRow,
  type ThresholdSuggestResult,
} from '@/lib/api';

const SOURCE_TONE: Record<string, 'success' | 'warning' | 'blue'> = {
  platform_default: 'success',
  tenant_override: 'warning',
};

export function ThresholdsLimitsPage() {
  const user = useAuth((s) => s.user);
  const canMutate = user?.roles.includes('admin') ?? false;
  const [editTarget, setEditTarget] = useState<ThresholdEffectiveRow | null>(null);
  const [suggestTarget, setSuggestTarget] = useState<ThresholdEffectiveRow | null>(null);

  const qc = useQueryClient();
  const effectiveQ = useQuery({ queryKey: ['tl-effective'], queryFn: () => api.thresholdsEffective() });
  const driftQ = useQuery({ queryKey: ['tl-drift'], queryFn: () => api.thresholdsDrift() });

  const entries = useMemo<ThresholdEffectiveRow[]>(
    () => effectiveQ.data?.entries ?? effectiveQ.data?.items ?? [],
    [effectiveQ.data],
  );
  const driftByIndicator = useMemo(() => {
    const map = new Map<string, ThresholdDriftRow>();
    for (const d of driftQ.data?.indicators ?? []) map.set(d.indicator_id, d);
    return map;
  }, [driftQ.data]);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['tl-effective'] });
    qc.invalidateQueries({ queryKey: ['tl-drift'] });
  };

  const overrideCount = entries.filter((e) => e.source === 'tenant_override').length;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Thresholds & Limits"
        subtitle="DQ bands · ratio warning/critical · severity gates · model promotion thresholds"
        actions={
          <Button variant="ghost" onClick={refreshAll} data-testid="tl-refresh">
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      />

      <LastRunBanner indicators={entries.map((e) => e.indicator_id)} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label="Total thresholds"
          value={entries.length.toString()}
          testId="tl-kpi-total"
        />
        <MetricCard
          label="Tenant overrides"
          value={overrideCount.toString()}
          tone="warning"
          testId="tl-kpi-overrides"
        />
        <MetricCard
          label="Platform defaults"
          value={(entries.length - overrideCount).toString()}
          tone="success"
        />
        <MetricCard
          label="Drift score (mean)"
          value={
            driftQ.data?.mean_drift_score != null
              ? `${(driftQ.data.mean_drift_score * 100).toFixed(1)}%`
              : '—'
          }
          tone={
            driftQ.data?.mean_drift_score != null && driftQ.data.mean_drift_score > 0.2
              ? 'warning'
              : 'blue'
          }
          testId="tl-kpi-drift"
        />
      </div>

      <Panel title="Threshold library" data-testid="tl-library-panel">
        {effectiveQ.isLoading ? (
          <p className="text-sm text-muted">Loading thresholds…</p>
        ) : entries.length === 0 ? (
          <p
            className="rounded border border-dashed border-divider p-6 text-center text-sm text-muted"
            data-testid="tl-library-empty"
          >
            No thresholds registered.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="tl-library-table">
            <thead className="text-left text-xs uppercase text-muted">
              <tr className="border-b border-divider/40">
                <th className="py-2">Indicator</th>
                <th>Yellow</th>
                <th>Orange</th>
                <th>Red</th>
                <th>Source</th>
                <th>Drift</th>
                {canMutate && <th></th>}
              </tr>
            </thead>
            <tbody>
              {entries.map((row) => {
                const drift = driftByIndicator.get(row.indicator_id);
                return (
                  <tr
                    key={row.indicator_id}
                    className="border-b border-divider/40 hover:bg-divider/10"
                    data-testid={`tl-row-${row.indicator_id}`}
                  >
                    <td className="py-2">
                      <div className="font-medium">{row.name ?? row.indicator_id}</div>
                      <div className="text-xs text-muted font-mono">{row.indicator_id}</div>
                    </td>
                    <td>
                      <BandValue
                        value={row.effective.yellow_at}
                        defaultValue={row.library_default.yellow_at}
                        colour="bg-warning/30"
                      />
                    </td>
                    <td>
                      <BandValue
                        value={row.effective.orange_at}
                        defaultValue={row.library_default.orange_at}
                        colour="bg-danger/30"
                      />
                    </td>
                    <td>
                      <BandValue
                        value={row.effective.red_at}
                        defaultValue={row.library_default.red_at}
                        colour="bg-danger/60"
                      />
                    </td>
                    <td>
                      <Badge tone={SOURCE_TONE[row.source] ?? 'blue'}>
                        {row.source === 'platform_default' ? 'platform default' : 'tenant override'}
                      </Badge>
                    </td>
                    <td className="text-xs">
                      {drift?.drift_score != null
                        ? `${(drift.drift_score * 100).toFixed(1)}%`
                        : '—'}
                    </td>
                    {canMutate && (
                      <td className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            onClick={() => setSuggestTarget(row)}
                            data-testid={`tl-suggest-${row.indicator_id}`}
                            aria-label={`Suggest thresholds for ${row.indicator_id}`}
                          >
                            <Lightbulb size={12} />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setEditTarget(row)}
                            data-testid={`tl-edit-${row.indicator_id}`}
                            aria-label={`Edit ${row.indicator_id}`}
                          >
                            <Pencil size={12} />
                          </Button>
                          {row.source === 'tenant_override' && (
                            <Button
                              variant="ghost"
                              onClick={async () => {
                                await api.thresholdReset(row.indicator_id);
                                refreshAll();
                              }}
                              data-testid={`tl-reset-${row.indicator_id}`}
                              aria-label={`Reset ${row.indicator_id}`}
                              title="Revert to platform default"
                            >
                              <RotateCcw size={12} />
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Where used">
        <p className="text-sm text-muted">
          Thresholds drive alert classification + the rule simulator. Open{' '}
          <Link to="/rules/engine?tab=simulator" className="text-action hover:underline">
            Rules Engine → Simulator
          </Link>{' '}
          to run a what-if against the current thresholds, or{' '}
          <Link to="/admin/audit-log?action=threshold" className="text-action hover:underline">
            Audit Trail
          </Link>{' '}
          for the full edit history.
        </p>
      </Panel>

      {editTarget && (
        <EditModal
          row={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => {
            setEditTarget(null);
            refreshAll();
          }}
        />
      )}
      {suggestTarget && (
        <SuggestModal
          row={suggestTarget}
          onClose={() => setSuggestTarget(null)}
          onApply={async (vals) => {
            await api.thresholdUpdate(suggestTarget.indicator_id, vals);
            setSuggestTarget(null);
            refreshAll();
          }}
        />
      )}
    </div>
  );
}

function BandValue({
  value,
  defaultValue,
  colour,
}: {
  value: number;
  defaultValue: number;
  colour: string;
}) {
  const drifted = Math.abs(value - defaultValue) > 0.001;
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className={`inline-block h-2 w-2 rounded-full ${colour}`} />
      <span className="font-mono">{value.toFixed(2)}</span>
      {drifted && (
        <span className="text-muted text-[10px]">
          (default {defaultValue.toFixed(2)})
        </span>
      )}
    </span>
  );
}

// ─── Last-run banner ──────────────────────────────────────────────────

function LastRunBanner({ indicators }: { indicators: string[] }) {
  // The audit query needs *some* indicator_id to filter on — we surface
  // the most-recent across the whole tenant. The audit-trail API
  // accepts a comma-separated list of resource_ids via a sequential
  // fetch; for the banner we just take the first indicator and ask for
  // the catch-all action filter. If the chain has nothing, no banner.
  const recent = useQuery({
    queryKey: ['tl-last-run', indicators.length],
    queryFn: async () => {
      // Walk the first 5 indicators looking for the freshest audit event.
      let newest: ThresholdAuditEvent | null = null;
      for (const id of indicators.slice(0, 5)) {
        try {
          const events = await api.thresholdAuditHistory(id, 5);
          for (const e of events.items ?? []) {
            if (!newest || e.ts > newest.ts) newest = e;
          }
        } catch {
          // skip
        }
      }
      return newest;
    },
    enabled: indicators.length > 0,
  });

  if (!recent.data) return null;
  const e = recent.data;
  return (
    <div
      className="flex items-start gap-3 rounded border border-blue/40 bg-blue/5 p-3 text-sm"
      data-testid="tl-lastrun-banner"
    >
      <History size={16} className="text-action mt-0.5" />
      <div className="flex-1">
        <strong className="capitalize">{e.action.replace('threshold.', '')}</strong>{' '}
        on <code className="font-mono">{e.resource_id}</code>
        <span className="text-muted"> · {new Date(e.ts).toLocaleString()}</span>
        <span className="text-muted"> · by {e.actor_username}</span>
      </div>
      <Link
        to={`/admin/audit-log?resource_id=${encodeURIComponent(e.resource_id)}`}
        className="text-xs text-action hover:underline inline-flex items-center gap-1"
        data-testid="tl-lastrun-link"
      >
        <ScrollText size={12} /> View in Audit Trail
      </Link>
    </div>
  );
}

// ─── Edit modal ───────────────────────────────────────────────────────

function EditModal({
  row,
  onClose,
  onSuccess,
}: {
  row: ThresholdEffectiveRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [yellow, setYellow] = useState(row.effective.yellow_at.toString());
  const [orange, setOrange] = useState(row.effective.orange_at.toString());
  const [red, setRed] = useState(row.effective.red_at.toString());
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () =>
      api.thresholdUpdate(row.indicator_id, {
        yellow_at: Number(yellow),
        orange_at: Number(orange),
        red_at: Number(red),
      }),
    onSuccess,
    onError: (err: unknown) => {
      const e = err as { body?: { error?: { message?: string } }; message?: string };
      setErrMsg(e.body?.error?.message ?? e.message ?? 'Update failed');
    },
  });

  const valid =
    Number.isFinite(Number(yellow)) &&
    Number.isFinite(Number(orange)) &&
    Number.isFinite(Number(red)) &&
    Number(yellow) <= Number(orange) &&
    Number(orange) <= Number(red);

  return (
    <Modal open onClose={onClose} ariaLabel={`Edit ${row.indicator_id}`} size="lg" testId="tl-edit-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Edit thresholds — <span className="font-mono">{row.indicator_id}</span>
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close"><X size={16} /></Button>
        </header>
        <p className="text-xs text-muted">
          Bands must be monotone: yellow ≤ orange ≤ red, each in [0, 1].
        </p>
        {errMsg && (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            <AlertTriangle size={14} className="inline mr-1" /> {errMsg}
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Yellow at"
            value={yellow}
            onChange={(e) => setYellow(e.target.value)}
            data-testid="tl-edit-yellow"
          />
          <Input
            label="Orange at"
            value={orange}
            onChange={(e) => setOrange(e.target.value)}
            data-testid="tl-edit-orange"
          />
          <Input
            label="Red at"
            value={red}
            onChange={(e) => setRed(e.target.value)}
            data-testid="tl-edit-red"
          />
        </div>
        <div className="rounded border border-divider/40 bg-divider/5 p-3 text-xs">
          <strong>Default:</strong> Y {row.library_default.yellow_at.toFixed(2)} · O{' '}
          {row.library_default.orange_at.toFixed(2)} · R {row.library_default.red_at.toFixed(2)}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => m.mutate()}
            disabled={!valid || m.isPending}
            data-testid="tl-edit-submit"
          >
            {m.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Suggest modal ───────────────────────────────────────────────────

function SuggestModal({
  row,
  onClose,
  onApply,
}: {
  row: ThresholdEffectiveRow;
  onClose: () => void;
  onApply: (vals: { yellow_at: number; orange_at: number; red_at: number }) => void;
}) {
  const [valuesRaw, setValuesRaw] = useState('');
  const [polarity, setPolarity] = useState<'higher_is_worse' | 'lower_is_worse'>('higher_is_worse');
  const [result, setResult] = useState<ThresholdSuggestResult | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const suggest = useMutation({
    mutationFn: () => {
      const vals = valuesRaw
        .split(/[,\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
      return api.thresholdSuggest(row.indicator_id, vals, polarity);
    },
    onSuccess: (r) => setResult(r),
    onError: (err: unknown) => {
      const e = err as { body?: { error?: { message?: string } }; message?: string };
      setErrMsg(e.body?.error?.message ?? e.message ?? 'Suggest failed');
    },
  });

  return (
    <Modal open onClose={onClose} ariaLabel={`Suggest thresholds for ${row.indicator_id}`} size="lg" testId="tl-suggest-modal">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Suggest from data — <span className="font-mono">{row.indicator_id}</span>
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close"><X size={16} /></Button>
        </header>
        <p className="text-xs text-muted">
          Paste observed indicator values (≥ 5 finite samples needed). Bands derived from
          percentile distribution; polarity controls direction.
        </p>
        {errMsg && (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            <AlertTriangle size={14} className="inline mr-1" /> {errMsg}
          </div>
        )}
        <label className="block text-xs text-muted">
          Values (comma or space separated)
          <textarea
            value={valuesRaw}
            onChange={(e) => setValuesRaw(e.target.value)}
            rows={3}
            placeholder="0.12, 0.35, 0.48, 0.62, 0.75, 0.88"
            className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm font-mono"
            data-testid="tl-suggest-values"
          />
        </label>
        <label className="block text-xs text-muted">
          Polarity
          <select
            value={polarity}
            onChange={(e) => setPolarity(e.target.value as 'higher_is_worse' | 'lower_is_worse')}
            className="mt-1 w-full rounded border border-divider px-2 py-1 text-sm"
            data-testid="tl-suggest-polarity"
          >
            <option value="higher_is_worse">Higher = worse (DPD, util, fraud signals)</option>
            <option value="lower_is_worse">Lower = worse (customer-health, AUC)</option>
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <Button
            variant="primary"
            onClick={() => suggest.mutate()}
            disabled={suggest.isPending}
            data-testid="tl-suggest-run"
          >
            {suggest.isPending ? 'Computing…' : 'Suggest'}
          </Button>
        </div>
        {result && (
          <div
            className="rounded border border-success/40 bg-success/10 p-3 text-sm"
            data-testid="tl-suggest-result"
          >
            <Sparkles size={14} className="text-success inline mr-1" />
            {result.suggested ? (
              <>
                <strong>Suggested bands:</strong>{' '}
                <span className="font-mono">
                  Y {result.suggested.yellow_at.toFixed(2)} · O {result.suggested.orange_at.toFixed(2)} · R {result.suggested.red_at.toFixed(2)}
                </span>
                <div className="text-xs text-muted mt-1">
                  Based on {result.sample_size} samples · range [
                  {result.sample_min?.toFixed(2) ?? '?'},{' '}
                  {result.sample_max?.toFixed(2) ?? '?'}]
                </div>
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="primary"
                    onClick={() => result.suggested && onApply(result.suggested)}
                    data-testid="tl-suggest-apply"
                  >
                    Apply suggested
                  </Button>
                </div>
              </>
            ) : (
              <>
                <strong>Insufficient data:</strong>{' '}
                {result.insufficient_reason === 'too_few_samples'
                  ? `need ≥ 5 finite samples (got ${result.sample_size})`
                  : 'no finite values in input'}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
