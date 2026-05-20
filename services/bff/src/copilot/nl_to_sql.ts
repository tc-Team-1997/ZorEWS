// services/bff/src/copilot/nl_to_sql.ts
//
// T2.9 — NL→SQL Copilot stub.
//
// Stub mode (default): pure pattern-match against a closed set of
// natural-language question templates, returning a SAFE parameterised
// SELECT against the `mart.*` schema with explanation + confidence
// score + intent label + requires_review flag.
//
// Production mode (Year-2): swap `translateNlToSql` for a Claude
// `messages.create` call returning the same shape. The contract is
// designed so the SPA + audit chain don't need to change.
//
// Safety rails the resolver enforces:
//   1. Always `SELECT` — no DDL/DML/DCL.
//   2. Mart tables only (mart.customer_360 / loan_360 / txn_features /
//      indicator_values). No `raw.*` direct access; no `app_*` cross-
//      reads. Tenant-scoped via parameterised `tenant_id =`.
//   3. Parameter bindings returned separately — caller passes them to
//      the DB driver, not string-concat.
//   4. `requires_review` is always TRUE for the stub. Operator MUST
//      eyeball the SQL before running. Production may drop this once
//      LLM confidence is calibrated.
//   5. Hard LIMIT injected on every query (caller-configurable up to
//      MAX_LIMIT).
//
// Pure function — no I/O. Mirrors the M-resolver pattern.

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

// ─── Public types ──────────────────────────────────────────────────────

export type NlToSqlIntent =
  | 'unknown'
  | 'high_risk_customers'
  | 'alerts_by_severity'
  | 'avg_dpd_by_product'
  | 'top_npa_customers'
  | 'indicator_value_lookup'
  | 'customer_count_by_segment'
  | 'loan_portfolio_summary'
  | 'utilization_above_threshold'
  | 'txn_volume_trend'
  | 'alert_count_last_n_days';

export interface NlToSqlInput {
  question: string;
  tenant_id: string;
  /** Defaults to DEFAULT_LIMIT (100); clamped to [1, MAX_LIMIT=1000]. */
  limit?: number;
}

export interface NlToSqlResult {
  intent: NlToSqlIntent;
  sql: string;
  params: Record<string, string | number>;
  /** 0..1 — how confident the stub is the intent matches the question.
   *  Production LLM mode replaces this with a real-confidence score. */
  confidence: number;
  /** Human-readable explanation of what the SQL does. */
  explanation: string;
  /** Always TRUE in stub mode — operator must review. */
  requires_review: boolean;
  /** True when the resolver didn't match any known pattern. */
  fallback: boolean;
}

export class NlToSqlError extends Error {
  constructor(
    public readonly code: 'invalid_input' | 'unsafe_query',
    message: string,
  ) {
    super(message);
    this.name = 'NlToSqlError';
  }
}

// ─── Pattern catalog ───────────────────────────────────────────────────
//
// Each entry: regex pattern that matches the question + the SQL template
// + a confidence score + an explanation builder.

interface PatternEntry {
  intent: NlToSqlIntent;
  patterns: RegExp[];
  /** Returns SQL + params + explanation tailored to the match. */
  resolve: (
    matches: RegExpMatchArray[],
    tenant_id: string,
    limit: number,
  ) => Pick<NlToSqlResult, 'sql' | 'params' | 'explanation'>;
  confidence: number;
}

