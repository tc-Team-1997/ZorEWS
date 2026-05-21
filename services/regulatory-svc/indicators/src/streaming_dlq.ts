// services/regulatory-svc/indicators/src/streaming_dlq.ts
//
// T2.12.3 — NDJSON dead-letter sink for StreamingRuleEvaluatorConsumer.
// Mirrors the existing services/event-bus/src/outbox.ts pattern so
// operators have a single mental model for offline replay.
//
// Files written: `<dir>/apex.indicator.values.dlq-YYYY-MM-DD.ndjson`
// Each line: `{event, error, attempts, dlq_at, attempted_via}`.
//
// Operator replay flow (from `docs/bau-runbook.md` § ingestion):
//   1. SRE inspects `.dlq/apex.indicator.values.dlq-<date>.ndjson`
//   2. After investigating the upstream issue, runs the replay script:
//        cat .dlq/<file> | jq '.event' | \
//          curl -X POST $BFF_URL/v1/streaming/indicator-events \
//               -H "X-Tenant-ID: <tenant>" -d @-
//   3. Successfully replayed lines are deleted; permanently-broken
//      events stay in the file with a `.replayed=false` marker.

import * as fs from "node:fs";
import * as path from "node:path";
import type { IndicatorValueEvent } from "./kafka_producer";

/** Single DLQ record format. Read by the operator replay flow. */
export interface DlqRecord {
  event: IndicatorValueEvent;
  error: string;
  attempts: number;
  dlq_at: string;
  attempted_via: "bff_streaming";
}

/**
 * Append-only NDJSON DLQ sink. Open-append-close per write so a crash
 * mid-write doesn't corrupt the file. Day-partitioned for easy cleanup.
 */
export class NdjsonDlqSink {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Write a single failed event. Idempotent vs partial writes (append). */
  async write(event: IndicatorValueEvent, error: string, attempts = 0): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dir, `apex.indicator.values.dlq-${day}.ndjson`);
    const record: DlqRecord = {
      event,
      error,
      attempts,
      dlq_at: new Date().toISOString(),
      attempted_via: "bff_streaming",
    };
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(file, line, { encoding: "utf8" });
  }

  /** Test + replay-script helper. Reads every DLQ record on disk. */
  readAll(): DlqRecord[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: DlqRecord[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.startsWith("apex.indicator.values.dlq-") || !f.endsWith(".ndjson")) continue;
      const text = fs.readFileSync(path.join(this.dir, f), "utf8");
      for (const ln of text.split("\n")) {
        if (!ln.trim()) continue;
        try {
          out.push(JSON.parse(ln) as DlqRecord);
        } catch {
          // Skip corrupted lines (partial-write rescue); operator inspects manually
        }
      }
    }
    return out;
  }
}

/**
 * Factory for the streaming consumer's `dlqWrite` slot. Returns a
 * function bound to an NdjsonDlqSink under `${STREAMING_DLQ_DIR}`
 * (default `.dlq/streaming-rule-evaluator`).
 */
export function makeStreamingDlqWriter(
  env: NodeJS.ProcessEnv = process.env,
): (event: IndicatorValueEvent, error: string) => Promise<void> {
  const dir = env.STREAMING_DLQ_DIR ?? ".dlq/streaming-rule-evaluator";
  const sink = new NdjsonDlqSink(dir);
  return (event, error) => sink.write(event, error);
}
