import { describe, expect, it, vi } from 'vitest';
import {
  DENIED,
  MANUAL_TTL_MS,
  PageConsent,
  PageToolsClient,
  answerToolCall,
  asToolCall,
  pageName,
  type ToolCallMessage,
} from '../htmlToolBridge';

/**
 * The app's half of `window.bevel.tools`: the MCP calls a page's calls become,
 * the rule for which of them ask the viewer first, and the consent that holds
 * for one view of the page.
 */

const PAGE = 'Dashboards/Roadmap.html';

/** The deployment's UTCP manual: `read_file` reads, `edit_file` and `write_file` write. */
const MANUAL = {
  tools: [
    { name: 'read_file', tags: [] },
    { name: 'edit_file', tags: ['write'] },
    { name: 'write_file', tags: ['write'] },
  ],
};

interface Sent {
  url: string;
  headers: Headers;
  body: { method?: string; params?: { name: string; arguments: unknown }; page?: string; tool?: string };
}

/** A stand-in for the app's fetch: the manual, the MCP endpoint and the refusal route. */
function fakeServer(answer: (name: string, args: unknown) => unknown = (name) => ({ ran: name }), opts: { sse?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ url, headers: new Headers(init?.headers), body });
    if (url === '/api/agent/utcp') return Response.json(MANUAL);
    if (url === '/api/mcp/page-refusals') return new Response(null, { status: 204 });
    const result = answer(body.params.name, body.params.arguments);
    const message = { jsonrpc: '2.0', id: body.id, result };
    if (opts.sse) {
      return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json(message);
  });
  const mcpCalls = () => sent.filter((s) => s.url === '/api/mcp').map((s) => s.body.params!.name);
  return { sent, fetchImpl, mcpCalls };
}

/** A tool result carrying `value` as JSON text, the way the hosted server answers. */
const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

const call = (fn: ToolCallMessage['fn'], ...args: unknown[]): ToolCallMessage => ({
  type: 'bevel.tool.call',
  requestId: `r-${Math.random()}`,
  fn,
  args,
});

describe('PageToolsClient', () => {
  it("calls the hosted MCP server as the page, and answers with the tool's own result", async () => {
    const server = fakeServer((name) => text({ ran: name }), { sse: true });
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    await expect(client.callTool('read_file', { body: { path: 'a.md' } })).resolves.toEqual({ ran: 'read_file' });
    const [sent] = server.sent;
    expect(sent!.body).toMatchObject({ method: 'tools/call', params: { name: 'read_file', arguments: { body: { path: 'a.md' } } } });
    expect(decodeURIComponent(sent!.headers.get('X-Bevel-Page')!)).toBe(PAGE);
  });

  it("rejects with the tool's own refusal, as tools/call answers it", async () => {
    const server = fakeServer(() => ({ isError: true, content: [{ type: 'text', text: 'You don\'t have read access to "a.md"' }] }));
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    await expect(client.callTool('read_file', {})).rejects.toThrow('You don\'t have read access to "a.md"');
  });

  it('maps searchTools and toolsInfo onto list_tools and tools_info', async () => {
    const server = fakeServer((name, args) =>
      name === 'list_tools'
        ? text({ tools: ['KNOWLEDGE_BASE.list_change_requests', 'KNOWLEDGE_BASE.get_change_request', 'KNOWLEDGE_BASE.read_file'] })
        : text({ interfaces: `for ${JSON.stringify(args)}`, not_found: [] }),
    );
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    await expect(client.searchTools('change request')).resolves.toEqual({
      tools: ['KNOWLEDGE_BASE.list_change_requests', 'KNOWLEDGE_BASE.get_change_request'],
    });
    await expect(client.searchTools('')).resolves.toMatchObject({ tools: expect.arrayContaining(['KNOWLEDGE_BASE.read_file']) });
    await expect(client.toolsInfo(['read_file'])).resolves.toEqual({
      interfaces: 'for {"tool_names":["read_file"]}',
      not_found: [],
    });
    expect(server.mcpCalls()).toEqual(['list_tools', 'list_tools', 'tools_info']);
  });

  it('counts as writing a write-tagged tool, a tool the manual does not list, and every chain — never a read', async () => {
    const client = new PageToolsClient(PAGE, fakeServer().fetchImpl);
    expect(await client.mayWrite('callTool', ['read_file', {}])).toBe(false);
    expect(await client.mayWrite('searchTools', ['x'])).toBe(false);
    expect(await client.mayWrite('toolsInfo', [['x']])).toBe(false);
    expect(await client.mayWrite('callTool', ['list_tools', {}])).toBe(false);
    expect(await client.mayWrite('callTool', ['edit_file', {}])).toBe(true);
    expect(await client.mayWrite('callTool', ['notion_search', {}])).toBe(true);
    expect(await client.mayWrite('callToolChain', ['return 1'])).toBe(true);
    expect(await client.mayWrite('callTool', ['call_tool_chain', { code: 'x' }])).toBe(true);
  });

  it('reads the manual again once it is a minute old, so a tool retagged write asks', async () => {
    let tags: string[] = [];
    let reads = 0;
    let now = 1_000_000;
    const fetchImpl = async (url: string) => {
      if (url !== '/api/agent/utcp') throw new Error(`unexpected ${url}`);
      reads += 1;
      return Response.json({ tools: [{ name: 'publish', tags }] });
    };
    const client = new PageToolsClient(PAGE, fetchImpl, () => now);
    expect(await client.mayWrite('callTool', ['publish', {}])).toBe(false);
    tags = ['write'];
    now += MANUAL_TTL_MS - 1;
    expect(await client.mayWrite('callTool', ['publish', {}])).toBe(false);
    expect(reads).toBe(1);
    now += 1;
    expect(await client.mayWrite('callTool', ['publish', {}])).toBe(true);
    expect(reads).toBe(2);
  });

  it('counts everything but the reading meta-tools as writing when the manual cannot be read', async () => {
    const client = new PageToolsClient(PAGE, async () => new Response('', { status: 500 }));
    expect(await client.mayWrite('callTool', ['read_file', {}])).toBe(true);
    expect(await client.mayWrite('searchTools', ['x'])).toBe(false);
  });
});

