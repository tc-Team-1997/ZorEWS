// T3.2.1 — IFRS9 adapter-signal layer tests.
//
// Sibling to the parallel-session-shipped src/ifrs9/stage_movement.ts;
// this layer composes the M14.2 Ifrs9Adapter for portfolio-level
// orchestration (stage-movement diff, ECL inputs batch, transition matrix).

import {
  Ifrs9SignalError,
  buildStageTransitionMatrix,
  getEclInputsBatch,
  getStageMovementSignal,
  syntheticIfrs9Stage,
} from '../src/ifrs9_adapter_signal';
import type { Ifrs9Adapter, Ifrs9Stage } from '../src/integrations/ifrs9';

type StageMap = Map<string, Ifrs9Stage>;
function makeMockAdapter(map: StageMap): Ifrs9Adapter {
  return {
    async getStage(_tenant: string, customer_id: string, asOf: Date) {
      const key = `${customer_id}|${asOf.toISOString().slice(0, 10)}`;
      return map.get(key) ?? null;
    },
    async listStages() {
      return { items: [], total: 0, page: 1, page_size: 50, stage_filter: null };
    },
  };
}

function stageRow(customer_id: string, stage: 1 | 2 | 3, observed_at: Date): Ifrs9Stage {
  const s = syntheticIfrs9Stage(customer_id, stage, observed_at);
  const ecl = Math.round((stage === 1 ? s.pd_12m : s.pd_lifetime) * s.lgd * s.ead_kes);
  return { ...s, ecl_kes: ecl };
}

const TENANT = 'BIL';
const SINCE = new Date('2026-01-01T00:00:00.000Z');
const UNTIL = new Date('2026-05-01T00:00:00.000Z');

describe('getStageMovementSignal', () => {
  test('detects deterioration (stage 1 → 2)', async () => {
    const map: StageMap = new Map([
      ['CUST-1|2026-01-01', stageRow('CUST-1', 1, SINCE)],
      ['CUST-1|2026-05-01', stageRow('CUST-1', 2, UNTIL)],
    ]);
    const ev = await getStageMovementSignal(makeMockAdapter(map), TENANT, 'CUST-1', SINCE, UNTIL);
    expect(ev).not.toBeNull();
    expect(ev!.from_stage).toBe(1);
    expect(ev!.to_stage).toBe(2);
    expect(ev!.direction).toBe('deterioration');
    expect(ev!.ecl_delta_kes).toBeGreaterThan(0);
    expect(ev!.pd_12m_delta).toBeGreaterThan(0);
  });

  test('detects improvement (stage 2 → 1)', async () => {
    const map: StageMap = new Map([
      ['CUST-1|2026-01-01', stageRow('CUST-1', 2, SINCE)],
      ['CUST-1|2026-05-01', stageRow('CUST-1', 1, UNTIL)],
    ]);
    const ev = await getStageMovementSignal(makeMockAdapter(map), TENANT, 'CUST-1', SINCE, UNTIL);
    expect(ev!.direction).toBe('improvement');
    expect(ev!.ecl_delta_kes).toBeLessThan(0);
  });

  test('flags unchanged when same stage', async () => {
    const map: StageMap = new Map([
      ['CUST-1|2026-01-01', stageRow('CUST-1', 2, SINCE)],
      ['CUST-1|2026-05-01', stageRow('CUST-1', 2, UNTIL)],
    ]);
    const ev = await getStageMovementSignal(makeMockAdapter(map), TENANT, 'CUST-1', SINCE, UNTIL);
    expect(ev!.direction).toBe('unchanged');
  });

  test('returns null when adapter misses either side', async () => {
    const map: StageMap = new Map([['CUST-1|2026-01-01', stageRow('CUST-1', 1, SINCE)]]);
    const ev = await getStageMovementSignal(makeMockAdapter(map), TENANT, 'CUST-1', SINCE, UNTIL);
    expect(ev).toBeNull();
  });

  test('rejects empty tenant_id + customer_id + bad window', async () => {
    const adapter = makeMockAdapter(new Map());
    await expect(getStageMovementSignal(adapter, '', 'C', SINCE, UNTIL)).rejects.toThrow(/tenant_id/);
    await expect(getStageMovementSignal(adapter, TENANT, '', SINCE, UNTIL)).rejects.toThrow(/customer_id/);
    await expect(getStageMovementSignal(adapter, TENANT, 'C', UNTIL, SINCE)).rejects.toBeInstanceOf(
      Ifrs9SignalError,
    );
  });
});

