import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenPageInPlatformContext, PageToolsContext, RendererSurfaceContext, getFileRenderer, type RendererSurface } from '..';
import { GitContext, type GitContextValue } from '../../../../git';
import { clearToken, setToken } from '../../../../../lib/api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../state/workspace.context';
import { frameChannel, stubServer } from './pageToolsHarness';

/**
 * `window.bevel.tools` as the app gives it: present where a host provides the
 * bridge (the file page, the skill page), `null` everywhere else, and the two cards — consent to write, and the way to the
 * platform — drawn by the app around the frame, driven here by the very
 * messages the frame's runtime posts.
 */

const HtmlRenderer = getFileRenderer('Dashboards/Roadmap.html');
const PATH = 'knowledge-base/Dashboards/Roadmap.html';
const PAGE = 'Dashboards/Roadmap.html';

const workspace = { workspaceId: 'main', kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue;
const git = { status: { branch: 'main' } } as unknown as GitContextValue;

/**
 * The page on the app's file page: in the app, with the file page's provider.
 * `receive` is the file's content changing under the open page (a teammate's
 * save arriving): the same frame, a new document in it.
 */
function onFilePage({ readOnly = true }: { readOnly?: boolean } = {}) {
  const tree = (content: string) => (
    <MemoryRouter initialEntries={['/workspace/main/knowledge-base/Dashboards/Roadmap.html']}>
      <WorkspaceContext.Provider value={workspace}>
        <GitContext.Provider value={git}>
          <PageToolsContext.Provider value={{ pagePath: PAGE }}>
            <HtmlRenderer content={content} filePath={PATH} onSave={async () => undefined} readOnly={readOnly} />
          </PageToolsContext.Provider>
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>
  );
  const result = render(tree('<h1>Roadmap</h1>'));
  return { ...result, receive: (content: string) => result.rerender(tree(content)) };
}

/** The page in the app on a host without the bridge — a history or change-request preview. */
function inAppElsewhere() {
  return render(
    <MemoryRouter initialEntries={['/workspace/main']}>
      <WorkspaceContext.Provider value={workspace}>
        <GitContext.Provider value={git}>
          <HtmlRenderer content="<h1>Roadmap</h1>" filePath={PATH} onSave={async () => undefined} readOnly />
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

/** The page on the embed — a surface, even with a page-tools provider somewhere above. */
function onEmbed(openFilePage: (path: string) => void, openWorkspacePath: (path: string) => void = () => undefined) {
  const surface: RendererSurface = {
    kbDirName: 'knowledge-base',
    openLink: () => undefined,
    openWorkspacePath,
    openFilePage,
    openNodeId: () => undefined,
    canonicalUrlFor: () => null,
    rawUrl: (path) => `/raw/${path}`,
    rawFetch: async () => new Response(''),
    offersDownload: false,
  };
  return render(
    <MemoryRouter>
      <PageToolsContext.Provider value={{ pagePath: PAGE }}>
        <RendererSurfaceContext.Provider value={surface}>
          <HtmlRenderer content="<h1>Roadmap</h1>" filePath={PATH} onSave={async () => undefined} readOnly />
        </RendererSurfaceContext.Provider>
      </PageToolsContext.Provider>
    </MemoryRouter>,
  );
}

async function frameOf(container: HTMLElement): Promise<HTMLIFrameElement> {
  return waitFor(() => {
    const el = container.querySelector('iframe');
    if (!el) throw new Error('no frame yet');
    return el;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('window.bevel.tools on the file page and elsewhere', () => {
  it('gives the page the five functions on the file page', async () => {
    const { container } = onFilePage();
    const srcdoc = (await frameOf(container)).getAttribute('srcdoc')!;
    expect(srcdoc).toContain('globalThis.bevel.tools = Object.freeze({');
    for (const fn of ['searchTools', 'toolsInfo', 'callTool', 'callToolChain', 'uploadFile']) expect(srcdoc).toContain(`${fn}: function`);
  });

  it('gives it null on the embed and on any other preview in the app', async () => {
    const embed = onEmbed(() => undefined);
    expect((await frameOf(embed.container)).getAttribute('srcdoc')).toContain('globalThis.bevel.tools = null;');
    cleanup();
    const elsewhere = inAppElsewhere();
    expect((await frameOf(elsewhere.container)).getAttribute('srcdoc')).toContain('globalThis.bevel.tools = null;');
  });
});

describe('the consent card on the file page', () => {
  it('runs a read with no card', async () => {
    const server = stubServer();
    const { container } = onFilePage();
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tool.call', requestId: 'r1', fn: 'callTool', args: ['read_file', {}] });
    await waitFor(() => expect(frame.replies).toEqual([{ type: 'bevel.tool.response', requestId: 'r1', ok: true, result: { ran: 'read_file' } }]));
    expect(server.mcp).toEqual(['read_file']);
    expect(screen.queryByText(/wants to write to the knowledge base/)).toBeNull();
  });

  it('asks on the first write with the page\'s name and path; Allow runs it and holds for the view', async () => {
    const server = stubServer();
    const { container } = onFilePage();
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tool.call', requestId: 'w1', fn: 'callTool', args: ['edit_file', {}] });
    expect(await screen.findByText('Roadmap wants to write to the knowledge base')).toBeTruthy();
    expect(screen.getByText(PAGE)).toBeTruthy();
    expect(server.mcp).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Allow while open' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w1', ok: true, result: { ran: 'edit_file' } }));

    frame.post({ type: 'bevel.tool.call', requestId: 'w2', fn: 'callToolChain', args: ['return 1'] });
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w2', ok: true }));
    expect(screen.queryByText(/wants to write to the knowledge base/)).toBeNull();
    expect(server.mcp).toEqual(['edit_file', 'call_tool_chain']);
  });

  it('Deny answers denied and runs nothing; the next write asks again; a reload asks again after an Allow', async () => {
    const server = stubServer();
    const { container } = onFilePage();
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tool.call', requestId: 'w1', fn: 'callTool', args: ['edit_file', {}] });
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(frame.replies.at(-1)).toEqual({ type: 'bevel.tool.response', requestId: 'w1', ok: false, error: 'denied', code: 'denied' }));
    expect(server.mcp).toEqual([]);

    frame.post({ type: 'bevel.tool.call', requestId: 'w2', fn: 'callTool', args: ['edit_file', {}] });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow while open' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w2', ok: true }));

    // Reload the page: a new view, a new frame window, and the card again.
    fireEvent.click(screen.getByTitle('Reload preview'));
    const reloaded = frameChannel(await waitFor(() => {
      const el = container.querySelector('iframe')!;
      if (el.contentWindow === null) throw new Error('not yet');
      return el;
    }));
    reloaded.post({ type: 'bevel.tool.call', requestId: 'w3', fn: 'callTool', args: ['edit_file', {}] });
    expect(await screen.findByText('Roadmap wants to write to the knowledge base')).toBeTruthy();
  });

  it('asks again after Edit and back to Preview, though the document is the same', async () => {
    stubServer();
    const { container } = onFilePage({ readOnly: false });
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tool.call', requestId: 'w1', fn: 'callTool', args: ['edit_file', {}] });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow while open' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w1', ok: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(container.querySelector('iframe')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const back = frameChannel(await frameOf(container));
    back.post({ type: 'bevel.tool.call', requestId: 'w2', fn: 'callTool', args: ['edit_file', {}] });
    expect(await screen.findByText('Roadmap wants to write to the knowledge base')).toBeTruthy();
  });

  it('answers requireTools true with nothing shown', async () => {
    const { container } = onFilePage();
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tools.require', requestId: 'q1' });
    await waitFor(() => expect(frame.replies).toEqual([{ type: 'bevel.tools.require.response', requestId: 'q1', ok: true, result: true }]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('an upload from the file page', () => {
  const TOKEN = 'bevel-up_s3cret';

  /** The hosted server and the upload endpoint, as the app's fetch sees them: every request, with its headers. */
  function stubUploadServer() {
    const requests: Array<{ step: string; headers: Headers; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (url === '/api/agent/utcp') return Response.json({ tools: [] });
        if (url === '/api/mcp/page-refusals') {
          requests.push({ step: 'refusal', headers, body: JSON.parse(String(init!.body)) });
          return new Response(null, { status: 204 });
        }
        if (url.startsWith('/api/agent/uploads')) {
          requests.push({ step: `${init?.method} ${url}`, headers, body: init?.body });
          return Response.json({ filename: 'Assets.xlsx', bytes: 4, kind: 'file' });
        }
        const rpc = JSON.parse(String(init!.body)) as { id: number; params: { name: string; arguments: { body: Record<string, unknown> } } };
        requests.push({ step: rpc.params.name, headers, body: rpc.params.arguments });
        const answer =
          rpc.params.name === 'request_file_upload'
            ? { uploadUrl: `https://kb.example.com/api/agent/uploads/${TOKEN}`, token: TOKEN, maxBytes: 1024 }
            : { destination: 'Data/Campaigns/Easter', count: 1, total: 1, files: [{ path: 'knowledge-base/Data/Campaigns/Easter/Assets.xlsx', outcome: 'created' }] };
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } });
      }),
    );
    return { requests };
  }

  const file = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'Assets.xlsx');

  it('asks with the write card, and on Allow runs the three steps in order with the viewer\'s session', async () => {
    setToken('viewer-session');
    try {
      const server = stubUploadServer();
      const { container } = onFilePage();
      const frame = frameChannel(await frameOf(container));
      frame.post({ type: 'bevel.tool.call', requestId: 'u1', fn: 'uploadFile', args: [file(), { branch: 'main', destination: 'Data/Campaigns/Easter' }] });
      expect(await screen.findByText('Roadmap wants to write to the knowledge base')).toBeTruthy();
      expect(server.requests).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: 'Allow while open' }));
      await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'u1', ok: true, result: { count: 1, destination: 'Data/Campaigns/Easter' } }));
      expect(server.requests.map((r) => r.step)).toEqual([
        'request_file_upload',
        'POST /api/agent/uploads?filename=Assets.xlsx',
        'apply_file_upload',
      ]);
      for (const r of server.requests) expect(r.headers.get('Authorization')).toBe('Bearer viewer-session');
      for (const r of server.requests.filter((x) => x.step.endsWith('_upload'))) {
        expect(decodeURIComponent(r.headers.get('X-Bevel-Page')!)).toBe(PAGE);
      }
      expect(server.requests[1]!.headers.get('x-upload-token')).toBe(TOKEN);
      // The token went to the server and nowhere else: not into an address, not back to the frame.
      expect(server.requests[1]!.step).not.toContain(TOKEN);
      expect(JSON.stringify(frame.replies)).not.toContain(TOKEN);

      // Allow holds for the view: the next upload runs with no card.
      frame.post({ type: 'bevel.tool.call', requestId: 'u2', fn: 'uploadFile', args: [file(), { branch: 'main', destination: 'Data' }] });
      await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'u2', ok: true }));
      expect(screen.queryByText(/wants to write to the knowledge base/)).toBeNull();
    } finally {
      clearToken();
    }
  });

  it('Deny answers denied, uploads nothing, and reports a refused apply_file_upload under the page', async () => {
    const server = stubUploadServer();
    const { container } = onFilePage();
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tool.call', requestId: 'u1', fn: 'uploadFile', args: [file(), { branch: 'main', destination: 'Data/Campaigns/Easter' }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(frame.replies.at(-1)).toEqual({ type: 'bevel.tool.response', requestId: 'u1', ok: false, error: 'denied', code: 'denied' }));
    await waitFor(() => expect(server.requests.map((r) => r.step)).toEqual(['refusal']));
    expect(server.requests[0]!.body).toMatchObject({ page: PAGE, tool: 'apply_file_upload' });
  });
});

