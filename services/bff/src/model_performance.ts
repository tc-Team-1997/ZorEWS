// services/bff/src/model_performance.ts
//
// T6 M7.5 — Model performance ledger.
//
// MLops watches the production model's quality metrics across
// runs to trigger retraining before drift erodes scoring quality.
// M7.5 ships an append-only per-tenant per-model ledger of
// metric observations (precision / recall / AUC / drift_score /
// calibration_err) with a pure aggregator the SPA can render as
// a sparkline + summary card.
//
// Design:
//  - Append-only. Mistaken entries stay; corrections happen via
//    a follow-up entry. Keeps the ledger usable as a raw audit
//    feed for compliance reviews.
//  - Per (tenant, model_id) cap of 200 — same posture as M14.10
//    field visit ledger. Newest 200 retained, oldest evicted.
//  - model_id MUST exist in the M7.1 catalog. Bogus ids rejected
//    at write time (fail loud at the source rather than persisting
//    garbage that confuses the SPA).
//  - linearPercentile re-uses the same Excel/R type-7 definition
//    as M3.5 so all of our latency-style summaries are consistent.

import { randomUUID } from 'node:crypto';
import { type AiModelRegistry } from './ai_model_registry';
import { linearPercentile } from './connector_run_analytics';

// ─── Public types ─────────────────────────────────────────────────────

export const PERFORMANCE_METRICS = [
  'precision',
  'recall',
  'auc',
  'drift_score',
  'calibration_err',
] as const;

export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];

export function isPerformanceMetric(s: unknown): s is PerformanceMetric {
  return typeof s === 'string' && (PERFORMANCE_METRICS as readonly string[]).includes(s);
}

export interface ModelPerformanceInput {
  metric: PerformanceMetric;
  /** Metric value. Each metric has its own natural range — caller
   *  is responsible for posting valid numbers. We bound to [-1, 2]
   *  to catch order-of-magnitude bugs (rate values > 1, drift >> 1). */
  value: number;
  /** Sample size the metric was computed over — used by the
   *  aggregator to weight summaries. */
  sample_size: number;
  /** Free-form context (cohort, threshold, etc.) ≤ 500 chars. */
  notes?: string;
}

export interface ModelPerformanceEntry {
  entry_id: string;
  tenant_id: string;
  model_id: string;
  metric: PerformanceMetric;
  value: number;
  sample_size: number;
  notes: string;
  recorded_at: string;
}

export interface ModelPerformanceSummary {
  tenant_id: string;
  model_id: string;
  /** Number of entries the summary covers. */
  sample_size: number;
  /** Per-metric stats — null when no entries observed for that metric. */
  metrics: Record<
    PerformanceMetric,
    {
      latest_value: number;
      latest_at: string;
      sample_count: number;
      mean: number;
      min: number;
      p50: number;
      p95: number;
      max: number;
    } | null
  >;
}

export class ModelPerformanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ModelPerformanceError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

const NOTES_CAP = 500;
const MAX_SAMPLE_SIZE = 100_000_000; // 100M-row sanity cap

