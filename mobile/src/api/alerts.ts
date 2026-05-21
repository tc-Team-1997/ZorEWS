// mobile/src/api/alerts.ts
//
// Alert list + ack + per-customer linked-alerts queries. Reuses
// existing /v1/alerts + /v1/alerts/:id/ack endpoints — no new
// server surface.

import type { ApiClient } from './client';
import type { AlertSeverity, MobileAlert } from '../types';

export interface AlertListOptions {
  severity?: AlertSeverity;
  status?: 'open' | 'acknowledged' | 'closed';
  customer_id?: string;
  sort?: 'criticality' | 'severity' | 'age';
  dedup?: boolean;
  limit?: number;
}

export interface AlertListResponse {
  tenant_id?: string;
  generated_at?: string;
  total: number;
  items: MobileAlert[];
}

export interface AlertAckHistoryItem {
  ts: string;
  action: 'acknowledged' | 'unacknowledged';
  actor_username: string;
  notes: string | null;
}

export interface AlertAckState {
  alert_id: string;
  status: 'open' | 'acknowledged';
  acked_by: string | null;
  acked_at: string | null;
  ack_notes: string | null;
  history?: AlertAckHistoryItem[];
}

export class AlertsApi {
  constructor(private readonly client: ApiClient) {}

  async list(opts: AlertListOptions = {}): Promise<AlertListResponse> {
    return this.client.get<AlertListResponse>('/v1/alerts', {
      severity: opts.severity,
      status: opts.status,
      customer_id: opts.customer_id,
      sort: opts.sort ?? 'criticality',
      dedup: opts.dedup !== undefined ? String(opts.dedup) : undefined,
      limit: opts.limit !== undefined ? String(opts.limit) : undefined,
    });
  }

  async getAckState(alert_id: string): Promise<AlertAckState> {
    return this.client.get<AlertAckState>(`/v1/alerts/${encodeURIComponent(alert_id)}/ack`);
  }

  /** Acknowledge an alert. Mobile interceptor populates X-APEX-USER. */
  async acknowledge(alert_id: string, notes?: string): Promise<AlertAckState> {
    return this.client.post<AlertAckState>(`/v1/alerts/${encodeURIComponent(alert_id)}/ack`, {
      notes,
    });
  }

  async unacknowledge(alert_id: string, reason: string): Promise<AlertAckState> {
    return this.client.post<AlertAckState>(`/v1/alerts/${encodeURIComponent(alert_id)}/unack`, {
      reason,
    });
  }
}
