import { describe, test, expect } from 'vitest';
import { http } from '@/lib/http';

// NOTE: the shared MSW `server` (@/mocks/server) is started + reset + closed
// by the global test setup (src/__tests__/setup.ts). This file does NOT
// re-call server.listen()/close() — doing so throws an MSW InvariantError
// ("cannot call .listen() twice"). The /v1/exports handler lives in
// src/mocks/handlers.ts so it's already registered on the shared server.

describe('/v1/exports MSW handler', () => {
  test('POST returns an enveloped export record', async () => {
    const res = await http.post('/v1/exports', {
      module: 'alerts', report_type: 'risk', format: 'csv', record_count: 3,
      title: 'Alerts', status: 'completed',
      config: { formats: ['csv'], report_type: 'risk', date_range: '30d', data_scope: 'filtered', include: {} },
    });
    // The repo's `http` response interceptor auto-unwraps the {header, body}
    // envelope (see src/lib/http.ts), so the export record lands directly at
    // res.data — NOT res.data.body. Reconciled to this repo's actual http.
    expect(res.data.export_id).toMatch(/^EXP-/);
  });
});
