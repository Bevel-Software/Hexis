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

  it('answers `closed` and runs nothing once the view is closed — asked for nothing, Allow or no Allow', async () => {
    const { client, consent, ask, answer, server } = setup();
    const allowed = answerToolCall(call('callToolChain', 'return 1'), client, consent);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(true);
    expect(await allowed).toMatchObject({ ok: true });

    consent.close();
    for (const late of [call('callTool', 'edit_file', {}), call('callTool', 'read_file', {}), call('callToolChain', 'return 2')]) {
      expect(await answerToolCall(late, client, consent)).toMatchObject({ ok: false, code: 'closed' });
    }
    expect(ask).toHaveBeenCalledTimes(1);
    expect(server.mcpCalls()).toEqual(['call_tool_chain']);
  });

  it('answers `closed` when the view closes while its card is still open, whatever the card later says', async () => {
    const { client, consent, ask, answer, server } = setup();
    const pending = answerToolCall(call('callTool', 'edit_file', {}), client, consent);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    consent.close();
    answer(true);
    expect(await pending).toMatchObject({ ok: false, code: 'closed' });
    expect(server.mcpCalls()).toEqual([]);
  });
});

describe('the frame messages the app reads', () => {
  it('accepts only a well-formed call of one of the four functions', () => {
    expect(asToolCall({ type: 'bevel.tool.call', requestId: 'r', fn: 'callTool', args: ['read_file', {}] })).not.toBeNull();
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
