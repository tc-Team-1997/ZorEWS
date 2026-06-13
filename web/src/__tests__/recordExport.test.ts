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
