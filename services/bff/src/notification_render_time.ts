/**
 * M10.23 — Notification template render time estimate
 * Estimates rendering complexity for each notification template.
 */

import { introspectNotificationTemplateCatalog } from './notification_template_catalog';

export type ComplexityTier = 'fast' | 'normal' | 'slow';

export interface TemplateRenderTime {
  channel: string;
  template_id: string;
  required_var_count: number;
  estimated_render_ms: number;
  complexity_tier: ComplexityTier;
}

export interface NotificationRenderTimeReport {
  generated_at: string;
  total_templates: number;
  templates: TemplateRenderTime[];
  avg_render_ms: number;
  slowest_template: string | null;
}

function estimateRenderMs(
  channel: string,
  template_id: string,
  required_var_count: number,
): number {
  let base = 50;
  // Channel overhead
  if (channel === 'email') base += 20; // HTML rendering
  if (channel === 'sms') base += 5;    // Short, minimal processing
  // Per required variable
  base += required_var_count * 10;
  return base;
}

function tierFor(ms: number): ComplexityTier {
  if (ms < 60) return 'fast';
  if (ms <= 100) return 'normal';
  return 'slow';
}

export function buildNotificationRenderTimes(
  now: Date = new Date(),
): NotificationRenderTimeReport {
  const catalog = introspectNotificationTemplateCatalog();

  const templates: TemplateRenderTime[] = catalog.templates.map((t) => {
    const required_var_count = t.required_vars.length;
    const estimated_render_ms = estimateRenderMs(t.channel, t.template_id, required_var_count);
    return {
      channel: t.channel,
      template_id: t.template_id,
      required_var_count,
      estimated_render_ms,
      complexity_tier: tierFor(estimated_render_ms),
    };
  });

  // Sort by estimated_render_ms desc
  templates.sort((a, b) => b.estimated_render_ms - a.estimated_render_ms);

  const avg_render_ms =
    templates.length > 0
      ? templates.reduce((s, t) => s + t.estimated_render_ms, 0) / templates.length
      : 0;

  const slowest_template = templates.length > 0 ? templates[0].template_id : null;

  return {
    generated_at: now.toISOString(),
    total_templates: templates.length,
    templates,
    avg_render_ms,
    slowest_template,
  };
}
