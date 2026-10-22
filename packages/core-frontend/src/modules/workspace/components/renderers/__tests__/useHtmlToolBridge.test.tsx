import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  OpenPageInPlatformContext,
  PageToolsContext,
  RendererSurfaceContext,
  useHtmlToolBridge,
  type RendererSurface,
} from '..';
import { GitContext, type GitContextValue } from '../../../../git';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../state/workspace.context';
import { frameChannel, stubServer } from './pageToolsHarness';

/**
 * The bridge controller's contract, through a renderer that is not the app's:
 * a component that owns its frame, calls `useHtmlToolBridge` with the frame,
 * its file and its view key, and renders the cards it hands back — exactly
 * what a distribution's own HTML renderer does. Everything comes from the
 * renderers module's entry. The frame stays the same element across a view
 * change here, so what an ended view's calls are answered is visible.
 */

const PATH = 'knowledge-base/Dashboards/Roadmap.html';
const PAGE = 'Dashboards/Roadmap.html';

const workspace = { workspaceId: 'main', kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue;
const git = { status: { branch: 'main' } } as unknown as GitContextValue;

/** A downstream renderer: its own frame and document, the controller's bridge. */
function OtherHtmlRenderer({ viewKey }: { viewKey: number }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { toolBridge, cards } = useHtmlToolBridge({ iframeRef, filePath: PATH, viewKey });
  return (
    <>
      <iframe ref={iframeRef} title="page" sandbox="allow-scripts" srcDoc={toolBridge ? 'with tools' : 'without tools'} />
      {cards}
    </>
  );
}

type Where = 'file page' | 'elsewhere' | 'embed';

function mount(where: Where, opts: { openFilePage?: (path: string) => void; openInPlatform?: () => void } = {}) {
  const surface: RendererSurface = {
    kbDirName: 'knowledge-base',
    openLink: () => undefined,
    openWorkspacePath: () => undefined,
    openFilePage: opts.openFilePage ?? (() => undefined),
    openNodeId: () => undefined,
    canonicalUrlFor: () => null,
    rawUrl: (path) => `/raw/${path}`,
    rawFetch: async () => new Response(''),
    offersDownload: false,
  };
  const tree = (viewKey: number) => {
    const renderer = opts.openInPlatform ? (
      <OpenPageInPlatformContext.Provider value={opts.openInPlatform}>
        <OtherHtmlRenderer viewKey={viewKey} />
      </OpenPageInPlatformContext.Provider>
    ) : (
      <OtherHtmlRenderer viewKey={viewKey} />
    );
    // A page-tools provider on the embed too: a surface never gets tools, whatever is above it.
    const placed =
      where === 'embed' ? (
        <PageToolsContext.Provider value={{ pagePath: PAGE }}>
          <RendererSurfaceContext.Provider value={surface}>{renderer}</RendererSurfaceContext.Provider>
        </PageToolsContext.Provider>
      ) : where === 'file page' ? (
        <PageToolsContext.Provider value={{ pagePath: PAGE }}>{renderer}</PageToolsContext.Provider>
      ) : (
        renderer
      );
    return (
      <MemoryRouter>
        <WorkspaceContext.Provider value={workspace}>
          <GitContext.Provider value={git}>{placed}</GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>
    );
  };
  let viewKey = 0;
  const result = render(tree(viewKey));
  const iframe = result.container.querySelector('iframe')!;
  return {
    iframe,
    frame: frameChannel(iframe),
    /** The renderer's view ends (a reload, a rebuilt document) while its frame stays. */
    nextView: () => {
      viewKey += 1;
      result.rerender(tree(viewKey));
    },
  };
}

const write = (requestId: string) => ({ type: 'bevel.tool.call', requestId, fn: 'callTool', args: ['edit_file', {}] });
const CARD = 'Roadmap wants to write to the knowledge base';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useHtmlToolBridge through a renderer of its own', () => {
  it('builds the frame with tools on the file page only', () => {
    expect(mount('file page').iframe.getAttribute('srcdoc')).toBe('with tools');
    cleanup();
    expect(mount('elsewhere').iframe.getAttribute('srcdoc')).toBe('without tools');
    cleanup();
    expect(mount('embed').iframe.getAttribute('srcdoc')).toBe('without tools');
  });

  it('runs a read with no card', async () => {
    const server = stubServer();
    const { frame } = mount('file page');
    frame.post({ type: 'bevel.tool.call', requestId: 'r1', fn: 'callTool', args: ['read_file', {}] });
    await waitFor(() => expect(frame.replies).toEqual([{ type: 'bevel.tool.response', requestId: 'r1', ok: true, result: { ran: 'read_file' } }]));
    expect(screen.queryByText(CARD)).toBeNull();
    expect(server.mcp).toEqual(['read_file']);
  });

  it('asks once for ten writes at once; Allow answers all ten and holds for the view; a new view asks again', async () => {
    const server = stubServer();
    const { frame, nextView } = mount('file page');
    for (let i = 0; i < 10; i += 1) frame.post(write(`w${i}`));
    expect(await screen.findByText(CARD)).toBeTruthy();
    expect(screen.getByText(PAGE)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Allow while open' })).toHaveLength(1);
    expect(server.mcp).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Allow while open' }));
    await waitFor(() => expect(frame.replies).toHaveLength(10));
    expect(frame.replies.every((r) => r.ok === true)).toBe(true);

    frame.post(write('w10'));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w10', ok: true }));
    expect(screen.queryByText(CARD)).toBeNull();

    nextView();
    frame.post(write('w11'));
    expect(await screen.findByText(CARD)).toBeTruthy();
  });

  it('Deny answers denied and runs nothing; the next write asks again', async () => {
    const server = stubServer();
    const { frame } = mount('file page');
    frame.post(write('w1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(frame.replies.at(-1)).toEqual({ type: 'bevel.tool.response', requestId: 'w1', ok: false, error: 'denied', code: 'denied' }));
    expect(server.mcp).toEqual([]);
    frame.post(write('w2'));
    expect(await screen.findByText(CARD)).toBeTruthy();
  });

  // The frame keeps its window across `nextView` here, as a browser's does
  // when a document is rebuilt in the same frame element. So these cases
  // show the whole of what an ended view's calls get: no card, nothing run,
  // and no reply posted into the next view — the window alone would let one
  // through. (`closed` is what `answerToolCall` decides; nobody is left to
  // hear it.)
  const settled = () => new Promise((r) => setTimeout(r, 50));

  it('closes an open card when the view ends: nothing runs, and the next view hears nothing of it', async () => {
    const server = stubServer();
    const { frame, nextView } = mount('file page');
    frame.post(write('w1'));
    expect(await screen.findByText(CARD)).toBeTruthy();
    nextView();
    await waitFor(() => expect(screen.queryByText(CARD)).toBeNull());
    await settled();
    expect(frame.replies).toEqual([]);
    expect(server.mcp).toEqual([]);
  });

  it('a call decided after its view ended shows no card, runs nothing, and is not answered into the next view', async () => {
    const server = stubServer({ holdManual: true });
    const { frame, nextView } = mount('file page');
    frame.post(write('w1'));
    frame.post({ type: 'bevel.tool.call', requestId: 'r1', fn: 'callTool', args: ['read_file', {}] });
    nextView();
    server.releaseManual();
    await settled();
    expect(frame.replies).toEqual([]);
    expect(screen.queryByText(CARD)).toBeNull();
    expect(server.mcp).toEqual([]);
  });

  it('runs nothing for calls still being decided when the view ends, even after its Allow, and answers none of them', async () => {
    const server = stubServer();
    const { frame, nextView } = mount('file page');
    frame.post({ type: 'bevel.tool.call', requestId: 'c1', fn: 'callToolChain', args: ['return 1'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow while open' }));
    await waitFor(() => expect(frame.replies).toEqual([expect.objectContaining({ requestId: 'c1', ok: true })]));

    frame.post(write('w1'));
    frame.post({ type: 'bevel.tool.call', requestId: 'r1', fn: 'callTool', args: ['read_file', {}] });
    frame.post({ type: 'bevel.tool.call', requestId: 'c2', fn: 'callToolChain', args: ['return 2'] });
    nextView();
    await settled();
    expect(frame.replies).toHaveLength(1);
    expect(screen.queryByText(CARD)).toBeNull();
    expect(server.mcp).toEqual(['call_tool_chain']);
  });

  it('answers the new view\'s own calls after an older view\'s are dropped', async () => {
    const server = stubServer();
    const { frame, nextView } = mount('file page');
    frame.post(write('w1'));
    expect(await screen.findByText(CARD)).toBeTruthy();
    nextView();
    await waitFor(() => expect(screen.queryByText(CARD)).toBeNull());
    frame.post({ type: 'bevel.tool.call', requestId: 'r2', fn: 'callTool', args: ['read_file', {}] });
    await waitFor(() => expect(frame.replies).toEqual([{ type: 'bevel.tool.response', requestId: 'r2', ok: true, result: { ran: 'read_file' } }]));
    expect(server.mcp).toEqual(['read_file']);
  });

  it('answers requireTools true on the file page with nothing shown', async () => {
    const { frame } = mount('file page');
    frame.post({ type: 'bevel.tools.require', requestId: 'q1' });
    await waitFor(() => expect(frame.replies).toEqual([{ type: 'bevel.tools.require.response', requestId: 'q1', ok: true, result: true }]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the platform card elsewhere: Continue without tools, and Open in the platform the host\'s way or the file page', async () => {
    const openFilePage = vi.fn();
    const { frame } = mount('embed', { openFilePage });
    frame.post({ type: 'bevel.tools.require', requestId: 'q1' });
    expect(await screen.findByText('Roadmap uses tools that are only available in the platform')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without tools' }));
    await waitFor(() => expect(frame.replies.at(-1)).toEqual({ type: 'bevel.tools.require.response', requestId: 'q1', ok: true, result: false }));
    frame.post({ type: 'bevel.tools.require', requestId: 'q2' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open in the platform' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'q2', result: false }));
    expect(openFilePage).toHaveBeenCalledWith(PATH);
    cleanup();

    const openInPlatform = vi.fn();
    const elsewhere = mount('elsewhere', { openInPlatform });
    elsewhere.frame.post({ type: 'bevel.tools.require', requestId: 'q3' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open in the platform' }));
    await waitFor(() => expect(elsewhere.frame.replies.at(-1)).toMatchObject({ requestId: 'q3', result: false }));
    expect(openInPlatform).toHaveBeenCalledTimes(1);
  });

  it('refuses a tool call outright where there are no tools', async () => {
    const { frame } = mount('embed');
    frame.post({ type: 'bevel.tool.call', requestId: 'r1', fn: 'callTool', args: ['read_file', {}] });
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'r1', ok: false, code: 'unavailable' }));
  });

  it('ignores messages that do not come from its own frame', async () => {
    const server = stubServer();
    const { frame } = mount('file page');
    window.dispatchEvent(new MessageEvent('message', { data: write('x1'), source: window }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'bevel.tools.require', requestId: 'x2' }, source: window }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(frame.replies).toEqual([]);
    expect(server.mcp).toEqual([]);
  });
});
