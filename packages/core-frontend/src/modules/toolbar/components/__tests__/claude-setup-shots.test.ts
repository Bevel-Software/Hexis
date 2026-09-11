import { describe, expect, it } from 'vitest';
import {
  installPluginsShot,
  pluginsAddShot,
  selectRepositoryShot,
} from '../claude-setup-shots';

describe('Claude setup screenshot callouts', () => {
  it('points non-admins at the repository picker trigger', () => {
    expect(selectRepositoryShot.alt).toContain('Select repository');
    expect(selectRepositoryShot.boxes).toHaveLength(1);
  });

  it('highlights both Plugins and Add before opening the marketplace menu', () => {
    expect(pluginsAddShot.boxes).toHaveLength(2);
    expect(pluginsAddShot.alt).toContain('Plugins tab');
    expect(pluginsAddShot.alt).toContain('Add button');
  });

  it('highlights the whole Hexis all row', () => {
    expect(installPluginsShot.boxes).toHaveLength(1);
    expect(installPluginsShot.boxes[0].w).toBeGreaterThan(60);
    expect(installPluginsShot.alt).toContain('whole Hexis all row');
  });
});
