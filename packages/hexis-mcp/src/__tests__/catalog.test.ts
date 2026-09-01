import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Tool as UtcpTool } from '@utcp/sdk';
import { flattenManualTool, type ProxiedTool } from '@bevel-software/platform-mcp-core';
import { localManualTemplates, remoteManualTemplate, REMOTE_MANUAL_NAME } from '../manuals.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { discoverTools, getSkillPrompt, listSkillPrompts, listedTools, withoutRemoteMetaTools } from '../server.js';
import { DeploymentError, fetchAllManuals, fetchLocalOnlyManuals, resolveMcpUrl } from '../deployment.js';

function tool(mcpName: string, manualName = REMOTE_MANUAL_NAME): ProxiedTool {
  return {
    utcpName: `${manualName}.${mcpName}`,
    mcpName,
    description: `the ${mcpName} tool`,
    inputSchema: { type: 'object', properties: {} },
    manualName,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('remoteManualTemplate', () => {
  it('carries the key as a header on an http MCP transport', () => {
    const template = remoteManualTemplate('https://x.example/api/mcp', 'bevel_k') as unknown as {
      name: string;
      call_template_type: string;
      config: { mcpServers: Record<string, { transport: string; url: string; headers: Record<string, string> }> };
    };
    expect(template.name).toBe(REMOTE_MANUAL_NAME);
    expect(template.call_template_type).toBe('mcp');
    const server = template.config.mcpServers[REMOTE_MANUAL_NAME]!;
    expect(server).toMatchObject({
      transport: 'http',
      url: 'https://x.example/api/mcp',
      headers: { Authorization: 'Bearer bevel_k' },
    });
  });
});

describe('localManualTemplates', () => {
  const localHttp = {
    name: 'localbox',
    call_template_type: 'http',
    http_method: 'GET',
    url: 'http://localhost:9000/utcp',
  };
  const remoteHttp = {
    name: 'serper',
    call_template_type: 'http',
    http_method: 'GET',
    url: 'https://google.serper.dev/utcp',
  };

  it('registers only the manuals the deployment called local-only', () => {
    const out = localManualTemplates([localHttp, remoteHttp], new Set(['localbox']));
    expect(out.map((m) => m.name)).toEqual(['localbox']);
  });

  it('takes nothing when nothing is local-only — the hosted endpoint already serves it all', () => {
    expect(localManualTemplates([localHttp, remoteHttp], new Set())).toEqual([]);
  });

  const platformRef = {
    name: 'git',
    call_template_type: 'http',
    http_method: 'GET',
    url: 'https://knowledge.example.com/api/tools/git/manual',
  };

  it("lets a platform '.tool' reference carry cli tools — the reason this server exists", () => {
    // The deployment serves a `.tool` manual as an http reference, and UTCP's
    // secure default limits a manual to its template's own protocol. Without
    // the widening, every cli tool in a local `.tool` was silently dropped at
    // registration ("registered manual 'git' with 0 tools") and no session
    // ever had `git.push`.
    const out = localManualTemplates([platformRef], new Set(['git']));
    expect(out[0]!.allowed_communication_protocols).toEqual(['cli', 'http']);
  });

  it('widens ONLY the platform reference shape — a genuine local http integration stays strict', () => {
    const out = localManualTemplates([localHttp], new Set(['localbox']));
    expect(out[0]!.allowed_communication_protocols).toBeUndefined();
  });

  it('respects a declared protocol list — an empty one included — and leaves non-http templates alone', () => {
    const explicit = { ...platformRef, name: 'a', allowed_communication_protocols: ['http'] };
    // An explicit [] is the author's restriction (the SDK reads it as
    // own-protocol-only); declaring it must not be treated as absence.
    const explicitEmpty = { ...platformRef, name: 'b', allowed_communication_protocols: [] as string[] };
    const mcpLocal = {
      name: 'stdiobox',
      call_template_type: 'mcp',
      config: { mcpServers: { stdiobox: { transport: 'stdio', command: 'x', args: [] } } },
    };
    const out = localManualTemplates([explicit, explicitEmpty, mcpLocal], new Set(['a', 'b', 'stdiobox']));
    expect(out[0]!.allowed_communication_protocols).toEqual(['http']);
    expect(out[1]!.allowed_communication_protocols).toEqual([]);
    expect(out[2]!.allowed_communication_protocols ?? []).toEqual([]);
  });

  it('drops a malformed manual instead of failing the whole catalog', () => {
    const broken = { name: 'broken', call_template_type: 'nonsense-protocol' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = localManualTemplates([broken, localHttp], new Set(['broken', 'localbox']));
    expect(out.map((m) => m.name)).toEqual(['localbox']);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('broken'));
  });
});

describe('discoverTools', () => {
  it('removes the deployment\'s meta-tool copies from the REGISTRY, not just the listing', async () => {
    // A chain and the local `list_tools` reflect over the tool repository, so
    // a remote `hexis.call_tool_chain` left registered would stay reachable —
    // and would run against the remote registry that cannot see local tools.
    const repo = new Map<string, UtcpTool>();
    for (const name of ['read_file', 'list_tools', 'tools_info', 'call_tool_chain']) {
      repo.set(
        `${REMOTE_MANUAL_NAME}.${name}`,
        { name: `${REMOTE_MANUAL_NAME}.${name}`, description: '', inputs: { type: 'object' } } as unknown as UtcpTool,
      );
    }
    const client = {
      registerManual: async () => ({ success: true }),
      getTools: async () => [...repo.values()],
      config: { tool_repository: { removeTool: async (n: string) => repo.delete(n) } },
    };
    const tools = await discoverTools(client as never, { name: REMOTE_MANUAL_NAME } as never, []);
    expect([...repo.keys()]).toEqual([`${REMOTE_MANUAL_NAME}.read_file`]);
    expect(tools.map((t) => t.mcpName)).toEqual(['read_file']);
  });
});

describe('withoutRemoteMetaTools', () => {
  it('drops the deployment\'s meta-tools, which describe the wrong registry', () => {
    const kept = withoutRemoteMetaTools([
      tool('read_file'),
      tool('list_tools'),
      tool('tools_info'),
      tool('call_tool_chain'),
      tool('grep'),
    ]);
    expect(kept.map((t) => t.mcpName)).toEqual(['read_file', 'grep']);
  });
});

describe('listedTools', () => {
  it('serves the local meta-tools ahead of the discovered ones', () => {
    const names = listedTools([tool('read_file')]).map((t) => t.name);
    expect(names.slice(0, 3)).toEqual(['list_tools', 'tools_info', 'call_tool_chain']);
    expect(names).toContain('read_file');
  });

  it('lets the workspace tool win the one collision flattening can actually produce', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A local manual's tools are always namespaced (`localbox.read_file` →
    // `localbox_read_file`), so a bare workspace name like `read_file` can
    // never be shadowed. The reachable collision is between FLATTENED names:
    // the workspace serving a tool literally NAMED `localbox_read_file`.
    const utcp = (name: string, description: string) =>
      ({ name, description, inputs: { type: 'object', properties: {} } }) as unknown as UtcpTool;
    const flattened = [
      utcp('hexis.localbox_read_file', 'the workspace copy'),
      utcp('localbox.read_file', 'the local copy'),
    ].map((t) => flattenManualTool(t, REMOTE_MANUAL_NAME));
    expect(flattened.map((t) => t.mcpName)).toEqual(['localbox_read_file', 'localbox_read_file']);
    const survivors = listedTools(flattened).filter((t) => t.name === 'localbox_read_file');
    expect(survivors).toHaveLength(1);
    // Remote-first discovery order is what makes the workspace copy the winner.
    expect(survivors[0]!.description).toBe('the workspace copy');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('localbox_read_file (duplicate)'));
  });

  it('bares the deployment MCP-shaped names: manual.server.tool, both segments stripped', () => {
    // The remote manual is MCP-protocol and its single server shares the
    // manual's name, so core tools arrive as `hexis.hexis.read_file` — THREE
    // segments. One strip left `hexis.read_file`, an invalid MCP name, and
    // the entire remote toolset was dropped from the listing (caught live
    // against a real deployment; the fixtures above had encoded the hosted
    // proxy's two-segment HTTP shape instead).
    const utcp = (name: string) =>
      ({ name, description: '', inputs: { type: 'object', properties: {} } }) as unknown as UtcpTool;
    expect(flattenManualTool(utcp('hexis.hexis.read_file'), REMOTE_MANUAL_NAME).mcpName).toBe('read_file');
    // Local manuals keep their fully namespaced, underscore-sanitized names.
    expect(
      flattenManualTool(utcp('local_toolbox.local_toolbox.local_echo'), REMOTE_MANUAL_NAME).mcpName,
    ).toBe('local_toolbox_local_toolbox_local_echo');
  });

  it('drops a tool a meta-tool would shadow, so the listing never advertises an uncallable name', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const listed = listedTools([{ ...tool('read_file'), mcpName: 'call_tool_chain' }]);
    expect(listed.filter((t) => t.name === 'call_tool_chain')).toHaveLength(1);
    expect(listed.find((t) => t.name === 'call_tool_chain')!.description).toMatch(/Execute a short JavaScript/);
  });
});

