// services/regulatory-svc/alerts/src/evaluator.ts
//
// AlertEvaluator — the "do-everything" wiring used by both the HTTP endpoint
// (`POST /alerts/evaluate`) and the (future) Kafka subscriber on
// apex.rule.firings. It:
//
//  1. Validates the input firing against the v1 schema.
//  2. Calls ai-copilot-svc /score (best-effort).
//  3. Builds the canonical alert (severity merge + idempotent alert_id).
//  4. Validates the output against apex.regulatory.events.v2.
//  5. Emits to the Producer (Kafka in prod, outbox in dev).
//  6. Enqueues into the SmartQueue.
//
// Returns the canonical alert + the queue entry.

import { buildAlert } from './alert';
import type { Producer } from './producer';
import { type IQueue, type QueueEntry } from './queue';
import { ruleFiringValidator, alertEventValidator, explain } from './schemas';
import type { ScoreClient } from './score_client';
import type { CanonicalAlert, RuleFiring } from './types';

export interface EvaluatorOptions {
  producer: Producer;
  queue: IQueue;
  scoreClient: ScoreClient;
  /** Topic to emit on. Defaults to apex.regulatory.events. */
  topic?: string;
  /** Build score-call payload from a firing. Defaults to a minimal stub. */
  featureBuilder?: (firing: RuleFiring) => Record<string, unknown>;
  now?: () => Date;
  /** Skip output schema validation — used when caller already validates. */
  skipOutputValidation?: boolean;
}

export interface EvaluationResult {
  alert: CanonicalAlert;
  queueEntry: QueueEntry;
  score: { pd: number | null; level: string | null };
  alertExisting: boolean;
}

/**
 * Default feature builder. The real producer will lift features from
 * mart.indicator_values; for the prototype we project the firing's
 * `evidence` bag into the score endpoint's expected shape with safe
 * defaults so the call doesn't 422.
 */
export function defaultFeatureBuilder(firing: RuleFiring): Record<string, unknown> {
  const e = firing.evidence ?? {};
  const num = (k: string, fallback: number): number => {
    const v = e[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const str = (k: string, fallback: string): string => {
    const v = e[k];
    return typeof v === 'string' ? v : fallback;
  };
  return {
    customer_id: firing.customer_id,
    utilization: num('utilization', 0.5),
    dpd_max_90d: num('dpd_max_90d', 0),
    balance_drop_30d_pct: num('balance_drop_30d_pct', 0),
    bureau_score: num('bureau_score', 600),
    repayment_delay_streak: num('repayment_delay_streak', 0),
    txn_volume_zscore_90d: num('txn_volume_zscore_90d', 0),
    tenure_months: num('tenure_months', 12),
    product_type: str('product_type', 'personal_loan'),
    income_bucket: str('income_bucket', 'lower_mid'),
  };
}

export class AlertEvaluator {
  private readonly topic: string;
  private readonly featureBuilder: (f: RuleFiring) => Record<string, unknown>;

  constructor(private readonly opts: EvaluatorOptions) {
    this.topic = opts.topic ?? 'apex.regulatory.events';
    this.featureBuilder = opts.featureBuilder ?? defaultFeatureBuilder;
  }

  async evaluate(firing: RuleFiring, tenant_id: string = 'BANK_DEMO'): Promise<EvaluationResult> {
    // 1. Input validation.
    const inV = ruleFiringValidator();
    if (!inV(firing)) {
      const err = new Error(`firing failed schema: ${explain(inV).join('; ')}`) as Error & {
        status?: number;
      };
      err.status = 400;
      throw err;
    }

    // 2. Score (best-effort).
    let score = null;
    try {
      score = await this.opts.scoreClient.score(this.featureBuilder(firing));
    } catch {
      score = null;
    }

    // 3. Build canonical alert.
    const alert = buildAlert({ firing, score, now: this.opts.now });

    // 4. Output schema validation.
    if (!this.opts.skipOutputValidation) {
      const outV = alertEventValidator();
      if (!outV(alert)) {
        const err = new Error(
          `built alert failed schema: ${explain(outV).join('; ')}`,
        ) as Error & { status?: number };
        err.status = 500;
        throw err;
      }
    }

    // 5. Idempotency check via queue (alert_id is content-derived).
    const existing = this.opts.queue.get(alert.alert_id, tenant_id);

    // 6. Emit + enqueue (skip duplicate emits — alert_id is deterministic).
    if (!existing) {
      await this.opts.producer.emit(this.topic, alert);
    }
    const entry = this.opts.queue.enqueue(alert, tenant_id);

    return {
      alert,
      queueEntry: entry,
      score: { pd: score?.pd ?? null, level: score?.level ?? null },
      alertExisting: !!existing,
    };
  }
}
