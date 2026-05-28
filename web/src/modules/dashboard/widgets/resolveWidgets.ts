// Phase 3 — Dashboard Foundation: the widget resolver.
//
// Pure function (no React, no I/O) that composes the three config layers
// into the ordered widget list a dashboard shell renders:
//
//   1. domain   → widgetsForDomain (registry)
//   2. roles    → allowed categories (roleWidgetMapping, unioned)
//   3. perms    → requiredPermissions ⊆ viewer permissions
//   4. order    → dashboardConfig.layout, unlisted widgets last (id asc)
//
// Fully testable in isolation — the heart of config-driven, role-aware,
// domain-aware rendering.

import type { ResolvedWidget, WidgetCategory, WidgetContext } from './types';
import { widgetsForDomain } from './widgetRegistry';
import {
  ROLE_WIDGET_MAPPING,
  DEFAULT_ROLE_RULE,
} from './roleWidgetMapping';
import { layoutOrder } from './dashboardConfig';

/** Union the category rules across a viewer's roles. Returns '*' when any
 *  role grants all categories; otherwise the deduped category set. An
 *  empty/unknown role list falls back to DEFAULT_ROLE_RULE. */
export function allowedCategories(roles: string[]): WidgetCategory[] | '*' {
  if (roles.length === 0) {
    return DEFAULT_ROLE_RULE;
  }
  const acc = new Set<WidgetCategory>();
  for (const role of roles) {
    const rule = ROLE_WIDGET_MAPPING[role] ?? DEFAULT_ROLE_RULE;
    if (rule === '*') return '*';
    for (const c of rule) acc.add(c);
  }
  if (acc.size === 0) {
    // Every role was unknown → safe default.
    for (const c of DEFAULT_ROLE_RULE === '*' ? [] : DEFAULT_ROLE_RULE) acc.add(c);
  }
  return [...acc];
}

/** Resolve the ordered, role/domain/permission-filtered widget set for a
 *  workspace context. */
export function resolveWidgets(ctx: WidgetContext): ResolvedWidget[] {
  const { domain, roles } = ctx;
  const permissions = ctx.permissions ?? [];

  const cats = allowedCategories(roles);
  const catAllowed = (c: WidgetCategory): boolean => cats === '*' || cats.includes(c);

  const visible = widgetsForDomain(domain)
    .filter((w) => catAllowed(w.category))
    .filter((w) => w.requiredPermissions.every((p) => permissions.includes(p)));

  // Order by the domain layout (unlisted last), then id asc as a stable
  // tie-break so the output is deterministic.
  visible.sort((a, b) => {
    const oa = layoutOrder(domain, a.id);
    const ob = layoutOrder(domain, b.id);
    if (oa !== ob) return oa - ob;
    return a.id.localeCompare(b.id);
  });

  return visible.map((w, i) => ({ ...w, order: i }));
}
