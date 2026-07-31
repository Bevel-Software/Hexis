import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tool-registry.js';
import type { UtcpTool } from '../tool.contract.js';

function fakeTool(name: string): UtcpTool {
  return {
    name,
    description: `the ${name} tool`,
    inputs: { type: 'object', properties: {} },
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: { call_template_type: 'http' } as never,
  } as UtcpTool;
}

describe('ToolRegistry', () => {
  it('keeps external and internal catalogs separate', async () => {
    const r = new ToolRegistry();
    r.registerExternalTool(fakeTool('ask'));
    r.registerInternalTool(fakeTool('commit_change'));
    expect((await r.listExternal()).map((t) => t.name)).toEqual(['ask']);
    expect((await r.listInternal()).map((t) => t.name)).toEqual(['commit_change']);
  });

  it('a `both` tool registers into both catalogs', async () => {
    const r = new ToolRegistry();
    const t = fakeTool('list_branches');
    r.registerExternalTool(t);
    r.registerInternalTool(t);
    expect((await r.listExternal()).map((x) => x.name)).toContain('list_branches');
    expect((await r.listInternal()).map((x) => x.name)).toContain('list_branches');
  });

  it('resolves a ToolProvider lazily and appends it after static tools', async () => {
    const r = new ToolRegistry();
    r.registerExternalTool(fakeTool('ask'));
    r.registerExternalTool(() => fakeTool('list_skills'));
    expect((await r.listExternal()).map((t) => t.name)).toEqual(['ask', 'list_skills']);
  });

  it('resolves an async (Promise-returning) ToolProvider', async () => {
    const r = new ToolRegistry();
    r.registerExternalTool(async () => fakeTool('list_skills'));
    expect((await r.listExternal()).map((t) => t.name)).toEqual(['list_skills']);
  });

  it('passes the ToolManualContext through to providers', async () => {
    const r = new ToolRegistry();
    let received: { userEmail?: string } | undefined;
    r.registerExternalTool((ctx) => {
      received = ctx;
      return fakeTool('list_skills');
    });
    await r.listExternal({ userEmail: 'a@b.eu' });
    expect(received).toEqual({ userEmail: 'a@b.eu' });
  });

  it('throws on a duplicate name within a surface, but not across surfaces', () => {
    const r = new ToolRegistry();
    r.registerExternalTool(fakeTool('ask'));
    expect(() => r.registerExternalTool(fakeTool('ask'))).toThrow(/Duplicate external/);
    expect(() => r.registerInternalTool(fakeTool('ask'))).not.toThrow();
  });
});