describe('resolveMcpUrl', () => {
  const config = { baseUrl: 'https://x.example', connectionKey: 'bevel_k' };

  function stubConfigEndpoint(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  }

  it('uses the endpoint the deployment advertises, not one we compute', async () => {
    stubConfigEndpoint({ mcpUrl: 'https://proxied.example/api/mcp' });
    vi.spyOn(console, 'error').mockImplementation(() => {}); // the cross-origin note, tested below
    expect(await resolveMcpUrl(config)).toBe('https://proxied.example/api/mcp');
  });

  it('falls back to <base>/api/mcp on a deployment too old to advertise it, and says so', async () => {
    stubConfigEndpoint({ branchModel: { defaultBranch: 'main' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveMcpUrl(config)).toBe('https://x.example/api/mcp');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('does not advertise'));
  });

  it('refuses an advertised endpoint that is not http(s)', async () => {
    stubConfigEndpoint({ mcpUrl: 'javascript:alert(1)' });
    await expect(resolveMcpUrl(config)).rejects.toThrow(/non-http MCP endpoint/);
  });

  it('reports an unreachable deployment as such rather than as an empty toolset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(resolveMcpUrl(config)).rejects.toThrow(/Could not reach the deployment config/);
  });

  it('strips credentials embedded in the advertised endpoint, and says so', async () => {
    stubConfigEndpoint({ mcpUrl: 'https://user:pass@proxied.example/api/mcp' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveMcpUrl(config)).toBe('https://proxied.example/api/mcp');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('dropped credentials'));
  });

  it('names a cross-origin endpoint on stderr instead of following it silently', async () => {
    stubConfigEndpoint({ mcpUrl: 'https://other.example/api/mcp' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveMcpUrl(config)).toBe('https://other.example/api/mcp');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('routes MCP through https://other.example'));
  });

  it('a same-host scheme swap is a different origin too — a downgrade must be named', async () => {
    const host = new URL(config.baseUrl).host;
    stubConfigEndpoint({ mcpUrl: `http://${host}/api/mcp` });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveMcpUrl(config)).toBe(`http://${host}/api/mcp`);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(`routes MCP through http://${host}`));
  });

  it('reports a 200 that is not JSON as a deployment problem, not a parser bug', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><title>login</title>', { status: 200 })));
    await expect(resolveMcpUrl(config)).rejects.toBeInstanceOf(DeploymentError);
    await expect(resolveMcpUrl(config)).rejects.toThrow(/not JSON/);
  });
});

