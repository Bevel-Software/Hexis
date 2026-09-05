import { describe, it, expect } from 'vitest';
import {
  filterLibraryItems,
  isInPlugin,
  isUngrouped,
  pluginCounts,
  pluginsOfItem,
  withLinkHealth,
  type AttentionStatus,
} from '../utils/status';

/**
 * Membership by LINK, alongside membership by folder. A shared skill under
 * `Skills/` has no folder plugin, yet belongs to every plugin whose manifest
 * links it — and the gallery, the sidebar counts and the plugin page all have
 * to agree on that.
 */

const OK: AttentionStatus = { state: 'ok', text: 'Ready' };

const shared = {
  kind: 'skill' as const,
  name: 'deploy',
  description: 'Ship it.',
  owned: false,
  plugin: null,
  shared: true,
  plugins: [
    { name: 'GTM', linked: true, granted: true },
    { name: 'Ops', linked: true, granted: false },
  ],
  status: OK,
};
const inline = {
  kind: 'skill' as const,
  name: 'outreach',
  description: '',
  owned: true,
  plugin: 'GTM',
  plugins: [{ name: 'GTM', linked: false, granted: true }],
  status: OK,
};
const personal = { kind: 'skill' as const, name: 'mine', description: '', owned: true, plugin: null, status: OK };

describe('membership by link', () => {
  it('a linked skill belongs to the plugins that link it, and to no folder plugin', () => {
    expect(isInPlugin(shared, 'GTM')).toBe(true);
    expect(isInPlugin(shared, 'Ops')).toBe(true);
    expect(isInPlugin(shared, 'Sales')).toBe(false);
    expect(pluginsOfItem(shared).sort()).toEqual(['GTM', 'Ops']);
    // Shared is not "yours alone" — only the personal skill is.
    expect(isUngrouped(shared)).toBe(false);
    expect(isUngrouped(personal)).toBe(true);
  });

  it('the plugin view and the sidebar counts follow links', () => {
    const items = [shared, inline, personal];
    expect(filterLibraryItems(items, { kind: 'group', plugin: 'GTM' }, '').map((i) => i.name)).toEqual([
      'deploy',
      'outreach',
    ]);
    expect(filterLibraryItems(items, { kind: 'ungrouped' }, '').map((i) => i.name)).toEqual(['mine']);
    expect(pluginCounts(items)).toEqual([
      { plugin: 'GTM', count: 2 },
      { plugin: 'Ops', count: 1 },
    ]);
  });

  it('a link whose grant is missing wears the amber note on THAT plugin\'s page only', () => {
    // Granted on GTM: untouched.
    expect(withLinkHealth(shared, 'GTM').status).toBe(OK);
    // Not granted on Ops: needs setup, and says whose job it is.
    expect(withLinkHealth(shared, 'Ops').status).toMatchObject({ state: 'warn', text: 'Needs setup' });
    expect(withLinkHealth({ ...shared, owned: true }, 'Ops').status.text).toBe(
      'Needs setup: share with plugin members',
    );
    // Inline membership never wears it.
    expect(withLinkHealth(inline, 'GTM').status).toBe(OK);
  });
});
