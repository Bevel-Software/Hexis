import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ProxiedTool } from '@bevel-software/platform-mcp-core';
import { localManualTemplates, remoteManualTemplate, REMOTE_MANUAL_NAME } from '../manuals.js';
import { listedTools, withoutRemoteMetaTools } from '../server.js';
import { resolveMcpUrl } from '../deployment.js';

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

  it('drops a malformed manual instead of failing the whole catalog', () => {
    const broken = { name: 'broken', call_template_type: 'nonsense-protocol' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = localManualTemplates([broken, localHttp], new Set(['broken', 'localbox']));
    expect(out.map((m) => m.name)).toEqual(['localbox']);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('broken'));
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

  it('lets the workspace tool win a name collision with a local one', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const listed = listedTools([tool('read_file'), tool('read_file', 'localbox')]);
    expect(listed.filter((t) => t.name === 'read_file')).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('read_file (duplicate)'));
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
});
