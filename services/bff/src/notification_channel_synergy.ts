// services/bff/src/notification_channel_synergy.ts
// T6 M10.28 — Notification channel synergy analysis

import { type AlertRoutingEngine } from './alert_routing';
import { BIL_CLASS_ORDER, type BilAlertClass } from './bil_alert_classification';

export interface ChannelCombo {
  combo: string;
  classes_using_it: BilAlertClass[];
  coverage_pct: number;
}

export interface NotificationChannelSynergy {
  tenant_id: string;
  generated_at: string;
  combos: ChannelCombo[];
  single_channel_classes: BilAlertClass[];
  multi_channel_classes: BilAlertClass[];
  channel_diversity_score: number;
  most_synergistic_combo: string | null;
}

export function buildNotificationChannelSynergy(
  engine: AlertRoutingEngine,
  tenant_id: string,
  now: Date
): NotificationChannelSynergy {
  const generated_at = now.toISOString();
  const rules = engine.listRules(tenant_id);

  const totalClasses = BIL_CLASS_ORDER.length;

  // Map class -> channels
  const classChannelMap = new Map<BilAlertClass, string[]>();
  for (const rule of rules) {
    const cls = rule.class as BilAlertClass;
    const channels = rule.channels ?? [];
    classChannelMap.set(cls, channels.map(String).sort());
  }

  // Group by channel combo
  const comboMap = new Map<string, BilAlertClass[]>();
  for (const [cls, channels] of classChannelMap.entries()) {
    const combo = channels.join(',') || '(none)';
    if (!comboMap.has(combo)) comboMap.set(combo, []);
    comboMap.get(combo)!.push(cls);
  }

  const combos: ChannelCombo[] = Array.from(comboMap.entries())
    .map(([combo, classes]) => ({
      combo,
      classes_using_it: classes,
      coverage_pct: Math.round((classes.length / totalClasses) * 100),
    }))
    .sort((a, b) => b.coverage_pct - a.coverage_pct);

  const single_channel_classes: BilAlertClass[] = [];
  const multi_channel_classes: BilAlertClass[] = [];

  for (const [cls, channels] of classChannelMap.entries()) {
    if (channels.length <= 1) single_channel_classes.push(cls);
    else multi_channel_classes.push(cls);
  }

  // Channel diversity: distinct channels across all rules / 4 * 100
  const allChannels = new Set<string>();
  for (const channels of classChannelMap.values()) {
    for (const ch of channels) allChannels.add(ch);
  }
  const channel_diversity_score = Math.round((allChannels.size / 4) * 100);

  const most_synergistic_combo = combos.length > 0 ? combos[0]!.combo : null;

  return {
    tenant_id,
    generated_at,
    combos,
    single_channel_classes,
    multi_channel_classes,
    channel_diversity_score,
    most_synergistic_combo,
  };
}