const CATALOG: PatternEntry[] = [
  // ── high_risk_customers ───────────────────────────────────────────
  {
    intent: 'high_risk_customers',
    patterns: [
      /\b(high[ -]?risk|risky)\s+customers?\b/i,
      /\bcustomers?\s+(at|with)\s+(high\s+)?risk\b/i,
      /\bwho.+(risk|risky)\b/i,
    ],
    confidence: 0.85,
    resolve: (_, tenant, limit) => ({
      sql: `SELECT customer_id, name, risk_level, pd_score, utilization, dpd_max_90d
FROM mart.customer_360
WHERE tenant_id = :tenant_id
  AND risk_level = 'High'
ORDER BY pd_score DESC
LIMIT :limit;`,
      params: { tenant_id: tenant, limit },
      explanation: `Returns up to ${limit} customers in the High risk band, sorted by PD score descending.`,
    }),
  },

  // ── alerts_by_severity ─────────────────────────────────────────────
  {
    intent: 'alerts_by_severity',
    patterns: [
      /\b(alerts?|alarms?)\s+(by|per|grouped\s+by)\s+severity\b/i,
      /\bseverity\s+breakdown\b/i,
      /\bhow\s+many\s+(red|orange|yellow|green)\s+alerts?\b/i,
    ],
    confidence: 0.9,
    resolve: (_, tenant, limit) => ({
      sql: `SELECT severity, COUNT(*) AS alert_count
FROM mart.indicator_values
WHERE tenant_id = :tenant_id
  AND breach_severity IS NOT NULL
GROUP BY severity
ORDER BY alert_count DESC
LIMIT :limit;`,
      params: { tenant_id: tenant, limit },
      explanation: `Counts indicator-value breaches per severity tier for the tenant. Use the result for an at-a-glance "where is our risk concentrated?" view.`,
    }),
  },

  // ── avg_dpd_by_product ─────────────────────────────────────────────
  {
    intent: 'avg_dpd_by_product',
    patterns: [
      /\b(avg|average|mean)\s+dpd\b/i,
      /\bdpd\s+by\s+(product|loan\s+type)\b/i,
    ],
    confidence: 0.88,
    resolve: (_, tenant, limit) => ({
      sql: `SELECT product_code,
       AVG(worst_dpd) AS avg_dpd,
       COUNT(*) AS loan_count
FROM mart.loan_360
WHERE tenant_id = :tenant_id
GROUP BY product_code
ORDER BY avg_dpd DESC
LIMIT :limit;`,
      params: { tenant_id: tenant, limit },
      explanation: `Average days-past-due grouped by product code. Higher avg_dpd ⇒ riskier product.`,
    }),
  },

  // ── top_npa_customers ──────────────────────────────────────────────
  {
    intent: 'top_npa_customers',
    patterns: [
      /\b(top|worst)\s+npa\s+customers?\b/i,
      /\bcustomers?\s+with\s+npa\b/i,
      /\bnpa\s+(list|breakdown)\b/i,
    ],
    confidence: 0.86,
    resolve: (_, tenant, limit) => ({
      sql: `SELECT c.customer_id, c.name, l.product_code, l.outstanding_balance, l.worst_dpd
FROM mart.customer_360 c
JOIN mart.loan_360 l ON l.customer_id = c.customer_id AND l.tenant_id = c.tenant_id
WHERE c.tenant_id = :tenant_id
  AND l.has_npa = true
ORDER BY l.outstanding_balance DESC
LIMIT :limit;`,
      params: { tenant_id: tenant, limit },
      explanation: `Lists customers with at least one NPA loan, sorted by outstanding balance (worst-exposure first).`,
    }),
  },

  // ── indicator_value_lookup ─────────────────────────────────────────
  {
    intent: 'indicator_value_lookup',
    patterns: [
      /\bindicator\s+([A-Z]{2,8}-?\d+)\b/i,
      /\bvalue\s+of\s+([A-Z]{2,8}-?\d+)\b/i,
      /\b([A-Z]{2,8}-?\d+)\s+(value|score)\b/i,
    ],
    confidence: 0.92,
    resolve: (matches, tenant, limit) => {
      const indicatorId = matches[0]?.[1]?.toUpperCase() ?? 'FIN-001';
      return {
        sql: `SELECT customer_id, indicator_id, value, breach_severity, as_of
FROM mart.indicator_values
WHERE tenant_id = :tenant_id
  AND indicator_id = :indicator_id
ORDER BY value DESC
LIMIT :limit;`,
        params: { tenant_id: tenant, indicator_id: indicatorId, limit },
        explanation: `Lookup current values for indicator ${indicatorId}, sorted by magnitude descending.`,
      };
    },
  },

  // ── customer_count_by_segment ──────────────────────────────────────
  {
    intent: 'customer_count_by_segment',
    patterns: [
      /\b(how\s+many|count|number\s+of)\s+customers?\b/i,
      /\bcustomers?\s+by\s+(segment|risk\s+level|product)\b/i,
    ],
    confidence: 0.8,
    resolve: (_, tenant, limit) => ({
      sql: `SELECT risk_level, COUNT(*) AS customer_count
FROM mart.customer_360
WHERE tenant_id = :tenant_id
GROUP BY risk_level
ORDER BY customer_count DESC
LIMIT :limit;`,
      params: { tenant_id: tenant, limit },
      explanation: `Customer headcount per risk level for the tenant.`,
    }),
  },

  // ── loan_portfolio_summary ─────────────────────────────────────────
  {
    intent: 'loan_portfolio_summary',
    patterns: [
      /\b(loan\s+)?portfolio\s+(summary|overview)\b/i,
      /\btotal\s+(outstanding|exposure)\b/i,
      /\bsummarise?\s+loans\b/i,
    ],
    confidence: 0.83,
    resolve: (_, tenant, limit) => ({
      sql: `SELECT product_code,
       COUNT(*) AS loan_count,
       SUM(outstanding_balance) AS total_outstanding,
       SUM(CASE WHEN has_npa THEN outstanding_balance ELSE 0 END) AS npa_outstanding
FROM mart.loan_360
WHERE tenant_id = :tenant_id
GROUP BY product_code
ORDER BY total_outstanding DESC
LIMIT :limit;`,
      params: { tenant_id: tenant, limit },
      explanation: `Per-product loan portfolio: count, total outstanding, NPA-only outstanding.`,
    }),
  },

  // ── utilization_above_threshold ────────────────────────────────────
  {
    intent: 'utilization_above_threshold',
    patterns: [
      /\butili[sz]ation\s+(above|over|>\s*)\s*(0?\.\d+|\d+%?)\b/i,
      /\b(customers?|accounts?)\s+(over|above)\s+\d+%?\s+utili[sz]ation\b/i,
    ],
    confidence: 0.84,
    resolve: (matches, tenant, limit) => {
      const raw = matches[0]?.[2] ?? '0.8';
      let threshold = parseFloat(raw.replace('%', ''));
      // Percentage form ("85") → 0.85; decimal form ("0.85") → 0.85.
      if (threshold > 1) threshold = threshold / 100;
      threshold = Math.max(0, Math.min(1, threshold));
      return {
        sql: `SELECT customer_id, name, utilization, risk_level
FROM mart.customer_360
WHERE tenant_id = :tenant_id
  AND utilization > :threshold
ORDER BY utilization DESC
LIMIT :limit;`,
        params: { tenant_id: tenant, threshold, limit },
        explanation: `Customers with utilization above ${threshold}, sorted highest-first.`,
      };
    },
  },

  // ── txn_volume_trend ──────────────────────────────────────────────
  {
    intent: 'txn_volume_trend',
    patterns: [
      /\b(transaction|txn)\s+(volume|trend)\b/i,
      /\bspending\s+pattern\b/i,
    ],
    confidence: 0.81,
    resolve: (_, tenant, limit) => ({
      sql: `SELECT customer_id, txn_volume_90d, txn_volume_zscore_90d
FROM mart.txn_features
WHERE tenant_id = :tenant_id
ORDER BY ABS(txn_volume_zscore_90d) DESC
LIMIT :limit;`,
      params: { tenant_id: tenant, limit },
      explanation: `Transaction volume z-scores per customer, sorted by absolute magnitude (most anomalous first).`,
    }),
  },

  // ── alert_count_last_n_days ───────────────────────────────────────
  {
    intent: 'alert_count_last_n_days',
    patterns: [
      /\b(alerts?|alarms?)\s+(in\s+)?(the\s+)?last\s+(\d+)\s+days?\b/i,
      /\b(\d+)[- ]day\s+alert(s)?\b/i,
    ],
    confidence: 0.87,
    resolve: (matches, tenant, limit) => {
      const m = matches[0];
      const days = parseInt(m?.[4] ?? m?.[1] ?? '30', 10);
      const clampedDays = Math.max(1, Math.min(365, days));
      return {
        sql: `SELECT DATE(as_of) AS day, COUNT(*) AS alert_count
FROM mart.indicator_values
WHERE tenant_id = :tenant_id
  AND breach_severity IS NOT NULL
  AND as_of >= NOW() - (:days || ' days')::interval
GROUP BY DATE(as_of)
ORDER BY day DESC
LIMIT :limit;`,
        params: { tenant_id: tenant, days: clampedDays, limit },
        explanation: `Daily alert count over the last ${clampedDays} days, newest day first.`,
      };
    },
  },
];

