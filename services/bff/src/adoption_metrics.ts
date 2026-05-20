// services/bff/src/adoption_metrics.ts
//
// X.4 — Adoption metrics tracked from Phase 1.
//
// Per-tenant adoption-funnel rollup answering "how engaged is this
// tenant?" — covers daily active users, alert handling depth (open vs
// acked vs closed), case workflow penetration, rule coverage, scenario
// authorship, dashboard customisation. Deterministic per (tenant, day)
// synthesis until production telemetry plugs into the same shape (DAU
// from CloudWatch real-user metrics, alert/case stats from app_*
// stores, etc.).
//
// Pure function — no I/O. Mirrors the BIL dashboard builders +
// FinOps dashboard (T5.5) FNV-1a + Mulberry32 seed pattern.

// ─── Public types ──────────────────────────────────────────────────────

export interface AdoptionEngagement {
  /** Daily active users — count distinct logins in last 24h. */
  dau: number;
  /** Weekly active users — count distinct logins in last 7d. */
  wau: number;
  /** Monthly active users — count distinct logins in last 30d. */
  mau: number;
  /** DAU/MAU ratio (0..1) — engagement intensity. >0.2 is "healthy
   *  daily-engaged" by industry rule of thumb. */
  daily_intensity: number;
  /** WAU/MAU ratio (0..1) — weekly engagement. */
  weekly_intensity: number;
}

export interface AdoptionAlertFunnel {
  total_alerts_30d: number;
  /** Alerts that an operator acknowledged (M8.3). */
  acked_count: number;
  /** Alerts that landed in a case (M9.1 investigation). */
  with_case_count: number;
  /** Alerts whose case reached a decision. */
  decided_count: number;
  /** acked / total — first-engagement rate. */
  ack_rate: number;
  /** with_case / acked — investigation depth. */
  investigation_rate: number;
  /** decided / with_case — closure depth. */
  closure_rate: number;
}

export interface AdoptionAuthorship {
  /** Custom rules created (M5.x custom templates beyond seed library). */
  custom_rules_count: number;
  /** Custom scenario presets saved (M16.4 + saved-scenario store). */
  saved_scenarios_count: number;
  /** Custom dashboards (M11.7 builder). */
  custom_dashboards_count: number;
  /** Custom investigation checklists (M9.2). */
  custom_checklists_count: number;
  /** Custom weight presets (M6.4). */
  custom_scoring_presets_count: number;
  /** True if ≥ 1 authoring action in last 30 days — tenant is actively
   *  configuring vs passively consuming defaults. */
  has_recent_authorship: boolean;
}

export interface AdoptionWorkflow {
  /** Onboarding completeness % (M2.6 / M2.11 milestone). */
  onboarding_pct: number;
  /** True iff M2.11 stage = 'complete'. */
  onboarding_complete: boolean;
  /** API key count active (M1.2). */
  active_api_keys: number;
  /** Webhook subscriptions registered + active (T4.12). */
  active_webhooks: number;
  /** Tenants with at least one TOTP-2FA-enrolled user (M1.1). */
  has_2fa_enrolled: boolean;
}

export interface AdoptionMetrics {
  tenant_id: string;
  generated_at: string;
  /** Days since the tenant was provisioned (per app_iam.tenants
   *  created_at — synthesised deterministically here). */
  days_since_provisioned: number;
  engagement: AdoptionEngagement;
  alert_funnel: AdoptionAlertFunnel;
  authorship: AdoptionAuthorship;
  workflow: AdoptionWorkflow;
  /** Headline score 0..100. Composite of intensity + funnel + workflow
   *  weighted equally. Drives the SaaS-admin "is this tenant going to
   *  renew?" leading indicator. */
  adoption_score: number;
  /** Bucketed score: `at_risk` (<40) / `warming_up` (<60) /
   *  `engaged` (<80) / `power_user` (≥ 80). */
  adoption_band: 'at_risk' | 'warming_up' | 'engaged' | 'power_user';
}

