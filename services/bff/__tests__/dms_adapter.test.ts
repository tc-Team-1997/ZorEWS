// services/bff/__tests__/dms_adapter.test.ts
//
// T6 M14.4 — DMS Document Management adapter.

import request from 'supertest';
import {
  DmsError,
  StubDmsAdapter,
  isDocumentStatus,
  isDocumentType,
  listDocumentTypes,
  type DmsAdapter,
  type DmsDocument,
} from '../src/integrations/dms';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeDmsApp(role: string = 'admin', dmsAdapter?: DmsAdapter) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    dmsAdapter,
  });
}

// ─── Type guards + helpers ─────────────────────────────────────────────

describe('isDocumentStatus / isDocumentType', () => {
  test('isDocumentStatus accepts the 4 valid statuses', () => {
    expect(isDocumentStatus('pending_review')).toBe(true);
    expect(isDocumentStatus('verified')).toBe(true);
    expect(isDocumentStatus('rejected')).toBe(true);
    expect(isDocumentStatus('expired')).toBe(true);
    expect(isDocumentStatus('PENDING')).toBe(false);
  });
  test('isDocumentType accepts the 9 valid types', () => {
    for (const t of listDocumentTypes()) expect(isDocumentType(t)).toBe(true);
    expect(isDocumentType('contract')).toBe(false);
  });
  test('listDocumentTypes returns all 9 in canonical order', () => {
    expect(listDocumentTypes()).toEqual([
      'claim_form',
      'medical_record',
      'kyc_proof',
      'identity_proof',
      'address_proof',
      'policy_doc',
      'photo',
      'invoice',
      'misc',
    ]);
  });
});

// ─── StubDmsAdapter — listByCustomer ───────────────────────────────────

