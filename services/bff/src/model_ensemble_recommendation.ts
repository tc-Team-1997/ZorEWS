// services/bff/src/model_ensemble_recommendation.ts
// T6 M7.30 — Model ensemble recommendation

import { type AiModelRegistry, type ModelType } from './ai_model_registry';

const ALL_MODEL_TYPES: ModelType[] = ['pd', 'fraud', 'churn', 'lapse', 'anomaly', 'claim_severity'];

export interface EnsembleRecommendation {
  type: ModelType;
  recommendation: 'ensemble' | 'single_model' | 'retrain_needed';
  models_available: number;
  ensemble_benefit_estimate: number;
  primary_model_id: string | null;
  secondary_model_id: string | null;
}

export interface ModelEnsembleRecommendation {
  tenant_id: string;
  generated_at: string;
  by_type: EnsembleRecommendation[];
  types_ready_for_ensemble: number;
  types_needing_retraining: number;
}

export function buildModelEnsembleRecommendation(
  registry: AiModelRegistry,
  now: Date
): ModelEnsembleRecommendation {
  const generated_at = now.toISOString();

  const by_type: EnsembleRecommendation[] = ALL_MODEL_TYPES.map((type) => {
    const allVersions = registry.list({ type });
    const nonRetired = allVersions.filter((m) => m.status !== 'retired');
    const count = nonRetired.length;

    // Sort by AUC (for binary) or recency
    const sorted = nonRetired.slice().sort((a, b) => {
      const aAuc = a.metrics?.auc ?? 0;
      const bAuc = b.metrics?.auc ?? 0;
      if (bAuc !== aAuc) return bAuc - aAuc;
      return b.trained_at > a.trained_at ? 1 : -1;
    });

    if (count === 0) {
      return {
        type,
        recommendation: 'retrain_needed',
        models_available: 0,
        ensemble_benefit_estimate: 0,
        primary_model_id: null,
        secondary_model_id: null,
      };
    }

    if (count === 1) {
      return {
        type,
        recommendation: 'single_model',
        models_available: 1,
        ensemble_benefit_estimate: 0,
        primary_model_id: sorted[0]!.model_id,
        secondary_model_id: null,
      };
    }

    // Ensemble: +5% AUC estimate
    const primaryAuc = sorted[0]!.metrics?.auc ?? 0;
    const ensemble_benefit_estimate = primaryAuc > 0 ? Math.round(primaryAuc * 0.05 * 10000) / 10000 : 0.05;

    return {
      type,
      recommendation: 'ensemble',
      models_available: count,
      ensemble_benefit_estimate,
      primary_model_id: sorted[0]!.model_id,
      secondary_model_id: sorted[1]!.model_id,
    };
  });

  const types_ready_for_ensemble = by_type.filter((t) => t.recommendation === 'ensemble').length;
  const types_needing_retraining = by_type.filter((t) => t.recommendation === 'retrain_needed').length;

  return {
    tenant_id: '',
    generated_at,
    by_type,
    types_ready_for_ensemble,
    types_needing_retraining,
  };
}