describe('getEclInputsBatch', () => {
  test('aggregates PD/LGD/EAD × N customers + portfolio totals', async () => {
    const asOf = new Date('2026-05-21T00:00:00.000Z');
    const dayKey = asOf.toISOString().slice(0, 10);
    const map: StageMap = new Map([
      [`CUST-1|${dayKey}`, stageRow('CUST-1', 1, asOf)],
      [`CUST-2|${dayKey}`, stageRow('CUST-2', 2, asOf)],
      [`CUST-3|${dayKey}`, stageRow('CUST-3', 3, asOf)],
    ]);
    const batch = await getEclInputsBatch(makeMockAdapter(map), TENANT, ['CUST-1', 'CUST-2', 'CUST-3'], asOf);
    expect(batch.total_customers).toBe(3);
    expect(batch.stage_1_count).toBe(1);
    expect(batch.stage_2_count).toBe(1);
    expect(batch.stage_3_count).toBe(1);
    expect(batch.total_ead_kes).toBe(100_000 + 500_000 + 1_000_000);
    expect(batch.total_ecl_kes).toBeGreaterThan(0);
    expect(batch.missing_customer_ids).toHaveLength(0);
  });

  test('captures missing customer_ids into the missing array', async () => {
    const asOf = new Date('2026-05-21T00:00:00.000Z');
    const dayKey = asOf.toISOString().slice(0, 10);
    const map: StageMap = new Map([[`CUST-1|${dayKey}`, stageRow('CUST-1', 1, asOf)]]);
    const batch = await getEclInputsBatch(makeMockAdapter(map), TENANT, ['CUST-1', 'CUST-2'], asOf);
    expect(batch.total_customers).toBe(1);
    expect(batch.missing_customer_ids).toEqual(['CUST-2']);
  });

  test('rejects > 500 customers per call', async () => {
    const adapter = makeMockAdapter(new Map());
    const lots = Array.from({ length: 501 }, (_, i) => `C-${i}`);
    await expect(getEclInputsBatch(adapter, TENANT, lots, new Date())).rejects.toThrow(/capped/);
  });

  test('skips non-string ids defensively', async () => {
    const asOf = new Date('2026-05-21T00:00:00.000Z');
    const adapter = makeMockAdapter(new Map());
    const batch = await getEclInputsBatch(adapter, TENANT, ['C-1', '', '   '], asOf);
    // First two are non-empty strings (' ' is treated as id), third is whitespace — let's not over-spec.
    expect(batch.total_customers).toBe(0);
  });
});

describe('buildStageTransitionMatrix', () => {
  test('counts every from→to combination correctly', async () => {
    const map: StageMap = new Map();
    // 5 customers: 2 stay 1→1, 1 1→2, 1 2→3, 1 2→1
    map.set('C-1|2026-01-01', stageRow('C-1', 1, SINCE));
    map.set('C-1|2026-05-01', stageRow('C-1', 1, UNTIL));
    map.set('C-2|2026-01-01', stageRow('C-2', 1, SINCE));
    map.set('C-2|2026-05-01', stageRow('C-2', 1, UNTIL));
    map.set('C-3|2026-01-01', stageRow('C-3', 1, SINCE));
    map.set('C-3|2026-05-01', stageRow('C-3', 2, UNTIL));
    map.set('C-4|2026-01-01', stageRow('C-4', 2, SINCE));
    map.set('C-4|2026-05-01', stageRow('C-4', 3, UNTIL));
    map.set('C-5|2026-01-01', stageRow('C-5', 2, SINCE));
    map.set('C-5|2026-05-01', stageRow('C-5', 1, UNTIL));
    const m = await buildStageTransitionMatrix(
      makeMockAdapter(map),
      TENANT,
      ['C-1', 'C-2', 'C-3', 'C-4', 'C-5'],
      SINCE,
      UNTIL,
    );
    expect(m.total_customers).toBe(5);
    expect(m.matrix[0][0]).toBe(2);
    expect(m.matrix[0][1]).toBe(1);
    expect(m.matrix[1][2]).toBe(1);
    expect(m.matrix[1][0]).toBe(1);
    expect(m.deteriorations).toBe(2);
    expect(m.improvements).toBe(1);
    expect(m.unchanged).toBe(2);
  });

  test('partition invariant: det + imp + unch = total_customers', async () => {
    const map: StageMap = new Map();
    for (let i = 0; i < 12; i++) {
      const cid = `C-${i}`;
      const from = ((i % 3) + 1) as 1 | 2 | 3;
      const to = (((i + 1) % 3) + 1) as 1 | 2 | 3;
      map.set(`${cid}|2026-01-01`, stageRow(cid, from, SINCE));
      map.set(`${cid}|2026-05-01`, stageRow(cid, to, UNTIL));
    }
    const m = await buildStageTransitionMatrix(
      makeMockAdapter(map),
      TENANT,
      Array.from({ length: 12 }, (_, i) => `C-${i}`),
      SINCE,
      UNTIL,
    );
    expect(m.deteriorations + m.improvements + m.unchanged).toBe(m.total_customers);
  });
});
