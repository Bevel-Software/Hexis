import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { flattenManualTool, toListedTool } from '@bevel-software/platform-mcp-core';
import { ToolRegistry } from '../tool-registry.js';
import { createManualRoutes } from '../manual.routes.js';
import {
  TOOL_READ_ONLY_SETTING,
  ToolReadOnlyHints,
  UnknownToolError,
  createToolHintsAgentRoutes,
  createToolHintsRoutes,
} from '../read-only-hints.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import { registerWorkflowTools } from '../../workflow/agent-tools/workflow.tools.js';
import { registerChangeRequestReadTools } from '../../workflow/agent-tools/change-request-read.tools.js';
import { registerWorkspaceTools } from '../../workspace/workspace.tools.js';
import { registerSkillsTools } from '../../skills/skills.tools.js';
import { registerPluginsTools } from '../../plugins/plugins.tools.js';
import { registerToolManualsTools } from '../../tool-manuals/tool-manuals.tools.js';
import { registerEmbedTools } from '../../embed/embed.tools.js';
import { registerAgentGuideTool } from '../../agent-guide/agent-guide.tools.js';
import { ToolDescriptionNotes } from '../../workspace/agent-access.gate.js';
import { parseToolReadOnlyOverrides } from '../../settings/deployment-settings.service.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * The read-only hint of every platform tool, as the deployment serves it to
 * both MCP servers: the `read-only` tag on the agent manual (the hosted
 * endpoint) and `GET /agent/tool-hints` (`hexis-mcp`). Built from the real
 * registrars, as `create-core-server` registers them, so a tool that declares
 * itself wrongly fails here by name.
 */

/** A stub service: every method answers an empty list (see `own-tool-schemas.test.ts`). */
const nothing = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : async () => []) }) as never;
const pass: express.RequestHandler = (_req, _res, next) => next();
const handler = (() => pass) as never;

/** The tools the ticket names as readers, every one of which must list `readOnlyHint: true`. */
const READERS = [
  'start_session',
  'grep',
  'list_files',
  'read_file',
  'file_stat',
  'request_file_download',
  'list_branches',
  'list_skills',
  'get_skill',
  'list_local_tools',
  'list_tool_setup',
  'get_change_request',
  'list_change_requests',
  'list_change_request_files',
  'list_change_request_comments',
  'list_change_request_reviews',
  'get_agent_guide',
  'ask',
];

/** The tools the ticket names as writers, every one of which must list `readOnlyHint: false`. */
const WRITERS = [
  'write_file',
  'write_files',
  'edit_file',
  'save_file',
  'mkdir',
  'copy_file',
  'move_file',
  'delete_file',
  'delete_folder',
  'unzip',
  'request_file_upload',
  'apply_file_upload',
  'create_branch',
  'switch_branch',
  'delete_branch',
  'merge_branch',
  'commit_change',
  'share_current_branch',
  'open_change_request',
  'post_change_request_comment',
  'create_plugin',
  'my_plugin',
];

/** Writers the in-app agent alone is served: on neither MCP server's listing. */
const INTERNAL_ONLY = new Set(['switch_branch']);

