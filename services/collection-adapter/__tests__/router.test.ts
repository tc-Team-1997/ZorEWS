import { decideRoute } from '../src/router';
import type { CaseEvent } from '../src/types';

function event(overrides: Partial<CaseEvent> = {}): CaseEvent {
  return {
    event_id: 'evt-1',
    event_type: 'case.created',
    ts: '2026-04-27T10:00:00Z',
    case_id: 'case-1',
    alert_id: 'alert-1',
    customer_id: 'cust-1',
    prior_state: null,
    new_state: 'open',
    payload: { severity: 'high' },
    ...overrides,
  };
}

describe('decideRoute — pure routing decision', () => {
  test('routes critical cases', () => {
    const r = decideRoute(event({ payload: { severity: 'critical' } }));
    expect(r.route).toBe(true);
    expect(r.reason).toBe('severity');
    expect(r.severity).toBe('critical');
  });

  test('routes high cases', () => {
    const r = decideRoute(event({ payload: { severity: 'high' } }));
    expect(r.route).toBe(true);
    expect(r.reason).toBe('severity');
    expect(r.severity).toBe('high');
  });

  test('does NOT route medium without loan', () => {
    const r = decideRoute(event({ payload: { severity: 'medium' } }));
    expect(r.route).toBe(false);
    expect(r.reason).toBe('below_threshold');
  });

  test('routes medium WITH loan_id (loan default track)', () => {
    const r = decideRoute(
      event({ payload: { severity: 'medium', loan_id: 'loan-9' } }),
    );
    expect(r.route).toBe(true);
    expect(r.reason).toBe('loan_default_track');
    expect(r.loan_id).toBe('loan-9');
  });

  test('does NOT route low severity even with loan', () => {
    const r = decideRoute(event({ payload: { severity: 'low', loan_id: 'loan-9' } }));
    expect(r.route).toBe(false);
  });

  test('does NOT route non-creation events (assigned, action, monitored, closed)', () => {
    for (const t of ['case.assigned', 'case.action_logged', 'case.monitored', 'case.closed'] as const) {
      const r = decideRoute(event({ event_type: t, payload: { severity: 'critical' } }));
      expect(r.route).toBe(false);
      expect(r.reason).toBe('not_a_creation_event');
    }
  });

  test('treats unknown severity as low (defensive default)', () => {
    const r = decideRoute(event({ payload: { severity: 'urgent' } }));
    expect(r.route).toBe(false);
    expect(r.severity).toBe('low');
  });

  test('handles missing severity (no payload)', () => {
    const r = decideRoute(event({ payload: {} }));
    expect(r.route).toBe(false);
    expect(r.severity).toBe('low');
  });
});
