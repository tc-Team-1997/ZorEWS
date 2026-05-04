import { IllegalTransition, isTerminal, nextState } from '../src/state_machine';
import type { CaseState } from '../src/types';

describe('case state machine', () => {
  test('happy path: open -> assigned -> in_action -> monitored -> closed', () => {
    let s: CaseState = 'open';
    s = nextState(s, 'assign');
    expect(s).toBe('assigned');
    s = nextState(s, 'logAction');
    expect(s).toBe('in_action');
    s = nextState(s, 'monitor');
    expect(s).toBe('monitored');
    s = nextState(s, 'close');
    expect(s).toBe('closed');
    expect(isTerminal(s)).toBe(true);
  });

  test('logAction during monitored re-engages to in_action', () => {
    expect(nextState('monitored', 'logAction')).toBe('in_action');
  });

  test('logAction during in_action stays in_action', () => {
    expect(nextState('in_action', 'logAction')).toBe('in_action');
  });

  test('close is allowed from open / assigned / in_action / monitored', () => {
    for (const s of ['open', 'assigned', 'in_action', 'monitored'] as CaseState[]) {
      expect(nextState(s, 'close')).toBe('closed');
    }
  });

  test('cannot assign a closed case', () => {
    expect(() => nextState('closed', 'assign')).toThrow(IllegalTransition);
  });

  test('cannot logAction without an assignee (open)', () => {
    expect(() => nextState('open', 'logAction')).toThrow(IllegalTransition);
  });

  test('cannot monitor before action', () => {
    expect(() => nextState('open', 'monitor')).toThrow(IllegalTransition);
    expect(() => nextState('assigned', 'monitor')).toThrow(IllegalTransition);
  });

  test('IllegalTransition carries current state + attempted', () => {
    try {
      nextState('closed', 'logAction');
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransition);
      const err = e as IllegalTransition;
      expect(err.current).toBe('closed');
      expect(err.attempted).toBe('logAction');
      expect(err.status).toBe(409);
    }
  });

  test('isTerminal only true for closed', () => {
    for (const s of ['open', 'assigned', 'in_action', 'monitored'] as CaseState[]) {
      expect(isTerminal(s)).toBe(false);
    }
    expect(isTerminal('closed')).toBe(true);
  });
});
