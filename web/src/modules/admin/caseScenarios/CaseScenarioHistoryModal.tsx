// Audit log modal for a single case scenario. Shows the append-only
// history with one row per mutation (create / update / activate /
// archive / restore) + an expandable diff preview.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { Badge, Button, type BadgeTone } from '@/components/ui';
import {
  api,
  type CaseScenarioHistoryAction,
  type CaseScenarioRow,
} from '@/lib/api';

const ACTION_TONE: Record<CaseScenarioHistoryAction, BadgeTone> = {
  create: 'blue',
  update: 'neutral',
  activate: 'success',
  archive: 'warning',
  restore: 'success',
};

interface Props {
  scenario: CaseScenarioRow;
  onClose: () => void;
}

export function CaseScenarioHistoryModal({ scenario, onClose }: Props) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const historyQ = useQuery({
    queryKey: ['case-scenario-history', scenario.scenario_id],
    queryFn: () => api.caseScenarioHistory(scenario.scenario_id, { page_size: 200 }),
  });

  return (
    <div
      role="dialog"
      aria-label={`History — ${scenario.name}`}
      data-testid="case-scenario-history-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <h3 className="text-base font-semibold">
            History — <span className="font-normal text-muted">{scenario.name}</span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 p-4 text-sm">
          {historyQ.isLoading && <p className="text-muted">Loading history…</p>}
          {historyQ.isError && (
            <p className="text-rose-700" role="alert">
              Failed to load history: {(historyQ.error as Error)?.message}
            </p>
          )}
          {historyQ.data?.items.length === 0 && (
            <p className="italic text-muted">No history entries yet.</p>
          )}
          <ol className="space-y-2">
            {historyQ.data?.items.map((entry) => {
              const isOpen = expanded[entry.history_id] ?? false;
              return (
                <li
                  key={entry.history_id}
                  className="rounded border border-slate-200 p-2"
                  data-testid={`cs-history-entry-${entry.history_id}`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [entry.history_id]: !isOpen }))
                    }
                    className="flex w-full items-center gap-2 text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />
                    )}
                    <Badge tone={ACTION_TONE[entry.action]} className="text-2xs uppercase">
                      {entry.action}
                    </Badge>
                    <span className="text-2xs text-muted">
                      {new Date(entry.performed_at).toLocaleString()} · by{' '}
                      <span className="font-medium text-slate-700">{entry.performed_by}</span>
                    </span>
                    <span className="ml-auto text-2xs text-muted">
                      {entry.diff.length} change{entry.diff.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                      {entry.diff.length === 0 ? (
                        <p className="text-2xs italic text-muted">
                          No tracked field changes (status-only transition).
                        </p>
                      ) : (
                        <ul className="space-y-0.5 font-mono text-2xs">
                          {entry.diff.map((op, i) => (
                            <li key={i}>
                              <span
                                className={
                                  op.op === 'add'
                                    ? 'text-emerald-700'
                                    : op.op === 'remove'
                                      ? 'text-rose-700'
                                      : 'text-blue-700'
                                }
                              >
                                {op.op}
                              </span>{' '}
                              <span className="text-slate-700">{op.path}</span>
                              {op.op !== 'remove' && (
                                <span className="text-slate-500">
                                  {' = '}
                                  {JSON.stringify(op.value)}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="sticky bottom-0 flex justify-end border-t border-slate-200 bg-white px-4 py-3">
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
