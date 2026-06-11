// services/bff/src/adapter_dependency_graph.ts
// T6 M14.37 — Adapter dependency graph.
// Builds a dependency graph between M14 adapters based on data-flow relationships.

import { type AdapterId, listFleetAdapters } from './adapter_health';

export interface DependencyEdge {
  from: AdapterId;
  to: AdapterId;
  relationship: string;
}

export interface AdapterDependencyNode {
  adapter_id: AdapterId;
  label: string;
  depends_on: AdapterId[];
  depended_by: AdapterId[];
  centrality_score: number; // depends_on.length + depended_by.length
}

export interface AdapterDependencyGraphResult {
  generated_at: string;
  total_adapters: number;
  edges: DependencyEdge[];
  adapters: AdapterDependencyNode[];
  most_central_adapter: AdapterId | null;
  isolated_adapters: AdapterId[];
}

// Hardcoded business-logic dependency edges
const DEPENDENCY_EDGES: Array<{
  from: AdapterId;
  to: AdapterId;
  relationship: string;
}> = [
  { from: 'insurance', to: 'ifrs9', relationship: 'policy data feeds ECL' },
  { from: 'ifrs9', to: 'aml', relationship: 'stage info enriches screening' },
  { from: 'bureau', to: 'ifrs9', relationship: 'credit score feeds PD' },
  { from: 'aml', to: 'dms', relationship: 'match records need document evidence' },
  { from: 'hr', to: 'agent', relationship: 'staff manages agent productivity' },
  { from: 'finance', to: 'ifrs9', relationship: 'account balance feeds EAD' },
];

export function buildAdapterDependencyGraph(now: Date): AdapterDependencyGraphResult {
  const fleet = listFleetAdapters();
  const adapterIds = new Set(fleet.map((f) => f.adapter_id));
  const labelById = new Map(fleet.map((f) => [f.adapter_id, f.label]));

  // Filter edges to only those with both endpoints in the fleet
  const edges = DEPENDENCY_EDGES.filter(
    (e) => adapterIds.has(e.from) && adapterIds.has(e.to),
  );

  // Build adjacency
  const dependsOnMap = new Map<AdapterId, Set<AdapterId>>();
  const dependedByMap = new Map<AdapterId, Set<AdapterId>>();

  for (const id of adapterIds) {
    dependsOnMap.set(id, new Set());
    dependedByMap.set(id, new Set());
  }

  for (const edge of edges) {
    dependsOnMap.get(edge.from)!.add(edge.to);
    dependedByMap.get(edge.to)!.add(edge.from);
  }

  const adapters: AdapterDependencyNode[] = fleet.map((f) => {
    const depends_on = [...(dependsOnMap.get(f.adapter_id) ?? [])].sort();
    const depended_by = [...(dependedByMap.get(f.adapter_id) ?? [])].sort();
    return {
      adapter_id: f.adapter_id,
      label: labelById.get(f.adapter_id) ?? f.adapter_id,
      depends_on: depends_on as AdapterId[],
      depended_by: depended_by as AdapterId[],
      centrality_score: depends_on.length + depended_by.length,
    };
  });

  // Sort by centrality_score desc, adapter_id asc tie-break
  adapters.sort(
    (a, b) => b.centrality_score - a.centrality_score || a.adapter_id.localeCompare(b.adapter_id),
  );

  const most_central = adapters.length > 0 && adapters[0].centrality_score > 0
    ? adapters[0].adapter_id
    : null;

  const isolated = adapters
    .filter((a) => a.centrality_score === 0)
    .map((a) => a.adapter_id)
    .sort();

  return {
    generated_at: now.toISOString(),
    total_adapters: fleet.length,
    edges,
    adapters,
    most_central_adapter: most_central,
    isolated_adapters: isolated as AdapterId[],
  };
}
