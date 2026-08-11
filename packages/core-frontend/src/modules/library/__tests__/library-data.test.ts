import { describe, expect, it, vi } from 'vitest';
import {
  workspaceHasNoGroups,
  type LibraryContextValue,
  type LibraryItem,
} from '../state/library-data';

/**
 * The one predicate behind every "create the FIRST group" doorway — the nav's
 * spelled-out row and the index's CTA both. What these tests pin is that the
 * verdict is SETTLED: an empty answer while either witness is loading or has
 * failed must read as "unknown", never as "untouched".
 */

function item(group: string | null): LibraryItem {
  return {
    kind: 'skill',
    id: 'scratch',
    name: 'scratch',
    description: '',
    owned: false,
    group,
    path: group ? `Groups/${group}/scratch` : 'Skills/scratch',
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
    groupSummaries: [],
    groupsLoading: false,
    groupsError: null,
    reloadGroups: vi.fn(),
    ...over,
  };
}

describe('workspaceHasNoGroups', () => {
  it('is true only for a settled, group-less workspace', () => {
    expect(workspaceHasNoGroups(lib())).toBe(true);
    expect(workspaceHasNoGroups(lib({ items: [item(null)] }))).toBe(true);
  });

  it('treats a still-loading source as an unanswered question', () => {
    expect(workspaceHasNoGroups(lib({ loading: true }))).toBe(false);
    expect(workspaceHasNoGroups(lib({ groupsLoading: true }))).toBe(false);
  });

  it('treats a failed source as an unanswered question', () => {
    expect(workspaceHasNoGroups(lib({ error: 'boom' }))).toBe(false);
    expect(workspaceHasNoGroups(lib({ groupsError: "Couldn't load groups." }))).toBe(false);
  });

  it('counts a group from either witness — a summary, or a catalog item', () => {
    expect(
      workspaceHasNoGroups(
        lib({
          groupSummaries: [
            {
              name: 'GTM',
              folders: ['Groups/GTM'],
              canRead: false,
              canWrite: false,
            } as LibraryContextValue['groupSummaries'][number],
          ],
        }),
      ),
    ).toBe(false);
    expect(workspaceHasNoGroups(lib({ items: [item('GTM')] }))).toBe(false);
  });
});
