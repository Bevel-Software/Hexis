import { compileCheck, exampleArguments } from '@bevel-software/platform-mcp-core';
import { describe, expect, it } from 'vitest';
import { hexisCatalog } from '../../../__tests__/hexis-catalog.js';
import { routeToolSchemas } from '../route-tool-schemas.js';

/**
 * Every tool a route mounts declares two schemas: the one a client sees
 * (`inputs`, with the platform tools' arguments under `body`) and the FLAT one
 * the route itself checks a call against. The `Call:` line at the top of each
 * description is generated from the first; the route refuses by the second.
 * The two must agree, or a call written from the example is refused one
 * layer in, with nothing in the description to say why.
 *
 * Held here, over the whole catalog Hexis registers, because the flat schema
 * is this module's: `routeToolSchemas` is how a mounted route finds its own,
 * and no other module reads it.
 */
describe('the flat schema a route checks against accepts the call its own example shows', () => {
  it('for every tool Hexis mounts on a route', async () => {
    const { internal } = await hexisCatalog();
    const mounted = internal.filter((tool) => routeToolSchemas(tool.name) !== undefined);
    // The catalog is the real one: the family every scenario names is in it.
    for (const name of ['read_file', 'write_file', 'list_files', 'grep', 'move_file']) {
      expect(mounted.some((t) => t.name === name), name).toBe(true);
    }
    expect(mounted.length).toBeGreaterThan(12);
    for (const tool of mounted) {
      // The client's schema is the flat one in its envelope (`bodyEnvelope`),
      // so the client's example and the route's check meet on the flat schema:
      // an example written from it must pass the check made from it.
      const flat = routeToolSchemas(tool.name)!.flat;
      const check = compileCheck(flat);
      expect(check.checkable, `${tool.name} (flat): ${check.checkable ? '' : check.reason}`).toBe(true);
      if (!check.checkable) throw new Error(check.reason);
      expect(check.check(exampleArguments(flat)), `${tool.name} (flat)`).toEqual([]);
    }
  });
});
