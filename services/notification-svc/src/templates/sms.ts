// services/notification-svc/src/templates/sms.ts
//
// 160-char SMS template. Uses ${alert.summary} placeholder (substituted in TS)
// and truncates aggressively so we stay in single-segment territory.

import type { AlertSummary } from '../types';

export function renderAlertSms(alert: AlertSummary): { subject: string; body: string } {
  const reason = alert.reason_summary ?? `${alert.rule_id ?? 'Alert'} fired`;
  // Format: "[APEX EWS][CRITICAL] <reason> id:<short>"
  const shortId = alert.alert_id.slice(0, 8);
  const head = `[APEX EWS][${alert.severity}]`;
  const tail = ` id:${shortId}`;
  const budget = 160 - head.length - tail.length - 1; // 1 space
  const body = `${head} ${truncate(reason, budget)}${tail}`;
  return { subject: `APEX EWS ${alert.severity}`, body };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.slice(0, max - 1) + '…';
}
