// services/auth-svc/src/service_clients.ts
//
// OAuth client-credentials principals (T4.24, Banking API doc §7).
//
// Two demo clients are seeded so the prototype can demonstrate the full
// flow without a database round-trip:
//   apex-mobile-bank-demo   / secret: "demo-secret-bank"  / tenant: BANK_DEMO
//   bil-los-stub            / secret: "demo-secret-bil"   / tenant: BIL
//
// Production wiring (Postgres `app_iam.service_clients`) is left to a
// follow-up — the interface below isolates the storage so swapping in a
// pg implementation is a one-file change.

import argon2 from "argon2";

export interface ServiceClient {
  client_id: string;
  tenant_id: string;
  display_name: string;
  scopes: string[];
  client_secret_hash: string;
  active: boolean;
}

export interface IServiceClientStore {
  /**
   * Look up by composite (tenant_id, client_id). Returns undefined when
   * the client is unknown or marked inactive.
   */
  find(tenantId: string, clientId: string): ServiceClient | undefined;
  /**
   * Verify the bcrypt/argon2 secret. Constant-time-ish — performs the
   * hash comparison even when the client doesn't exist (the caller still
   * shouldn't reveal which leg failed; we return false either way).
   */
  verifySecret(client: ServiceClient, secret: string): Promise<boolean>;
}

class InMemoryServiceClientStore implements IServiceClientStore {
  private clients = new Map<string, ServiceClient>();

  add(c: ServiceClient): void {
    this.clients.set(this.key(c.tenant_id, c.client_id), c);
  }

  find(tenantId: string, clientId: string): ServiceClient | undefined {
    const c = this.clients.get(this.key(tenantId, clientId));
    return c?.active ? c : undefined;
  }

  async verifySecret(client: ServiceClient, secret: string): Promise<boolean> {
    return argon2.verify(client.client_secret_hash, secret);
  }

  private key(tenantId: string, clientId: string): string {
    return `${tenantId}::${clientId}`;
  }
}

let cached: IServiceClientStore | undefined;

/**
 * Returns the lazy-initialised demo store. Tests can inject a custom store
 * via `__setServiceClientStoreForTests` to bypass the seed.
 */
export async function getServiceClientStore(): Promise<IServiceClientStore> {
  if (cached) return cached;
  const store = new InMemoryServiceClientStore();
  // Hash the seed secrets at boot so verifySecret runs the real path.
  const bankHash = await argon2.hash("demo-secret-bank", { type: argon2.argon2id });
  const bilHash = await argon2.hash("demo-secret-bil", { type: argon2.argon2id });
  store.add({
    client_id: "apex-mobile-bank-demo",
    tenant_id: "BANK_DEMO",
    display_name: "APEX Mobile (BANK_DEMO)",
    scopes: [],
    client_secret_hash: bankHash,
    active: true,
  });
  store.add({
    client_id: "bil-los-stub",
    tenant_id: "BIL",
    display_name: "BIL LOS stub (BIL)",
    scopes: [],
    client_secret_hash: bilHash,
    active: true,
  });
  cached = store;
  return cached;
}

/** Test helper — drop the cached store so the next getServiceClientStore() rehydrates. */
export function __resetServiceClientStoreForTests(): void {
  cached = undefined;
}

/** Test helper — inject a fully-built store (skips seeding). */
export function __setServiceClientStoreForTests(s: IServiceClientStore): void {
  cached = s;
}