/** Every tool module the server registers, with stand-in services. */
function platformRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const kb = testKbContext();
  registerWorkflowTools(registry, express.Router(), pass, handler, kb, async () => true);
  registerChangeRequestReadTools(registry, express.Router(), pass, handler, nothing, kb);
  registerWorkspaceTools(
    registry,
    express.Router(),
    pass,
    handler,
    nothing,
    nothing,
    nothing,
    kb,
    { recoveryBotEmail: 'recovery@bevel.software', hooks: nothing, notes: new ToolDescriptionNotes() },
    nothing,
    nothing,
    undefined,
    undefined,
    nothing,
    undefined,
    nothing,
  );
  registerSkillsTools(registry, express.Router(), pass, handler, nothing);
  registerPluginsTools(registry, kb);
  registerEmbedTools(registry, express.Router(), pass, handler, {
    embedService: nothing,
    kb,
    readForTool: nothing,
    canBeReached: () => true,
    appUrlFor: (repoRelative) => `https://example.test/${repoRelative}`,
    notes: new ToolDescriptionNotes(),
  });
  registerToolManualsTools(registry, express.Router(), pass, handler, nothing, {
    accessControl: nothing,
    variableStatus: nothing,
    kb,
  });
  registerAgentGuideTool(registry, express.Router(), pass, handler, async () => []);
  // `ask` is registered by the deployment's agent overlay (`ext.tools`), not
  // by core; it declares itself the way every other non-writing tool does.
  registry.registerExternalTool(
    toolDef({ name: 'ask', description: 'Ask the agent.', path: '/api/agent/tools/ask', inputs: { type: 'object', properties: {} } }),
  );
  return registry;
}

/** The deployment-settings surface the hints use, over one in-memory row. */
function memorySettings(initial = '') {
  const state = { value: initial, writes: 0, updatedBy: null as string | null };
  return {
    state,
    port: {
      reload: async (key: string) => (key === TOOL_READ_ONLY_SETTING ? state.value : ''),
      recordIfAbsent: async (_key: string, value: string, by: string | null) => {
        if (state.value) return false;
        if (parseToolReadOnlyOverrides(value) === null) return false;
        state.value = value;
        state.writes += 1;
        state.updatedBy = by;
        return true;
      },
      swapIfValue: async (_key: string, expected: string, next: string | null, by: string | null) => {
        if (state.value !== expected) return false;
        state.value = next ?? '';
        state.writes += 1;
        state.updatedBy = by;
        return true;
      },
    },
  };
}

/** The agent manual as the hosted MCP server lists it: flattened, then turned into listing entries. */
async function hostedListing(registry: ToolRegistry, hints: ToolReadOnlyHints) {
  const manual = await hints.apply(await registry.listExternal());
  return new Map(
    manual
      .map((t) => toListedTool(flattenManualTool({ ...t, name: `KNOWLEDGE_BASE.${t.name}` }, 'KNOWLEDGE_BASE')))
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map((e) => [e.name, e]),
  );
}

describe('the built-in hint of every platform tool', () => {
  it('lists every reader the ticket names as read-only and every writer as not, from the write declaration', async () => {
    const registry = platformRegistry();
    const listing = await hostedListing(registry, new ToolReadOnlyHints(registry, memorySettings().port));
    for (const name of READERS) expect(listing.get(name)?.annotations, name).toEqual({ readOnlyHint: true });
    for (const name of WRITERS.filter((n) => !INTERNAL_ONLY.has(n))) {
      expect(listing.get(name)?.annotations, name).toEqual({ readOnlyHint: false });
    }
  });

  it('would list `switch_branch` as a writer: it declares one, and is served to no MCP client at all', async () => {
    // Internal-only (it steers the in-app agent's next turn), so neither MCP
    // server lists it. Its declaration still decides its hint, should that change.
    const registry = platformRegistry();
    const hints = new ToolReadOnlyHints(registry, memorySettings().port);
    expect((await registry.listExternal()).some((t) => t.name === 'switch_branch')).toBe(false);
    const internal = (await registry.listInternal()).find((t) => t.name === 'switch_branch');
    expect(internal?.tags).toContain('write');
    const [applied] = await hints.apply([internal!]);
    expect(applied!.tags).not.toContain('read-only');
  });

  it('carries the hint on EVERY platform tool, and no other annotation', async () => {
    const registry = platformRegistry();
    const listing = await hostedListing(registry, new ToolReadOnlyHints(registry, memorySettings().port));
    expect(listing.size).toBeGreaterThan(READERS.length + WRITERS.length - 1);
    for (const [name, entry] of listing) {
      expect(Object.keys(entry.annotations ?? {}), name).toEqual(['readOnlyHint']);
    }
  });

  it('agrees with the map `hexis-mcp` reads, meta-tools included', async () => {
    const registry = platformRegistry();
    const hints = new ToolReadOnlyHints(registry, memorySettings().port);
    const listing = await hostedListing(registry, hints);
    const served = await hints.hints();
    for (const [name, entry] of listing) expect(served[name], name).toBe(entry.annotations?.readOnlyHint);
    expect(served).toMatchObject({ list_tools: true, tools_info: true, call_tool_chain: false });
  });

  it("leaves every tool's name, description and schemas as the registry has them", async () => {
    const registry = platformRegistry();
    const before = await registry.listExternal();
    const after = await new ToolReadOnlyHints(registry, memorySettings().port).apply(before);
    const untagged = (tools: typeof before) => tools.map((t) => ({ ...t, tags: undefined }));
    expect(untagged(after)).toEqual(untagged(before));
    // And the registry's own defs are never written to.
    expect((await registry.listExternal()).some((t) => (t.tags ?? []).includes('read-only'))).toBe(false);
  });
});

