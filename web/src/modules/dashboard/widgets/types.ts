// Phase 3 — Dashboard Foundation: widget architecture types.
//
// Config-driven dashboard contract. Widgets are declared as METADATA in
// widgetRegistry.ts (NOT hardcoded inside pages); roleWidgetMapping.ts
// gates them by role; dashboardConfig.ts orders them per domain; and the
// pure resolveWidgets() composes the three into the ordered list a
// dashboard shell renders. This is the foundation layer — the React
// component binding + live data wiring land in follow-up increments,
// reusing the existing BFF dashboard endpoints (see ADOPTION below).

import type { DomainChoice } from '@/lib/useOnboardingContext';

/** A widget belongs to one domain, or 'both' for cross-domain widgets. */
export type WidgetDomain = DomainChoice | 'both';

/** Coarse semantic bucket used by roleWidgetMapping to gate visibility.
 *  Kept deliberately small so role rules stay legible. */
export type WidgetCategory = 'overview' | 'risk' | 'fraud' | 'collections';

/** Grid span (in the 3-column workspace grid). */
export type WidgetSpan = 1 | 2 | 3;

/** Declarative widget definition — pure metadata, no React/data here.
 *  The future renderer maps `id` → a component; `dataSource` is the seam
 *  where a widget's data hook / BFF endpoint / AI service plugs in. */
export interface WidgetDef {
  id: string;
  title: string;
  /** One-line description for tooltips + the admin widget catalogue. */
  description: string;
  domain: WidgetDomain;
  category: WidgetCategory;
  /** Permissions the viewer must ALL hold to see this widget. Empty =
   *  no permission gate (role gate via roleWidgetMapping still applies). */
  requiredPermissions: string[];
  /** Default column span in the workspace grid. */
  defaultSpan: WidgetSpan;
  /** True when the widget is designed to host an AI/analytics panel in a
   *  later phase — the integration seam is reserved now. */
  aiReady: boolean;
  /** Where the widget will source data once wired — an existing BFF
   *  endpoint or a future one. Documentation seam; not fetched yet. */
  dataSource: string;
}

/** Per-role widget-visibility rule: the categories a role may see, or
 *  '*' for every category. Keyed by role id (backend Role OR an
 *  enterprise role id — see roleWidgetMapping for the forward-compat
 *  note). */
export type RoleWidgetRule = WidgetCategory[] | '*';

/** A widget resolved for a specific (domain, roles, permissions) context,
 *  carrying its layout position. This is what a dashboard shell renders. */
export interface ResolvedWidget extends WidgetDef {
  /** 0-based position in the resolved layout (dashboardConfig order). */
  order: number;
}

/** Inputs to resolveWidgets — the live workspace context. `roles` is
 *  intentionally `string[]` (not the strict 5-value backend Role union)
 *  so enterprise role ids (fraud_analyst, claims_investigator, …) flow
 *  through unchanged when they reach the frontend. */
export interface WidgetContext {
  domain: DomainChoice;
  roles: string[];
  /** Viewer's permission grants. Optional — defaults to none; widgets
   *  with requiredPermissions stay hidden until permissions are wired. */
  permissions?: string[];
}
