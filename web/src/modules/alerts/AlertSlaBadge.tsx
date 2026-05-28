// Phase 4 — Alert Center: reusable SLA indicator.
//
// Renders an alert's SLA posture (on_time / warning / breached) from its
// severity + age via the canonical alertSeverity config. Reuses the
// shared <Badge> primitive so it inherits the app's tone palette. The
// brief's "reusable SLA indicators / breach indicators" deliverable.

import { Badge, type BadgeTone } from '@/components/ui';
import type { Severity } from '@/lib/api';
import { computeAlertSla, slaWindowLabel, type AlertSlaStatus } from './alertSeverity';

const STATUS_TONE: Record<AlertSlaStatus, BadgeTone> = {
  on_time: 'success',
  warning: 'warning',
  breached: 'danger',
};

const STATUS_LABEL: Record<AlertSlaStatus, string> = {
  on_time: 'On time',
  warning: 'Escalate',
  breached: 'Breached',
};

export function AlertSlaBadge({
  severity,
  ageMin,
}: {
  severity: Severity;
  ageMin: number;
}) {
  const sla = computeAlertSla(severity, ageMin);
  const pct = Math.min(999, Math.round(sla.progress * 100));
  return (
    <div
      className="flex flex-col items-start gap-0.5"
      data-testid={`alert-sla-${sla.status}`}
    >
      <Badge tone={STATUS_TONE[sla.status]} className="uppercase tracking-wide">
        {STATUS_LABEL[sla.status]}
      </Badge>
      <span className="text-2xs text-muted tabular">
        {pct}% of {slaWindowLabel(severity)}
      </span>
    </div>
  );
}
