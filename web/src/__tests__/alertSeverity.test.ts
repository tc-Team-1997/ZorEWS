// Phase 4 — Alert Center: severity → SLA system contract.
//
// Pins the canonical severity→SLA windows + the breach/escalation
// classification the alert list's SLA column depends on. Pure logic.

import { describe, test, expect } from 'vitest';
import {
  ALERT_SLA_BY_SEVERITY,
  computeAlertSla,
  slaWindowLabel,
} from '@/modules/alerts/alertSeverity';
import type { Severity } from '@/lib/api';

const ALL: Severity[] = ['critical', 'high', 'medium', 'low'];

describe('ALERT_SLA_BY_SEVERITY config', () => {
  test('every severity has an SLA window', () => {
    for (const s of ALL) {
      expect(ALERT_SLA_BY_SEVERITY[s].sla_hours).toBeGreaterThan(0);
    }
  });

  test('matches the Phase 4 brief windows (2/8/24h)', () => {
    expect(ALERT_SLA_BY_SEVERITY.critical.sla_hours).toBe(2);
    expect(ALERT_SLA_BY_SEVERITY.high.sla_hours).toBe(8);
    expect(ALERT_SLA_BY_SEVERITY.medium.sla_hours).toBe(24);
  });

  test('escalation always fires strictly before breach', () => {
    for (const s of ALL) {
      expect(ALERT_SLA_BY_SEVERITY[s].escalate_after_hours).toBeLessThan(
        ALERT_SLA_BY_SEVERITY[s].sla_hours,
      );
    }
  });

  test('SLA windows shorten as severity rises', () => {
    expect(ALERT_SLA_BY_SEVERITY.critical.sla_hours).toBeLessThan(
      ALERT_SLA_BY_SEVERITY.high.sla_hours,
    );
    expect(ALERT_SLA_BY_SEVERITY.high.sla_hours).toBeLessThan(
      ALERT_SLA_BY_SEVERITY.medium.sla_hours,
    );
    expect(ALERT_SLA_BY_SEVERITY.medium.sla_hours).toBeLessThan(
      ALERT_SLA_BY_SEVERITY.low.sla_hours,
    );
  });
});

describe('computeAlertSla — status classification', () => {
  test('fresh critical alert (10m) is on_time', () => {
    const p = computeAlertSla('critical', 10);
    expect(p.status).toBe('on_time');
    expect(p.breached).toBe(false);
    expect(p.escalate_due).toBe(false);
  });

  test('critical at the escalation threshold (90m of 120m) → warning', () => {
    const p = computeAlertSla('critical', 90); // escalate_after = 1.5h = 90m
    expect(p.status).toBe('warning');
    expect(p.escalate_due).toBe(true);
    expect(p.breached).toBe(false);
  });

  test('critical past 2h SLA (130m) → breached', () => {
    const p = computeAlertSla('critical', 130);
    expect(p.status).toBe('breached');
    expect(p.breached).toBe(true);
    expect(p.escalate_due).toBe(true);
    expect(p.remaining_minutes).toBeLessThan(0);
  });

  test('exact SLA boundary (120m) is breached (>=)', () => {
    expect(computeAlertSla('critical', 120).breached).toBe(true);
  });

  test('exact escalation boundary (90m) is warning (>=)', () => {
    const p = computeAlertSla('critical', 90);
    expect(p.escalate_due).toBe(true);
    expect(p.status).toBe('warning');
  });

  test('progress = elapsed / sla, rounded 4dp', () => {
    // 60m of a 120m SLA = 0.5
    expect(computeAlertSla('critical', 60).progress).toBe(0.5);
    // can exceed 1 when breached
    expect(computeAlertSla('critical', 240).progress).toBe(2);
  });

  test('remaining_minutes = sla - elapsed', () => {
    expect(computeAlertSla('high', 60).remaining_minutes).toBe(8 * 60 - 60);
  });

  test('negative / non-finite age clamps to 0 (on_time)', () => {
    expect(computeAlertSla('critical', -5).elapsed_minutes).toBe(0);
    expect(computeAlertSla('critical', Number.NaN).status).toBe('on_time');
    expect(computeAlertSla('critical', Number.POSITIVE_INFINITY).elapsed_minutes).toBe(0);
  });

  test('medium alert open 20h → warning (escalate at 18h, breach at 24h)', () => {
    const p = computeAlertSla('medium', 20 * 60);
    expect(p.status).toBe('warning');
    expect(p.breached).toBe(false);
  });
});

describe('slaWindowLabel', () => {
  test('renders the hour window', () => {
    expect(slaWindowLabel('critical')).toBe('2h');
    expect(slaWindowLabel('medium')).toBe('24h');
  });
});
