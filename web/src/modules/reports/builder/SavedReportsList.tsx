// web/src/modules/reports/builder/SavedReportsList.tsx
//
// T4.6.5 — Left panel of the report builder. Lists saved reports
// collapsed by visibility (Private / Role-shared / Tenant-shared).
// Reuses the panel + button primitives + the role-based-visibility
// shape from T4.6.3.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Lock, Users, Globe, Trash2 } from 'lucide-react';
import { Button, Panel } from '@/components/ui';
import { cn } from '@/lib/cn';
import type {
  ReportVisibility,
  SavedReport,
} from './api';

interface Props {
  reports: SavedReport[];
  selected_id?: string | null;
  onSelect: (report: SavedReport) => void;
  onDelete?: (report: SavedReport) => void;
  onNew?: () => void;
  loading?: boolean;
  error?: string | null;
}

interface Group {
  visibility: ReportVisibility;
  label: string;
  icon: typeof Lock;
  items: SavedReport[];
}

const VISIBILITY_ORDER: readonly ReportVisibility[] = [
  'private',
  'role',
  'tenant',
];

const VISIBILITY_META: Record<ReportVisibility, { label: string; icon: typeof Lock }> = {
  private: { label: 'Private', icon: Lock },
  role: { label: 'Role-shared', icon: Users },
  tenant: { label: 'Tenant-shared', icon: Globe },
};

export function SavedReportsList({
  reports,
  selected_id,
  onSelect,
  onDelete,
  onNew,
  loading,
  error,
}: Props): JSX.Element {
  const [open, setOpen] = useState<Record<ReportVisibility, boolean>>({
    private: true,
    role: true,
    tenant: true,
  });

  const groups: Group[] = useMemo(() => {
    const byVis = new Map<ReportVisibility, SavedReport[]>();
    for (const v of VISIBILITY_ORDER) byVis.set(v, []);
    for (const r of reports) byVis.get(r.visibility)?.push(r);
    return VISIBILITY_ORDER.map((v) => ({
      visibility: v,
      label: VISIBILITY_META[v].label,
      icon: VISIBILITY_META[v].icon,
      items: byVis.get(v) ?? [],
    }));
  }, [reports]);

  return (
    <Panel className="flex flex-col h-full" data-testid="saved-reports-list">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-ink">Saved reports</h2>
        {onNew && (
          <Button size="sm" variant="primary" onClick={onNew} data-testid="new-report-btn">
            + New
          </Button>
        )}
      </div>

      {loading && (
        <div className="text-xs text-ink-muted py-2">Loading reports…</div>
      )}
      {error && (
        <div
          role="alert"
          className="text-xs text-danger bg-danger/5 p-2 rounded"
          data-testid="saved-reports-error"
        >
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-3">
        {groups.map((g) => (
          <section key={g.visibility} data-testid={`group-${g.visibility}`}>
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [g.visibility]: !o[g.visibility] }))}
              className="w-full flex items-center justify-between text-xs font-medium text-ink-muted uppercase tracking-wide py-1 hover:text-ink"
              aria-expanded={open[g.visibility]}
              aria-controls={`group-body-${g.visibility}`}
              data-testid={`group-toggle-${g.visibility}`}
            >
              <span className="flex items-center gap-1.5">
                {open[g.visibility] ? (
                  <ChevronDown className="h-3 w-3" aria-hidden />
                ) : (
                  <ChevronRight className="h-3 w-3" aria-hidden />
                )}
                <g.icon className="h-3 w-3" aria-hidden />
                {g.label}
              </span>
              <span className="bg-divider rounded px-1.5 py-0.5 text-ink">{g.items.length}</span>
            </button>

            {open[g.visibility] && (
              <ul
                id={`group-body-${g.visibility}`}
                className="mt-1 space-y-0.5"
                data-testid={`group-body-${g.visibility}`}
              >
                {g.items.length === 0 && (
                  <li className="text-xs text-ink-muted italic py-1 px-2">No reports</li>
                )}
                {g.items.map((r) => (
                  <li key={r.report_id} className="group">
                    <div
                      className={cn(
                        'flex items-center justify-between rounded px-2 py-1.5 cursor-pointer transition-colors',
                        selected_id === r.report_id
                          ? 'bg-brand-sky/20 border border-brand-sky'
                          : 'hover:bg-divider',
                      )}
                      data-testid={`saved-report-${r.report_id}`}
                      onClick={() => onSelect(r)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect(r);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open report: ${r.name}`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <FileText className="h-3 w-3 text-ink-muted flex-shrink-0" aria-hidden />
                        <span className="text-xs text-ink truncate">{r.name}</span>
                      </div>
                      {onDelete && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            // eslint-disable-next-line no-restricted-globals
                            if (confirm(`Delete report "${r.name}"?`)) {
                              onDelete(r);
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 text-danger hover:text-danger/70 transition-opacity"
                          aria-label={`Delete ${r.name}`}
                          data-testid={`delete-${r.report_id}`}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                        </button>
                      )}
                    </div>
                    {r.tags.length > 0 && (
                      <div className="px-2 flex gap-1 flex-wrap mt-0.5">
                        {r.tags.slice(0, 3).map((t) => (
                          <span
                            key={t}
                            className="text-[10px] bg-divider px-1 rounded text-ink-muted"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </Panel>
  );
}
