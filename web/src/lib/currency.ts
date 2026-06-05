// web/src/lib/currency.ts
//
// Canonical ZorEWS currency formatter.
// All monetary KPI values across the platform must use these functions.
// Replaces 7 inconsistent local fmtKes/fmtCurrency implementations.
//
// BFSI compact format (Indian numbering convention):
//   < 1,000          → raw (1)
//   1,000 – 99,999   → K  (1.25K)
//   1,00,000 – 99,99,999  → L  (1.25L)   [Lakhs]
//   ≥ 1,00,00,000         → Cr (1.25Cr)  [Crores]
//
// Exact value is always preserved in the `full` output for tooltips.

export type CurrencyLocale = 'IN' | 'GLOBAL';

export interface FormatOptions {
  /** Number of decimal places in compact display. Default: 2. */
  decimals?: number;
  /** Whether to include the "KES" prefix. Default: false (unit implicit on dashboard). */
  prefix?: boolean;
  /** Locale convention. Default 'IN' (lakhs/crores). */
  locale?: CurrencyLocale;
}

// ─── Thresholds ───────────────────────────────────────────────────────────

const CR  = 10_000_000;       // 1 Crore  = 1,00,00,000
const L   = 100_000;          // 1 Lakh   = 1,00,000
const K   = 1_000;            // 1 Thousand

// ─── Core formatter ───────────────────────────────────────────────────────

/**
 * Compact monetary formatter for KPI cards.
 *
 * @example
 * fmtCompact(5_113_220_000) → "511.32Cr"
 * fmtCompact(125_000)       → "1.25L"
 * fmtCompact(1_250)         → "1.25K"
 * fmtCompact(500)           → "500"
 */
export function fmtCompact(value: number, opts: FormatOptions = {}): string {
  const { decimals = 2, prefix = false, locale = 'IN' } = opts;
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const pfx = prefix ? 'KES ' : '';

  let formatted: string;
  if (locale === 'IN') {
    if (abs >= CR) {
      formatted = `${(abs / CR).toFixed(decimals)}Cr`;
    } else if (abs >= L) {
      formatted = `${(abs / L).toFixed(decimals)}L`;
    } else if (abs >= K) {
      formatted = `${(abs / K).toFixed(decimals)}K`;
    } else {
      formatted = abs.toLocaleString('en-IN');
    }
  } else {
    // GLOBAL fallback: B / M / K
    const B = 1_000_000_000;
    const M = 1_000_000;
    if (abs >= B) {
      formatted = `${(abs / B).toFixed(decimals)}B`;
    } else if (abs >= M) {
      formatted = `${(abs / M).toFixed(decimals)}M`;
    } else if (abs >= K) {
      formatted = `${(abs / K).toFixed(decimals)}K`;
    } else {
      formatted = abs.toLocaleString('en');
    }
  }

  return `${sign}${pfx}${formatted}`;
}

/**
 * Full monetary formatter for tooltips (exact value, never truncated).
 *
 * @example
 * fmtFull(5_113_220_000) → "KES 5,11,32,20,000"   [en-IN]
 * fmtFull(125_000)       → "KES 1,25,000"
 */
export function fmtFull(value: number): string {
  return `KES ${value.toLocaleString('en-IN')}`;
}

/**
 * Ultra-compact for very tight spaces (1 decimal place).
 *
 * @example
 * fmtTight(5_113_220_000) → "511.3Cr"
 * fmtTight(125_000)       → "1.3L"
 */
export function fmtTight(value: number): string {
  return fmtCompact(value, { decimals: 1 });
}

/**
 * Format with explicit KES prefix — use in standalone text (reports, exports).
 *
 * @example
 * fmtKES(5_113_220_000) → "KES 511.32Cr"
 */
export function fmtKES(value: number, decimals = 2): string {
  return fmtCompact(value, { decimals, prefix: true });
}

/**
 * Zero-decimal compact — for very dense tables.
 *
 * @example
 * fmtCompact0(125_400) → "1L"
 */
export function fmtCompact0(value: number): string {
  return fmtCompact(value, { decimals: 0 });
}

/**
 * Determine if a value needs compact formatting (above 10K).
 */
export function needsCompact(value: number): boolean {
  return Math.abs(value) >= 10_000;
}
