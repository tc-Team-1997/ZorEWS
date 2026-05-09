// Routable EWS Rule diff page — `/rules/ews/:rule_id/diff?from=&to=`.
//
// Replaces the old modal `EwsRuleDiffViewer`. The full route is
// shareable via the `from` + `to` query params, supports a Swap
// button + a "Revert to From" admin action with confirm modal, and
// renders a side-by-side JSON view alongside the field-level diff.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, ChevronLeft, RotateCcw, AlertTriangle } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  rulesPlusApi,
  type RuleDiffEntry,
  type RuleVersionSnapshot,
} from './rulesPlusApi';
import { useAuth } from '@/store/auth';

// ── SemVer helpers (mirror the BFF's compareSemver) ────────────────────

function parseSemver(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i++) {
    if (A[i] < B[i]) return -1;
    if (A[i] > B[i]) return 1;
  }
  return 0;
}

// ── Page ───────────────────────────────────────────────────────────────

export function EwsRuleDiffPage() {
  const { rule_id = '' } = useParams<{ rule_id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuth((s) => s.user);
  const roles = user?.roles ?? [];
  const canRevert = roles.some((r) => r === 'admin' || r === 'supervisor');

  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');

  const versionsQ = useQuery({
    queryKey: ['ews-rule-versions', rule_id],
    queryFn: () => rulesPlusApi.versions(rule_id),
    enabled: !!rule_id,
  });

  // Default selection — newest at "to", second-newest at "from".
  useEffect(() => {
    if (!versionsQ.data) return;
    if (fromParam && toParam) return;
    const items = versionsQ.data.items;
    if (items.length === 0) return;
    const sp = new URLSearchParams(searchParams);
    if (!toParam) sp.set('to', items[0].semver);
    if (!fromParam) sp.set('from', items[Math.min(1, items.length - 1)].semver);
    setSearchParams(sp, { replace: true });
  }, [versionsQ.data, fromParam, toParam, searchParams, setSearchParams]);

  const setFromTo = (next: { from?: string; to?: string }) => {
    const sp = new URLSearchParams(searchParams);
    if (next.from !== undefined) sp.set('from', next.from);
    if (next.to !== undefined) sp.set('to', next.to);
    setSearchParams(sp, { replace: true });
  };

  const swap = () => {
    if (!fromParam || !toParam) return;
    setFromTo({ from: toParam, to: fromParam });
  };

  const diffQ = useQuery({
    queryKey: ['ews-rule-diff', rule_id, fromParam, toParam],
    queryFn: () => rulesPlusApi.diffWithSnapshots(rule_id, fromParam!, toParam!),
    enabled: !!rule_id && !!fromParam && !!toParam && fromParam !== toParam,
  });

  // ── Revert flow ──────────────────────────────────────────────────────

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revertReason, setRevertReason] = useState('');
  const revertMut = useMutation({
    mutationFn: () => rulesPlusApi.revert(rule_id, fromParam!, revertReason || undefined),
    onSuccess: (snap) => {
      // Invalidate so the dropdowns re-fetch with the new version
      void qc.invalidateQueries({ queryKey: ['ews-rule-versions', rule_id] });
      // Move "to" to the new version, keep "from" at the original target
      setSearchParams(
        (sp) => {
          const next = new URLSearchParams(sp);
          next.set('to', snap.semver);
          return next;
        },
        { replace: true },
      );
      setConfirmOpen(false);
      setRevertReason('');
    },
  });

  // ── Derived state ────────────────────────────────────────────────────

  const items = versionsQ.data?.items ?? [];
  const fromSnap = diffQ.data?.from_snapshot;
  const toSnap = diffQ.data?.to_snapshot;
  const reversed = useMemo(() => {
    if (!fromParam || !toParam) return false;
    return compareSemver(fromParam, toParam) >= 0;
  }, [fromParam, toParam]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <Button variant="ghost" onClick={() => navigate('/rules/ews')}>
          <ChevronLeft size={14} /> Back to rules
        </Button>
      </div>

      <PageHeader
        title={`Diff Viewer — ${rule_id}`}
        subtitle="Compare any two SemVer snapshots; admins can revert to a prior version."
      />

      <Panel>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end">
          <div className="md:col-span-5">
            <VersionSelector
              label="From version"
              testId="diff-from"
              value={fromParam ?? ''}
              options={items}
              onChange={(v) => setFromTo({ from: v })}
            />
          </div>
          <div className="md:col-span-2 flex justify-center">
            <Button
              variant="ghost"
              data-testid="diff-swap"
              aria-label="Swap From and To"
              onClick={swap}
              disabled={!fromParam || !toParam}
            >
              <ArrowLeftRight size={14} /> Swap
            </Button>
          </div>
          <div className="md:col-span-5">
            <VersionSelector
              label="To version"
              testId="diff-to"
              value={toParam ?? ''}
              options={items}
              onChange={(v) => setFromTo({ to: v })}
            />
          </div>
        </div>

        {reversed && (
          <div
            role="alert"
            data-testid="diff-reversed-warning"
            className="mt-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <AlertTriangle size={14} />
            From version (<span className="font-mono">{fromParam}</span>) is at or
            after To (<span className="font-mono">{toParam}</span>) — you may be
            reading the diff backwards. Use Swap to flip them.
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canRevert && fromParam && (
            <Button
              data-testid="diff-revert"
              onClick={() => setConfirmOpen(true)}
              disabled={!fromParam || revertMut.isPending}
            >
              <RotateCcw size={14} /> Revert to From (v{fromParam})
            </Button>
          )}
          <Link
            to={`/rules/ews`}
            className="text-xs text-slate-500 hover:text-slate-700 ml-auto"
          >
            Open rule in editor →
          </Link>
        </div>
      </Panel>

      {/* ── Header strips ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <VersionHeaderStrip side="from" snapshot={fromSnap} fallbackSemver={fromParam} />
        <VersionHeaderStrip side="to" snapshot={toSnap} fallbackSemver={toParam} />
      </div>

      {/* ── Diff body ────────────────────────────────────────────── */}
      <Panel title="Changes">
        {versionsQ.isLoading ? (
          <p className="py-6 text-center text-sm text-slate-500">Loading versions…</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No version snapshots recorded for this rule yet.
          </p>
        ) : !fromParam || !toParam ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Pick both versions to compare.
          </p>
        ) : fromParam === toParam ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Pick two different versions to see the diff.
          </p>
        ) : diffQ.isLoading ? (
          <p className="py-6 text-center text-sm text-slate-500">Computing diff…</p>
        ) : diffQ.isError ? (
          <p className="py-6 text-center text-sm text-rose-700" role="alert">
            Failed to load diff: {(diffQ.error as Error)?.message}
          </p>
        ) : diffQ.data && diffQ.data.diff.length === 0 ? (
          <p className="py-6 text-center text-sm text-emerald-700">
            No changes between {fromParam} and {toParam} — bodies are identical.
          </p>
        ) : (
          <DiffBody
            diff={diffQ.data!.diff}
            fromSnap={fromSnap?.snapshot as Record<string, unknown> | undefined}
            toSnap={toSnap?.snapshot as Record<string, unknown> | undefined}
          />
        )}
      </Panel>

      {/* ── Revert confirmation modal ───────────────────────────────── */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="revert-confirm-modal"
        >
          <div className="w-full max-w-md rounded-md bg-white p-4 shadow-xl">
            <h3 className="mb-2 text-base font-semibold text-rose-700">
              Revert {rule_id} to v{fromParam}?
            </h3>
            <p className="mb-3 text-sm text-slate-600">
              This creates a new version whose body is identical to v
              {fromParam}. The action is recorded in the admin audit log
              and is reversible only by another revert.
            </p>
            <label className="block text-xs">
              <span className="font-semibold uppercase text-slate-500">Reason (optional)</span>
              <textarea
                value={revertReason}
                onChange={(e) => setRevertReason(e.target.value)}
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
                rows={3}
                placeholder="e.g. production caused regression — rollback"
              />
            </label>
            {revertMut.isError && (
              <div role="alert" className="mt-2 text-xs text-rose-700">
                {(revertMut.error as Error)?.message ?? 'Revert failed.'}
              </div>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                data-testid="revert-cancel"
                onClick={() => setConfirmOpen(false)}
                disabled={revertMut.isPending}
              >
                Cancel
              </Button>
              <Button
                data-testid="revert-confirm"
                onClick={() => revertMut.mutate()}
                disabled={revertMut.isPending}
              >
                Revert
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function VersionSelector({
  label,
  testId,
  value,
  options,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  options: RuleVersionSnapshot[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="font-semibold uppercase text-slate-500">{label}</span>
      <select
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm font-mono"
      >
        <option value="">— pick a version —</option>
        {options.map((v) => (
          <option key={v.version_id} value={v.semver}>
            v{v.semver} · by {v.created_by} · {new Date(v.created_at).toLocaleDateString()}
          </option>
        ))}
      </select>
    </label>
  );
}

function VersionHeaderStrip({
  side,
  snapshot,
  fallbackSemver,
}: {
  side: 'from' | 'to';
  snapshot?: RuleVersionSnapshot;
  fallbackSemver: string | null;
}) {
  const sideLabel = side === 'from' ? 'From' : 'To';
  const tone = side === 'from' ? 'danger' : 'success';
  return (
    <Panel title={sideLabel}>
      <div className="flex items-baseline gap-2 text-sm" data-testid={`diff-header-${side}`}>
        <Badge tone={tone as never}>v{snapshot?.semver ?? fallbackSemver ?? '—'}</Badge>
        {snapshot && (
          <span className="text-xs text-slate-500">
            by{' '}
            <span className="font-medium text-slate-700">{snapshot.created_by}</span>
            {' · '}
            {new Date(snapshot.created_at).toLocaleString()}
          </span>
        )}
      </div>
      {snapshot?.reason && (
        <p className="mt-1 text-xs italic text-slate-600">"{snapshot.reason}"</p>
      )}
    </Panel>
  );
}

function DiffBody({
  diff,
  fromSnap,
  toSnap,
}: {
  diff: RuleDiffEntry[];
  fromSnap?: Record<string, unknown>;
  toSnap?: Record<string, unknown>;
}) {
  return (
    <div className="space-y-4" data-testid="diff-body">
      {/* Field-level diff list */}
      <div className="space-y-2">
        {diff.map((r) => (
          <div
            key={r.field}
            className="rounded border border-slate-200 bg-slate-50 p-2 text-xs"
            data-testid={`diff-field-${r.field}`}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono font-semibold">{r.field}</span>
              <Badge
                tone={
                  r.kind === 'changed' ? 'warning' : r.kind === 'added' ? 'success' : 'danger'
                }
              >
                {r.kind}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <pre className="overflow-x-auto rounded bg-rose-50 p-1 text-rose-800">
                {JSON.stringify(r.before, null, 2)}
              </pre>
              <pre className="overflow-x-auto rounded bg-emerald-50 p-1 text-emerald-800">
                {JSON.stringify(r.after, null, 2)}
              </pre>
            </div>
          </div>
        ))}
      </div>

      {/* Side-by-side full JSON snapshots */}
      {(fromSnap || toSnap) && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">
            Full snapshots (side-by-side)
          </h4>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <pre
              data-testid="diff-snapshot-from"
              className="max-h-96 overflow-auto rounded border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-900"
            >
              {fromSnap ? JSON.stringify(fromSnap, null, 2) : '(missing)'}
            </pre>
            <pre
              data-testid="diff-snapshot-to"
              className="max-h-96 overflow-auto rounded border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900"
            >
              {toSnap ? JSON.stringify(toSnap, null, 2) : '(missing)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
