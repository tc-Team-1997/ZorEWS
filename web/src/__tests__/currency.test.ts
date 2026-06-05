// web/src/__tests__/currency.test.ts
//
// Unit tests for the canonical ZorEWS currency formatter.
// Verifies the Indian compact format (K / L / Cr) and overflow-safe output.

import { describe, it, expect } from 'vitest';
import { fmtCompact, fmtFull, fmtKES, fmtTight, fmtCompact0, needsCompact } from '@/lib/currency';

describe('fmtCompact — Indian compact format', () => {
  it('renders raw integers below 1K', () => {
    expect(fmtCompact(0)).toBe('0');
    expect(fmtCompact(500)).toBe('500');
    expect(fmtCompact(999)).toBe('999');
  });

  it('renders K for 1,000 – 99,999', () => {
    expect(fmtCompact(1_000)).toBe('1.00K');
    expect(fmtCompact(1_250)).toBe('1.25K');
    expect(fmtCompact(10_000)).toBe('10.00K');
    expect(fmtCompact(99_999)).toBe('100.00K');  // rounds up at boundary
  });

  it('renders L for 1,00,000 – 9,99,99,999', () => {
    expect(fmtCompact(100_000)).toBe('1.00L');
    expect(fmtCompact(125_000)).toBe('1.25L');
    expect(fmtCompact(3_000_000)).toBe('30.00L');
    expect(fmtCompact(9_999_999)).toBe('100.00L');  // just under 1 Cr
  });

  it('renders Cr for ≥ 1,00,00,000', () => {
    expect(fmtCompact(10_000_000)).toBe('1.00Cr');
    expect(fmtCompact(12_500_000)).toBe('1.25Cr');
    expect(fmtCompact(511_322_000)).toBe('51.13Cr');
    expect(fmtCompact(5_113_220_000)).toBe('511.32Cr');
  });

  it('handles negative values with − sign', () => {
    expect(fmtCompact(-125_000)).toBe('−1.25L');
    expect(fmtCompact(-5_113_220_000)).toBe('−511.32Cr');
  });

  it('respects custom decimals option', () => {
    expect(fmtCompact(1_250, { decimals: 0 })).toBe('1K');
    expect(fmtCompact(125_000, { decimals: 1 })).toBe('1.3L');
    expect(fmtCompact(5_113_220_000, { decimals: 1 })).toBe('511.3Cr');
  });

  it('respects prefix option', () => {
    expect(fmtCompact(511_322_000, { prefix: true })).toBe('KES 51.13Cr');
    expect(fmtCompact(125_000, { prefix: true })).toBe('KES 1.25L');
  });
});

describe('fmtFull — exact value for tooltips', () => {
  it('always returns full en-IN format with KES prefix', () => {
    expect(fmtFull(0)).toBe('KES 0');
    expect(fmtFull(1_250)).toBe('KES 1,250');
    expect(fmtFull(5_113_220_000)).toContain('KES');
    expect(fmtFull(5_113_220_000)).toContain('5');
  });
});

describe('fmtKES — compact with KES prefix', () => {
  it('prefixes with KES', () => {
    expect(fmtKES(511_322_000)).toBe('KES 51.13Cr');
    expect(fmtKES(125_000)).toBe('KES 1.25L');
    expect(fmtKES(1_250)).toBe('KES 1.25K');
  });
});

describe('fmtTight — 1 decimal for tight spaces', () => {
  it('uses 1 decimal place', () => {
    expect(fmtTight(5_113_220_000)).toBe('511.3Cr');
    expect(fmtTight(125_400)).toBe('1.3L');
  });
});

describe('fmtCompact0 — zero decimals', () => {
  it('rounds to whole units', () => {
    expect(fmtCompact0(1_250)).toBe('1K');
    expect(fmtCompact0(125_000)).toBe('1L');
    expect(fmtCompact0(12_500_000)).toBe('1Cr');
  });
});

describe('needsCompact', () => {
  it('returns false for small values', () => {
    expect(needsCompact(0)).toBe(false);
    expect(needsCompact(9_999)).toBe(false);
  });
  it('returns true for values >= 10K', () => {
    expect(needsCompact(10_000)).toBe(true);
    expect(needsCompact(5_113_220_000)).toBe(true);
  });
});

describe('spec examples from OBJECTIVE', () => {
  it('matches all required examples exactly', () => {
    expect(fmtCompact(1_250)).toBe('1.25K');
    expect(fmtCompact(125_000)).toBe('1.25L');
    expect(fmtCompact(12_500_000)).toBe('1.25Cr');
    expect(fmtCompact(511_322_000)).toBe('51.13Cr');
    expect(fmtCompact(5_113_220_000)).toBe('511.32Cr');
  });

  it('never produces values longer than 12 characters (no card overflow)', () => {
    const TEST_VALUES = [
      0, 500, 1_250, 99_999, 125_000, 3_000_000,
      12_500_000, 511_322_000, 5_113_220_000, 999_999_999_999,
    ];
    for (const v of TEST_VALUES) {
      const result = fmtCompact(v);
      expect(result.length).toBeLessThanOrEqual(12);
    }
  });
});
