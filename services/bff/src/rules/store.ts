// services/bff/src/rules/store.ts
//
// In-memory rule store. Real impl would proxy to regulatory-svc/rules
// (which already has draft/simulate/live/retired persistence). For the
// prototype this is enough — and tests can swap in `new RuleStore([])`
// for a clean slate.

import { SEED_RULES } from './seed';
import type { RuleProduct, RuleState, RuleV2 } from './types';

export class RuleStore {
  private byId = new Map<string, RuleV2>();

  constructor(seed: RuleV2[] = SEED_RULES) {
    for (const r of seed) this.byId.set(r.id, deepClone(r));
  }

  list(filters: { state?: RuleState; product?: RuleProduct } = {}): RuleV2[] {
    return Array.from(this.byId.values())
      .filter((r) => !filters.state || r.state === filters.state)
      .filter(
        (r) =>
          !filters.product ||
          r.applicable_products.length === 0 ||
          r.applicable_products.includes(filters.product),
      )
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  get(id: string): RuleV2 | undefined {
    const r = this.byId.get(id);
    return r ? deepClone(r) : undefined;
  }

  upsert(rule: RuleV2): void {
    this.byId.set(rule.id, deepClone(rule));
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Module-level singleton so /v1/rules/* shares state across requests. */
export const defaultStore = new RuleStore();
