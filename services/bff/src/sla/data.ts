// services/bff/src/sla/data.ts
//
// Synthetic case fleet for the SLA endpoints. Hand-tuned so the SPA
// renders a realistic mix: ~70% on-track, ~15% approaching, ~10%
// breached, ~5% closed.
//
// Production wires this to regulatory-svc/cases — the BFF would proxy
// or maintain a read cache. For the prototype, this in-memory list is
// sufficient and matches the MSW mock data shape.

import type { SlaCase } from './evaluator';

/**
 * Generate a deterministic case fleet anchored on `now`. Cases are
 * spread across the 4 severities + 4 active states (open, assigned,
 * in_action, monitored) + closed. Created-times step back from now so
 * a few of each severity are inside the breach window.
 */
export function makeFleet(now: Date = new Date()): SlaCase[] {
  const t = now.getTime();
  const minutesAgo = (m: number) => new Date(t - m * 60_000).toISOString();
  return [
    // ── Critical (ack 15m, action 60m, close 240m) ─────────────────────
    { case_id: 'case-1001', severity: 'critical', state: 'open', created_at: minutesAgo(8) }, // on track
    { case_id: 'case-1002', severity: 'critical', state: 'open', created_at: minutesAgo(13) }, // approaching
    { case_id: 'case-1003', severity: 'critical', state: 'open', created_at: minutesAgo(45) }, // breached
    {
      case_id: 'case-1004',
      severity: 'critical',
      state: 'in_action',
      created_at: minutesAgo(310),
      acked_at: minutesAgo(305),
      first_action_at: minutesAgo(290),
    }, // breached on close
    {
      case_id: 'case-1005',
      severity: 'critical',
      state: 'closed',
      created_at: minutesAgo(180),
      acked_at: minutesAgo(170),
      first_action_at: minutesAgo(155),
      closed_at: minutesAgo(60),
    },

    // ── High (ack 60m, action 240m, close 1440m) ───────────────────────
    { case_id: 'case-2001', severity: 'high', state: 'open', created_at: minutesAgo(20) }, // on track
    { case_id: 'case-2002', severity: 'high', state: 'open', created_at: minutesAgo(55) }, // approaching
    { case_id: 'case-2003', severity: 'high', state: 'open', created_at: minutesAgo(120) }, // breached
    {
      case_id: 'case-2004',
      severity: 'high',
      state: 'assigned',
      created_at: minutesAgo(150),
      acked_at: minutesAgo(45),
    }, // on track on action stage
    {
      case_id: 'case-2005',
      severity: 'high',
      state: 'monitored',
      created_at: minutesAgo(900),
      acked_at: minutesAgo(870),
      first_action_at: minutesAgo(820),
    }, // on track on close

    // ── Medium (ack 240m, action 1440m, close 4320m) ───────────────────
    { case_id: 'case-3001', severity: 'medium', state: 'open', created_at: minutesAgo(60) }, // on track
    { case_id: 'case-3002', severity: 'medium', state: 'open', created_at: minutesAgo(220) }, // approaching
    { case_id: 'case-3003', severity: 'medium', state: 'open', created_at: minutesAgo(310) }, // breached
    { case_id: 'case-3004', severity: 'medium', state: 'open', created_at: minutesAgo(40) }, // on track
    {
      case_id: 'case-3005',
      severity: 'medium',
      state: 'assigned',
      created_at: minutesAgo(800),
      acked_at: minutesAgo(120),
    },

    // ── Low (ack 1440m, action 4320m, close 10080m) ────────────────────
    { case_id: 'case-4001', severity: 'low', state: 'open', created_at: minutesAgo(120) }, // on track
    { case_id: 'case-4002', severity: 'low', state: 'open', created_at: minutesAgo(1300) }, // approaching
    { case_id: 'case-4003', severity: 'low', state: 'open', created_at: minutesAgo(1500) }, // breached
    { case_id: 'case-4004', severity: 'low', state: 'open', created_at: minutesAgo(40) }, // on track
  ];
}
