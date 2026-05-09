// services/notification-svc/src/templates/email.ts
//
// Minimal HTML template for the alert email. Uses ${alert.summary} placeholders;
// kept small and inline so we don't ship a templating engine for the prototype.

import type { AlertSummary } from '../types';

export interface RenderedEmail {
  subject: string;
  body: string;
}

export function renderAlertEmail(alert: AlertSummary, displayName?: string): RenderedEmail {
  const subject = `[ZorEWS] ${alert.severity} alert · ${alert.rule_id ?? alert.alert_id}`;
  const greeting = displayName ? `Hi ${displayName},` : 'Hi,';
  const summary = alert.reason_summary ?? 'An alert was raised on your portfolio.';
  const pdRow =
    alert.pd != null
      ? `<tr><td><strong>PD</strong></td><td>${(alert.pd * 100).toFixed(1)}%</td></tr>`
      : '';
  const levelRow = alert.risk_level
    ? `<tr><td><strong>Risk level</strong></td><td>${alert.risk_level}</td></tr>`
    : '';
  const body = `<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#2C2C2A;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <h2 style="color:#0D2B6A;margin:0 0 8px;">ZorEWS alert</h2>
    <p>${greeting}</p>
    <p>${escapeHtml(summary)}</p>
    <table style="border-collapse:collapse;margin:12px 0;">
      <tr><td><strong>Alert id</strong></td><td>${alert.alert_id}</td></tr>
      <tr><td><strong>Severity</strong></td><td>${alert.severity}</td></tr>
      <tr><td><strong>Customer</strong></td><td>${alert.customer_id}</td></tr>
      <tr><td><strong>Rule</strong></td><td>${alert.rule_id ?? '—'}</td></tr>
      ${pdRow}
      ${levelRow}
      <tr><td><strong>Raised at</strong></td><td>${alert.raised_at}</td></tr>
    </table>
    <p style="font-size:12px;color:#6b7280;">You receive this because your role subscribes to ZorEWS regulatory alerts. Reply to this email or open the case in the EWS console to take action.</p>
  </div>
</body></html>`;
  return { subject, body };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
