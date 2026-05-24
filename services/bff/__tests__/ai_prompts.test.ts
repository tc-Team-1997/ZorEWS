// services/bff/__tests__/ai_prompts.test.ts

import {
  ALL_PROMPT_CATEGORIES,
  isPromptCategory,
  listPrompts,
  getPrompt,
  createPrompt,
  updatePrompt,
  deletePrompt,
  _resetAiPromptStore,
  PromptError,
} from '../src/ai_prompts';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetAiPromptStore());

describe('enum', () => {
  it('7 categories', () => {
    expect(ALL_PROMPT_CATEGORIES).toHaveLength(7);
    expect(isPromptCategory('risk_analysis')).toBe(true);
    expect(isPromptCategory('bogus')).toBe(false);
  });
});

describe('list', () => {
  it('includes platform prompts by default', () => {
    const out = listPrompts('BANK_DEMO');
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((p) => p.is_platform)).toBe(true);
  });

  it('include_platform=false hides platform', () => {
    const out = listPrompts('BANK_DEMO', { include_platform: false });
    expect(out.every((p) => !p.is_platform)).toBe(true);
  });

  it('category filter narrows', () => {
    const out = listPrompts('BANK_DEMO', { category: 'compliance' });
    expect(out.every((p) => p.category === 'compliance')).toBe(true);
  });

  it('q filter searches name + body + tags', () => {
    const out = listPrompts('BANK_DEMO', { q: 'RBI' });
    expect(out.length).toBeGreaterThan(0);
  });

  it('platform prompts sorted first', () => {
    createPrompt('BANK_DEMO', { name: 'My custom risk prompt', category: 'risk_analysis', body: 'Analyse the high-risk customers' }, 'alice', NOW);
    const out = listPrompts('BANK_DEMO');
    expect(out[0].is_platform).toBe(true);
  });

  it('invalid category throws', () => {
    expect(() => listPrompts('BANK_DEMO', { category: 'bogus' as 'risk_analysis' })).toThrow(PromptError);
  });
});

describe('get', () => {
  it('platform prompt findable', () => {
    expect(getPrompt('BANK_DEMO', 'pp_high_risk_summary_v1')).not.toBeNull();
  });

  it('custom prompt findable + cross-tenant null', () => {
    const c = createPrompt('BANK_DEMO', { name: 'Custom one', category: 'risk_analysis', body: 'Analyse the risk landscape' }, 'a', NOW);
    expect(getPrompt('BANK_DEMO', c.prompt_id)).not.toBeNull();
    expect(getPrompt('BIL', c.prompt_id)).toBeNull();
  });
});

describe('create + update + delete', () => {
  it('happy path', () => {
    const c = createPrompt('BANK_DEMO', { name: 'New prompt', category: 'reporting', body: 'Generate the daily report for {{date}}', description: 'Daily', tags: ['daily', 'report'] }, 'alice', NOW);
    expect(c.prompt_id).toMatch(/^pmt-BANK_DEMO-\d+$/);
    expect(c.is_platform).toBe(false);
    expect(c.tags).toEqual(['daily', 'report']);
    const u = updatePrompt('BANK_DEMO', c.prompt_id, { name: 'Renamed prompt', body: 'New body with {{var}} substitution' }, NOW);
    expect(u.name).toBe('Renamed prompt');
    expect(deletePrompt('BANK_DEMO', c.prompt_id)).toBe(true);
    expect(getPrompt('BANK_DEMO', c.prompt_id)).toBeNull();
  });

  it('platform prompts are immutable', () => {
    expect(() => updatePrompt('BANK_DEMO', 'pp_high_risk_summary_v1', { name: 'hacked' }, NOW)).toThrow(/read-only/);
    expect(deletePrompt('BANK_DEMO', 'pp_high_risk_summary_v1')).toBe(false);
  });

  it('rejects bad name + body length + category + tag cap', () => {
    expect(() => createPrompt('BANK_DEMO', { name: '@@', category: 'reporting', body: 'good body content here' }, 'a', NOW)).toThrow(PromptError);
    expect(() => createPrompt('BANK_DEMO', { name: 'NameOK', category: 'reporting', body: 'short' }, 'a', NOW)).toThrow(PromptError);
    expect(() => createPrompt('BANK_DEMO', { name: 'NameOK', category: 'bogus' as 'reporting', body: 'good body content here' }, 'a', NOW)).toThrow(PromptError);
    const bigBody = 'x'.repeat(8001);
    expect(() => createPrompt('BANK_DEMO', { name: 'NameOK', category: 'reporting', body: bigBody }, 'a', NOW)).toThrow(PromptError);
    // Tag cap: extra tags trimmed
    const c = createPrompt('BANK_DEMO', { name: 'TagCap', category: 'reporting', body: 'good body content here', tags: new Array(30).fill('t') }, 'a', NOW);
    expect(c.tags.length).toBeLessThanOrEqual(20);
  });

  it('cross-tenant update + delete', () => {
    const c = createPrompt('BANK_DEMO', { name: 'NameOK', category: 'reporting', body: 'good body content here' }, 'a', NOW);
    expect(() => updatePrompt('BIL', c.prompt_id, { name: 'X' }, NOW)).toThrow(PromptError);
    expect(deletePrompt('BIL', c.prompt_id)).toBe(false);
  });
});
