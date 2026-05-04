// services/collection-adapter/src/cases_client.ts
//
// Thin HTTP client to the cases service. Used by the /collection/callback
// handler to translate a Collection status report into a case-close call.

import type { Outcome } from './types';

export class CasesClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'CasesClientError';
  }
}

export interface CasesClient {
  close(case_id: string, outcome: Outcome, note?: string | null): Promise<unknown>;
}

export class HttpCasesClient implements CasesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async close(case_id: string, outcome: Outcome, note?: string | null): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/cases/${encodeURIComponent(case_id)}/close`;
    const r = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome, note: note ?? null }),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    if (!r.ok) {
      const msg =
        (body as { error?: string } | null)?.error ?? `cases-svc returned ${r.status}`;
      throw new CasesClientError(r.status, msg, body);
    }
    return body;
  }
}

export class UnavailableCasesClient implements CasesClient {
  async close(): Promise<unknown> {
    throw new CasesClientError(503, 'cases service is not configured (set APEX_CASES_URL)');
  }
}

export function makeCasesClient(env: NodeJS.ProcessEnv = process.env): CasesClient {
  if (!env.APEX_CASES_URL) return new UnavailableCasesClient();
  return new HttpCasesClient(env.APEX_CASES_URL);
}
