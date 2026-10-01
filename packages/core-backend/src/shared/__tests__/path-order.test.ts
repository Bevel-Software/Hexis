import { describe, it, expect } from 'vitest';
import { comparePathComponents } from '../path-order.js';

describe('comparePathComponents', () => {
  it('orders component by component, the way a sorted directory walk visits paths', () => {
    // A whole-string compare would weigh "-" against "/" and put a-b/x first.
    expect(comparePathComponents('a/b/x', 'a-b/x')).toBeLessThan(0);
    expect(comparePathComponents('Plugins/GTM', 'Plugins/GTM/skills')).toBeLessThan(0);
    expect(comparePathComponents('Plugins/GTM', 'Plugins/GTM')).toBe(0);
  });

  it('never calls two distinct paths equal: a collation tie falls through to code-unit order', () => {
    // Precomposed é and its decomposed spelling collate as equal; two folders
    // so named must still have ONE first, or discovery and principal synthesis
    // could each claim a different one for the same slug.
    const composed = 'Plugins/café';
    const decomposed = 'Plugins/café';
    // (Whether the host's collation equates them is the host's business —
    // the property under test holds either way: distinct paths never tie.)
    const order = comparePathComponents(composed, decomposed);
    expect(order).not.toBe(0);
    expect(comparePathComponents(decomposed, composed)).toBe(-order);
  });
});
