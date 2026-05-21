// mobile/src/api/investigations.ts
//
// Investigation step progress for the case-view screen. Reuses M9.1
// investigation endpoints.

import type { ApiClient } from './client';
import type { MobileInvestigationStep } from '../types';

export interface MobileInvestigation {
  investigation_id: string;
  case_id: string;
  status: string;
  decision: string | null;
  opened_at: string;
  closed_at: string | null;
  steps: MobileInvestigationStep[];
  notes_count?: number;
}

export class InvestigationsApi {
  constructor(private readonly client: ApiClient) {}

  async listByCase(case_id: string): Promise<{
    total: number;
    items: MobileInvestigation[];
  }> {
    return this.client.get<{ total: number; items: MobileInvestigation[] }>(
      '/v1/investigations',
      { case_id },
    );
  }

  async get(investigation_id: string): Promise<MobileInvestigation> {
    return this.client.get<MobileInvestigation>(
      `/v1/investigations/${encodeURIComponent(investigation_id)}`,
    );
  }

  /** Mark an investigation step as complete (mobile field officer flow). */
  async completeStep(
    investigation_id: string,
    step_id: string,
    evidence_link?: string,
  ): Promise<MobileInvestigation> {
    return this.client.post<MobileInvestigation>(
      `/v1/investigations/${encodeURIComponent(investigation_id)}/steps/${encodeURIComponent(step_id)}/complete`,
      { evidence_link },
    );
  }

  async addNote(investigation_id: string, body: string): Promise<{ note_id: string }> {
    return this.client.post<{ note_id: string }>(
      `/v1/investigations/${encodeURIComponent(investigation_id)}/notes`,
      { body },
    );
  }
}
