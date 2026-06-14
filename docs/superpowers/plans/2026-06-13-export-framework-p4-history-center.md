# Export Framework P4 — Export History Center + byte-identical re-download

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Ship the Export History Center SPA page (list/filter every export with full metadata) + byte-identical re-download backed by bounded server-side artifact storage.

**Architecture:** Additive on the P1 framework. The BFF export store gains optional artifact bytes (base64) with a tight size + count cap so memory stays bounded; `POST /v1/exports` accepts an optional artifact; `GET /v1/exports/:id/download` serves it. The ExportModal base64-encodes each generated blob and includes it in the audit POST, so the server holds the exact bytes the user downloaded. The History Center page consumes `GET /v1/exports` and offers a real re-download for records that carry an artifact.

**Tech Stack:** TypeScript, React, vitest (web); Express, jest (BFF). No new deps.

**Spec:** `docs/superpowers/specs/2026-06-13-enterprise-report-export-framework-design.md` (§"EXPORT HISTORY", §11 re-download caveat now being closed).

---

## File structure
- Modify: `services/bff/src/exports/store.ts` — artifact fields + `getArtifact` + artifact cap.
- Modify: `services/bff/src/server.ts` — `POST /v1/exports` accepts optional artifact; new `GET /v1/exports/:export_id/download`.
- Modify: `web/src/lib/export/recordExport.ts` + `ExportModal.tsx` — base64 the blob, send it.
- Modify: `web/src/lib/api.ts` — `exportsHistory` + `exportDownloadUrl` helpers + `ExportHistoryRecord` type.
- Create: `web/src/modules/admin/exports/ExportHistoryPage.tsx` + route + nav.
- Modify: `web/src/mocks/handlers.ts` — store/serve artifact in the MSW handlers.
- Tests: `services/bff/__tests__/exports.test.ts` (artifact round-trip) + `web/src/__tests__/ExportHistoryPage.test.tsx`.

---

## Task 1: BFF artifact storage (store)

**Files:** Modify `services/bff/src/exports/store.ts`; append to `services/bff/__tests__/exports.test.ts`

- [ ] **Step 1: Write the failing test** — append to `services/bff/__tests__/exports.test.ts`:
```ts
import { InMemoryExportHistoryStore as Store2 } from '../src/exports/store';

describe('export artifact storage', () => {
  test('add() with artifact → getArtifact returns it + has_artifact true', () => {
    const s = new Store2();
    const rec = s.add('BANK_DEMO', { ...input(), artifact_base64: 'aGVsbG8=', content_type: 'text/csv' }, NOW, 1);
    expect(rec.has_artifact).toBe(true);
    expect(rec.artifact_base64).toBeUndefined(); // list/get views never inline the blob
    const art = s.getArtifact('BANK_DEMO', rec.export_id);
    expect(art?.base64).toBe('aGVsbG8=');
    expect(art?.content_type).toBe('text/csv');
  });
  test('add() without artifact → has_artifact false, getArtifact null', () => {
    const s = new Store2();
    const rec = s.add('BANK_DEMO', input(), NOW, 1);
    expect(rec.has_artifact).toBe(false);
    expect(s.getArtifact('BANK_DEMO', rec.export_id)).toBeNull();
  });
  test('artifact cap evicts oldest artifact bytes (record metadata stays)', () => {
    const s = new Store2(500, 2); // artifactCap = 2
    const a = s.add('BANK_DEMO', { ...input(), artifact_base64: 'YQ==', content_type: 'text/csv' }, new Date('2026-06-13T10:00:00Z'), 1);
    s.add('BANK_DEMO', { ...input(), artifact_base64: 'Yg==', content_type: 'text/csv' }, new Date('2026-06-13T11:00:00Z'), 2);
    s.add('BANK_DEMO', { ...input(), artifact_base64: 'Yw==', content_type: 'text/csv' }, new Date('2026-06-13T12:00:00Z'), 3);
    expect(s.getArtifact('BANK_DEMO', a.export_id)).toBeNull();      // oldest artifact evicted
    expect(s.get('BANK_DEMO', a.export_id)?.has_artifact).toBe(false); // metadata stays, flag flips
  });
  test('getArtifact cross-tenant returns null', () => {
    const s = new Store2();
    const rec = s.add('BANK_DEMO', { ...input(), artifact_base64: 'YQ==', content_type: 'text/csv' }, NOW, 1);
    expect(s.getArtifact('BIL', rec.export_id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fail.** `cd services/bff && npx jest __tests__/exports.test.ts -t "artifact"` — FAIL (no artifact support).

- [ ] **Step 3: Implement** — in `services/bff/src/exports/store.ts`:

Add to `ExportRecordInput`:
```ts
  /** Optional base64 of the generated file, for byte-identical re-download.
   *  Stored separately + size/count-capped; never inlined into list/get views. */
  artifact_base64?: string;
  content_type?: string;
