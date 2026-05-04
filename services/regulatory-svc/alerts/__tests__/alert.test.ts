import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildAlert, contentKeyFor, deterministicAlertId } from '../src/alert';
import { OutboxProducer } from '../src/producer';
import { SmartQueue } from '../src/queue';
import { StubScoreClient } from '../src/score_client';
import { AlertEvaluator } from '../src/evaluator';
import { alertEventValidator } from '../src/schemas';
import type { RuleFiring, ScoreResponse } from '../src/types';

const baseFiring: RuleFiring = {
  firing_id: '11111111-1111-4111-8111-111111111111',
  rule_id: 'RULE-014',
  rule_version: 1,
  customer_id: 'CUST0000001',
  indicators_fired: ['TXN-003', 'BEH-006'],
  rule_severity: 'medium',
  reason: 'Salary inflow stopped 60d',
  recommended_action: 'Contact customer',
  ts: '2026-04-26T08:00:00.000Z',
};

const baseScore: ScoreResponse = {
  customer_id: 'CUST0000001',
  pd: 0.31,
  level: 'High',
  top_reasons: [
    { feature: 'utilization', value: 0.92, shap_value: 0.41, direction: 'positive' },
    { feature: 'tenure_months', value: 6, shap_value: -0.05, direction: 'negative' },
  ],
};

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('buildAlert — pure', () => {
  const fixedNow = () => new Date('2026-04-26T08:00:00.000Z');

  test('emits canonical envelope with merged severity', () => {
    const alert = buildAlert({ firing: baseFiring, score: baseScore, now: fixedNow });
    expect(alert.severity).toBe('HIGH'); // medium rule × High score → high → HIGH wire
    expect(alert.rule_id).toBe('RULE-014');
    expect(alert.indicators_fired).toEqual(['BEH-006', 'TXN-003']); // sorted
    expect(alert.pd).toBe(0.31);
    expect(alert.risk_level).toBe('High');
    expect(alert.reason_summary).toContain('Salary inflow stopped');
    expect(alert.scoring.risk_band).toBe('HIGH');
  });

  test('null score → severity from rule alone', () => {
    const alert = buildAlert({ firing: baseFiring, score: null, now: fixedNow });
    expect(alert.severity).toBe('MEDIUM');
    expect(alert.pd).toBeNull();
    expect(alert.risk_level).toBeNull();
    expect(alert.scoring.risk_band).toBeNull();
    expect(alert.top_reasons).toEqual([]);
  });

  test('idempotent alert_id from firing+severity content', () => {
    const a = buildAlert({ firing: baseFiring, score: baseScore, now: fixedNow });
    const b = buildAlert({ firing: baseFiring, score: baseScore, now: fixedNow });
    expect(a.alert_id).toBe(b.alert_id);
    // content-key change → different id
    const c = buildAlert(
      { firing: { ...baseFiring, rule_id: 'RULE-099' }, score: baseScore, now: fixedNow },
    );
    expect(c.alert_id).not.toBe(a.alert_id);
  });

  test('passes apex.regulatory.events.v2.json schema', () => {
    const alert = buildAlert({ firing: baseFiring, score: baseScore, now: fixedNow });
    const v = alertEventValidator();
    const ok = v(alert);
    if (!ok) {
      // surface AJV errors for debugging
      // eslint-disable-next-line no-console
      console.error(v.errors);
    }
    expect(ok).toBe(true);
  });

  test('contentKeyFor / deterministicAlertId stable', () => {
    const k = contentKeyFor(baseFiring, 'high');
    expect(deterministicAlertId(k)).toBe(deterministicAlertId(k));
  });
});

describe('AlertEvaluator — end-to-end with stubs', () => {
  test('emits to outbox and enqueues', async () => {
    const dir = tmpDir('apex-alert-');
    const outbox = new OutboxProducer(path.join(dir, '.outbox'));
    const queue = new SmartQueue(path.join(dir, '.queue', 'queue.ndjson'), [
      'analyst-a',
      'analyst-b',
    ]);
    const ev = new AlertEvaluator({
      producer: outbox,
      queue,
      scoreClient: new StubScoreClient(baseScore),
      now: () => new Date('2026-04-26T08:00:00.000Z'),
    });

    const result = await ev.evaluate(baseFiring);
    expect(result.alert.severity).toBe('HIGH');
    expect(result.queueEntry.bucket).toBe('critical'); // high → Critical bucket
    expect(result.alertExisting).toBe(false);

    const written = outbox.readAll('apex.regulatory.events');
    expect(written).toHaveLength(1);
    expect(written[0].alert_id).toBe(result.alert.alert_id);
  });

  test('idempotent: same firing twice → same alert_id, single emit', async () => {
    const dir = tmpDir('apex-alert-idem-');
    const outbox = new OutboxProducer(path.join(dir, '.outbox'));
    const queue = new SmartQueue(path.join(dir, '.queue', 'queue.ndjson'));
    const ev = new AlertEvaluator({
      producer: outbox,
      queue,
      scoreClient: new StubScoreClient(baseScore),
      now: () => new Date('2026-04-26T08:00:00.000Z'),
    });

    const a = await ev.evaluate(baseFiring);
    const b = await ev.evaluate(baseFiring);
    expect(b.alert.alert_id).toBe(a.alert.alert_id);
    expect(b.alertExisting).toBe(true);
    expect(outbox.readAll('apex.regulatory.events')).toHaveLength(1);
  });

  test('rejects malformed firing', async () => {
    const dir = tmpDir('apex-alert-bad-');
    const ev = new AlertEvaluator({
      producer: new OutboxProducer(path.join(dir, '.outbox')),
      queue: new SmartQueue(),
      scoreClient: new StubScoreClient(null),
    });
    const bad = { ...baseFiring, firing_id: 'not-a-uuid' } as unknown as RuleFiring;
    await expect(ev.evaluate(bad)).rejects.toThrow(/firing failed schema/);
  });
});
