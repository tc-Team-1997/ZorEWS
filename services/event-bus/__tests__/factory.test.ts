import { InMemoryEventBus } from '../src/memory';
import { OutboxProducer } from '../src/outbox';
import { KafkaProducer } from '../src/kafka';
import { makeProducer } from '../src/factory';

describe('makeProducer()', () => {
  test('default → OutboxProducer', () => {
    const p = makeProducer({ clientId: 'test', env: {} });
    expect(p).toBeInstanceOf(OutboxProducer);
  });

  test('APEX_BUS=memory → InMemoryEventBus', () => {
    const p = makeProducer({ clientId: 'test', env: { APEX_BUS: 'memory' } });
    expect(p).toBeInstanceOf(InMemoryEventBus);
  });

  test('APEX_BUS=kafka + KAFKA_BROKERS → KafkaProducer', () => {
    const p = makeProducer({
      clientId: 'test',
      env: { APEX_BUS: 'kafka', KAFKA_BROKERS: 'broker-1:9092,broker-2:9092' },
    });
    expect(p).toBeInstanceOf(KafkaProducer);
  });

  test('APEX_BUS=kafka without KAFKA_BROKERS → throws', () => {
    expect(() =>
      makeProducer({ clientId: 'test', env: { APEX_BUS: 'kafka' } }),
    ).toThrow(/KAFKA_BROKERS/);
  });

  test('APEX_OUTBOX_DIR override is honoured', async () => {
    const p = makeProducer({
      clientId: 'test',
      env: { APEX_BUS: 'outbox', APEX_OUTBOX_DIR: '/tmp/test-outbox-override' },
    });
    expect(p).toBeInstanceOf(OutboxProducer);
  });

  test('case-insensitive bus selection', () => {
    const p = makeProducer({ clientId: 'test', env: { APEX_BUS: 'MEMORY' } });
    expect(p).toBeInstanceOf(InMemoryEventBus);
  });
});
