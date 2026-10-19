import { vi } from 'vitest';

/**
 * The two ends of the page tool bridge a test drives, shared by the app's
 * renderer suite and the controller's own: the frame (what its runtime posts,
 * what the app posts back) and the server (the hosted MCP endpoint and the
 * manual, as the app's fetch sees them).
 */

/** Post `data` as the frame would, and collect what the app posts back to it. */
export function frameChannel(iframe: HTMLIFrameElement) {
  const win = iframe.contentWindow!;
  const replies: Array<Record<string, unknown>> = [];
  vi.spyOn(win, 'postMessage').mockImplementation(((msg: Record<string, unknown>) => void replies.push(msg)) as never);
  return {
    replies,
    post: (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, source: win })),
  };
}

/**
 * The hosted server and the manual: `read_file` reads, `edit_file` writes.
 * `mcp` records every tool the server was asked to run. With `holdManual`,
 * the manual is not answered until `releaseManual()` — a lookup still in
 * flight.
 */
export function stubServer({ holdManual = false }: { holdManual?: boolean } = {}) {
  const mcp: string[] = [];
  let releaseManual: () => void = () => undefined;
  const manualHeld = holdManual ? new Promise<void>((resolve) => (releaseManual = resolve)) : Promise.resolve();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/agent/utcp') {
        await manualHeld;
        return Response.json({ tools: [{ name: 'read_file', tags: [] }, { name: 'edit_file', tags: ['write'] }] });
      }
      if (url === '/api/mcp/page-refusals') return new Response(null, { status: 204 });
      const body = JSON.parse(String(init!.body)) as { id: number; params: { name: string } };
      mcp.push(body.params.name);
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ ran: body.params.name }) }] },
      });
    }),
  );
  return { mcp, releaseManual: () => releaseManual() };
}