describe('StubDmsAdapter — listByCustomer', () => {
  test('returns 0-12 documents per customer', async () => {
    const a = new StubDmsAdapter();
    const docs = await a.listByCustomer('BIL', 'c-101', NOW);
    expect(docs.length).toBeGreaterThanOrEqual(0);
    expect(docs.length).toBeLessThanOrEqual(12);
  });

  test('deterministic — same (tenant, customer) → identical document_ids', async () => {
    const a = new StubDmsAdapter();
    const a1 = await a.listByCustomer('BIL', 'c-101', NOW);
    const a2 = await a.listByCustomer('BIL', 'c-101', NOW);
    expect(a1.map((d) => d.document_id)).toEqual(a2.map((d) => d.document_id));
  });

  test('different tenants → disjoint document_ids', async () => {
    const a = new StubDmsAdapter();
    let differs = false;
    for (let i = 0; i < 30 && !differs; i++) {
      const bil = await a.listByCustomer('BIL', `c-${i}`, NOW);
      const bank = await a.listByCustomer('BANK_DEMO', `c-${i}`, NOW);
      const bilIds = new Set(bil.map((d) => d.document_id));
      for (const d of bank) {
        if (bilIds.has(d.document_id)) {
          fail('overlap detected');
        }
      }
      if (bil.length > 0 || bank.length > 0) differs = true;
    }
    expect(differs).toBe(true);
  });

  test('sorted newest-uploaded-first', async () => {
    const a = new StubDmsAdapter();
    // sample many until we find a customer with >=2 docs
    for (let i = 0; i < 100; i++) {
      const docs = await a.listByCustomer('BIL', `c-${i}`, NOW);
      if (docs.length >= 2) {
        for (let j = 1; j < docs.length; j++) {
          expect(docs[j - 1]!.uploaded_at >= docs[j]!.uploaded_at).toBe(true);
        }
        return;
      }
    }
  });

  test('every document has required fields with valid types', async () => {
    const a = new StubDmsAdapter();
    let total = 0;
    for (let i = 0; i < 30; i++) {
      const docs = await a.listByCustomer('BIL', `c-${i}`, NOW);
      for (const d of docs) {
        total++;
        expect(d.document_id).toMatch(/^dms-bil-\d{7}$/);
        expect(d.customer_id).toBe(`c-${i}`);
        expect(listDocumentTypes()).toContain(d.type);
        expect(['pending_review', 'verified', 'rejected', 'expired']).toContain(d.status);
        expect(d.size_bytes).toBeGreaterThan(0);
        expect(d.size_bytes).toBeLessThanOrEqual(5_000_000);
        expect(d.download_url).toMatch(/^\/v1\/integrations\/dms\/documents\//);
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  test('proof types may carry expires_at; non-proofs do not', async () => {
    const a = new StubDmsAdapter();
    for (let i = 0; i < 30; i++) {
      const docs = await a.listByCustomer('BIL', `c-${i}`, NOW);
      for (const d of docs) {
        const isProof = d.type === 'kyc_proof' || d.type === 'identity_proof' || d.type === 'address_proof';
        if (!isProof) {
          expect(d.expires_at).toBeNull();
        }
      }
    }
  });

  test('expired status implies expires_at <= now', async () => {
    const a = new StubDmsAdapter();
    let saw = false;
    for (let i = 0; i < 200 && !saw; i++) {
      const docs = await a.listByCustomer('BIL', `c-${i}`, NOW);
      for (const d of docs) {
        if (d.status === 'expired') {
          saw = true;
          expect(d.expires_at).not.toBeNull();
          expect(d.expires_at!.localeCompare(NOW.toISOString()) <= 0).toBe(true);
        }
      }
    }
  });

  test('pending_review docs have no status_changed_at; non-pending do', async () => {
    const a = new StubDmsAdapter();
    for (let i = 0; i < 30; i++) {
      const docs = await a.listByCustomer('BIL', `c-${i}`, NOW);
      for (const d of docs) {
        if (d.status === 'pending_review') {
          expect(d.status_changed_at).toBeNull();
          expect(d.status_changed_by).toBeNull();
        } else {
          expect(d.status_changed_at).not.toBeNull();
          expect(d.status_changed_by).not.toBeNull();
        }
      }
    }
  });

  test('empty customer_id → empty list', async () => {
    const a = new StubDmsAdapter();
    expect(await a.listByCustomer('BIL', '', NOW)).toEqual([]);
  });
});

// ─── StubDmsAdapter — listByCase + get + updateStatus ──────────────────

describe('StubDmsAdapter — listByCase', () => {
  test('returns docs linked to a case; empty before listByCustomer is called', async () => {
    const a = new StubDmsAdapter();
    expect(await a.listByCase('BIL', 'CASE-1')).toEqual([]);
  });

  test('after warming customer caches, listByCase returns case-linked docs', async () => {
    const a = new StubDmsAdapter();
    // Warm 50 customers; ~30% of docs link to a case so we should find some
    for (let i = 0; i < 50; i++) {
      await a.listByCustomer('BIL', `c-${i}`, NOW);
    }
    // Find a case_id that exists by sampling
    let target_case_id: string | null = null;
    for (let i = 0; i < 50 && !target_case_id; i++) {
      const docs = await a.listByCustomer('BIL', `c-${i}`, NOW);
      for (const d of docs) {
        if (d.case_id) {
          target_case_id = d.case_id;
          break;
        }
      }
    }
    expect(target_case_id).not.toBeNull();
    const caseDocs = await a.listByCase('BIL', target_case_id!);
    expect(caseDocs.length).toBeGreaterThan(0);
    for (const d of caseDocs) {
      expect(d.case_id).toBe(target_case_id);
    }
  });

  test('listByCase is tenant-scoped', async () => {
    const a = new StubDmsAdapter();
    await a.listByCustomer('BIL', 'c-1', NOW);
    expect(await a.listByCase('BANK_DEMO', 'CASE-1')).toEqual([]);
  });
});

describe('StubDmsAdapter — get + updateStatus', () => {
  async function findDoc(a: StubDmsAdapter): Promise<DmsDocument> {
    for (let i = 0; i < 50; i++) {
      const docs = await a.listByCustomer('BIL', `c-${i}`, NOW);
      if (docs.length > 0) return docs[0]!;
    }
    throw new Error('fixture: no docs');
  }

  test('get returns doc by id; null for miss / cross-tenant', async () => {
    const a = new StubDmsAdapter();
    const d = await findDoc(a);
    expect((await a.get('BIL', d.document_id))!.document_id).toBe(d.document_id);
    expect(await a.get('BIL', 'dms-bil-9999999')).toBeNull();
    expect(await a.get('BANK_DEMO', d.document_id)).toBeNull();
  });

  test('updateStatus updates fields, mirrors across both maps', async () => {
    const a = new StubDmsAdapter();
    const d = await findDoc(a);
    const updated = await a.updateStatus('BIL', d.document_id, 'verified', 'taniya', NOW);
    expect(updated.status).toBe('verified');
    expect(updated.status_changed_at).toBe(NOW.toISOString());
    expect(updated.status_changed_by).toBe('taniya');
    // Mirror check via listByCustomer
    const list = await a.listByCustomer('BIL', d.customer_id, NOW);
    const fromList = list.find((x) => x.document_id === d.document_id)!;
    expect(fromList.status).toBe('verified');
  });

  test('updateStatus with invalid status throws invalid_status', async () => {
    const a = new StubDmsAdapter();
    const d = await findDoc(a);
    try {
      await a.updateStatus('BIL', d.document_id, 'OK' as never, 't', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as DmsError).code).toBe('invalid_status');
    }
  });

  test('updateStatus with unknown document throws unknown_document', async () => {
    const a = new StubDmsAdapter();
    try {
      await a.updateStatus('BIL', 'dms-bil-9999999', 'verified', 't', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as DmsError).code).toBe('unknown_document');
    }
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/integrations/dms/document-types', () => {
  test('returns the 9 document types', async () => {
    const { app } = makeDmsApp('admin');
    const r = await request(app).get('/v1/integrations/dms/document-types').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(9);
  });

  test('unknown role → 403', async () => {
    const { app } = makeDmsApp('case_owner');
    const r = await request(app).get('/v1/integrations/dms/document-types').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/integrations/dms/documents', () => {
  test('?customer_id=X returns the customer\'s docs', async () => {
    const { app } = makeDmsApp('admin');
    const r = await request(app)
      .get('/v1/integrations/dms/documents?customer_id=c-101')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('c-101');
    expect(r.body.body.case_id).toBeNull();
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });

  test('?case_id=X returns case-linked docs', async () => {
    const adapter = new StubDmsAdapter();
    const { app } = makeDmsApp('admin', adapter);
    // Warm + find a real case_id
    let target_case: string | null = null;
    for (let i = 0; i < 50 && !target_case; i++) {
      const docs = await adapter.listByCustomer('BIL', `c-${i}`, NOW);
      for (const d of docs) {
        if (d.case_id) {
          target_case = d.case_id;
          break;
        }
      }
    }
    expect(target_case).not.toBeNull();
    const r = await request(app)
      .get(`/v1/integrations/dms/documents?case_id=${target_case}`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.case_id).toBe(target_case);
    expect(r.body.body.items.length).toBeGreaterThan(0);
  });

  test('neither customer_id nor case_id → 400', async () => {
    const { app } = makeDmsApp('admin');
    const r = await request(app).get('/v1/integrations/dms/documents').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('both customer_id AND case_id → 400 (must pick one)', async () => {
    const { app } = makeDmsApp('admin');
    const r = await request(app)
      .get('/v1/integrations/dms/documents?customer_id=c-1&case_id=CASE-1')
      .set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown role → 403', async () => {
    const { app } = makeDmsApp('case_owner');
    const r = await request(app)
      .get('/v1/integrations/dms/documents?customer_id=c-1')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('adapter throwing → 502 envelope', async () => {
    const exploding: DmsAdapter = {
      async listByCustomer() {
        throw new Error('vendor timeout');
      },
      async listByCase() {
        return [];
      },
      async get() {
        return null;
      },
      async updateStatus() {
        return {} as DmsDocument;
      },
    };
    const { app } = makeDmsApp('admin', exploding);
    const r = await request(app)
      .get('/v1/integrations/dms/documents?customer_id=c-1')
      .set(TH_BIL);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('EWS_502');
  });
});

describe('GET /v1/integrations/dms/documents/:document_id', () => {
  test('valid id → 200 with the doc', async () => {
    const adapter = new StubDmsAdapter();
    const { app } = makeDmsApp('admin', adapter);
    let target_id: string | null = null;
    for (let i = 0; i < 50 && !target_id; i++) {
      const docs = await adapter.listByCustomer('BIL', `c-${i}`, NOW);
      if (docs.length > 0) target_id = docs[0]!.document_id;
    }
    const r = await request(app).get(`/v1/integrations/dms/documents/${target_id}`).set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.document_id).toBe(target_id);
  });

  test('unknown id → 404', async () => {
    const { app } = makeDmsApp('admin');
    const r = await request(app)
      .get('/v1/integrations/dms/documents/dms-bil-9999999')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404', async () => {
    const adapter = new StubDmsAdapter();
    const { app } = makeDmsApp('admin', adapter);
    let target_id: string | null = null;
    for (let i = 0; i < 50 && !target_id; i++) {
      const docs = await adapter.listByCustomer('BIL', `c-${i}`, NOW);
      if (docs.length > 0) target_id = docs[0]!.document_id;
    }
    const r = await request(app).get(`/v1/integrations/dms/documents/${target_id}`).set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/integrations/dms/documents/:document_id/status', () => {
  async function seedDoc(adapter: StubDmsAdapter): Promise<{ id: string; customer: string }> {
    for (let i = 0; i < 50; i++) {
      const docs = await adapter.listByCustomer('BIL', `c-${i}`, NOW);
      if (docs.length > 0) return { id: docs[0]!.document_id, customer: `c-${i}` };
    }
    throw new Error('fixture: no docs');
  }

  test('valid status → 200 with updated fields', async () => {
    const adapter = new StubDmsAdapter();
    const { app } = makeDmsApp('admin', adapter);
    const { id } = await seedDoc(adapter);
    const r = await request(app)
      .patch(`/v1/integrations/dms/documents/${id}/status`)
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ status: 'verified' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('verified');
    expect(r.body.body.status_changed_by).toBe('taniya');
  });

  test('default changed_by is "admin"', async () => {
    const adapter = new StubDmsAdapter();
    const { app } = makeDmsApp('admin', adapter);
    const { id } = await seedDoc(adapter);
    const r = await request(app)
      .patch(`/v1/integrations/dms/documents/${id}/status`)
      .set(TH_BIL)
      .send({ status: 'verified' });
    expect(r.body.body.status_changed_by).toBe('admin');
  });

  test('accepts an enveloped request body', async () => {
    const adapter = new StubDmsAdapter();
    const { app } = makeDmsApp('admin', adapter);
    const { id } = await seedDoc(adapter);
    const r = await request(app)
      .patch(`/v1/integrations/dms/documents/${id}/status`)
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { status: 'rejected' } });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('rejected');
  });

  test('invalid status → 400 EWS_400_invalid_status', async () => {
    const adapter = new StubDmsAdapter();
    const { app } = makeDmsApp('admin', adapter);
    const { id } = await seedDoc(adapter);
    const r = await request(app)
      .patch(`/v1/integrations/dms/documents/${id}/status`)
      .set(TH_BIL)
      .send({ status: 'OK' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('unknown id → 404 EWS_404_unknown_document', async () => {
    const { app } = makeDmsApp('admin');
    const r = await request(app)
      .patch('/v1/integrations/dms/documents/dms-bil-9999999/status')
      .set(TH_BIL)
      .send({ status: 'verified' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_document');
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL list does not leak to BANK_DEMO', async () => {
    const adapter = new StubDmsAdapter();
    const { app } = makeDmsApp('admin', adapter);
    const bil = await request(app)
      .get('/v1/integrations/dms/documents?customer_id=c-101')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/dms/documents?customer_id=c-101')
      .set(TH_BANK);
    const bilIds: string[] = (bil.body.body.items as DmsDocument[]).map((d) => d.document_id);
    for (const d of bank.body.body.items as DmsDocument[]) {
      expect(bilIds).not.toContain(d.document_id);
    }
  });
});
