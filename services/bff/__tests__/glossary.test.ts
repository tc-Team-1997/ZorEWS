// services/bff/__tests__/glossary.test.ts

import {
  ALL_GLOSSARY_CATEGORIES,
  GLOSSARY_TERMS,
  isGlossaryCategory,
  listGlossaryTerms,
  getGlossaryTerm,
  listGlossaryCategories,
  GlossaryError,
} from '../src/glossary';

describe('catalog', () => {
  it('7 categories', () => {
    expect(ALL_GLOSSARY_CATEGORIES).toHaveLength(7);
  });
  it('GLOSSARY_TERMS has ≥ 20 entries', () => {
    expect(GLOSSARY_TERMS.length).toBeGreaterThanOrEqual(20);
  });
  it('every term has required fields', () => {
    for (const t of GLOSSARY_TERMS) {
      expect(t.term_id).toBeTruthy();
      expect(t.term).toBeTruthy();
      expect(t.definition.length).toBeGreaterThan(10);
      expect(ALL_GLOSSARY_CATEGORIES).toContain(t.category);
    }
  });
  it('term_id values unique', () => {
    const ids = new Set(GLOSSARY_TERMS.map((t) => t.term_id));
    expect(ids.size).toBe(GLOSSARY_TERMS.length);
  });
  it('related_term_ids point at real terms', () => {
    const all = new Set(GLOSSARY_TERMS.map((t) => t.term_id));
    for (const t of GLOSSARY_TERMS) {
      for (const r of t.related_term_ids ?? []) {
        expect(all.has(r)).toBe(true);
      }
    }
  });
  it('type guard', () => {
    expect(isGlossaryCategory('banking')).toBe(true);
    expect(isGlossaryCategory('bogus')).toBe(false);
  });
});

describe('listGlossaryTerms', () => {
  it('no filter returns full catalog', () => {
    expect(listGlossaryTerms()).toHaveLength(GLOSSARY_TERMS.length);
  });

  it('category filter narrows', () => {
    const reg = listGlossaryTerms({ category: 'regulatory' });
    expect(reg.length).toBeGreaterThan(0);
    expect(reg.every((t) => t.category === 'regulatory')).toBe(true);
  });

  it('invalid category throws', () => {
    expect(() => listGlossaryTerms({ category: 'bogus' as 'banking' })).toThrow(GlossaryError);
  });

  it('q filter searches term + definition + term_id', () => {
    const r1 = listGlossaryTerms({ q: 'NPA' });
    expect(r1.length).toBeGreaterThan(0);
    const r2 = listGlossaryTerms({ q: 'sma' });
    expect(r2.length).toBeGreaterThan(0);
  });

  it('defensive copy — mutating result does not pollute catalog', () => {
    const r = listGlossaryTerms();
    if (r[0].related_term_ids) r[0].related_term_ids.push('hack');
    const r2 = listGlossaryTerms();
    if (r2[0].related_term_ids) expect(r2[0].related_term_ids).not.toContain('hack');
  });
});

describe('getGlossaryTerm + listGlossaryCategories', () => {
  it('hit + miss', () => {
    expect(getGlossaryTerm('sma')).not.toBeNull();
    expect(getGlossaryTerm('bogus')).toBeNull();
  });

  it('listGlossaryCategories returns the 7 in canonical order', () => {
    expect(listGlossaryCategories()).toEqual(['banking', 'regulatory', 'risk', 'ai_ml', 'workflow', 'fraud', 'insurance']);
  });
});
