// web/src/modules/admin/featureStore/api.ts
//
// T2.1.2 — SPA Feature Store explorer: typed API wrappers for the BFF
// `/v1/feature-store/*` surface (T2.1.1).

import { http } from '@/lib/http';

export const ALL_FEATURE_NAMES = [
  'utilization',
  'dpd_max_90d',
  'bureau_score',
  'repayment_delay_streak',
  'txn_volume_zscore_90d',
  'tenure_months',
  'product_level',
  'income_level',
] as const;

export type FeatureName = (typeof ALL_FEATURE_NAMES)[number];

export type FeatureValueType = 'number' | 'integer' | 'enum';
export type RiskPolarity = 'higher_is_worse' | 'lower_is_worse' | 'neutral';

export interface FeatureDef {
  name: FeatureName;
  display_name: string;
  description: string;
  value_type: FeatureValueType;
  range: [number, number];
  enum_labels: ReadonlyArray<string>;
  risk_polarity: RiskPolarity;
}

export interface FeatureCatalogResponse {
  tenant_id: string;
  total_features: number;
  features: FeatureDef[];
}

export interface FeatureCoverageResponse {
  tenant_id: string;
  generated_at: string;
  catalog_size: number;
  earliest_observed_at: string;
  latest_observed_at: string;
  window_days: number;
  total_entities_seeded: number | 'unbounded_synthetic';
  features: FeatureDef[];
}

export interface FeatureSnapshotRow {
  entity_id: string;
  observed_at: string;
  features: Record<FeatureName, number>;
}

export interface FeatureHistoryPoint {
  observed_at: string;
  value: number;
}

export type FeatureTrend = 'rising' | 'falling' | 'flat' | null;

export interface FeatureHistory {
  tenant_id: string;
  entity_id: string;
  feature_name: FeatureName;
  since: string;
  until: string;
  count: number;
  points: FeatureHistoryPoint[];
  min: number | null;
  max: number | null;
  mean: number | null;
  first_value: number | null;
  last_value: number | null;
  trend: FeatureTrend;
}

// ─── API ──────────────────────────────────────────────────────────────

export const featureStoreApi = {
  catalog: () =>
    http.get<FeatureCatalogResponse>('/v1/feature-store/catalog').then((r) => r.data),

  coverage: () =>
    http.get<FeatureCoverageResponse>('/v1/feature-store/coverage').then((r) => r.data),

  snapshot: (customer_id: string, at?: string) =>
    http
      .get<FeatureSnapshotRow>(
        `/v1/feature-store/customers/${encodeURIComponent(customer_id)}/snapshot`,
        { params: at ? { at } : undefined },
      )
      .then((r) => r.data),

  history: (
    customer_id: string,
    feature_name: FeatureName,
    opts?: { since?: string; until?: string },
  ) =>
    http
      .get<FeatureHistory>(
        `/v1/feature-store/customers/${encodeURIComponent(customer_id)}/history`,
        {
          params: {
            feature_name,
            ...(opts?.since ? { since: opts.since } : {}),
            ...(opts?.until ? { until: opts.until } : {}),
          },
        },
      )
      .then((r) => r.data),
};
