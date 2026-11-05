import { vi } from 'vitest';

/** Everything the app posted to a frame window, shared by every channel taken on it. */
const postedTo = new WeakMap<Window, Array<Record<string, unknown>>>();

/**
 * The two ends of the page tool bridge a test drives, shared by the app's
 * renderer suite and the controller's own: the frame (what its runtime posts,
 * what the app posts back) and the server (the hosted MCP endpoint and the
 * manual, as the app's fetch sees them).
 */

/**
 * Post `data` as the frame's CURRENT document would — stamped with the
 * identity the app built into it (`documentId="…"` in the srcdoc), as the
 * runtime stamps every message — and collect what the app posts back. A
 * channel taken before a view change keeps the old document's identity, so
 * it posts as that document would.
 */
export function frameChannel(iframe: HTMLIFrameElement) {
  const win = iframe.contentWindow!;
  const documentId = /documentId\s*=\s*"([^"]+)"/.exec(iframe.getAttribute('srcdoc') ?? '')?.[1];
  // One collector per window, however many channels are taken on it: a
  // channel's `replies` are what the app posted to the window since the
  // channel was taken, so a reply meant for a replaced document shows up on
  // the old channel AND the new one, and neither assertion is vacuous.
  let posted = postedTo.get(win);
  if (!posted) {
    posted = [];
    postedTo.set(win, posted);
    const all = posted;
    vi.spyOn(win, 'postMessage').mockImplementation(((msg: Record<string, unknown>) => void all.push(msg)) as never);
  }
  const since = posted.length;
  const all = posted;
  return {
    get replies(): Array<Record<string, unknown>> {
      return all.slice(since);
    },
    documentId,
    post: (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: documentId && data && typeof data === 'object' ? { documentId, ...(data as object) } : data,
          source: win,
        }),
      ),
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
