// services/bff/src/sla/policy.ts
//
// SLA policy table. For each severity, defines max-minutes-allowed for
// each lifecycle stage:
//
//   ack     — case opened → first acknowledgement (assignee picks it up)
//   action  — assigned    → first officer action (call/visit/sms)
//   close   — opened      → terminal state (cured/cured_temp/defaulted)
//
// In production these would come from a versioned policy table that
// risk + collections owns jointly. For the prototype we hard-code a
// reasonable matrix anchored on RBI early-warning guidance.

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type SlaStage = 'ack' | 'action' | 'close';

export interface SlaPolicy {
  /** Minutes from open → first ack. */
  ack_minutes: number;
  /** Minutes from open → first officer action. */
  action_minutes: number;
  /** Minutes from open → terminal state. */
  close_minutes: number;
}

export const SLA_POLICY: Record<Severity, SlaPolicy> = {
  critical: { ack_minutes: 15, action_minutes: 60, close_minutes: 240 },
  high: { ack_minutes: 60, action_minutes: 240, close_minutes: 1_440 },
  medium: { ack_minutes: 240, action_minutes: 1_440, close_minutes: 4_320 },
  low: { ack_minutes: 1_440, action_minutes: 4_320, close_minutes: 10_080 },
};

/** "approaching" threshold — within this fraction of deadline is yellow. */
export const APPROACHING_FRACTION = 0.8;