describe('an override', () => {
  it('flips a reader and a writer, and a reset puts each back and removes the override', async () => {
    const registry = platformRegistry();
    const settings = memorySettings();
    const hints = new ToolReadOnlyHints(registry, settings.port);

    expect(await hints.set('read_file', false, 'admin@x')).toMatchObject({ builtIn: true, override: false, readOnly: false });
    expect(await hints.set('write_file', true, 'admin@x')).toMatchObject({ builtIn: false, override: true, readOnly: true });
    expect(JSON.parse(settings.state.value)).toEqual({ read_file: false, write_file: true });
    expect(settings.state.updatedBy).toBe('admin@x');
    let listing = await hostedListing(registry, hints);
    expect(listing.get('read_file')?.annotations).toEqual({ readOnlyHint: false });
    expect(listing.get('write_file')?.annotations).toEqual({ readOnlyHint: true });

    expect(await hints.set('write_file', null, 'admin@x')).toMatchObject({ override: null, readOnly: false });
    expect(await hints.set('read_file', null, 'admin@x')).toMatchObject({ override: null, readOnly: true });
    // The last override gone is the row gone: every tool on its built-in value.
    expect(settings.state.value).toBe('');
    listing = await hostedListing(registry, hints);
    expect(listing.get('read_file')?.annotations).toEqual({ readOnlyHint: true });
    expect(listing.get('write_file')?.annotations).toEqual({ readOnlyHint: false });
  });

  it('applies to a code-mode meta-tool', async () => {
    const registry = platformRegistry();
    const hints = new ToolReadOnlyHints(registry, memorySettings().port);
    expect(await hints.set('call_tool_chain', true, null)).toMatchObject({ kind: 'meta', builtIn: false, readOnly: true });
    expect(await hints.overrides()).toEqual({ call_tool_chain: true });
    expect((await hints.hints()).call_tool_chain).toBe(true);
  });

  it('refuses a name that is neither a platform tool nor a meta-tool', async () => {
    const registry = platformRegistry();
    const settings = memorySettings();
    const hints = new ToolReadOnlyHints(registry, settings.port);
    await expect(hints.set('serper_search', true, null)).rejects.toBeInstanceOf(UnknownToolError);
    expect(settings.state.writes).toBe(0);
  });

  it('reads an unreadable stored value as no override at all', async () => {
    const registry = platformRegistry();
    const hints = new ToolReadOnlyHints(registry, memorySettings('{"read_file":"yes"}').port);
    expect(await hints.overrides()).toEqual({});
  });
});

describe('the setting holds only a map of tool names to booleans', () => {
  it('accepts a map, and blank as no override', () => {
    expect(parseToolReadOnlyOverrides('{"read_file":false,"call_tool_chain":true}')).toEqual({
      read_file: false,
      call_tool_chain: true,
    });
    expect(parseToolReadOnlyOverrides('')).toEqual({});
  });

  it.each(['[]', 'true', '{"read_file":"false"}', '{"bad name":true}', 'not json'])('refuses %s', (raw) => {
    expect(parseToolReadOnlyOverrides(raw)).toBeNull();
  });
});

