import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, AlertTriangle, Clock } from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  KANBAN_COLUMNS,
  PRIORITY_TONE,
  QUICK_TRANSITIONS,
  cmsApi,
  type CmsCase,
  type CmsCaseState,
} from './api';

export function CmsCaseKanbanPage() {
  const qc = useQueryClient();

  const listQ = useQuery({
    queryKey: ['cms-cases', 'kanban'],
    queryFn: () => cmsApi.list({}),
  });

  const transitionMut = useMutation({
    mutationFn: ({ case_id, target }: { case_id: string; target: CmsCaseState }) =>
      cmsApi.transition(case_id, target),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cms-cases'] }),
  });

  const items = listQ.data?.items ?? [];
  const grouped = useMemo(() => {
    const map: Record<CmsCaseState, CmsCase[]> = {
      OPEN: [],
      ASSIGNED: [],
      INVESTIGATING: [],
      PENDING_APPROVAL: [],
      ESCALATED: [],
      CLOSED: [],
      REOPENED: [],
    };
    for (const c of items) map[c.status].push(c);
    return map;
  }, [items]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Case Kanban"
        subtitle="Click a quick-action arrow on a card to transition. Closed cases are read-only."
        actions={
          <Link to="/cms/cases">
            <Button variant="ghost">List view</Button>
          </Link>
        }
      />
      <div className="overflow-x-auto">
        <div className="flex gap-3 min-w-max">
          {KANBAN_COLUMNS.map((col) => (
            <div key={col} className="w-80 flex-shrink-0">
              <Panel title={`${col} (${grouped[col].length})`}>
                <div className="space-y-2 max-h-[70vh] overflow-y-auto">
                  {grouped[col].length === 0 ? (
                    <div className="text-xs text-slate-400 italic">empty</div>
                  ) : (
                    grouped[col].map((c) => (
                      <CaseCard
                        key={c.case_id}
                        c={c}
                        onTransition={(target) =>
                          transitionMut.mutate({ case_id: c.case_id, target })
                        }
                        disabled={transitionMut.isPending}
                      />
                    ))
                  )}
                </div>
              </Panel>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CaseCard({
  c,
  onTransition,
  disabled,
}: {
  c: CmsCase;
  onTransition: (target: CmsCaseState) => void;
  disabled: boolean;
}) {
  const targets = QUICK_TRANSITIONS[c.status] ?? [];
  const slaBreached =
    c.status !== 'CLOSED' && Date.now() >= new Date(c.sla_due_at).getTime();
  const slaWarning =
    c.status !== 'CLOSED' &&
    !slaBreached &&
    progressPct(new Date(c.created_at), new Date(c.sla_due_at), Date.now()) >= 80;

  return (
    <div className="rounded-md border border-slate-200 bg-white p-2 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/cms/cases/${c.case_id}`}
          className="font-mono text-xs text-blue-600 hover:underline"
        >
          {c.case_number}
        </Link>
        <Badge tone={PRIORITY_TONE[c.priority] as never}>{c.priority}</Badge>
      </div>
      <div className="mt-1 text-sm font-medium leading-snug">{c.title}</div>
      <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
        {c.assigned_to ? <span>👤 {c.assigned_to}</span> : <span className="italic">unassigned</span>}
        {slaBreached ? (
          <span className="ml-2 inline-flex items-center gap-1 text-rose-600">
            <AlertTriangle size={11} /> SLA breached
          </span>
        ) : slaWarning ? (
          <span className="ml-2 inline-flex items-center gap-1 text-amber-600">
            <Clock size={11} /> SLA warn
          </span>
        ) : null}
      </div>
      {targets.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {targets.map((t) => (
            <button
              key={t}
              disabled={disabled}
              onClick={() => onTransition(t)}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-50 px-2 py-0.5 text-xs hover:bg-blue-50 disabled:opacity-50"
            >
              <ArrowRight size={10} /> {t}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function progressPct(created: Date, due: Date, now: number): number {
  const total = due.getTime() - created.getTime();
  if (total <= 0) return 100;
  const elapsed = now - created.getTime();
  return Math.max(0, Math.round((elapsed / total) * 100));
}
