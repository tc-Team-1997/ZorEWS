// services/bff/__tests__/insurance_siu.test.ts

import {
  ALL_SIU_STATUSES,
  ALL_SIU_DECISIONS,
  ALL_EVIDENCE_TYPES,
  canTransition,
  InMemorySiuStore,
  SiuError,
} from '../src/insurance_siu';

const NOW = new Date('2026-05-29T12:00:00.000Z');

function freshStore() {
  return new InMemorySiuStore();
}
function firstClaim(store: InMemorySiuStore) {
  return store.listQueue('BANK_DEMO', NOW)[0].claim_id;
}

describe('enums + state machine', () => {
  it('6 statuses, 4 decisions, 5 evidence types', () => {
    expect(ALL_SIU_STATUSES).toEqual(['triage', 'evidence_gathering', 'awaiting_response', 'review', 'decision', 'closed']);
    expect(ALL_SIU_DECISIONS).toHaveLength(4);
    expect(ALL_EVIDENCE_TYPES).toHaveLength(5);
  });
  it('legal + illegal transitions', () => {
    expect(canTransition('triage', 'evidence_gathering')).toBe(true);
    expect(canTransition('evidence_gathering', 'review')).toBe(true);
    expect(canTransition('review', 'decision')).toBe(true);
    expect(canTransition('decision', 'closed')).toBe(true);
    expect(canTransition('closed', 'evidence_gathering')).toBe(true); // re-open
    expect(canTransition('triage', 'review')).toBe(false);
    expect(canTransition('triage', 'decision')).toBe(false);
    expect(canTransition('closed', 'triage')).toBe(false);
  });
});

describe('queue', () => {
  it('returns suspicious claims worst-first, all score >= 0.5', () => {
    const store = freshStore();
    const q = store.listQueue('BANK_DEMO', NOW);
    expect(q.length).toBeGreaterThan(0);
    for (const r of q) expect(r.anomaly_score).toBeGreaterThanOrEqual(0.5);
    for (let i = 1; i < q.length; i++) expect(q[i - 1].anomaly_score).toBeGreaterThanOrEqual(q[i].anomaly_score);
  });
  it('min_score + limit filters', () => {
    const store = freshStore();
    const q = store.listQueue('BANK_DEMO', NOW, { min_score: 0.8, limit: 5 });
    expect(q.length).toBeLessThanOrEqual(5);
    for (const r of q) expect(r.anomaly_score).toBeGreaterThanOrEqual(0.8);
  });
  it('has_open_investigation flips once an investigation is opened', () => {
    const store = freshStore();
    const id = firstClaim(store);
    expect(store.listQueue('BANK_DEMO', NOW).find((r) => r.claim_id === id)!.has_open_investigation).toBe(false);
    store.open('BANK_DEMO', { claim_id: id, opened_by: 'siu.analyst' }, NOW);
    expect(store.listQueue('BANK_DEMO', NOW).find((r) => r.claim_id === id)!.has_open_investigation).toBe(true);
  });
  it('tenant isolation — BIL claim ids disjoint from BANK_DEMO', () => {
    const store = freshStore();
    const bank = new Set(store.listQueue('BANK_DEMO', NOW).map((r) => r.claim_id));
    for (const r of store.listQueue('BIL', NOW)) expect(bank.has(r.claim_id)).toBe(false);
  });
  it('empty tenant_id throws', () => {
    expect(() => freshStore().listQueue('', NOW)).toThrow(SiuError);
  });
});

describe('open + list + get', () => {
  it('opens an investigation in triage pulling canonical claim facts', () => {
    const store = freshStore();
    const id = firstClaim(store);
    const inv = store.open('BANK_DEMO', { claim_id: id, opened_by: 'siu.analyst' }, NOW);
    expect(inv.status).toBe('triage');
    expect(inv.claim_id).toBe(id);
    expect(inv.claimant_name).not.toBe('Unknown');
    expect(inv.anomaly_score).toBeGreaterThanOrEqual(0.5);
    expect(inv.investigation_id).toMatch(/^siu-BANK_DEMO-/);
  });
  it('refuses a 2nd open investigation for the same claim', () => {
    const store = freshStore();
    const id = firstClaim(store);
    store.open('BANK_DEMO', { claim_id: id, opened_by: 'a' }, NOW);
    expect(() => store.open('BANK_DEMO', { claim_id: id, opened_by: 'a' }, NOW)).toThrow(SiuError);
  });
  it('allows re-open after close', () => {
    const store = freshStore();
    const id = firstClaim(store);
    const inv = store.open('BANK_DEMO', { claim_id: id, opened_by: 'a' }, NOW);
    store.updateStatus('BANK_DEMO', inv.investigation_id, 'closed', 'a', NOW);
    expect(() => store.open('BANK_DEMO', { claim_id: id, opened_by: 'a' }, NOW)).not.toThrow();
  });
  it('list filters by status + paginates; get returns by id; cross-tenant null', () => {
    const store = freshStore();
    const id = firstClaim(store);
    const inv = store.open('BANK_DEMO', { claim_id: id, opened_by: 'a' }, NOW);
    expect(store.list('BANK_DEMO').total).toBe(1);
    expect(store.list('BANK_DEMO', { status: 'triage' }).items).toHaveLength(1);
    expect(store.list('BANK_DEMO', { status: 'closed' }).items).toHaveLength(0);
    expect(store.get('BANK_DEMO', inv.investigation_id)!.claim_id).toBe(id);
    expect(store.get('BIL', inv.investigation_id)).toBeNull();
  });
  it('open requires claim_id + opened_by', () => {
    const store = freshStore();
    expect(() => store.open('BANK_DEMO', { claim_id: '', opened_by: 'a' }, NOW)).toThrow(SiuError);
    expect(() => store.open('BANK_DEMO', { claim_id: 'CLM-X', opened_by: '' }, NOW)).toThrow(SiuError);
  });
});