describe('the platform card where there are no tools', () => {
  it('on the embed offers Continue without tools (false) and Open in the platform (opens the page, false)', async () => {
    const openFilePage = vi.fn();
    const openWorkspacePath = vi.fn();
    const { container } = onEmbed(openFilePage, openWorkspacePath);
    const frame = frameChannel(await frameOf(container));

    frame.post({ type: 'bevel.tools.require', requestId: 'q1' });
    expect(await screen.findByText('Roadmap uses tools that are only available in the platform')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without tools' }));
    await waitFor(() => expect(frame.replies.at(-1)).toEqual({ type: 'bevel.tools.require.response', requestId: 'q1', ok: true, result: false }));
    expect(openFilePage).not.toHaveBeenCalled();

    frame.post({ type: 'bevel.tools.require', requestId: 'q2' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open in the platform' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'q2', result: false }));
    // The FILE PAGE verb, not the plain path: the embed opens a new tab, and
    // a page in a skill's folder would otherwise open as the skill page.
    expect(openFilePage).toHaveBeenCalledWith(PATH);
    expect(openWorkspacePath).not.toHaveBeenCalled();
  });

  it("on a skill page opens the page the host's way, not the skill-relative name", async () => {
    const open = vi.fn();
    const { container } = render(
      <MemoryRouter initialEntries={['/skills-and-tools/skills/roadmap']}>
        <WorkspaceContext.Provider value={workspace}>
          <GitContext.Provider value={git}>
            <OpenPageInPlatformContext.Provider value={open}>
              <HtmlRenderer content="<h1>Roadmap</h1>" filePath="view.html" onSave={async () => undefined} readOnly />
            </OpenPageInPlatformContext.Provider>
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tools.require', requestId: 'q1' });
    expect(await screen.findByText('view uses tools that are only available in the platform')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open in the platform' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'q1', result: false }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('refuses a tool call outright where there are no tools', async () => {
    const { container } = onEmbed(() => undefined);
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tool.call', requestId: 'r1', fn: 'callTool', args: ['read_file', {}] });
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'r1', ok: false, code: 'unavailable' }));
  });

  it('ignores messages that do not come from its own frame', async () => {
    const { container } = onEmbed(() => undefined);
    await frameOf(container);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'bevel.tools.require', requestId: 'x' }, source: window }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(/only available in the platform/)).toBeNull();
  });
});

