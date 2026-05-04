import { InMemoryEventBus } from '../src/memory';

describe('InMemoryEventBus', () => {
  test('publish records the message in order', async () => {
    const bus = new InMemoryEventBus();
    await bus.publish({ topic: 't1', payload: { n: 1 } });
    await bus.publish({ topic: 't1', payload: { n: 2 } });
    expect(bus.published).toHaveLength(2);
    expect(bus.published[0].payload).toEqual({ n: 1 });
    expect(bus.published[1].payload).toEqual({ n: 2 });
  });

  test('subscribe receives only matching topics', async () => {
    const bus = new InMemoryEventBus();
    const seen: { topic: string; n: number }[] = [];
    await bus.subscribe<{ n: number }>(['t1'], (m) => {
      seen.push({ topic: m.topic, n: m.payload.n });
    });
    await bus.publish({ topic: 't1', payload: { n: 1 } });
    await bus.publish({ topic: 't2', payload: { n: 99 } }); // not subscribed
    await bus.publish({ topic: 't1', payload: { n: 2 } });
    expect(seen).toEqual([
      { topic: 't1', n: 1 },
      { topic: 't1', n: 2 },
    ]);
  });

  test('multiple subscribers all receive', async () => {
    const bus = new InMemoryEventBus();
    const a: number[] = [];
    const b: number[] = [];
    await bus.subscribe<{ n: number }>(['t'], (m) => {
      a.push(m.payload.n);
    });
    await bus.subscribe<{ n: number }>(['t'], (m) => {
      b.push(m.payload.n);
    });
    await bus.publish({ topic: 't', payload: { n: 5 } });
    expect(a).toEqual([5]);
    expect(b).toEqual([5]);
  });

  test('handler error does not stop publish from completing', async () => {
    const bus = new InMemoryEventBus();
    await bus.subscribe(['t'], () => {
      throw new Error('boom');
    });
    await expect(bus.publish({ topic: 't', payload: 'ok' })).resolves.toBeUndefined();
    expect(bus.published).toHaveLength(1);
  });

  test('headers + key passed through', async () => {
    const bus = new InMemoryEventBus();
    await bus.publish({
      topic: 't',
      key: 'customer-123',
      headers: { 'x-trace-id': 'abc' },
      payload: { ok: true },
    });
    expect(bus.published[0].key).toBe('customer-123');
    expect(bus.published[0].headers).toEqual({ 'x-trace-id': 'abc' });
  });

  test('reset clears state', async () => {
    const bus = new InMemoryEventBus();
    await bus.subscribe(['t'], () => {});
    await bus.publish({ topic: 't', payload: 1 });
    bus.reset();
    expect(bus.published).toHaveLength(0);
    await bus.publish({ topic: 't', payload: 2 });
    expect(bus.published).toHaveLength(1); // subs cleared too
  });
});
