import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RendererSurfaceContext, getFileRenderer, type RendererSurface } from '..';
import { OpenPageInPlatformContext, PageToolsContext } from '../htmlToolBridge';
import { GitContext, type GitContextValue } from '../../../../git/state/git.context';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../state/workspace.context';

/**
 * `window.bevel.tools` as the app gives it: present on the file page, `null`
 * everywhere else, and the two cards — consent to write, and the way to the
 * platform — drawn by the app around the frame, driven here by the very
 * messages the frame's runtime posts.
 */

const HtmlRenderer = getFileRenderer('Dashboards/Roadmap.html');
const PATH = 'knowledge-base/Dashboards/Roadmap.html';
const PAGE = 'Dashboards/Roadmap.html';

const workspace = { workspaceId: 'main', kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue;
const git = { status: { branch: 'main' } } as unknown as GitContextValue;

/** The page on the app's file page: in the app, with the file page's provider. */
function onFilePage({ readOnly = true }: { readOnly?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={['/workspace/main/knowledge-base/Dashboards/Roadmap.html']}>
      <WorkspaceContext.Provider value={workspace}>
        <GitContext.Provider value={git}>
          <PageToolsContext.Provider value={{ pagePath: PAGE }}>
            <HtmlRenderer content="<h1>Roadmap</h1>" filePath={PATH} onSave={async () => undefined} readOnly={readOnly} />
          </PageToolsContext.Provider>
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

/** The page in the app but not on the file page — a skill page, a history preview. */
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

/** Post `data` as the frame would, and collect what the app posts back to it. */
function frameChannel(iframe: HTMLIFrameElement) {
  const win = iframe.contentWindow!;
  const replies: Array<Record<string, unknown>> = [];
  vi.spyOn(win, 'postMessage').mockImplementation(((msg: Record<string, unknown>) => void replies.push(msg)) as never);
  return {
    replies,
    post: (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data, source: win })),
  };
}

/** The hosted server and the manual, as the app's fetch sees them. */
function stubServer() {
  const mcp: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/agent/utcp') return Response.json({ tools: [{ name: 'read_file', tags: [] }, { name: 'edit_file', tags: ['write'] }] });
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
  return { mcp };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('window.bevel.tools on the file page and elsewhere', () => {
  it('gives the page the four functions on the file page', async () => {
    const { container } = onFilePage();
    const srcdoc = (await frameOf(container)).getAttribute('srcdoc')!;
    expect(srcdoc).toContain('globalThis.bevel.tools = Object.freeze({');
    for (const fn of ['searchTools', 'toolsInfo', 'callTool', 'callToolChain']) expect(srcdoc).toContain(`${fn}: function`);
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
