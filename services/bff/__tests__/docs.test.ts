// services/bff/__tests__/docs.test.ts
//
// Mount tests for the /docs Swagger UI surface (services/bff/src/docs.ts).
// In-memory only — no pg, no env vars, no real file watching.

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { mountDocs } from '../src/docs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'api', 'swagger.json');

const SPEC_PRESENT = fs.existsSync(SPEC_PATH);
const describeWithSpec = SPEC_PRESENT ? describe : describe.skip;

describeWithSpec('mountDocs (with real swagger.json on disk)', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    delete process.env.DISABLE_DOCS;
  });

  it('returns true when the spec is present + mounts /docs', () => {
    const mounted = mountDocs(app);
    expect(mounted).toBe(true);
  });

  it('exposes raw JSON at /docs/openapi.json', async () => {
    mountDocs(app);
    const r = await request(app).get('/docs/openapi.json').expect(200);
    expect(r.body.openapi).toBe('3.1.0');
    expect(r.body.info.title).toBe('ZorEWS BFF API');
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(100);
  });

  it('serves the swagger-ui HTML at /docs/', async () => {
    mountDocs(app);
    const r = await request(app).get('/docs/').expect(200);
    expect(r.text).toContain('swagger-ui');
    // Verify the customisations landed
    expect(r.text).toContain('ZorEWS BFF — API Reference');
  });

  it('respects custom basePath option', async () => {
    mountDocs(app, { basePath: '/api-docs' });
    await request(app).get('/api-docs/openapi.json').expect(200);
    // The default /docs path should NOT be mounted
    await request(app).get('/docs/openapi.json').expect(404);
  });

  it('skips the mount when DISABLE_DOCS=true', async () => {
    process.env.DISABLE_DOCS = 'true';
    const mounted = mountDocs(app);
    expect(mounted).toBe(false);
    await request(app).get('/docs/openapi.json').expect(404);
    delete process.env.DISABLE_DOCS;
  });
});

describe('mountDocs (no spec on disk)', () => {
  it('returns false + does not throw when the spec is missing', () => {
    // Force resolveSpecPath to miss by overriding the root candidate
    const originalRoot = process.env.ZOREWS_REPO_ROOT;
    process.env.ZOREWS_REPO_ROOT = '/nonexistent/path/that/will/never/exist/abc123';

    // We also need to bypass the real candidates — easiest is to mock fs
    // briefly. We use jest's spyOn to make existsSync return false for any
    // path containing swagger.json.
    const spy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('swagger.json')) return false;
      // Defer to real fs for other paths (don't break unrelated code)
      return false;
    });

    const app = express();
    const mounted = mountDocs(app);
    expect(mounted).toBe(false);

    spy.mockRestore();
    if (originalRoot === undefined) delete process.env.ZOREWS_REPO_ROOT;
    else process.env.ZOREWS_REPO_ROOT = originalRoot;
  });
});
