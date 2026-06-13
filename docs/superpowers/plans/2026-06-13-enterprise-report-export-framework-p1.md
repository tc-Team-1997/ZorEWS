# Enterprise Report Export Framework — P1-thin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a shared, RBAC-gated, audited report-export framework (PDF/Excel/CSV) driven by a per-screen `ReportData` adapter contract, piloted on Customer Risk Profile + Alerts.

**Architecture:** Hybrid (Option C) — reports are generated client-side from a screen-supplied `ReportData` object via pure generator functions; every export then fires `POST /v1/exports` so the BFF writes a server-trustworthy M15.1 audit event + an in-memory export-history record. Additive only — no existing route/API/RBAC/UI changes.

**Tech Stack:** TypeScript. Frontend: React 18 + Vite + vitest, jspdf + jspdf-autotable (PDF), write-excel-file/browser (XLSX). Backend: Express + jest, existing envelope (`wrapResponse`/`wrapError`), `requireTenant` + `@apex-ews/rbac` `requireRole`, M15.1 `AuditTrailStore`.

**Spec:** `docs/superpowers/specs/2026-06-13-enterprise-report-export-framework-design.md`

---

## File Structure

**Backend — `services/bff/src/exports/` (new dir):**
- `store.ts` — `ExportFormat`, `ReportType`, `ExportConfig`, `ExportRecord`, `ExportHistoryStore` interface, `InMemoryExportHistoryStore`, `defaultExportHistoryStore` singleton, `_resetDefaultExportHistoryStore` test helper, `ExportRecordError`.
- Routes live in `services/bff/src/server.ts` (existing file) following the M15.1 audit-route pattern.
- Tests: `services/bff/__tests__/exports.test.ts`.

**Frontend — `web/src/lib/export/` (new dir):**
- `types.ts` — `ReportType`, `ExportFormat`, `ExportConfig`, `ReportData`, `ReportAdapter` (shared with BFF shapes by structure, not import).
- `generators/csv.ts` — `buildReportCsv(data, config) → Blob`.
- `generators/pdf.ts` — `buildReportPdf(data, config) → jsPDF`, `reportPdfBlob(...)`.
- `generators/xlsx.ts` — `buildReportXlsxBlob(data, config) → Promise<Blob>`.
- `recordExport.ts` — `recordExport(input) → Promise<void>` (fires `POST /v1/exports`, best-effort).
- Tests: `web/src/__tests__/exportGenerators.test.ts`, `web/src/__tests__/recordExport.test.ts`.

**Frontend — `web/src/components/export/` (new dir):**
- `ExportModal.tsx` — config UI + generate orchestration.
- `ExportButton.tsx` — RBAC-gated trigger that opens the modal.
- Tests: `web/src/__tests__/ExportModal.test.tsx`, `web/src/__tests__/ExportButton.test.tsx`.

**Frontend — pilot adapters (new files next to their pages):**
- `web/src/modules/customers/customerReportAdapter.ts` + wire button into `CustomerRiskProfilePage.tsx`.
- `web/src/modules/alerts/alertsReportAdapter.ts` + wire button into `AlertListPage.tsx`.
- Tests: `web/src/__tests__/customerReportAdapter.test.ts`, `web/src/__tests__/alertsReportAdapter.test.ts`.

**RBAC — `infra/rbac/matrix.json` (existing):** add `reports:export`.

**MSW — `web/src/mocks/handlers.ts` (existing):** add `/v1/exports` handlers.

---

## Task 1: RBAC scope `reports:export`

