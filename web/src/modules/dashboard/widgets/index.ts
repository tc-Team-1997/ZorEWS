// Phase 3 — Dashboard Foundation: widget architecture barrel.
//
// Public surface of the config-driven dashboard layer. A dashboard shell
// imports resolveWidgets + WidgetContainer + the config; pages never
// hardcode widgets. The React component-binding map + live data wiring
// arrive in the renderer increment (see ADOPTION in the Phase 3 notes).

export type {
  WidgetDef,
  WidgetDomain,
  WidgetCategory,
  WidgetSpan,
  RoleWidgetRule,
  ResolvedWidget,
  WidgetContext,
} from './types';
export {
  WIDGET_REGISTRY,
  getWidgetDef,
  widgetsForDomain,
} from './widgetRegistry';
export { ROLE_WIDGET_MAPPING, DEFAULT_ROLE_RULE } from './roleWidgetMapping';
export {
  DASHBOARD_CONFIG,
  layoutOrder,
  type DomainDashboardConfig,
} from './dashboardConfig';
export { resolveWidgets, allowedCategories } from './resolveWidgets';
export { WidgetContainer } from './WidgetContainer';
