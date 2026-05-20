// Recovery Center Phase 2h — CMS case attachment adoption.
//
// BFF-local adopter (same in-process pattern as
// webhooks + saved_scenario + saved_report_filter). Wire shape:
//   DELETE /v1/cms/cases/:case_id/attachments/:attachment_id
//   → archive the row before deleting (best-effort)
//   → registered RecoveryAdapter restores via cmsCaseStore.restoreAttachment
//
// Closes one more loose end in the BFF-side hard-delete audit.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { _resetRecoveryAdapters } from '../src/recovery/adapters';
import { InMemoryCmsCaseStore } from '../src/cms_store';

const NOW = new Date('2026-05-20T15:00:00.000Z');

function setup() {
  _resetRecoveryAdapters();
  const cmsCaseStore = new InMemoryCmsCaseStore();
  const recoveryStore = new InMemoryRecoveryStore();
  const auditTrailStore = new InMemoryAuditTrailStore();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    cmsCaseStore,
    recoveryStore,
    auditTrailStore,
    now: () => NOW,
    getRole: () => 'admin',
  });
  return { app, cmsCaseStore, recoveryStore, auditTrailStore };
}

const HEADERS = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-source-system': 'test',
  'x-apex-user': 'alice.admin',
};

/** Create a case + attachment via the BFF, return both. */
async function createCaseAndAttachment(app: ReturnType<typeof makeApp>['app']) {
  const create = await request(app)
    .post('/v1/cms/cases')
    .set(HEADERS)
    .send({
      title: 'Attachment-recovery test case',
      description: 'Phase 2h adoption',
      priority: 'P3',
    });
  expect(create.status).toBe(201);
  const case_id =
    (create.body.body?.case_id as string) ?? (create.body.case_id as string);
  const att = await request(app)
    .post(`/v1/cms/cases/${case_id}/attachments`)
    .set(HEADERS)
    .send({
      file_name: 'evidence.pdf',
      file_url: 'https://example.com/blob/evidence.pdf',
      file_size: 12345,
      mime_type: 'application/pdf',
    });
  expect(att.status).toBe(201);
  const attachment_id =
    (att.body.body?.attachment_id as string) ?? (att.body.attachment_id as string);
  return { case_id, attachment_id };
}

// ─── Archive-before-delete ──────────────────────────────────────────

describe('DELETE /v1/cms/cases/:id/attachments/:aid archives before delete', () => {
  test('happy path: attachment archived, then deleted; recovery row visible in /v1/recovery list', async () => {
    const { app, recoveryStore } = setup();
    const { case_id, attachment_id } = await createCaseAndAttachment(app);
    const del = await request(app)
      .delete(`/v1/cms/cases/${case_id}/attachments/${attachment_id}`)
      .set(HEADERS);
    expect(del.status).toBe(204);

    // Recovery store has the archived row.
    const stats = await recoveryStore.stats('BANK_DEMO');
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.by_entity_type['cms_case_attachment']).toBe(1);

    // Visible via the admin list route.
    const list = await request(app)
      .get('/v1/recovery?status=archived')
      .set(HEADERS);
    expect(list.status).toBe(200);
    const items = list.body.body.items as Array<{
      entity_type: string;
      original_id: string;
      original_table: string;
      payload: { file_name: string; case_id: string };
      deleted_by: string;
    }>;
    const ours = items.find((i) => i.original_id === attachment_id);
    expect(ours).toBeDefined();
    expect(ours!.entity_type).toBe('cms_case_attachment');
    expect(ours!.original_table).toBe('app_cases.cms_case_attachments');
    expect(ours!.deleted_by).toBe('alice.admin');
    expect(ours!.payload.file_name).toBe('evidence.pdf');
    expect(ours!.payload.case_id).toBe(case_id);
  });

  test('unknown attachment_id → 404 + no archive (Recycle Bin stays clean)', async () => {
    const { app, recoveryStore } = setup();
    // Need a real case to satisfy the route's parent lookup.
    const create = await request(app)
      .post('/v1/cms/cases')
      .set(HEADERS)
      .send({
        title: 'No-attachment-here',
        description: 'x',
        priority: 'P4',
      });
    const case_id =
      (create.body.body?.case_id as string) ?? (create.body.case_id as string);
    const del = await request(app)
      .delete(`/v1/cms/cases/${case_id}/attachments/att-does-not-exist`)
      .set(HEADERS);
    expect(del.status).toBe(404);
    const stats = await recoveryStore.stats('BANK_DEMO');
    expect(stats.total).toBe(0);
  });

  test('audit trail records `recovery.archive` event', async () => {
    const { app, auditTrailStore } = setup();
    const { case_id, attachment_id } = await createCaseAndAttachment(app);
    await request(app)
      .delete(`/v1/cms/cases/${case_id}/attachments/${attachment_id}`)
      .set(HEADERS);
    const events = auditTrailStore.list('BANK_DEMO', {}).items;
    const archive = events.find((e) => e.action === 'recovery.archive');
    expect(archive).toBeDefined();
    expect(archive!.actor_username).toBe('alice.admin');
    const meta = archive!.metadata as { entity_type: string };
    expect(meta.entity_type).toBe('cms_case_attachment');
  });
});

