import { describe, it, expect } from 'vitest';
import {
  LIBRARY_ROOT,
  libraryFilterForPath,
  libraryHomeForItemPath,
  pathForLibraryFilter,
  pathForPlugin,
  pathForTeam,
} from '../routes/library-paths';
import type { LibraryFilter } from '../utils/status';

/**
 * The URL↔selection pair, both ways: a path that maps to a filter must map
 * back to itself, or the sidebar lights a row the URL did not name.
 */
describe('libraryFilterForPath ↔ pathForLibraryFilter', () => {
  it('round-trips every lens, the root being Everything', () => {
    const filters: LibraryFilter[] = [
      { kind: 'all' },
      { kind: 'owned' },
      { kind: 'ungrouped' },
      { kind: 'team', group: 'Sales & Ops' },
      { kind: 'group', plugin: 'gtm' },
    ];
    for (const filter of filters) {
      expect(libraryFilterForPath(pathForLibraryFilter(filter))).toEqual(filter);
    }
    expect(pathForLibraryFilter({ kind: 'all' })).toBe(LIBRARY_ROOT);
  });

  it('keeps the old everything address as a second spelling of the root', () => {
    expect(libraryFilterForPath(`${LIBRARY_ROOT}/everything`)).toEqual({ kind: 'all' });
  });

  it('reads a team name back from its encoded segment, and a bad escape as itself', () => {
    expect(pathForTeam('Sales & Ops')).toBe(`${LIBRARY_ROOT}/teams/Sales%20%26%20Ops`);
    expect(libraryFilterForPath(`${LIBRARY_ROOT}/teams/%zz`)).toEqual({ kind: 'team', group: '%zz' });
  });

  it('names no filter for a page that is not a slice of the catalog', () => {
    expect(libraryFilterForPath(`${LIBRARY_ROOT}/welcome`)).toBeNull();
    expect(libraryFilterForPath(`${LIBRARY_ROOT}/teams`)).toBeNull();
    expect(libraryFilterForPath('/workspace/main/kb/Skills/x/SKILL.md')).toBeNull();
  });
});

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

  it('sends a shared skill to the root, which is Everything', () => {
    expect(libraryHomeForItemPath('Skills/Eng/deploy', null)).toEqual({ label: 'Everything', path: LIBRARY_ROOT });
  });
});
