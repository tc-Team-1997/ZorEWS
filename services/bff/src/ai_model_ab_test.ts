// services/bff/src/ai_model_ab_test.ts
//
// T6 M7.3 — Model A/B test harness.
//
// M7.1 ships the model registry; M7.2 ships the promotion state
// machine. M7.3 ships the A/B comparison primitive: score the
// SAME (customer, features) input against TWO model versions and
// return both results plus a delta summary. Drives the SPA's
// "candidate vs champion" pre-promotion screen.
//
// Pure function. Both models must already exist in the registry;
// promotion-state restrictions don't apply here (you can compare
// retired ↔ shadow, etc. — comparison is read-only).

import {
  type AiModelRegistry,
  type InferenceInput,
  type InferenceResult,
  type ModelVersion,
  ModelRegistryError,
} from './ai_model_registry';

export interface AbTestInput extends InferenceInput {
  champion_model_id: string;
  candidate_model_id: string;
}

export interface AbTestResult {
  champion: { model: ModelVersion; result: InferenceResult };
  candidate: { model: ModelVersion; result: InferenceResult };
  /** candidate.score - champion.score (sign matters; positive
   *  means candidate scored higher). */
  score_delta: number;
  /** Probability delta when both models surface a probability. */
  probability_delta: number | null;
  /** True iff both ended up in the same band (low/medium/high). */
  band_match: boolean;
  /** True iff models are of the same type — comparing across types
   *  is allowed but the band/probability deltas may not be
   *  meaningful. */
  type_match: boolean;
  scored_at: string;
}

export class AbTestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AbTestError';
  }
}

export function runAbTest(
  registry: AiModelRegistry,
  input: AbTestInput,
  tenant_id: string,
  asOf: Date,
): AbTestResult {
  if (!input || typeof input !== 'object') {
    throw new AbTestError('invalid_input', 'request body required');
  }
  if (!input.champion_model_id || typeof input.champion_model_id !== 'string') {
    throw new AbTestError('invalid_input', 'champion_model_id is required');
  }
  if (!input.candidate_model_id || typeof input.candidate_model_id !== 'string') {
    throw new AbTestError('invalid_input', 'candidate_model_id is required');
  }
  if (input.champion_model_id === input.candidate_model_id) {
    throw new AbTestError('invalid_input', 'champion and candidate must differ');
  }
  if (!input.customer_id || typeof input.customer_id !== 'string') {
    throw new AbTestError('invalid_input', 'customer_id is required');
  }

  const champion = registry.get(input.champion_model_id);
  if (!champion) {
    throw new AbTestError(
      'unknown_model',
      `champion model ${input.champion_model_id} not found`,
    );
  }
  const candidate = registry.get(input.candidate_model_id);
  if (!candidate) {
    throw new AbTestError(
      'unknown_model',
      `candidate model ${input.candidate_model_id} not found`,
    );
  }

  const inferenceInput: InferenceInput = {
    customer_id: input.customer_id,
    features: input.features,
  };

  let champResult: InferenceResult;
  let candResult: InferenceResult;
  try {
    champResult = registry.score(champion.model_id, inferenceInput, tenant_id, asOf);
  } catch (e) {
    if (e instanceof ModelRegistryError) {
      throw new AbTestError('inference_failed', `champion: ${e.message}`);
    }
    throw e;
  }
  try {
    candResult = registry.score(candidate.model_id, inferenceInput, tenant_id, asOf);
  } catch (e) {
    if (e instanceof ModelRegistryError) {
      throw new AbTestError('inference_failed', `candidate: ${e.message}`);
    }
    throw e;
  }

  const probability_delta =
    champResult.probability !== null && candResult.probability !== null
      ? candResult.probability - champResult.probability
      : null;

  return {
    champion: { model: champion, result: champResult },
    candidate: { model: candidate, result: candResult },
    score_delta: candResult.score - champResult.score,
    probability_delta,
    band_match: champResult.band === candResult.band,
    type_match: champion.type === candidate.type,
    scored_at: asOf.toISOString(),
  };
}
