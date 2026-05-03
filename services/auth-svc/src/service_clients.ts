// services/auth-svc/src/service_clients.ts
//
// OAuth client-credentials principals (T4.24, Banking API doc §7).
//
// Two demo clients are seeded so the prototype can demonstrate the full
// flow without a database round-trip:
//   apex-mobile-bank-demo   / secret: "demo-secret-bank"  / tenant: BANK_DEMO
//   bil-los-stub            / secret: "demo-secret-bil"   / tenant: BIL
//
// Two backing impls share the IServiceClientStore interface:
//   - InMemoryServiceClientStore — the default; hermetic for tests.
//   - PgServiceClientStore        — pg-backed against app_iam.service_clients.
//                                   Hydrates on init (cache-on-init same as
//                                   PgUserStore / PgWebhookSubscriptionStore).
//                                   Selected when AUTH_SVC_PG_URL is set.

import argon2 from "argon2";
import { Pool } from "pg";

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

const SEED_CLIENTS: Array<{
  client_id: string;
  tenant_id: string;
  display_name: string;
  scopes: string[];
  password: string;
}> = [
  {
    client_id: "apex-mobile-bank-demo",
    tenant_id: "BANK_DEMO",
    display_name: "APEX Mobile (BANK_DEMO)",
    scopes: [],
    password: "demo-secret-bank",
  },
  {
    client_id: "bil-los-stub",
    tenant_id: "BIL",
    display_name: "BIL LOS stub (BIL)",
    scopes: [],
    password: "demo-secret-bil",
  },
];

function key(tenantId: string, clientId: string): string {
  return `${tenantId}::${clientId}`;
}

export class InMemoryServiceClientStore implements IServiceClientStore {
  private clients = new Map<string, ServiceClient>();

  add(c: ServiceClient): void {
    this.clients.set(key(c.tenant_id, c.client_id), c);
  }

  find(tenantId: string, clientId: string): ServiceClient | undefined {
    const c = this.clients.get(key(tenantId, clientId));
    return c?.active ? c : undefined;
  }

  async verifySecret(client: ServiceClient, secret: string): Promise<boolean> {
    return argon2.verify(client.client_secret_hash, secret);
  }
}

/**
 * Pg-backed store. Hydrates the in-memory cache from app_iam.service_clients
 * on init (so .find() stays synchronous), and seeds the demo clients on
 * first init (idempotent INSERT … ON CONFLICT DO NOTHING). Reads serve
 * from cache; verifySecret runs the same argon2.verify path as the
 * in-memory store.
 *
 * No write-through path is needed for this prototype — the only writes
 * are the bootstrap seeds. Admin CRUD on service clients lands in a
 * future T4.24 Phase 2 task.
 */
export class PgServiceClientStore implements IServiceClientStore {
  private cache = new Map<string, ServiceClient>();
  private initialised = false;

  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    if (this.initialised) return;
    // 1. Seed demo clients if the table is empty for that tenant.
    for (const seed of SEED_CLIENTS) {
      const hash = await argon2.hash(seed.password, { type: argon2.argon2id });
      await this.pool.query(
        `INSERT INTO app_iam.service_clients
           (client_id, tenant_id, client_secret_hash, display_name, scopes, active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (tenant_id, client_id) DO NOTHING`,
        [seed.client_id, seed.tenant_id, hash, seed.display_name, seed.scopes],
      );
    }
    // 2. Hydrate the cache.
    const r = await this.pool.query<{
      client_id: string;
      tenant_id: string;
      display_name: string;
      scopes: string[];
      client_secret_hash: string;
      active: boolean;
    }>(`SELECT client_id, tenant_id, display_name, scopes, client_secret_hash, active
        FROM app_iam.service_clients
        WHERE active`);
    this.cache.clear();
    for (const row of r.rows) {
      this.cache.set(key(row.tenant_id, row.client_id), {
        client_id: row.client_id,
        tenant_id: row.tenant_id,
        display_name: row.display_name,
        scopes: row.scopes,
        client_secret_hash: row.client_secret_hash,
        active: row.active,
      });
    }
    this.initialised = true;
  }

  find(tenantId: string, clientId: string): ServiceClient | undefined {
    const c = this.cache.get(key(tenantId, clientId));
    return c?.active ? c : undefined;
  }

  async verifySecret(client: ServiceClient, secret: string): Promise<boolean> {
    return argon2.verify(client.client_secret_hash, secret);
  }
}

let cached: IServiceClientStore | undefined;

/**
 * Returns the lazy-initialised store. When `AUTH_SVC_PG_URL` is set,
 * returns a PgServiceClientStore (hydrated + seeded against pg).
 * Otherwise returns an InMemoryServiceClientStore with the demo clients
 * seeded with argon2-hashed passwords.
 *
 * Tests can inject a custom store via `__setServiceClientStoreForTests`.
 */
export async function getServiceClientStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IServiceClientStore> {
  if (cached) return cached;

  const url = env.AUTH_SVC_PG_URL;
  if (url) {
    const pool = new Pool({ connectionString: url, max: 2 });
    const store = new PgServiceClientStore(pool);
    await store.init();
    cached = store;
    return cached;
  }

  const store = new InMemoryServiceClientStore();
  for (const seed of SEED_CLIENTS) {
    const hash = await argon2.hash(seed.password, { type: argon2.argon2id });
    store.add({
      client_id: seed.client_id,
      tenant_id: seed.tenant_id,
      display_name: seed.display_name,
      scopes: seed.scopes,
      client_secret_hash: hash,
      active: true,
    });
  }
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
