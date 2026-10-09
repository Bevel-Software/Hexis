import { describe, expect, it, vi } from 'vitest';
import type { AdminMenuItem, AppDef } from '../../../../core/registry';
import {
  COMMAND_SHORTCUTS,
  coreCommandActions,
  mergeCommandActions,
  suggestedActions,
  visibleActions,
  type CommandAction,
  type CommandContext,
} from '../actions';

/**
 * The command list on its own, without a menu: what core offers, what each
 * context hides, and how a distribution's commands join it.
 */

const APPS: AppDef[] = [
  // Out of order on purpose: the commands follow the switcher's `order`.
  { id: 'skills-tools', label: 'Skills & Tools', path: '/skills-and-tools', order: 20, element: <></> },
  { id: 'knowledge', label: 'Knowledge', path: '/workspace', order: 10, element: <></> },
];

const USER = { id: 'u1', email: 'ada@example.com', name: 'Ada' };

const row = (over: Partial<AdminMenuItem> & { id: string }): AdminMenuItem => ({ label: over.id, ...over });

function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    navigate: vi.fn(),
    user: USER,
    isAdmin: false,
    activeAppId: 'knowledge',
    openFilePath: null,
    editablePage: null,
    openWorkspacePath: vi.fn(),
    invite: { open: vi.fn(), invitedRevision: 0 },
    createPage: vi.fn(async () => 'kb/KnowledgeBase/Untitled.md'),
    onboardingPending: false,
    ...over,
  };
}

const labels = (actions: CommandAction[]) => actions.map((a) => a.label);

describe('coreCommandActions', () => {
  const settings = {
    defaultItems: [
      row({ id: 'secrets', label: 'Secrets', path: '/secrets' }),
      row({ id: 'dialog-row', label: 'Feedback', dialog: () => <></> }),
      row({ id: 'node-label', label: <b>Fancy</b>, path: '/fancy' }),
    ],
    adminItems: [row({ id: 'roles', label: 'App roles', path: '/roles-and-members' })],
  };
  const all = coreCommandActions({ apps: APPS, settings });

  it('offers a member the page verbs, the apps and their own settings', () => {
    expect(labels(visibleActions(all, ctx()))).toEqual([
      'New page',
      'Connect your agent',
      'Go to Knowledge',
      'Go to Skills & Tools',
      'Settings: Secrets',
    ]);
  });

  it('adds Invite people and the admin settings for an admin', () => {
    expect(labels(visibleActions(all, ctx({ isAdmin: true })))).toEqual([
      'New page',
      'Invite people',
      'Connect your agent',
      'Go to Knowledge',
      'Go to Skills & Tools',
      'Settings: Secrets',
      'Settings: App roles',
    ]);
  });

  it('leaves out New page before the workspace knows its folder, and Invite with no dialog to open', () => {
    const shown = labels(visibleActions(all, ctx({ isAdmin: true, createPage: null, invite: null })));
    expect(shown).not.toContain('New page');
    expect(shown).not.toContain('Invite people');
  });

  it('offers Edit this page only for the open page the viewer says can be edited', () => {
    const page = 'kb/KnowledgeBase/Notes.md';
    expect(labels(visibleActions(all, ctx({ openFilePath: page })))).not.toContain('Edit this page');
    expect(labels(visibleActions(all, ctx({ openFilePath: page, editablePage: page })))).toContain('Edit this page');
    // A stale verdict for another page offers nothing.
    expect(labels(visibleActions(all, ctx({ openFilePath: page, editablePage: 'kb/Other.md' })))).not.toContain(
      'Edit this page',
    );
  });

  it('runs a settings row’s own onSelect ahead of its path, as the profile menu does', () => {
    const onSelect = vi.fn(({ navigate }: { navigate(to: string): void }) => navigate('/chosen'));
    const [action] = coreCommandActions({
      apps: [],
      settings: { defaultItems: [row({ id: 'x', label: 'X', path: '/declared', onSelect })], adminItems: [] },
    }).filter((a) => a.id === 'settings:x');
    const c = ctx();
    void action.run(c);
    expect(c.navigate).toHaveBeenCalledWith('/chosen');
    expect(c.navigate).not.toHaveBeenCalledWith('/declared');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ user: USER }));
  });

  it('offers a settings row only while its isShown holds for the signed-in person, as the profile menu does', () => {
    const isShown = vi.fn((user: { email: string }) => user.email === 'ada@example.com');
    const actions = coreCommandActions({
      apps: [],
      settings: { defaultItems: [row({ id: 'undo', label: 'Ask again', onSelect: vi.fn(), isShown })], adminItems: [] },
    });
    expect(labels(visibleActions(actions, ctx()))).toContain('Settings: Ask again');
    expect(labels(visibleActions(actions, ctx({ user: { ...USER, email: 'bob@example.com' } })))).not.toContain(
      'Settings: Ask again',
    );
    // Signed out there is nobody to show the profile menu's rows to.
    expect(labels(visibleActions(actions, ctx({ user: null })))).not.toContain('Settings: Ask again');
  });
});