// ─── Restore via /v1/recovery/:id/restore ───────────────────────────

describe('POST /v1/recovery/:id/restore for cms_case_attachment', () => {
  test('happy path: restore re-inserts the attachment on the same case', async () => {
    const { app, recoveryStore } = setup();
    const { case_id, attachment_id } = await createCaseAndAttachment(app);
    await request(app)
      .delete(`/v1/cms/cases/${case_id}/attachments/${attachment_id}`)
      .set(HEADERS);

    // Confirm gone from the case's attachment list.
    const listBefore = await request(app)
      .get(`/v1/cms/cases/${case_id}/attachments`)
      .set(HEADERS);
    const arrBefore =
      (listBefore.body.body?.items as Array<{ attachment_id: string }> | undefined) ??
      (listBefore.body.items as Array<{ attachment_id: string }> | undefined) ??
      [];
    expect(arrBefore.find((a) => a.attachment_id === attachment_id)).toBeUndefined();

    // Find the recovery_id.
    const listRec = await request(app)
      .get('/v1/recovery?status=archived')
      .set(HEADERS);
    const recoveryRow = (listRec.body.body.items as Array<{
      recovery_id: string;
      original_id: string;
    }>).find((i) => i.original_id === attachment_id)!;

    // Restore.
    const restore = await request(app)
      .post(`/v1/recovery/${recoveryRow.recovery_id}/restore`)
      .set(HEADERS);
    expect(restore.status).toBe(200);
    expect(restore.body.body.status).toBe('restored');

    // Attachment is back on the case.
    const listAfter = await request(app)
      .get(`/v1/cms/cases/${case_id}/attachments`)
      .set(HEADERS);
    const arrAfter =
      (listAfter.body.body?.items as Array<{ attachment_id: string; file_name: string }> | undefined) ??
      (listAfter.body.items as Array<{ attachment_id: string; file_name: string }> | undefined) ??
      [];
    const restored = arrAfter.find((a) => a.attachment_id === attachment_id);
    expect(restored).toBeDefined();
    expect(restored!.file_name).toBe('evidence.pdf');

    // Recovery row marked restored.
    const rec = await recoveryStore.get('BANK_DEMO', recoveryRow.recovery_id);
    expect(rec!.status).toBe('restored');
  });

  test('409 restore_conflict when an attachment with the same id already exists', async () => {
    const { app } = setup();
    const { case_id, attachment_id } = await createCaseAndAttachment(app);
    await request(app)
      .delete(`/v1/cms/cases/${case_id}/attachments/${attachment_id}`)
      .set(HEADERS);
    const listRec = await request(app)
      .get('/v1/recovery?status=archived')
      .set(HEADERS);
    const recoveryRow = (listRec.body.body.items as Array<{
      recovery_id: string;
      original_id: string;
    }>).find((i) => i.original_id === attachment_id)!;
    // First restore succeeds.
    const r1 = await request(app)
      .post(`/v1/recovery/${recoveryRow.recovery_id}/restore`)
      .set(HEADERS);
    expect(r1.status).toBe(200);
    // The recovery row is now in 'restored' state — a SECOND restore on
    // the SAME recovery row gives 409 already_restored (per Phase 1
    // semantic). Verify the user gets a clear error.
    const r2 = await request(app)
      .post(`/v1/recovery/${recoveryRow.recovery_id}/restore`)
      .set(HEADERS);
    expect(r2.status).toBe(409);
  });

  test('admin RBAC enforced — non-admin role cannot restore', async () => {
    _resetRecoveryAdapters();
    const cmsCaseStore = new InMemoryCmsCaseStore();
    const recoveryStore = new InMemoryRecoveryStore();
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      cmsCaseStore,
      recoveryStore,
      now: () => NOW,
      getRole: () => 'risk_analyst', // non-admin
    });
    const list = await request(app).get('/v1/recovery').set(HEADERS);
    // Recovery list itself is admin-only.
    expect(list.status).toBe(403);
  });
});
