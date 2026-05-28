// Phase 4 — reusable case workflow chips.
//
// Extracts the status / priority / SLA badge logic that was inlined +
// duplicated across CmsCaseListPage, CmsCaseDetailPage, and the Kanban
// board into shared components (the brief's "reusable status chips /
// SLA indicators / escalation badges"). Output is byte-identical to the
// previous inline markup so existing pages + tests are unchanged.

import { AlertTriangle, Clock } from 'lucide-react';
import { Badge } from '@/components/ui';
import {
  STATUS_TONE,
  PRIORITY_TONE,
  type CmsCaseState,
  type CmsPriority,
} from '@/modules/cms/api';

/** Case lifecycle status chip (OPEN / ASSIGNED / … / CLOSED). */
export function CaseStatusBadge({ status }: { status: CmsCaseState }) {
  return <Badge tone={STATUS_TONE[status] as never}>{status}</Badge>;
}

/** Case priority chip (P1–P4). */
export function CasePriorityBadge({ priority }: { priority: CmsPriority }) {
  return <Badge tone={PRIORITY_TONE[priority] as never}>{priority}</Badge>;
}

export interface CaseSlaShape {
  progress_pct: number;
  breached: boolean;
  warning: boolean;
}

/**
 * SLA / escalation indicator. Three states, worst-first:
 *   breached → danger  "⚠ SLA breached"
 *   warning  → warning  "⏱ SLA warn (N%)"
 *   on-track → success  "SLA N%"
 */
export function CaseSlaBadge({ sla }: { sla: CaseSlaShape }) {
  if (sla.breached) {
    return (
      <Badge tone={'danger' as never}>
        <AlertTriangle size={11} className="inline" /> SLA breached
      </Badge>
    );
  }
  if (sla.warning) {
    return (
      <Badge tone={'warning' as never}>
        <Clock size={11} className="inline" /> SLA warn ({sla.progress_pct}%)
      </Badge>
    );
  }
  return <Badge tone={'success' as never}>SLA {sla.progress_pct}%</Badge>;
}
