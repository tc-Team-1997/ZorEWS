// web/src/modules/admin/streamingLatency/api.ts
//
// T2.12.1.SPA — Streaming Latency dashboard: typed API wrappers for
// the BFF /v1/streaming/* surface shipped in T2.12.1.

import { http } from '@/lib/http';

export interface IndicatorLatencyRow {
  indicator_id: string;
  count: number;
  mean_total_ms: number;
  median_total_ms: number;
  p95_total_ms: number;
  max_total_ms: number;
  count_under_60s: number;
  percentage_under_60s: number;
}

export interface StreamingLatencySummary {
  tenant_id: string;
  generated_at: string;
  sample_size: number;
  mean_total_ms: number | null;
  median_total_ms: number | null;
  p95_total_ms: number | null;
  max_total_ms: number | null;
  min_total_ms: number | null;
  mean_processing_ms: number | null;
  p95_processing_ms: number | null;
  count_under_60s: number;
  count_over_60s: number;
  percentage_under_60s: number;
  target_p95_60s_met: boolean;
  by_indicator: IndicatorLatencyRow[];
  total_indicators: number;
  most_recent_at: string | null;
  oldest_at: string | null;
}

export interface StreamingProcessingRecord {
  event_id: string;
  tenant_id: string;
  indicator_id: string;
  customer_id: string;
  observed_at: string;
  received_at: string;
  processed_at: string;
  ingest_latency_ms: number;
  processing_latency_ms: number;
  total_latency_ms: number;
  fired_alert_ids: string[];
  fired_rule_ids: string[];
}

export interface StreamingEventsResponse {
  tenant_id: string;
  total: number;
  events: StreamingProcessingRecord[];
}

export const streamingLatencyApi = {
  summary: (limit?: number) =>
    http
      .get<StreamingLatencySummary>('/v1/streaming/latency', {
        params: limit ? { limit } : undefined,
      })
      .then((r) => r.data),

  events: (limit: number = 50) =>
    http
      .get<StreamingEventsResponse>('/v1/streaming/events', { params: { limit } })
      .then((r) => r.data),
};
