import { describe, it, expect } from 'vitest';
import type { LibraryItem } from '../state/library-data';
import type { PluginSummary } from '../services/plugins.api';
import { pluginEntriesFor } from '../utils/plugin-entries';

/**
 * The plugin rows of a gallery page, from both witnesses. Driven through the
 * one exported function with crafted catalogs and summaries.
 */

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  kind: 'skill',
  id: 'x',
  name: 'x',
  description: '',
  owned: false,
  status: { state: 'ok', text: 'Ready' },
  plugin: null,
  path: 'Skills/x',
  ...over,
});

const summary = (over: Partial<PluginSummary>): PluginSummary => ({
  name: 'gtm',
  displayName: 'GTM',
  folders: ['Plugins/GTM'],
  linksAreManaged: true,
  canRead: true,
  canWrite: false,
  isOwner: false,
  skillCount: 3,
  toolCount: 2,
  brokenLinks: 0,
  owners: { roles: [], users: [] },
  writers: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  hasRequested: false,
  requestNumber: null,
  ...over,
});

const names = (entries: { name: string | null }[]) => entries.map((e) => e.name);

describe('pluginEntriesFor', () => {
  it('leads Everything with the own space, then every plugin either witness names', () => {
    const items = [
      item({ id: 'a', name: 'a', plugin: 'ops', path: 'Plugins/Ops/skills/a' }),
      // Reached only through a LINK: no folder item names the plugin.
      item({ id: 'b', name: 'b', shared: true, path: 'Skills/Eng/b', plugins: [{ name: 'eng', linked: true, granted: true }] }),
      item({ id: 'mine', name: 'mine', path: 'Plugins/personal-u1/skills/mine' }),
    ];
    const entries = pluginEntriesFor(items, [summary({})], { kind: 'all' }, [], '', 'Yours');
    expect(names(entries)).toEqual([null, 'eng', 'gtm', 'ops']);
    expect(entries[0]).toMatchObject({ label: 'Yours', skillCount: 1, toolCount: 0, member: true });
  });

  it('counts a plugin\'s items by folder OR by link, the way its page lists them', () => {
    const items = [
      item({ id: 'a', name: 'a', plugin: 'gtm', path: 'Plugins/GTM/skills/a' }),
      item({ id: 'b', name: 'b', shared: true, path: 'Skills/Eng/b', plugins: [{ name: 'gtm', linked: true, granted: true }] }),
      item({ kind: 'integration', id: 't', name: 't', plugin: 'gtm', path: 'Plugins/GTM/mcp.json' }),
    ];
    // No summary: the catalog's own counts stand.
    const [, gtm] = pluginEntriesFor(items, [], { kind: 'all' }, [], '', 'Yours');
    expect(gtm).toMatchObject({ name: 'gtm', skillCount: 2, toolCount: 1, member: true });
  });

  it('is a member by READ, never by write — an admin rescued into the rules of a folder they cannot open is locked out', () => {
    const rescued = summary({ canRead: false, canWrite: true });
    const [, gtm] = pluginEntriesFor([], [rescued], { kind: 'all' }, [], '', 'Yours');
    expect(gtm?.member).toBe(false);
    // …but a linked skill in the catalog proves they can read something of it.
    const linked = item({ id: 'b', name: 'b', shared: true, path: 'Skills/Eng/b', plugins: [{ name: 'gtm', linked: true, granted: true }] });
    const [, again] = pluginEntriesFor([linked], [rescued], { kind: 'all' }, [], '', 'Yours');
    expect(again?.member).toBe(true);
  });

  it('Owned by me keeps the plugins the caller manages, own space first', () => {
    const entries = pluginEntriesFor(
      [],
      [summary({ name: 'gtm', canWrite: true }), summary({ name: 'ops', displayName: 'Ops', canWrite: false })],
      { kind: 'owned' },
      [],
      '',
      'Yours',
    );
    expect(names(entries)).toEqual([null, 'gtm']);
  });

  it("a team's rows are the server's plugins, counted by the team's slice, with no own space", () => {
    const items = [
      item({ id: 'a', name: 'a', plugin: 'gtm', path: 'Plugins/GTM/skills/a' }),
      item({ id: 'b', name: 'b', plugin: 'gtm', path: 'Plugins/GTM/skills/b' }),
      item({ kind: 'integration', id: 't', name: 't', plugin: 'gtm', path: 'Plugins/GTM/mcp.json' }),
    ];
    const teams = [{ name: 'Sales', plugins: ['gtm'], skills: ['a'], tools: [] }];
    const entries = pluginEntriesFor(items, [summary({ skillCount: 9, toolCount: 9 })], { kind: 'team', group: 'Sales' }, teams, '', 'Yours');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'gtm', skillCount: 1, toolCount: 0 });
    // An unknown team lists nothing — and so does a known one that names no plugin.
    expect(pluginEntriesFor(items, [summary({})], { kind: 'team', group: 'Nobody' }, teams, '', 'Yours')).toEqual([]);
    const empty = [{ name: 'Sales', plugins: [], skills: ['a'], tools: [] }];
    expect(pluginEntriesFor(items, [summary({})], { kind: 'team', group: 'Sales' }, empty, '', 'Yours')).toEqual([]);
  });

  it('a search narrows the rows by label, own space included', () => {
    const entries = pluginEntriesFor([], [summary({}), summary({ name: 'ops', displayName: 'Ops' })], { kind: 'all' }, [], 'gt', 'Yours');
    expect(names(entries)).toEqual(['gtm']);
    expect(names(pluginEntriesFor([], [summary({})], { kind: 'all' }, [], 'you', 'Yours'))).toEqual([null]);
  });

  it('lists no plugins for a plugin page or the personal page', () => {
    expect(pluginEntriesFor([], [summary({})], { kind: 'group', plugin: 'gtm' }, [], '', 'Yours')).toEqual([]);
    expect(pluginEntriesFor([], [summary({})], { kind: 'ungrouped' }, [], '', 'Yours')).toEqual([]);
  });
});