```
Change `ExportRecord` to drop the inlined artifact + add a flag:
```ts
export interface ExportRecord extends Omit<ExportRecordInput, 'artifact_base64' | 'content_type'> {
  export_id: string;
  tenant_id: string;
  generated_at: string;
  has_artifact: boolean;
}
export interface ExportArtifact { base64: string; content_type: string; }
```
Add to `ExportHistoryStore`:
```ts
  getArtifact(tenant_id: string, export_id: string): ExportArtifact | null;
```
Add a max artifact byte length constant + a per-tenant artifact map in `InMemoryExportHistoryStore`:
```ts
const MAX_ARTIFACT_B64 = 4 * 1024 * 1024; // ~4MB base64 ceiling per artifact
```
Constructor: `constructor(private readonly cap = DEFAULT_CAP, private readonly artifactCap = 50) {}`
Add `private artifacts = new Map<string, Map<string, ExportArtifact>>();` and a per-tenant insertion-order list for artifact eviction.

In `add()`: after building the metadata `rec`, set `has_artifact`:
```ts
    let hasArtifact = false;
    if (input.artifact_base64 && input.content_type && input.artifact_base64.length <= MAX_ARTIFACT_B64) {
      const am = this.artifacts.get(tenant_id) ?? new Map<string, ExportArtifact>();
      am.set(rec.export_id, { base64: input.artifact_base64, content_type: input.content_type });
      // evict oldest artifact(s) beyond the cap (insertion order = Map order)
      while (am.size > this.artifactCap) {
        const oldest = am.keys().next().value as string;
        am.delete(oldest);
        const stale = (this.byTenant.get(tenant_id) ?? []).find((r) => r.export_id === oldest);
        if (stale) stale.has_artifact = false;
      }
      this.artifacts.set(tenant_id, am);
      hasArtifact = true;
    }
```
Build `rec` with `has_artifact: hasArtifact` (strip artifact_base64/content_type from the stored metadata record). `get()`/`list()` return `{ ...r }` (metadata only — no blob). Add:
```ts
  getArtifact(tenant_id: string, export_id: string): ExportArtifact | null {
    const a = this.artifacts.get(tenant_id)?.get(export_id);
    return a ? { ...a } : null;
  }
