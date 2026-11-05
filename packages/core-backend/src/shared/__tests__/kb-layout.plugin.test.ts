import { describe, it, expect } from 'vitest';
import { DEFAULT_KB_LAYOUT, pluginOfPath, PLUGINS_DIR } from '@bevel-software/platform-shared';

/** `pluginOfPath` under the default layout, which these cases are written against. */
const plugin = (path: string) => pluginOfPath(path, DEFAULT_KB_LAYOUT);

/**
 * `pluginOfPath` is the whole of the grouping contract — the sidebar, the
 * catalog buckets and the access story all read a plugin off a path with it.
 * The cases that matter are the ones where "has a plugin" and "is under the
 * plugin root" come apart.
 */
describe('pluginOfPath', () => {
  it('reads the plugin from the Plugins root', () => {
    expect(plugin(`${PLUGINS_DIR}/GTM/heyreach-campaign/SKILL.md`)).toBe('GTM');
    expect(plugin(`${PLUGINS_DIR}/GTM/heyreach.tool`)).toBe('GTM');
    expect(plugin(`${PLUGINS_DIR}/Engineering/review/architecture-review`)).toBe(
      'Engineering',
    );
  });

  it('returns null for content directly under the root — it has no plugin folder', () => {
    // The regression this guards: `Plugins/slack.tool` must NOT report a plugin
    // called "slack.tool", and `Plugins/GTM` must not report itself.
    expect(plugin(`${PLUGINS_DIR}/slack.tool`)).toBeNull();
    expect(plugin(`${PLUGINS_DIR}/GTM`)).toBeNull();
    expect(plugin(PLUGINS_DIR)).toBeNull();
  });

  it('returns null outside the plugin root', () => {
    expect(plugin('KnowledgeBase/Product/Knowledge/Foo.md')).toBeNull();
    expect(plugin('Data/Engineering/Knowledge/Bar.md')).toBeNull();
    // The retired pre-merge roots are ordinary non-plugin folders now.
    expect(plugin('Skills/GTM/heyreach-campaign')).toBeNull();
    expect(plugin('Tools/NewsAgent/serper.tool')).toBeNull();
    expect(plugin('access.md')).toBeNull();
    expect(plugin('')).toBeNull();
  });

  it('is not fooled by a prefix match on the root name', () => {
    expect(plugin('PluginsOld/GTM/x')).toBeNull();
  });

  it('tolerates leading and doubled separators', () => {
    expect(plugin(`/${PLUGINS_DIR}/GTM/x`)).toBe('GTM');
    expect(plugin(`${PLUGINS_DIR}//GTM//x`)).toBe('GTM');
  });
});
