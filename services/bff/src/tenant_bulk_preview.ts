// services/bff/src/tenant_bulk_preview.ts
//
// T6 M2.4 — Staged bulk-import preview + apply.
//
// M2.3 ships POST /v1/tenants/bulk-import with dry_run mode that
// already returns per-row outcomes. Operators using the SPA
// preview UI need stronger semantics, though: the rows the
// operator approves on screen MUST be exactly the rows that get
// committed, even if the source CSV file changed between the
// preview screen and the apply click.
//
// Design:
//  - POST /preview parses + dry-runs, then snapshots the parsed
//    rows + the dry-run summary into a per-tenant preview store
//    keyed by a freshly minted `preview_id` with a 10-minute TTL.
//  - POST /apply takes that preview_id, looks up the snapshot,
//    runs `applyBulkTenants` against the EXACT same rows in
//    non-dry-run mode, and marks the preview consumed.
//  - DELETE cancels an active preview.
//  - GET lists active previews for the tenant.
//  - Cap 5 concurrent previews per tenant — operators only need
//    one at a time; the cap is paranoia against UI bugs leaking
//    previews.
//
// Preview lifecycle states: 'pending' → 'consumed' | 'expired' |
// 'cancelled'. Consumed and cancelled previews are kept around
// briefly for audit before the cleaner sweeps them out.

import { randomUUID, createHash } from 'node:crypto';
import {
  type BulkImportResult,
  type BulkRowInput,
  TenantBulkError,
  applyBulkTenants,
  parseTenantCsv,
} from './tenant_bulk';
import { type TenantLookup } from './tenant';

// ─── Public types ─────────────────────────────────────────────────────

export type PreviewStatus = 'pending' | 'consumed' | 'expired' | 'cancelled';

export interface BulkImportPreview {
  preview_id: string;
  tenant_id: string;
  /** Operator who created the preview. */
  created_by: string;
  created_at: string;
  expires_at: string;
  status: PreviewStatus;
  /** SHA-256 of the parsed CSV content; lets the SPA detect when
   *  a stale preview was generated from a different file. */
  csv_sha256: string;
  rows: BulkRowInput[];
  summary: BulkImportResult;
  /** Stamped on consumed/cancelled. */
  resolved_at: string | null;
}

export class PreviewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PreviewError';
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const CAP_PER_TENANT = 5;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Returns `expired` when `now >= expires_at` AND status is still
 *  pending; otherwise the existing status is returned unchanged. */
export function effectiveStatus(p: BulkImportPreview, now: Date): PreviewStatus {
  if (p.status !== 'pending') return p.status;
  return now.getTime() >= new Date(p.expires_at).getTime() ? 'expired' : 'pending';
}

// ─── Store ────────────────────────────────────────────────────────────

export interface BulkImportPreviewStore {
  list(tenant_id: string, now: Date): BulkImportPreview[];
  get(tenant_id: string, preview_id: string, now: Date): BulkImportPreview | null;
  /** Create + persist a NEW preview. Caller has already produced
   *  the dry-run `summary`; the store just snapshots it. */
  put(input: {
    tenant_id: string;
    csv: string;
    rows: BulkRowInput[];
    summary: BulkImportResult;
    created_by: string;
    now: Date;
  }): BulkImportPreview;
  /** Mark a preview consumed. Idempotent: re-consuming throws. */
  consume(tenant_id: string, preview_id: string, now: Date): BulkImportPreview;
  cancel(tenant_id: string, preview_id: string, now: Date): BulkImportPreview;
}

export class InMemoryBulkImportPreviewStore implements BulkImportPreviewStore {
  private readonly perTenant = new Map<string, BulkImportPreview[]>();

