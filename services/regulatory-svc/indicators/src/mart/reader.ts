// MartReader interface.
//
// The compute service does not talk to Aurora directly — it goes through
// a `MartReader`. We ship two implementations:
//
//   * InMemoryMartReader  — used by tests and local dev. Constructed with
//                           ready-made fixtures.
//   * PostgresMartReader  — skeleton for production. Real SQL is left as a
//                           `// TODO` so we can land + test the service
//                           without a live Aurora.
//
// Both implementations resolve a single (customer_id, snapshot_date) into
// (customer, loans[], txn_features) so the compute fns can run pure.

import { MartCustomer360, MartLoan360, MartTxnFeatures } from '../types';

export interface MartSnapshot {
  customer: MartCustomer360;
  loans: MartLoan360[];
  txn: MartTxnFeatures;
}

export interface MartReader {
  fetchSnapshot(customer_id: string, snapshot_date: string): Promise<MartSnapshot | null>;
  /** Optional bulk-fetch for batch evaluation. */
  fetchSnapshots(
    items: Array<{ customer_id: string; snapshot_date: string }>,
  ): Promise<Array<{ customer_id: string; snapshot_date: string; snapshot: MartSnapshot | null }>>;
}

/** Used in tests and local dev. Holds a map of (customer_id|snapshot_date) → snapshot. */
export class InMemoryMartReader implements MartReader {
  private readonly bucket = new Map<string, MartSnapshot>();

  constructor(snapshots: Array<{ key: string; snapshot: MartSnapshot }> = []) {
    for (const s of snapshots) this.bucket.set(s.key, s.snapshot);
  }

  static keyOf(customer_id: string, snapshot_date: string): string {
    return `${customer_id}|${snapshot_date}`;
  }

  put(customer_id: string, snapshot_date: string, snap: MartSnapshot): void {
    this.bucket.set(InMemoryMartReader.keyOf(customer_id, snapshot_date), snap);
  }

  async fetchSnapshot(customer_id: string, snapshot_date: string): Promise<MartSnapshot | null> {
    return this.bucket.get(InMemoryMartReader.keyOf(customer_id, snapshot_date)) ?? null;
  }

  async fetchSnapshots(
    items: Array<{ customer_id: string; snapshot_date: string }>,
  ): Promise<Array<{ customer_id: string; snapshot_date: string; snapshot: MartSnapshot | null }>> {
    return items.map((i) => ({
      customer_id: i.customer_id,
      snapshot_date: i.snapshot_date,
      snapshot: this.bucket.get(InMemoryMartReader.keyOf(i.customer_id, i.snapshot_date)) ?? null,
    }));
  }
}

/**
 * PostgresMartReader skeleton.
 *
 * In production, this would bind to Aurora PG 16 via `pg` (node-postgres) and
 * run three parameterised queries against `mart.customer_360`, `mart.loan_360`,
 * and `mart.txn_features`. We don't add the dependency now — the live wiring
 * happens when agent-integration provisions a service IRSA + secret. For now
 * `fetchSnapshot` throws so accidental prod use is loud.
 *
 * The method signatures + comments document the exact SQL we expect to run,
 * so agent-integration can wire it in later without code-archaeology.
 */
export class PostgresMartReader implements MartReader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly client: any /* pg.Client | pg.Pool */) {
    // pre-flight — don't crash the service on import; only when used.
  }

  async fetchSnapshot(customer_id: string, snapshot_date: string): Promise<MartSnapshot | null> {
    if (!this.client) {
      throw new Error('PostgresMartReader: no pg client supplied');
    }
    // SQL plan — left as TODO until pg is added to deps.
    //
    //   SELECT * FROM mart.customer_360 WHERE customer_id = $1;
    //   SELECT * FROM mart.loan_360     WHERE customer_id = $1;
    //   SELECT * FROM mart.txn_features WHERE customer_id = $1 AND as_of = $2;
    //
    // The generated TypeScript types live in src/types.ts. Catalog-required
    // columns that aren't yet in the dbt models (e.g. daily_balance,
    // restructure_requests) need agent-data to extend the marts before this
    // path returns useful data — until then it returns the row as-is and
    // compute fns gracefully degrade to value=null when a field is absent.
    void customer_id;
    void snapshot_date;
    throw new Error('PostgresMartReader.fetchSnapshot not implemented (TODO: agent-integration to wire pg client)');
  }

  async fetchSnapshots(
    items: Array<{ customer_id: string; snapshot_date: string }>,
  ): Promise<Array<{ customer_id: string; snapshot_date: string; snapshot: MartSnapshot | null }>> {
    return Promise.all(
      items.map(async (i) => ({
        customer_id: i.customer_id,
        snapshot_date: i.snapshot_date,
        snapshot: await this.fetchSnapshot(i.customer_id, i.snapshot_date),
      })),
    );
  }
}
