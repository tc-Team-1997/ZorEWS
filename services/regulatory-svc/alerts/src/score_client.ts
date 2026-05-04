// services/regulatory-svc/alerts/src/score_client.ts
//
// Thin HTTP client for ai-copilot-svc POST /score.
// In production the alert producer wires this to the in-cluster service.
// In dev / tests the client is mockable: pass a {fetch} override.
//
// The alert producer treats the score as best-effort: if the call fails or
// times out, we proceed with the rule severity alone (score → null).

import type { ScoreResponse } from './types';

export interface ScoreClient {
  score(features: Record<string, unknown>): Promise<ScoreResponse | null>;
}

export interface HttpScoreClientOptions {
  /** Base URL of ai-copilot-svc, e.g. http://ai-copilot-svc.apex.svc.cluster.local:8080 */
  baseUrl: string;
  /** Network timeout (ms). Defaults to 1500ms — alert latency budget is 60s P95 (NFR-PERF-1) but the rest of the merge is local. */
  timeoutMs?: number;
  /** Inject for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class HttpScoreClient implements ScoreClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpScoreClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  }

  async score(features: Record<string, unknown>): Promise<ScoreResponse | null> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(`${this.baseUrl}/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(features),
        signal: controller.signal,
      });
      if (!r.ok) return null;
      return (await r.json()) as ScoreResponse;
    } catch {
      // Best-effort — never block alert emission on a score outage.
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}

/** Stub client for tests / offline dev. Returns whatever the user provides. */
export class StubScoreClient implements ScoreClient {
  constructor(private readonly response: ScoreResponse | null) {}
  async score(_features: Record<string, unknown>): Promise<ScoreResponse | null> {
    return this.response;
  }
}
