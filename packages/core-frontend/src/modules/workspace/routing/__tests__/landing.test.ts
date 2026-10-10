import { describe, it, expect } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { deleteTookLibraryItem, landingAfterClose } from '../landing';

const ITEM_PAGE = `/workspace/${DEFAULT_BRANCH}/Knowledge/Plugins/GTM/web-search.tool`;

describe('landingAfterClose', () => {
  it('lands on the tab that is left', () => {
    expect(landingAfterClose('/workspace/main/Knowledge/Draft.md', 'main', 'Knowledge/Keep.md')).toBe(
      '/workspace/main/Knowledge/Keep.md',
    );
  });

  it('with no tab left, lands on Knowledge home on the same branch', () => {
    expect(landingAfterClose('/workspace/feature/Knowledge/Draft.md', 'feature', null)).toBe('/workspace/feature');
  });

  it("with no tab left on a Library item's page, lands on Skills & Tools", () => {
    expect(landingAfterClose(ITEM_PAGE, DEFAULT_BRANCH, null)).toBe('/skills-and-tools');
  });

  it("on a Library item's page with a tab left, lands on that tab", () => {
    expect(landingAfterClose(ITEM_PAGE, DEFAULT_BRANCH, 'Knowledge/Keep.md')).toBe(
      `/workspace/${DEFAULT_BRANCH}/Knowledge/Keep.md`,
    );
  });
});

describe('deleteTookLibraryItem', () => {
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
