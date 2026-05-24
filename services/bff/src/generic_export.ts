// services/bff/src/generic_export.ts
//
// Generic Excel + PDF export — closes §2.4 #24 of
// ZorEWS_Pending_Gap_Analysis.md.
//
//   POST /v1/export/xlsx       body: { sheets: [{ name, columns[], rows[] }] }
//   POST /v1/export/pdf        body: { title, sections: [{ heading, columns, rows }] }
//
// Returns binary content with Content-Disposition: attachment. Distinct
// from /v1/reports/builder/export.csv (which is the report-builder
// pipeline) — these are generic table-to-binary generators any SPA
// surface can use.

export interface ExportSheet {
  name: string;
  columns: string[];
  rows: (string | number | boolean | null)[][];
}

export interface XlsxExportInput {
  filename?: string;
  sheets: ExportSheet[];
}

export interface PdfExportInput {
  title: string;
  subtitle?: string;
  generated_at?: string;
  generated_by?: string;
  filename?: string;
  sections: ExportSheet[];
}

export class ExportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

function validateSheet(s: ExportSheet, label: string): void {
  if (!s || typeof s !== 'object') throw new ExportError('invalid_input', `${label} must be an object`);
  if (!s.name || typeof s.name !== 'string' || s.name.length > 60)
    throw new ExportError('invalid_input', `${label}.name must be 1..60 chars`);
  if (!Array.isArray(s.columns) || s.columns.length === 0)
    throw new ExportError('invalid_input', `${label}.columns must be non-empty`);
  if (s.columns.length > 50) throw new ExportError('invalid_input', `${label}.columns > 50`);
  if (!Array.isArray(s.rows)) throw new ExportError('invalid_input', `${label}.rows must be an array`);
  if (s.rows.length > 5000) throw new ExportError('invalid_input', `${label}.rows > 5000`);
  for (const r of s.rows) {
    if (!Array.isArray(r)) throw new ExportError('invalid_input', `each row must be an array`);
    if (r.length !== s.columns.length) throw new ExportError('invalid_input', `row length must match columns`);
  }
}

// ─── Minimal valid XLSX writer (OOXML-bare-bones; xl/sharedStrings.xml + xl/worksheets/sheetN.xml) ─────
// To avoid pulling in heavy native deps, we generate a minimal valid
// .xlsx Open XML SpreadsheetML zipped envelope using only stdlib +
// the existing `node:zlib` deflate primitive. The output is a
// well-formed .xlsx that opens in Excel / Numbers / LibreOffice.
//
// Format (per ISO/IEC 29500): a ZIP archive containing
//   [Content_Types].xml    — content type registry
//   _rels/.rels            — package relationships
//   xl/workbook.xml        — workbook metadata + sheet list
//   xl/_rels/workbook.xml.rels
//   xl/sharedStrings.xml   — string table
//   xl/worksheets/sheet{N}.xml
// We deliberately avoid xl/styles.xml (everything renders as text/numeric
// with default formatting), which keeps the writer simple + portable.

import { deflateRawSync } from 'zlib';

interface ZipEntry {
  path: string;
  data: Buffer;
}

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const fileName = Buffer.from(entry.path, 'utf-8');
    const uncompressed = entry.data;
    const compressed = deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);
    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // method = deflate
    local.writeUInt16LE(0, 10);          // mtime
    local.writeUInt16LE(0, 12);          // mdate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    localHeaders.push(Buffer.concat([local, fileName, compressed]));
    // Central directory entry (46 bytes + name)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);          // ext attrs
    central.writeUInt32LE(offset, 42);
    centralDir.push(Buffer.concat([central, fileName]));
    offset += local.length + fileName.length + compressed.length;
  }
  const centralDirBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localHeaders, centralDirBuf, eocd]);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