describe('lifecycle + decision', () => {
  function openOne() {
    const store = freshStore();
    const inv = store.open('BANK_DEMO', { claim_id: firstClaim(store), opened_by: 'a' }, NOW);
    return { store, id: inv.investigation_id };
  }
  it('full legal walk to a fraud_confirmed close', () => {
    const { store, id } = openOne();
    store.updateStatus('BANK_DEMO', id, 'evidence_gathering', 'a', NOW);
    store.updateStatus('BANK_DEMO', id, 'review', 'a', NOW);
    store.updateStatus('BANK_DEMO', id, 'decision', 'a', NOW);
    const closed = store.updateStatus('BANK_DEMO', id, 'closed', 'a', NOW, 'fraud_confirmed');
    expect(closed.status).toBe('closed');
    expect(closed.decision).toBe('fraud_confirmed');
    expect(closed.closed_at).not.toBeNull();
  });
  it('illegal transition throws', () => {
    const { store, id } = openOne();
    expect(() => store.updateStatus('BANK_DEMO', id, 'decision', 'a', NOW)).toThrow(SiuError);
  });
  it('closing from decision without a decision throws decision_required', () => {
    const { store, id } = openOne();
    store.updateStatus('BANK_DEMO', id, 'evidence_gathering', 'a', NOW);
    store.updateStatus('BANK_DEMO', id, 'review', 'a', NOW);
    store.updateStatus('BANK_DEMO', id, 'decision', 'a', NOW);
    expect(() => store.updateStatus('BANK_DEMO', id, 'closed', 'a', NOW)).toThrow(SiuError);
  });
  it('early dismissal (triage → closed) allowed without decision', () => {
    const { store, id } = openOne();
    expect(() => store.updateStatus('BANK_DEMO', id, 'closed', 'a', NOW)).not.toThrow();
  });
  it('re-open clears closed_at', () => {
    const { store, id } = openOne();
    store.updateStatus('BANK_DEMO', id, 'closed', 'a', NOW);
    const re = store.updateStatus('BANK_DEMO', id, 'evidence_gathering', 'a', NOW);
    expect(re.closed_at).toBeNull();
  });
  it('unknown investigation + invalid status + invalid decision throw', () => {
    const { store } = openOne();
    expect(() => store.updateStatus('BANK_DEMO', 'siu-x', 'review', 'a', NOW)).toThrow(SiuError);
    const id2 = store.open('BANK_DEMO', { claim_id: store.listQueue('BANK_DEMO', NOW)[1].claim_id, opened_by: 'a' }, NOW).investigation_id;
    expect(() => store.updateStatus('BANK_DEMO', id2, 'bogus' as never, 'a', NOW)).toThrow(SiuError);
  });
});

describe('notes + evidence + escalate + link-alert', () => {
  function openOne() {
    const store = freshStore();
    const inv = store.open('BANK_DEMO', { claim_id: firstClaim(store), opened_by: 'a' }, NOW);
    return { store, id: inv.investigation_id };
  }
  it('adds a note', () => {
    const { store, id } = openOne();
    const inv = store.addNote('BANK_DEMO', id, 'Claimant phone disconnected.', 'siu.analyst', NOW);
    expect(inv.notes).toHaveLength(1);
    expect(inv.notes[0].body).toBe('Claimant phone disconnected.');
  });
  it('rejects empty note', () => {
    const { store, id } = openOne();
    expect(() => store.addNote('BANK_DEMO', id, '   ', 'a', NOW)).toThrow(SiuError);
  });
  it('adds typed evidence with attachment ref', () => {
    const { store, id } = openOne();
    const inv = store.addEvidence('BANK_DEMO', id, { type: 'document', title: 'Hospital bill', description: 'Mismatched dates', attachment_ref: 'dms://doc/123' }, 'a', NOW);
    expect(inv.evidence).toHaveLength(1);
    expect(inv.evidence[0].type).toBe('document');
    expect(inv.evidence[0].attachment_ref).toBe('dms://doc/123');
  });
  it('rejects invalid evidence type + empty title', () => {
    const { store, id } = openOne();
    expect(() => store.addEvidence('BANK_DEMO', id, { type: 'bogus' as never, title: 'x' }, 'a', NOW)).toThrow(SiuError);
    expect(() => store.addEvidence('BANK_DEMO', id, { type: 'photo', title: '' }, 'a', NOW)).toThrow(SiuError);
  });
  it('escalate sets the flag', () => {
    const { store, id } = openOne();
    expect(store.escalate('BANK_DEMO', id, 'a', NOW).escalated).toBe(true);
  });
  it('link-alert dedupes', () => {
    const { store, id } = openOne();
    store.linkAlert('BANK_DEMO', id, 'a-700001', 'a', NOW);
    const inv = store.linkAlert('BANK_DEMO', id, 'a-700001', 'a', NOW);
    expect(inv.linked_alerts).toEqual(['a-700001']);
  });
  it('mutations on unknown investigation throw', () => {
    const { store } = openOne();
    expect(() => store.addNote('BANK_DEMO', 'siu-x', 'hi', 'a', NOW)).toThrow(SiuError);
    expect(() => store.escalate('BANK_DEMO', 'siu-x', 'a', NOW)).toThrow(SiuError);
  });
});
