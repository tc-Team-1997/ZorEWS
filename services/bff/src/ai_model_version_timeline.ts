// services/bff/src/ai_model_version_timeline.ts
//
// T6 M7.21 — AI model version history timeline.
//
// M7.1 ships the registry catalogue. M7.21 adds a type-scoped version
// history timeline — all model versions for a given type sorted by
// trained_at desc, surface the production version, retired count,
// active (non-retired) count, and a 30-day version velocity.
//
// Useful for the BIL AI governance committee: "how fast are we
// iterating on the PD model? how many stale versions are retired?"

import {
  isModelType,
  type AiModelRegistry,
  type ModelMetrics,
  type ModelType,
  type ModelVersion,
} from './ai_model_registry';

// ─── Public types ──────────────────────────────────────────────────────

export interface ModelVersionEntry {
  model_id: string;
  name: string;
  version: string;
  status: string;
  framework: string;
  trained_at: string;
  deployed_at: string | null;
  /** How many days the model has been in its current status (from
   *  trained_at to now when not deployed; from deployed_at to now
   *  when deployed and non-retired). */
  days_in_status: number;
  metrics: ModelMetrics | null;
}

export interface ModelVersionTimeline {
  model_type: ModelType;
  generated_at: string;
  version_count: number;
  versions: ModelVersionEntry[];
  /** model_id of the current production version; null when none. */
  production_version: string | null;
  retired_count: number;
  /** Non-retired model count (experimental + staging + production + shadow). */
  active_count: number;
  /** Number of distinct model versions trained in the last 30 calendar days. */
  version_velocity_30d: number;
}

export class ModelVersionTimelineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ModelVersionTimelineError';
  }
}

// ─── Pure function ─────────────────────────────────────────────────────

export function buildModelVersionTimeline(
  model_type: string,
  registry: AiModelRegistry,
  now: Date,
): ModelVersionTimeline {
  if (!isModelType(model_type)) {
    throw new ModelVersionTimelineError(
      'invalid_type',
      `Unknown model type: ${model_type}`,
    );
  }

  const allVersions: ModelVersion[] = registry.list({ type: model_type as ModelType });

  // Sort by trained_at desc (newest first)
  const sorted = [...allVersions].sort((a, b) => {
    const ta = new Date(a.trained_at).getTime();
    const tb = new Date(b.trained_at).getTime();
    if (tb !== ta) return tb - ta;
    return a.model_id.localeCompare(b.model_id);
  });

  const nowMs = now.getTime();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  const versions: ModelVersionEntry[] = sorted.map((m) => {
    const trainedMs = new Date(m.trained_at).getTime();
    const deployedMs = m.deployed_at ? new Date(m.deployed_at).getTime() : null;
    const referenceMs = deployedMs !== null && m.status !== 'retired'
      ? deployedMs
      : trainedMs;
    const days_in_status = Math.max(
      0,
      Math.floor((nowMs - referenceMs) / (24 * 60 * 60 * 1000)),
    );
    return {
      model_id: m.model_id,
      name: m.name,
      version: m.version,
      status: m.status,
      framework: m.framework,
      trained_at: m.trained_at,
      deployed_at: m.deployed_at,
      days_in_status,
      metrics: m.metrics ?? null,
    };
  });

  // Production version: newest trained production model
  const productionVersions = sorted.filter((m) => m.status === 'production');
  const production_version =
    productionVersions.length > 0 ? productionVersions[0].model_id : null;

  const retired_count = allVersions.filter((m) => m.status === 'retired').length;
  const active_count = allVersions.filter((m) => m.status !== 'retired').length;

  const velocity_cutoff = nowMs - THIRTY_DAYS_MS;
  const version_velocity_30d = allVersions.filter(
    (m) => new Date(m.trained_at).getTime() >= velocity_cutoff,
  ).length;

  return {
    model_type: model_type as ModelType,
    generated_at: now.toISOString(),
    version_count: allVersions.length,
    versions,
    production_version,
    retired_count,
    active_count,
    version_velocity_30d,
  };
}