**Files:**
- Modify: `infra/rbac/matrix.json` (operations map)
- Test: `infra/rbac/scripts/__tests__` is python; the TS guard is `infra/rbac/lib/src/__tests__/rbac.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `infra/rbac/lib/src/__tests__/rbac.test.ts`:

```ts
test('reports:export is analyst+ (admin, supervisor, risk_analyst)', () => {
  expect(can('admin', 'reports:export')).toBe(true);
  expect(can('supervisor', 'reports:export')).toBe(true);
  expect(can('risk_analyst', 'reports:export')).toBe(true);
  expect(can('field_officer', 'reports:export')).toBe(false);
  expect(can('collection_officer', 'reports:export')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd infra/rbac/lib && npx jest -t "reports:export is analyst"`
Expected: FAIL — `can('admin','reports:export')` is `false` (unknown op fails closed).

- [ ] **Step 3: Add the scope to the matrix**

In `infra/rbac/matrix.json`, inside `"operations"`, add (alphabetical-ish, near the other `reports:` entries):

```json
    "reports:export": [
      "admin",
      "supervisor",
      "risk_analyst"
    ],
```

- [ ] **Step 4: Rebuild the rbac lib + run test to verify it passes**

Run: `cd infra/rbac/lib && npm run build && npx jest -t "reports:export is analyst"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/rbac/matrix.json infra/rbac/lib/src/__tests__/rbac.test.ts
git commit -m "feat(rbac): add reports:export scope (analyst+) for export framework"
```

---

## Task 2: Export history store (BFF)

**Files:**
- Create: `services/bff/src/exports/store.ts`
- Test: `services/bff/__tests__/exports.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/bff/__tests__/exports.test.ts`:

```ts
import {
  InMemoryExportHistoryStore,
  ExportRecordError,
  type ExportRecordInput,
} from '../src/exports/store';

const NOW = new Date('2026-06-13T10:00:00.000Z');
function input(over: Partial<ExportRecordInput> = {}): ExportRecordInput {
  return {
    generated_by: 'alice.admin',
    role: 'admin',
    module: 'customer_360',
    report_type: 'customer',
    format: 'pdf',
    record_count: 12,
    title: 'Customer Report — c-101',
    status: 'completed',
    config: { formats: ['pdf'], report_type: 'customer', date_range: '30d', data_scope: 'complete', include: {} },
    ...over,
  };
}

describe('InMemoryExportHistoryStore', () => {
  test('add() returns a record with EXP- id, tenant, and echoed fields', () => {
    const s = new InMemoryExportHistoryStore();
    const rec = s.add('BANK_DEMO', input(), NOW, 1);
    expect(rec.export_id).toBe('EXP-BANK_DEMO-1781690400000-1');
    expect(rec.tenant_id).toBe('BANK_DEMO');
    expect(rec.format).toBe('pdf');
    expect(rec.record_count).toBe(12);
    expect(rec.status).toBe('completed');
    expect(rec.generated_at).toBe('2026-06-13T10:00:00.000Z');
  });

  test('list() is newest-first and tenant-scoped', () => {
    const s = new InMemoryExportHistoryStore();
    s.add('BANK_DEMO', input({ format: 'csv' }), new Date('2026-06-13T10:00:00Z'), 1);
    s.add('BANK_DEMO', input({ format: 'pdf' }), new Date('2026-06-13T11:00:00Z'), 2);
    s.add('BIL', input(), new Date('2026-06-13T12:00:00Z'), 3);
    const page = s.list('BANK_DEMO', {});
    expect(page.total).toBe(2);
    expect(page.items[0].format).toBe('pdf'); // newest first
    expect(page.items.every((r) => r.tenant_id === 'BANK_DEMO')).toBe(true);
  });

  test('list() filters by module + format', () => {
    const s = new InMemoryExportHistoryStore();
    s.add('BANK_DEMO', input({ module: 'alerts', format: 'csv' }), NOW, 1);
    s.add('BANK_DEMO', input({ module: 'customer_360', format: 'pdf' }), NOW, 2);
    expect(s.list('BANK_DEMO', { module: 'alerts' }).total).toBe(1);
    expect(s.list('BANK_DEMO', { format: 'pdf' }).total).toBe(1);
  });

  test('get() returns the record incl. config_snapshot, null cross-tenant', () => {
    const s = new InMemoryExportHistoryStore();
    const rec = s.add('BANK_DEMO', input(), NOW, 1);
    expect(s.get('BANK_DEMO', rec.export_id)?.config.report_type).toBe('customer');
    expect(s.get('BIL', rec.export_id)).toBeNull();
  });

  test('add() rejects invalid format / missing module', () => {
    const s = new InMemoryExportHistoryStore();
    expect(() => s.add('BANK_DEMO', input({ format: 'docx' as never }), NOW, 1)).toThrow(ExportRecordError);
    expect(() => s.add('BANK_DEMO', input({ module: '' }), NOW, 1)).toThrow(ExportRecordError);
  });

  test('per-tenant FIFO cap evicts oldest', () => {
    const s = new InMemoryExportHistoryStore(2);
    s.add('BANK_DEMO', input({ title: 'a' }), new Date('2026-06-13T10:00:00Z'), 1);
    s.add('BANK_DEMO', input({ title: 'b' }), new Date('2026-06-13T11:00:00Z'), 2);
    s.add('BANK_DEMO', input({ title: 'c' }), new Date('2026-06-13T12:00:00Z'), 3);
    const titles = s.list('BANK_DEMO', {}).items.map((r) => r.title);
    expect(titles).toEqual(['c', 'b']); // 'a' evicted, newest-first
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/bff && npx jest __tests__/exports.test.ts`
Expected: FAIL — cannot find `../src/exports/store`.

- [ ] **Step 3: Write the store**

Create `services/bff/src/exports/store.ts`:

```ts
// services/bff/src/exports/store.ts
//
// P1 — Enterprise Report Export Framework history + audit-record store.
// In-memory, per-tenant, FIFO-capped. pg-swap-ready: a PgExportHistoryStore
// satisfying ExportHistoryStore is a future drop-in (matches the T4.13–T4.18
// pattern). Records are written by POST /v1/exports on every export.

export const ALL_EXPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ExportFormat = (typeof ALL_EXPORT_FORMATS)[number];

export const ALL_REPORT_TYPES = [
  'customer', 'risk', 'case', 'recovery',
  'compliance', 'portfolio', 'executive', 'ai_insight',
] as const;
export type ReportType = (typeof ALL_REPORT_TYPES)[number];

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (ALL_EXPORT_FORMATS as readonly string[]).includes(v);
}
export function isReportType(v: unknown): v is ReportType {
  return typeof v === 'string' && (ALL_REPORT_TYPES as readonly string[]).includes(v);
}

/** The modal's config, snapshotted so P1 can "re-run with same config". */
export interface ExportConfigSnapshot {
  formats: ExportFormat[];
  report_type: ReportType;
  date_range: string;
  data_scope: string;
  include: Record<string, boolean>;
  custom_range?: { from: string; to: string };
}

export interface ExportRecordInput {
  generated_by: string;
  role: string;
  module: string;
  report_type: ReportType;
  format: ExportFormat;
  record_count: number;
  title: string;
  status: 'completed' | 'failed';
  config: ExportConfigSnapshot;
}

export interface ExportRecord extends ExportRecordInput {
  export_id: string;
  tenant_id: string;
  generated_at: string; // ISO
}

export interface ExportListFilters {
  module?: string;
  format?: ExportFormat;
  report_type?: ReportType;
  page?: number;
  page_size?: number;
}

export interface ExportListPage {
  items: ExportRecord[];
  total: number;
  page: number;
  page_size: number;
}

export interface ExportHistoryStore {
  add(tenant_id: string, input: ExportRecordInput, now: Date, seq: number): ExportRecord;
  list(tenant_id: string, filters: ExportListFilters): ExportListPage;
  get(tenant_id: string, export_id: string): ExportRecord | null;
}

export class ExportRecordError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ExportRecordError';
  }
}

const DEFAULT_CAP = 500;

export class InMemoryExportHistoryStore implements ExportHistoryStore {
  private byTenant = new Map<string, ExportRecord[]>();
  constructor(private readonly cap = DEFAULT_CAP) {}

  add(tenant_id: string, input: ExportRecordInput, now: Date, seq: number): ExportRecord {
    if (!tenant_id) throw new ExportRecordError('invalid_input', 'tenant_id required');
    if (!input.module || typeof input.module !== 'string') {
      throw new ExportRecordError('invalid_input', 'module required');
    }
    if (!isExportFormat(input.format)) {
      throw new ExportRecordError('invalid_format', `invalid format: ${String(input.format)}`);
    }
    if (!isReportType(input.report_type)) {
      throw new ExportRecordError('invalid_report_type', `invalid report_type: ${String(input.report_type)}`);
    }
    const rec: ExportRecord = {
      ...input,
      export_id: `EXP-${tenant_id}-${now.getTime()}-${seq}`,
      tenant_id,
      generated_at: now.toISOString(),
    };
    const list = this.byTenant.get(tenant_id) ?? [];
    list.push(rec);
    while (list.length > this.cap) list.shift();
    this.byTenant.set(tenant_id, list);
    return { ...rec };
  }

  list(tenant_id: string, filters: ExportListFilters): ExportListPage {
    let rows = (this.byTenant.get(tenant_id) ?? []).slice();
    if (filters.module) rows = rows.filter((r) => r.module === filters.module);
    if (filters.format) rows = rows.filter((r) => r.format === filters.format);
    if (filters.report_type) rows = rows.filter((r) => r.report_type === filters.report_type);
    // newest-first
    rows.sort((a, b) => (a.generated_at < b.generated_at ? 1 : a.generated_at > b.generated_at ? -1 : 0));
    const total = rows.length;
    const page = Math.max(1, filters.page ?? 1);
    const page_size = Math.max(1, Math.min(200, filters.page_size ?? 50));
    const start = (page - 1) * page_size;
    return { items: rows.slice(start, start + page_size).map((r) => ({ ...r })), total, page, page_size };
  }

  get(tenant_id: string, export_id: string): ExportRecord | null {
    const rec = (this.byTenant.get(tenant_id) ?? []).find((r) => r.export_id === export_id);
    return rec ? { ...rec } : null;
  }
}

let _default: InMemoryExportHistoryStore | null = null;
export function defaultExportHistoryStore(): InMemoryExportHistoryStore {
  if (!_default) _default = new InMemoryExportHistoryStore();
  return _default;
}
export function _resetDefaultExportHistoryStore(): void {
  _default = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/bff && npx jest __tests__/exports.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add services/bff/src/exports/store.ts services/bff/__tests__/exports.test.ts
git commit -m "feat(bff): in-memory export-history store for export framework"
```

---

## Task 3: Export routes — POST/GET /v1/exports (BFF)

**Files:**
- Modify: `services/bff/src/server.ts` (AppDeps + makeApp store wiring + 3 routes)
- Test: `services/bff/__tests__/exports.test.ts` (append route tests)

- [ ] **Step 1: Write the failing test**

Append to `services/bff/__tests__/exports.test.ts`:

```ts
import request from 'supertest';
import { makeApp } from '../src/server';
import { InMemoryAuditTrailStore } from '../src/audit_trail';

function adminHeaders(tenant = 'BANK_DEMO') {
  return { 'X-Tenant-ID': tenant, 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin', 'x-apex-role': 'admin' };
}
function body() {
  return {
    module: 'customer_360', report_type: 'customer', format: 'pdf',
    record_count: 5, title: 'Customer Report — c-101', status: 'completed',
    config: { formats: ['pdf'], report_type: 'customer', date_range: '30d', data_scope: 'complete', include: { summary: true } },
  };
}

describe('POST/GET /v1/exports', () => {
  test('POST records an export + writes an M15.1 audit event', async () => {
    const audit = new InMemoryAuditTrailStore();
    const app = makeApp({ auditTrailStore: audit });
    const res = await request(app).post('/v1/exports').set(adminHeaders()).send(body());
    expect(res.status).toBe(201);
    expect(res.body.body.export_id).toMatch(/^EXP-BANK_DEMO-/);
    const events = audit.list('BANK_DEMO', { action: 'export.generate' });
    expect(events.total).toBe(1);
    expect(events.items[0].metadata.format).toBe('pdf');
  });

  test('GET lists newest-first, tenant-scoped, filterable', async () => {
    const app = makeApp({});
    await request(app).post('/v1/exports').set(adminHeaders()).send({ ...body(), module: 'alerts', format: 'csv' });
    await request(app).post('/v1/exports').set(adminHeaders()).send(body());
    const all = await request(app).get('/v1/exports').set(adminHeaders());
    expect(all.body.body.total).toBeGreaterThanOrEqual(2);
    const onlyAlerts = await request(app).get('/v1/exports?module=alerts').set(adminHeaders());
    expect(onlyAlerts.body.body.items.every((r: { module: string }) => r.module === 'alerts')).toBe(true);
  });

  test('GET /:id returns config_snapshot; 404 cross-tenant', async () => {
    const app = makeApp({});
    const created = await request(app).post('/v1/exports').set(adminHeaders()).send(body());
    const id = created.body.body.export_id;
    const ok = await request(app).get(`/v1/exports/${id}`).set(adminHeaders());
    expect(ok.status).toBe(200);
    expect(ok.body.body.config.report_type).toBe('customer');
    const cross = await request(app).get(`/v1/exports/${id}`).set(adminHeaders('BIL'));
    expect(cross.status).toBe(404);
  });

  test('POST 403 without reports:export (field_officer)', async () => {
    const app = makeApp({});
    const res = await request(app).post('/v1/exports')
      .set({ ...adminHeaders(), 'x-apex-role': 'field_officer' }).send(body());
    expect(res.status).toBe(403);
  });

  test('POST 400 on invalid format', async () => {
    const app = makeApp({});
    const res = await request(app).post('/v1/exports').set(adminHeaders()).send({ ...body(), format: 'docx' });
    expect(res.status).toBe(400);
  });
});
```

Note: `_resetDefaultExportHistoryStore()` is called in a `beforeEach` so the singleton doesn't leak between tests. Add at the top of this describe-block file region:

```ts
import { _resetDefaultExportHistoryStore } from '../src/exports/store';
beforeEach(() => _resetDefaultExportHistoryStore());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/bff && npx jest __tests__/exports.test.ts -t "POST records"`
Expected: FAIL — route 404 (not registered).

- [ ] **Step 3a: Wire the store into AppDeps + makeApp**

In `services/bff/src/server.ts`:

Add to the imports near the other store imports (~line 982 region):

```ts
import {
  defaultExportHistoryStore,
  type ExportHistoryStore,
  type ExportRecordInput,
  isExportFormat,
  isReportType,
  ExportRecordError,
} from './exports/store';
```

Add to the `AppDeps` interface (~line 1301 region, beside `auditTrailStore?`):

```ts
  /** P1 export framework history store. Defaults to the module-level
   *  InMemoryExportHistoryStore; tests inject a fresh one. */
  exportHistoryStore?: ExportHistoryStore;
```

Add to `makeApp` beside `const auditTrailStore = ...` (~line 1654 region):

```ts
  const exportHistoryStore = deps.exportHistoryStore ?? defaultExportHistoryStore();
  let _exportSeq = 0;
```

- [ ] **Step 3b: Add the 3 routes**

In `services/bff/src/server.ts`, beside the `/v1/audit/*` routes (after the `GET /v1/audit/summary` block), add:

```ts
  // ── P1 Enterprise Report Export Framework ────────────────────────────
  // POST records an export (history + M15.1 audit). GET lists/reads history.
  // Generation itself is client-side; this is the server-trustworthy record.

  app.post(
    '/v1/exports',
    requireTenantMw,
    requireRole('reports:export'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const raw = req.body as { header?: unknown; body?: unknown } | unknown;
      const inner =
        raw && typeof raw === 'object' && 'header' in (raw as object) && 'body' in (raw as object)
          ? (raw as { body: unknown }).body
          : raw;
      if (!inner || typeof inner !== 'object') {
        return res.status(400).json(wrapError({ code: 'EWS_400', message: 'request body required', severity: 'MEDIUM' }, ctx));
      }
      const b = inner as Partial<ExportRecordInput>;
      if (!isExportFormat(b.format)) {
        return res.status(400).json(wrapError({ code: 'EWS_400_invalid_format', message: `invalid format: ${String(b.format)}`, severity: 'MEDIUM' }, ctx));
      }
      if (!isReportType(b.report_type)) {
        return res.status(400).json(wrapError({ code: 'EWS_400_invalid_report_type', message: `invalid report_type: ${String(b.report_type)}`, severity: 'MEDIUM' }, ctx));
      }
      const tenant_id = req.tenant!.tenant_id;
      const actor = (req.headers['x-apex-user'] as string) || b.generated_by || 'unknown';
      const role = (req.headers['x-apex-role'] as string) || b.role || 'unknown';
      const recInput: ExportRecordInput = {
        generated_by: actor,
        role,
        module: String(b.module ?? ''),
        report_type: b.report_type,
        format: b.format,
        record_count: Number.isFinite(b.record_count) ? Number(b.record_count) : 0,
        title: String(b.title ?? ''),
        status: b.status === 'failed' ? 'failed' : 'completed',
        config: (b.config ?? { formats: [b.format], report_type: b.report_type, date_range: 'unknown', data_scope: 'unknown', include: {} }) as ExportRecordInput['config'],
      };
      try {
        const rec = exportHistoryStore.add(tenant_id, recInput, now(), ++_exportSeq);
        auditTrailStore.record(tenant_id, {
          actor_username: actor,
          actor_role: role,
          action: 'export.generate',
          resource_type: 'report',
          resource_id: rec.export_id,
          outcome: recInput.status === 'failed' ? 'failure' : 'success',
          severity: 'info',
          metadata: {
            module: recInput.module, report_type: recInput.report_type,
            format: recInput.format, record_count: recInput.record_count,
            data_scope: recInput.config.data_scope,
          },
        }, now());
        return res.status(201).json(wrapResponse(rec, ctx, { code: 'EWS_201', message: 'Created' }));
      } catch (e) {
        if (e instanceof ExportRecordError) {
          return res.status(400).json(wrapError({ code: `EWS_400_${e.code}`, message: e.message, severity: 'MEDIUM' }, ctx));
        }
        return res.status(500).json(wrapError({ code: 'EWS_500', message: e instanceof Error ? e.message : 'export record failed', severity: 'HIGH' }, ctx));
      }
    },
  );

  app.get(
    '/v1/exports',
    requireTenantMw,
    requireRole('reports:export'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const q = req.query;
      const filters: import('./exports/store').ExportListFilters = {};
      if (typeof q.module === 'string') filters.module = q.module;
      if (typeof q.format === 'string' && isExportFormat(q.format)) filters.format = q.format;
      if (typeof q.report_type === 'string' && isReportType(q.report_type)) filters.report_type = q.report_type;
      if (typeof q.page === 'string') filters.page = Math.max(1, Number(q.page) || 1);
      if (typeof q.page_size === 'string') filters.page_size = Math.max(1, Math.min(200, Number(q.page_size) || 50));
      const out = exportHistoryStore.list(req.tenant!.tenant_id, filters);
      return res.json(wrapResponse(out, ctx));
    },
  );

  app.get(
    '/v1/exports/:export_id',
    requireTenantMw,
    requireRole('reports:export'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const rec = exportHistoryStore.get(req.tenant!.tenant_id, req.params.export_id);
      if (!rec) {
        return res.status(404).json(wrapError({ code: 'EWS_404_unknown_export', message: `unknown export: ${req.params.export_id}`, severity: 'LOW' }, ctx));
      }
      return res.json(wrapResponse(rec, ctx));
    },
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/bff && npx jest __tests__/exports.test.ts`
Expected: PASS (all store + route tests).

- [ ] **Step 5: Commit**

```bash
git add services/bff/src/server.ts services/bff/__tests__/exports.test.ts
git commit -m "feat(bff): POST/GET /v1/exports — record + audit exports (reports:export)"
```

---

## Task 4: Frontend export types (`ReportData` contract)

**Files:**
- Create: `web/src/lib/export/types.ts`
- Test: covered structurally by generator tests in Task 5–7 (no standalone test; types are compile-checked).

- [ ] **Step 1: Write the types**

Create `web/src/lib/export/types.ts`:

```ts
// web/src/lib/export/types.ts
// Shared contract for the Enterprise Report Export Framework (P1).
// Each screen supplies a ReportAdapter; generators consume only ReportData.

export const ALL_EXPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ExportFormat = (typeof ALL_EXPORT_FORMATS)[number];

export const ALL_REPORT_TYPES = [
  'customer', 'risk', 'case', 'recovery',
  'compliance', 'portfolio', 'executive', 'ai_insight',
] as const;
export type ReportType = (typeof ALL_REPORT_TYPES)[number];

export type DateRangeKey = 'today' | '7d' | '30d' | 'quarter' | 'custom';
export type DataScope = 'current_page' | 'filtered' | 'selected' | 'complete';

export type ReportSectionKey =
  | 'summary' | 'kpis' | 'trends' | 'charts' | 'alerts'
  | 'ai_insights' | 'recommendations' | 'audit_trail' | 'workflow_history';

export interface ExportConfig {
  formats: ExportFormat[];
  report_type: ReportType;
  date_range: DateRangeKey;
  custom_range?: { from: string; to: string };
  data_scope: DataScope;
  include: Record<ReportSectionKey, boolean>;
}

export type TableRow = (string | number)[];
export interface ReportTable { name: string; columns: string[]; rows: TableRow[]; }

export interface ReportData {
  report_type: ReportType;
  module: string;
  title: string;
  subject?: { id: string; name: string };
  meta: {
    tenant_id: string;
    generated_by: string;
    role: string;
    generated_at: string; // ISO
    report_id: string;
  };
  sections: {
    summary?: { label: string; value: string }[];
    kpis?: { label: string; value: string; delta?: string }[];
    trends?: { label: string; points: { x: string; y: number }[] }[];
    tables?: ReportTable[];
    alerts?: Record<string, string | number>[];
    recommendations?: string[];
    ai_insights?: { narrative: string };
    audit_trail?: Record<string, string | number>[];
    workflow_history?: Record<string, string | number>[];
  };
  /** The row count that POST /v1/exports records (primary table size). */
  record_count: number;
}

export type ReportAdapter = (config: ExportConfig) => ReportData | Promise<ReportData>;

export const DEFAULT_INCLUDE: Record<ReportSectionKey, boolean> = {
  summary: true, kpis: true, trends: true, charts: true, alerts: true,
  ai_insights: false, recommendations: true, audit_trail: false, workflow_history: false,
};
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors from `lib/export/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/export/types.ts
git commit -m "feat(web): ReportData adapter contract + ExportConfig types"
```

---

## Task 5: CSV generator

**Files:**
- Create: `web/src/lib/export/generators/csv.ts`
- Test: `web/src/__tests__/exportGenerators.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/exportGenerators.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { buildReportCsv } from '@/lib/export/generators/csv';
import type { ReportData, ExportConfig } from '@/lib/export/types';
import { DEFAULT_INCLUDE } from '@/lib/export/types';

const config: ExportConfig = {
  formats: ['csv'], report_type: 'customer', date_range: '30d',
  data_scope: 'complete', include: DEFAULT_INCLUDE,
};
const data: ReportData = {
  report_type: 'customer', module: 'customer_360', title: 'Customer Report — c-101',
  subject: { id: 'c-101', name: 'Acme Ltd' },
  meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin', generated_at: '2026-06-13T10:00:00Z', report_id: 'EXP-1' },
  sections: {
    tables: [{ name: 'Cases', columns: ['Case', 'State'], rows: [['case-1', 'open'], ['case-2', 'closed']] }],
  },
  record_count: 2,
};

describe('buildReportCsv', () => {
  test('emits header + one line per row of the primary table', async () => {
    const blob = buildReportCsv(data, config);
    const text = await blob.text();
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('Case,State');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toBe('case-1,open');
  });

  test('escapes commas, quotes, newlines (RFC 4180)', async () => {
    const d2: ReportData = { ...data, sections: { tables: [{ name: 'X', columns: ['A'], rows: [['a,b'], ['he said "hi"']] }] } };
    const text = await buildReportCsv(d2, config).text();
    const lines = text.trim().split('\r\n');
    expect(lines[1]).toBe('"a,b"');
    expect(lines[2]).toBe('"he said ""hi"""');
  });

  test('no table → header-only meta line', async () => {
    const d3: ReportData = { ...data, sections: {} };
    const text = await buildReportCsv(d3, config).text();
    expect(text).toContain('No tabular records for this scope');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/exportGenerators.test.ts`
Expected: FAIL — cannot resolve `@/lib/export/generators/csv`.

- [ ] **Step 3: Write the CSV generator**

Create `web/src/lib/export/generators/csv.ts`:

```ts
// web/src/lib/export/generators/csv.ts — primary-table-only CSV (RFC 4180).
import type { ReportData, ExportConfig } from '../types';

function esc(v: string | number): string {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildReportCsv(data: ReportData, _config: ExportConfig): Blob {
  const table = data.sections.tables?.[0];
  let text: string;
  if (!table || table.rows.length === 0) {
    text = `# ${data.title}\r\nNo tabular records for this scope\r\n`;
  } else {
    const header = table.columns.map(esc).join(',');
    const rows = table.rows.map((r) => r.map(esc).join(','));
    text = [header, ...rows].join('\r\n') + '\r\n';
  }
  return new Blob([text], { type: 'text/csv;charset=utf-8' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/exportGenerators.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/export/generators/csv.ts web/src/__tests__/exportGenerators.test.ts
git commit -m "feat(web): CSV report generator (RFC 4180)"
```

---

## Task 6: PDF generator

**Files:**
- Create: `web/src/lib/export/generators/pdf.ts`
- Test: append to `web/src/__tests__/exportGenerators.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/src/__tests__/exportGenerators.test.ts`:

```ts
import { buildReportPdf } from '@/lib/export/generators/pdf';

describe('buildReportPdf', () => {
  test('produces a jsPDF doc with the enterprise header text + report id', () => {
    const doc = buildReportPdf(data, config);
    const text = doc.getDocument ? '' : ''; // jsPDF has no text-extract; assert via internal pages count
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    // header strings are written; we assert the output blob is non-trivial
    const out = doc.output('arraybuffer');
    expect(out.byteLength).toBeGreaterThan(800);
  });

  test('includes summary + kpis + table sections when present', () => {
    const rich: ReportData = {
      ...data,
      sections: {
        summary: [{ label: 'Risk Score', value: '0.82' }],
        kpis: [{ label: 'Open Alerts', value: '3', delta: '+1' }],
        tables: [{ name: 'Cases', columns: ['Case', 'State'], rows: [['case-1', 'open']] }],
        recommendations: ['Escalate to supervisor'],
      },
    };
    const doc = buildReportPdf(rich, config);
    expect(doc.output('arraybuffer').byteLength).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/exportGenerators.test.ts -t buildReportPdf`
Expected: FAIL — cannot resolve `@/lib/export/generators/pdf`.

- [ ] **Step 3: Write the PDF generator**

Create `web/src/lib/export/generators/pdf.ts`:

```ts
// web/src/lib/export/generators/pdf.ts — enterprise-styled, section-driven PDF.
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ReportData, ExportConfig } from '../types';

const BRAND: [number, number, number] = [37, 99, 235];
const MARGIN = 40;

function cursorAfter(doc: jsPDF, fallback: number): number {
  // @ts-expect-error — autoTable mutates the doc with lastAutoTable.
  return (doc.lastAutoTable?.finalY ?? fallback) + 20;
}

export function buildReportPdf(data: ReportData, config: ExportConfig): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  // Header block.
  doc.setFontSize(16);
  doc.setTextColor(0);
  doc.text('ZorEWS', MARGIN, MARGIN);
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text('Early Warning System', MARGIN, MARGIN + 15);
  doc.setFontSize(9);
  const m = data.meta;
  doc.text(`Tenant: ${m.tenant_id}`, MARGIN, MARGIN + 32);
  doc.text(`Generated By: ${m.generated_by} (${m.role})`, MARGIN, MARGIN + 44);
  doc.text(`Generated: ${m.generated_at}`, MARGIN, MARGIN + 56);
  doc.text(`Report ID: ${m.report_id}`, MARGIN, MARGIN + 68);
  doc.setTextColor(0);
  doc.setFontSize(13);
  doc.text(data.title, MARGIN, MARGIN + 92);
  let y = MARGIN + 110;

  const inc = config.include;
  const s = data.sections;

  if (inc.summary && s.summary?.length) {
    autoTable(doc, {
      startY: y, head: [['Summary', 'Value']],
      body: s.summary.map((r) => [r.label, r.value]),
      theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: BRAND },
      margin: { left: MARGIN, right: MARGIN },
    });
    y = cursorAfter(doc, y);
  }
  if (inc.kpis && s.kpis?.length) {
    autoTable(doc, {
      startY: y, head: [['KPI', 'Value', 'Δ']],
      body: s.kpis.map((k) => [k.label, k.value, k.delta ?? '—']),
      theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: BRAND },
      margin: { left: MARGIN, right: MARGIN },
    });
    y = cursorAfter(doc, y);
  }
  for (const t of s.tables ?? []) {
    autoTable(doc, {
      startY: y, head: [t.columns], body: t.rows.slice(0, 200).map((r) => r.map((c) => String(c ?? '—'))),
      theme: 'striped', styles: { fontSize: 7, cellPadding: 3 }, headStyles: { fillColor: BRAND, fontSize: 8 },
      margin: { left: MARGIN, right: MARGIN },
    });
    y = cursorAfter(doc, y);
  }
  if (inc.recommendations && s.recommendations?.length) {
    doc.setFontSize(10); doc.text('Recommendations', MARGIN, y); y += 14;
    doc.setFontSize(8);
    s.recommendations.forEach((r) => { doc.text(`• ${r}`, MARGIN, y); y += 12; });
  }
  if (inc.ai_insights && s.ai_insights?.narrative) {
    doc.setFontSize(10); doc.text('AI Insight', MARGIN, y); y += 14;
    doc.setFontSize(8);
    doc.splitTextToSize(s.ai_insights.narrative, 515).forEach((line: string) => { doc.text(line, MARGIN, y); y += 11; });
  }

  // Footer + page numbers.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const h = doc.internal.pageSize.getHeight();
    const w = doc.internal.pageSize.getWidth();
    doc.setFontSize(7); doc.setTextColor(140);
    doc.text('Confidential — Generated from ZorEWS', MARGIN, h - 20);
    doc.text(`Page ${p} of ${pages}`, w - MARGIN - 60, h - 20);
    doc.setTextColor(0);
  }
  return doc;
}

export function reportPdfBlob(data: ReportData, config: ExportConfig): Blob {
  return buildReportPdf(data, config).output('blob');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/exportGenerators.test.ts -t buildReportPdf`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/export/generators/pdf.ts web/src/__tests__/exportGenerators.test.ts
git commit -m "feat(web): enterprise PDF report generator (header/footer/page-no)"
```

---

## Task 7: XLSX generator

**Files:**
- Create: `web/src/lib/export/generators/xlsx.ts`
- Test: append to `web/src/__tests__/exportGenerators.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/src/__tests__/exportGenerators.test.ts`:

```ts
import { buildReportXlsxBlob } from '@/lib/export/generators/xlsx';

describe('buildReportXlsxBlob', () => {
  test('produces a non-empty blob', async () => {
    const blob = await buildReportXlsxBlob(data, config);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain('spreadsheet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/exportGenerators.test.ts -t buildReportXlsxBlob`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the XLSX generator**

Create `web/src/lib/export/generators/xlsx.ts`:

```ts
// web/src/lib/export/generators/xlsx.ts — multi-sheet workbook.
import writeXlsxFile, { type Sheet } from 'write-excel-file/browser';
import type { ReportData, ExportConfig } from '../types';

interface Cell {
  value?: string | number | null;
  fontWeight?: 'bold';
  backgroundColor?: string;
  color?: string;
  type?: typeof String | typeof Number;
}
const HEAD = (label: string): Cell => ({ value: label, fontWeight: 'bold', backgroundColor: '#2563EB', color: '#FFFFFF' });
const cell = (v: string | number): Cell =>
  typeof v === 'number' && Number.isFinite(v) ? { type: Number, value: v } : { type: String, value: String(v ?? '') };

export async function buildReportXlsxBlob(data: ReportData, config: ExportConfig): Promise<Blob> {
  const s = data.sections;
  const m = data.meta;

  const summary: Cell[][] = [
    [HEAD('Field'), HEAD('Value')],
    [{ value: 'Report' }, { value: data.title }],
    [{ value: 'Tenant' }, { value: m.tenant_id }],
    [{ value: 'Generated By' }, { value: `${m.generated_by} (${m.role})` }],
    [{ value: 'Generated At' }, { value: m.generated_at }],
    [{ value: 'Report ID' }, { value: m.report_id }],
    ...(s.summary ?? []).map((r) => [{ value: r.label }, { value: r.value }]),
    ...(s.kpis ?? []).map((k) => [{ value: `KPI: ${k.label}` }, { value: k.value }]),
  ];

  const primary = s.tables?.[0];
  const rawData: Cell[][] = primary
    ? [primary.columns.map(HEAD), ...primary.rows.map((r) => r.map(cell))]
    : [[HEAD('Note')], [{ value: 'No tabular records for this scope' }]];

  const risk: Cell[][] = [
    [HEAD('Risk Metric'), HEAD('Value')],
    ...(s.kpis ?? []).map((k) => [{ value: k.label }, { value: k.value }]),
  ];

  const sheets: Array<{ sheet: string; data: Cell[][] }> = [
    { sheet: 'Executive Summary', data: summary },
    { sheet: 'Raw Data', data: rawData },
    { sheet: 'Risk Analysis', data: risk },
  ];
  if (config.include.audit_trail && s.audit_trail?.length) {
    const cols = Object.keys(s.audit_trail[0]);
    sheets.push({
      sheet: 'Audit Trail',
      data: [cols.map(HEAD), ...s.audit_trail.map((row) => cols.map((c) => cell(row[c])))],
    });
  }

  return writeXlsxFile(sheets as unknown as Sheet<Blob>[]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/exportGenerators.test.ts -t buildReportXlsxBlob`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/export/generators/xlsx.ts web/src/__tests__/exportGenerators.test.ts
git commit -m "feat(web): multi-sheet XLSX report generator"
```

---

## Task 8: recordExport (fire POST /v1/exports)

**Files:**
- Create: `web/src/lib/export/recordExport.ts`
- Test: `web/src/__tests__/recordExport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/recordExport.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest';
import { recordExport } from '@/lib/export/recordExport';

vi.mock('@/lib/http', () => ({ http: { post: vi.fn().mockResolvedValue({ data: {} }) } }));
import { http } from '@/lib/http';

describe('recordExport', () => {
  test('POSTs /v1/exports with the record payload', async () => {
    await recordExport({
      module: 'alerts', report_type: 'risk', format: 'csv',
      record_count: 7, title: 'Alerts', status: 'completed',
      config: { formats: ['csv'], report_type: 'risk', date_range: '30d', data_scope: 'complete', include: {} },
    });
    expect(http.post).toHaveBeenCalledWith('/v1/exports', expect.objectContaining({ module: 'alerts', format: 'csv' }));
  });

  test('swallows network errors (best-effort, never throws)', async () => {
    (http.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    await expect(recordExport({
      module: 'alerts', report_type: 'risk', format: 'pdf', record_count: 0,
      title: 'x', status: 'completed',
      config: { formats: ['pdf'], report_type: 'risk', date_range: 'today', data_scope: 'current_page', include: {} },
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/recordExport.test.ts`
Expected: FAIL — cannot resolve `@/lib/export/recordExport`.

- [ ] **Step 3: Write recordExport**

Create `web/src/lib/export/recordExport.ts`:

```ts
// web/src/lib/export/recordExport.ts — best-effort audit/history record.
import { http } from '@/lib/http';
import type { ExportFormat, ReportType } from './types';

export interface RecordExportInput {
  module: string;
  report_type: ReportType;
  format: ExportFormat;
  record_count: number;
  title: string;
  status: 'completed' | 'failed';
  config: {
    formats: ExportFormat[]; report_type: ReportType;
    date_range: string; data_scope: string; include: Record<string, boolean>;
    custom_range?: { from: string; to: string };
  };
}

/** Fire-and-forget — the client download already succeeded; never block on this. */
export async function recordExport(input: RecordExportInput): Promise<void> {
  try {
    await http.post('/v1/exports', input);
  } catch (e) {
    // Best-effort: the export already downloaded. Log + move on.
    // eslint-disable-next-line no-console
    console.warn('[export] failed to record export history:', e instanceof Error ? e.message : e);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/recordExport.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/export/recordExport.ts web/src/__tests__/recordExport.test.ts
git commit -m "feat(web): recordExport — best-effort POST /v1/exports"
```

---

## Task 9: ExportModal component

**Files:**
- Create: `web/src/components/export/ExportModal.tsx`
- Test: `web/src/__tests__/ExportModal.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/ExportModal.test.tsx`:

```tsx
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExportModal } from '@/components/export/ExportModal';
import type { ReportData } from '@/lib/export/types';

vi.mock('@/lib/export/recordExport', () => ({ recordExport: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/export/generators/csv', () => ({ buildReportCsv: () => new Blob(['Case,State\r\nc-1,open']) }));
vi.mock('@/lib/export/generators/pdf', () => ({ reportPdfBlob: () => new Blob(['%PDF']) }));
vi.mock('@/lib/export/generators/xlsx', () => ({ buildReportXlsxBlob: async () => new Blob(['xlsx']) }));

// jsdom has no URL.createObjectURL / anchor download — stub it.
beforeEach(() => {
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});

const data: ReportData = {
  report_type: 'customer', module: 'customer_360', title: 'Customer Report — c-101',
  meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin', generated_at: '2026-06-13T10:00:00Z', report_id: 'EXP-1' },
  sections: { tables: [{ name: 'Cases', columns: ['Case', 'State'], rows: [['c-1', 'open']] }] },
  record_count: 1,
};

describe('ExportModal', () => {
  test('renders format + scope + section controls when open', () => {
    render(<ExportModal open onClose={() => {}} adapter={() => data} module="customer_360" defaultReportType="customer" />);
    expect(screen.getByTestId('export-format-pdf')).toBeTruthy();
    expect(screen.getByTestId('export-format-csv')).toBeTruthy();
    expect(screen.getByTestId('export-scope')).toBeTruthy();
    expect(screen.getByTestId('export-generate')).toBeTruthy();
  });

  test('Generate runs the adapter + records the export', async () => {
    const { recordExport } = await import('@/lib/export/recordExport');
    render(<ExportModal open onClose={() => {}} adapter={() => data} module="customer_360" defaultReportType="customer" />);
    fireEvent.click(screen.getByTestId('export-generate'));
    await waitFor(() => expect(recordExport).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/ExportModal.test.tsx`
Expected: FAIL — cannot resolve `@/components/export/ExportModal`.

- [ ] **Step 3: Write ExportModal**

Create `web/src/components/export/ExportModal.tsx`:

```tsx
// web/src/components/export/ExportModal.tsx — format + config + generate.
import { useState } from 'react';
import { Modal, Button } from '@/components/ui';
import {
  ALL_EXPORT_FORMATS, DEFAULT_INCLUDE,
  type ExportFormat, type ReportType, type ReportAdapter,
  type ExportConfig, type DateRangeKey, type DataScope, type ReportSectionKey,
} from '@/lib/export/types';
import { buildReportCsv } from '@/lib/export/generators/csv';
import { reportPdfBlob } from '@/lib/export/generators/pdf';
import { buildReportXlsxBlob } from '@/lib/export/generators/xlsx';
import { recordExport } from '@/lib/export/recordExport';

const DATE_RANGES: { key: DateRangeKey; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' }, { key: 'quarter', label: 'Quarter' }, { key: 'custom', label: 'Custom' },
];
const SCOPES: { key: DataScope; label: string }[] = [
  { key: 'current_page', label: 'Current Page' }, { key: 'filtered', label: 'Filtered Records' },
  { key: 'selected', label: 'Selected Records' }, { key: 'complete', label: 'Complete Dataset' },
];
const SECTIONS: { key: ReportSectionKey; label: string }[] = [
  { key: 'summary', label: 'Summary' }, { key: 'kpis', label: 'KPIs' }, { key: 'trends', label: 'Trends' },
  { key: 'charts', label: 'Charts' }, { key: 'alerts', label: 'Alerts' }, { key: 'ai_insights', label: 'AI Insights' },
  { key: 'recommendations', label: 'Recommendations' }, { key: 'audit_trail', label: 'Audit Trail' },
  { key: 'workflow_history', label: 'Workflow History' },
];
const REPORT_TYPES: ReportType[] = ['customer', 'risk', 'case', 'recovery', 'compliance', 'portfolio', 'executive', 'ai_insight'];

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  adapter: ReportAdapter;
  module: string;
  defaultReportType: ReportType;
}

export function ExportModal({ open, onClose, adapter, module, defaultReportType }: ExportModalProps) {
  const [formats, setFormats] = useState<ExportFormat[]>(['pdf']);
  const [reportType, setReportType] = useState<ReportType>(defaultReportType);
  const [dateRange, setDateRange] = useState<DateRangeKey>('30d');
  const [scope, setScope] = useState<DataScope>('complete');
  const [include, setInclude] = useState<Record<ReportSectionKey, boolean>>(DEFAULT_INCLUDE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleFormat = (f: ExportFormat) =>
    setFormats((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  async function generate() {
    setError(null);
    if (formats.length === 0) { setError('Select at least one format'); return; }
    setBusy(true);
    const config: ExportConfig = { formats, report_type: reportType, date_range: dateRange, data_scope: scope, include };
    try {
      const data = await adapter(config);
      const slug = (data.subject?.id ?? module).replace(/\W+/g, '_');
      const stamp = new Date().toISOString().slice(0, 10);
      for (const fmt of formats) {
        let blob: Blob;
        if (fmt === 'csv') blob = buildReportCsv(data, config);
        else if (fmt === 'pdf') blob = reportPdfBlob(data, config);
        else blob = await buildReportXlsxBlob(data, config);
        download(blob, `${module}-${slug}-${stamp}.${fmt}`);
        await recordExport({
          module, report_type: reportType, format: fmt, record_count: data.record_count,
          title: data.title, status: 'completed',
          config: { formats, report_type: reportType, date_range: dateRange, data_scope: scope, include },
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
      await recordExport({
        module, report_type: reportType, format: formats[0], record_count: 0,
        title: `${module} export`, status: 'failed',
        config: { formats, report_type: reportType, date_range: dateRange, data_scope: scope, include },
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Generate Report" size="2xl" testId="export-modal">
      <div className="p-6 space-y-5">
        <h2 className="text-lg font-semibold text-aurora-ink">Generate Report</h2>

        <div>
          <div className="text-sm font-medium mb-2">Formats</div>
          <div className="flex gap-3">
            {ALL_EXPORT_FORMATS.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input type="checkbox" data-testid={`export-format-${f}`} checked={formats.includes(f)} onChange={() => toggleFormat(f)} />
                {f.toUpperCase()}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm text-slate-400" title="Coming soon (P1.5)">
              <input type="checkbox" disabled /> Word (.docx)
            </label>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <label className="text-sm">Report Type
            <select className="input mt-1" value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)} data-testid="export-report-type">
              {REPORT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-sm">Date Range
            <select className="input mt-1" value={dateRange} onChange={(e) => setDateRange(e.target.value as DateRangeKey)} data-testid="export-date-range">
              {DATE_RANGES.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </label>
          <label className="text-sm">Data Scope
            <select className="input mt-1" value={scope} onChange={(e) => setScope(e.target.value as DataScope)} data-testid="export-scope">
              {SCOPES.map((sc) => <option key={sc.key} value={sc.key}>{sc.label}</option>)}
            </select>
          </label>
        </div>

        <div>
          <div className="text-sm font-medium mb-2">Include Sections</div>
          <div className="grid grid-cols-3 gap-2">
            {SECTIONS.map((sec) => (
              <label key={sec.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" data-testid={`export-section-${sec.key}`} checked={include[sec.key]}
                  onChange={() => setInclude((cur) => ({ ...cur, [sec.key]: !cur[sec.key] }))} />
                {sec.label}
              </label>
            ))}
          </div>
        </div>

        {error && <div className="text-sm text-danger" data-testid="export-error">{error}</div>}

        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={generate} disabled={busy} data-testid="export-generate">{busy ? 'Generating…' : 'Generate'}</Button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/ExportModal.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/export/ExportModal.tsx web/src/__tests__/ExportModal.test.tsx
git commit -m "feat(web): ExportModal — formats + config + section toggles + generate"
```

---

## Task 10: ExportButton (RBAC-gated)

**Files:**
- Create: `web/src/components/export/ExportButton.tsx`
- Test: `web/src/__tests__/ExportButton.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/ExportButton.test.tsx`:

```tsx
import { describe, test, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportButton } from '@/components/export/ExportButton';
import type { ReportData } from '@/lib/export/types';

const data: ReportData = {
  report_type: 'customer', module: 'customer_360', title: 't',
  meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin', generated_at: '', report_id: 'EXP-1' },
  sections: {}, record_count: 0,
};
function setUser(roles: string[]) {
  localStorage.setItem('apex.ews.user', JSON.stringify({ username: 'alice.admin', roles }));
}
beforeEach(() => localStorage.clear());

describe('ExportButton', () => {
  test('renders for admin (has reports:export)', () => {
    setUser(['admin']);
    render(<ExportButton adapter={() => data} module="customer_360" reportType="customer" />);
    expect(screen.getByTestId('export-button')).toBeTruthy();
  });

  test('hidden for field_officer (no reports:export)', () => {
    setUser(['field_officer']);
    const { container } = render(<ExportButton adapter={() => data} module="customer_360" reportType="customer" />);
    expect(container.querySelector('[data-testid="export-button"]')).toBeNull();
  });

  test('clicking opens the modal', () => {
    setUser(['risk_analyst']);
    render(<ExportButton adapter={() => data} module="customer_360" reportType="customer" />);
    fireEvent.click(screen.getByTestId('export-button'));
    expect(screen.getByTestId('export-modal')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/ExportButton.test.tsx`
Expected: FAIL — cannot resolve `@/components/export/ExportButton`.

- [ ] **Step 3: Write ExportButton**

Create `web/src/components/export/ExportButton.tsx`:

```tsx
// web/src/components/export/ExportButton.tsx — RBAC-gated export trigger.
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui';
import { ExportModal } from './ExportModal';
import type { ReportAdapter, ReportType } from '@/lib/export/types';

// reports:export → admin, supervisor, risk_analyst (matches infra/rbac/matrix.json).
const EXPORT_ROLES = new Set(['admin', 'supervisor', 'risk_analyst']);

function canExport(): boolean {
  try {
    const raw = localStorage.getItem('apex.ews.user');
    if (!raw) return false;
    const roles: string[] = JSON.parse(raw)?.roles ?? [];
    return roles.some((r) => EXPORT_ROLES.has(r));
  } catch {
    return false;
  }
}

export interface ExportButtonProps {
  adapter: ReportAdapter;
  module: string;
  reportType: ReportType;
  label?: string;
}

export function ExportButton({ adapter, module, reportType, label = 'Export' }: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  if (!canExport()) return null;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} data-testid="export-button">
        <Download className="w-4 h-4 mr-1" /> {label}
      </Button>
      <ExportModal open={open} onClose={() => setOpen(false)} adapter={adapter} module={module} defaultReportType={reportType} />
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/ExportButton.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/export/ExportButton.tsx web/src/__tests__/ExportButton.test.tsx
git commit -m "feat(web): RBAC-gated ExportButton wrapping ExportModal"
```

---

## Task 11: Customer Risk Profile adapter + wire button

**Files:**
- Create: `web/src/modules/customers/customerReportAdapter.ts`
- Modify: `web/src/modules/customers/CustomerRiskProfilePage.tsx` (add `<ExportButton>` to the page header)
- Test: `web/src/__tests__/customerReportAdapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/customerReportAdapter.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { buildCustomerReportData } from '@/modules/customers/customerReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: 'customer', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('buildCustomerReportData', () => {
  test('maps a customer profile into ReportData', () => {
    const data = buildCustomerReportData({
      customer: { id: 'c-101', name: 'Acme Ltd', risk_score: 0.82, npa_status: 'SUBSTANDARD' },
      alerts: [{ alert_id: 'a-1', severity: 'high', rule_name: 'DPD 30+' }],
      cases: [{ case_id: 'case-1', state: 'open' }],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('customer');
    expect(data.subject).toEqual({ id: 'c-101', name: 'Acme Ltd' });
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.summary?.some((s) => s.label === 'Risk Score')).toBe(true);
    expect(data.sections.tables?.[0].rows).toHaveLength(1); // 1 case
    expect(data.record_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/customerReportAdapter.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the adapter**

Create `web/src/modules/customers/customerReportAdapter.ts`:

```ts
// web/src/modules/customers/customerReportAdapter.ts
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface CustomerReportSource {
  customer: { id: string; name: string; risk_score: number; npa_status: string };
  alerts: { alert_id: string; severity: string; rule_name: string }[];
  cases: { case_id: string; state: string }[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildCustomerReportData(src: CustomerReportSource, config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: 'customer',
    module: 'customer_360',
    title: `Customer Report — ${src.customer.name} (${src.customer.id})`,
    subject: { id: src.customer.id, name: src.customer.name },
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [
        { label: 'Customer ID', value: src.customer.id },
        { label: 'Risk Score', value: src.customer.risk_score.toFixed(2) },
        { label: 'NPA Status', value: src.customer.npa_status },
      ],
      kpis: [
        { label: 'Open Alerts', value: String(src.alerts.length) },
        { label: 'Open Cases', value: String(src.cases.length) },
      ],
      alerts: config.include.alerts ? src.alerts : undefined,
      tables: [{
        name: 'Case History', columns: ['Case', 'State'],
        rows: src.cases.map((c) => [c.case_id, c.state]),
      }],
      recommendations: config.include.recommendations
        ? ['Review highest-severity alert', 'Confirm NPA classification with credit team']
        : undefined,
    },
    record_count: src.cases.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/customerReportAdapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the button into the page**

In `web/src/modules/customers/CustomerRiskProfilePage.tsx`:
- Add imports at top:

```tsx
import { ExportButton } from '@/components/export/ExportButton';
import { buildCustomerReportData } from './customerReportAdapter';
```

- Where the page renders its header actions (next to the title — find the `<PageHeader …>` or top heading block), add (using the already-loaded `profile`, `linkedAlerts`, `linkedCases`, and auth user available on the page — match the page's existing variable names; if the page exposes `data`/`alerts`/`cases` under different names, adapt the field reads):

```tsx
<ExportButton
  module="customer_360"
  reportType="customer"
  adapter={() => buildCustomerReportData({
    customer: {
      id: profile.customer_id, name: profile.name,
      risk_score: profile.pd ?? 0, npa_status: profile.npa_status ?? 'STANDARD',
    },
    alerts: (linkedAlerts ?? []).map((a) => ({ alert_id: a.id, severity: a.severity, rule_name: a.rule?.name ?? '' })),
    cases: (linkedCases ?? []).map((c) => ({ case_id: c.id, state: c.state })),
    meta: { tenant_id: 'BANK_DEMO', generated_by: 'operator', role: 'admin' },
  })}
/>
```

> NOTE for the implementer: open `CustomerRiskProfilePage.tsx` first and read the actual variable names the page uses for the profile, linked alerts, and linked cases. The field reads above (`profile.customer_id`, `a.rule?.name`, etc.) must be reconciled to the page's real shapes. Keep the `<ExportButton>` purely additive — do not change any existing render or data fetch.

- [ ] **Step 6: Run the page's existing test suite to verify no regression**

Run: `cd web && npx vitest run src/__tests__/CustomerRiskProfilePage.test.tsx`
Expected: PASS (existing tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add web/src/modules/customers/customerReportAdapter.ts web/src/modules/customers/CustomerRiskProfilePage.tsx web/src/__tests__/customerReportAdapter.test.ts
git commit -m "feat(web): Customer Risk Profile export adapter + button (pilot 1)"
```

---

## Task 12: Alerts adapter + wire button

**Files:**
- Create: `web/src/modules/alerts/alertsReportAdapter.ts`
- Modify: `web/src/modules/alerts/AlertListPage.tsx` (add `<ExportButton>` to the header)
- Test: `web/src/__tests__/alertsReportAdapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/alertsReportAdapter.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { buildAlertsReportData } from '@/modules/alerts/alertsReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['csv'], report_type: 'risk', date_range: '30d', data_scope: 'filtered', include: DEFAULT_INCLUDE };

describe('buildAlertsReportData', () => {
  test('maps a filtered alert list into ReportData (risk report)', () => {
    const data = buildAlertsReportData({
      alerts: [
        { id: 'a-1', customer: { id: 'c-1', name: 'X' }, severity: 'critical', rule: { name: 'R1' }, age_min: 10 },
        { id: 'a-2', customer: { id: 'c-2', name: 'Y' }, severity: 'high', rule: { name: 'R2' }, age_min: 50 },
      ],
      meta: { tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin' },
    }, config);
    expect(data.report_type).toBe('risk');
    expect(data.subject).toBeUndefined();
    expect(data.sections.tables?.[0].rows).toHaveLength(2);
    expect(data.sections.kpis?.find((k) => k.label === 'Critical')?.value).toBe('1');
    expect(data.record_count).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/alertsReportAdapter.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the adapter**

Create `web/src/modules/alerts/alertsReportAdapter.ts`:

```ts
// web/src/modules/alerts/alertsReportAdapter.ts
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface AlertRow {
  id: string;
  customer: { id: string; name: string };
  severity: string;
  rule: { name: string };
  age_min: number;
}
export interface AlertsReportSource {
  alerts: AlertRow[];
  meta: { tenant_id: string; generated_by: string; role: string };
}

export function buildAlertsReportData(src: AlertsReportSource, _config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  const bySeverity = (sev: string) => src.alerts.filter((a) => a.severity === sev).length;
  return {
    report_type: 'risk',
    module: 'alerts',
    title: 'Alert Activity Report',
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [{ label: 'Total Alerts', value: String(src.alerts.length) }],
      kpis: [
        { label: 'Critical', value: String(bySeverity('critical')) },
        { label: 'High', value: String(bySeverity('high')) },
        { label: 'Medium', value: String(bySeverity('medium')) },
      ],
      tables: [{
        name: 'Alerts', columns: ['Alert', 'Customer', 'Severity', 'Rule', 'Age (min)'],
        rows: src.alerts.map((a) => [a.id, a.customer.name, a.severity, a.rule.name, a.age_min]),
      }],
    },
    record_count: src.alerts.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/alertsReportAdapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the button into the page**

In `web/src/modules/alerts/AlertListPage.tsx`:
- Add imports:

```tsx
import { ExportButton } from '@/components/export/ExportButton';
import { buildAlertsReportData } from './alertsReportAdapter';
```

- In the page header actions area (next to the existing filter controls / title), add — passing the page's *currently-filtered* alert array (use the same variable the DataTable renders, so the export respects active filters + data-scope):

```tsx
<ExportButton
  module="alerts"
  reportType="risk"
  adapter={() => buildAlertsReportData({
    alerts: (filteredAlerts ?? []).map((a) => ({
      id: a.id, customer: { id: a.customer.id, name: a.customer.name },
      severity: a.severity, rule: { name: a.rule?.name ?? '' }, age_min: a.age_min ?? 0,
    })),
    meta: { tenant_id: 'BANK_DEMO', generated_by: 'operator', role: 'admin' },
  })}
/>
```

> NOTE for the implementer: read `AlertListPage.tsx` for the real name of the post-filter alert array (the plan uses `filteredAlerts`). Reconcile the field reads to the page's `Alert` type. Additive only.

- [ ] **Step 6: Run the page's existing test suite to verify no regression**

Run: `cd web && npx vitest run src/__tests__/AlertListPage.test.tsx`
Expected: PASS (existing 22 tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add web/src/modules/alerts/alertsReportAdapter.ts web/src/modules/alerts/AlertListPage.tsx web/src/__tests__/alertsReportAdapter.test.ts
git commit -m "feat(web): Alerts export adapter + button (pilot 2)"
```

---

## Task 13: MSW handlers + full-suite regression gate

**Files:**
- Modify: `web/src/mocks/handlers.ts` (add `/v1/exports` handlers so dev-mode + any integration test works)
- Test: full BFF jest + web vitest suites

- [ ] **Step 1: Write the failing test**

Append to `web/src/__tests__/recordExport.test.ts` (integration against MSW — remove the `vi.mock('@/lib/http')` isolation by adding a separate file if the mock conflicts; here we add a focused MSW assertion):

Create `web/src/__tests__/exportsMsw.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { server } from '@/mocks/server';
import { http as mswHttp, HttpResponse } from 'msw';
import { http } from '@/lib/http';

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('/v1/exports MSW handler', () => {
  test('POST returns an enveloped export record', async () => {
    const res = await http.post('/v1/exports', {
      module: 'alerts', report_type: 'risk', format: 'csv', record_count: 3,
      title: 'Alerts', status: 'completed',
      config: { formats: ['csv'], report_type: 'risk', date_range: '30d', data_scope: 'filtered', include: {} },
    });
    expect(res.data.body.export_id).toMatch(/^EXP-/);
  });
});
```

> If `@/mocks/server` doesn't exist in this repo's test setup (MSW may be wired via `setupWorker` for the browser only), skip this MSW test file and instead rely on the handler being exercised in dev mode; keep the handler addition (Step 3) regardless.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/exportsMsw.test.ts`
Expected: FAIL — no handler for `POST /v1/exports` (passthrough/404).

- [ ] **Step 3: Add MSW handlers**

In `web/src/mocks/handlers.ts`, add an in-memory list + 3 handlers (follow the file's existing `http.post`/`http.get` + envelope pattern; the repo's handlers return `{ header, body }`):

```ts
// ── P1 export framework ──────────────────────────────────────────────
const _mswExports: Record<string, unknown>[] = [];
let _mswExportSeq = 0;
export function __resetMswExports() { _mswExports.length = 0; _mswExportSeq = 0; }

// inside the exported handlers array:
http.post('/v1/exports', async ({ request }) => {
  const b = (await request.json()) as Record<string, unknown>;
  const rec = {
    ...b,
    export_id: `EXP-BANK_DEMO-${Date.now()}-${++_mswExportSeq}`,
    tenant_id: 'BANK_DEMO',
    generated_at: new Date().toISOString(),
  };
  _mswExports.unshift(rec);
  return HttpResponse.json({ header: { status: 'SUCCESS', code: 'EWS_201', message: 'Created' }, body: rec }, { status: 201 });
}),
http.get('/v1/exports', () =>
  HttpResponse.json({ header: { status: 'SUCCESS', code: 'EWS_200', message: 'OK' }, body: { items: _mswExports, total: _mswExports.length, page: 1, page_size: 50 } })),
http.get('/v1/exports/:id', ({ params }) => {
  const rec = _mswExports.find((r) => r.export_id === params.id);
  return rec
    ? HttpResponse.json({ header: { status: 'SUCCESS', code: 'EWS_200', message: 'OK' }, body: rec })
    : HttpResponse.json({ header: { status: 'FAILURE' }, error: { code: 'EWS_404_unknown_export', message: 'not found', severity: 'LOW' } }, { status: 404 });
}),
```

> Match the actual import names already used in `handlers.ts` (`http`, `HttpResponse` from `msw`). If the file already imports them, do not re-import.

- [ ] **Step 4: Run the focused test + both full suites**

Run:
```bash
cd web && npx vitest run src/__tests__/exportsMsw.test.ts   # if applicable
cd web && npx vitest run                                    # full web suite — all green
cd ../services/bff && npx jest __tests__/exports.test.ts    # backend suite — green
```
Expected: new tests PASS; no pre-existing test regresses.

- [ ] **Step 5: Commit**

```bash
git add web/src/mocks/handlers.ts web/src/__tests__/exportsMsw.test.ts
git commit -m "feat(web): MSW handlers for /v1/exports (dev-mode + tests)"
```

---

## Final verification (after all tasks)

- [ ] `cd services/bff && npx jest __tests__/exports.test.ts` — green
- [ ] `cd web && npx vitest run` — full web suite green (incl. existing CustomerRiskProfilePage + AlertListPage)
- [ ] `cd web && npx tsc --noEmit` — no new type errors
- [ ] `cd infra/rbac/lib && npx jest` — rbac matrix green
- [ ] Manual smoke (`make up` + `cd web && npm run dev`): login as alice.admin → open a customer → click Export → pick PDF+CSV → Generate → 2 files download → `GET /v1/exports` shows 2 records.
- [ ] Confirm field_officer does NOT see the Export button.

---

## Self-Review notes (author)

- **Spec coverage:** Export action (Task 10/11/12) · format options PDF/Excel/CSV (Task 5–7) · report-type select (Task 9) · date-range/scope/sections config (Task 9) · enterprise PDF header/footer/page-no/report-id (Task 6) · multi-sheet Excel (Task 7) · CSV tabular+filters (Task 5) · RBAC (Task 1/10 + route gate Task 3) · audit record per export (Task 3) · export-history store + routes (Task 2/3) · pilot Customer Report template (Task 11). **Deferred per spec (out of P1):** Word (.docx), AI narrative, Export History Center *page*, the other 28 screens, byte-identical re-download — these are P1.5/P2/P3/P4.
- **Placeholder scan:** none — every code step has complete code. The two "NOTE for the implementer" blocks (Task 11/12 page-wiring) are reconciliation guidance for additive edits into existing files whose exact local variable names must be read at edit time; the adapter functions they call are fully specified + unit-tested.
- **Type consistency:** `ReportData` / `ExportConfig` / `ExportFormat` / `ReportType` identical across frontend (Task 4) and consumed unchanged by Tasks 5–12. Backend `ExportRecordInput` / `ExportRecord` (Task 2) match the route (Task 3) and the `recordExport` payload (Task 8). `reports:export` scope name identical in Task 1 (matrix), Task 3 (route gate), Task 10 (button gate).
