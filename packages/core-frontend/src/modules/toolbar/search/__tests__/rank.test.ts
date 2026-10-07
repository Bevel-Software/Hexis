import { describe, it, expect } from 'vitest';
import { matchTier, normalizeForMatch, rankByName } from '../rank';

const names = (items: string[], query: string, limit = 10) => rankByName(items, query, (n) => n, limit);

describe('matchTier', () => {
  it('ranks a prefix above a word start above a bare substring', () => {
    expect(matchTier('Pricing', 'pri')).toBe(0);
    expect(matchTier('Team pricing', 'pri')).toBe(1);
    expect(matchTier('Enterprise', 'pri')).toBe(2);
    expect(matchTier('Onboarding', 'pri')).toBeNull();
  });

  it('counts a later word-start occurrence even when the first one lands mid-word', () => {
    expect(matchTier('Banana and', 'an')).toBe(1);
  });

  it('treats punctuation and separators as word boundaries', () => {
    expect(matchTier('heyreach-campaign', 'camp')).toBe(1);
    expect(matchTier('q3_roadmap', 'road')).toBe(1);
    expect(matchTier('Notes (draft)', 'draft')).toBe(1);
  });

  it('ignores case, accents and repeated whitespace', () => {
    expect(matchTier('Café Menu', 'cafe')).toBe(0);
    expect(matchTier('How to   get started', 'TO GET')).toBe(1);
    expect(normalizeForMatch('  Ärger  Über ')).toBe('arger uber');
  });

  it('matches everything for an empty query', () => {
    expect(matchTier('Anything', '   ')).toBe(2);
  });
});

describe('rankByName', () => {
  it('orders by tier, then shorter name, then alphabet', () => {
    expect(names(['Enterprise plan', 'Team pricing', 'Pricing', 'Pricing FAQ', 'Onboarding'], 'pri')).toEqual([
      'Pricing',
      'Pricing FAQ',
      'Team pricing',
      'Enterprise plan',
    ]);
    expect(names(['beta', 'Alfa', 'gamma'], 'a')).toEqual(['Alfa', 'beta', 'gamma']);
  });

  it('keeps the caller’s order for equal names', () => {
    const items = [
      { id: 1, name: 'Plan' },
      { id: 2, name: 'Plan' },
    ];
    expect(rankByName(items, 'plan', (i) => i.name, 10).map((i) => i.id)).toEqual([1, 2]);
  });

  it('honours the limit after ranking, not before', () => {
    expect(names(['Xa', 'Xb', 'Alpha'], 'a', 1)).toEqual(['Alpha']);
  });

  it('returns the caller’s own order, capped, for an empty query', () => {
    expect(names(['c', 'a', 'b'], '', 2)).toEqual(['c', 'a']);
  });

  it('returns nothing when nothing matches', () => {
    expect(names(['Pricing'], 'zzz')).toEqual([]);
  });
});