describe('a call whose view ended before it was decided', () => {
  // A rebuilt document is a new frame window here, so what the old view's
  // call is answered reaches nobody — `closed` itself is pinned through the
  // controller's own suite, whose frame keeps its window. What this renderer
  // must show is the rest: no card in the new view, and nothing run.
  const settled = () => new Promise((r) => setTimeout(r, 50));

  it('shows no card and runs nothing when the document changes under it while the lookup is in flight', async () => {
    const server = stubServer({ holdManual: true });
    const page = onFilePage();
    const iframe = await frameOf(page.container);
    const frame = frameChannel(iframe);
    frame.post({ type: 'bevel.tool.call', requestId: 'w1', fn: 'callTool', args: ['edit_file', {}] });

    // The lookup of whether edit_file writes is still in flight when the page's document is replaced.
    page.receive('<h1>Roadmap, v2</h1>');
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain('Roadmap, v2'));
    const changed = frameChannel(iframe);
    server.releaseManual();
    await settled();

    expect(screen.queryByText(/wants to write to the knowledge base/)).toBeNull();
    expect(server.mcp).toEqual([]);
    expect(changed.replies).toEqual([]);
  });

  it('does not run on an Allow the ended view gave', async () => {
    const server = stubServer({ holdManual: true });
    const page = onFilePage();
    const iframe = await frameOf(page.container);
    const frame = frameChannel(iframe);
    // A chain asks without the manual: Allow it, so the view holds an Allow.
    frame.post({ type: 'bevel.tool.call', requestId: 'w1', fn: 'callToolChain', args: ['return 1'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow while open' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w1', ok: true }));

    frame.post({ type: 'bevel.tool.call', requestId: 'w2', fn: 'callTool', args: ['edit_file', {}] });
    page.receive('<h1>Roadmap, v2</h1>');
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain('Roadmap, v2'));
    server.releaseManual();
    await settled();

    expect(server.mcp).toEqual(['call_tool_chain']);
  });

  it('opens no card in the reloaded view and sends the server nothing when the viewer reloads first', async () => {
    const server = stubServer({ holdManual: true });
    const { container } = onFilePage();
    const frame = frameChannel(await frameOf(container));
    frame.post({ type: 'bevel.tool.call', requestId: 'w1', fn: 'callTool', args: ['edit_file', {}] });

    fireEvent.click(screen.getByTitle('Reload preview'));
    const reloaded = frameChannel(await waitFor(() => {
      const el = container.querySelector('iframe')!;
      if (el.contentWindow === null) throw new Error('not yet');
      return el;
    }));
    server.releaseManual();
    await settled();

    expect(screen.queryByText(/wants to write to the knowledge base/)).toBeNull();
    expect(server.mcp).toEqual([]);
    // Neither document hears an answer meant for a view that is gone.
    expect(frame.replies).toEqual([]);
    expect(reloaded.replies).toEqual([]);
  });
});
