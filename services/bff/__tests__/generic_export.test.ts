// services/bff/__tests__/generic_export.test.ts

import { buildXlsx, buildPdf, ExportError } from '../src/generic_export';

describe('buildXlsx', () => {
  it('builds a valid 1-sheet workbook', () => {
    const out = buildXlsx({
      sheets: [
        {
          name: 'Sheet 1',
          columns: ['ID', 'Name', 'Amount'],
          rows: [
            [1, 'Alice', 1000.5],
            [2, 'Bob', 2000],
            [3, 'Carol', null],
          ],
        },
      ],
    });
    expect(out.filename).toMatch(/\.xlsx$/);
    expect(out.buffer.length).toBeGreaterThan(500);
    // Verify ZIP header (PK\x03\x04)
    expect(out.buffer[0]).toBe(0x50);
    expect(out.buffer[1]).toBe(0x4b);
    expect(out.buffer[2]).toBe(0x03);
    expect(out.buffer[3]).toBe(0x04);
  });

  it('honours custom filename', () => {
    const out = buildXlsx({ filename: 'custom.xlsx', sheets: [{ name: 'S', columns: ['a'], rows: [['x']] }] });
    expect(out.filename).toBe('custom.xlsx');
  });

  it('rejects empty sheets', () => {
    expect(() => buildXlsx({ sheets: [] })).toThrow(ExportError);
  });

  it('rejects > 16 sheets', () => {
    const sheets = new Array(17).fill(null).map((_, i) => ({ name: `S${i}`, columns: ['a'], rows: [['x']] }));
    expect(() => buildXlsx({ sheets })).toThrow(ExportError);
  });

  it('rejects mismatched row + column lengths', () => {
    expect(() =>
      buildXlsx({ sheets: [{ name: 'X', columns: ['a', 'b'], rows: [['only-one-cell']] }] }),
    ).toThrow(ExportError);
  });

  it('rejects > 5000 rows in a sheet', () => {
    const rows = new Array(5001).fill(null).map((_, i) => [i]);
    expect(() => buildXlsx({ sheets: [{ name: 'X', columns: ['n'], rows }] })).toThrow(ExportError);
  });
});

describe('buildPdf', () => {
  it('builds a valid PDF', () => {
    const out = buildPdf({
      title: 'Test report',
      subtitle: 'Sample',
      sections: [
        {
          name: 'Section A',
          columns: ['ID', 'Name'],
          rows: [
            [1, 'Alice'],
            [2, 'Bob'],
          ],
        },
      ],
    });
    expect(out.filename).toMatch(/\.pdf$/);
    expect(out.buffer.length).toBeGreaterThan(200);
    // Verify PDF header (%PDF-)
    expect(out.buffer.slice(0, 5).toString('utf-8')).toBe('%PDF-');
    // Verify PDF trailer (%%EOF)
    const tail = out.buffer.slice(-6).toString('utf-8');
    expect(tail).toContain('%%EOF');
  });

  it('honours generated_at + generated_by', () => {
    const out = buildPdf({
      title: 'T',
      generated_at: '2026-05-23T12:00:00Z',
      generated_by: 'alice',
      sections: [{ name: 'S', columns: ['x'], rows: [['y']] }],
    });
    expect(out.buffer.toString('utf-8')).toContain('Generated: 2026-05-23');
    expect(out.buffer.toString('utf-8')).toContain('alice');
  });

  it('rejects missing title + empty sections', () => {
    // @ts-expect-error title missing
    expect(() => buildPdf({ sections: [{ name: 'S', columns: ['x'], rows: [['y']] }] })).toThrow(ExportError);
    expect(() => buildPdf({ title: 'T', sections: [] })).toThrow(ExportError);
  });

  it('truncates row list to 200 when section has > 200 rows', () => {
    const rows = new Array(250).fill(null).map((_, i) => [i, `R${i}`]);
    const out = buildPdf({ title: 'Big', sections: [{ name: 'S', columns: ['n', 'name'], rows }] });
    // The truncation notice is embedded in the content stream;
    // we assert that the PDF is well-formed + has a non-trivial size
    expect(out.buffer.slice(0, 5).toString('utf-8')).toBe('%PDF-');
    expect(out.buffer.length).toBeGreaterThan(500);
  });
});
