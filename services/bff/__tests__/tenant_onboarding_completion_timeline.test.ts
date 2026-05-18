// services/bff/__tests__/tenant_onboarding_completion_timeline.test.ts
//
// T6 M2.16 — Onboarding step completion daily timeline.

import request from 'supertest';
import {
  summarizeOnboardingCompletionTimeline,
  OnboardingCompletionTimelineError,
  DEFAULT_ONBOARDING_DAILY_WINDOW,
  MAX_ONBOARDING_DAILY_WINDOW,
} from '../src/tenant_onboarding_completion_timeline';
import {
  InMemoryOnboardingStore,
  type OnboardingStore,
  type StepProgress,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCtApp(role: string = 'admin', onboardingStore?: OnboardingStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    onboardingStore: onboardingStore ?? new InMemoryOnboardingStore(),
  });
}

function step(
  id: string,
  status: 'completed' | 'skipped' | 'pending',
  at: string | null,
): StepProgress {
  return {
    step_id: id as never,
    status: status as never,
    completed_at: status === 'pending' ? null : at,
    completed_by: status === 'pending' ? null : 'alice',
    notes: null,
    skip_reason: null,
  };
}

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M2.16 — empty fleet', () => {
  test('zero tenants → 30 zero buckets + null leaderboard', () => {
    const s = summarizeOnboardingCompletionTimeline([], 30, NOW);
    expect(s.total_tenants_scanned).toBe(0);
    expect(s.total_actions_in_window).toBe(0);
    expect(s.by_day.length).toBe(30);
    for (const b of s.by_day) {
      expect(b.total).toBe(0);
      expect(b.completed_count).toBe(0);
      expect(b.skipped_count).toBe(0);
      expect(b.distinct_tenants).toBe(0);
    }
    expect(s.peak_day).toBeNull();
    expect(s.mean_per_day).toBe(0);
    expect(s.growth_rate).toBeNull();
  });
});

describe('M2.16 — window mechanics', () => {
  test('default 30-day window starts Apr 20 ends May 19', () => {
    const s = summarizeOnboardingCompletionTimeline([], 30, NOW);
    expect(s.days).toBe(30);
    expect(s.window_start).toBe('2026-04-20');
    expect(s.window_end).toBe('2026-05-19');
    expect(s.by_day[0].date).toBe('2026-04-20');
    expect(s.by_day[29].date).toBe('2026-05-19');
  });

  test('days=1 → 1 bucket on NOW UTC date', () => {
    const s = summarizeOnboardingCompletionTimeline([], 1, NOW);
    expect(s.by_day.length).toBe(1);
    expect(s.by_day[0].date).toBe('2026-05-19');
  });
});

describe('M2.16 — pending steps not counted', () => {
  test('pending status skipped', () => {
    const fleet = [
      { tenant_id: 't1', steps: [step('tenant_provisioned', 'pending', null)] },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    expect(s.total_actions_in_window).toBe(0);
    expect(s.total_actions_observed).toBe(0);
  });
});

describe('M2.16 — single completion placement', () => {
  test('1 step completed today → today\'s bucket count=1', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [step('tenant_provisioned', 'completed', NOW.toISOString())],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    const today = s.by_day.find((b) => b.date === '2026-05-19')!;
    expect(today.total).toBe(1);
    expect(today.completed_count).toBe(1);
    expect(today.skipped_count).toBe(0);
    expect(today.distinct_tenants).toBe(1);
    expect(s.total_actions_in_window).toBe(1);
  });
});

describe('M2.16 — completed + skipped both counted in total', () => {
  test('1 completed + 1 skipped → total=2', () => {
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', NOW.toISOString()),
          step('operator_invited', 'skipped', NOW.toISOString()),
        ],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    const today = s.by_day.find((b) => b.date === '2026-05-19')!;
    expect(today.total).toBe(2);
    expect(today.completed_count).toBe(1);
    expect(today.skipped_count).toBe(1);
  });
});

describe('M2.16 — distinct_tenants per day', () => {
  test('2 tenants both completing same day → distinct_tenants=2', () => {
    const ts = NOW.toISOString();
    const fleet = [
      { tenant_id: 't1', steps: [step('tenant_provisioned', 'completed', ts)] },
      { tenant_id: 't2', steps: [step('tenant_provisioned', 'completed', ts)] },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    const today = s.by_day.find((b) => b.date === '2026-05-19')!;
    expect(today.total).toBe(2);
    expect(today.distinct_tenants).toBe(2);
  });

  test('same tenant 2 actions same day → distinct_tenants=1', () => {
    const ts = NOW.toISOString();
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', ts),
          step('channels_configured', 'completed', ts),
        ],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    const today = s.by_day.find((b) => b.date === '2026-05-19')!;
    expect(today.total).toBe(2);
    expect(today.distinct_tenants).toBe(1);
  });
});

describe('M2.16 — actions outside window dropped from in_window', () => {
  test('100-day-old action → not in any bucket but counted in observed', () => {
    const oldTs = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('tenant_provisioned', 'completed', oldTs),
          step('channels_configured', 'completed', NOW.toISOString()),
        ],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    expect(s.total_actions_in_window).toBe(1);
    expect(s.total_actions_observed).toBe(2);
  });
});

