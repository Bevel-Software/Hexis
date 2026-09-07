import { describe, it, expect } from 'vitest';
import { pluginLabel, pluginNameForPath } from '../utils/plugin-summary';

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
