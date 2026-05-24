// services/bff/__tests__/dq_standardisation.test.ts

import {
  ALL_STANDARDISATION_OPS,
  listPipelines,
  getPipeline,
  createPipeline,
  updatePipeline,
  deletePipeline,
  runPipelineOnSample,
  listDictionaries,
  getDictionary,
  createDictionary,
  addDictionaryEntry,
  removeDictionaryEntry,
  _resetStandardisationStore,
  StandardisationError,
} from '../src/dq_standardisation';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetStandardisationStore());

describe('enums', () => {
  it('ALL_STANDARDISATION_OPS has 8 entries', () => {
    expect(ALL_STANDARDISATION_OPS).toHaveLength(8);
    expect(ALL_STANDARDISATION_OPS).toContain('dictionary_lookup');
  });
});

describe('pipeline CRUD', () => {
  it('create + list + get round-trip', () => {
    const p = createPipeline(
      'BANK_DEMO',
      {
        name: 'Address normaliser',
        description: 'Strips punctuation + collapses whitespace',
        target_column: 'address',
        steps: [
          { op: 'trim' },
          { op: 'strip_punctuation' },
          { op: 'collapse_whitespace' },
        ],
      },
      'alice',
      NOW,
    );
    expect(p.pipeline_id).toMatch(/^stdp-BANK_DEMO-\d+$/);
    expect(p.steps).toHaveLength(3);
    expect(p.created_by).toBe('alice');
    expect(listPipelines('BANK_DEMO')).toHaveLength(1);
    const fetched = getPipeline('BANK_DEMO', p.pipeline_id)!;
    expect(fetched.name).toBe('Address normaliser');
  });

  it('update name + steps', () => {
    const p = createPipeline('BANK_DEMO', { name: 'P1', target_column: 'name', steps: [{ op: 'trim' }] }, 'alice', NOW);
    const u = updatePipeline('BANK_DEMO', p.pipeline_id, { name: 'P1 renamed', steps: [{ op: 'uppercase' }] }, new Date(NOW.getTime() + 1000));
    expect(u.name).toBe('P1 renamed');
    expect(u.steps).toEqual([{ op: 'uppercase', config: undefined }]);
  });

  it('delete returns true on hit + false on cross-tenant', () => {
    const p = createPipeline('BANK_DEMO', { name: 'P1', target_column: 'x', steps: [{ op: 'trim' }] }, 'alice', NOW);
    expect(deletePipeline('BIL', p.pipeline_id)).toBe(false);
    expect(deletePipeline('BANK_DEMO', p.pipeline_id)).toBe(true);
    expect(getPipeline('BANK_DEMO', p.pipeline_id)).toBeNull();
  });

  it('cross-tenant get returns null', () => {
    const p = createPipeline('BANK_DEMO', { name: 'P1', target_column: 'x', steps: [{ op: 'trim' }] }, 'alice', NOW);
    expect(getPipeline('BIL', p.pipeline_id)).toBeNull();
  });

  it('rejects invalid name + empty steps + > 20 steps', () => {
    expect(() => createPipeline('BANK_DEMO', { name: '@@@', target_column: 'x', steps: [{ op: 'trim' }] }, 'a', NOW)).toThrow(StandardisationError);
    expect(() => createPipeline('BANK_DEMO', { name: 'P', target_column: 'x', steps: [] }, 'a', NOW)).toThrow(StandardisationError);
    const tooMany = new Array(21).fill({ op: 'trim' });
    expect(() => createPipeline('BANK_DEMO', { name: 'P', target_column: 'x', steps: tooMany }, 'a', NOW)).toThrow(StandardisationError);
  });

  it('rejects invalid op + missing config for dict lookup + regex', () => {
    // @ts-expect-error testing bad op
    expect(() => createPipeline('BANK_DEMO', { name: 'P', target_column: 'x', steps: [{ op: 'BOGUS' }] }, 'a', NOW)).toThrow(StandardisationError);
    expect(() => createPipeline('BANK_DEMO', { name: 'P', target_column: 'x', steps: [{ op: 'dictionary_lookup' }] }, 'a', NOW)).toThrow(StandardisationError);
    expect(() => createPipeline('BANK_DEMO', { name: 'P', target_column: 'x', steps: [{ op: 'regex_replace', config: { pattern: '\\d+' } }] }, 'a', NOW)).toThrow(StandardisationError);
  });
});

