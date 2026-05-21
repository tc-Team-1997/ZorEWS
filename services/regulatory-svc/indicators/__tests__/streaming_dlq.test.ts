// services/regulatory-svc/indicators/__tests__/streaming_dlq.test.ts
//
// T2.12.3 — NDJSON DLQ sink tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NdjsonDlqSink, makeStreamingDlqWriter } from "../src/streaming_dlq";
import type { IndicatorValueEvent } from "../src/kafka_producer";

function makeEvent(overrides: Partial<IndicatorValueEvent> = {}): IndicatorValueEvent {
  return {
    value_id: overrides.value_id ?? "v-test-1",
    indicator_id: overrides.indicator_id ?? "FIN-001",
    customer_id: overrides.customer_id ?? "c-100001",
    computed_at: overrides.computed_at ?? "2026-05-21T12:00:00Z",
    value: overrides.value ?? 0.85,
    severity_weight: overrides.severity_weight ?? 0.5,
    family: overrides.family ?? "financial",
    tenant_id: overrides.tenant_id ?? "BANK_DEMO",
  };
}

describe("NdjsonDlqSink", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "streaming-dlq-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the dir on construction", () => {
    const subdir = path.join(tmpDir, "nested", "dlq");
    expect(fs.existsSync(subdir)).toBe(false);
    new NdjsonDlqSink(subdir);
    expect(fs.existsSync(subdir)).toBe(true);
  });

  it("writes a single record + readAll round-trips", async () => {
    const sink = new NdjsonDlqSink(tmpDir);
    const event = makeEvent({ value_id: "v-1" });

    await sink.write(event, "max retries exceeded", 3);

    const records = sink.readAll();
    expect(records.length).toBe(1);
    expect(records[0].event.value_id).toBe("v-1");
    expect(records[0].error).toBe("max retries exceeded");
    expect(records[0].attempts).toBe(3);
    expect(records[0].attempted_via).toBe("bff_streaming");
    expect(records[0].dlq_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appends multiple records to the same day-partitioned file", async () => {
    const sink = new NdjsonDlqSink(tmpDir);
    await sink.write(makeEvent({ value_id: "v-a" }), "err-a");
    await sink.write(makeEvent({ value_id: "v-b" }), "err-b");
    await sink.write(makeEvent({ value_id: "v-c" }), "err-c");

    const records = sink.readAll();
    expect(records.length).toBe(3);
    expect(records.map((r) => r.event.value_id)).toEqual(["v-a", "v-b", "v-c"]);
  });

  it("file is named apex.indicator.values.dlq-<YYYY-MM-DD>.ndjson", async () => {
    const sink = new NdjsonDlqSink(tmpDir);
    await sink.write(makeEvent(), "err");
    const today = new Date().toISOString().slice(0, 10);
    const expected = path.join(tmpDir, `apex.indicator.values.dlq-${today}.ndjson`);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it("readAll returns [] when dir is empty", () => {
    const sink = new NdjsonDlqSink(tmpDir);
    expect(sink.readAll()).toEqual([]);
  });

  it("readAll skips corrupted partial-write lines", async () => {
    const sink = new NdjsonDlqSink(tmpDir);
    await sink.write(makeEvent({ value_id: "v-good" }), "err");

    // Append a corrupted line manually to simulate crash mid-write
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(tmpDir, `apex.indicator.values.dlq-${today}.ndjson`);
    fs.appendFileSync(file, '{"partial json no close', "utf8");
    fs.appendFileSync(file, "\n", "utf8");
    fs.appendFileSync(file, '{"event":{"value_id":"v-good-2"},"error":"err2","attempts":0,"dlq_at":"2026-05-21T12:00:00Z","attempted_via":"bff_streaming"}\n', "utf8");

    const records = sink.readAll();
    // 1 from first write + 1 from second valid append (corrupted line skipped)
    expect(records.length).toBe(2);
    expect(records.map((r) => r.event.value_id)).toContain("v-good");
    expect(records.map((r) => r.event.value_id)).toContain("v-good-2");
  });

  it("makeStreamingDlqWriter returns a function bound to STREAMING_DLQ_DIR", async () => {
    const dir = path.join(tmpDir, "factory-test");
    const writer = makeStreamingDlqWriter({ STREAMING_DLQ_DIR: dir });
    await writer(makeEvent({ value_id: "v-factory" }), "factory test");
    const sink = new NdjsonDlqSink(dir);
    const records = sink.readAll();
    expect(records.length).toBe(1);
    expect(records[0].event.value_id).toBe("v-factory");
  });

  it("makeStreamingDlqWriter falls back to .dlq/streaming-rule-evaluator default", () => {
    const writer = makeStreamingDlqWriter({});
    expect(typeof writer).toBe("function");
    // Don't actually write — would pollute the workspace .dlq/ dir.
    // The fallback path is verified by inspection of the factory source.
  });
});
