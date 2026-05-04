import { CollectionProcessor } from '../src/processor';
import { InMemoryCollectionSink } from '../src/sink';
import { StaticCaseEventSource } from '../src/source';
import type { CaseEvent, CaseEventType } from '../src/types';

function event(
  case_id: string,
  type: CaseEventType,
  payload: Record<string, unknown>,
  overrides: Partial<CaseEvent> = {},
): CaseEvent {
  return {
    event_id: `evt-${case_id}-${type}`,
    event_type: type,
    ts: '2026-04-27T10:00:00Z',
    case_id,
    alert_id: `alert-${case_id}`,
    customer_id: `cust-${case_id}`,
    prior_state: null,
    new_state: 'open',
    payload,
    ...overrides,
  };
}

describe('CollectionProcessor — process()', () => {
  test('routes eligible cases and skips ineligible', async () => {
    const events = [
      event('c-1', 'case.created', { severity: 'critical' }),
      event('c-2', 'case.created', { severity: 'high' }),
      event('c-3', 'case.created', { severity: 'medium', loan_id: 'l-3' }),
      event('c-4', 'case.created', { severity: 'medium' }),  // no loan → skip
      event('c-5', 'case.created', { severity: 'low' }),
      event('c-6', 'case.assigned', { severity: 'critical' }), // not creation
    ];
    const sink = new InMemoryCollectionSink();
    const proc = new CollectionProcessor(new StaticCaseEventSource(events), sink);
    const report = await proc.process();
    expect(report.scanned).toBe(6);
    expect(report.routed).toBe(3);
    expect(report.skipped_below_threshold).toBe(2);
    expect(report.skipped_non_create).toBe(1);
    expect(sink.events.map((e) => e.case_id).sort()).toEqual(['c-1', 'c-2', 'c-3']);
    // Reasons captured.
    expect(sink.events.find((e) => e.case_id === 'c-3')?.reason).toBe('loan_default_track');
    expect(sink.events.find((e) => e.case_id === 'c-1')?.reason).toBe('severity');
  });

  test('idempotent — replaying the same events does not double-route', async () => {
    const events = [event('c-1', 'case.created', { severity: 'critical' })];
    const sink = new InMemoryCollectionSink();
    const proc = new CollectionProcessor(new StaticCaseEventSource(events), sink);
    const r1 = await proc.process();
    const r2 = await proc.process();
    expect(r1.routed).toBe(1);
    expect(r2.routed).toBe(0);
    expect(r2.skipped_already_routed).toBe(1);
    expect(sink.events).toHaveLength(1);
  });

  test('captures full route metadata for downstream sync', async () => {
    const ev = event('c-x', 'case.created', { severity: 'high', loan_id: 'l-x' });
    const sink = new InMemoryCollectionSink();
    const FIXED = new Date('2026-04-27T12:00:00Z');
    const proc = new CollectionProcessor(
      new StaticCaseEventSource([ev]),
      sink,
      () => FIXED,
    );
    await proc.process();
    expect(sink.events[0]).toMatchObject({
      case_id: 'c-x',
      alert_id: 'alert-c-x',
      customer_id: 'cust-c-x',
      severity: 'high',
      loan_id: 'l-x',
      routed_at: '2026-04-27T12:00:00.000Z',
      source_event_id: 'evt-c-x-case.created',
    });
    expect(sink.events[0].route_id).toMatch(/^route_/);
  });
});
