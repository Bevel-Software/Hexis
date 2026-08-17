import { describe, expect, it, vi } from 'vitest';
import {
  workspaceHasNoPlugins,
  type LibraryContextValue,
  type LibraryItem,
} from '../state/library-data';

/**
 * The one predicate behind every "create the FIRST plugin" doorway — the nav's
 * spelled-out row and the index's CTA both. What these tests pin is that the
 * verdict is SETTLED: an empty answer while either witness is loading or has
 * failed must read as "unknown", never as "untouched".
 */

function item(plugin: string | null): LibraryItem {
  return {
    kind: 'skill',
    id: 'scratch',
    name: 'scratch',
    description: '',
    owned: false,
    plugin,
    path: plugin ? `Plugins/${plugin}/scratch` : 'Skills/scratch',
    status: { state: 'ok', text: 'Ready' },
  };
}

function lib(over: Partial<LibraryContextValue> = {}): LibraryContextValue {
  return {
    loading: false,
    error: null,
    skills: [],
    pendingSkills: [],
    tools: [],
    ownedSkills: new Set(),
    allowedToolsBySkill: new Map(),
    crs: [],
    myCrNumbers: new Set(),
    reload: vi.fn(),
    items: [],
    pluginSummaries: [],
    pluginsLoading: false,
    pluginsError: null,
    reloadPlugins: vi.fn(),
    ...over,
  };
}

describe('workspaceHasNoPlugins', () => {
  it('is true only for a settled, plugin-less workspace', () => {
    expect(workspaceHasNoPlugins(lib())).toBe(true);
    expect(workspaceHasNoPlugins(lib({ items: [item(null)] }))).toBe(true);
  });

  it('treats a still-loading source as an unanswered question', () => {
    expect(workspaceHasNoPlugins(lib({ loading: true }))).toBe(false);
    expect(workspaceHasNoPlugins(lib({ pluginsLoading: true }))).toBe(false);
  });

  it('treats a failed source as an unanswered question', () => {
    expect(workspaceHasNoPlugins(lib({ error: 'boom' }))).toBe(false);
    expect(workspaceHasNoPlugins(lib({ pluginsError: "Couldn't load plugins." }))).toBe(false);
  });

  it('counts a plugin from either witness — a summary, or a catalog item', () => {
    expect(
      workspaceHasNoPlugins(
        lib({
          pluginSummaries: [
            {
              name: 'GTM',
              folders: ['Plugins/GTM'],
              canRead: false,
              canWrite: false,
            } as LibraryContextValue['pluginSummaries'][number],
          ],
        }),
      ),
    ).toBe(false);
    expect(workspaceHasNoPlugins(lib({ items: [item('GTM')] }))).toBe(false);
  });
});
