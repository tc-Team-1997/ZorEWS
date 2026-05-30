// services/bff/src/governance/branch_store.ts
//
// Branch registry — in-memory implementation matching 051 schema.
// Tenant-scoped reads; UNIQUE(tenant_id, code) enforced.

import {
  GovernanceError,
  type Branch,
  type BranchInput,
  type BranchPatch,
} from './types';

export interface ListBranchesFilter {
  tenant_id?: string;
  country_code?: string;
  active_only?: boolean;
}

export interface IBranchStore {
  list(filter?: ListBranchesFilter): Branch[];
  get(branch_id: string): Branch | null;
  byTenantAndCode(tenant_id: string, code: string): Branch | null;
  create(input: BranchInput, now: Date): Branch;
  update(branch_id: string, patch: BranchPatch, now: Date): Branch;
  delete(branch_id: string): boolean;
}

function validateInput(input: BranchInput): void {
  if (!input || typeof input !== 'object') throw new GovernanceError('invalid_input');
  if (!input.tenant_id?.trim()) throw new GovernanceError('invalid_tenant');
  if (!input.country_code?.trim()) throw new GovernanceError('invalid_country');
  if (!input.code?.trim() || input.code.length > 32) throw new GovernanceError('invalid_input');
  if (!input.name?.trim() || input.name.length > 200) throw new GovernanceError('invalid_input');
}

function nextBranchId(seq: number): string {
  return `br-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export class InMemoryBranchStore implements IBranchStore {
  private readonly rows = new Map<string, Branch>();
  private seq = 0;

  constructor(seed?: Iterable<Branch>) {
    if (seed) for (const b of seed) this.rows.set(b.branch_id, b);
  }

  list(filter: ListBranchesFilter = {}): Branch[] {
    let out = Array.from(this.rows.values());
    if (filter.tenant_id) out = out.filter((b) => b.tenant_id === filter.tenant_id);
    if (filter.country_code) out = out.filter((b) => b.country_code === filter.country_code);
    if (filter.active_only) out = out.filter((b) => b.active);
    // Stable sort: tenant_id, then code asc.
    out.sort((a, b) => {
      if (a.tenant_id !== b.tenant_id) return a.tenant_id < b.tenant_id ? -1 : 1;
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    });
    return out.map((b) => ({ ...b }));
  }

  get(branch_id: string): Branch | null {
    const b = this.rows.get(branch_id);
    return b ? { ...b } : null;
  }

  byTenantAndCode(tenant_id: string, code: string): Branch | null {
    for (const b of this.rows.values()) {
      if (b.tenant_id === tenant_id && b.code === code) return { ...b };
    }
    return null;
  }

  create(input: BranchInput, now: Date): Branch {
    validateInput(input);
    if (this.byTenantAndCode(input.tenant_id, input.code)) {
      throw new GovernanceError('duplicate_branch_code');
    }
    this.seq += 1;
    const branch: Branch = {
      branch_id: nextBranchId(this.seq),
      tenant_id: input.tenant_id,
      country_code: input.country_code,
      code: input.code,
      name: input.name,
      city: input.city ?? null,
      state: input.state ?? null,
      address: input.address ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      manager_user: input.manager_user ?? null,
      active: input.active ?? true,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.rows.set(branch.branch_id, branch);
    return { ...branch };
  }

  update(branch_id: string, patch: BranchPatch, now: Date): Branch {
    const existing = this.rows.get(branch_id);
    if (!existing) throw new GovernanceError('unknown_branch');
    if (!patch || typeof patch !== 'object') throw new GovernanceError('invalid_input');
    if (patch.code !== undefined) {
      if (!patch.code.trim() || patch.code.length > 32) throw new GovernanceError('invalid_input');
      const dup = this.byTenantAndCode(existing.tenant_id, patch.code);
      if (dup && dup.branch_id !== branch_id) throw new GovernanceError('duplicate_branch_code');
    }
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 200)) {
      throw new GovernanceError('invalid_input');
    }
    const next: Branch = {
      ...existing,
      ...(patch.code !== undefined ? { code: patch.code } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.city !== undefined ? { city: patch.city } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.address !== undefined ? { address: patch.address } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.manager_user !== undefined ? { manager_user: patch.manager_user } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updated_at: now.toISOString(),
    };
    this.rows.set(branch_id, next);
    return { ...next };
  }

  delete(branch_id: string): boolean {
    return this.rows.delete(branch_id);
  }
}

/** Seed mirrors data/schema/051 — 11 branches across 7 tenants. */
export function buildDefaultBranchSeed(now: Date): Branch[] {
  const ts = now.toISOString();
  const rows: Omit<Branch, 'created_at' | 'updated_at'>[] = [
    { branch_id: 'br-hdfc-mumbai-fort',   tenant_id: 'HDFC_BANK',     country_code: 'IN', code: 'HDFC001', name: 'HDFC Bank Fort Branch',       city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-hdfc-delhi-cp',      tenant_id: 'HDFC_BANK',     country_code: 'IN', code: 'HDFC002', name: 'HDFC Bank Connaught Place',   city: 'Delhi',    state: 'Delhi',       address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-hdfc-bengaluru-mg',  tenant_id: 'HDFC_BANK',     country_code: 'IN', code: 'HDFC003', name: 'HDFC Bank MG Road',           city: 'Bengaluru',state: 'Karnataka',   address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-icici-mumbai-bkc',   tenant_id: 'ICICI_BANK',    country_code: 'IN', code: 'ICIC001', name: 'ICICI Bank BKC',              city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-icici-pune-baner',   tenant_id: 'ICICI_BANK',    country_code: 'IN', code: 'ICIC002', name: 'ICICI Bank Baner',            city: 'Pune',     state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-sbi-mumbai-main',    tenant_id: 'SBI',           country_code: 'IN', code: 'SBI001',  name: 'State Bank of India Main',    city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-sbi-chennai-anna',   tenant_id: 'SBI',           country_code: 'IN', code: 'SBI002',  name: 'SBI Anna Salai',              city: 'Chennai',  state: 'Tamil Nadu',  address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-hdfcergo-mumbai-hq', tenant_id: 'HDFC_ERGO',     country_code: 'IN', code: 'HERGO01', name: 'HDFC ERGO Mumbai HQ',         city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-icicilom-mumbai-hq', tenant_id: 'ICICI_LOMBARD', country_code: 'IN', code: 'ILOM001', name: 'ICICI Lombard Mumbai HQ',     city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-bank-demo-main',     tenant_id: 'BANK_DEMO',     country_code: 'IN', code: 'DEMO001', name: 'APEX Demo Bank — Main',       city: 'Mumbai',   state: 'Maharashtra', address: null, phone: null, email: null, manager_user: null, active: true },
    { branch_id: 'br-bil-thimphu',        tenant_id: 'BIL',           country_code: 'BT', code: 'BIL001',  name: 'BIL Thimphu Head Office',     city: 'Thimphu',  state: 'Thimphu',     address: null, phone: null, email: null, manager_user: null, active: true },
  ];
  return rows.map((r) => ({ ...r, created_at: ts, updated_at: ts }));
}

let _default: InMemoryBranchStore | undefined;
export function defaultBranchStore(): InMemoryBranchStore {
  if (!_default) _default = new InMemoryBranchStore(buildDefaultBranchSeed(new Date()));
  return _default;
}
export function _resetDefaultBranchStore(): void {
  _default = undefined;
}
