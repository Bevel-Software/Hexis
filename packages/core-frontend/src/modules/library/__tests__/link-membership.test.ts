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
import { attentionOf, brokenLinksOf, type LibraryItem } from '../state/library-data';

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

  it('a broken link never erases a reason the card already shows', () => {
    const needsTools = { ...shared, status: { state: 'warn' as const, text: 'Needs setup: 1 tool' } };
    // Ops's link is broken too — but the card's own reason comes first.
    expect(withLinkHealth(needsTools, 'Ops').status).toBe(needsTools.status);
  });

  it("a broken link counts in the plugin's attention, apart from its tools", () => {
    const unsetTool = {
      kind: 'integration' as const,
      name: 'hubspot',
      description: '',
      owned: false,
      plugin: 'Ops',
      status: { state: 'warn' as const, text: 'Needs setup' },
    };
    const items = [shared, inline, personal, unsetTool] as unknown as LibraryItem[];
    // Ops: one tool to set up, one linked skill its members cannot read.
    expect(brokenLinksOf(items, 'Ops')).toBe(1);
    expect(attentionOf(items, 'Ops')).toBe(2);
    // GTM's link is granted: nothing to report.
    expect(brokenLinksOf(items, 'GTM')).toBe(0);
    expect(attentionOf(items, 'GTM')).toBe(0);
    // An inline skill is never a broken link, whatever `granted` says.
    const oddInline = { ...inline, plugins: [{ name: 'GTM', linked: false, granted: false }] };
    expect(brokenLinksOf([oddInline] as unknown as LibraryItem[], 'GTM')).toBe(0);
  });

  it("the server's broken-link count wins over the caller's catalog", () => {
    // The catalog cannot list a skill the caller may not read — which is the
    // skill a missing grant is about — so the summary's count decides.
    const items = [shared, inline] as unknown as LibraryItem[];
    expect(brokenLinksOf(items, 'GTM', [{ name: 'GTM', brokenLinks: 2 }])).toBe(2);
    expect(attentionOf(items, 'GTM', [{ name: 'GTM', brokenLinks: 2 }])).toBe(2);
    // An older server sends no count: the catalog is the fallback.
    expect(brokenLinksOf(items, 'Ops', [{ name: 'Ops' }])).toBe(1);
    expect(brokenLinksOf(items, 'Ops', [])).toBe(1);
  });
});
