// services/bff/src/admin/notification_template_render.ts
//
// Pure mustache-flavoured renderer for notification_templates (T6
// M14.24). Used by:
//   - the admin Preview route (render-only, no side effect)
//   - the admin Test-fire route (render + append to dispatch log)
//   - future: M14.23 case-create pipeline + M14.25 escalation worker,
//     which both consume the same render() to produce the actual
//     subject/body that hits email/SMS providers.
//
// Syntax (kept tight on purpose — fits the BAC §3.1.6 admin UX):
//
//   {{variable}}                     → value (HTML-safe; we don't escape
//                                       since the templates are plain text)
//   {{variable | default: "x"}}      → fallback when variable is missing
//                                       or the value is null/undefined/""
//
// No conditionals, no loops, no helpers — those add a parser. If a
// variable is referenced but not provided AND no default is set, the
// renderer collects it into `missing_vars` (so the SPA can warn the
// admin before they hit Send) but still substitutes a visible
// `{{variable}}` placeholder so a partially-rendered preview is
// readable.

import type {
  NotificationChannel,
  NotificationTemplate,
} from './case_scenarios_types';

export interface RenderContext {
  /** Tenant — surfaced in the dispatch log so cross-tenant audit
   *  works the same as the admin_audit_log pattern. */
  tenant_id: string;
  /** Mustache substitution map. Coerced to string via String(value);
   *  null + undefined are treated as "missing". */
  vars: Record<string, unknown>;
}

export interface RenderResult {
  channel: NotificationChannel;
  /** NULL for SMS (DB CHECK), else the rendered subject. */
  subject: string | null;
  body: string;
  /** Vars referenced by the template that weren't provided AND had no
   *  `| default:` clause. The render still completes (with visible
   *  placeholders) so the preview is useful, but callers can decide
   *  whether to refuse the dispatch. */
  missing_vars: string[];
  /** Vars used by at least one substitution. Distinct from
   *  Object.keys(vars) — only the ones the template actually mentions. */
  used_vars: string[];
}

const TOKEN_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*default:\s*"([^"]*)"\s*)?\}\}/g;

function renderField(
  template: string,
  vars: Record<string, unknown>,
  used: Set<string>,
  missing: Set<string>,
): string {
  return template.replace(TOKEN_RE, (full, name: string, def?: string) => {
    used.add(name);
    const v = vars[name];
    const present = v !== null && v !== undefined && !(typeof v === 'string' && v.length === 0);
    if (present) return String(v);
    if (def !== undefined) return def;
    missing.add(name);
    return full; // leave the literal {{name}} placeholder so admins see what's missing
  });
}

/**
 * Pure render. No IO, no audit side-effect. Safe to call from anywhere
 * (preview, test-fire, runtime dispatch).
 */
export function renderTemplate(
  template: NotificationTemplate,
  ctx: RenderContext,
): RenderResult {
  const used = new Set<string>();
  const missing = new Set<string>();
  const subject =
    template.subject !== null
      ? renderField(template.subject, ctx.vars, used, missing)
      : null;
  const body = renderField(template.body, ctx.vars, used, missing);
  return {
    channel: template.channel,
    subject,
    body,
    missing_vars: [...missing].sort(),
    used_vars: [...used].sort(),
  };
}
