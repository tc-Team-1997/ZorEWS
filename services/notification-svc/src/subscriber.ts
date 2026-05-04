// services/notification-svc/src/subscriber.ts
//
// Stub subscriber for `apex.regulatory.events`. In production this is wired
// to the kafkajs consumer; for the prototype the AlertSubscriber accepts
// ad-hoc events (e.g. from the HTTP endpoint or a polled outbox tail).
//
// The subscriber's only job is to call `fanout()` per the channel matrix:
//   CRITICAL → SMS + Email
//   HIGH/MEDIUM → Email
//   LOW → in-app only (no-op here)

import { fanout, type FanoutDeps } from './router';
import type { AlertSummary, NotifyTarget, SendResult } from './types';

export class AlertSubscriber {
  constructor(private readonly deps: FanoutDeps) {}

  /**
   * Process one alert; returns the SendResults from each channel actually
   * fanned out to. LOW alerts return [] (in-app only).
   */
  async onAlert(alert: AlertSummary, target: NotifyTarget): Promise<SendResult[]> {
    return fanout(this.deps, { alert, target });
  }
}
