// services/bff/__tests__/ifrs9_http_adapter.test.ts
//
// T3.2 — HttpIfrs9Adapter unit tests against an injected fetch stub.
// Real bank IFRS9 source URL is the only external blocker — contract is
// validated today.

import {
  HttpIfrs9Adapter,
  makeIfrs9Adapter,
} from "../src/integrations/ifrs9_http_adapter";

function makeFetchStub(
  handler: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => { status: number; body?: unknown },
): typeof fetch {
  const impl = async (input: unknown, init: unknown = {}) => {
    const url = typeof input === "string" ? input : String(input);
    const i = init as { method?: string; headers?: Record<string, string>; body?: string };
    const result = handler(url, i);
    const text = result.body === undefined ? "" : JSON.stringify(result.body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => text,
      headers: new Headers(),
    } as unknown as Response;
  };
  return impl as unknown as typeof fetch;
}

describe("HttpIfrs9Adapter", () => {
  const baseUrl = "https://ifrs9.bank.internal/api/v1";
  const tenant = "BANK_DEMO";
  const asOf = new Date("2026-05-21T00:00:00Z");

  it("requires baseUrl or IFRS9_BASE_URL env", () => {
    expect(() => new HttpIfrs9Adapter({})).toThrow(/IFRS9_BASE_URL/);
  });

  it("getStage GET /ifrs9/stages/:customer_id; returns null on 404", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "tok",
      fetchImpl: makeFetchStub((url) => {
        expect(url).toBe(`${baseUrl}/ifrs9/stages/c-404`);
        return { status: 404 };
      }),
    });

    const res = await adapter.getStage(tenant, "c-404", asOf);
    expect(res).toBeNull();
  });

  it("getStage normalises bank response shape", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "tok",
      fetchImpl: makeFetchStub(() => ({
        status: 200,
        body: {
          customer_id: "c-100001",
          stage: 2,
          pd_12m: 0.08,
          pd_lifetime: 0.15,
          lgd: 0.45,
          ead_kes: 2_000_000,
          dpd_days: 45,
          stage_reason: "watchlist flag raised",
          evaluation_date: "2026-05-20T12:00:00Z",
        },
      })),
    });

    const stage = await adapter.getStage(tenant, "c-100001", asOf);
    expect(stage).not.toBeNull();
    expect(stage!.stage).toBe(2);
    expect(stage!.pd_12m).toBeCloseTo(0.08);
    expect(stage!.pd_lifetime).toBeCloseTo(0.15);
    // ECL = driver_PD × LGD × EAD; Stage 2 driver = pd_lifetime
    expect(stage!.ecl_kes).toBe(Math.round(0.15 * 0.45 * 2_000_000));
  });

  it("getStage clamps PDs and LGD to [0,1]", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub(() => ({
        status: 200,
        body: {
          customer_id: "c-100002",
          stage: 1,
          pd_12m: -0.5,
          pd_lifetime: 1.5,
          lgd: 2.0,
          ead_kes: -100,
        },
      })),
    });

    const stage = await adapter.getStage(tenant, "c-100002", asOf);
    expect(stage!.pd_12m).toBe(0);
    expect(stage!.pd_lifetime).toBe(1);
    expect(stage!.lgd).toBe(1);
    expect(stage!.ead_kes).toBe(0);
  });

  it("getStage enforces pd_lifetime ≥ pd_12m invariant", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub(() => ({
        status: 200,
        body: {
          customer_id: "c-100003",
          stage: 2,
          pd_12m: 0.2,
          pd_lifetime: 0.1, // smaller than 12m — must be raised
          lgd: 0.4,
          ead_kes: 1_000_000,
        },
      })),
    });

    const stage = await adapter.getStage(tenant, "c-100003", asOf);
    expect(stage!.pd_lifetime).toBeGreaterThanOrEqual(stage!.pd_12m);
  });

  it("Stage 1 ECL uses pd_12m as driver", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub(() => ({
        status: 200,
        body: {
          customer_id: "c-1",
          stage: 1,
          pd_12m: 0.02,
          pd_lifetime: 0.10,
          lgd: 0.5,
          ead_kes: 1_000_000,
        },
      })),
    });
    const stage = await adapter.getStage(tenant, "c-1", asOf);
    expect(stage!.ecl_kes).toBe(Math.round(0.02 * 0.5 * 1_000_000));
  });

  it("Stage 2/3 ECL uses pd_lifetime as driver", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub(() => ({
        status: 200,
        body: {
          customer_id: "c-1",
          stage: 3,
          pd_12m: 0.3,
          pd_lifetime: 0.9,
          lgd: 0.6,
          ead_kes: 500_000,
        },
      })),
    });
    const stage = await adapter.getStage(tenant, "c-1", asOf);
    expect(stage!.ecl_kes).toBe(Math.round(0.9 * 0.6 * 500_000));
  });

  it("listStages forwards stage + pagination as query params", async () => {
    let capturedUrl = "";
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub((url) => {
        capturedUrl = url;
        return {
          status: 200,
          body: { items: [], total: 0, page: 1, page_size: 50 },
        };
      }),
    });

    await adapter.listStages(tenant, { stage: 2, page: 1, page_size: 50 }, asOf);
    expect(capturedUrl).toBe(`${baseUrl}/ifrs9/inputs?stage=2&page=1&page_size=50`);
  });

  it("listStages normalises every item + carries stage_filter back", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub(() => ({
        status: 200,
        body: {
          items: [
            { customer_id: "c-1", stage: 1, pd_12m: 0.01, pd_lifetime: 0.05, lgd: 0.3, ead_kes: 100 },
            { customer_id: "c-2", stage: 3, pd_12m: 0.4, pd_lifetime: 0.8, lgd: 0.7, ead_kes: 200 },
          ],
          total: 2,
          page: 1,
          page_size: 50,
        },
      })),
    });

    const page = await adapter.listStages(tenant, { stage: 3 }, asOf);
    expect(page.items.length).toBe(2);
    expect(page.items[0].customer_id).toBe("c-1");
    expect(page.items[1].customer_id).toBe("c-2");
    expect(page.stage_filter).toBe(3);
  });

  it("listStages returns empty page on 404", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub(() => ({ status: 404 })),
    });

    const page = await adapter.listStages(tenant, {}, asOf);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("propagates 5xx errors as Error (so ResilientCbsClient can retry at a higher layer)", async () => {
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => "",
      fetchImpl: makeFetchStub(() => ({ status: 500, body: { message: "bank downstream timeout" } })),
    });

    await expect(adapter.getStage(tenant, "c-1", asOf)).rejects.toThrow(/500/);
  });

  it("attaches Bearer header per request (supports token rotation)", async () => {
    let counter = 0;
    let capturedAuth = "";
    const adapter = new HttpIfrs9Adapter({
      baseUrl,
      authToken: () => `token-${++counter}`,
      fetchImpl: makeFetchStub((_u, init) => {
        capturedAuth = (init.headers as Record<string, string>).Authorization;
        return { status: 200, body: {} };
      }),
    });
    await adapter.getStage(tenant, "c-1", asOf);
    const first = capturedAuth;
    await adapter.getStage(tenant, "c-2", asOf);
    const second = capturedAuth;
    expect(first).not.toBe(second);
  });
});

describe("makeIfrs9Adapter factory", () => {
  const orig = process.env.IFRS9_BASE_URL;
  afterAll(() => {
    if (orig === undefined) delete process.env.IFRS9_BASE_URL;
    else process.env.IFRS9_BASE_URL = orig;
  });

  it("returns HttpIfrs9Adapter when IFRS9_BASE_URL is set", () => {
    process.env.IFRS9_BASE_URL = "https://ifrs9.test.internal";
    const a = makeIfrs9Adapter(process.env);
    expect(a).toBeInstanceOf(HttpIfrs9Adapter);
  });

  it("throws when IFRS9_BASE_URL is unset", () => {
    delete process.env.IFRS9_BASE_URL;
    expect(() => makeIfrs9Adapter({})).toThrow(/IFRS9_BASE_URL not set/);
  });
});