describe('runPipelineOnSample', () => {
  it('applies trim + uppercase + collapse_whitespace', () => {
    const p = createPipeline('BANK_DEMO', {
      name: 'P',
      target_column: 'x',
      steps: [{ op: 'trim' }, { op: 'collapse_whitespace' }, { op: 'uppercase' }],
    }, 'alice', NOW);
    const out = runPipelineOnSample('BANK_DEMO', p.pipeline_id, ['  hello   world  ', 'foo bar']);
    expect(out.rows[0].input).toBe('  hello   world  ');
    expect(out.rows[0].output).toBe('HELLO WORLD');
    expect(out.rows[1].output).toBe('FOO BAR');
  });

  it('dictionary_lookup respects tenant dictionary', () => {
    const d = createDictionary('BANK_DEMO', { name: 'State codes', entries: [{ from: 'MH', to: 'Maharashtra' }] }, NOW);
    const p = createPipeline('BANK_DEMO', {
      name: 'StateExpand',
      target_column: 'state',
      steps: [{ op: 'dictionary_lookup', config: { dictionary_id: d.dictionary_id } }],
    }, 'alice', NOW);
    const out = runPipelineOnSample('BANK_DEMO', p.pipeline_id, ['MH', 'KA']);
    expect(out.rows[0].output).toBe('Maharashtra');
    expect(out.rows[1].output).toBe('KA'); // miss — passthrough
  });

  it('regex_replace applies the pattern + replacement', () => {
    const p = createPipeline('BANK_DEMO', {
      name: 'P',
      target_column: 'x',
      steps: [{ op: 'regex_replace', config: { pattern: '\\d+', replacement: 'N' } }],
    }, 'alice', NOW);
    const out = runPipelineOnSample('BANK_DEMO', p.pipeline_id, ['abc123def456']);
    expect(out.rows[0].output).toBe('abcNdefN');
  });

  it('rejects samples > 100 + unknown pipeline', () => {
    const p = createPipeline('BANK_DEMO', { name: 'P', target_column: 'x', steps: [{ op: 'trim' }] }, 'alice', NOW);
    expect(() => runPipelineOnSample('BANK_DEMO', p.pipeline_id, new Array(101).fill('x'))).toThrow(StandardisationError);
    expect(() => runPipelineOnSample('BANK_DEMO', 'bogus', ['x'])).toThrow(StandardisationError);
  });

  it('transformations field records each diff', () => {
    const p = createPipeline('BANK_DEMO', {
      name: 'P',
      target_column: 'x',
      steps: [{ op: 'trim' }, { op: 'uppercase' }],
    }, 'alice', NOW);
    const out = runPipelineOnSample('BANK_DEMO', p.pipeline_id, ['  hello  ']);
    expect(out.rows[0].transformations).toHaveLength(2);
    expect(out.rows[0].transformations[0].op).toBe('trim');
    expect(out.rows[0].transformations[1].op).toBe('uppercase');
  });
});

describe('dictionary CRUD', () => {
  it('create + list + get round-trip', () => {
    const d = createDictionary('BANK_DEMO', { name: 'States', description: 'Indian states', entries: [{ from: 'MH', to: 'Maharashtra' }] }, NOW);
    expect(d.entries).toHaveLength(1);
    expect(listDictionaries('BANK_DEMO')).toHaveLength(1);
    expect(getDictionary('BANK_DEMO', d.dictionary_id)).not.toBeNull();
  });

  it('addDictionaryEntry persists + updates existing', () => {
    const d = createDictionary('BANK_DEMO', { name: 'X' }, NOW);
    addDictionaryEntry('BANK_DEMO', d.dictionary_id, { from: 'MH', to: 'Maharashtra' }, NOW);
    addDictionaryEntry('BANK_DEMO', d.dictionary_id, { from: 'MH', to: 'Maharashtra State' }, NOW); // overwrite
    const updated = getDictionary('BANK_DEMO', d.dictionary_id)!;
    expect(updated.entries.find((e) => e.from === 'MH')!.to).toBe('Maharashtra State');
  });

  it('removeDictionaryEntry removes + throws on missing', () => {
    const d = createDictionary('BANK_DEMO', { name: 'X', entries: [{ from: 'MH', to: 'Maharashtra' }] }, NOW);
    removeDictionaryEntry('BANK_DEMO', d.dictionary_id, 'MH', NOW);
    expect(getDictionary('BANK_DEMO', d.dictionary_id)!.entries).toHaveLength(0);
    expect(() => removeDictionaryEntry('BANK_DEMO', d.dictionary_id, 'BOGUS', NOW)).toThrow(StandardisationError);
  });

  it('cross-tenant ops rejected', () => {
    const d = createDictionary('BANK_DEMO', { name: 'X' }, NOW);
    expect(() => addDictionaryEntry('BIL', d.dictionary_id, { from: 'a', to: 'b' }, NOW)).toThrow(StandardisationError);
    expect(() => removeDictionaryEntry('BIL', d.dictionary_id, 'a', NOW)).toThrow(StandardisationError);
  });

  it('addDictionaryEntry rejects bad input + dictionary_full', () => {
    const d = createDictionary('BANK_DEMO', { name: 'X' }, NOW);
    // @ts-expect-error testing bad input
    expect(() => addDictionaryEntry('BANK_DEMO', d.dictionary_id, null, NOW)).toThrow(StandardisationError);
    expect(() => addDictionaryEntry('BANK_DEMO', d.dictionary_id, { from: '', to: 'x' }, NOW)).toThrow(StandardisationError);
  });
});
