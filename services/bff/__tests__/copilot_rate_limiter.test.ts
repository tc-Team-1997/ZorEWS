// services/bff/__tests__/copilot_rate_limiter.test.ts
//
// Copilot-1 — rate limiter tests.

import {
  COPILOT_DEFAULT_LIMIT,
  COPILOT_DEFAULT_WINDOW_MS,
  checkAndConsume,
  emptyRateState,
  inspect,
} from '../src/copilot/rate_limiter';

const NOW = new Date('2026-05-06T10:00:00.000Z');

describe('Copilot-1 — rate limiter', () => {
  test('first call allowed; remaining = limit - 1', () => {
    const s = emptyRateState();
    const r = checkAndConsume(s, 'BIL', 'jane', NOW);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(COPILOT_DEFAULT_LIMIT - 1);
  });

  test('30 calls in same window all allowed; 31st blocked', () => {
    const s = emptyRateState();
    for (let i = 0; i < COPILOT_DEFAULT_LIMIT; i++) {
      const r = checkAndConsume(s, 'BIL', 'jane', NOW);
      expect(r.ok).toBe(true);
    }
    const blocked = checkAndConsume(s, 'BIL', 'jane', NOW);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  test('reset_at on block points to oldest entry + window', () => {
    const s = emptyRateState();
    for (let i = 0; i < COPILOT_DEFAULT_LIMIT; i++) checkAndConsume(s, 'BIL', 'jane', NOW);
    const blocked = checkAndConsume(s, 'BIL', 'jane', NOW);
    expect(blocked.reset_at).toBe(new Date(NOW.getTime() + COPILOT_DEFAULT_WINDOW_MS).toISOString());
  });

  test('after window: old entries age out, new call allowed', () => {
    const s = emptyRateState();
    for (let i = 0; i < COPILOT_DEFAULT_LIMIT; i++) checkAndConsume(s, 'BIL', 'jane', NOW);
    expect(checkAndConsume(s, 'BIL', 'jane', NOW).ok).toBe(false);
    const later = new Date(NOW.getTime() + COPILOT_DEFAULT_WINDOW_MS + 1);
    const r = checkAndConsume(s, 'BIL', 'jane', later);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(COPILOT_DEFAULT_LIMIT - 1);
  });

  test('per-(tenant, user) isolation', () => {
    const s = emptyRateState();
    for (let i = 0; i < COPILOT_DEFAULT_LIMIT; i++) checkAndConsume(s, 'BIL', 'jane', NOW);
    expect(checkAndConsume(s, 'BIL', 'jane', NOW).ok).toBe(false);
    expect(checkAndConsume(s, 'BIL', 'bob', NOW).ok).toBe(true);
    expect(checkAndConsume(s, 'BANK_DEMO', 'jane', NOW).ok).toBe(true);
  });

  test('custom limit + window honoured', () => {
    const s = emptyRateState();
    expect(checkAndConsume(s, 'BIL', 'jane', NOW, 2, 60_000).ok).toBe(true);
    expect(checkAndConsume(s, 'BIL', 'jane', NOW, 2, 60_000).ok).toBe(true);
    expect(checkAndConsume(s, 'BIL', 'jane', NOW, 2, 60_000).ok).toBe(false);
  });

  test('inspect: used + remaining + reset_at without consuming', () => {
    const s = emptyRateState();
    expect(inspect(s, 'BIL', 'jane', NOW).used).toBe(0);
    checkAndConsume(s, 'BIL', 'jane', NOW);
    const i = inspect(s, 'BIL', 'jane', NOW);
    expect(i.used).toBe(1);
    expect(i.remaining).toBe(COPILOT_DEFAULT_LIMIT - 1);
    expect(i.reset_at).not.toBeNull();
  });

  test('inspect: empty user returns reset_at=null', () => {
    expect(inspect(emptyRateState(), 'BIL', 'jane', NOW).reset_at).toBeNull();
  });

  test('rolling window: entry from 30 minutes ago still counts', () => {
    const s = emptyRateState();
    const earlier = new Date(NOW.getTime() - 30 * 60_000);
    checkAndConsume(s, 'BIL', 'jane', earlier);
    const i = inspect(s, 'BIL', 'jane', NOW);
    expect(i.used).toBe(1);
  });

  test('rolling window: entry from 61 minutes ago aged out', () => {
    const s = emptyRateState();
    const earlier = new Date(NOW.getTime() - 61 * 60_000);
    checkAndConsume(s, 'BIL', 'jane', earlier);
    const i = inspect(s, 'BIL', 'jane', NOW);
    expect(i.used).toBe(0);
  });
});
