// services/notification-svc/src/router.ts
//
// Severity-based fan-out (FR-ALERT-4):
//
//   CRITICAL → SMS (Africa's Talking) + Email (SES)
//   HIGH     → Email only          (operations override; same as CRITICAL minus SMS)
//   MEDIUM   → Email only
//   LOW      → in-app only (no fan-out from this service)
//
// The original spec wording was "Critical: SMS+Email; Medium: email; Low:
// in-app". HIGH alerts were not explicitly listed; we treat HIGH like MEDIUM
// (email only) to avoid noisy SMS while still surfacing it on the analyst's
// inbox. Critical-only SMS preserves the cost / urgency signal.
//
// Returns one SendResult per channel actually invoked.

import { renderAlertEmail } from './templates/email';
import { renderAlertSms } from './templates/sms';
import type {
  Adapter,
  AlertSummary,
  Channel,
  NotifyTarget,
  SendResult,
} from './types';

export function channelsFor(severity: AlertSummary['severity']): Channel[] {
  switch (severity) {
    case 'CRITICAL':
      return ['sms', 'email'];
    case 'HIGH':
    case 'MEDIUM':
      return ['email'];
    case 'LOW':
    default:
      return []; // in-app only — handled by the UI MSW layer / web subscription
  }
}

export interface FanoutDeps {
  emailAdapter: Adapter; // channel === 'email'
  smsAdapter: Adapter; // channel === 'sms'
}

export interface FanoutInput {
  alert: AlertSummary;
  target: NotifyTarget;
}

export async function fanout(
  deps: FanoutDeps,
  { alert, target }: FanoutInput,
): Promise<SendResult[]> {
  const channels = channelsFor(alert.severity);
  const results: SendResult[] = [];

  for (const ch of channels) {
    if (ch === 'email') {
      const msg = renderAlertEmail(alert, target.display_name);
      results.push(
        await deps.emailAdapter.send({
          channel: 'email',
          target,
          message: msg,
          alert_id: alert.alert_id,
        }),
      );
    } else if (ch === 'sms') {
      const msg = renderAlertSms(alert);
      results.push(
        await deps.smsAdapter.send({
          channel: 'sms',
          target,
          message: msg,
          alert_id: alert.alert_id,
        }),
      );
    }
  }

  return results;
}