describe('the routes', () => {
  let server: HttpServer | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  /** A deployment with the three routes and the agent manual; `x-email` stands in for the session. */
  async function start(admins: string[]) {
    const registry = platformRegistry();
    const settings = memorySettings();
    const hints = new ToolReadOnlyHints(registry, settings.port);
    const app = express();
    app.use(express.json());
    app.use('/api', createManualRoutes(registry, pass, undefined, hints));
    app.use('/api', createToolHintsAgentRoutes(hints, pass));
    app.use(
      '/api',
      (req, _res, next) => {
        req.userEmail = req.header('x-email') ?? undefined;
        next();
      },
      createToolHintsRoutes(hints, { isAdmin: async (email) => !!email && admins.includes(email) }),
    );
    server = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const put = (name: string, body: unknown, email: string) =>
      fetch(`${base}/tool-hints/${name}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-email': email },
        body: JSON.stringify(body),
      });
    const manualTags = async (name: string) => {
      const manual = (await (await fetch(`${base}/agent/utcp`)).json()) as { tools: Array<{ name: string; tags: string[] }> };
      return manual.tools.find((t) => t.name === name)?.tags ?? [];
    };
    return { base, settings, put, manualTags };
  }

  it("refuses a non-admin's write, and writes nothing", async () => {
    const { put, settings, base } = await start(['admin@x']);
    const res = await put('write_file', { readOnly: true }, 'member@x');
    expect(res.status).toBe(403);
    expect(settings.state.writes).toBe(0);
    // A non-admin still reads every value, and is told they may not edit.
    const listed = (await (await fetch(`${base}/tool-hints`, { headers: { 'x-email': 'member@x' } })).json()) as {
      canEdit: boolean;
      tools: Array<{ name: string; readOnly: boolean; kind: string }>;
    };
    expect(listed.canEdit).toBe(false);
    expect(listed.tools.find((t) => t.name === 'read_file')).toMatchObject({ readOnly: true, kind: 'platform' });
    expect(listed.tools.filter((t) => t.kind === 'meta').map((t) => t.name)).toEqual([
      'list_tools',
      'tools_info',
      'call_tool_chain',
    ]);
  });

  it("applies an admin's override to the next manual and hint map, and a reset removes it", async () => {
    const { put, manualTags, base } = await start(['admin@x']);
    expect(await manualTags('write_file')).not.toContain('read-only');

    const res = await put('write_file', { readOnly: true }, 'admin@x');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'write_file', override: true, readOnly: true });
    expect(await manualTags('write_file')).toContain('read-only');
    const hints = (await (await fetch(`${base}/agent/tool-hints`)).json()) as { tools: Record<string, boolean> };
    expect(hints.tools.write_file).toBe(true);

    expect((await put('write_file', { readOnly: null }, 'admin@x')).status).toBe(200);
    expect(await manualTags('write_file')).not.toContain('read-only');
    const admin = (await (await fetch(`${base}/tool-hints`, { headers: { 'x-email': 'admin@x' } })).json()) as {
      canEdit: boolean;
      tools: Array<{ name: string; override: boolean | null }>;
    };
    expect(admin.canEdit).toBe(true);
    expect(admin.tools.find((t) => t.name === 'write_file')?.override).toBeNull();
  });

  it('answers 404 for an unknown tool and 400 for a value that is not true, false or null', async () => {
    const { put, settings } = await start(['admin@x']);
    expect((await put('serper_search', { readOnly: true }, 'admin@x')).status).toBe(404);
    expect((await put('read_file', { readOnly: 'yes' }, 'admin@x')).status).toBe(400);
    expect((await put('read_file', {}, 'admin@x')).status).toBe(400);
    expect(settings.state.writes).toBe(0);
  });
});