describe('getJson unauthorized messaging', () => {
  const config = { baseUrl: 'https://x.example', connectionKey: 'bevel_k' };

  it('blames the connection key only on a request that actually carried it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(fetchAllManuals(config)).rejects.toThrow(/connection key was rejected/);
  });

  it('keeps the key out of the story when the failing request carried no credentials', async () => {
    // `/api/config` sends no Authorization header, so its 401 is an
    // interceptor (SSO gate, proxy), not a bad key.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const err = (await resolveMcpUrl(config).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(DeploymentError);
    expect(err.message).toMatch(/refused access \(HTTP 401\)/);
    expect(err.message).not.toMatch(/connection key/);
  });
});

describe('skill prompts', () => {
  const config = { baseUrl: 'https://x.example', connectionKey: 'bevel_k' };

  it('lists skills as prompts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ skills: [{ name: 'deploy', description: 'd' }] }), { status: 200 })),
    );
    expect(await listSkillPrompts(config)).toEqual({
      prompts: [{ name: 'deploy', description: 'd', arguments: [] }],
    });
  });

  it('propagates an upstream list failure instead of serving an empty prompt list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(listSkillPrompts(config)).rejects.toBeInstanceOf(DeploymentError);
  });

  it('serves a loaded skill as its prompt text', async () => {
    const skill = { name: 'deploy', description: 'd', body: 'Do.', path: 'skills/deploy', files: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, kind: 'skill', skill }), { status: 200 })),
    );
    const res = await getSkillPrompt(config, 'deploy');
    expect(res.messages[0]!.content).toEqual({ type: 'text', text: 'Do.' });
  });

  it('reserves "Unknown skill" (InvalidParams) for a lookup that succeeded and found nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'no such skill' }), { status: 200 })),
    );
    await expect(getSkillPrompt(config, 'ghost')).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Unknown skill "ghost"'),
    });
  });

  it('propagates an upstream get_skill failure rather than calling it the caller\'s mistake', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(getSkillPrompt(config, 'deploy')).rejects.toBeInstanceOf(DeploymentError);
  });
});

describe('fetchAllManuals / fetchLocalOnlyManuals', () => {
  const config = { baseUrl: 'https://x.example', connectionKey: 'bevel_k' };

  it('fails loudly on shape drift — an empty toolset must not look like success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
    );
    await expect(fetchAllManuals(config)).rejects.toBeInstanceOf(DeploymentError);
    await expect(fetchLocalOnlyManuals(config)).rejects.toThrow(/expected shape/);
  });

  it('treats an EMPTY list as valid — no local-only tools is a state, not drift', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ manuals: [], tools: [] }), { status: 200 })),
    );
    expect(await fetchAllManuals(config)).toEqual([]);
    expect((await fetchLocalOnlyManuals(config)).size).toBe(0);
  });
});
