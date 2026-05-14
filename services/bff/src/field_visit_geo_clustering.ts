// services/bff/src/field_visit_geo_clustering.ts
//
// T6 M14.21 — Field visit geo-clustering.
//
// M14.10 ships the per-tenant field-visit ledger (visits carry an
// optional GPS pin). M14.19 ships the per-officer + outcome rollup.
// M14.21 adds the spatial view: group visits by physical proximity
// so the supervisor map can see "5 visits happening at the BIL
// Mumbai office today" as a single dot vs scattered noise.
//
// Design:
//  - Pure function over a readonly FieldVisit[]. Caller slices the
//    window (typically `fieldVisitStore.list(tenant, filter)`).
//  - Visits without `location` are counted separately as
//    `total_without_gps` but never produce a cluster — no way to
//    place them.
//  - Greedy O(n × k) clustering: walk visits oldest-first, assign
//    each to the FIRST existing cluster whose centroid is within
//    `radius_km`. If none match, start a new cluster. Centroid is
//    the running mean of (lat, lon) — simple and stable for the
//    small clusters this surface produces.
//  - Haversine distance with Earth radius 6371 km. Accurate to
//    ~0.5% across normal usage — fine for the "are these two
//    visits in the same neighbourhood?" question this answers.
//  - Cluster order is insertion order of the first visit (so
//    deterministic given visits[]). Cluster IDs `c-${idx}`.

import {
  type FieldVisit,
  type VisitOutcome,
  VISIT_OUTCOMES,
} from './field_officer';

// ─── Public types ─────────────────────────────────────────────────────

export interface ClusterCentroid {
  lat: number;
  lon: number;
}

export interface VisitGeoCluster {
  cluster_id: string;
  centroid: ClusterCentroid;
  visit_count: number;
  /** Distinct officer_ids seen in this cluster, sorted asc. */
  officer_ids: string[];
  /** Distinct customer_ids seen in this cluster, sorted asc. */
  customer_ids: string[];
  /** Counts per outcome — every key present at 0. */
  by_outcome: Record<VisitOutcome, number>;
  /** ISO timestamp of the newest visit in this cluster. */
  latest_visit_at: string;
}

export interface FieldVisitGeoClusters {
  /** Radius (km) used for the clustering. Echoed back for SPA tooltips. */
  radius_km: number;
  /** Number of clusters produced. */
  cluster_count: number;
  /** Visits that contributed to a cluster (had a GPS pin). */
  total_with_gps: number;
  /** Visits skipped because they had no GPS. */
  total_without_gps: number;
  /** Clusters sorted by visit_count desc, ties broken by latest_visit_at desc. */
  clusters: VisitGeoCluster[];
}

export const DEFAULT_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 500;
const EARTH_RADIUS_KM = 6371;

// ─── Haversine ───────────────────────────────────────────────────────

/** Great-circle distance between two lat/lon points in kilometres. */
export function haversineKm(a: ClusterCentroid, b: ClusterCentroid): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ─── Pure aggregator ─────────────────────────────────────────────────

function emptyByOutcome(): Record<VisitOutcome, number> {
  return Object.fromEntries(VISIT_OUTCOMES.map((o) => [o, 0])) as Record<
    VisitOutcome,
    number
  >;
}

type ClusterAcc = {
  cluster_id: string;
  centroid: ClusterCentroid;
  visit_count: number;
  officers: Set<string>;
  customers: Set<string>;
  by_outcome: Record<VisitOutcome, number>;
  latest_visit_at: string;
};

/**
 * Pure greedy spatial clustering. Visits without GPS are counted
 * separately and skipped. Centroid is the running mean updated as
 * each visit joins a cluster.
 */
export function clusterFieldVisits(
  visits: readonly FieldVisit[],
  radius_km: number = DEFAULT_RADIUS_KM,
): FieldVisitGeoClusters {
  if (!Number.isFinite(radius_km) || radius_km <= 0) {
    radius_km = DEFAULT_RADIUS_KM;
  }
  if (radius_km > MAX_RADIUS_KM) radius_km = MAX_RADIUS_KM;

  let total_with_gps = 0;
  let total_without_gps = 0;
  const accs: ClusterAcc[] = [];

  for (const v of visits) {
    if (!v.location) {
      total_without_gps += 1;
      continue;
    }
    total_with_gps += 1;
    const point: ClusterCentroid = { lat: v.location.lat, lon: v.location.lon };
    let target: ClusterAcc | undefined;
    for (const acc of accs) {
      if (haversineKm(acc.centroid, point) <= radius_km) {
        target = acc;
        break;
      }
    }
    if (!target) {
      target = {
        cluster_id: `c-${accs.length}`,
        centroid: { lat: point.lat, lon: point.lon },
        visit_count: 0,
        officers: new Set<string>(),
        customers: new Set<string>(),
        by_outcome: emptyByOutcome(),
        latest_visit_at: v.visit_at,
      };
      accs.push(target);
    } else {
      // Running mean centroid: c' = c + (point - c) / (n + 1).
      const n = target.visit_count;
      target.centroid.lat = target.centroid.lat + (point.lat - target.centroid.lat) / (n + 1);
      target.centroid.lon = target.centroid.lon + (point.lon - target.centroid.lon) / (n + 1);
    }
    target.visit_count += 1;
    target.officers.add(v.officer_id);
    target.customers.add(v.customer_id);
    if (VISIT_OUTCOMES.includes(v.outcome)) target.by_outcome[v.outcome] += 1;
    if (v.visit_at > target.latest_visit_at) target.latest_visit_at = v.visit_at;
  }

  const clusters: VisitGeoCluster[] = accs.map((a) => ({
    cluster_id: a.cluster_id,
    centroid: { lat: a.centroid.lat, lon: a.centroid.lon },
    visit_count: a.visit_count,
    officer_ids: [...a.officers].sort(),
    customer_ids: [...a.customers].sort(),
    by_outcome: a.by_outcome,
    latest_visit_at: a.latest_visit_at,
  }));
  clusters.sort((a, b) => {
    if (b.visit_count !== a.visit_count) return b.visit_count - a.visit_count;
    return a.latest_visit_at < b.latest_visit_at ? 1 : a.latest_visit_at > b.latest_visit_at ? -1 : 0;
  });

  return {
    radius_km,
    cluster_count: clusters.length,
    total_with_gps,
    total_without_gps,
    clusters,
  };
}