// Convert 0-indexed col → A, B, ..., Z, AA, ..., AZ, ...
function colToLetters(idx: number): string {
  let out = '';
  let n = idx;
  while (n >= 0) {
    out = String.fromCharCode((n % 26) + 65) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

export function buildXlsx(input: XlsxExportInput): { buffer: Buffer; filename: string } {
  if (!input || !Array.isArray(input.sheets) || input.sheets.length === 0)
    throw new ExportError('invalid_input', 'sheets must be non-empty');
  if (input.sheets.length > 16) throw new ExportError('invalid_input', 'sheets > 16');
  for (let i = 0; i < input.sheets.length; i++) validateSheet(input.sheets[i], `sheets[${i}]`);

  // Build shared-strings table — every value (column header + string row cell) becomes a shared-string index.
  const sst: string[] = [];
  const sstIndex = new Map<string, number>();
  function ssIdx(v: string): number {
    const seen = sstIndex.get(v);
    if (seen !== undefined) return seen;
    const idx = sst.length;
    sst.push(v);
    sstIndex.set(v, idx);
    return idx;
  }

  const sheetXmls: string[] = [];
  for (const sheet of input.sheets) {
    let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
    // Header row (row 1)
    xml += '<row r="1">';
    sheet.columns.forEach((c, ci) => {
      xml += `<c r="${colToLetters(ci)}1" t="s"><v>${ssIdx(c)}</v></c>`;
    });
    xml += '</row>';
    sheet.rows.forEach((row, ri) => {
      const rowNum = ri + 2;
      xml += `<row r="${rowNum}">`;
      row.forEach((cell, ci) => {
        const ref = `${colToLetters(ci)}${rowNum}`;
        if (cell === null || cell === undefined) return;
        if (typeof cell === 'number' && Number.isFinite(cell))
          xml += `<c r="${ref}"><v>${cell}</v></c>`;
        else if (typeof cell === 'boolean')
          xml += `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
        else
          xml += `<c r="${ref}" t="s"><v>${ssIdx(String(cell))}</v></c>`;
      });
      xml += '</row>';
    });
    xml += '</sheetData></worksheet>';
    sheetXmls.push(xml);
  }

  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst
    .map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`)
    .join('')}</sst>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    input.sheets
      .map((s, i) => `<sheet name="${escapeXml(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    input.sheets
      .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('') +
    `<Relationship Id="rId${input.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    input.sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf-8') },
    { path: '_rels/.rels', data: Buffer.from(rels, 'utf-8') },
    { path: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf-8') },
    { path: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf-8') },
    { path: 'xl/sharedStrings.xml', data: Buffer.from(sstXml, 'utf-8') },
    ...sheetXmls.map((xml, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(xml, 'utf-8') })),
  ];
  return { buffer: buildZip(entries), filename: input.filename ?? `export-${Date.now()}.xlsx` };
}

// ─── Minimal text-rendered PDF (single page, monospace) ─────────────────
// Generates a valid 1.4 PDF with a single content stream rendering each
// section as fixed-width text. Sufficient for ops "print-to-PDF" needs
// without pulling in a full PDF library.

function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildPdf(input: PdfExportInput): { buffer: Buffer; filename: string } {
  if (!input || typeof input !== 'object') throw new ExportError('invalid_input', 'input required');
  if (!input.title || typeof input.title !== 'string')
    throw new ExportError('invalid_input', 'title required');
  if (!Array.isArray(input.sections) || input.sections.length === 0)
    throw new ExportError('invalid_input', 'sections must be non-empty');
  for (let i = 0; i < input.sections.length; i++) validateSheet(input.sections[i], `sections[${i}]`);

  // Build the visible content as plain-text rows (one PDF line each).
  const lines: string[] = [];
  lines.push(input.title);
  if (input.subtitle) lines.push(input.subtitle);
  if (input.generated_at) lines.push(`Generated: ${input.generated_at}`);
  if (input.generated_by) lines.push(`By: ${input.generated_by}`);
  lines.push('');
  for (const sec of input.sections) {
    lines.push(`### ${sec.name}`);
    lines.push(sec.columns.join(' | '));
    lines.push(sec.columns.map(() => '----').join('-+-'));
    for (const row of sec.rows.slice(0, 200)) {
      lines.push(row.map((c) => (c === null || c === undefined ? '' : String(c))).join(' | '));
    }
    if (sec.rows.length > 200) lines.push(`... (showing first 200 of ${sec.rows.length} rows)`);
    lines.push('');
  }

  // Build single-page PDF.
  // Use built-in Helvetica font (no font embedding needed). Each line at
  // y = top - i*lineHeight. If lines overflow, truncate with notice.
  const top = 800;
  const lineHeight = 14;
  const maxLines = Math.floor(top / lineHeight) - 2;
  const visibleLines = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), `... (truncated; ${lines.length - maxLines + 1} more lines)`] : lines;

  const contentStream = `BT /F1 10 Tf 36 ${top} Td 12 TL ${visibleLines
    .map((l, i) => `${i === 0 ? '' : 'T* '}(${pdfEscape(l).slice(0, 200)}) Tj`)
    .join(' ')} ET`;

  const buf = Buffer.from(contentStream, 'utf-8');
  const lengthStr = String(buf.length);

  // Build PDF objects (5 objects + xref + trailer)
  const objects: string[] = [];
  // 1 — Catalog
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  // 2 — Pages
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  // 3 — Page
  objects.push(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  );
  // 4 — Content stream
  objects.push(`<< /Length ${lengthStr} >>\nstream\n${contentStream}\nendstream`);
  // 5 — Font
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  // Assemble PDF body with byte offsets for xref
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'utf-8'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf-8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return { buffer: Buffer.from(pdf, 'utf-8'), filename: input.filename ?? `export-${Date.now()}.pdf` };
}
