import { describe, it, expect } from 'vitest';
import {
  canonicalPluginToken,
  canonicalRoleName,
  parseAccessEntry,
  parsePluginPrincipalKey,
} from '../access-grammar.js';

/**
 * ONE spelling for a plugin principal. Every spelling of a token folds to the
 * same canonical key — through the parser, through the role canonicaliser
 * that grants and revocations compare with — and a canonical key is exactly
 * one name and one verb: nothing nested, nothing that is not already a slug.
 */
describe('plugin principal tokens — one canonical form', () => {
  it('folds any spelling of a plugin token to its slugged key', () => {
    for (const spelling of ['plugin/Sales Team/read', 'plugin/sales-team/read', 'Plugin/SALES TEAM/READ', ' plugin/Sales  Team/read ']) {
      expect(canonicalPluginToken(spelling)).toBe('plugin/sales-team/read');
      expect(canonicalRoleName(spelling)).toBe('plugin/sales-team/read');
    }
    const parsed = parseAccessEntry('plugin/Sales Team/write');
    expect(parsed.ok && parsed.entry.kind === 'role' ? parsed.entry.role : null).toBe('plugin/sales-team/write');
  });

  it('is not a plugin token without a name, with a nested name, or with an unknown verb', () => {
    for (const bad of ['plugin//read', 'plugin/GTM', 'plugin/GTM/foo/read', 'plugin/GTM/delete', 'role/GTM/read']) {
      expect(canonicalPluginToken(bad)).toBeNull();
    }
    // A non-plugin role still canonicalises the old way.
    expect(canonicalRoleName('  Sales   Team ')).toBe('sales team');
  });

  it('accepts as a canonical key only what it would itself generate', () => {
    expect(parsePluginPrincipalKey('plugin/gtm/read')).toEqual({ slug: 'gtm', verb: 'read' });
    expect(parsePluginPrincipalKey('plugin/gtm/foo/read')).toBeNull();
    expect(parsePluginPrincipalKey('plugin/GTM/read')).toBeNull(); // not a slug
    expect(parsePluginPrincipalKey('plugin/gtm/delete')).toBeNull();
    expect(parsePluginPrincipalKey('plugin//read')).toBeNull();
  });
});
