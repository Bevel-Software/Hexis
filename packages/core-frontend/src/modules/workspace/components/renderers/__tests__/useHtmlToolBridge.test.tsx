import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { sha256Hex } from '@bevel-software/platform-shared';
import { ALLOWED_PAGE_KEY_PREFIX } from '../pageConsentMemory';
import { frameChannel, stubServer } from './pageToolsHarness';

/**
 * The bridge controller's contract, through a renderer that is not the app's:
 * a component that owns its frame, calls `useHtmlToolBridge` with the frame,
 * its file and its view key, and renders the cards it hands back — exactly
 * what a distribution's own HTML renderer does. Everything comes from the
 * renderers module's entry. The frame stays the same element across a view
 * change here — the one window a browser keeps when a document is rebuilt in
 * place — so the suite can show that an ended view's calls are answered into
 * nobody: the controller decides them `closed` and never posts the reply.
 */

const PATH = 'knowledge-base/Dashboards/Roadmap.html';
const PAGE = 'Dashboards/Roadmap.html';

const workspace = { workspaceId: 'main', kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue;
const git = { status: { branch: 'main' } } as unknown as GitContextValue;

/** A downstream renderer: its own frame and document, the controller's bridge. */
function OtherHtmlRenderer({ viewKey, path, source }: { viewKey: number; path: string; source: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { toolBridge, cards } = useHtmlToolBridge({ iframeRef, filePath: path, viewKey, source });
  // The document carries the identity the controller minted for it, as the
  // real runtime does (`buildSandboxedHtml` with this `toolBridge`).
  const srcDoc = `${toolBridge.tools ? 'with tools' : 'without tools'} documentId="${toolBridge.documentId}"`;
  return (
    <>
      <iframe ref={iframeRef} title="page" sandbox="allow-scripts" srcDoc={srcDoc} />
      {cards}
    </>
  );
}

type Where = 'file page' | 'elsewhere' | 'embed';

function mount(
  where: Where,
  opts: { openFilePage?: (path: string) => void; openInPlatform?: () => void; path?: string; page?: string; source?: string } = {},
) {
  const path = opts.path ?? PATH;
  const page = opts.page ?? PAGE;
  let source = opts.source ?? SOURCE;
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
    const view = <OtherHtmlRenderer viewKey={viewKey} path={path} source={source} />;
    const renderer = opts.openInPlatform ? (
      <OpenPageInPlatformContext.Provider value={opts.openInPlatform}>{view}</OpenPageInPlatformContext.Provider>
    ) : (
      view
    );
    // A page-tools provider on the embed too: a surface never gets tools, whatever is above it.
    const placed =
      where === 'embed' ? (
        <PageToolsContext.Provider value={{ pagePath: page }}>
          <RendererSurfaceContext.Provider value={surface}>{renderer}</RendererSurfaceContext.Provider>
        </PageToolsContext.Provider>
      ) : where === 'file page' ? (
        <PageToolsContext.Provider value={{ pagePath: page }}>{renderer}</PageToolsContext.Provider>
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
    /**
     * The renderer's view ends (a reload, a rebuilt document) while its
     * frame stays. Answers a channel for the NEW document; the one taken
     * before still posts as the old document. A `nextSource` is the page's
     * source after an edit; without one the new view shows the same source.
     */
    nextView: (nextSource?: string) => {
      viewKey += 1;
      if (nextSource !== undefined) source = nextSource;
      result.rerender(tree(viewKey));
      return frameChannel(iframe);
    },
  };
}

const write = (requestId: string) => ({ type: 'bevel.tool.call', requestId, fn: 'callTool', args: ['edit_file', {}] });
const CARD = "You're allowing changes using your account. Do you want to allow that?";
const SOURCE = '<button onclick="bevel.tools.callTool(\'edit_file\', {})">Edit</button>';

/** The digests stored in localStorage, least recently allowed first: read through the storage API, as another tab would. */
const remembered = (): string[] =>
  Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!)
    .filter((key) => key.startsWith(ALLOWED_PAGE_KEY_PREFIX) && Number.isFinite(Number(window.localStorage.getItem(key))))
    .sort((a, b) => Number(window.localStorage.getItem(a)) - Number(window.localStorage.getItem(b)))
    .map((key) => key.slice(ALLOWED_PAGE_KEY_PREFIX.length));
/** Every raw memory entry in storage, well-formed or not. */
const storedEntries = (): string[] =>
  Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!).filter((key) => key.startsWith(ALLOWED_PAGE_KEY_PREFIX));

