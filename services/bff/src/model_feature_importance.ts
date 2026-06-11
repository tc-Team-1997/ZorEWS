// services/bff/src/model_feature_importance.ts
// T6 M7.27 — Model feature importance tracking.
// Lists key_features per production model with synthesized importance scores.

import { defaultAiModelRegistry } from './ai_model_registry';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FeatureImportanceEntry {
  name: string;
  importance: number; // normalized to sum to 1.0 across features
  rank: number;
}

export interface ModelFeatureImportanceEntry {
  model_id: string;
  name: string;
  type: string;
  features: FeatureImportanceEntry[];
  top_feature: string | null;
  feature_count: number;
}

export interface ModelFeatureImportanceResult {
  tenant_id: string;
  generated_at: string;
  models: ModelFeatureImportanceEntry[];
  most_feature_rich_model: string | null; // most key_features
}

export function buildModelFeatureImportance(
  tenant_id: string,
  now: Date,
): ModelFeatureImportanceResult {
  if (!tenant_id) throw new Error('tenant_id required');

  // Get all production models
  const allModels = defaultAiModelRegistry.list({ status: 'production' });

  const models: ModelFeatureImportanceEntry[] = allModels.map((model) => {
    const featureNames = model.key_features ?? [];

    if (featureNames.length === 0) {
      return {
        model_id: model.model_id,
        name: model.name,
        type: model.type,
        features: [],
        top_feature: null,
        feature_count: 0,
      };
    }

    // Generate raw importances per feature
    const rawImportances = featureNames.map((fname) => {
      const seed = fnv1a(`${tenant_id}:${model.model_id}:feat_imp:${fname}`);
      const rng = mulberry32(seed);
      return 0.05 + rng() * 0.45; // [0.05, 0.50)
    });

    const totalRaw = rawImportances.reduce((s, v) => s + v, 0);

    const features: FeatureImportanceEntry[] = featureNames.map((fname, idx) => ({
      name: fname,
      importance: Math.round((rawImportances[idx] / totalRaw) * 10000) / 10000,
      rank: 0, // set after sort
    }));

    // Sort by importance desc, name asc tie-break
    features.sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name));
    features.forEach((f, idx) => { f.rank = idx + 1; });

    return {
      model_id: model.model_id,
      name: model.name,
      type: model.type,
      features,
      top_feature: features.length > 0 ? features[0].name : null,
      feature_count: features.length,
    };
  });

  // most_feature_rich_model = highest feature_count, model_id asc tie-break
  let mostFeatureRich: string | null = null;
  if (models.length > 0) {
    const sorted = [...models].sort(
      (a, b) => b.feature_count - a.feature_count || a.model_id.localeCompare(b.model_id),
    );
    mostFeatureRich = sorted[0].feature_count > 0 ? sorted[0].model_id : null;
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    models,
    most_feature_rich_model: mostFeatureRich,
  };
}