function validate(input: unknown): ModelPerformanceInput {
  if (!input || typeof input !== 'object') {
    throw new ModelPerformanceError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (!isPerformanceMetric(i.metric)) {
    throw new ModelPerformanceError(
      'invalid_input',
      `metric must be one of ${PERFORMANCE_METRICS.join(', ')}`,
    );
  }
  if (typeof i.value !== 'number' || !Number.isFinite(i.value)) {
    throw new ModelPerformanceError('invalid_input', 'value must be a finite number');
  }
  if (i.value < -1 || i.value > 2) {
    throw new ModelPerformanceError(
      'invalid_input',
      'value must be in [-1, 2] (rates ≤ 1, drift > 1 caps at 2)',
    );
  }
  if (
    typeof i.sample_size !== 'number' ||
    !Number.isInteger(i.sample_size) ||
    i.sample_size < 1
  ) {
    throw new ModelPerformanceError('invalid_input', 'sample_size must be a positive integer');
  }
  if (i.sample_size > MAX_SAMPLE_SIZE) {
    throw new ModelPerformanceError(
      'invalid_input',
      `sample_size ≤ ${MAX_SAMPLE_SIZE}`,
    );
  }
  let notes = '';
  if (i.notes !== undefined && i.notes !== null) {
    if (typeof i.notes !== 'string') {
      throw new ModelPerformanceError('invalid_input', 'notes must be a string');
    }
    if (i.notes.length > NOTES_CAP) {
      throw new ModelPerformanceError('invalid_input', `notes ≤ ${NOTES_CAP} chars`);
    }
    notes = i.notes.trim();
  }
  return {
    metric: i.metric,
    value: i.value,
    sample_size: i.sample_size,
    notes: notes ? notes : undefined,
  };
}

// ─── Pure aggregator ──────────────────────────────────────────────────

function emptyMetrics(): ModelPerformanceSummary['metrics'] {
  return {
    precision: null,
    recall: null,
    auc: null,
    drift_score: null,
    calibration_err: null,
  };
}

/**
 * Pure aggregator: roll up per-metric latest + mean/p50/p95 over
 * the supplied entries. Caller slices the window before calling
 * (typically `listFor(tenant, model_id, {since})`).
 */
export function summarizePerformance(
  tenant_id: string,
  model_id: string,
  entries: readonly ModelPerformanceEntry[],
): ModelPerformanceSummary {
  const metrics = emptyMetrics();
  for (const m of PERFORMANCE_METRICS) {
    const subset = entries.filter((e) => e.metric === m);
    if (subset.length === 0) continue;
    // Latest by recorded_at (string-compare on ISO is correct).
    let latest = subset[0]!;
    for (const e of subset) if (e.recorded_at > latest.recorded_at) latest = e;
    const sortedValues = subset.map((e) => e.value).sort((a, b) => a - b);
    const sum = sortedValues.reduce((s, v) => s + v, 0);
    metrics[m] = {
      latest_value: latest.value,
      latest_at: latest.recorded_at,
      sample_count: subset.length,
      mean: sum / sortedValues.length,
      min: sortedValues[0]!,
      p50: linearPercentile(sortedValues, 0.5)!,
      p95: linearPercentile(sortedValues, 0.95)!,
      max: sortedValues[sortedValues.length - 1]!,
    };
  }
  return {
    tenant_id,
    model_id,
    sample_size: entries.length,
    metrics,
  };
}

// ─── Store ────────────────────────────────────────────────────────────

export interface PerformanceFilter {
  metric?: PerformanceMetric;
  since?: string;
  until?: string;
}

export interface ModelPerformanceStore {
  record(
    tenant_id: string,
    model_id: string,
    input: unknown,
    now: Date,
  ): ModelPerformanceEntry;
  list(
    tenant_id: string,
    model_id: string,
    filter: PerformanceFilter,
  ): ModelPerformanceEntry[];
}

const CAP_PER_MODEL = 200;

export class InMemoryModelPerformanceStore implements ModelPerformanceStore {
  /** (tenant_id, model_id) → entries[]. */
  private readonly perKey = new Map<string, ModelPerformanceEntry[]>();
  private readonly registry: AiModelRegistry;

  constructor(registry: AiModelRegistry) {
    this.registry = registry;
  }

  private key(tenant_id: string, model_id: string): string {
    return `${tenant_id}::${model_id}`;
  }

  private bucket(tenant_id: string, model_id: string): ModelPerformanceEntry[] {
    const k = this.key(tenant_id, model_id);
    let arr = this.perKey.get(k);
    if (!arr) {
      arr = [];
      this.perKey.set(k, arr);
    }
    return arr;
  }

  record(
    tenant_id: string,
    model_id: string,
    input: unknown,
    now: Date,
  ): ModelPerformanceEntry {
    if (!this.registry.get(model_id)) {
      throw new ModelPerformanceError(
        'unknown_model',
        `model ${model_id} not in registry`,
      );
    }
    const valid = validate(input);
    const arr = this.bucket(tenant_id, model_id);
    const entry: ModelPerformanceEntry = {
      entry_id: `mpe-${randomUUID()}`,
      tenant_id,
      model_id,
      metric: valid.metric,
      value: valid.value,
      sample_size: valid.sample_size,
      notes: valid.notes ?? '',
      recorded_at: now.toISOString(),
    };
    arr.push(entry);
    if (arr.length > CAP_PER_MODEL) {
      arr.splice(0, arr.length - CAP_PER_MODEL);
    }
    return { ...entry };
  }

  list(
    tenant_id: string,
    model_id: string,
    filter: PerformanceFilter,
  ): ModelPerformanceEntry[] {
    if (!this.registry.get(model_id)) {
      throw new ModelPerformanceError(
        'unknown_model',
        `model ${model_id} not in registry`,
      );
    }
    const arr = this.perKey.get(this.key(tenant_id, model_id)) ?? [];
    return arr
      .filter((e) => {
        if (filter.metric && e.metric !== filter.metric) return false;
        if (filter.since && e.recorded_at < filter.since) return false;
        if (filter.until && e.recorded_at >= filter.until) return false;
        return true;
      })
      .map((e) => ({ ...e }));
  }
}

export {
  CAP_PER_MODEL as MODEL_PERFORMANCE_CAP,
};
