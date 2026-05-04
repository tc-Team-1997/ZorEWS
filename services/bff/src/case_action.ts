// services/bff/src/case_action.ts
//
// CaseActionSink — forwards `/v1/action` POSTs to the regulatory-svc/cases
// service. The cases service owns the state machine; the BFF is just a
// thin proxy that surfaces the public-API endpoint.

export interface CaseActionInput {
  case_id: string;
  kind: 'call' | 'visit' | 'sms' | 'email' | 'note';
  officer_id: string;
  outcome_note?: string | null;
  gps?: { lat: number; lng: number; accuracy_m?: number | null } | null;
  /** T4.24 Phase 5 — propagated to regulatory-svc/cases as X-Tenant-ID
   *  so the cases service can scope its store reads/writes. */
  tenant_id?: string;
  /** T4.24 Phase 5 — propagated as X-Channel for the audit trail. */
  channel?: string;
}

/** What the cases service returns from POST /cases/:id/actions. We don't
 *  retype the whole Case here — the BFF passes it through unchanged. */
export type CaseSnapshot = Record<string, unknown>;

export class CaseActionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'CaseActionError';
  }
}

export interface CaseActionSink {
  log(input: CaseActionInput): Promise<CaseSnapshot>;
}

/** HTTP proxy via global fetch (Node 18+ ships it). */
export class HttpCaseActionSink implements CaseActionSink {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async log(input: CaseActionInput): Promise<CaseSnapshot> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/cases/${encodeURIComponent(input.case_id)}/actions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (input.tenant_id) headers['X-Tenant-ID'] = input.tenant_id;
    if (input.channel) headers['X-Channel'] = input.channel;
    const r = await this.fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: input.kind,
        officer_id: input.officer_id,
        outcome_note: input.outcome_note ?? null,
        gps: input.gps ?? null,
      }),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // body might be empty; that's fine for non-2xx
    }
    if (!r.ok) {
      const msg =
        (body as { error?: string } | null)?.error ?? `cases-svc returned ${r.status}`;
      throw new CaseActionError(r.status, msg, body);
    }
    return (body as CaseSnapshot) ?? {};
  }
}

/** Test/dev fallback when no upstream is configured. */
export class UnavailableCaseActionSink implements CaseActionSink {
  async log(): Promise<CaseSnapshot> {
    throw new CaseActionError(
      503,
      'cases service is not configured (set APEX_CASES_URL)',
    );
  }
}

export function makeCaseActionSink(env: NodeJS.ProcessEnv = process.env): CaseActionSink {
  if (!env.APEX_CASES_URL) return new UnavailableCaseActionSink();
  return new HttpCaseActionSink(env.APEX_CASES_URL);
}