describe('shortcut hints', () => {
  it('come from the table the shortcuts are bound by, and only for bound commands', () => {
    const all = coreCommandActions({ apps: APPS, settings: { defaultItems: [], adminItems: [] } });
    const hint = (id: string) => all.find((a) => a.id === id)?.shortcut;
    expect(hint('new-page')).toEqual(['C']);
    expect(hint('go-to:knowledge')).toEqual(['G', 'K']);
    expect(hint('go-to:skills-tools')).toEqual(['G', 'S']);
    expect(hint('invite')).toBeUndefined();
    expect(Object.keys(COMMAND_SHORTCUTS).sort()).toEqual(['go-to:knowledge', 'go-to:skills-tools', 'new-page']);
  });
});

describe('suggestedActions', () => {
  const all = coreCommandActions({ apps: APPS, settings: { defaultItems: [], adminItems: [] } });
  const suggest = (c: CommandContext) => labels(suggestedActions(visibleActions(all, c), c));

  it('suggests the commonest verbs and the way to the other app', () => {
    expect(suggest(ctx({ isAdmin: true, onboardingPending: true }))).toEqual([
      'New page',
      'Invite people',
      'Connect your agent',
      'Go to Skills & Tools',
    ]);
    expect(suggest(ctx({ activeAppId: 'skills-tools' }))).toEqual(['New page', 'Go to Knowledge']);
  });
});

describe('mergeCommandActions / visibleActions', () => {
  const core = coreCommandActions({ apps: [], settings: { defaultItems: [], adminItems: [] } });

  it('puts the registry’s commands after core’s and drops a reused id', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const extra: CommandAction[] = [
      { id: 'new-ontology', label: 'New ontology', visible: () => true, run: vi.fn() },
      { id: 'new-page', label: 'Impostor', visible: () => true, run: vi.fn() },
    ];
    const merged = mergeCommandActions(core, extra);
    expect(merged.map((a) => a.id).slice(-1)).toEqual(['new-ontology']);
    expect(labels(merged)).not.toContain('Impostor');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps a registry command whose keys collide with bound ones, but drops its shortcut', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const withKeys = coreCommandActions({ apps: APPS, settings: { defaultItems: [], adminItems: [] } });
    const extra: CommandAction[] = [
      { id: 'clash', label: 'Clash', shortcut: ['c'], visible: () => true, run: vi.fn() },
      { id: 'prefix', label: 'Prefix', shortcut: ['G'], visible: () => true, run: vi.fn() },
      { id: 'longer', label: 'Longer', shortcut: ['g', 'k', 'x'], visible: () => true, run: vi.fn() },
      // Three keys that collide with nothing: still unbindable, so still dropped.
      { id: 'too-long', label: 'Too long', shortcut: ['x', 'y', 'z'], visible: () => true, run: vi.fn() },
      { id: 'fine', label: 'Fine', shortcut: ['O'], visible: () => true, run: vi.fn() },
      { id: 'also-fine', label: 'Also fine', shortcut: ['g', 'o'], visible: () => true, run: vi.fn() },
    ];
    const merged = mergeCommandActions(withKeys, extra);
    const shortcutOf = (id: string) => merged.find((a) => a.id === id)?.shortcut;
    expect(merged.map((a) => a.id).slice(-6)).toEqual(['clash', 'prefix', 'longer', 'too-long', 'fine', 'also-fine']);
    expect(shortcutOf('clash')).toBeUndefined();
    expect(shortcutOf('prefix')).toBeUndefined();
    expect(shortcutOf('longer')).toBeUndefined();
    expect(shortcutOf('too-long')).toBeUndefined();
    expect(shortcutOf('fine')).toEqual(['O']);
    expect(shortcutOf('also-fine')).toEqual(['g', 'o']);
    expect(error).toHaveBeenCalledTimes(4);
    error.mockRestore();
  });

  it('drops a command whose visible() throws, and keeps the rest', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: CommandAction = {
      id: 'broken',
      label: 'Broken',
      visible: () => {
        throw new Error('boom');
      },
      run: vi.fn(),
    };
    expect(labels(visibleActions(mergeCommandActions(core, [broken]), ctx()))).toEqual([
      'New page',
      'Connect your agent',
    ]);
    error.mockRestore();
  });
});
