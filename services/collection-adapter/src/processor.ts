// services/collection-adapter/src/processor.ts
//
// CollectionProcessor — orchestrates one routing pass. Reads case events
// from the source, decides which to route, and emits a single
// apex.collection.routes event per eligible case (idempotent on case_id).

import { decideRoute } from './router';
import type { CaseEventSource } from './source';
import type { CollectionSink } from './sink';
import type { CollectionRouteEvent } from './types';

let routeCounter = 0;
function newRouteId(now: () => Date): string {
  routeCounter = (routeCounter + 1) & 0xffff;
  return `route_${now().getTime().toString(36)}_${routeCounter.toString(16).padStart(4, '0')}`;
}

export interface ProcessReport {
  scanned: number;
  routed: number;
  skipped_below_threshold: number;
  skipped_already_routed: number;
  skipped_non_create: number;
  routes: CollectionRouteEvent[];
}

export class CollectionProcessor {
  constructor(
    private readonly source: CaseEventSource,
    private readonly sink: CollectionSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async process(): Promise<ProcessReport> {
    const events = this.source.read();
    const report: ProcessReport = {
      scanned: events.length,
      routed: 0,
      skipped_below_threshold: 0,
      skipped_already_routed: 0,
      skipped_non_create: 0,
      routes: [],
    };

    for (const event of events) {
      const decision = decideRoute(event);
      if (!decision.route) {
        if (decision.reason === 'not_a_creation_event') report.skipped_non_create++;
        else report.skipped_below_threshold++;
        continue;
      }
      if (this.sink.hasRouted(event.case_id)) {
        report.skipped_already_routed++;
        continue;
      }
      const route: CollectionRouteEvent = {
        route_id: newRouteId(this.now),
        case_id: event.case_id,
        alert_id: event.alert_id,
        customer_id: event.customer_id,
        severity: decision.severity,
        loan_id: decision.loan_id,
        routed_at: this.now().toISOString(),
        reason: decision.reason,
        source_event_id: event.event_id,
      };
      await this.sink.emit(route);
      report.routes.push(route);
      report.routed++;
    }
    return report;
  }
}