  private bucket(tenant_id: string): BulkImportPreview[] {
    let arr = this.perTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.perTenant.set(tenant_id, arr);
    }
    return arr;
  }

  list(tenant_id: string, now: Date): BulkImportPreview[] {
    const arr = this.perTenant.get(tenant_id) ?? [];
    return arr.map((p) => ({ ...p, status: effectiveStatus(p, now) }));
  }

  get(tenant_id: string, preview_id: string, now: Date): BulkImportPreview | null {
    const p = this.perTenant.get(tenant_id)?.find((x) => x.preview_id === preview_id);
    if (!p) return null;
    return { ...p, status: effectiveStatus(p, now) };
  }

  put(input: {
    tenant_id: string;
    csv: string;
    rows: BulkRowInput[];
    summary: BulkImportResult;
    created_by: string;
    now: Date;
  }): BulkImportPreview {
    if (!input.created_by || !input.created_by.trim()) {
      throw new PreviewError('invalid_input', 'created_by required');
    }
    const arr = this.bucket(input.tenant_id);
    // Count only *active* previews against the cap; consumed/cancelled
    // sit around purely for audit and shouldn't block new previews.
    const activeCount = arr.filter(
      (p) => effectiveStatus(p, input.now) === 'pending',
    ).length;
    if (activeCount >= CAP_PER_TENANT) {
      throw new PreviewError(
        'cap_reached',
        `tenant ${input.tenant_id} already has ${CAP_PER_TENANT} active previews — cancel one first`,
      );
    }
    const created_at = input.now.toISOString();
    const expires_at = new Date(input.now.getTime() + TTL_MS).toISOString();
    const preview: BulkImportPreview = {
      preview_id: `prv-${randomUUID()}`,
      tenant_id: input.tenant_id,
      created_by: input.created_by.trim(),
      created_at,
      expires_at,
      status: 'pending',
      csv_sha256: sha256Hex(input.csv),
      rows: input.rows.map((r) => ({ ...r, channels_allowed: [...r.channels_allowed] })),
      summary: input.summary,
      resolved_at: null,
    };
    arr.push(preview);
    return { ...preview, rows: preview.rows.map((r) => ({ ...r, channels_allowed: [...r.channels_allowed] })) };
  }

  consume(tenant_id: string, preview_id: string, now: Date): BulkImportPreview {
    const arr = this.bucket(tenant_id);
    const idx = arr.findIndex((p) => p.preview_id === preview_id);
    if (idx < 0) {
      throw new PreviewError('unknown_preview', `preview ${preview_id} not found`);
    }
    const cur = arr[idx]!;
    const eff = effectiveStatus(cur, now);
    if (eff !== 'pending') {
      throw new PreviewError(
        eff === 'expired' ? 'preview_expired' : 'preview_not_pending',
        `preview ${preview_id} is ${eff}`,
      );
    }
    const updated: BulkImportPreview = {
      ...cur,
      status: 'consumed',
      resolved_at: now.toISOString(),
    };
    arr[idx] = updated;
    return { ...updated, rows: updated.rows.map((r) => ({ ...r, channels_allowed: [...r.channels_allowed] })) };
  }

  cancel(tenant_id: string, preview_id: string, now: Date): BulkImportPreview {
    const arr = this.bucket(tenant_id);
    const idx = arr.findIndex((p) => p.preview_id === preview_id);
    if (idx < 0) {
      throw new PreviewError('unknown_preview', `preview ${preview_id} not found`);
    }
    const cur = arr[idx]!;
    const eff = effectiveStatus(cur, now);
    if (eff !== 'pending') {
      throw new PreviewError(
        'preview_not_pending',
        `preview ${preview_id} is already ${eff} — cannot cancel`,
      );
    }
    const updated: BulkImportPreview = {
      ...cur,
      status: 'cancelled',
      resolved_at: now.toISOString(),
    };
    arr[idx] = updated;
    return { ...updated, rows: updated.rows.map((r) => ({ ...r, channels_allowed: [...r.channels_allowed] })) };
  }
}

export const defaultBulkImportPreviewStore: BulkImportPreviewStore =
  new InMemoryBulkImportPreviewStore();

// ─── High-level entry points ─────────────────────────────────────────

/**
 * Pure-function preview pipeline. Parses the CSV, runs the M2.3
 * dry-run, snapshots both into the store, and returns the new
 * preview record. Throws TenantBulkError on parse failure (caller
 * maps to EWS_400_invalid_input).
 */
export async function createBulkImportPreview(
  store: BulkImportPreviewStore,
  lookup: TenantLookup,
  args: { tenant_id: string; csv: string; created_by: string; now: Date },
): Promise<BulkImportPreview> {
  if (typeof args.csv !== 'string') {
    throw new TenantBulkError('invalid_input', 'csv body required');
  }
  const rows = parseTenantCsv(args.csv);
  const summary = await applyBulkTenants(rows, lookup, { dry_run: true });
  return store.put({
    tenant_id: args.tenant_id,
    csv: args.csv,
    rows,
    summary,
    created_by: args.created_by,
    now: args.now,
  });
}

/**
 * Pure-function apply pipeline. Marks the preview consumed and
 * runs `applyBulkTenants` (dry_run=false) against the snapshotted
 * rows. The preview's stored summary is from the dry run; the
 * apply returns a fresh summary with the actual create outcomes.
 */
export async function applyBulkImportPreview(
  store: BulkImportPreviewStore,
  lookup: TenantLookup,
  args: { tenant_id: string; preview_id: string; now: Date },
): Promise<{ preview: BulkImportPreview; result: BulkImportResult }> {
  const preview = store.consume(args.tenant_id, args.preview_id, args.now);
  const result = await applyBulkTenants(preview.rows, lookup, { dry_run: false });
  return { preview, result };
}
