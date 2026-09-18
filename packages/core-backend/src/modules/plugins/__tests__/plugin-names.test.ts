import { describe, it, expect } from 'vitest';
import {
  pluginDisplayNameOf,
  pluginIdentityOf,
  renderPluginManifest,
} from '@bevel-software/platform-shared';

/**
 * THE rule, in one place: the identifier is the manifest's `name`; the
 * display name is the manifest's `displayName`, else that same `name`. The
 * folder a plugin happens to live in is not an input to either — it used to
 * be, which made moving or re-casing a folder a silent rename.
 */
describe('the one display-name rule', () => {
  it('reads the display name from the manifest and nothing else', () => {
    expect(pluginDisplayNameOf({ name: 'sales-team', displayName: 'Sales Team' })).toBe('Sales Team');
    // No `displayName`: the identifier is what it is called. There is nowhere
    // else to look — the function is not given a folder to fall back to.
    expect(pluginDisplayNameOf({ name: 'design' })).toBe('design');
    // Whitespace is never what someone typed.
    expect(pluginDisplayNameOf({ name: 'gtm', displayName: '  Go To Market  ' })).toBe('Go To Market');
    // A blank field is no answer; the name stands.
    expect(pluginDisplayNameOf({ name: 'gtm', displayName: '   ' })).toBe('gtm');
    expect(pluginDisplayNameOf({ name: 'gtm', displayName: 42 })).toBe('gtm');
    // A manifest naming something no identifier still SAYS what it is called.
    expect(pluginDisplayNameOf({ name: 'Not An Identifier' })).toBe('Not An Identifier');
    // Nothing to read: empty, for the caller that resolved an identity to use.
    expect(pluginDisplayNameOf({})).toBe('');
    expect(pluginDisplayNameOf(null)).toBe('');
    expect(pluginDisplayNameOf({ name: 42 })).toBe('');
  });

  it('never lets the display name reach back into the identifier', () => {
    const manifest = { name: 'sales-team', displayName: 'Something Else Entirely' };
    expect(pluginIdentityOf(manifest, 'Sales Team')).toBe('sales-team');
    expect(pluginIdentityOf(manifest, 'anything-at-all')).toBe('sales-team');
  });

  describe('renderPluginManifest', () => {
    it('always writes displayName — the folder spelling by default', () => {
      expect(JSON.parse(renderPluginManifest('Sales Team'))).toMatchObject({
        name: 'sales-team',
        displayName: 'Sales Team',
      });
    });

    it('writes it even when it equals the identifier, so no reader needs a second rule', () => {
      const manifest = JSON.parse(renderPluginManifest('design'));
      expect(manifest).toMatchObject({ name: 'design', displayName: 'design' });
      expect(pluginDisplayNameOf(manifest)).toBe('design');
    });

    it('takes the name its creator typed when given one', () => {
      expect(JSON.parse(renderPluginManifest('Sales Team', 'Sales Team (EMEA)'))).toMatchObject({
        name: 'sales-team',
        displayName: 'Sales Team (EMEA)',
      });
      // A blank one is not a name; the folder's spelling stands.
      expect(JSON.parse(renderPluginManifest('Sales Team', '   ')).displayName).toBe('Sales Team');
    });

    it('round-trips: what the renderer writes is what the reader says', () => {
      for (const folder of ['Sales Team', 'design', 'GTM', 'ÜbÜr Tëam']) {
        const manifest = JSON.parse(renderPluginManifest(folder));
        expect(pluginDisplayNameOf(manifest)).toBe(folder);
        expect(pluginIdentityOf(manifest, 'some-other-folder')).toBe(manifest.name);
      }
    });

    it('invents nothing else', () => {
      expect(Object.keys(JSON.parse(renderPluginManifest('GTM')))).toEqual(['$schema', 'name', 'displayName']);
    });
  });
});
