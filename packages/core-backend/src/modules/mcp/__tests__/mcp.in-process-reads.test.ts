import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallTemplate } from '@utcp/sdk';
import { McpService, type McpCaller, type McpSkillCaller } from '../mcp.service.js';
import { SpillStore } from '../../workspace/index.js';
import { createManualRoutes, ToolRegistry } from '../../tool-registry/index.js';
import { toolDef, ToolError } from '../../tool-helpers/index.js';
import type { AgentEventInput } from '../../audit/index.js';

/**
 * The hosted MCP endpoint reads a caller's manual list and their skills by
 * calling functions the composition hands it, and not by sending its own
 * server a request. Asserted against the real service, a real UTCP client and
 * a real MCP client.
 *
 * The loopback here serves the platform manual and a tool route, which tool
 * discovery and tool calls still use. It serves NO manual list and NO skill
 * route, and counts every request it gets for one: a read that went over
 * loopback would find nothing there, and would be counted.
 */

let httpServer: HttpServer | undefined;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
});

interface HarnessOptions {
  /** `'throws'`: the manual list reader fails. Default: it answers the harness's manuals. */
  manualList?: 'throws';
  /** Records the Audit log's events. */
  auditRecorder?: { record: (e: AgentEventInput) => void };
}

async function harness(opts: HarnessOptions = {}) {
  const registry = new ToolRegistry();
  registry.registerExternalTool(
    toolDef({
      name: 'read_file',
      description: 'read a file',
      path: '/api/agent/tools/read_file',
      inputs: { type: 'object', properties: { path: { type: 'string' } } },
    }),
  );
  const state = {
    base: '',
    /** Requests the loopback received for a manual list or a skill. */
    loopbackReads: [] as string[],
    /** What the manual list reader answers beside the platform manual. Handed out as it is, not copied. */
    manuals: [] as CallTemplate[],
    /** Every call the manual list reader answered. */
    manualListReads: [] as { userId: string; agentPath: string | null; remoteOnly: boolean }[],
    /** Every call the skill reads answered. */
    skillReads: [] as ({ read: 'list' } | { read: 'get'; name: string })[],
    skillCallers: [] as McpSkillCaller[],
    /** What the two skill reads do. */
    listSkills: (async () => ({ skills: [] })) as () => Promise<unknown>,
    getSkill: (async () => ({ ok: false, error: 'not_found' })) as (name: string) => Promise<unknown>,
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.path === '/api/agent/all-tools' || /\/api\/agent\/tools\/(list|get)_skills?$/.test(req.path)) {
      state.loopbackReads.push(req.path);
    }
    next();
  });
  app.post('/api/agent/tools/read_file', (req, res) => res.json({ path: (req.body as { path?: string }).path }));
  app.get('/api/test/late-manual', (_req, res) =>
    res.json({
      utcp_version: '1.1.0',
      manual_version: '1.0.0',
      tools: [
        {
          name: 'late_arrival',
          description: 'a tool of a manual the caller may read',
          inputs: { type: 'object', properties: {} },
          outputs: { type: 'object', properties: {} },
          tags: [],
          tool_call_template: {
            call_template_type: 'http',
            http_method: 'POST',
            url: `${state.base}/api/agent/tools/read_file`,
            content_type: 'application/json',
          },
        },
      ],
    }),
  );
  const noAuth: express.RequestHandler = (_req, _res, next) => next();
  app.use('/api', createManualRoutes(registry, noAuth));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  state.base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;

  const kbManual = {
    name: 'KNOWLEDGE_BASE',
    call_template_type: 'http',
    http_method: 'GET',
    url: '${API_URL}/api/agent/utcp',
    content_type: 'application/json',
    headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
  } as unknown as CallTemplate;

  const mcp = new McpService(
    {
      loopbackBaseUrl: state.base,
      manualName: 'KNOWLEDGE_BASE',
      spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
      publicFrontendUrl: 'http://localhost:5173',
      readCatalogRevision: async () => ({ revision: 'rev-1' }),
      readManualList: async (who, { remoteOnly }) => {
        state.manualListReads.push({ ...who, remoteOnly });
        if (opts.manualList === 'throws') throw new Error('the manual catalog could not be read');
        return { manuals: [kbManual, ...state.manuals] };
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts.auditRecorder as any,
  );
  mcp.readSkillsWith({
    list: (caller) => {
      state.skillCallers.push(caller);
      state.skillReads.push({ read: 'list' });
      return state.listSkills();
    },
    get: (caller, name) => {
      state.skillCallers.push(caller);
      state.skillReads.push({ read: 'get', name });
      return state.getSkill(name);
    },
  });
  return { state, mcp };
}

/** One request's server, driven over an in-memory pair — the route builds one per HTTP request. */
async function connect(mcp: McpService, caller: Partial<McpCaller> = {}): Promise<Client> {
  const server = await mcp.createRequestServer(
    { userId: 'user-A', tokenId: 'key-1', connectionId: null, bearer: 'bevel_key_1', ...caller },
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const lateManual = (base: string): CallTemplate =>
  ({ name: 'late-manual', call_template_type: 'http', url: `${base}/api/test/late-manual`, http_method: 'GET' }) as CallTemplate;

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

describe('McpService — the manual list is read in process', () => {
  it('builds the surface from the reader, for the caller, and sends the server no request for the list', async () => {
    const { state, mcp } = await harness();
    state.manuals = [lateManual(state.base)];

    const names = await toolNames(await connect(mcp));
    expect(names).toContain('read_file');
    expect(names.some((n) => n.endsWith('late_arrival'))).toBe(true);
    expect(state.manualListReads).toEqual([{ userId: 'user-A', agentPath: null, remoteOnly: true }]);
    expect(state.loopbackReads).toEqual([]);
  });

  it('reads the list once for two requests of one person: the surface is kept', async () => {
    const { state, mcp } = await harness();
    await toolNames(await connect(mcp));
    await toolNames(await connect(mcp));
    expect(state.manualListReads).toHaveLength(1);
  });

  it('reads the list for the agent a narrowed connection was made as', async () => {
    const { state, mcp } = await harness();
    await toolNames(await connect(mcp, { agentPath: 'Agents/narrow.agent' }));
    expect(state.manualListReads).toEqual([{ userId: 'user-A', agentPath: 'Agents/narrow.agent', remoteOnly: true }]);
  });

  // Discovery renames a manual in place to the name it registers under. What
  // the reader hands out may share parts with the catalog every caller is
  // served from, so whatever a build does, it does to a list of its own. (The
  // build copies twice over, through JSON and through validation; this holds
  // the property, whichever of them provides it.)
  it("leaves the reader's templates as the reader made them", async () => {
    const { state, mcp } = await harness();
    const handedOut = lateManual(state.base);
    const asMade = structuredClone(handedOut);
    state.manuals = [handedOut];

    const names = await toolNames(await connect(mcp));
    // Registered under a name without the hyphen, which is the rename.
    expect(names.some((n) => n.includes('late_manual') && n.endsWith('late_arrival'))).toBe(true);
    expect(handedOut).toEqual(asMade);
  });

  it('serves the platform tools alone when the reader fails, and reads again for the next request', async () => {
    const { state, mcp } = await harness({ manualList: 'throws' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await toolNames(await connect(mcp))).toContain('read_file');
    expect(await toolNames(await connect(mcp))).toContain('read_file');
    // Not kept: a surface built without the list would hide the caller's
    // manuals until their catalog next changed.
    expect(state.manualListReads).toHaveLength(2);
    expect(state.loopbackReads).toEqual([]);
  });
});

describe('McpService — the skills behind the prompts are read in process', () => {
  const rfi = { name: 'rfi', description: 'Answer a request for information.', path: 'Skills/rfi' };
  const loaded = { ...rfi, body: '# rfi\n\nFollow the steps.', files: ['Skills/rfi/template.md'] };

  it('lists the prompts from the list read, as the caller, with no request to the server', async () => {
    const { state, mcp } = await harness();
    state.listSkills = async () => ({ skills: [{ ...rfi, canWrite: true }] });

    const { prompts } = await (await connect(mcp)).listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['onboard', 'rfi']);
    expect(prompts[1]).toMatchObject({ name: 'rfi', description: rfi.description });
    expect(state.skillCallers).toEqual([{ userId: 'user-A', tokenId: 'key-1', agentPath: null }]);
    expect(state.loopbackReads).toEqual([]);
  });

  it('reads as the agent a narrowed connection was made as, and as a person with no key', async () => {
    const { state, mcp } = await harness();
    await (await connect(mcp, { agentPath: 'Agents/narrow.agent' })).listPrompts();
    await (await connect(mcp, { tokenId: null, bearer: 'a-session' })).listPrompts();
    expect(state.skillCallers).toEqual([
      { userId: 'user-A', tokenId: 'key-1', agentPath: 'Agents/narrow.agent' },
      { userId: 'user-A', tokenId: null, agentPath: null },
    ]);
  });

  it('serves a prompt from the skill read and records it as a skill read', async () => {
    const events: AgentEventInput[] = [];
    const { state, mcp } = await harness({ auditRecorder: { record: (e) => events.push(e) } });
    state.listSkills = async () => ({ skills: [rfi] });
    state.getSkill = async (name) => ({ ok: true, kind: 'skill', skill: { ...loaded, name } });

    const prompt = await (await connect(mcp)).getPrompt({ name: 'rfi' });
    expect(prompt.description).toBe(rfi.description);
    const text = (prompt.messages[0]!.content as { text: string }).text;
    expect(text).toContain('Follow the steps.');
    expect(text).toContain('"template.md"');
    expect(state.skillReads).toContainEqual({ read: 'get', name: 'rfi' });
    expect(events).toEqual([expect.objectContaining({ kind: 'skill', name: 'rfi', manual: 'Skills/rfi', outcome: 'ok' })]);
    expect(state.loopbackReads).toEqual([]);
  });

  it('answers an unknown skill as unknown, and records the failed read', async () => {
    const events: AgentEventInput[] = [];
    const { mcp } = await harness({ auditRecorder: { record: (e) => events.push(e) } });
    await expect((await connect(mcp)).getPrompt({ name: 'nope' })).rejects.toThrow('Unknown skill "nope".');
    expect(events).toEqual([expect.objectContaining({ kind: 'skill', name: 'nope', outcome: 'error' })]);
  });

  // A connection whose agent loads nothing is refused the skills by the read,
  // as its route refuses it with a 403. The endpoint lists it no prompt, in one
  // log line with no stack: it happens on every `prompts/list` of such a connection.
  it('lists no prompt for a connection the read refuses, in one log line', async () => {
    const { state, mcp } = await harness();
    state.listSkills = async () => {
      throw new ToolError('This connection loads nothing.', 403, { code: 'not_available_to_connection' });
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { prompts } = await (await connect(mcp, { agentPath: 'Agents/narrow.agent' })).listPrompts();
    expect(prompts).toEqual([]);
    const lines = errors.mock.calls.map((c) => c.map(String).join(' '));
    expect(lines.filter((l) => l.includes('skill list_skills refused: HTTP 403 This connection loads nothing.'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('    at ');
  });

  it('lists no skill when the read fails, and the request still answers', async () => {
    const { state, mcp } = await harness();
    state.listSkills = async () => {
      throw new Error('the skill catalog could not be read');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prompts } = await (await connect(mcp)).listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['onboard']);
  });
});
