import { describe, it, expect } from 'vitest';
import { matchTier, normalizeForMatch, rankByName, rankByNames } from '../rank';

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

  it('reads a letter outside the Basic Multilingual Plane as a letter, not a word boundary', () => {
    // `𝐀` (U+1D400) is two UTF-16 code units; its trailing half alone is no letter.
    expect(matchTier('𝐀bc', 'bc')).toBe(2);
    expect(matchTier('𝐀 bc', 'bc')).toBe(1);
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
    // Same tier, same length: only the alphabet puts them in order, whatever order they came in.
    expect(names(['Coda', 'Bora'], 'o')).toEqual(['Bora', 'Coda']);
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

describe('rankByNames', () => {
  const commands = [
    { label: 'Invite people', keywords: ['team', 'members'] },
    { label: 'Team settings', keywords: [] },
    { label: 'New page', keywords: ['write'] },
  ];
  const ranked = (query: string) =>
    rankByNames(commands, query, (c) => [c.label, ...c.keywords], 10).map((c) => c.label);

  it('ranks an item at the best tier any of its names reaches', () => {
    // "Invite people" reaches tier 0 through its keyword, as "Team settings" does through its label.
    expect(ranked('team')).toEqual(['Invite people', 'Team settings']);
    expect(ranked('wri')).toEqual(['New page']);
  });

  it('breaks ties on the first name, the one on screen', () => {
    expect(ranked('e')).toEqual(['New page', 'Invite people', 'Team settings']);
  });
});
