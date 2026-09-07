import { describe, it, expect } from 'vitest';
import { LIBRARY_ROOT, libraryHomeForItemPath, pathForPlugin } from '../routes/library-paths';

/**
 * Where "back" goes from an item page. The plugin is named by its IDENTITY
 * (resolved by the caller through the catalog) but a personal shelf is a
 * place decided by the FOLDER — a personal item's identity is null, and it
 * must still go home to "Yours".
 */
describe('libraryHomeForItemPath', () => {
  it('sends a personal item to Yours even though it has no plugin identity', () => {
    expect(libraryHomeForItemPath('Plugins/personal-u1/skills/notes', null)).toEqual({
      label: 'Yours',
      path: `${LIBRARY_ROOT}/yours`,
    });
  });

  it('sends a plugin item to its plugin by identity, labelled by the caller', () => {
    expect(libraryHomeForItemPath('Plugins/GTM/skills/outreach', 'go-to-market', () => 'Go To Market')).toEqual({
      label: 'Go To Market',
      path: pathForPlugin('go-to-market'),
    });
  });

  it('falls back to the folder when the caller resolved no identity', () => {
    expect(libraryHomeForItemPath('Plugins/GTM/skills/outreach')).toEqual({ label: 'GTM', path: pathForPlugin('GTM') });
  });

  it('sends a shared skill to the root', () => {
    expect(libraryHomeForItemPath('Skills/Eng/deploy', null).path).toBe(LIBRARY_ROOT);
  });
});
