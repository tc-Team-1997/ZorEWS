// services/bff/src/scenario_narrative.ts
//
// T6 M16.16 — Scenario library narrative one-liners.
//
// Each M16.1 preset carries `shocks: {gdp, rate, fx}` — three
// numbers in three different units (GDP percentage points, rate
// basis points, FX percent). Today the SPA renders each in its
// own chip with its own format spec. M16.16 ships the canonical
// one-liner so the SPA can render "GDP −4.0%, rates +200bps,
// INR −8.5%" in a single label without re-implementing the
// formatting in TypeScript.
//
// Companion to M16.15 (chart-data radar transform) — M16.15 is
// the visual normaliser; M16.16 is the textual narrator.
//
// Pure — no I/O, no store dependency. Platform-static.

import { SCENARIO_PRESETS, type ScenarioPreset, type ScenarioShocks } from './scenario_library';

// ─── Public types ─────────────────────────────────────────────────────

export interface ScenarioNarrative {
  preset_id: string;
  name: string;
  category: ScenarioPreset['category'];
  severity: ScenarioPreset['severity'];
  /** Per-axis numeric values rendered with sign + unit. Empty array
   *  on baseline (all-zero shocks) — caller can render "Baseline
   *  (no shock)" instead. Stable order: gdp → rate → fx. */
  axis_phrases: string[];
  /** Single-line summary joining `axis_phrases` with ", ". For the
   *  baseline preset (every axis is 0) this is the literal string
   *  "Baseline (no shock)" rather than an empty string — saves the
   *  SPA from a null-check on hover/tooltip rendering. */
  narrative: string;
}

export interface ScenarioNarrativeCatalog {
  total_presets: number;
  /** Sorted by preset_id asc for stable rendering. */
  presets: ScenarioNarrative[];
}

// ─── Pure formatters ──────────────────────────────────────────────────

/** Unicode minus (U+2212) for negative numbers — keeps the narrative
 *  printable in fixed-width contexts where ASCII hyphen looks like a
 *  separator. Positive numbers stay '+' (ASCII). */
const MINUS = '−';

function fmtSigned(value: number, decimals: number): string {
  if (value === 0) return '0';
  const sign = value < 0 ? MINUS : '+';
  const abs = Math.abs(value);
  return `${sign}${abs.toFixed(decimals)}`;
}

/** GDP shock — percentage points, 1 decimal place. */
function fmtGdp(gdp: number): string | null {
  if (gdp === 0) return null;
  return `GDP ${fmtSigned(gdp, 1)}%`;
}

/** Rate shock — basis points, integer (rounded from input). */
function fmtRate(rate: number): string | null {
  if (rate === 0) return null;
  const sign = rate < 0 ? MINUS : '+';
  return `rates ${sign}${Math.round(Math.abs(rate))}bps`;
}

/** FX shock — percent move, 1 decimal place. Positive = local-currency
 *  depreciation, narrated as "INR <sign>X.X%". */
function fmtFx(fx: number): string | null {
  if (fx === 0) return null;
  return `INR ${fmtSigned(fx, 1)}%`;
}

export function formatShockPhrases(shocks: ScenarioShocks): string[] {
  const phrases: string[] = [];
  const g = fmtGdp(shocks.gdp);
  if (g) phrases.push(g);
  const r = fmtRate(shocks.rate);
  if (r) phrases.push(r);
  const f = fmtFx(shocks.fx);
  if (f) phrases.push(f);
  return phrases;
}

export function formatScenarioNarrative(preset: ScenarioPreset): ScenarioNarrative {
  const axis_phrases = formatShockPhrases(preset.shocks);
  const narrative = axis_phrases.length === 0
    ? 'Baseline (no shock)'
    : axis_phrases.join(', ');
  return {
    preset_id: preset.id,
    name: preset.name,
    category: preset.category,
    severity: preset.severity,
    axis_phrases,
    narrative,
  };
}

export function listScenarioNarratives(): ScenarioNarrativeCatalog {
  const presets = SCENARIO_PRESETS.map(formatScenarioNarrative)
    .sort((a, b) => a.preset_id.localeCompare(b.preset_id));
  return {
    total_presets: presets.length,
    presets,
  };
}
