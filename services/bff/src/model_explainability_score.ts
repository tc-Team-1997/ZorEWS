// services/bff/src/model_explainability_score.ts
// T6 M7.29 — AI model explainability score.

import { defaultAiModelRegistry, type AiModelRegistry, type ModelVersion } from './ai_model_registry';

export type InterpretabilityGrade = 'A' | 'B' | 'C' | 'D';

export interface ModelExplainabilityRow {
  model_id: string;
  name: string;
  type: string;
  framework: string;
  explainability_score: number;
  has_shap_support: boolean;
  interpretability_grade: InterpretabilityGrade;
}

export interface ModelExplainabilityResult {
  tenant_id: string;
  generated_at: string;
  models: ModelExplainabilityRow[];
  avg_explainability: number;
  most_explainable_model: string | null;
  black_box_models: string[];
}

const TYPE_BASE: Record<string, number> = {
  pd: 80,
  churn: 75,
  fraud: 70,
  lapse: 65,
  claim_severity: 55,
  anomaly: 40,
};

const FRAMEWORK_DELTA: Record<string, number> = {
  xgboost: 15,
  sklearn: 10,
  lightgbm: 10,
  torch: -10,
  isolation_forest: -20,
};

const SHAP_FRAMEWORKS = new Set(['xgboost', 'sklearn', 'lightgbm']);

function gradeFor(score: number): InterpretabilityGrade {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

export async function buildModelExplainabilityScore(
  tenant_id: string,
  now: Date,
  registry: AiModelRegistry = defaultAiModelRegistry,
): Promise<ModelExplainabilityResult> {
  if (!tenant_id) throw new Error('tenant_id required');

  const all: ModelVersion[] = await registry.list({});

  const rows: ModelExplainabilityRow[] = all.map((m) => {
    const typeBase = TYPE_BASE[m.type] ?? 50;
    const frameworkDelta = FRAMEWORK_DELTA[m.framework] ?? 0;
    const featureBonus = Math.min(20, (m.key_features?.length ?? 0) * 2);
    const explainability_score = Math.max(0, Math.min(100, typeBase + frameworkDelta + featureBonus));
    const has_shap_support = SHAP_FRAMEWORKS.has(m.framework);

    return {
      model_id: m.model_id,
      name: m.name,
      type: m.type,
      framework: m.framework,
      explainability_score,
      has_shap_support,
      interpretability_grade: gradeFor(explainability_score),
    };
  });

  rows.sort((a, b) => b.explainability_score - a.explainability_score);

  const avg_explainability =
    rows.length === 0
      ? 0
      : Math.round(rows.reduce((s, r) => s + r.explainability_score, 0) / rows.length);

  const most_explainable_model = rows[0]?.model_id ?? null;
  const black_box_models = rows
    .filter((r) => r.interpretability_grade === 'D')
    .map((r) => r.model_id);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    models: rows,
    avg_explainability,
    most_explainable_model,
    black_box_models,
  };
}
