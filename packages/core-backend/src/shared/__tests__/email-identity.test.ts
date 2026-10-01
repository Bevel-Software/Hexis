import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalEmail, hashEmail } from '../email-identity.js';

describe('canonicalEmail', () => {
  it('trims and lowercases, so one person has one spelling', () => {
    expect(canonicalEmail('  Mia@X.io ')).toBe('mia@x.io');
    expect(canonicalEmail('mia@x.io')).toBe('mia@x.io');
    expect(canonicalEmail('MIA@X.IO')).toBe('mia@x.io');
  });

  it('leaves everything else alone — no dot-folding, no plus-tag stripping', () => {
    // Providers disagree about these, and a rule that guessed would merge two
    // identities the operator's directory treats as distinct.
    expect(canonicalEmail('m.i.a+reviews@x.io')).toBe('m.i.a+reviews@x.io');
  });
});

describe('hashEmail', () => {
  it('hashes the CANONICAL form — the property PR attribution depends on', () => {
    // The author id is written into a PR body from one spelling and looked up
    // from another; if the two normalised differently, every PR the bot opened
    // would be de-attributed. The access resolver carried its own copy of this
    // expression, used by the very lookup that has to agree with it.
    const expected = createHash('sha256').update('mia@x.io').digest('hex');
    expect(hashEmail('mia@x.io')).toBe(expected);
    expect(hashEmail('  Mia@X.io ')).toBe(expected);
    expect(hashEmail('MIA@X.IO')).toBe(expected);
  });

  it('separates two people who differ by more than spelling', () => {
    expect(hashEmail('mia@x.io')).not.toBe(hashEmail('sam@x.io'));
    expect(hashEmail('mia@x.io')).not.toBe(hashEmail('mia+reviews@x.io'));
  });
});
