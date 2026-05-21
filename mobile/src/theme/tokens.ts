// mobile/src/theme/tokens.ts
//
// Design tokens mirroring DMS_Network reference (the SPA's
// `web/src/styles/tokens.ts`). Kept slim — the mobile shell renders
// 3 screens + login.

export const colors = {
  brand_navy: '#0f1d3c',
  brand_blue: '#1a3a8a',
  brand_sky: '#3d6fd8',
  ink: '#1f2937',
  ink_subtle: '#6b7280',
  divider: '#e5e7eb',
  surface: '#ffffff',
  surface_alt: '#f9fafb',
  // Semantic — drive the alert-severity badge.
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#d97706',
  low: '#65a30d',
  // Status semantics — match SPA palette.
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const typography = {
  title: { fontSize: 24, fontWeight: '700' as const },
  heading: { fontSize: 18, fontWeight: '600' as const },
  body: { fontSize: 14, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const, color: colors.ink_subtle },
} as const;

export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
} as const;

/** Severity → token resolver — drives the SPA's Badge component. */
export function severityColor(severity: 'critical' | 'high' | 'medium' | 'low'): string {
  return colors[severity];
}
