// services/bff/src/notification_template_catalog.ts
//
// T6 M10.11 — Unified notification template catalog.
//
// M10.1 ships email templates. M10.2 ships SMS templates. M10.3 ships
// push templates. Each channel has its own list-templates route
// (4 templates × 3 channels = 12 templates today). M10.11 unifies
// them into a single picker-friendly catalog: per-template {channel,
// template_id, description, required_vars} so the SPA template-
// picker can enumerate everything in one dropdown grouped by channel
// without 3 round-trips + 3 different shapes.
//
// Pure — derives entirely from the three channel-specific listX
// functions. Platform-static (same response across tenants).

import { listTemplates as listEmailTemplates } from './notifications/email';
import { listSmsTemplates } from './notifications/sms';
import { listPushTemplates } from './notifications/push';

// ─── Public types ─────────────────────────────────────────────────────

export type NotificationChannelKey = 'email' | 'sms' | 'push';

export interface NotificationCatalogEntry {
  channel: NotificationChannelKey;
  template_id: string;
  description: string;
  required_vars: string[];
}

export interface NotificationTemplateCatalog {
  total_templates: number;
  by_channel: Record<NotificationChannelKey, number>;
  templates: NotificationCatalogEntry[];
  /** Union of all required_vars across every template, sorted asc.
   *  Useful for the SPA to enumerate "every variable any template
   *  might want" up-front for a form-builder. */
  distinct_required_vars: string[];
}

// ─── Pure introspector ────────────────────────────────────────────────

export function introspectNotificationTemplateCatalog(): NotificationTemplateCatalog {
  const templates: NotificationCatalogEntry[] = [];
  const distinct = new Set<string>();
  const by_channel: Record<NotificationChannelKey, number> = {
    email: 0,
    sms: 0,
    push: 0,
  };

  for (const t of listEmailTemplates()) {
    templates.push({
      channel: 'email',
      template_id: t.id,
      description: t.description,
      required_vars: [...t.required_vars],
    });
    by_channel.email += 1;
    for (const v of t.required_vars) distinct.add(v);
  }
  for (const t of listSmsTemplates()) {
    templates.push({
      channel: 'sms',
      template_id: t.id,
      description: t.description,
      required_vars: [...t.required_vars],
    });
    by_channel.sms += 1;
    for (const v of t.required_vars) distinct.add(v);
  }
  for (const t of listPushTemplates()) {
    templates.push({
      channel: 'push',
      template_id: t.id,
      description: t.description,
      required_vars: [...t.required_vars],
    });
    by_channel.push += 1;
    for (const v of t.required_vars) distinct.add(v);
  }

  templates.sort((a, b) => {
    if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
    return a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0;
  });

  return {
    total_templates: templates.length,
    by_channel,
    templates,
    distinct_required_vars: [...distinct].sort(),
  };
}
