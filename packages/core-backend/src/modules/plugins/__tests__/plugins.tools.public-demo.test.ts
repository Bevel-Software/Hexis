import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/index.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { registerPluginsTools } from '../plugins.tools.js';

const CALLER = { userEmail: 'alice@example.com' };

/** The names each surface lists after `registerPluginsTools`, external then internal. */
async function surfaces(publicDemo: boolean): Promise<string[][]> {
  const registry = new ToolRegistry();
  registerPluginsTools(registry, testKbContext(), publicDemo);
  return [
    (await registry.listExternal(CALLER)).map((t) => t.name),
    (await registry.listInternal(CALLER)).map((t) => t.name),
  ];
}

describe('the plugin-creation tools and the public demo', () => {
  it('are on neither surface on the public demo, where both doors refuse every call', async () => {
    for (const names of await surfaces(true)) {
      expect(names).not.toContain('my_plugin');
      expect(names).not.toContain('create_plugin');
    }
  });

  it('are on both surfaces on any other deployment', async () => {
    for (const names of await surfaces(false)) {
      expect(names).toEqual(expect.arrayContaining(['my_plugin', 'create_plugin']));
    }
  });
});
