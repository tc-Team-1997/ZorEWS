// services/bff/src/tenant_bulk.ts
//
// T6 M2.3 — Bulk-tenant CSV onboarding.
//
// M2.1 ships the readiness check; M2.2 ships the onboarding wizard.
// M2.3 ships CSV-driven bulk creation of tenants for BIL multi-
// branch rollouts (one row per tenant). Outputs a per-row result
// (created | error_code | reason).
//
// CSV expected columns (header required):
//   tenant_id,name,vertical,channels_allowed
//
// channels_allowed is `;`-separated (CSV cells can't carry commas).

import { type TenantLookup } from './tenant';

export interface BulkRowInput {
  tenant_id: string;
  name: string;
  vertical: 'banking' | 'insurance';
  channels_allowed: string[];
}

export type BulkRowOutcome =
  | { row: number; status: 'created'; tenant_id: string }
  | { row: number; status: 'skipped'; tenant_id: string; reason: string }
  | { row: number; status: 'error'; tenant_id: string | null; reason: string };

export interface BulkImportResult {
  total: number;
  created: number;
  skipped: number;
  errored: number;
  rows: BulkRowOutcome[];
  dry_run: boolean;
}

export class TenantBulkError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TenantBulkError';
  }
}

// ─── CSV parser ───────────────────────────────────────────────────────

/** Minimal CSV — no embedded quotes, no escapes; production swap is
 *  a real csv-parse adapter. Rejects rows with the wrong column count. */
export function parseTenantCsv(csv: string): BulkRowInput[] {
  if (typeof csv !== 'string' || !csv.trim()) {
    throw new TenantBulkError('invalid_input', 'csv body is required');
  }
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new TenantBulkError('invalid_input', 'csv has no rows');
  }
  const header = lines[0]!.split(',').map((h) => h.trim());
  const expected = ['tenant_id', 'name', 'vertical', 'channels_allowed'];
  if (header.length !== expected.length || !expected.every((e, i) => header[i] === e)) {
    throw new TenantBulkError(
      'invalid_input',
      `csv header must be: ${expected.join(',')}`,
    );
  }
  const rows: BulkRowInput[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(',').map((c) => c.trim());
    if (cells.length !== expected.length) {
      throw new TenantBulkError(
        'invalid_input',
        `row ${i + 1}: expected ${expected.length} columns, got ${cells.length}`,
      );
    }
    const [tenant_id, name, vertical, channelsRaw] = cells;
    if (!tenant_id || !name) {
      throw new TenantBulkError(
        'invalid_input',
        `row ${i + 1}: tenant_id and name are required`,
      );
    }
    if (vertical !== 'banking' && vertical !== 'insurance') {
      throw new TenantBulkError(
        'invalid_input',
        `row ${i + 1}: vertical must be banking|insurance`,
      );
    }
    const channels_allowed = channelsRaw!
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (channels_allowed.length === 0) {
      throw new TenantBulkError(
        'invalid_input',
        `row ${i + 1}: channels_allowed must contain at least one entry`,
      );
    }
    rows.push({ tenant_id, name, vertical, channels_allowed });
  }
  return rows;
}

// ─── Apply ────────────────────────────────────────────────────────────

export interface BulkApplyOpts {
  dry_run: boolean;
  /** Cap on rows. Defaults to 100. */
  max_rows?: number;
}

export async function applyBulkTenants(
  rows: BulkRowInput[],
  lookup: TenantLookup,
  opts: BulkApplyOpts,
): Promise<BulkImportResult> {
  const cap = opts.max_rows ?? 100;
  if (rows.length > cap) {
    throw new TenantBulkError('invalid_input', `too many rows (max ${cap})`);
  }
  const seenIds = new Set<string>();
  const outcomes: BulkRowOutcome[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const rowNumber = i + 2; // +2 to account for header + 1-based
    if (seenIds.has(r.tenant_id)) {
      outcomes.push({
        row: rowNumber,
        status: 'error',
        tenant_id: r.tenant_id,
        reason: 'duplicate_in_csv',
      });
      continue;
    }
    seenIds.add(r.tenant_id);

    const existing = await lookup(r.tenant_id);
    if (existing) {
      outcomes.push({
        row: rowNumber,
        status: 'skipped',
        tenant_id: r.tenant_id,
        reason: 'tenant_exists',
      });
      continue;
    }

    if (opts.dry_run) {
      outcomes.push({
        row: rowNumber,
        status: 'created',
        tenant_id: r.tenant_id,
      });
      continue;
    }

    if (typeof lookup.create !== 'function') {
      outcomes.push({
        row: rowNumber,
        status: 'error',
        tenant_id: r.tenant_id,
        reason: 'lookup_does_not_support_create',
      });
      continue;
    }

    try {
      await lookup.create({
        tenant_id: r.tenant_id,
        name: r.name,
        vertical: r.vertical,
        channels_allowed: r.channels_allowed,
      });
      outcomes.push({
        row: rowNumber,
        status: 'created',
        tenant_id: r.tenant_id,
      });
    } catch (e) {
      outcomes.push({
        row: rowNumber,
        status: 'error',
        tenant_id: r.tenant_id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    total: rows.length,
    created: outcomes.filter((o) => o.status === 'created').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    errored: outcomes.filter((o) => o.status === 'error').length,
    rows: outcomes,
    dry_run: opts.dry_run,
  };
}
