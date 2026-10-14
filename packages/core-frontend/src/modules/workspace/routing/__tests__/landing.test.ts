import { describe, it, expect } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { landingAfterClose } from '../landing';

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
