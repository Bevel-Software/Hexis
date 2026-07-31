import { describe, it, expect } from 'vitest';
import { recordTouch, decideWrite } from '../session-ontology.policy.js';

const PRODUCT = 'KnowledgeBase/Product';
const PLATFORM = 'KnowledgeBase/Platform';
const GTM = 'KnowledgeBase/GTM';

describe('recordTouch', () => {
  it('adds a named ontology to the set', () => {
    expect([...recordTouch(new Set(), PRODUCT)]).toEqual([PRODUCT]);
  });

  it('adds nothing for a neutral touch', () => {
    expect([...recordTouch(new Set([PRODUCT]), null)]).toEqual([PRODUCT]);
  });

  it('accumulates across ontologies', () => {
    const a = recordTouch(new Set(), PRODUCT);
    const b = recordTouch(a, PLATFORM);
    expect(new Set(b)).toEqual(new Set([PRODUCT, PLATFORM]));
  });

  it('does not mutate the input set', () => {
    const input = new Set([PRODUCT]);
    recordTouch(input, PLATFORM);
    expect([...input]).toEqual([PRODUCT]);
  });
});

describe('decideWrite', () => {
  it('allows a write to a neutral path regardless of touched set', () => {
    expect(decideWrite(new Set([PRODUCT, PLATFORM]), null)).toEqual({ allow: true });
  });

  it('allows a write when the session has touched nothing yet', () => {
    expect(decideWrite(new Set(), PRODUCT)).toEqual({ allow: true });
  });

  it('allows a write to the single ontology the session is confined to', () => {
    expect(decideWrite(new Set([PRODUCT]), PRODUCT)).toEqual({ allow: true });
  });

  it('blocks a write to a different ontology when confined to one (different-ontology)', () => {
    expect(decideWrite(new Set([PRODUCT]), PLATFORM)).toEqual({
      allow: false,
      reason: 'different-ontology',
      touched: [PRODUCT],
      attempted: PLATFORM,
    });
  });

  it('blocks ALL writes once the session has touched two ontologies (multi-ontology)', () => {
    // Reading across ontologies poisons writes — even a write back into Product.
    expect(decideWrite(new Set([PRODUCT, PLATFORM]), PRODUCT)).toEqual({
      allow: false,
      reason: 'multi-ontology',
      touched: [PLATFORM, PRODUCT],
      attempted: PRODUCT,
    });
    expect(decideWrite(new Set([PRODUCT, PLATFORM]), GTM).allow).toBe(false);
  });
});
