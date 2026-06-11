// services/bff/src/connector_schema_evolution.ts
// T6 M3.27 — Connector schema evolution tracker.
// Synthesizes schema evolution stats per connector using deterministic PRNG.

import { listSchemaConnectorIds } from './connector_schema';

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = ((r ^ (r >>> 15)) * (r | 1)) >>> 0;
    r = (r ^ (r + ((r ^ (r >>> 7)) * (r | 61)))) >>> 0;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export type ConnectorMaturity = 'evolving' | 'stable' | 'frozen';

export interface ConnectorEvolutionEntry {
  connector_id: string;
  version: string;
  version_count: number;
  evolution_score: number;
  breaking_changes_count: number;
  additive_changes_count: number;
  maturity: ConnectorMaturity;
  last_updated_at: string;
}

export interface ConnectorSchemaEvolutionResult {
  generated_at: string;
  total_connectors: number;
  connectors: ConnectorEvolutionEntry[];
  most_stable_connector: string | null;
  most_active_connector: string | null;
}

function maturityFor(score: number, version_count: number): ConnectorMaturity {
  if (version_count <= 1) return 'frozen';
  if (score >= 80) return 'stable';
  return 'evolving';
}

export function buildConnectorSchemaEvolution(now: Date): ConnectorSchemaEvolutionResult {
  const ids = listSchemaConnectorIds();
  const nowMs = now.getTime();

  const connectors: ConnectorEvolutionEntry[] = ids.map((connector_id) => {
    const seed = fnv1a(`${connector_id}:schema_evo`);
    const rng = mulberry32(seed);

    const version_count = 1 + Math.floor(rng() * 5); // 1-5
    const breaking_changes_count = Math.floor(rng() * 4); // 0-3
    const additive_changes_count = 1 + Math.floor(rng() * 8); // 1-8
    const raw_score = 100 - (breaking_changes_count * 20) + additive_changes_count * 5;
    const evolution_score = Math.max(0, Math.min(100, raw_score));

    // deterministic last_updated_at: 0-180 days ago
    const daysAgo = Math.floor(rng() * 180);
    const last_updated_at = new Date(nowMs - daysAgo * 86_400_000).toISOString();

    // version string
    const major = Math.floor(rng() * 2) + 1;
    const minor = Math.floor(rng() * 10);
    const version = `${major}.${minor}.0`;

    return {
      connector_id,
      version,
      version_count,
      evolution_score,
      breaking_changes_count,
      additive_changes_count,
      maturity: maturityFor(evolution_score, version_count),
      last_updated_at,
    };
  });

  let mostStable: string | null = null;
  let mostActive: string | null = null;

  if (connectors.length > 0) {
    // most_stable = highest evolution_score with connector_id asc tie-break
    const stableSorted = [...connectors].sort(
      (a, b) => b.evolution_score - a.evolution_score || a.connector_id.localeCompare(b.connector_id),
    );
    mostStable = stableSorted[0].connector_id;

    // most_active = highest additive_changes_count with connector_id asc tie-break
    const activeSorted = [...connectors].sort(
      (a, b) => b.additive_changes_count - a.additive_changes_count || a.connector_id.localeCompare(b.connector_id),
    );
    mostActive = activeSorted[0].connector_id;
  }

  return {
    generated_at: now.toISOString(),
    total_connectors: connectors.length,
    connectors,
    most_stable_connector: mostStable,
    most_active_connector: mostActive,
  };
}