beforeEach(() => window.localStorage.clear());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useHtmlToolBridge through a renderer of its own', () => {
  it('builds the frame with tools on the file page only, each view\'s document with its own identity', () => {
    const page = mount('file page');
    expect(page.iframe.getAttribute('srcdoc')).toMatch(/^with tools documentId="doc-/);
    const first = page.frame.documentId;
    const next = page.nextView();
    expect(next.documentId).toMatch(/^doc-/);
    expect(next.documentId).not.toBe(first);
    cleanup();
    expect(mount('elsewhere').iframe.getAttribute('srcdoc')).toMatch(/^without tools documentId="doc-/);
    cleanup();
    expect(mount('embed').iframe.getAttribute('srcdoc')).toMatch(/^without tools documentId="doc-/);
  });

  it('on a view without tools, a requireTools from the replaced document is ignored too', async () => {
    const { frame: old, nextView } = mount('embed');
    const current = nextView();
    old.post({ type: 'bevel.tools.require', requestId: 'q1' });
    await settled();
    expect(screen.queryByText(/only available in the platform/)).toBeNull();
    expect(old.replies).toEqual([]);
    expect(current.replies).toEqual([]);

    current.post({ type: 'bevel.tools.require', requestId: 'q2' });
    expect(await screen.findByText('Roadmap uses tools that are only available in the platform')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without tools' }));
    await waitFor(() => expect(current.replies.at(-1)).toEqual({ type: 'bevel.tools.require.response', requestId: 'q2', ok: true, result: false }));
  });

  it('ignores a message from the document a view change replaced, and answers the new document', async () => {
    // The old document queued its call before the change and the frame's
    // window delivered it after: same window, old identity. Nothing of it
    // runs or shows; the new document's own call is answered.
    const server = stubServer();
    const { frame: old, nextView } = mount('file page');
    const current = nextView();
    old.post(write('w1'));
    old.post({ type: 'bevel.tools.require', requestId: 'q1' });
    await settled();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Nothing posted to the window at all: neither the old channel nor the new one hears a reply.
    expect(old.replies).toEqual([]);
    expect(current.replies).toEqual([]);
    expect(server.mcp).toEqual([]);

    current.post({ type: 'bevel.tool.call', requestId: 'r1', fn: 'callTool', args: ['read_file', {}] });
    await waitFor(() => expect(current.replies).toEqual([{ type: 'bevel.tool.response', requestId: 'r1', ok: true, result: { ran: 'read_file' } }]));
    expect(server.mcp).toEqual(['read_file']);
  });

  it('runs a read with no card', async () => {
    const server = stubServer();
    const { frame } = mount('file page');
    frame.post({ type: 'bevel.tool.call', requestId: 'r1', fn: 'callTool', args: ['read_file', {}] });
    await waitFor(() => expect(frame.replies).toEqual([{ type: 'bevel.tool.response', requestId: 'r1', ok: true, result: { ran: 'read_file' } }]));
    expect(screen.queryByText(CARD)).toBeNull();
    expect(server.mcp).toEqual(['read_file']);
  });

  it('asks once for ten writes at once, in the plain sentence with the path under it and two buttons', async () => {
    const server = stubServer();
    const { frame } = mount('file page');
    for (let i = 0; i < 10; i += 1) frame.post(write(`w${i}`));
    expect(await screen.findByText(CARD)).toBeTruthy();
    expect(screen.getByText(PAGE)).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    const labels = [...dialog.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter((t) => t === "Don't allow" || t === 'Allow');
    expect(labels).toEqual(["Don't allow", 'Allow']);
    expect(screen.getAllByRole('button', { name: 'Allow' })).toHaveLength(1);
    expect(server.mcp).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(frame.replies).toHaveLength(10));
    expect(frame.replies.every((r) => r.ok === true)).toBe(true);

    frame.post(write('w10'));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w10', ok: true }));
    expect(screen.queryByText(CARD)).toBeNull();
  });

  it('remembers an Allow by the digest of the page\'s source: a later view of the same source asks nothing', async () => {
    const server = stubServer();
    const { frame, nextView } = mount('file page');
    frame.post(write('w1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w1', ok: true }));
    expect(remembered()).toEqual([sha256Hex(SOURCE)]);

    const next = nextView();
    next.post(write('w2'));
    await waitFor(() => expect(next.replies.at(-1)).toMatchObject({ requestId: 'w2', ok: true }));
    expect(screen.queryByText(CARD)).toBeNull();
    expect(server.mcp).toEqual(['edit_file', 'edit_file']);

    // A new mount, as a reload or a navigation back is.
    cleanup();
    const reloaded = mount('file page');
    reloaded.frame.post(write('w3'));
    await waitFor(() => expect(reloaded.frame.replies.at(-1)).toMatchObject({ requestId: 'w3', ok: true }));
    expect(screen.queryByText(CARD)).toBeNull();
  });

  it('asks again when one character of the source changed; Allow keeps both digests', async () => {
    stubServer();
    const { frame, nextView } = mount('file page');
    frame.post(write('w1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ ok: true }));

    const edited = `${SOURCE} `;
    const next = nextView(edited);
    next.post(write('w2'));
    expect(await screen.findByText(CARD)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(next.replies.at(-1)).toMatchObject({ requestId: 'w2', ok: true }));
    expect(remembered()).toEqual([sha256Hex(SOURCE), sha256Hex(edited)]);

    // Changed back: that digest is still stored.
    const reverted = nextView(SOURCE);
    reverted.post(write('w3'));
    await waitFor(() => expect(reverted.replies.at(-1)).toMatchObject({ requestId: 'w3', ok: true }));
    expect(screen.queryByText(CARD)).toBeNull();
  });

  it('remembers by content, not path: the same source at another path asks nothing', async () => {
    stubServer();
    const first = mount('file page');
    first.frame.post(write('w1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(first.frame.replies.at(-1)).toMatchObject({ ok: true }));
    cleanup();

    const copy = mount('file page', { path: 'knowledge-base/Dashboards/Copy.html', page: 'Dashboards/Copy.html' });
    copy.frame.post(write('w2'));
    await waitFor(() => expect(copy.frame.replies.at(-1)).toMatchObject({ requestId: 'w2', ok: true }));
    expect(screen.queryByText(CARD)).toBeNull();
  });

  it('asks on every view in a browser that cannot store, with no error shown', async () => {
    stubServer();
    // A storage that throws on the memory's key (the app's own sign-in reads
    // the same storage, so a storage refusing everything signs nobody in).
    const real = window.localStorage;
    const refuse = (key: string) => {
      if (key.startsWith(ALLOWED_PAGE_KEY_PREFIX)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      getItem: (key: string) => (refuse(key), real.getItem(key)),
      setItem: (key: string, value: string) => (refuse(key), real.setItem(key, value)),
      removeItem: (key: string) => real.removeItem(key),
      key: (i: number) => real.key(i),
      get length() {
        return real.length;
      },
    } as unknown as Storage);
    const { frame, nextView } = mount('file page');
    frame.post(write('w1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w1', ok: true }));
    const next = nextView();
    next.post(write('w2'));
    expect(await screen.findByText(CARD)).toBeTruthy();
  });

  it("Don't allow answers denied, runs nothing and stores nothing; the next write asks again, in this view and the next", async () => {
    const server = stubServer();
    const { frame, nextView } = mount('file page');
    frame.post(write('w1'));
    fireEvent.click(await screen.findByRole('button', { name: "Don't allow" }));
    await waitFor(() => expect(frame.replies.at(-1)).toEqual({ type: 'bevel.tool.response', requestId: 'w1', ok: false, error: 'denied', code: 'denied' }));
    expect(server.mcp).toEqual([]);
    expect(window.localStorage.getItem(ALLOWED_PAGE_KEY_PREFIX + sha256Hex(SOURCE))).toBeNull();
    expect(storedEntries()).toEqual([]);
    frame.post(write('w2'));
    expect(await screen.findByText(CARD)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
    await waitFor(() => expect(frame.replies.at(-1)).toMatchObject({ requestId: 'w2', code: 'denied' }));
    const next = nextView();
    next.post(write('w3'));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
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
    const next = nextView();
    await waitFor(() => expect(screen.queryByText(CARD)).toBeNull());
    next.post({ type: 'bevel.tool.call', requestId: 'r2', fn: 'callTool', args: ['read_file', {}] });
    await waitFor(() => expect(next.replies).toEqual([{ type: 'bevel.tool.response', requestId: 'r2', ok: true, result: { ran: 'read_file' } }]));
    expect(frame.replies).toEqual([]);
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
