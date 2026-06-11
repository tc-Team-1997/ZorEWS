// @ts-nocheck
import { describe, it, expect } from '@jest/globals';
import { makeApp } from '../src/server';
import supertest from 'supertest';
import { buildNotificationChannelSynergy } from '../src/notification_channel_synergy';
import { InMemoryAlertRoutingEngine } from '../src/alert_routing';

const NOW = new Date('2026-06-11T12:00:00Z');

describe('buildNotificationChannelSynergy', () => {
  it('returns combos array', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = buildNotificationChannelSynergy(engine, 'BIL', NOW);
    expect(Array.isArray(out.combos)).toBe(true);
  });

  it('has required envelope fields', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = buildNotificationChannelSynergy(engine, 'BIL', NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBeDefined();
    expect(typeof out.channel_diversity_score).toBe('number');
    expect(Array.isArray(out.single_channel_classes)).toBe(true);
    expect(Array.isArray(out.multi_channel_classes)).toBe(true);
  });

  it('channel_diversity_score is in [0, 100]', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = buildNotificationChannelSynergy(engine, 'BIL', NOW);
    expect(out.channel_diversity_score).toBeGreaterThanOrEqual(0);
    expect(out.channel_diversity_score).toBeLessThanOrEqual(100);
  });

  it('most_synergistic_combo is the first combo', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = buildNotificationChannelSynergy(engine, 'BIL', NOW);
    if (out.combos.length > 0) {
      expect(out.most_synergistic_combo).toBe(out.combos[0].combo);
    } else {
      expect(out.most_synergistic_combo).toBeNull();
    }
  });

  it('coverage_pct in [0, 100] for all combos', () => {
    const engine = new InMemoryAlertRoutingEngine();
    const out = buildNotificationChannelSynergy(engine, 'BIL', NOW);
    for (const combo of out.combos) {
      expect(combo.coverage_pct).toBeGreaterThanOrEqual(0);
      expect(combo.coverage_pct).toBeLessThanOrEqual(100);
    }
  });
});

describe('GET /v1/notifications/channel-synergy', () => {
  it('returns 200 for admin', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/notifications/channel-synergy')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.combos)).toBe(true);
  });

  it('returns 403 for field_officer', async () => {
    const { app } = makeApp({});
    const res = await supertest(app)
      .get('/v1/notifications/channel-synergy')
      .set('X-Tenant-ID', 'BIL').set('X-Channel', 'API').set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
