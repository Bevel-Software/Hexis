import { describe, it, expect } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import {
  LIBRARY_ROOT,
  deleteTookLibraryItem,
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
      label: 'Personal plugin',
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

describe('deleteTookLibraryItem', () => {
  const ITEM_PAGE = `/workspace/${DEFAULT_BRANCH}/Knowledge/Plugins/GTM/web-search.tool`;
  const SKILL = 'Knowledge/Skills/Sales/discovery-call';
  const page = (path: string) => `/workspace/${DEFAULT_BRANCH}/${path}`;

  it("is true for the skill's folder, and for the file on screen itself", () => {
    expect(deleteTookLibraryItem(page(`${SKILL}/SKILL.md`), 'Knowledge', SKILL)).toBe(true);
    expect(deleteTookLibraryItem(page(`${SKILL}/SKILL.md`), 'Knowledge', `${SKILL}/SKILL.md`)).toBe(true);
    expect(deleteTookLibraryItem(ITEM_PAGE, 'Knowledge', 'Knowledge/Plugins/GTM')).toBe(true);
  });

  it("is true for the skill's SKILL.md while one of its other files is on screen", () => {
    expect(deleteTookLibraryItem(page(`${SKILL}/checklist.md`), 'Knowledge', `${SKILL}/SKILL.md`)).toBe(true);
  });

  it('is false for another item, a sibling sharing a prefix, or a page outside the Library', () => {
    expect(deleteTookLibraryItem(page(`${SKILL}/SKILL.md`), 'Knowledge', 'Knowledge/Skills/Sales/other')).toBe(false);
    expect(deleteTookLibraryItem(page(`${SKILL}-v2/SKILL.md`), 'Knowledge', SKILL)).toBe(false);
    expect(deleteTookLibraryItem(page(`${SKILL}/checklist.md`), 'Knowledge', `${SKILL}/checklist.md.bak`)).toBe(false);
    expect(deleteTookLibraryItem('/workspace/feature/Knowledge/Draft.md', 'Knowledge', 'Knowledge/Draft.md')).toBe(false);
    expect(deleteTookLibraryItem('/skills-and-tools', 'Knowledge', SKILL)).toBe(false);
  });
});