describe('M2.16 — peak_day formula', () => {
  test('highest-count day wins; earliest-day-wins tie-break', () => {
    const dayA = '2026-05-10T12:00:00.000Z';
    const dayB = '2026-05-15T12:00:00.000Z';
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('a', 'completed', dayA),
          step('b', 'completed', dayB),
          step('c', 'completed', dayB),
        ],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    expect(s.peak_day).toBe('2026-05-15');
    expect(s.peak_count).toBe(2);
  });

  test('earliest-day-wins at tied counts', () => {
    const dayA = '2026-05-10T12:00:00.000Z';
    const dayB = '2026-05-15T12:00:00.000Z';
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('a', 'completed', dayA),
          step('b', 'completed', dayB),
        ],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    expect(s.peak_day).toBe('2026-05-10');
  });
});

describe('M2.16 — mean_per_day', () => {
  test('round(total/days)', () => {
    const ts = NOW.toISOString();
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('a', 'completed', ts),
          step('b', 'completed', ts),
          step('c', 'completed', ts),
        ],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    expect(s.mean_per_day).toBe(0); // round(3/30)
  });
});

describe('M2.16 — growth_rate', () => {
  test('positive when second-half busier', () => {
    const firstHalf = '2026-04-22T12:00:00.000Z';
    const secondHalf = '2026-05-10T12:00:00.000Z';
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('a', 'completed', firstHalf),
          step('b', 'completed', secondHalf),
          step('c', 'completed', secondHalf),
          step('d', 'completed', secondHalf),
        ],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    expect(s.growth_rate).not.toBeNull();
    expect(s.growth_rate! > 0).toBe(true);
  });

  test('null when first-half=0', () => {
    const recent = '2026-05-10T12:00:00.000Z';
    const fleet = [
      { tenant_id: 't1', steps: [step('a', 'completed', recent)] },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    expect(s.growth_rate).toBeNull();
  });

  test('null when days=1', () => {
    const fleet = [
      { tenant_id: 't1', steps: [step('a', 'completed', NOW.toISOString())] },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 1, NOW);
    expect(s.growth_rate).toBeNull();
  });
});

describe('M2.16 — partition invariant', () => {
  test('Σ by_day.total = total_actions_in_window', () => {
    const ts = NOW.toISOString();
    const fleet = [
      {
        tenant_id: 't1',
        steps: [
          step('a', 'completed', ts),
          step('b', 'completed', ts),
          step('c', 'skipped', ts),
        ],
      },
    ];
    const s = summarizeOnboardingCompletionTimeline(fleet, 30, NOW);
    const sum = s.by_day.reduce((acc, b) => acc + b.total, 0);
    expect(sum).toBe(s.total_actions_in_window);
  });
});

describe('M2.16 — invalid days', () => {
  test('throws on days=0', () => {
    expect(() => summarizeOnboardingCompletionTimeline([], 0, NOW))
      .toThrow(OnboardingCompletionTimelineError);
  });

  test('throws on days=366', () => {
    expect(() => summarizeOnboardingCompletionTimeline([], 366, NOW))
      .toThrow(OnboardingCompletionTimelineError);
  });

  test('accepts days=365 at boundary', () => {
    const s = summarizeOnboardingCompletionTimeline([], 365, NOW);
    expect(s.by_day.length).toBe(365);
  });

  test('throws on non-integer', () => {
    expect(() => summarizeOnboardingCompletionTimeline([], 3.5, NOW))
      .toThrow(OnboardingCompletionTimelineError);
  });
});

describe('M2.16 — exported constants', () => {
  test('DEFAULT + MAX exposed', () => {
    expect(DEFAULT_ONBOARDING_DAILY_WINDOW).toBe(30);
    expect(MAX_ONBOARDING_DAILY_WINDOW).toBe(365);
  });
});

describe('M2.16 — generated_at echo', () => {
  test('ISO timestamp echoed', () => {
    const s = summarizeOnboardingCompletionTimeline([], 30, NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M2.16 — GET /v1/tenants/onboarding/completion-timeline', () => {
  test('admin → 200 with default 30-day window (empty)', async () => {
    const { app } = makeCtApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/completion-timeline')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.by_day.length).toBe(30);
    expect(r.body.body.total_actions_in_window).toBe(0);
  });

  test('populated → reflects markStep across tenants', async () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('BANK_DEMO', 'tenant_provisioned', 'completed', 'alice', null, NOW);
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'bob', null, NOW);
    const { app } = makeCtApp('admin', store);
    const r = await request(app)
      .get('/v1/tenants/onboarding/completion-timeline')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_actions_in_window).toBe(2);
    expect(r.body.body.peak_day).toBe('2026-05-19');
  });

  test('?days=7 narrows window', async () => {
    const { app } = makeCtApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/completion-timeline?days=7')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.by_day.length).toBe(7);
  });

  test('?days=0 → 400', async () => {
    const { app } = makeCtApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/completion-timeline?days=0')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCtApp('case_owner');
    const r = await request(app)
      .get('/v1/tenants/onboarding/completion-timeline')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M2.15 /v1/tenants/onboarding/actor-fleet sibling regression still 200', async () => {
    const { app } = makeCtApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/actor-fleet')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/completion-timeline` not captured by `:tenant_id` wildcard', async () => {
    const { app } = makeCtApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/completion-timeline')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.by_day).toBeDefined();
  });
});
