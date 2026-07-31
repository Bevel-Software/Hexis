import { describe, it, expect } from 'vitest';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import {
  filterLibraryItems,
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

describe('filterLibraryItems (category chips + search)', () => {
  const items: LibraryFilterable[] = [
    { kind: 'skill', name: 'Weekly newsletter', description: 'drafts the Friday newsletter', owned: true },
    { kind: 'skill', name: 'RFI responder', description: 'answers requests', owned: false },
    { kind: 'integration', name: 'Slack', description: 'messages', owned: false },
    { kind: 'integration', name: 'GitHub', description: 'code and change requests', owned: true },
  ];

  it('narrows by category', () => {
    expect(filterLibraryItems(items, 'skills', '').map((i) => i.name)).toEqual([
      'Weekly newsletter',
      'RFI responder',
    ]);
    expect(filterLibraryItems(items, 'integrations', '').map((i) => i.name)).toEqual([
      'Slack',
      'GitHub',
    ]);
    expect(filterLibraryItems(items, 'owned', '').map((i) => i.name)).toEqual([
      'Weekly newsletter',
      'GitHub',
    ]);
  });

  it('search matches name or description within the category, case-insensitively', () => {
    expect(filterLibraryItems(items, 'skills', 'friday').map((i) => i.name)).toEqual([
      'Weekly newsletter',
    ]);
    expect(filterLibraryItems(items, 'integrations', 'CHANGE').map((i) => i.name)).toEqual([
      'GitHub',
    ]);
    expect(filterLibraryItems(items, 'skills', 'slack')).toEqual([]);
  });
});
