import { describe, it, expect } from 'vitest';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import {
  filterLibraryItems,
  groupCounts,
  neededToolsFor,
  skillStatus,
  toolStatus,
  type LibraryFilterable,
} from '../utils/status';

function tool(overrides: Partial<ToolSecrets>): ToolSecrets {
  return {
    slug: 'slack',
    name: 'slack',
    path: 'Tools/slack.tool',
    type: 'http',
    setup: null,
    canWrite: false,
    variables: [],
    ...overrides,
  };
}

describe('toolStatus', () => {
  it('is ok when every variable is satisfied', () => {
    const t = tool({
      variables: [
        { name: 'API_KEY', scope: 'admin', label: null, key: 'slack_API_KEY', adminConfigured: true, userConfigured: false },
        { name: 'TOKEN', scope: 'user', label: null, key: 'slack_TOKEN', adminConfigured: false, userConfigured: true },
      ],
    });
    expect(toolStatus(t).state).toBe('ok');
  });

  it('flags a missing user sign-in as warn (oauth) and an expired one as err', () => {
    const pending = tool({
      variables: [
        { name: 'SIGNIN', scope: 'user', label: null, key: 'k', adminConfigured: true, userConfigured: false, oauth: true, authorized: false },
      ],
    });
    expect(toolStatus(pending)).toEqual({ state: 'warn', text: 'Needs your sign-in' });

    const expired = tool({
      variables: [
        { name: 'SIGNIN', scope: 'user', label: null, key: 'k', adminConfigured: true, userConfigured: true, oauth: true, authorized: true, needsReauth: true },
      ],
    });
    expect(toolStatus(expired).state).toBe('err');
  });

  it('flags a missing shared value as off (not set up yet)', () => {
    const t = tool({
      variables: [
        { name: 'API_KEY', scope: 'admin', label: null, key: 'k', adminConfigured: false, userConfigured: false },
      ],
    });
    expect(toolStatus(t)).toEqual({ state: 'off', text: 'Not set up yet' });
    expect(toolStatus(tool({ ...t, canWrite: true })).text).toContain('you maintain');
  });
});

describe('neededToolsFor / skillStatus', () => {
  const slack = tool({ name: 'slack', slug: 'slack' });
  const notion = tool({
    name: 'notion',
    slug: 'notion',
    variables: [
      { name: 'SIGNIN', scope: 'user', label: null, key: 'k', adminConfigured: true, userConfigured: false, oauth: true, authorized: false },
    ],
  });

  it('matches manual-namespaced allowed-tools entries and ignores generic agent tools', () => {
    const needed = neededToolsFor({ allowedTools: ['Bash', 'slack_post_message', 'notion.notion_search'] }, [slack, notion]);
    expect(needed.map((t) => t.name)).toEqual(['slack', 'notion']);
    expect(neededToolsFor({ allowedTools: ['Read', 'Bash'] }, [slack, notion])).toEqual([]);
  });

  it('skill is ready only when every needed integration is connected', () => {
    expect(skillStatus([slack]).state).toBe('ok');
    expect(skillStatus([slack, notion])).toEqual({ state: 'warn', text: 'Needs setup' });
    expect(skillStatus([]).state).toBe('ok');
  });
});

describe('filterLibraryItems (sidebar selection + search)', () => {
  const items: LibraryFilterable[] = [
    { kind: 'skill', name: 'Weekly newsletter', description: 'drafts the Friday newsletter', owned: true, group: 'Everyone' },
    { kind: 'skill', name: 'RFI responder', description: 'answers requests', owned: false, group: 'GTM' },
    { kind: 'integration', name: 'Slack', description: 'messages', owned: false, group: 'Everyone' },
    { kind: 'integration', name: 'GitHub', description: 'code and change requests', owned: true, group: null },
  ];

  it('narrows to a group — skills and tools together, not split by kind', () => {
    expect(filterLibraryItems(items, { kind: 'group', group: 'Everyone' }, '').map((i) => i.name)).toEqual([
      'Weekly newsletter',
      'Slack',
    ]);
  });

  it('narrows to owned, and to the ungrouped bucket', () => {
    expect(filterLibraryItems(items, { kind: 'owned' }, '').map((i) => i.name)).toEqual([
      'Weekly newsletter',
      'GitHub',
    ]);
    expect(filterLibraryItems(items, { kind: 'ungrouped' }, '').map((i) => i.name)).toEqual([
      'GitHub',
    ]);
  });

  it('"all" keeps everything, including ungrouped items', () => {
    expect(filterLibraryItems(items, { kind: 'all' }, '')).toHaveLength(4);
  });

  it('search matches name or description within the selection, case-insensitively', () => {
    expect(filterLibraryItems(items, { kind: 'all' }, 'friday').map((i) => i.name)).toEqual([
      'Weekly newsletter',
    ]);
    expect(filterLibraryItems(items, { kind: 'all' }, 'CHANGE').map((i) => i.name)).toEqual([
      'GitHub',
    ]);
    // The query is applied INSIDE the selection, so a match outside it stays out.
    expect(filterLibraryItems(items, { kind: 'group', group: 'GTM' }, 'slack')).toEqual([]);
  });
});

describe('groupCounts', () => {
  it('counts per group, skips ungrouped, and sorts by name not by count', () => {
    const items: LibraryFilterable[] = [
      { kind: 'skill', name: 'a', description: '', owned: false, group: 'Zeta' },
      { kind: 'skill', name: 'b', description: '', owned: false, group: 'Alpha' },
      { kind: 'integration', name: 'c', description: '', owned: false, group: 'Zeta' },
      { kind: 'skill', name: 'd', description: '', owned: false, group: null },
    ];
    // Alpha first despite having fewer items — a nav that reorders itself when
    // a group gains an item moves under the pointer.
    expect(groupCounts(items)).toEqual([
      { group: 'Alpha', count: 1 },
      { group: 'Zeta', count: 2 },
    ]);
  });

  it('is empty when nothing is grouped', () => {
    expect(groupCounts([{ kind: 'skill', name: 'a', description: '', owned: true, group: null }])).toEqual([]);
  });
});
