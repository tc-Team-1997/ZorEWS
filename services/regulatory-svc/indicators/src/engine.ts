// Engine.
//
// Coordinates: (customer_id, snapshot_date) → MartSnapshot → run every
// catalog id's compute fn → emit `apex.indicator.values` for breached ones.
//
// Pure data path; HTTP wiring is in server.ts.

import { COMPUTE_REGISTRY } from './compute';
import { loadCatalog } from './catalog';
import { MartReader } from './mart/reader';
import { IndicatorValueRecord, ComputeInputs } from './types';

export interface EvaluateRequest {
  customer_id: string;
  snapshot_date: string;
}

export interface EvaluateResult {
  customer_id: string;
  snapshot_date: string;
  values: IndicatorValueRecord[];
  /** Subset of values where breached === true. */
  breached: IndicatorValueRecord[];
  /** True if the (customer, snapshot) had no mart row. */
  not_found: boolean;
}

export type IndicatorEventEmitter = (record: IndicatorValueRecord) => void;

/**
 * Default emitter — logs the marker comment so agent-integration's Kafka
 * bridge can replace it without a code change. Tests can pass a spy.
 */
export const defaultEmitter: IndicatorEventEmitter = (record) => {
  // emit to apex.indicator.values
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      topic: 'apex.indicator.values',
      key: `${record.customer_id}|${record.indicator_id}`,
      value: record,
    }),
  );
};

export interface EngineOptions {
  reader: MartReader;
  emitter?: IndicatorEventEmitter;
}

export class IndicatorEngine {
  constructor(private readonly opts: EngineOptions) {}

  async evaluate(req: EvaluateRequest): Promise<EvaluateResult> {
    const snap = await this.opts.reader.fetchSnapshot(req.customer_id, req.snapshot_date);
    const ts = new Date().toISOString();
    if (!snap) {
      return {
        customer_id: req.customer_id,
        snapshot_date: req.snapshot_date,
        values: [],
        breached: [],
        not_found: true,
      };
    }

    const catalog = loadCatalog();
    const out: IndicatorValueRecord[] = [];
    const emitter = this.opts.emitter ?? defaultEmitter;

    for (const def of catalog.indicators) {
      const compute = COMPUTE_REGISTRY[def.id];
      if (!compute) {
        // shouldn't happen — checkRegistryAgainstCatalog guards this at boot.
        continue;
      }
      const inputs: ComputeInputs = {
        customer: snap.customer,
        loans: snap.loans,
        txn: snap.txn,
        catalogEntry: def,
        snapshotDate: req.snapshot_date,
      };
      const result = compute(inputs);
      const record: IndicatorValueRecord = {
        customer_id: req.customer_id,
        snapshot_date: req.snapshot_date,
        indicator_id: def.id,
        value: result.value,
        breached: result.breached,
        severity: result.severity,
        ts,
      };
      out.push(record);
      if (result.breached) {
        emitter(record);
      }
    }

    return {
      customer_id: req.customer_id,
      snapshot_date: req.snapshot_date,
      values: out,
      breached: out.filter((v) => v.breached),
      not_found: false,
    };
  }

  async evaluateBatch(reqs: EvaluateRequest[]): Promise<EvaluateResult[]> {
    return Promise.all(reqs.map((r) => this.evaluate(r)));
  }
}
