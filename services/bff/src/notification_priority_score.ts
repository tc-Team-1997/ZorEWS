// services/bff/src/notification_priority_score.ts
// T6 M10.27 — Notification template priority scoring.

import { introspectNotificationTemplateCatalog } from './notification_template_catalog';

export type PriorityTier = 'critical' | 'high' | 'standard';

export interface TemplatePriorityRow {
  channel: string;
  template_id: string;
  urgency: number;
  channel_weight: number;
  priority_score: number;
  priority_tier: PriorityTier;
}

export interface NotificationPriorityScoreResult {
  generated_at: string;
  total_templates: number;
  templates: TemplatePriorityRow[];
  critical_templates: string[];
  high_priority_count: number;
}

const CHANNEL_WEIGHTS: Record<string, number> = {
  push: 1.2,
  sms: 1.1,
  email: 1.0,
};

function urgencyFor(template_id: string): number {
  const upper = template_id.toUpperCase();
  if (upper.includes('RED') || upper.includes('ALERT')) return 100;
  if (upper.includes('ORANGE')) return 80;
  return 50;
}

function tierFor(score: number): PriorityTier {
  if (score >= 110) return 'critical';
  if (score >= 80) return 'high';
  return 'standard';
}

export function buildNotificationPriorityScores(now: Date): NotificationPriorityScoreResult {
  const catalog = introspectNotificationTemplateCatalog();
  const rows: TemplatePriorityRow[] = [];

  for (const t of catalog.templates) {
    const urgency = urgencyFor(t.template_id);
    const channel_weight = CHANNEL_WEIGHTS[t.channel] ?? 1.0;
    const priority_score = Math.round(urgency * channel_weight * 100) / 100;
    const priority_tier = tierFor(priority_score);

    rows.push({
      channel: t.channel,
      template_id: t.template_id,
      urgency,
      channel_weight,
      priority_score,
      priority_tier,
    });
  }

  rows.sort((a, b) => b.priority_score - a.priority_score);

  const critical_templates = rows
    .filter((r) => r.priority_tier === 'critical')
    .map((r) => r.template_id);
  const high_priority_count = rows.filter((r) => r.priority_tier === 'high').length;

  return {
    generated_at: now.toISOString(),
    total_templates: rows.length,
    templates: rows,
    critical_templates,
    high_priority_count,
  };
}