describe('answering a page: reads at once, the first write asks', () => {
  function setup() {
    const server = fakeServer((name) => text({ ran: name }));
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    let answer: (ok: boolean) => void = () => {};
    const ask = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const consent = new PageConsent(ask);
    return { server, client, consent, ask, answer: (ok: boolean) => answer(ok) };
  }

  it('runs a read with no card', async () => {
    const { client, consent, ask, server } = setup();
    const res = await answerToolCall(call('callTool', 'read_file', { body: { path: 'a.md' } }), client, consent);
    expect(res).toMatchObject({ ok: true, result: { ran: 'read_file' } });
    expect(ask).not.toHaveBeenCalled();
    expect(server.mcpCalls()).toEqual(['read_file']);
  });

  it('asks on the first write; Allow runs it, and later writes run without asking', async () => {
    const { client, consent, ask, answer, server } = setup();
    const first = answerToolCall(call('callTool', 'edit_file', {}), client, consent);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    // Nothing runs while the card is open — a read included.
    const read = answerToolCall(call('callTool', 'read_file', {}), client, consent);
    await new Promise((r) => setTimeout(r, 10));
    expect(server.mcpCalls()).toEqual([]);
    answer(true);
    expect(await first).toMatchObject({ ok: true, result: { ran: 'edit_file' } });
    expect(await read).toMatchObject({ ok: true });
    expect(await answerToolCall(call('callTool', 'write_file', {}), client, consent)).toMatchObject({ ok: true });
    expect(await answerToolCall(call('callToolChain', 'return 1'), client, consent)).toMatchObject({ ok: true });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('Deny answers `denied`, runs nothing, reports the refusal, and the next write asks again', async () => {
    const { client, consent, ask, answer, server } = setup();
    const denied = answerToolCall(call('callTool', 'edit_file', { body: { path: 'a.md' } }), client, consent);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(false);
    expect(await denied).toMatchObject({ ok: false, error: DENIED, code: DENIED });
    expect(server.mcpCalls()).toEqual([]);
    await vi.waitFor(() =>
      expect(server.sent.find((s) => s.url === '/api/mcp/page-refusals')?.body).toEqual({
        page: PAGE,
        tool: 'edit_file',
        args: { body: { path: 'a.md' } },
      }),
    );

    void answerToolCall(call('callTool', 'edit_file', {}), client, consent);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
  });

  it('shows one card for writes that arrive together, and answers every one of them', async () => {
    const { client, consent, ask, answer } = setup();
    const writes = [
      answerToolCall(call('callTool', 'edit_file', {}), client, consent),
      answerToolCall(call('callTool', 'notion_create_page', {}), client, consent),
      answerToolCall(call('callToolChain', 'return 1'), client, consent),
    ];
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    answer(false);
    expect((await Promise.all(writes)).map((w) => w.ok)).toEqual([false, false, false]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again in a new view of the page: an Allow holds only until the page is reloaded', async () => {
    const { client, answer } = setup();
    const firstView = new PageConsent(() => Promise.resolve(true));
    await answerToolCall(call('callTool', 'edit_file', {}), client, firstView);
    const ask = vi.fn(() => Promise.resolve(false));
    const reloaded = new PageConsent(ask);
    expect(await answerToolCall(call('callTool', 'edit_file', {}), client, reloaded)).toMatchObject({ ok: false, code: DENIED });
    expect(ask).toHaveBeenCalledTimes(1);
    answer(true);
  });
});

describe('the frame messages the app reads', () => {
  it('accepts only a well-formed call of one of the five functions', () => {
    expect(asToolCall({ type: 'bevel.tool.call', requestId: 'r', fn: 'callTool', args: ['read_file', {}] })).not.toBeNull();
    expect(asToolCall({ type: 'bevel.tool.call', requestId: 'r', fn: 'uploadFile', args: [new Blob(['x']), {}] })).not.toBeNull();
    expect(asToolCall({ type: 'bevel.tool.call', requestId: 'r', fn: 'eval', args: [] })).toBeNull();
    expect(asToolCall({ type: 'bevel.tool.call', fn: 'callTool', args: [] })).toBeNull();
    expect(asToolCall({ type: 'bevel.navigate', href: 'x' })).toBeNull();
    expect(asToolCall(null)).toBeNull();
  });

  it("names a page by its file name, without the extension", () => {
    expect(pageName('Dashboards/Roadmap.html')).toBe('Roadmap');
    expect(pageName('knowledge-base/Boards/Q4.board.htm')).toBe('Q4.board');
  });
});

describe('uploadFile: the agent upload path, run by the app as the viewer', () => {
  const TOKEN = 'bevel-up_s3cret';
  /** 2 MB of bytes that are not text, the size of the campaign's asset list. */
  const XLSX = new File([new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 31) % 256)], 'Assets.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  interface UploadSent {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
  }

  /**
   * The hosted server, the upload endpoint and its discard, as the app's
   * fetch sees them. `posted` answers the bytes' POST; `applied` answers the
   * apply, given its arguments.
   */
  function uploadServer(
    opts: {
      posted?: () => Response;
      applied?: (args: Record<string, unknown>) => unknown;
    } = {},
  ) {
    const sent: UploadSent[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      sent.push({ url, method, headers: new Headers(init?.headers), body: init?.body });
      if (url === '/api/agent/utcp') return Response.json(MANUAL);
      if (url === '/api/mcp/page-refusals') return new Response(null, { status: 204 });
      if (url.startsWith('/api/agent/uploads')) {
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return opts.posted?.() ?? Response.json({ filename: 'x', bytes: 1, kind: 'file' });
      }
      const rpc = JSON.parse(String(init!.body)) as { id: number; params: { name: string; arguments: { body: Record<string, unknown> } } };
      const { name, arguments: args } = rpc.params;
      const result =
        name === 'request_file_upload'
          ? text({
              uploadUrl: `https://kb.example.com/api/agent/uploads/${TOKEN}`,
              token: TOKEN,
              expiresAt: '2026-10-20T12:00:00.000Z',
              expiresInSeconds: 900,
              maxBytes: 50 * 1024 * 1024,
            })
          : name === 'apply_file_upload'
            ? (opts.applied?.(args.body) ??
              text({
                destination: args.body.destination,
                count: 1,
                total: 1,
                files: [{ path: `knowledge-base/${String(args.body.destination)}/Assets.xlsx`, outcome: 'created' }],
              }))
            : text({ ran: name });
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    });
    /** Each request in order: the MCP tool it called, or the method and address. */
    const steps = () =>
      sent
        .filter((s) => s.url !== '/api/agent/utcp')
        .map((s) =>
          s.url === '/api/mcp'
            ? (JSON.parse(String(s.body)) as { params: { name: string } }).params.name
            : `${s.method} ${s.url}`,
        );
    const argsOf = (tool: string) =>
      sent
        .filter((s) => s.url === '/api/mcp')
        .map((s) => JSON.parse(String(s.body)) as { params: { name: string; arguments: { body: unknown } } })
        .find((r) => r.params.name === tool)?.params.arguments.body;
    return { sent, fetchImpl, steps, argsOf };
  }

  const sha256 = async (blob: Blob) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  it('requests a token, POSTs the bytes with the token in a header, then applies — and resolves with the apply', async () => {
    const server = uploadServer();
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    const answer = await client.uploadFile(XLSX, { branch: 'main', destination: 'Data/Campaigns/Easter' });

    expect(answer).toEqual({
      destination: 'Data/Campaigns/Easter',
      count: 1,
      total: 1,
      files: [{ path: 'knowledge-base/Data/Campaigns/Easter/Assets.xlsx', outcome: 'created' }],
    });
    expect(server.steps()).toEqual([
      'request_file_upload',
      'POST /api/agent/uploads?filename=Assets.xlsx',
      'apply_file_upload',
    ]);
    // Both tool calls go out as the page, so the Audit log names it as the agent.
    for (const s of server.sent.filter((x) => x.url === '/api/mcp')) {
      expect(decodeURIComponent(s.headers.get('X-Bevel-Page')!)).toBe(PAGE);
    }
    // The token in the header, never in the address; the body is the file itself, byte for byte.
    const post = server.sent.find((s) => s.method === 'POST' && s.url.startsWith('/api/agent/uploads'))!;
    expect(post.url).not.toContain(TOKEN);
    expect(post.headers.get('x-upload-token')).toBe(TOKEN);
    expect(post.body).toBeInstanceOf(Blob);
    expect(await sha256(post.body as Blob)).toBe(await sha256(XLSX));
    expect((post.body as Blob).size).toBe(2 * 1024 * 1024);
    // The apply names the token, the branch and the folder; `mode` is left to the tool's default, `create`.
    expect(server.argsOf('apply_file_upload')).toEqual({ branch: 'main', token: TOKEN, destination: 'Data/Campaigns/Easter' });
  });

  it('names a Blob by its `name` option, and lets that option rename a File', async () => {
    const server = uploadServer();
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    await client.uploadFile(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), { name: 'Budget.csv', branch: 'main', destination: 'Data' });
    await client.uploadFile(new File(['zip'], 'export.zip'), { name: 'Campaign assets.zip', branch: 'main', destination: 'Data' });
    expect(server.steps().filter((s) => s.startsWith('POST'))).toEqual([
      'POST /api/agent/uploads?filename=Budget.csv',
      'POST /api/agent/uploads?filename=Campaign%20assets.zip',
    ]);
  });

  it('refuses a call it cannot make before asking the server for anything', async () => {
    const server = uploadServer();
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    await expect(client.uploadFile('not a file', { branch: 'main', destination: 'Data' })).rejects.toThrow('needs a File');
    await expect(client.uploadFile(new Blob(['x']), { branch: 'main', destination: 'Data' })).rejects.toThrow('needs a file name');
    await expect(client.uploadFile(XLSX, { destination: 'Data' })).rejects.toThrow('needs `branch`');
    await expect(client.uploadFile(XLSX, { branch: 'main' })).rejects.toThrow('needs `destination`');
    expect(server.sent).toEqual([]);
  });

  it('passes `mode` through to the apply', async () => {
    for (const mode of ['create', 'overwrite', 'update']) {
      const server = uploadServer();
      await new PageToolsClient(PAGE, server.fetchImpl).uploadFile(XLSX, { branch: 'main', destination: 'Data', mode });
      expect(server.argsOf('apply_file_upload')).toMatchObject({ mode });
    }
  });

  it("rejects with the path's own refusal and code when nothing landed — `exists` under create", async () => {
    const message = '"knowledge-base/Data/Assets.xlsx" already exists. Pass `mode: overwrite` to replace it.';
    const server = uploadServer({
      applied: () =>
        text({
          destination: 'Data',
          count: 0,
          total: 1,
          files: [{ path: 'knowledge-base/Data/Assets.xlsx', outcome: 'refused', error: 'exists', message }],
        }),
    });
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    const err = await client.uploadFile(XLSX, { branch: 'main', destination: 'Data' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message, code: 'exists' });
    // The apply answered, so it spent the token itself: there is nothing to discard.
    expect(server.steps()).toEqual(['request_file_upload', 'POST /api/agent/uploads?filename=Assets.xlsx', 'apply_file_upload']);
  });

  it("rejects an upload over the limit with the server's message, applies nothing, and discards the token", async () => {
    const limit = "That upload is 2097152 bytes, over this deployment's 1048576 byte upload limit. Send a smaller file, or split it across several uploads.";
    const server = uploadServer({ posted: () => Response.json({ error: limit }, { status: 413 }) });
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    await expect(client.uploadFile(XLSX, { branch: 'main', destination: 'Data' })).rejects.toThrow(limit);
    expect(server.steps()).toEqual([
      'request_file_upload',
      'POST /api/agent/uploads?filename=Assets.xlsx',
      'DELETE /api/agent/uploads',
    ]);
    const discard = server.sent.at(-1)!;
    expect(discard.headers.get('x-upload-token')).toBe(TOKEN);
  });

  it("rejects a destination the viewer may not write with the tool's refusal, and discards the staged bytes", async () => {
    const refusal = 'You don\'t have write access to "knowledge-base/Finance". Propose it through a change request.';
    const server = uploadServer({ applied: () => ({ isError: true, content: [{ type: 'text', text: refusal }] }) });
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    await expect(client.uploadFile(XLSX, { branch: 'main', destination: 'Finance' })).rejects.toThrow(refusal);
    expect(server.steps()).toEqual([
      'request_file_upload',
      'POST /api/agent/uploads?filename=Assets.xlsx',
      'apply_file_upload',
      'DELETE /api/agent/uploads',
    ]);
    expect(server.sent.at(-1)!.url).not.toContain(TOKEN);
    expect(server.sent.at(-1)!.headers.get('x-upload-token')).toBe(TOKEN);
  });

  it('counts as writing', async () => {
    const client = new PageToolsClient(PAGE, uploadServer().fetchImpl);
    expect(await client.mayWrite('uploadFile', [XLSX, {}])).toBe(true);
  });

  it('asks on the first upload; Allow runs it, a later upload and write run without asking, and the token never reaches the page', async () => {
    const server = uploadServer();
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    let answer: (ok: boolean) => void = () => {};
    const ask = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const consent = new PageConsent(ask);

    const first = answerToolCall(call('uploadFile', XLSX, { branch: 'main', destination: 'Data/Campaigns/Easter' }), client, consent);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(server.steps()).toEqual([]);
    answer(true);
    const reply = await first;
    expect(reply).toMatchObject({ ok: true, result: { count: 1, destination: 'Data/Campaigns/Easter' } });
    expect(JSON.stringify(reply)).not.toContain(TOKEN);

    expect(await answerToolCall(call('uploadFile', XLSX, { branch: 'main', destination: 'Data' }), client, consent)).toMatchObject({ ok: true });
    expect(await answerToolCall(call('callTool', 'edit_file', {}), client, consent)).toMatchObject({ ok: true });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('Deny answers `denied`, uploads nothing, and records a refused apply_file_upload under the page', async () => {
    const server = uploadServer();
    const client = new PageToolsClient(PAGE, server.fetchImpl);
    const consent = new PageConsent(() => Promise.resolve(false));
    const reply = await answerToolCall(
      call('uploadFile', XLSX, { branch: 'main', destination: 'Data/Campaigns/Easter', mode: 'overwrite' }),
      client,
      consent,
    );
    expect(reply).toMatchObject({ ok: false, error: DENIED, code: DENIED });
    await vi.waitFor(() => expect(server.steps()).toEqual(['POST /api/mcp/page-refusals']));
    expect(JSON.parse(String(server.sent.at(-1)!.body))).toEqual({
      page: PAGE,
      tool: 'apply_file_upload',
      args: { body: { branch: 'main', destination: 'Data/Campaigns/Easter', mode: 'overwrite', name: 'Assets.xlsx' } },
    });
  });
});
