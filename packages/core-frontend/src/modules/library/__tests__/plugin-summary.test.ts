import { describe, it, expect } from 'vitest';
import {
  adminNamesOf,
  ownersTextOf,
  pluginLabel,
  pluginNameForPath,
  pluginsHoldingTool,
} from '../utils/plugin-summary';

const summaries = [
  { name: 'gtm', displayName: 'Go To Market', folders: ['Plugins/GTM'] },
  { name: 'deep', displayName: 'Deep', folders: ['Plugins/GTM/teams/Deep'] },
];

describe('pluginNameForPath', () => {
  it('names the plugin by the catalog folder holding the path — the deepest one', () => {
    expect(pluginNameForPath('Plugins/GTM/skills/outreach', summaries)).toBe('gtm');
    expect(pluginNameForPath('Plugins/GTM/teams/Deep/skills/x', summaries)).toBe('deep');
  });

  it('asks the catalog FIRST: a listed folder names the plugin whatever the folder is called', () => {
    const listed = [{ name: 'shelf', displayName: 'Shelf', folders: ['Plugins/personal-u1'] }];
    expect(pluginNameForPath('Plugins/personal-u1/skills/notes', listed)).toBe('shelf');
  });

  it('falls back to the folder for an unlisted path, and to null for a personal shelf', () => {
    expect(pluginNameForPath('Plugins/Legacy/skills/x', summaries)).toBe('Legacy');
    expect(pluginNameForPath('Plugins/personal-u1/skills/notes', summaries)).toBeNull();
    expect(pluginNameForPath('Skills/Eng/deploy', summaries)).toBeNull();
  });
});

describe('pluginLabel', () => {
  it('is the display name, else the identity', () => {
    expect(pluginLabel('gtm', summaries)).toBe('Go To Market');
    expect(pluginLabel('unknown', summaries)).toBe('unknown');
  });
});

describe('pluginsHoldingTool', () => {
  // A tool file in one plugin's folder, and a root two other plugins link.
  const withRoots = [
    { name: 'gtm', folders: ['Plugins/GTM'], linkedRoots: ['Plugins/Shared/observability'] },
    { name: 'ops', folders: ['Plugins/Ops'], linkedRoots: ['Plugins/Shared/observability'] },
    { name: 'finance', folders: ['Plugins/Finance'], linkedRoots: [] },
  ];

  it('is INLINE in the plugin whose folder holds the file', () => {
    expect(pluginsHoldingTool('Plugins/GTM/heyreach.tool', withRoots)).toEqual([
      { name: 'gtm', linked: false, granted: true },
    ]);
  });

  it('is LINKED into every plugin whose linked root holds it — a shared root reaches them all', () => {
    expect(pluginsHoldingTool('Plugins/Shared/observability/grafana.tool', withRoots)).toEqual([
      { name: 'gtm', linked: true, granted: true },
      { name: 'ops', linked: true, granted: true },
    ]);
  });

  it('says INLINE once, never twice: a root inside the plugin’s own folder adds nothing', () => {
    const selfRooted = [{ name: 'gtm', folders: ['Plugins/GTM'], linkedRoots: ['Plugins/GTM/tools'] }];
    expect(pluginsHoldingTool('Plugins/GTM/tools/grafana.tool', selfRooted)).toEqual([
      { name: 'gtm', linked: false, granted: true },
    ]);
  });

  it('claims nothing on a sibling folder sharing a prefix, nor from an older server with no roots', () => {
    expect(pluginsHoldingTool('Plugins/Shared/observability-archive/old.tool', withRoots)).toEqual([]);
    const older = [{ name: 'gtm', folders: ['Plugins/GTM'] }];
    expect(pluginsHoldingTool('Plugins/Shared/observability/grafana.tool', older)).toEqual([]);
  });
});

/**
 * Who runs a plugin, as every line that names them reads it: the row and the
 * locked page (`ownersTextOf`), a skill page's reviewer (`ownersTextOf` of the
 * skill's plugin) and the Subscribe confirmations (`adminNamesOf`). The
 * listing sends a person by email with an empty `name`.
 */
describe('ownersTextOf and adminNamesOf', () => {
  const person = { name: '', email: 'qa-user@example.com' };

  it('name an owner sent by email alone by that email, not the Admin role among the writers', () => {
    const summary = { owners: { roles: [], users: [person] }, writers: { roles: ['Admin'], users: [person] } };
    expect(ownersTextOf(summary)).toBe('qa-user@example.com');
    expect(adminNamesOf(summary)).toEqual(['qa-user@example.com']);
  });

  it('keep a named person by name, and fall back to Admin only with no owner', () => {
    const named = { name: 'Olga Ivanova', email: 'olga@example.com' };
    expect(ownersTextOf({ owners: { roles: [], users: [named] }, writers: { roles: [], users: [] } })).toBe(
      'Olga Ivanova',
    );
    const ownerless = { owners: { roles: [], users: [] }, writers: { roles: ['Admin'], users: [] } };
    expect(ownersTextOf(ownerless)).toBe('Admin');
    expect(adminNamesOf(ownerless)).toEqual(['Admin']);
  });
});
