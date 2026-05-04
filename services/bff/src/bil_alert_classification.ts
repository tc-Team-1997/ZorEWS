// services/bff/src/bil_alert_classification.ts
//
// T6 M8.1 — BIL Red/Orange/Yellow alert classification.
//
// The DataNetworks-EWS-Ver1.pdf §11 specifies a 3-tier alert palette
// driven by severity:
//   Red    — critical, immediate action, escalate to head-of-risk
//   Orange — high, investigate within SLA, supervisor handles
//   Yellow — medium, monitor only, analyst handles
//
// The existing alerts pipeline emits WireSeverity = LOW | MEDIUM | HIGH
// | CRITICAL. The BIL doc only colour-codes 3 levels — LOW falls
// outside its palette but operationally still needs a colour for the
// SPA badge. I extend with `green` (informational, no action) to give
// a complete mapping without contradicting the BIL spec.
//
// Why this lives in BFF and not regulatory-svc/alerts: the BIL
// classification is a UI/UX projection of severity, not a property of
// the alert itself. The producer (alerts service) doesn't need to know
// about colours; the consumer-facing API does. Keeping the mapping
// stateless + in the BFF means the BIL-vs-bank vertical can fork the
// table later without touching the upstream alert engine.

export type WireSeverityIn = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type UiSeverityIn = 'low' | 'medium' | 'high' | 'critical';
export type SeverityInput = WireSeverityIn | UiSeverityIn;

export type BilAlertClass = 'red' | 'orange' | 'yellow' | 'green';

export interface BilClassMetadata {
  /** The 4 colour buckets. */
  class: BilAlertClass;
  /** Hex colour for SPA legend / badges. */
  color_hex: string;
  /** Human-readable label for tooltips. */
  label: string;
  /** Action posture. `monitor_only=true` means no human action required. */
  monitor_only: boolean;
  /** SLA hours from alert raise. null when monitor_only=true. */
  sla_hours: number | null;
  /** Who owns the response. */
  escalation_path: 'head_of_risk' | 'supervisor' | 'analyst' | 'none';
  /** Short imperative description ("immediate action", "investigate", etc.). */
  action_required: string;
  /** Severities that map to this class. */
  source_severities: WireSeverityIn[];
}

const TABLE: Record<BilAlertClass, BilClassMetadata> = {
  red: {
    class: 'red',
    color_hex: '#D32F2F',
    label: 'Red — Critical',
    monitor_only: false,
    sla_hours: 4,
    escalation_path: 'head_of_risk',
    action_required: 'Immediate action — escalate to head of risk',
    source_severities: ['CRITICAL'],
  },
  orange: {
    class: 'orange',
    color_hex: '#F57C00',
    label: 'Orange — High',
    monitor_only: false,
    sla_hours: 24,
    escalation_path: 'supervisor',
    action_required: 'Investigate within 24 hours — supervisor leads',
    source_severities: ['HIGH'],
  },
  yellow: {
    class: 'yellow',
    color_hex: '#FBC02D',
    label: 'Yellow — Medium',
    monitor_only: false,
    sla_hours: 72,
    escalation_path: 'analyst',
    action_required: 'Monitor and triage within 72 hours',
    source_severities: ['MEDIUM'],
  },
  green: {
    class: 'green',
    color_hex: '#388E3C',
    label: 'Green — Informational',
    monitor_only: true,
    sla_hours: null,
    escalation_path: 'none',
    action_required: 'No action required — review at next portfolio cadence',
    source_severities: ['LOW'],
  },
};

/** All 4 classes in canonical (high → low severity) order. */
export const BIL_CLASS_ORDER: BilAlertClass[] = ['red', 'orange', 'yellow', 'green'];

export class AlertClassificationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AlertClassificationError';
  }
}

function normaliseSeverity(s: SeverityInput): WireSeverityIn {
  if (typeof s !== 'string') {
    throw new AlertClassificationError('invalid_severity', 'severity must be a string');
  }
  const u = s.toUpperCase();
  if (u !== 'LOW' && u !== 'MEDIUM' && u !== 'HIGH' && u !== 'CRITICAL') {
    throw new AlertClassificationError(
      'invalid_severity',
      `severity must be one of LOW|MEDIUM|HIGH|CRITICAL (case-insensitive); got ${s}`,
    );
  }
  return u as WireSeverityIn;
}

/**
 * Classify a severity into the BIL 4-colour palette.
 * Pure mapping — same input always yields the same class.
 */
export function classifyAlertSeverity(severity: SeverityInput): BilAlertClass {
  const wire = normaliseSeverity(severity);
  switch (wire) {
    case 'CRITICAL':
      return 'red';
    case 'HIGH':
      return 'orange';
    case 'MEDIUM':
      return 'yellow';
    case 'LOW':
      return 'green';
  }
}

/** Look up the full metadata block for a class. Throws on unknown class. */
export function getClassMetadata(c: BilAlertClass): BilClassMetadata {
  const meta = TABLE[c];
  if (!meta) {
    throw new AlertClassificationError('unknown_class', `unknown BIL class: ${c}`);
  }
  return meta;
}

/** Classify a severity and return its metadata block. */
export function classifyWithMetadata(severity: SeverityInput): {
  severity: WireSeverityIn;
  class: BilAlertClass;
  metadata: BilClassMetadata;
} {
  const wire = normaliseSeverity(severity);
  const cls = classifyAlertSeverity(wire);
  return { severity: wire, class: cls, metadata: getClassMetadata(cls) };
}

/** All metadata rows in canonical order — useful for a SPA legend. */
export function listClassifications(): BilClassMetadata[] {
  return BIL_CLASS_ORDER.map((c) => TABLE[c]);
}

/** Type-guard: is the string a valid BIL class? Used by the route to
 *  parse `/v1/alerts/by-class/:class`. */
export function isBilAlertClass(s: unknown): s is BilAlertClass {
  return s === 'red' || s === 'orange' || s === 'yellow' || s === 'green';
}
