// services/bff/src/customer_watchlist.ts
//
// T6 M4.7 — Customer watchlist + scan.
//
// Closes the loop on M4.5 / M4.6: analysts identify a customer
// worth tracking (manually flagged, or surfaced by an earlier
// breach scan), drop them on the watchlist with a reason, and
// then re-scan the watchlist on demand to see how every flagged
// customer is trending today.
//
// Design:
//  - Per-tenant cap of 50 — same posture as M16.4 custom presets
//    and M3.3 schema overrides.
//  - Duplicate adds surface as `EWS_409_already_watched` (caller's
//    PATCH-the-reason intent should use DELETE+POST or a future
//    update route).
//  - The scan route delegates to M4.6 `scanCustomerBreachesBulk`
//    — no new scan logic. Empty watchlist → empty result envelope
//    rather than 4xx, since "I have no one to watch" is a valid
//    state for a freshly-onboarded tenant.

import {
  type ScoringVertical,
  isScoringVertical,
} from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

export interface WatchedCustomerInput {
  customer_id: string;
  reason: string;
  vertical?: ScoringVertical;
}

export interface WatchedCustomer {
  customer_id: string;
  tenant_id: string;
  reason: string;
  vertical: ScoringVertical | null;
  added_by: string;
  added_at: string;
}

export class WatchlistError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WatchlistError';
  }
}

const CAP_PER_TENANT = 50;
const REASON_CAP = 200;
const CUSTOMER_ID_CAP = 64;

// ─── Validation ───────────────────────────────────────────────────────

function validate(input: unknown): WatchedCustomerInput {
  if (!input || typeof input !== 'object') {
    throw new WatchlistError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.customer_id !== 'string' || !i.customer_id.trim()) {
    throw new WatchlistError('invalid_input', 'customer_id is required');
  }
  if (i.customer_id.length > CUSTOMER_ID_CAP) {
    throw new WatchlistError(
      'invalid_input',
      `customer_id ≤ ${CUSTOMER_ID_CAP} chars`,
    );
  }
  if (typeof i.reason !== 'string' || !i.reason.trim()) {
    throw new WatchlistError('invalid_input', 'reason is required');
  }
  if (i.reason.length > REASON_CAP) {
    throw new WatchlistError('invalid_input', `reason ≤ ${REASON_CAP} chars`);
  }
  if (i.vertical !== undefined && !isScoringVertical(i.vertical)) {
    throw new WatchlistError(
      'invalid_input',
      "vertical must be 'banking' or 'insurance'",
    );
  }
  return {
    customer_id: i.customer_id.trim(),
    reason: i.reason.trim(),
    vertical: i.vertical as ScoringVertical | undefined,
  };
}

// ─── Store ────────────────────────────────────────────────────────────

export interface WatchlistStore {
  list(tenant_id: string): WatchedCustomer[];
  has(tenant_id: string, customer_id: string): boolean;
  add(
    tenant_id: string,
    input: unknown,
    added_by: string,
    now: Date,
  ): WatchedCustomer;
  remove(tenant_id: string, customer_id: string): boolean;
}

export class InMemoryWatchlistStore implements WatchlistStore {
  private readonly perTenant = new Map<string, WatchedCustomer[]>();

  list(tenant_id: string): WatchedCustomer[] {
    return [...(this.perTenant.get(tenant_id) ?? [])];
  }

  has(tenant_id: string, customer_id: string): boolean {
    return !!this.perTenant.get(tenant_id)?.some((c) => c.customer_id === customer_id);
  }

  add(
    tenant_id: string,
    input: unknown,
    added_by: string,
    now: Date,
  ): WatchedCustomer {
    if (!added_by || !added_by.trim()) {
      throw new WatchlistError('invalid_input', 'added_by required');
    }
    const valid = validate(input);
    const arr = this.perTenant.get(tenant_id) ?? [];
    if (arr.some((c) => c.customer_id === valid.customer_id)) {
      throw new WatchlistError(
        'already_watched',
        `customer ${valid.customer_id} is already on the watchlist`,
      );
    }
    if (arr.length >= CAP_PER_TENANT) {
      throw new WatchlistError(
        'cap_reached',
        `tenant ${tenant_id} watchlist is full (cap ${CAP_PER_TENANT})`,
      );
    }
    const entry: WatchedCustomer = {
      customer_id: valid.customer_id,
      tenant_id,
      reason: valid.reason,
      vertical: valid.vertical ?? null,
      added_by: added_by.trim(),
      added_at: now.toISOString(),
    };
    arr.push(entry);
    this.perTenant.set(tenant_id, arr);
    return entry;
  }

  remove(tenant_id: string, customer_id: string): boolean {
    const arr = this.perTenant.get(tenant_id);
    if (!arr) return false;
    const idx = arr.findIndex((c) => c.customer_id === customer_id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return true;
  }
}

export const defaultWatchlistStore: WatchlistStore = new InMemoryWatchlistStore();
