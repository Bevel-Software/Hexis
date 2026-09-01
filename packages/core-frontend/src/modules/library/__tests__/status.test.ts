import { describe, it, expect } from 'vitest';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import {
  emptyMessageFor,
  filterLibraryItems,
  pluginCounts,
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

/**
 * The distinction this whole feature exists for: a STORED credential and a
 * WORKING one are different claims, and the badge must not make the second on
 * the evidence of the first.
 */
describe('toolStatus: stored vs working', () => {
  const withKey = () =>
    tool({
      variables: [
        { name: 'API_KEY', scope: 'user', label: null, key: 'slack_API_KEY', adminConfigured: false, userConfigured: true },
      ],
    });

  it('says Key saved — not Connected — when a key is stored but never tested', () => {
    // No verdict at all is the DEFAULT everywhere but the tool page: nothing is
    // stored, so a list built from saved values can never earn "Connected".
    const s = toolStatus(withKey());
    expect(s.state).toBe('ok');
    expect(s.text).toBe('Key saved');
    // Green, because nothing needs a person; but the word claims only what is known.
    expect(s.hint).toMatch(/not verified/i);
  });

  it('says Key saved when the probe could not reach a verdict', () => {
    const s = toolStatus(withKey(), { status: 'unverifiable', detail: 'Provider timed out.', checkedAt: new Date().toISOString() });
    expect(s.state).toBe('ok');
    expect(s.text).toBe('Key saved');
    expect(s.hint).toBe('Provider timed out.');
  });

  it('earns Connected only from a passing probe, and shows when it was checked', () => {
    const s = toolStatus(withKey(), { status: 'ok', detail: null, checkedAt: new Date().toISOString() });
    expect(s.state).toBe('ok');
    expect(s.text).toBe('Connected');
    expect(s.hint).toMatch(/^Checked /);
  });

  it('goes red with the provider\'s own words when the credential is rejected', () => {
    const s = toolStatus(withKey(), { status: 'failed', detail: 'Invalid API key.', checkedAt: new Date().toISOString() });
    expect(s.state).toBe('err');
    expect(s.text).toBe('Not working');
    expect(s.hint).toBe('Invalid API key.');
  });

  it('says Signed in rather than Key saved when the tool is oauth-backed', () => {
    const s = toolStatus(
      tool({
        variables: [
          { name: 'SIGNIN', scope: 'user', label: null, key: 'slack_SIGNIN', adminConfigured: true, userConfigured: true, oauth: true, authorized: true },
        ],
      }),
    );
    expect(s.text).toBe('Signed in');
  });

  /**
   * Setup outranks the verdict. A `failed` from before the key was entered must
   * never displace the thing actually in the way — "Needs a key from you" is the
   * sentence the reader can act on.
   */
  it('names the missing key rather than a stale failure', () => {
    const s = toolStatus(
      tool({
        variables: [
          { name: 'API_KEY', scope: 'user', label: null, key: 'slack_API_KEY', adminConfigured: false, userConfigured: false },
        ],
      }),
      { status: 'failed', detail: 'Invalid API key.', checkedAt: new Date().toISOString() },
    );
    expect(s.state).toBe('warn');
    expect(s.text).toBe('Needs a key from you');
  });

  it('says No key needed for a tool that asks for nothing', () => {
    // "Key saved" would name a key the user was never asked for.
    expect(toolStatus(tool({ variables: [] })).text).toBe('No key needed');
  });

  /** An unverified tool blocks nothing: it needs no person, so a skill is Ready. */
  it('leaves a skill Ready when its tools are merely unverified', () => {
    expect(skillStatus([withKey()]).state).toBe('ok');
  });
});

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
    { kind: 'skill', name: 'Weekly newsletter', description: 'drafts the Friday newsletter', owned: true, plugin: 'Everyone' },
    { kind: 'skill', name: 'RFI responder', description: 'answers requests', owned: false, plugin: 'GTM' },
    { kind: 'integration', name: 'Slack', description: 'messages', owned: false, plugin: 'Everyone' },
    { kind: 'integration', name: 'GitHub', description: 'code and change requests', owned: true, plugin: null },
  ];

  it('narrows to a plugin. Skills and tools together, not split by kind', () => {
    expect(filterLibraryItems(items, { kind: 'group', plugin: 'Everyone' }, '').map((i) => i.name)).toEqual([
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
    expect(filterLibraryItems(items, { kind: 'group', plugin: 'GTM' }, 'slack')).toEqual([]);
  });
});

describe('pluginCounts', () => {
  it('counts per plugin, skips ungrouped, and sorts by name not by count', () => {
    const items: LibraryFilterable[] = [
      { kind: 'skill', name: 'a', description: '', owned: false, plugin: 'Zeta' },
      { kind: 'skill', name: 'b', description: '', owned: false, plugin: 'Alpha' },
      { kind: 'integration', name: 'c', description: '', owned: false, plugin: 'Zeta' },
      { kind: 'skill', name: 'd', description: '', owned: false, plugin: null },
    ];
    // Alpha first despite having fewer items — a nav that reorders itself when
    // a plugin gains an item moves under the pointer.
    expect(pluginCounts(items)).toEqual([
      { plugin: 'Alpha', count: 1 },
      { plugin: 'Zeta', count: 2 },
    ]);
  });

  it('is empty when nothing is grouped', () => {
    expect(pluginCounts([{ kind: 'skill', name: 'a', description: '', owned: true, plugin: null }])).toEqual([]);
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
