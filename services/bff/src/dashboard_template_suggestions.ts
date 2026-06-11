// services/bff/src/dashboard_template_suggestions.ts
// T6 M11.26 — Dashboard cross-tenant template suggestions.

import { listStarterPacks } from './dashboard_starter_packs';
import { defaultCustomDashboardStore, type CustomDashboardStore } from './custom_dashboards';

export type SuggestionStrength = 'already_covered' | 'partial_match' | 'new_opportunity';

export interface DashboardTemplateSuggestion {
  pack_id: string;
  pack_name: string;
  match_score: number;
  suggestion_strength: SuggestionStrength;
  missing_widget_types: string[];
}

export interface DashboardTemplateSuggestions {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  suggestions: DashboardTemplateSuggestion[];
  already_covered_packs: string[];
}

const STRENGTH_ORDER: SuggestionStrength[] = ['new_opportunity', 'partial_match', 'already_covered'];

export function buildDashboardTemplateSuggestions(
  tenant_id: string,
  store: CustomDashboardStore,
  now: Date,
): DashboardTemplateSuggestions {
  const dashboards = store.list(tenant_id);
  const catalog = listStarterPacks();

  // Collect all widget_types across the tenant's dashboards
  const tenantWidgetTypes = new Set<string>();
  for (const d of dashboards) {
    for (const w of d.widgets) {
      tenantWidgetTypes.add(w.widget_type);
    }
  }

  const suggestions: DashboardTemplateSuggestion[] = catalog.packs.map((pack) => {
    const packWidgetTypes = pack.widgets.map((w) => w.widget_type);
    const totalPack = packWidgetTypes.length;
    let matched = 0;
    const missing_widget_types: string[] = [];
    for (const wt of packWidgetTypes) {
      if (tenantWidgetTypes.has(wt)) matched++;
      else if (!missing_widget_types.includes(wt)) missing_widget_types.push(wt);
    }
    const match_score = totalPack > 0 ? matched / totalPack : 0;

    let suggestion_strength: SuggestionStrength;
    if (match_score >= 0.8) suggestion_strength = 'already_covered';
    else if (match_score >= 0.3) suggestion_strength = 'partial_match';
    else suggestion_strength = 'new_opportunity';

    return { pack_id: pack.pack_id, pack_name: pack.name, match_score: Math.round(match_score * 10000) / 10000, suggestion_strength, missing_widget_types };
  });

  // Sort: new_opportunity first, then partial_match, then already_covered
  suggestions.sort((a, b) => {
    const ra = STRENGTH_ORDER.indexOf(a.suggestion_strength);
    const rb = STRENGTH_ORDER.indexOf(b.suggestion_strength);
    return ra - rb;
  });

  const already_covered_packs = suggestions.filter((s) => s.suggestion_strength === 'already_covered').map((s) => s.pack_id);

  return { tenant_id, generated_at: now.toISOString(), total_dashboards: dashboards.length, suggestions, already_covered_packs };
}

export { defaultCustomDashboardStore };
