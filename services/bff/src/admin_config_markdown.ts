// services/bff/src/admin_config_markdown.ts
//
// T6 M13.13 — Config schema Markdown reference export.
//
// M13.9 ships a fixed-width plain-text summary (printable to PDF).
// M13.13 ships a Markdown-formatted REFERENCE of the M13.1 schema:
// hand-publishable in ops onboarding docs, regulator submissions,
// or pasted into a confluence page.
//
// Format:
//   - top-of-doc summary line (counts)
//   - one `##` heading per category in canonical order
//   - per-category Markdown table: key | type | default | description
//
// Pure renderer — no I/O, platform-static.

import { DEFAULTS, listCategories, type ConfigDef, type ConfigValue } from './admin_config';

// ─── Pure formatter ───────────────────────────────────────────────────

function escapePipe(s: string): string {
  // GFM table cells must escape `|`.
  return s.replace(/\|/g, '\\|');
}

function fmtDefaultValue(v: ConfigValue): string {
  if (typeof v === 'string') {
    return v === '' ? '`""`' : `\`"${v.replace(/`/g, "'")}"\``;
  }
  if (typeof v === 'boolean') return `\`${v}\``;
  if (typeof v === 'number') return `\`${v}\``;
  // json object
  try {
    return `\`${JSON.stringify(v)}\``;
  } catch {
    return '`{}`';
  }
}

function renderCategoryTable(category: string, defs: readonly ConfigDef[]): string {
  const sorted = [...defs].sort((a, b) => a.key.localeCompare(b.key));
  const lines: string[] = [
    `## ${category}`,
    '',
    `_${sorted.length} key${sorted.length === 1 ? '' : 's'} in this category._`,
    '',
    '| Key | Type | Default | Description |',
    '|-----|------|---------|-------------|',
  ];
  for (const d of sorted) {
    lines.push(
      `| \`${escapePipe(d.key)}\` | ${d.type} | ${fmtDefaultValue(d.default_value)} | ${escapePipe(d.description)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderConfigSchemaMarkdown(now: Date): string {
  const generatedAt = now.toISOString();
  const cats = listCategories();
  const byCat = new Map<string, ConfigDef[]>();
  for (const c of cats) byCat.set(c, []);
  for (const d of DEFAULTS) {
    const arr = byCat.get(d.category);
    if (arr) arr.push(d);
  }
  const totalKeys = DEFAULTS.length;

  const sections: string[] = [];
  sections.push('# Admin Configuration Schema');
  sections.push('');
  sections.push(
    `_Generated ${generatedAt} · ${totalKeys} platform default${totalKeys === 1 ? '' : 's'} · ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'}._`,
  );
  sections.push('');
  sections.push(
    'This document is a snapshot of the M13.1 platform configuration schema. ' +
      'Per-tenant overrides are managed via `PUT /v1/admin/config/:key`.',
  );
  sections.push('');

  for (const c of cats) {
    const defs = byCat.get(c) ?? [];
    if (defs.length === 0) continue;
    sections.push(renderCategoryTable(c, defs));
  }

  return sections.join('\n').trimEnd() + '\n';
}
