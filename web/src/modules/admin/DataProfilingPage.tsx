// web/src/modules/admin/DataProfilingPage.tsx
//
// Module 1.2 — Data Profiling (AI).
//
// Spec deliverables:
//   - Source selector + Column profile table (type, null%, distinct,
//     min/max, mean, p50/p95, top-5, format_detected)
//   - Distribution chart with configurable bucketing
//   - Auto-Suggested DQ Rules card (Promote / Dismiss)
//   - Schema viewer (read-only)
//   - AI-unavailable banner per cross-cutting #8
//
// Wired to:
//   GET  /v1/dq/profile/:source_id/columns
//   GET  /v1/dq/profile/:source_id/column/:col          (Module 1.2)
//   GET  /v1/dq/profile/:source_id/columns/:column/distribution
//   POST /v1/dq/profile/:source_id/suggest-rules
//   POST /v1/dq/profile/promote-rule                    (Module 1.2)

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import {
  AlertTriangle,
  BadgeCheck,
  Brain,
  CheckCircle2,
  Database,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import {
  api,
  type DqColumnProfile,
  type DqSuggestedRule,
} from '@/lib/api';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { color } from '@/styles/tokens';

const KNOWN_SOURCES = [
  { id: 'cbs_loans', label: 'CBS — Loans' },
  { id: 'cbs_repayments', label: 'CBS — Repayments' },
  { id: 'cbs_txns', label: 'CBS — Transactions' },
  { id: 'mart_customer_360', label: 'Mart — customer_360' },
  { id: 'mart_loan_360', label: 'Mart — loan_360' },
  { id: 'bureau_score', label: 'Bureau Score' },
] as const;

function formatTone(f: DqColumnProfile['format_detected']): 'success' | 'warning' | 'blue' | 'neutral' {
  if (!f) return 'neutral';
  if (f === 'pan' || f === 'gstin' || f === 'uuid' || f === 'phone_in') return 'blue';
  if (f === 'email' || f === 'iso_date' || f === 'iso_datetime') return 'success';
  return 'warning';
}

function ruleTypeTone(rt: DqSuggestedRule['rule_type']): 'success' | 'warning' | 'blue' | 'neutral' {
  if (rt === 'regex') return 'blue';
  if (rt === 'not_null') return 'success';
  if (rt === 'range') return 'warning';
  if (rt === 'enum_membership') return 'blue';
  return 'neutral';
}

function fmtNum(n: number | string | null): string {
  if (n === null || n === undefined) return '—';
  if (typeof n === 'number') {
    if (Math.abs(n) >= 100_000) return n.toLocaleString();
    if (Math.abs(n) % 1 === 0) return n.toString();
    return n.toFixed(2);
  }
  return String(n);
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export function DataProfilingPage() {
  const qc = useQueryClient();
  const [sourceId, setSourceId] = useState<string>(KNOWN_SOURCES[0].id);
  const [selectedCol, setSelectedCol] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<number>(10);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const profile = useQuery({
    queryKey: ['dq.profile', sourceId],
    queryFn: () => api.dqProfileColumns(sourceId),
  });

  // Default-select the first column whenever the source changes
  useEffect(() => {
    setSelectedCol(null);
  }, [sourceId]);
  useEffect(() => {
    if (!selectedCol && profile.data && profile.data.columns.length > 0) {
      setSelectedCol(profile.data.columns[0].column);
    }
  }, [profile.data, selectedCol]);

  const distribution = useQuery({
    queryKey: ['dq.distribution', sourceId, selectedCol, buckets],
    queryFn: () => api.dqColumnDistribution(sourceId, selectedCol!, buckets),
    enabled: !!selectedCol,
  });

  const suggestions = useQuery({
    queryKey: ['dq.suggestions', sourceId],
    queryFn: () => api.dqSuggestRules(sourceId),
  });

  const promoteMut = useMutation({
    mutationFn: (rule_id: string) => api.dqPromoteRule(rule_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dq.suggestions', sourceId] }),
  });

  const aiUnavailable = suggestions.isError;

  const visibleSuggestions = useMemo(() => {
    if (!suggestions.data) return [];
    return suggestions.data.rules.filter((r) => !dismissed.has(r.rule_id));
  }, [suggestions.data, dismissed]);

  const selectedProfile: DqColumnProfile | undefined = profile.data?.columns.find(
    (c) => c.column === selectedCol,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data Profiling"
        subtitle="Observe distribution + nulls + formats per column; AI suggests validation rules to promote into the DQ library."
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ['dq.profile', sourceId] });
              qc.invalidateQueries({ queryKey: ['dq.suggestions', sourceId] });
            }}
            data-testid="dq-refresh"
          >
            <RefreshCw className="size-4" aria-hidden /> Refresh
          </Button>
        }
      />

      {/* Source selector */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Database className="size-4 text-action" aria-hidden /> Source
          </span>
        }
        data-testid="dq-source-panel"
      >
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            data-testid="dq-source-select"
            className="rounded-input border border-divider bg-surface px-2.5 py-1.5 text-sm text-ink"
          >
            {KNOWN_SOURCES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {profile.data && (
            <span className="text-xs text-muted" data-testid="dq-rows-info">
              {profile.data.total_rows.toLocaleString()} rows · {profile.data.columns.length} columns
            </span>
          )}
        </div>
      </Panel>

      {/* AI-unavailable banner (cross-cutting #8) */}
      {aiUnavailable && (
        <div
          className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm"
          data-testid="dq-ai-unavailable-banner"
        >
          <p className="font-medium text-warning">AI unavailable</p>
          <p className="text-xs text-muted">
            The rule-suggestion engine couldn't be reached. The column profile table + distribution chart still
            work — you can manually create DQ rules in the Validation Rules library.
          </p>
        </div>
      )}

      {/* Column profile table */}
      <Panel
        title="Column profile"
        action={
          profile.data && (
            <span className="text-xs text-muted">Generated {new Date(profile.data.generated_at).toLocaleString()}</span>
          )
        }
        data-testid="dq-column-profile-panel"
      >
        {profile.isLoading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : profile.data ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="dq-column-profile-table">
              <thead className="text-2xs uppercase text-ink-subtle">
                <tr>
                  <th className="px-2 py-2">Column</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2 text-right">Null %</th>
                  <th className="px-2 py-2 text-right">Distinct</th>
                  <th className="px-2 py-2 text-right">Min</th>
                  <th className="px-2 py-2 text-right">Max</th>
                  <th className="px-2 py-2 text-right">Mean</th>
                  <th className="px-2 py-2 text-right">p50</th>
                  <th className="px-2 py-2 text-right">p95</th>
                  <th className="px-2 py-2">Format</th>
                  <th className="px-2 py-2">Top value</th>
                </tr>
              </thead>
              <tbody>
                {profile.data.columns.map((c) => (
                  <tr
                    key={c.column}
                    className={`cursor-pointer border-t border-divider hover:bg-action/5 ${
                      selectedCol === c.column ? 'bg-action/10' : ''
                    }`}
                    onClick={() => setSelectedCol(c.column)}
                    data-testid={`dq-col-row-${c.column}`}
                  >
                    <td className="px-2 py-2 font-medium text-ink">{c.column}</td>
                    <td className="px-2 py-2">
                      <Badge tone={c.type === 'enum' ? 'blue' : 'neutral'}>{c.type}</Badge>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtPct(c.null_pct)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{c.distinct_count.toLocaleString()}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(c.min)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(c.max)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(c.mean)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(c.p50)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtNum(c.p95)}</td>
                    <td className="px-2 py-2">
                      {c.format_detected ? (
                        <Badge tone={formatTone(c.format_detected)}>{c.format_detected}</Badge>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-muted truncate max-w-[180px]">
                      {c.top_values[0]?.value ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted">No profile available.</p>
        )}
      </Panel>

      {/* Distribution chart + selected column detail */}
      {selectedCol && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel
            title={
              <span className="flex items-center gap-2">
                <Sparkles className="size-4 text-action" aria-hidden /> Distribution — {selectedCol}
              </span>
            }
            action={
              <div className="flex items-center gap-2 text-xs">
                <label className="text-muted">Buckets</label>
                <select
                  value={buckets}
                  onChange={(e) => setBuckets(Number(e.target.value))}
                  data-testid="dq-buckets-select"
                  className="rounded-input border border-divider bg-surface px-1.5 py-0.5"
                >
                  {[5, 10, 20, 50].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            }
            data-testid="dq-distribution-panel"
          >
            {distribution.isLoading ? (
              <p className="py-3 text-sm text-muted">Loading…</p>
            ) : distribution.data ? (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={distribution.data.buckets}>
                    <XAxis dataKey="bucket" stroke={color.muted} fontSize={10} />
                    <YAxis stroke={color.muted} fontSize={10} />
                    <Tooltip
                      contentStyle={{
                        background: color.surface,
                        border: `1px solid ${color.divider}`,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                      {distribution.data.buckets.map((_, i) => (
                        <Cell key={i} fill={color.blue} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-muted">No distribution available.</p>
            )}
          </Panel>

          {selectedProfile && (
            <Panel title={`Top 5 values — ${selectedCol}`} data-testid="dq-top-values-panel">
              <ul className="space-y-1.5" data-testid="dq-top-values-list">
                {selectedProfile.top_values.slice(0, 5).map((v) => (
                  <li
                    key={v.value}
                    className="flex items-center justify-between rounded-md border border-divider bg-surface px-3 py-1.5 text-sm"
                  >
                    <code className="text-xs">{v.value}</code>
                    <span className="tabular-nums text-xs text-muted">
                      {v.count.toLocaleString()} · {fmtPct(v.pct)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}

      {/* AI suggestions card */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Brain className="size-4 text-action" aria-hidden /> Auto-Suggested DQ Rules
            <span className="text-xs text-muted">(AI)</span>
          </span>
        }
        action={
          <span className="text-xs text-muted">
            {visibleSuggestions.length} suggestion{visibleSuggestions.length === 1 ? '' : 's'}
          </span>
        }
        data-testid="dq-suggestions-panel"
      >
        {suggestions.isLoading ? (
          <p className="py-3 text-sm text-muted">Analyzing column profiles…</p>
        ) : aiUnavailable ? (
          <p className="text-sm text-muted">
            (AI suggestions unavailable — use the column profile + Validation Rules library to author rules manually.)
          </p>
        ) : visibleSuggestions.length === 0 ? (
          <p className="py-3 text-sm text-muted" data-testid="dq-suggestions-empty">
            No active suggestions for this source. All previously-suggested rules have been promoted or dismissed.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="dq-suggestions-list">
            {visibleSuggestions.map((r) => (
              <li
                key={r.rule_id}
                className="rounded-md border border-divider bg-surface p-3"
                data-testid={`dq-suggestion-${r.rule_id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={ruleTypeTone(r.rule_type)}>{r.rule_type}</Badge>
                      <code className="text-xs font-medium text-ink">{r.column}</code>
                      <span className="text-2xs text-muted">conf {(r.confidence * 100).toFixed(0)}%</span>
                      {r.status === 'promoted' && (
                        <Badge tone="success">
                          <CheckCircle2 className="size-3 inline mr-0.5" aria-hidden /> promoted
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted">{r.rationale}</p>
                    <pre className="mt-1 overflow-x-auto rounded bg-ink/5 px-2 py-1 text-2xs font-mono">
{JSON.stringify(r.rule_def)}
                    </pre>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => promoteMut.mutate(r.rule_id)}
                      disabled={r.status === 'promoted' || promoteMut.isPending}
                      data-testid={`dq-promote-${r.rule_id}`}
                      className="rounded-md border border-divider bg-action/10 px-2.5 py-1 text-xs font-medium text-action hover:bg-action/20 disabled:opacity-50"
                    >
                      <BadgeCheck className="size-3 inline mr-0.5" aria-hidden /> Promote
                    </button>
                    <button
                      type="button"
                      onClick={() => setDismissed((s) => new Set([...s, r.rule_id]))}
                      data-testid={`dq-dismiss-${r.rule_id}`}
                      className="rounded-md border border-divider bg-surface px-2.5 py-1 text-xs text-ink-subtle hover:bg-divider/30"
                    >
                      <X className="size-3 inline" aria-hidden /> Dismiss
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Schema viewer (read-only) */}
      {profile.data && (
        <Panel
          title="Canonical schema (read-only)"
          data-testid="dq-schema-viewer"
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {profile.data.columns.map((c) => (
              <div
                key={c.column}
                className="rounded border border-divider bg-surface px-2 py-1.5 text-xs"
                data-testid={`dq-schema-field-${c.column}`}
              >
                <code className="font-medium text-ink">{c.column}</code>
                <span className="ml-1 text-muted">{c.type}</span>
                {c.has_drift && (
                  <span className="ml-1 inline-flex items-center gap-0.5 text-warning text-2xs">
                    <AlertTriangle className="size-2.5" aria-hidden /> drift
                  </span>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
