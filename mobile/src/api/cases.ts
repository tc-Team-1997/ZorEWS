// mobile/src/api/cases.ts
//
// Case view + action capture. Reuses /api/cases + /v1/action.

import type { ApiClient } from './client';
import type { MobileCase, MobileCaseAction, MobileGpsCoords } from '../types';

export interface CaseListOptions {
  state?: 'open' | 'assigned' | 'in_action' | 'monitored' | 'closed';
  assignee?: string;
  customer_id?: string;
  sla?: 'on_track' | 'approaching' | 'breached' | 'closed';
  limit?: number;
}

export interface CaseListResponse {
  total: number;
  items: MobileCase[];
}

export class CasesApi {
  constructor(private readonly client: ApiClient) {}

  async list(opts: CaseListOptions = {}): Promise<CaseListResponse> {
    return this.client.get<CaseListResponse>('/api/cases', {
      state: opts.state,
      assignee: opts.assignee,
      customer_id: opts.customer_id,
      sla: opts.sla,
      limit: opts.limit !== undefined ? String(opts.limit) : undefined,
    });
  }

  async get(case_id: string): Promise<MobileCase> {
    return this.client.get<MobileCase>(`/api/cases/${encodeURIComponent(case_id)}`);
  }

  /** Submit a case-action. The BFF proxies to regulatory-svc/cases.
   *  When `gps` is supplied the action is geotagged (typical for
   *  field-officer visits). */
  async logAction(action: MobileCaseAction): Promise<{
    ok: boolean;
    case_state: MobileCase['state'];
  }> {
    return this.client.post<{ ok: boolean; case_state: MobileCase['state'] }>(
      '/v1/action',
      action,
    );
  }

  /** Geotagged visit — convenience wrapper for the GPS Capture screen. */
  async logVisit(
    case_id: string,
    officer_id: string,
    outcome_note: string,
    gps: MobileGpsCoords,
  ): Promise<{ ok: boolean; case_state: MobileCase['state'] }> {
    return this.logAction({
      case_id,
      kind: 'visit',
      officer_id,
      outcome_note,
      gps,
    });
  }
}
