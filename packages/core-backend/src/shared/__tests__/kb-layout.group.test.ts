import { describe, it, expect } from 'vitest';
import { pluginOfPath, PLUGINS_DIR } from '@bevel-software/platform-shared';

/**
 * `pluginOfPath` is the whole of the grouping contract — the sidebar, the
 * catalog buckets and the access story all read a group off a path with it.
 * The cases that matter are the ones where "has a group" and "is under the
 * group root" come apart.
 */
describe('pluginOfPath', () => {
  it('reads the group from the Groups root', () => {
    expect(pluginOfPath(`${PLUGINS_DIR}/GTM/heyreach-campaign/SKILL.md`)).toBe('GTM');
    expect(pluginOfPath(`${PLUGINS_DIR}/GTM/heyreach.tool`)).toBe('GTM');
    expect(pluginOfPath(`${PLUGINS_DIR}/Engineering/review/architecture-review`)).toBe(
      'Engineering',
    );
  });

  it('returns null for content directly under the root — it has no group folder', () => {
    // The regression this guards: `Plugins/slack.tool` must NOT report a group
    // called "slack.tool", and `Plugins/GTM` must not report itself.
    expect(pluginOfPath(`${PLUGINS_DIR}/slack.tool`)).toBeNull();
    expect(pluginOfPath(`${PLUGINS_DIR}/GTM`)).toBeNull();
    expect(pluginOfPath(PLUGINS_DIR)).toBeNull();
  });

  it('returns null outside the group root', () => {
    expect(pluginOfPath('KnowledgeBase/Product/Knowledge/Foo.md')).toBeNull();
    expect(pluginOfPath('Data/Engineering/Knowledge/Bar.md')).toBeNull();
    // The retired pre-merge roots are ordinary non-group folders now.
    expect(pluginOfPath('Skills/GTM/heyreach-campaign')).toBeNull();
    expect(pluginOfPath('Tools/NewsAgent/serper.tool')).toBeNull();
    expect(pluginOfPath('access.md')).toBeNull();
    expect(pluginOfPath('')).toBeNull();
  });

  it('is not fooled by a prefix match on the root name', () => {
    expect(pluginOfPath('GroupsOld/GTM/x')).toBeNull();
  });

  it('tolerates leading and doubled separators', () => {
    expect(pluginOfPath(`/${PLUGINS_DIR}/GTM/x`)).toBe('GTM');
    expect(pluginOfPath(`${PLUGINS_DIR}//GTM//x`)).toBe('GTM');
  });
});
