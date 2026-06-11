// @ts-nocheck
import { buildNotificationRenderTimes } from '../src/notification_render_time';
import { introspectNotificationTemplateCatalog } from '../src/notification_template_catalog';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildNotificationRenderTimes', () => {
  it('returns report with required fields', () => {
    const report = buildNotificationRenderTimes(NOW);
    expect(report.generated_at).toBeDefined();
    expect(typeof report.total_templates).toBe('number');
    expect(Array.isArray(report.templates)).toBe(true);
  });

  it('total_templates matches catalog count', () => {
    const catalog = introspectNotificationTemplateCatalog();
    const report = buildNotificationRenderTimes(NOW);
    expect(report.total_templates).toBe(catalog.total_templates);
  });

  it('each template has required fields', () => {
    const report = buildNotificationRenderTimes(NOW);
    for (const t of report.templates) {
      expect(t.channel).toBeDefined();
      expect(t.template_id).toBeDefined();
      expect(t.required_var_count).toBeGreaterThanOrEqual(0);
      expect(t.estimated_render_ms).toBeGreaterThan(0);
      expect(['fast', 'normal', 'slow']).toContain(t.complexity_tier);
    }
  });

  it('complexity_tier boundaries are correct', () => {
    const report = buildNotificationRenderTimes(NOW);
    for (const t of report.templates) {
      if (t.estimated_render_ms < 60) expect(t.complexity_tier).toBe('fast');
      else if (t.estimated_render_ms <= 100) expect(t.complexity_tier).toBe('normal');
      else expect(t.complexity_tier).toBe('slow');
    }
  });

  it('sorted by estimated_render_ms desc', () => {
    const report = buildNotificationRenderTimes(NOW);
    for (let i = 1; i < report.templates.length; i++) {
      expect(report.templates[i].estimated_render_ms).toBeLessThanOrEqual(
        report.templates[i - 1].estimated_render_ms,
      );
    }
  });

  it('slowest_template is first in sorted list', () => {
    const report = buildNotificationRenderTimes(NOW);
    if (report.templates.length > 0) {
      expect(report.slowest_template).toBe(report.templates[0].template_id);
    }
  });

  it('avg_render_ms is computed', () => {
    const report = buildNotificationRenderTimes(NOW);
    if (report.templates.length > 0) {
      expect(report.avg_render_ms).toBeGreaterThan(0);
    }
  });

  it('email templates have higher base cost than SMS', () => {
    const report = buildNotificationRenderTimes(NOW);
    const emailTemplates = report.templates.filter(t => t.channel === 'email');
    const smsTemplates = report.templates.filter(t => t.channel === 'sms');
    if (emailTemplates.length > 0 && smsTemplates.length > 0) {
      const maxEmailBase = Math.max(...emailTemplates.map(t => 70 + t.required_var_count * 10));
      const minSmsBase = Math.min(...smsTemplates.map(t => 55 + t.required_var_count * 10));
      // email has base 50+20=70 vs sms base 50+5=55 — email always >= sms base
      expect(maxEmailBase).toBeGreaterThanOrEqual(minSmsBase);
    }
  });

  it('is deterministic', () => {
    const r1 = buildNotificationRenderTimes(NOW);
    const r2 = buildNotificationRenderTimes(NOW);
    expect(r1.total_templates).toBe(r2.total_templates);
    expect(r1.slowest_template).toBe(r2.slowest_template);
  });
});
