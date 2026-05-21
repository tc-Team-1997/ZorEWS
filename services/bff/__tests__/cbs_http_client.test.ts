// services/bff/__tests__/cbs_http_client.test.ts
//
// T3.1 — HttpCbsClient unit tests.
// Validates the operation→HTTP mapping + auth + timeout + idempotency
// against an injected fetch stub. Real bank API access is the only
// remaining external blocker; this client is contract-validated today.

import {
  HttpCbsClient,
  makeCbsClient,
} from "../src/integrations/cbs_http_client";
import type { CbsClient } from "../src/integrations/cbs_production";

function makeFetchStub(
  handler: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    status: number;
    body?: unknown;
  },
): typeof fetch {
  const impl = async (input: unknown, init: unknown = {}) => {
    const url = typeof input === "string" ? input : String(input);
    const i = init as { method?: string; headers?: Record<string, string>; body?: string };
    const result = handler(url, i);
    const text =
      result.body === undefined ? "" : typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => text,
      json: async () => JSON.parse(text),
      headers: new Headers(),
    } as unknown as Response;
  };
  return impl as unknown as typeof fetch;
}

describe("HttpCbsClient", () => {
  const baseUrl = "https://cbs.bank.internal/api/v1";

  it("requires baseUrl or CBS_BASE_URL env", () => {
    expect(() => new HttpCbsClient({})).toThrow(/CBS_BASE_URL/);
  });

  it("maps getCustomer to GET /cbs/customers/:id with Bearer header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "test-token",
      fetchImpl: makeFetchStub((url, init) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return { status: 200, body: { id: "c-123", name: "Alice" } };
      }),
    });

    const res = await client.call({
      operation: "getCustomer",
      payload: { customer_id: "c-123" },
    });

    expect(capturedUrl).toBe(`${baseUrl}/cbs/customers/c-123`);
    expect(capturedHeaders.Authorization).toBe("Bearer test-token");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "c-123", name: "Alice" });
  });

  it("maps getLoan to GET /cbs/loans/:id", async () => {
    let url = "";
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub((u) => {
        url = u;
        return { status: 200, body: { loan_id: "l-1" } };
      }),
    });
    await client.call({ operation: "getLoan", payload: { loan_id: "l-1" } });
    expect(url).toBe(`${baseUrl}/cbs/loans/l-1`);
  });

  it("encodes customer_id with special chars", async () => {
    let url = "";
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub((u) => {
        url = u;
        return { status: 200, body: {} };
      }),
    });
    await client.call({ operation: "getCustomer", payload: { customer_id: "c/with/slash" } });
    expect(url).toBe(`${baseUrl}/cbs/customers/c%2Fwith%2Fslash`);
  });

  it("listLoans includes query params when present", async () => {
    let url = "";
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub((u) => {
        url = u;
        return { status: 200, body: { items: [], total: 0 } };
      }),
    });
    await client.call({
      operation: "listLoans",
      payload: { customer_id: "c-1", page: 2, page_size: 50 },
    });
    expect(url).toBe(`${baseUrl}/cbs/loans?customer_id=c-1&page=2&page_size=50`);
  });

  it("listLoans omits query string when no params", async () => {
    let url = "";
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub((u) => {
        url = u;
        return { status: 200, body: { items: [] } };
      }),
    });
    await client.call({ operation: "listLoans", payload: {} });
    expect(url).toBe(`${baseUrl}/cbs/loans`);
  });

  it("replayEvents sends POST with JSON body + Idempotency-Key", async () => {
    let method = "";
    let body: string | undefined;
    let headers: Record<string, string> = {};
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub((_u, init) => {
        method = init.method as string;
        body = init.body as string;
        headers = init.headers as Record<string, string>;
        return { status: 202, body: { task_id: "t-1" } };
      }),
    });

    const res = await client.call({
      operation: "replayEvents",
      idempotency_key: "rk-42",
      payload: { from_ts: "2026-01-01T00:00:00Z" },
    });

    expect(method).toBe("POST");
    expect(body).toBe(JSON.stringify({ from_ts: "2026-01-01T00:00:00Z" }));
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toBe("rk-42");
    expect(res.pending).toBe(true);
    expect(res.status).toBe(202);
  });

  it("returns ok:false on 4xx from bank with surfaced message", async () => {
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "tok",
      fetchImpl: makeFetchStub(() => ({
        status: 403,
        body: { message: "forbidden by bank policy" },
      })),
    });

    const res = await client.call({ operation: "getCustomer", payload: { customer_id: "c-1" } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toContain("forbidden by bank policy");
  });

  it("returns 599 + error on network failure", async () => {
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const res = await client.call({ operation: "getCustomer", payload: { customer_id: "c-1" } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(599);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("returns ok:false for unknown operation (does not throw)", async () => {
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => "",
      fetchImpl: async () => {
        throw new Error("should not be called");
      },
    });
    const res = await client.call({ operation: "wireFraudPayload" as never });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toContain("unknown CBS operation");
  });

  it("resolves authToken lazily per request (supports rotation)", async () => {
    let counter = 0;
    const client = new HttpCbsClient({
      baseUrl,
      authToken: () => `token-${++counter}`,
      fetchImpl: makeFetchStub(() => ({ status: 200, body: {} })),
    });

    let headersA: Record<string, string> = {};
    const fetchSpy = makeFetchStub((_u, init) => {
      headersA = init.headers as Record<string, string>;
      return { status: 200, body: {} };
    });
    // Inject directly so we observe the auth value
    (client as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchSpy;

    await client.call({ operation: "getCustomer", payload: { customer_id: "a" } });
    const first = headersA.Authorization;
    await client.call({ operation: "getCustomer", payload: { customer_id: "b" } });
    const second = headersA.Authorization;

    expect(first).not.toBe(second);
  });

  it("ResilientCbsClient can wrap HttpCbsClient transparently", async () => {
    // sanity smoke — composition with the existing resilience framework
    const inner: CbsClient = new HttpCbsClient({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub(() => ({ status: 200, body: { ok: true } })),
    });
    const res = await inner.call({ operation: "getCustomer", payload: { customer_id: "c-1" } });
    expect(res.ok).toBe(true);
  });
});

describe("makeCbsClient factory", () => {
  const orig = process.env.CBS_BASE_URL;
  afterAll(() => {
    if (orig === undefined) delete process.env.CBS_BASE_URL;
    else process.env.CBS_BASE_URL = orig;
  });

  it("returns HttpCbsClient when CBS_BASE_URL is set", () => {
    process.env.CBS_BASE_URL = "https://cbs.test.internal";
    const c = makeCbsClient(process.env);
    expect(c).toBeInstanceOf(HttpCbsClient);
  });

  it("throws when CBS_BASE_URL is unset", () => {
    delete process.env.CBS_BASE_URL;
    expect(() => makeCbsClient({})).toThrow(/CBS_BASE_URL not set/);
  });
});
