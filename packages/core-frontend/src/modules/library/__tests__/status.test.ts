import { describe, it, expect } from 'vitest';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import {
  emptyMessageFor,
  filterLibraryItems,
  groupCounts,
  neededToolsFor,
  skillStatus,
  toolStatus,
  type LibraryFilterable,
} from '../utils/status';
import { toastDuration } from '../utils/toast-duration';

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

  it('flags a missing shared value in AMBER, and says what it needs', () => {
    const t = tool({
      variables: [
        { name: 'API_KEY', scope: 'admin', label: null, key: 'k', adminConfigured: false, userConfigured: false },
      ],
    });
    // Never grey. Grey read as "disabled" or "not your problem", when an
    // unconfigured integration is the state that most needs somebody.
    expect(toolStatus(t)).toEqual({ state: 'warn', text: 'Needs setup' });
    expect(toolStatus(tool({ ...t, canWrite: true })).text).toBe('Needs setup: yours to set up');
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
    expect(skillStatus([]).state).toBe('ok');
  });

  it('names the integration standing in the skill\'s way, not just that one is', () => {
    // The first unhealthy one: fixing it either unblocks the skill or reveals
    // the next name, and "Needs setup" told you neither.
    expect(skillStatus([slack, notion])).toEqual({ state: 'warn', text: `Needs ${notion.name}` });
  });
});

describe('filterLibraryItems (sidebar selection + search)', () => {
  const items: LibraryFilterable[] = [
    { kind: 'skill', name: 'Weekly newsletter', description: 'drafts the Friday newsletter', owned: true, group: 'Everyone' },
    { kind: 'skill', name: 'RFI responder', description: 'answers requests', owned: false, group: 'GTM' },
    { kind: 'integration', name: 'Slack', description: 'messages', owned: false, group: 'Everyone' },
    { kind: 'integration', name: 'GitHub', description: 'code and change requests', owned: true, group: null },
  ];

  it('narrows to a group. Skills and tools together, not split by kind', () => {
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

describe('emptyMessageFor', () => {
  /**
   * An empty view and a failed search are different facts, and saying the
   * wrong one is worse than saying nothing: told "you're not responsible for
   * changes in any skills yet" after mistyping a search, you would believe the
   * shelf was empty rather than that you had missed.
   */
  it('names why the view is empty when nobody searched', () => {
    expect(emptyMessageFor({ kind: 'owned' }, '')).toBe(
      "You're not responsible for changes in any skills yet.",
    );
  });

  it('blames the search when there is one, in that same view', () => {
    expect(emptyMessageFor({ kind: 'owned' }, 'postgres')).toBe('Nothing here matches yet.');
    // Whitespace is not a search.
    expect(emptyMessageFor({ kind: 'owned' }, '   ')).toBe(
      "You're not responsible for changes in any skills yet.",
    );
  });

  it('leaves the other views on the general wording', () => {
    expect(emptyMessageFor({ kind: 'all' }, '')).toBe('Nothing here matches yet.');
    expect(emptyMessageFor({ kind: 'ungrouped' }, '')).toBe('Nothing here matches yet.');
  });
});

describe('toastDuration', () => {
  /**
   * The flat 2.6s was set when the only toast said "Copied". A 76-character
   * confirmation on that budget is unreadable — the message is the whole point
   * of a toast, so how long it stays has to follow how long it takes to read.
   */
  it('gives a long message time to be read', () => {
    const done = 'Done. Reopen the setup any time from your profile menu → External agent access.';
    expect(toastDuration(done)).toBeGreaterThan(4500);
  });

  it('does not blink a short one', () => {
    expect(toastDuration('Copied')).toBe(3000);
  });

  // Nothing camps on the screen: a runaway message is still a message you can
  // ignore, but a permanent one is a bug wearing a toast.
  it('caps however long the message is', () => {
    expect(toastDuration('x'.repeat(5000))).toBe(9000);
  });

  it('is never shorter for a longer message', () => {
    const lengths = [0, 10, 40, 80, 160, 400];
    const times = lengths.map((n) => toastDuration('x'.repeat(n)));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
