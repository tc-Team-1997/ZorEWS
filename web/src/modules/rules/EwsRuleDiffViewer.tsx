import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, X } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import {
  rulesPlusApi,
  type RuleDiffEntry,
  type RuleVersionSnapshot,
} from './rulesPlusApi';

interface Props {
  ruleId: string;
  /** Initial "from" version. Defaults to the second-newest. */
  initialFrom?: string;
  /** Initial "to" version. Defaults to the newest. */
  initialTo?: string;
  onClose: () => void;
}

export function EwsRuleDiffViewer({ ruleId, initialFrom, initialTo, onClose }: Props) {
  const versionsQ = useQuery({
    queryKey: ['ews-rule-versions', ruleId],
    queryFn: () => rulesPlusApi.versions(ruleId),
  });

  const [from, setFrom] = useState<string>(initialFrom ?? '');
  const [to, setTo] = useState<string>(initialTo ?? '');

  // Default selection once versions load: most recent → previous.
  useEffect(() => {
    if (!versionsQ.data || from || to) return;
    const items = versionsQ.data.items;
    if (items.length >= 2) {
      setTo(items[0]!.semver);
      setFrom(items[1]!.semver);
    } else if (items.length === 1) {
      setTo(items[0]!.semver);
      setFrom(items[0]!.semver);
    }
  }, [versionsQ.data, from, to]);

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const diffQ = useQuery({
    queryKey: ['ews-rule-diff', ruleId, from, to],
    queryFn: () => rulesPlusApi.diff(ruleId, from, to),
    enabled: !!from && !!to && from !== to,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 p-3">
          <h2 className="text-base font-semibold">Diff Viewer — {ruleId}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={14} />
          </Button>
        </div>
        <div className="p-3 space-y-3">
          <VersionSelector
            label="From"
            value={from}
            options={versionsQ.data?.items ?? []}
            onChange={setFrom}
          />
          <div className="text-center text-xs text-slate-400">
            <ArrowRight size={14} className="inline" />
          </div>
          <VersionSelector
            label="To"
            value={to}
            options={versionsQ.data?.items ?? []}
            onChange={setTo}
          />

          <Panel title="Changes">
            {versionsQ.isLoading ? (
              <div className="text-sm text-slate-500">Loading versions…</div>
            ) : (versionsQ.data?.items.length ?? 0) === 0 ? (
              <div className="text-sm text-slate-500">No version snapshots recorded yet.</div>
            ) : from === to ? (
              <div className="text-sm text-slate-500">
                Pick two different versions to see the diff.
              </div>
            ) : diffQ.isLoading ? (
              <div className="text-sm text-slate-500">Computing diff…</div>
            ) : diffQ.isError ? (
              <div className="text-sm text-rose-700">Diff failed.</div>
            ) : diffQ.data && diffQ.data.diff.length === 0 ? (
              <div className="text-sm text-emerald-700">
                No changes between {from} and {to} — bodies are identical.
              </div>
            ) : (
              <DiffList rows={diffQ.data?.diff ?? []} />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function VersionSelector({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: RuleVersionSnapshot[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="font-semibold uppercase text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm font-mono"
      >
        <option value="">— pick a version —</option>
        {options.map((v) => (
          <option key={v.version_id} value={v.semver}>
            {v.semver} · by {v.created_by} · {new Date(v.created_at).toLocaleString()}
          </option>
        ))}
      </select>
    </label>
  );
}

function DiffList({ rows }: { rows: RuleDiffEntry[] }) {
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div
          key={r.field}
          className="rounded border border-slate-200 bg-slate-50 p-2 text-xs"
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono font-semibold">{r.field}</span>
            <Badge tone={r.kind === 'changed' ? 'warning' : r.kind === 'added' ? 'success' : 'danger'}>
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
  );
}
