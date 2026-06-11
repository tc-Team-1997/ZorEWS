// services/bff/src/tenant_production_readiness.ts
// T6 M2.30 — Tenant readiness for production deployment

export interface ProductionReadinessCriterion {
  name: string;
  points_earned: number;
  max_points: number;
  passed: boolean;
  detail: string;
}

export interface TenantProductionReadiness {
  tenant_id: string;
  generated_at: string;
  readiness_score: number;
  readiness_grade: 'A' | 'B' | 'C' | 'D';
  criteria: ProductionReadinessCriterion[];
  blocking_criteria: string[];
  next_steps: string[];
}

export async function buildTenantProductionReadiness(
  tenant_id: string,
  now: Date,
  deps: {
    onboardingStore: { get(t: string): { is_complete: boolean } };
    apiKeyStore: { list(t: string, p: number, ps: number): { items: Array<{ status: string }> } };
    webhookStore: { list(t: string): Array<{ active: boolean }> };
    alertRoutingEngine: { listRules(t: string): unknown[] };
    configStore: { list(t: string): Array<{ is_default: boolean }> };
    scenarioStore: { list(f: { tenant_id: string }): unknown[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ruleStore: { list(f?: any): unknown[] };
    caseInvestigationStore: { list(t: string, f: Record<string, unknown>): { items: unknown[] } };
    auditTrailStore: { list(t: string, f: Record<string, unknown>): { items: unknown[]; total: number } };
    emailTransport: { recent(t: string, limit: number): unknown[] };
  }
): Promise<TenantProductionReadiness> {
  const generated_at = now.toISOString();
  const criteria: ProductionReadinessCriterion[] = [];

  // 1. onboarding_complete (100pts)
  const onboarding = deps.onboardingStore.get(tenant_id);
  criteria.push({
    name: 'onboarding_complete',
    points_earned: onboarding.is_complete ? 100 : 0,
    max_points: 100,
    passed: onboarding.is_complete,
    detail: onboarding.is_complete ? 'Onboarding wizard completed.' : 'Onboarding wizard not complete.',
  });

  // 2. has_api_keys (10pts)
  const keys = deps.apiKeyStore.list(tenant_id, 1, 100);
  const activeKeys = keys.items.filter((k) => k.status === 'active');
  const hasKeys = activeKeys.length > 0;
  criteria.push({
    name: 'has_api_keys',
    points_earned: hasKeys ? 10 : 0,
    max_points: 10,
    passed: hasKeys,
    detail: hasKeys ? `${activeKeys.length} active API key(s).` : 'No active API keys provisioned.',
  });

  // 3. has_webhooks (10pts)
  const webhooks = deps.webhookStore.list(tenant_id);
  const activeWebhooks = webhooks.filter((w) => w.active);
  const hasWebhooks = activeWebhooks.length > 0;
  criteria.push({
    name: 'has_webhooks',
    points_earned: hasWebhooks ? 10 : 0,
    max_points: 10,
    passed: hasWebhooks,
    detail: hasWebhooks ? `${activeWebhooks.length} active webhook(s).` : 'No active webhook subscriptions.',
  });

  // 4. alert_routing_customized (5pts)
  const routingRules = deps.alertRoutingEngine.listRules(tenant_id);
  // If there are overrides the engine will return them — check if any have source='tenant_override'
  // but listRules just returns RoutingDecision[] with source field
  const customized = routingRules.some((r) => {
    const rule = r as { source?: string };
    return rule.source === 'tenant_override';
  });
  criteria.push({
    name: 'alert_routing_customized',
    points_earned: customized ? 5 : 0,
    max_points: 5,
    passed: customized,
    detail: customized ? 'Alert routing customized.' : 'Using platform default alert routing.',
  });

  // 5. config_overrides_present (5pts)
  const configEntries = deps.configStore.list(tenant_id);
  const hasOverrides = configEntries.some((e) => !e.is_default);
  criteria.push({
    name: 'config_overrides_present',
    points_earned: hasOverrides ? 5 : 0,
    max_points: 5,
    passed: hasOverrides,
    detail: hasOverrides ? 'Tenant configuration customized.' : 'Using all platform defaults.',
  });

  // 6. has_scenarios (5pts)
  const scenarios = deps.scenarioStore.list({ tenant_id });
  const hasScenarios = scenarios.length > 0;
  criteria.push({
    name: 'has_scenarios',
    points_earned: hasScenarios ? 5 : 0,
    max_points: 5,
    passed: hasScenarios,
    detail: hasScenarios ? `${scenarios.length} saved scenario(s).` : 'No saved scenarios.',
  });

  // 7. has_custom_rules (10pts)
  const liveRules = deps.ruleStore.list({ state: 'live' });
  const hasRules = liveRules.length > 0;
  criteria.push({
    name: 'has_custom_rules',
    points_earned: hasRules ? 10 : 0,
    max_points: 10,
    passed: hasRules,
    detail: hasRules ? `${liveRules.length} live rule(s).` : 'No live rules configured.',
  });

  // 8. has_investigations (5pts)
  const investigations = deps.caseInvestigationStore.list(tenant_id, {});
  const hasInvestigations = investigations.items.length > 0;
  criteria.push({
    name: 'has_investigations',
    points_earned: hasInvestigations ? 5 : 0,
    max_points: 5,
    passed: hasInvestigations,
    detail: hasInvestigations ? `${investigations.items.length} investigation(s) recorded.` : 'No investigations recorded.',
  });

  // 9. audit_active (5pts)
  const auditPage = deps.auditTrailStore.list(tenant_id, { page_size: 1 });
  const auditActive = auditPage.total > 0;
  criteria.push({
    name: 'audit_active',
    points_earned: auditActive ? 5 : 0,
    max_points: 5,
    passed: auditActive,
    detail: auditActive ? `${auditPage.total} audit event(s).` : 'No audit events recorded.',
  });

  // 10. notifications_enabled (5pts)
  const emailSends = deps.emailTransport.recent(tenant_id, 1);
  const notificationsEnabled = emailSends.length > 0;
  criteria.push({
    name: 'notifications_enabled',
    points_earned: notificationsEnabled ? 5 : 0,
    max_points: 5,
    passed: notificationsEnabled,
    detail: notificationsEnabled ? 'Email notifications active.' : 'No email notifications sent.',
  });

  const total_score = criteria.reduce((s, c) => s + c.points_earned, 0);
  const max_possible = criteria.reduce((s, c) => s + c.max_points, 0);
  const normalized = Math.round((total_score / max_possible) * 100);

  let grade: 'A' | 'B' | 'C' | 'D';
  if (normalized >= 80) grade = 'A';
  else if (normalized >= 60) grade = 'B';
  else if (normalized >= 40) grade = 'C';
  else grade = 'D';

  const blocking_criteria = criteria
    .filter((c) => !c.passed && c.max_points >= 10)
    .map((c) => c.name);

  const next_steps = criteria
    .filter((c) => !c.passed)
    .map((c) => `Complete: ${c.name.replace(/_/g, ' ')}`);

  return {
    tenant_id,
    generated_at,
    readiness_score: normalized,
    readiness_grade: grade,
    criteria,
    blocking_criteria,
    next_steps,
  };
}
