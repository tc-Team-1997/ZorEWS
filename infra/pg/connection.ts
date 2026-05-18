// Centralised Postgres connection helper for ZorEWS services.
//
// This is OPT-IN. Existing services keep their per-store `new Pool(...)`
// calls (21 of them, see the audit doc) untouched — this helper is for
// NEW code or refactors that want a single source of truth for:
//   - Resolving the connection string from env vars with a documented fallback chain
//   - Logging which database+host:port+user the service connected to
//   - Pinging the pool on startup so misconfig fails fast (instead of on first request)
//
// Architecture note: ZorEWS does NOT use an ORM. Tables are defined in
// raw SQL migrations under data/schema/. Each Pg<Thing>Store class owns
// its own pg.Pool and writes raw SQL. The Pool itself already gives us
// connection pooling — this helper just standardises HOW Pools are built.
//
// Adoption pattern:
//   import { resolvePgConfig, makePool, pingPool } from '../../../infra/pg/connection.js';
//   const cfg = resolvePgConfig({ envVars: ['BFF_PG_URL', 'AUTH_PG_URL'] });
//   if (!cfg) return new InMemoryStore();   // env-var unset → fall back
//   const pool = makePool(cfg, { max: 4, logger: console });
//   await pingPool(pool, cfg);              // SELECT 1; throws on failure

import { Pool, PoolConfig } from 'pg';

export interface PgConfig {
  /** Full libpq connection string */
  connection_string: string;
  /** Parsed host (for logging only) */
  host: string;
  /** Parsed port (for logging only) */
  port: number;
  /** Parsed database (for logging only) */
  database: string;
  /** Parsed user (for logging only — never log password) */
  user: string;
  /** Which env var was resolved (for logging) */
  source_env_var: string;
}

export interface ResolveOptions {
  /** Ordered list of env vars to check. First non-empty wins. */
  envVars: string[];
  /** Fallback DSN if no env var is set (typically only used for tests) */
  fallback?: string;
}

export interface MakePoolOptions {
  /** Max pool size. Default 4 (matches existing service convention). */
  max?: number;
  /** ms before idle clients are evicted. Default 30000. */
  idleTimeoutMillis?: number;
  /** ms before a query times out. Default 10000. */
  statement_timeout?: number;
  /** Logger (must have .info() and .error()). Defaults to console. */
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
  /** Tag that appears in pg_stat_activity.application_name. Helps debugging. */
  application_name?: string;
}

/**
 * Resolve a Postgres connection config from environment variables.
 *
 * Returns null when no env var is set AND no fallback is given — callers
 * should fall back to their in-memory store (matches existing behaviour
 * of every Pg<Thing>Store in the codebase).
 */
export function resolvePgConfig(opts: ResolveOptions): PgConfig | null {
  for (const ev of opts.envVars) {
    const v = process.env[ev];
    if (v && v.trim().length > 0) {
      return parseDsn(v, ev);
    }
  }
  if (opts.fallback) {
    return parseDsn(opts.fallback, '<fallback>');
  }
  return null;
}

function parseDsn(dsn: string, source: string): PgConfig {
  // Standard postgres://user:pass@host:port/db?params parsing.
  // We DON'T do anything clever — pg.Pool will re-parse this itself.
  // We just extract the human-readable fields for logging.
  const u = new URL(dsn);
  return {
    connection_string: dsn,
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    database: u.pathname.replace(/^\//, ''),
    user: u.username,
    source_env_var: source,
  };
}

/**
 * Build a pg.Pool from a resolved config. Logs the connection
 * destination (without password) so service startup is auditable.
 */
export function makePool(cfg: PgConfig, opts: MakePoolOptions = {}): Pool {
  const max = opts.max ?? 4;
  const log = opts.logger ?? console;
  const application_name = opts.application_name ?? 'zorews-service';

  const poolConfig: PoolConfig = {
    connectionString: cfg.connection_string,
    max,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    application_name,
    // statement_timeout is a server-side parameter; pg.Pool forwards it
    // as a connection option only when explicitly placed in `options`.
    // For simplicity we set it post-connect via a SET statement.
  };

  const pool = new Pool(poolConfig);

  log.info(
    `[pg] pool opened: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database} ` +
      `(max=${max}, source_env=${cfg.source_env_var}, application_name=${application_name})`,
  );

  // Apply statement_timeout per-connection. Cheap and fail-soft.
  if (opts.statement_timeout) {
    pool.on('connect', (client) => {
      client
        .query(`SET statement_timeout = ${Number(opts.statement_timeout)}`)
        .catch((err) => log.error(`[pg] failed to set statement_timeout: ${err.message}`));
    });
  }

  pool.on('error', (err) => {
    // Idle client errors — don't crash the process, just log.
    log.error(`[pg] idle client error: ${err.message}`);
  });

  return pool;
}

/**
 * Ping the pool with `SELECT 1`. Throws on failure — callers should
 * call this once at startup so misconfig surfaces immediately instead
 * of on the first user request.
 */
export async function pingPool(pool: Pool, cfg: PgConfig): Promise<void> {
  const start = Date.now();
  const result = await pool.query('SELECT 1 AS ok, current_user, current_database()');
  const elapsed_ms = Date.now() - start;
  const row = result.rows[0] as { ok: number; current_user: string; current_database: string };
  if (row.ok !== 1 || row.current_database !== cfg.database) {
    throw new Error(
      `[pg] ping failed: expected db=${cfg.database}, got db=${row.current_database}`,
    );
  }
  console.info(`[pg] ping ok: ${row.current_user}@${cfg.host}:${cfg.port}/${row.current_database} (${elapsed_ms}ms)`);
}

/**
 * Verify a list of expected (schema, table) pairs exists in the DB.
 * Returns the list of MISSING tables (empty = all present). Useful as
 * a startup health gate when a service knows which tables it needs.
 */
export async function checkExpectedTables(
  pool: Pool,
  expected: Array<{ schema: string; table: string }>,
): Promise<Array<{ schema: string; table: string }>> {
  if (expected.length === 0) return [];
  const result = await pool.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_schema = ANY($1) AND table_name = ANY($2)`,
    [expected.map((e) => e.schema), expected.map((e) => e.table)],
  );
  const present = new Set(
    result.rows.map((r: { table_schema: string; table_name: string }) => `${r.table_schema}.${r.table_name}`),
  );
  return expected.filter((e) => !present.has(`${e.schema}.${e.table}`));
}
