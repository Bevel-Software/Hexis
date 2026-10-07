import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MCP App view the backend serves as `ui://hexis/page.html`, RUN — not
 * grepped. It lives in core-backend's packaged `mcp-app/` folder, and this
 * package is the one with a DOM to run it in.
 *
 * What is pinned is the half of the extension protocol a host holds us to:
 * the handshake's required fields, and the shape of the tool result the
 * host delivers (the params ARE the CallToolResult).
 */
const PAGE = readFileSync(path.resolve(__dirname, '../../../../../core-backend/mcp-app/page.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*)<\/script>/.exec(PAGE)![1];
const BODY = /<body>([\s\S]*?)<script>/.exec(PAGE)![1];

let host: { postMessage: ReturnType<typeof vi.fn> };
const realParent = Object.getOwnPropertyDescriptor(window, 'parent');

beforeEach(() => {
  // The test is about WHAT the view frames, not about loading it.
  const happyDOM = (window as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM;
  if (happyDOM) happyDOM.settings.disableIframePageLoading = true;
  document.body.innerHTML = BODY;
  host = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { configurable: true, value: host });
  // eslint-disable-next-line no-new-func
  new Function(SCRIPT)();
});

afterEach(() => {
  if (realParent) Object.defineProperty(window, 'parent', realParent);
  else delete (window as { parent?: unknown }).parent;
});

function fromHost(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, source: host as never, origin: 'https://host.example' }));
}

describe('the MCP App view', () => {
  it('opens with a ui/initialize carrying the app identity and capabilities a host requires', () => {
    const [message] = host.postMessage.mock.calls[0] as [Record<string, unknown>];
    expect(message).toMatchObject({ jsonrpc: '2.0', method: 'ui/initialize' });
    const params = message.params as Record<string, unknown>;
    expect(params.protocolVersion).toEqual(expect.any(String));
    expect(params.appInfo).toMatchObject({ name: expect.any(String), version: expect.any(String) });
    expect(params.appCapabilities).toEqual(expect.any(Object));
  });

  it('confirms the handshake with ui/notifications/initialized', () => {
    const { id } = host.postMessage.mock.calls[0][0] as { id: string };
    fromHost({ jsonrpc: '2.0', id, result: { protocolVersion: '2026-01-26' } });
    const sent = host.postMessage.mock.calls.map((c) => (c[0] as { method?: string }).method);
    expect(sent).toContain('ui/notifications/initialized');
  });

  it('frames the embed from a tool result delivered as the CallToolResult itself', () => {
    fromHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        content: [{ type: 'text', text: '{}' }],
        structuredContent: { embedUrl: 'https://hexis.example/embed?token=t' },
      },
    });
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src') ?? frame.src).toBe('https://hexis.example/embed?token=t');
    expect(frame.classList.contains('hidden')).toBe(false);
  });

  it('says why there is no view when the result carries no embed address', () => {
    fromHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { note: 'The embedded view needs an https deployment.' } },
    });
    expect(document.getElementById('notice')!.textContent).toContain('needs an https deployment');
    expect(document.getElementById('frame')!.classList.contains('hidden')).toBe(true);
  });
});