```

- [ ] **Step 4: Run → pass.** `cd services/bff && npx jest __tests__/exports.test.ts` — all green (existing + new).

- [ ] **Step 5: Commit.** `git add services/bff/src/exports/store.ts services/bff/__tests__/exports.test.ts && git commit -m "feat(bff): export artifact storage (bounded) for byte-identical re-download"`

---

## Task 2: BFF routes — accept artifact on POST + download route

**Files:** Modify `services/bff/src/server.ts`; append route tests to `services/bff/__tests__/exports.test.ts`

- [ ] **Step 1: Write the failing test** — append:
```ts
describe('POST artifact + GET /:id/download', () => {
  beforeEach(() => _resetDefaultExportHistoryStore());
  test('POST with artifact → download returns the bytes + content-type', async () => {
    const app = makeApp({});
    const created = await request(app).post('/v1/exports').set(adminHeaders())
      .send({ ...body(), artifact_base64: Buffer.from('hello,world').toString('base64'), content_type: 'text/csv' });
    expect(created.body.body.has_artifact).toBe(true);
    const id = created.body.body.export_id;
    const dl = await request(app).get(`/v1/exports/${id}/download`).set(adminHeaders());
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('text/csv');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.text).toBe('hello,world');
  });
  test('download 404 when no artifact stored', async () => {
    const app = makeApp({});
    const created = await request(app).post('/v1/exports').set(adminHeaders()).send(body());
    const id = created.body.body.export_id;
    const dl = await request(app).get(`/v1/exports/${id}/download`).set(adminHeaders());
    expect(dl.status).toBe(404);
  });
  test('download 403 without reports:export', async () => {
    const app = makeApp({});
    const created = await request(app).post('/v1/exports').set(adminHeaders())
      .send({ ...body(), artifact_base64: Buffer.from('x').toString('base64'), content_type: 'text/csv' });
    const id = created.body.body.export_id;
    const dl = await request(app).get(`/v1/exports/${id}/download`).set({ ...adminHeaders(), 'x-apex-role': 'field_officer' });
    expect(dl.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run → fail.** `cd services/bff && npx jest __tests__/exports.test.ts -t "download"`.

- [ ] **Step 3: Implement** — in `services/bff/src/server.ts`:

In the `POST /v1/exports` handler, when building `recInput`, pass the optional artifact through:
```ts
        artifact_base64: typeof b.artifact_base64 === 'string' ? b.artifact_base64 : undefined,
        content_type: typeof b.content_type === 'string' ? b.content_type : undefined,
```
(add these two keys to the `recInput` object literal; the `ExportRecordInput` type already carries them after Task 1.)

Add a new route after `GET /v1/exports/:export_id`:
```ts
  app.get(
    '/v1/exports/:export_id/download',
    requireTenantMw,
    requireRole('reports:export'),
    (req: Request, res: Response) => {
      const ctx = extractCtx(req, now);
      const art = exportHistoryStore.getArtifact(req.tenant!.tenant_id, req.params.export_id);
      if (!art) {
        return res.status(404).json(wrapError({ code: 'EWS_404_no_artifact', message: 'no stored artifact for this export', severity: 'LOW' }, ctx));
      }
      const buf = Buffer.from(art.base64, 'base64');
      res.setHeader('Content-Type', art.content_type);
      res.setHeader('Content-Disposition', `attachment; filename="export-${req.params.export_id}"`);
      return res.status(200).send(buf);
    },
  );
```
> Note: `:export_id/download` must register so it isn't shadowed by `:export_id`. Express matches by registration order + path specificity; register `/download` AFTER `/:export_id` is fine because the paths differ in segment count. Verify the existing `/:export_id` route still returns JSON.

- [ ] **Step 4: Run → pass.** `cd services/bff && npx jest __tests__/exports.test.ts` — all green.

- [ ] **Step 5: Commit.** `git add services/bff/src/server.ts services/bff/__tests__/exports.test.ts && git commit -m "feat(bff): GET /v1/exports/:id/download — byte-identical artifact re-download"`

---

## Task 3: ExportModal uploads the artifact

**Files:** Modify `web/src/lib/export/recordExport.ts`, `web/src/components/export/ExportModal.tsx`; extend `web/src/__tests__/recordExport.test.ts`

- [ ] **Step 1: Write the failing test** — append to `web/src/__tests__/recordExport.test.ts`:
```ts
test('forwards artifact_base64 + content_type when provided', async () => {
  await recordExport({
    module: 'alerts', report_type: 'risk', format: 'csv', record_count: 1,
    title: 'x', status: 'completed',
    config: { formats: ['csv'], report_type: 'risk', date_range: 'today', data_scope: 'current_page', include: {} },
    artifact_base64: 'YQ==', content_type: 'text/csv',
  });
  expect(http.post).toHaveBeenCalledWith('/v1/exports', expect.objectContaining({ artifact_base64: 'YQ==', content_type: 'text/csv' }));
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.**
In `recordExport.ts`, extend `RecordExportInput` with `artifact_base64?: string; content_type?: string;` (they pass straight through to the POST body — already spread).
In `ExportModal.tsx` `generate()`, after producing each `blob`, base64-encode it and pass to `recordExport`. Add a helper:
```ts
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv', pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
```
In the per-format loop, after `download(blob, …)`:
```ts
        let artifact_base64: string | undefined;
        try { artifact_base64 = await blobToBase64(blob); } catch { artifact_base64 = undefined; }
        await recordExport({
          module, report_type: reportType, format: fmt, record_count: data.record_count,
          title: data.title, status: 'completed',
          config: { formats, report_type: reportType, date_range: dateRange, data_scope: scope, include },
          artifact_base64, content_type: MIME[fmt],
        });
```
(replace the existing `recordExport(...)` call in the loop with this artifact-carrying version.)

- [ ] **Step 4: Run → pass.** `cd web && npx vitest run src/__tests__/recordExport.test.ts src/__tests__/ExportModal.test.tsx` — green. (jsdom has `btoa` + `Blob.arrayBuffer`; if `arrayBuffer` is missing in this jsdom, the try/catch leaves artifact undefined — the modal test already mocks generators returning `new Blob([...])`, so confirm it still passes; if arrayBuffer throws, the export still records without an artifact, which is acceptable.)

- [ ] **Step 5: Commit.** `git add web/src/lib/export/recordExport.ts web/src/components/export/ExportModal.tsx web/src/__tests__/recordExport.test.ts && git commit -m "feat(web): ExportModal uploads generated artifact for re-download"`

---

## Task 4: Export History Center page

**Files:** Modify `web/src/lib/api.ts`, `web/src/App.tsx`, `web/src/components/layout/AppShell.tsx`, `web/src/mocks/handlers.ts`; create `web/src/modules/admin/exports/ExportHistoryPage.tsx`, `web/src/__tests__/ExportHistoryPage.test.tsx`

- [ ] **Step 1: api.ts helpers.** Add:
```ts
export interface ExportHistoryRecord {
  export_id: string; tenant_id: string; generated_by: string; role: string;
  module: string; report_type: string; format: string; record_count: number;
  title: string; status: 'completed' | 'failed'; generated_at: string; has_artifact: boolean;
}
// in the api object:
  exportsHistory: (params: { module?: string; format?: string; page?: number; page_size?: number } = {}) =>
    http.get('/v1/exports', { params }).then((r) => r.data as { items: ExportHistoryRecord[]; total: number; page: number; page_size: number }),
```
(The http interceptor auto-unwraps the `{header, body}` envelope so `r.data` is the body.)

- [ ] **Step 2: MSW.** In `web/src/mocks/handlers.ts`, extend the existing `/v1/exports` POST handler to record `has_artifact: !!body.artifact_base64` + stash the artifact in a module map; add `http.get('/v1/exports/:id/download', ...)` returning the stashed bytes (or 404). Ensure the GET `/v1/exports` list returns `has_artifact` on each row.

- [ ] **Step 3: Write the failing test** — `web/src/__tests__/ExportHistoryPage.test.tsx`:
```tsx
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ExportHistoryPage } from '@/modules/admin/exports/ExportHistoryPage';

vi.mock('@/lib/api', () => ({
  api: {
    exportsHistory: vi.fn().mockResolvedValue({
      items: [
        { export_id: 'EXP-1', tenant_id: 'BANK_DEMO', generated_by: 'alice.admin', role: 'admin', module: 'customer_360', report_type: 'customer', format: 'pdf', record_count: 12, title: 'Customer Report', status: 'completed', generated_at: '2026-06-13T10:00:00Z', has_artifact: true },
        { export_id: 'EXP-2', tenant_id: 'BANK_DEMO', generated_by: 'bob', role: 'supervisor', module: 'alerts', report_type: 'risk', format: 'csv', record_count: 5, title: 'Alerts', status: 'completed', generated_at: '2026-06-13T09:00:00Z', has_artifact: false },
      ], total: 2, page: 1, page_size: 50,
    }),
  },
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
}
beforeEach(() => localStorage.setItem('apex.ews.user', JSON.stringify({ username: 'alice.admin', roles: ['admin'] })));

describe('ExportHistoryPage', () => {
  test('lists export records with module + format + generated-by', async () => {
    render(wrap(<ExportHistoryPage />));
    await waitFor(() => expect(screen.getByText('Customer Report')).toBeTruthy());
    expect(screen.getByText('customer_360')).toBeTruthy();
    expect(screen.getByText('alice.admin')).toBeTruthy();
  });
  test('shows a download action only for records with an artifact', async () => {
    render(wrap(<ExportHistoryPage />));
    await waitFor(() => expect(screen.getByText('Customer Report')).toBeTruthy());
    expect(screen.getAllByTestId('export-download').length).toBe(1); // only EXP-1 has_artifact
  });
});
```

- [ ] **Step 4: Run → fail.** `cd web && npx vitest run src/__tests__/ExportHistoryPage.test.tsx`.

- [ ] **Step 5: Implement** — `web/src/modules/admin/exports/ExportHistoryPage.tsx`:
```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel, Badge, DataTable, type Column } from '@/components/ui';
import { api, type ExportHistoryRecord } from '@/lib/api';

const FORMAT_TONE: Record<string, 'blue' | 'success' | 'warning' | 'purple'> = {
  pdf: 'danger' as never, xlsx: 'success', csv: 'blue', docx: 'purple',
};

export function ExportHistoryPage() {
  const [moduleFilter, setModuleFilter] = useState<string>('');
  const [formatFilter, setFormatFilter] = useState<string>('');
  const { data, isLoading } = useQuery({
    queryKey: ['exports.history', moduleFilter, formatFilter],
    queryFn: () => api.exportsHistory({ module: moduleFilter || undefined, format: formatFilter || undefined }),
  });
  const rows = data?.items ?? [];

  const columns: Column<ExportHistoryRecord>[] = [
    { key: 'title', header: 'Report', render: (r) => <span className="font-medium">{r.title}</span> },
    { key: 'module', header: 'Module', render: (r) => <span className="text-xs">{r.module}</span> },
    { key: 'report_type', header: 'Type', render: (r) => <Badge tone="neutral">{r.report_type}</Badge> },
    { key: 'format', header: 'Format', render: (r) => <Badge tone={FORMAT_TONE[r.format] ?? 'neutral'}>{r.format.toUpperCase()}</Badge> },
    { key: 'generated_by', header: 'Generated By', render: (r) => <span className="text-xs">{r.generated_by}</span> },
    { key: 'generated_at', header: 'When', render: (r) => <span className="text-xs">{new Date(r.generated_at).toLocaleString()}</span> },
    { key: 'record_count', header: 'Records', render: (r) => <span className="tabular-nums">{r.record_count}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'completed' ? 'success' : 'danger'}>{r.status}</Badge> },
    {
      key: 'download', header: '', render: (r) => r.has_artifact
        ? <a data-testid="export-download" href={`/v1/exports/${r.export_id}/download`} className="inline-flex items-center gap-1 text-action text-xs hover:underline"><Download size={13} /> Download</a>
        : <span className="text-2xs text-muted">re-export from module</span>,
    },
  ];

  return (
    <div data-testid="export-history-page">
      <PageHeader title="Export History Center" subtitle="Every report exported across ZorEWS — with re-download for stored artifacts." />
      <Panel>
        <div className="flex gap-2 mb-3">
          <input className="input" placeholder="Filter module…" value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} data-testid="export-history-module" />
          <select className="input" value={formatFilter} onChange={(e) => setFormatFilter(e.target.value)} data-testid="export-history-format">
            <option value="">All formats</option>
            <option value="pdf">PDF</option><option value="xlsx">Excel</option>
            <option value="csv">CSV</option><option value="docx">Word</option>
          </select>
        </div>
        {isLoading ? <p className="caption">Loading…</p> : <DataTable columns={columns} data={rows} rowKey={(r) => r.export_id} />}
      </Panel>
    </div>
  );
}
```
> NOTE: confirm the real `DataTable` API (`columns`/`data`/`rowKey` prop names + `Column` type) by reading `web/src/components/ui/DataTable.tsx` — reconcile if the prop names differ (e.g. `keyField`). Confirm `Badge` tones available; map `pdf` to a valid tone (use `'danger'` only if it exists, else `'warning'`).

- [ ] **Step 6: Route + nav.** In `web/src/App.tsx` add `<Route path="admin/exports" element={<ExportHistoryPage />} />` (import it). In `web/src/components/layout/AppShell.tsx` add a nav entry under the Admin/Reports group pointing at `/admin/exports` (icon e.g. `History` or `FileDown`), gated to analyst+ if the nav supports `requireRole`; otherwise just add the link (the page is reachable + the data is RBAC-gated at the BFF).

- [ ] **Step 7: Run → pass.** `cd web && npx vitest run src/__tests__/ExportHistoryPage.test.tsx` — green.

- [ ] **Step 8: Commit.** `git add -A web/src/modules/admin/exports web/src/__tests__/ExportHistoryPage.test.tsx web/src/lib/api.ts web/src/App.tsx web/src/components/layout/AppShell.tsx web/src/mocks/handlers.ts && git commit -m "feat(web): Export History Center page + re-download"`

---

## Final verification (P4)
- [ ] `cd services/bff && npx jest __tests__/exports.test.ts` — green
- [ ] `cd web && npx vitest run` — FULL suite green
- [ ] `cd web && npx tsc --noEmit 2>&1 | grep "error TS" | grep -vc "mocks/handlers.ts"` — `0`

## Self-Review notes
- **Spec coverage:** Export History Center "Track: Report Name/Module/Generated By/Format/Generated Time/Status" (Task 4 columns) + "Allow re-download" (Tasks 1-3 artifact storage + the download column). Closes the §11 re-download caveat — now byte-identical for stored artifacts (bounded cap; older artifacts fall back to "re-export from module").
- **Bounded memory:** artifacts are capped (count + per-blob size); the metadata history is unaffected by eviction.
- **Type consistency:** `ExportRecord.has_artifact` flows store → routes → api `ExportHistoryRecord` → page. `artifact_base64`/`content_type` are input-only (never inlined in list/get).
- **Additive:** new page + route + nav entry; existing routes unchanged (POST gains optional fields; new download route is additive).
