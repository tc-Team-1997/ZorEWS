// services/bff/src/tenant_comparison_matrix.ts
// T6 M2.27 — Tenant comparison matrix (BIL vs BANK_DEMO).
// Compares config overrides across the 2 known tenants key by key.

import { type ConfigStore, listCategories, type ConfigCategory } from './admin_config';

export interface ComparisonKey {
  key: string;
  category: ConfigCategory;
  bank_demo_value: unknown;
  bil_value: unknown;
  same: boolean;
}

export interface TenantComparisonMatrixResult {
  generated_at: string;
  total_keys: number;
  same_count: number;
  different_count: number;
  keys: ComparisonKey[];
  most_divergent_category: ConfigCategory | null;
}

export function buildTenantComparisonMatrix(
  configStore: ConfigStore,
  now: Date,
): TenantComparisonMatrixResult {
  const bankEntries = configStore.list('BANK_DEMO');
  const bilEntries = configStore.list('BIL');

  const bilByKey = new Map(bilEntries.map((e) => [e.key, e]));

  const diffCounts = new Map<ConfigCategory, number>();

  const keys: ComparisonKey[] = bankEntries.map((bankEntry) => {
    const bilEntry = bilByKey.get(bankEntry.key);
    const bankVal = bankEntry.value;
    const bilVal = bilEntry?.value ?? bankEntry.default_value;

    const sameVal = JSON.stringify(bankVal) === JSON.stringify(bilVal);

    if (!sameVal) {
      const cat = bankEntry.category;
      diffCounts.set(cat, (diffCounts.get(cat) ?? 0) + 1);
    }

    return {
      key: bankEntry.key,
      category: bankEntry.category,
      bank_demo_value: bankVal,
      bil_value: bilVal,
      same: sameVal,
    };
  });

  const sameCount = keys.filter((k) => k.same).length;
  const differentCount = keys.length - sameCount;

  let mostDivergentCategory: ConfigCategory | null = null;
  let maxDiff = 0;
  for (const [cat, count] of diffCounts) {
    if (count > maxDiff || (count === maxDiff && cat < (mostDivergentCategory ?? 'zzz'))) {
      maxDiff = count;
      mostDivergentCategory = cat;
    }
  }
  if (differentCount === 0) mostDivergentCategory = null;

  return {
    generated_at: now.toISOString(),
    total_keys: keys.length,
    same_count: sameCount,
    different_count: differentCount,
    keys,
    most_divergent_category: mostDivergentCategory,
  };
}
