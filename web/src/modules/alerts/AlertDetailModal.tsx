// Phase 4 — Alert Center: in-place alert detail panel.
//
// Clicking an alert row used to navigate straight to the customer
// profile. This opens an in-place detail view first (the brief's
// "expandable rows / quick actions / alert detail") and keeps the
// customer drill-through reachable as a link inside it — non-breaking,
// just one click deeper. Reuses the shared Modal primitive (focus trap,
// Esc, scroll-lock, a11y) + the AlertSlaBadge + the alert's own data.

import { Link } from 'react-router-dom';
import { Link2, User, ScrollText, ArrowRight, Check } from 'lucide-react';
import { Badge, type BadgeTone, Button, Modal } from '@/components/ui';
import type { Alert, Severity } from '@/lib/api';
import { bandFor } from '@/lib/criticality';
import { AlertSlaBadge } from './AlertSlaBadge';
import { computeAlertSla, slaWindowLabel } from './alertSeverity';

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

const BAND_TONE: Record<ReturnType<typeof bandFor>, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

const KES = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  maximumFractionDigits: 0,
});

function ageLabel(m: number): string {
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-0.5 text-sm text-ink">{children}</div>
    </div>
  );
}

export function AlertDetailModal({
  alert,
  onClose,
  onAcknowledge,
}: {
  alert: Alert | null;
  onClose: () => void;
  /** Acknowledge this alert (Phase 4). Optional — omit to hide the action. */
  onAcknowledge?: (alertId: string) => void;
}) {
  if (!alert) return null;
  const sla = computeAlertSla(alert.severity, alert.age_min);
  const overdueBy = -sla.remaining_minutes;

  return (
    <Modal
      open={alert !== null}
      onClose={onClose}
      ariaLabel={`Alert detail ${alert.id}`}
      size="lg"
      testId="alert-detail-modal"
    >
      <div className="space-y-5" data-testid="alert-detail-body">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pr-8">
          <div>
            <div className="flex items-center gap-2">
              <Badge tone={SEVERITY_TONE[alert.severity]} className="uppercase tracking-wide">
                {alert.severity}
              </Badge>
              <Badge tone={BAND_TONE[bandFor(alert.criticality_score)]} className="tracking-wide">
                {alert.criticality_score.toFixed(2)}
              </Badge>
              <span className="text-2xs text-muted">
                conf {(alert.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-muted">{alert.id}</p>
          </div>
          <AlertSlaBadge severity={alert.severity} ageMin={alert.age_min} />
        </div>

        {/* Core fields */}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Customer">
            <p className="font-medium">{alert.customer.name}</p>
            <p className="font-mono text-2xs text-muted">{alert.customer.id}</p>
          </Field>
          <Field label="Rule">
            <p>{alert.rule.name}</p>
            <p className="font-mono text-2xs text-muted">{alert.rule.id}</p>
          </Field>
          <Field label="Exposure">{KES.format(alert.customer_exposure_kes)}</Field>
          <Field label="Assignee">
            {alert.assignee ? (
              <Badge tone="neutral">{alert.assignee}</Badge>
            ) : (
              <span className="text-muted">unassigned</span>
            )}
          </Field>
          <Field label="Age">
            {ageLabel(alert.age_min)}{' '}
            <span className="text-2xs text-muted">
              · raised {new Date(alert.created_at).toLocaleString()}
            </span>
          </Field>
          <Field label="SLA">
            {sla.breached
              ? `Breached by ${ageLabel(Math.round(overdueBy))}`
              : `${ageLabel(Math.round(sla.remaining_minutes))} left of ${slaWindowLabel(alert.severity)}`}
          </Field>
        </div>

        {/* Indicators */}
        <Field label="Indicators fired">
          <div className="mt-1 flex flex-wrap gap-1">
            {alert.indicators.length === 0 ? (
              <span className="text-2xs text-muted">none</span>
            ) : (
              alert.indicators.map((id) => (
                <Badge key={id} tone="blue" className="font-mono">
                  {id}
                </Badge>
              ))
            )}
          </div>
        </Field>

        {/* Linked alerts */}
        {alert.linked_alert_ids.length > 0 && (
          <Field label="Linked alerts (same customer)">
            <span className="inline-flex items-center gap-1 text-sm">
              <Link2 size={12} className="text-blue-600" />
              {alert.linked_alert_ids.length} folded into this row
            </span>
            <div className="mt-1 flex flex-wrap gap-1">
              {alert.linked_alert_ids.map((id) => (
                <span key={id} className="font-mono text-2xs text-muted">
                  {id}
                </span>
              ))}
            </div>
          </Field>
        )}

        {/* Quick actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-4">
          {onAcknowledge &&
            (alert.acknowledged ? (
              <span
                className="inline-flex items-center gap-1.5 text-sm text-emerald-700"
                data-testid="alert-detail-acked"
              >
                <Check size={14} /> Acknowledged
              </span>
            ) : (
              <Button
                onClick={() => onAcknowledge(alert.id)}
                data-testid="alert-detail-acknowledge"
              >
                <Check size={14} /> Acknowledge
              </Button>
            ))}
          <Link
            to={`/customers/${alert.customer.id}`}
            onClick={onClose}
            data-testid="alert-detail-view-customer"
            className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-50"
          >
            <User size={14} /> View customer profile <ArrowRight size={12} />
          </Link>
          <Link
            to={`/alerts?rule_id=${encodeURIComponent(alert.rule.id)}`}
            onClick={onClose}
            data-testid="alert-detail-filter-rule"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            <ScrollText size={14} /> Filter alerts by this rule
          </Link>
        </div>
      </div>
    </Modal>
  );
}