// ─── Safety check ──────────────────────────────────────────────────────

const FORBIDDEN_KEYWORDS = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bCREATE\b/i,
  /;\s*\w/, // multi-statement guard (matches semicolon followed by another keyword)
];

function assertSafeSql(sql: string): void {
  for (const re of FORBIDDEN_KEYWORDS) {
    if (re.test(sql)) {
      throw new NlToSqlError('unsafe_query', `SQL contains forbidden keyword: ${re}`);
    }
  }
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function translateNlToSql(input: NlToSqlInput): NlToSqlResult {
  if (!input || typeof input !== 'object') {
    throw new NlToSqlError('invalid_input', 'request body must be an object');
  }
  if (typeof input.question !== 'string' || input.question.trim().length === 0) {
    throw new NlToSqlError('invalid_input', 'question must be a non-empty string');
  }
  if (input.question.length > 1000) {
    throw new NlToSqlError('invalid_input', 'question exceeds 1000 character limit');
  }
  if (typeof input.tenant_id !== 'string' || input.tenant_id.trim().length === 0) {
    throw new NlToSqlError('invalid_input', 'tenant_id required');
  }

  let limit = input.limit ?? DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new NlToSqlError('invalid_input', 'limit must be an integer');
  }
  limit = Math.max(1, Math.min(MAX_LIMIT, limit));

  // Walk the catalog in declared order; first match wins.
  for (const entry of CATALOG) {
    const matches: RegExpMatchArray[] = [];
    for (const re of entry.patterns) {
      const m = input.question.match(re);
      if (m) matches.push(m);
    }
    if (matches.length === 0) continue;

    const { sql, params, explanation } = entry.resolve(matches, input.tenant_id, limit);
    assertSafeSql(sql);
    return {
      intent: entry.intent,
      sql,
      params,
      confidence: entry.confidence,
      explanation,
      requires_review: true,
      fallback: false,
    };
  }

  // No pattern matched — return a safe fallback that lists tables the
  // user might want to query. Production LLM mode would attempt a free-
  // form translation here.
  return {
    intent: 'unknown',
    sql: `-- No matching pattern. Available tables for tenant ${input.tenant_id}:
--   mart.customer_360, mart.loan_360, mart.txn_features, mart.indicator_values
-- Try: "high-risk customers", "alerts by severity", "avg DPD by product",
--      "top NPA customers", "utilization above 0.8", "alerts last 7 days".`,
    params: { tenant_id: input.tenant_id },
    confidence: 0.0,
    explanation:
      'Stub mode could not match the question against any known pattern. ' +
      'Try rephrasing using the example prompts in the SQL comment block. ' +
      'Production LLM mode (when ANTHROPIC_API_KEY is set) will handle free-form questions.',
    requires_review: true,
    fallback: true,
  };
}

// ─── Constants for tests ───────────────────────────────────────────────

export const NL_TO_SQL_MAX_LIMIT = MAX_LIMIT;
export const NL_TO_SQL_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const NL_TO_SQL_INTENTS: readonly NlToSqlIntent[] = [
  'unknown',
  'high_risk_customers',
  'alerts_by_severity',
  'avg_dpd_by_product',
  'top_npa_customers',
  'indicator_value_lookup',
  'customer_count_by_segment',
  'loan_portfolio_summary',
  'utilization_above_threshold',
  'txn_volume_trend',
  'alert_count_last_n_days',
];