// ─── Helpers ───────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildAdoptionMetrics(
  tenant_id: string,
  now: Date,
): AdoptionMetrics {
  if (!tenant_id) {
    throw new Error('tenant_id required');
  }

  const seed = fnv1a(`adoption|${tenant_id}|${dayKey(now)}`);
  const rng = mulberry32(seed);

  // Tenant scale: BIL = 0.6 of BANK_DEMO (matches bil_dashboards.ts
  // convention).
  const tenantScale = tenant_id === 'BIL' ? 0.6 : 1.0;

  // ── Engagement (DAU/WAU/MAU) ───────────────────────────────────────
  // Base MAU 80-200 × tenant scale.
  const baseMau = Math.floor(80 + rng() * 120);
  const mau = Math.max(1, Math.floor(baseMau * tenantScale));
  // WAU ~ 60-80% of MAU.
  const wau = Math.floor(mau * (0.6 + rng() * 0.2));
  // DAU ~ 20-45% of MAU.
  const dau = Math.floor(mau * (0.2 + rng() * 0.25));
  const daily_intensity = round4(dau / mau);
  const weekly_intensity = round4(wau / mau);

  // ── Alert funnel ───────────────────────────────────────────────────
  // Total alerts 200-1200 × tenant scale.
  const total_alerts_30d = Math.floor((200 + rng() * 1000) * tenantScale);
  // Ack rate 0.55-0.95 — top-of-funnel.
  const ack_rate = round4(0.55 + rng() * 0.4);
  const acked_count = Math.floor(total_alerts_30d * ack_rate);
  // Investigation rate 0.15-0.45 of acked.
  const investigation_rate = round4(0.15 + rng() * 0.3);
  const with_case_count = Math.floor(acked_count * investigation_rate);
  // Closure rate 0.4-0.85 of with_case.
  const closure_rate = round4(0.4 + rng() * 0.45);
  const decided_count = Math.floor(with_case_count * closure_rate);

  // ── Authorship ─────────────────────────────────────────────────────
  // Tenant-scale + a "maturity" factor based on days_since_provisioned.
  const days_since_provisioned = 30 + Math.floor(rng() * 700);
  const maturityFactor = Math.min(1, days_since_provisioned / 180);
  const custom_rules_count = Math.floor(rng() * 25 * maturityFactor * tenantScale);
  const saved_scenarios_count = Math.floor(rng() * 15 * maturityFactor * tenantScale);
  const custom_dashboards_count = Math.floor(rng() * 8 * maturityFactor * tenantScale);
  const custom_checklists_count = Math.floor(rng() * 5 * maturityFactor * tenantScale);
  const custom_scoring_presets_count = Math.floor(rng() * 6 * maturityFactor * tenantScale);
  const has_recent_authorship =
    custom_rules_count + saved_scenarios_count + custom_dashboards_count > 0;

  // ── Workflow ───────────────────────────────────────────────────────
  // Onboarding pct correlates with days_since_provisioned (capped at 100).
  const onboarding_pct = Math.min(
    100,
    Math.floor((days_since_provisioned / 14) * (60 + rng() * 40)),
  );
  const onboarding_complete = onboarding_pct >= 100;
  const active_api_keys = Math.floor(rng() * 12 * tenantScale);
  const active_webhooks = Math.floor(rng() * 8 * tenantScale);
  const has_2fa_enrolled = maturityFactor > 0.5; // mature tenants ⇒ 2FA enrolled

  // ── Composite adoption score (0..100) ──────────────────────────────
  // Equal weighting across 4 axes: engagement, alert funnel, authorship,
  // workflow.
  const engagementScore =
    daily_intensity * 60 + weekly_intensity * 40; // 0..100
  const funnelScore =
    ack_rate * 50 + investigation_rate * 25 + closure_rate * 25; // 0..100
  const authorshipScore = Math.min(
    100,
    (custom_rules_count * 4 +
      saved_scenarios_count * 5 +
      custom_dashboards_count * 8 +
      custom_checklists_count * 6 +
      custom_scoring_presets_count * 6) *
      tenantScale,
  );
  const workflowScore =
    onboarding_pct * 0.6 +
    (active_api_keys > 0 ? 15 : 0) +
    (active_webhooks > 0 ? 15 : 0) +
    (has_2fa_enrolled ? 10 : 0);

  const adoption_score = round2(
    (engagementScore + funnelScore + authorshipScore + workflowScore) / 4,
  );

  let adoption_band: AdoptionMetrics['adoption_band'];
  if (adoption_score < 40) adoption_band = 'at_risk';
  else if (adoption_score < 60) adoption_band = 'warming_up';
  else if (adoption_score < 80) adoption_band = 'engaged';
  else adoption_band = 'power_user';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    days_since_provisioned,
    engagement: {
      dau,
      wau,
      mau,
      daily_intensity,
      weekly_intensity,
    },
    alert_funnel: {
      total_alerts_30d,
      acked_count,
      with_case_count,
      decided_count,
      ack_rate,
      investigation_rate,
      closure_rate,
    },
    authorship: {
      custom_rules_count,
      saved_scenarios_count,
      custom_dashboards_count,
      custom_checklists_count,
      custom_scoring_presets_count,
      has_recent_authorship,
    },
    workflow: {
      onboarding_pct,
      onboarding_complete,
      active_api_keys,
      active_webhooks,
      has_2fa_enrolled,
    },
    adoption_score,
    adoption_band,
  };
}
