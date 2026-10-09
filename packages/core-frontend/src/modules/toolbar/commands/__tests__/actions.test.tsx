import { describe, expect, it, vi } from 'vitest';
import type { AdminMenuItem, AppDef } from '../../../../core/registry';
import {
  COMMAND_SHORTCUTS,
  coreCommandActions,
  mergeCommandActions,
  shortcutId,
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
      'Create new page',
      'Connect your agent',
      'Go to Knowledge',
      'Go to Skills & Tools',
      'Settings: Secrets',
    ]);
  });

  it('adds Invite people and the admin settings for an admin', () => {
    expect(labels(visibleActions(all, ctx({ isAdmin: true })))).toEqual([
      'Create new page',
      'Invite people',
      'Connect your agent',
      'Go to Knowledge',
      'Go to Skills & Tools',
      'Settings: Secrets',
      'Settings: App roles',
    ]);
  });

  it('leaves out Create new page before the workspace knows its folder, and Invite with no dialog to open', () => {
    const shown = labels(visibleActions(all, ctx({ isAdmin: true, createPage: null, invite: null })));
    expect(shown).not.toContain('Create new page');
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
    // Never asked about nobody: `visibleActions` hides a row whose check
    // throws, so the label alone would pass without the signed-in gate.
    expect(isShown).toHaveBeenCalledTimes(2);
  });
});

describe('shortcut hints', () => {
  it('come from the table the shortcuts are bound by, and only for bound commands', () => {
    const all = coreCommandActions({ apps: APPS, settings: { defaultItems: [], adminItems: [] } });
    const hint = (id: string) => all.find((a) => a.id === id)?.shortcut;
    expect(hint('new-page')).toEqual({ key: 'c' });
    expect(hint('invite')).toEqual({ key: 'i', shift: true });
    expect(hint('go-to:knowledge')).toEqual({ key: 'k', shift: true });
    expect(hint('go-to:skills-tools')).toEqual({ key: 's', shift: true });
    expect(hint('edit-page')).toBeUndefined();
    expect(hint('connect-agent')).toBeUndefined();
    expect(Object.keys(COMMAND_SHORTCUTS).sort()).toEqual([
      'go-to:knowledge',
      'go-to:skills-tools',
      'invite',
      'new-page',
    ]);
  });

  it('names a shortcut by its letter, after shift+ when Shift is held', () => {
    expect(shortcutId({ key: 'C' })).toBe('c');
    expect(shortcutId({ key: 'k', shift: true })).toBe('shift+k');
    expect(shortcutId(undefined)).toBeNull();
  });

  it('calls the page command "Create new page", with "new page" among its names', () => {
    const all = coreCommandActions({ apps: APPS, settings: { defaultItems: [], adminItems: [] } });
    const newPage = all.find((a) => a.id === 'new-page')!;
    expect(newPage.label).toBe('Create new page');
    expect(newPage.keywords).toContain('new page');
  });
});

describe('suggestedActions', () => {
  const all = coreCommandActions({ apps: APPS, settings: { defaultItems: [], adminItems: [] } });
  const suggest = (c: CommandContext) => labels(suggestedActions(visibleActions(all, c), c));

  it('suggests the commonest verbs and the way to the other app', () => {
    expect(suggest(ctx({ isAdmin: true, onboardingPending: true }))).toEqual([
      'Create new page',
      'Invite people',
      'Connect your agent',
      'Go to Skills & Tools',
    ]);
    expect(suggest(ctx({ activeAppId: 'skills-tools' }))).toEqual(['Create new page', 'Go to Knowledge']);
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

  it('keeps a registry command whose shortcut is taken or not one letter, but drops its shortcut', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const withKeys = coreCommandActions({ apps: APPS, settings: { defaultItems: [], adminItems: [] } });
    const command = (id: string, shortcut: CommandAction['shortcut']): CommandAction => ({
      id,
      label: id,
      shortcut,
      visible: () => true,
      run: vi.fn(),
    });
    const extra: CommandAction[] = [
      // Taken by core: C, and ⇧K — whatever the letter's case.
      command('clash', { key: 'C' }),
      command('clash-shift', { key: 'k', shift: true }),
      // Not one letter.
      command('two-keys', { key: 'gk' }),
      command('digit', { key: '1' }),
      command('symbol', { key: '⇧' }),
      command('empty', { key: '' }),
      // One letter each, free: kept. ⇧C is free, since C is bound without Shift.
      command('fine', { key: 'O' }),
      command('fine-shift', { key: 'o', shift: true }),
      command('shift-c', { key: 'c', shift: true }),
      // Taken by the registry command before it.
      command('second', { key: 'o' }),
    ];
    const merged = mergeCommandActions(withKeys, extra);
    const shortcutOf = (id: string) => merged.find((a) => a.id === id)?.shortcut;
    expect(merged.map((a) => a.id).slice(-extra.length)).toEqual(extra.map((a) => a.id));
    for (const id of ['clash', 'clash-shift', 'two-keys', 'digit', 'symbol', 'empty', 'second']) {
      expect(shortcutOf(id)).toBeUndefined();
    }
    expect(shortcutOf('fine')).toEqual({ key: 'O' });
    expect(shortcutOf('fine-shift')).toEqual({ key: 'o', shift: true });
    expect(shortcutOf('shift-c')).toEqual({ key: 'c', shift: true });
    expect(error).toHaveBeenCalledTimes(7);
    // Each message names the command it is about.
    expect(error.mock.calls.map(([message]) => String(message))).toEqual(
      ['clash', 'clash-shift', 'two-keys', 'digit', 'symbol', 'empty', 'second'].map((id) =>
        expect.stringContaining(` of ${id} `),
      ),
    );
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
      'Create new page',
      'Connect your agent',
    ]);
    error.mockRestore();
  });
});
