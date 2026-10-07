import { createContext, useContext } from 'react';

/**
 * A surface that mounts the app's file renderers OUTSIDE the app.
 *
 * Every renderer in this folder asks its surroundings for exactly two things
 * beyond its props: where a file's BYTES come from, and what happens when
 * somebody CLICKS A LINK. Inside the app both answers come from the
 * providers — the raw file route under the session cookie, and react-router
 * navigation — and nothing needs this context.
 *
 * The embed is the surface where both answers are different, and neither is a
 * variation of the app's:
 *
 *  - Bytes come from `/api/embed/raw`, authenticated by the embed token and
 *    nothing else. There is no session: the page is framed by a host, and a
 *    cookie that travelled into that frame is exactly what the token-only
 *    rule exists to prevent.
 *  - A link must open the APP IN A NEW TAB, through the host, and must never
 *    navigate the embed. The embed is one page deep by decision; navigating
 *    it would show a page no token was minted for, inside a frame whose
 *    reader has no way back.
 *
 * So this is an INDIRECTION, not a feature flag: with no surface the hooks
 * below behave exactly as they always have, and the renderers are unchanged.
 * It is deliberately the narrowest thing that works — four verbs and a URL
 * builder — rather than a stand-in `WorkspaceContextValue`, which would be
 * forty methods that mutate a working tree the embed must never touch, and a
 * lie about what the page can do.
 */
export interface RendererSurface {
  /**
   * The knowledge-base directory name, for the link and image grammar
   * (`resolveKbHref`). The app reads it from the workspace; the embed is told
   * it by the load.
   */
  kbDirName: string;
  /**
   * Follow a link destination written inside `basePath`: a knowledge-base
   * page, or an external address. The embed opens both in a new tab through
   * its host.
   */
  openLink(href: string, basePath: string): void;
  /** Follow a node-id link (`<id>` or `<id#heading>`), the copy-link form. */
  openNodeId(idOrLink: string): void;
  /** The absolute, shareable address of `workspacePath` — what a copy-link yields. */
  canonicalUrlFor(workspacePath: string): string | null;
  /** The URL that serves `workspacePath`'s bytes on this surface. */
  rawUrl(workspacePath: string, options?: { version?: number }): string;
  /** Fetch those bytes with whatever credential this surface carries. */
  rawFetch(
    workspacePath: string,
    options?: { version?: number; signal?: AbortSignal },
  ): Promise<Response>;
  /**
   * Whether this surface offers the original bytes as a DOWNLOAD.
   *
   * `download:` is a verb of its own in the app, resolved per path, and the
   * embed has no route that resolves it — so the embed says NO and the button
   * is not drawn at all. Not drawn, rather than drawn and disabled: a
   * disabled control reads as "you may not", and the reader may well read the
   * page perfectly fine. There is simply no download here.
   */
  offersDownload: boolean;
}

export const RendererSurfaceContext = createContext<RendererSurface | null>(null);

/**
 * The surface a renderer is mounted on, or null inside the app.
 *
 * Never throws and needs no provider: "I am in the app" is the answer for
 * every surface but one, and a hook that threw here would make the context
 * mandatory for the whole renderer folder.
 */
export function useRendererSurface(): RendererSurface | null {
  return useContext(RendererSurfaceContext);
}

/**
 * How a renderer reads a file's bytes on the surface it is mounted on.
 *
 * `url` for the places a URL is the whole interface — an `<img src>`, an
 * `<object>`, a markdown picture — and `fetch` for the viewers that read the
 * bytes themselves (a PDF, a workbook, a deck, a message).
 */
export interface RendererRawRead {
  url(workspacePath: string, options?: { version?: number }): string;
  fetch(
    workspacePath: string,
    options?: { version?: number; signal?: AbortSignal },
  ): Promise<Response>;
  /**
   * Whether this read is pinned to a PAST SAVE rather than the working tree.
   *
   * The image viewers fold the workspace image revision into the URL so a
   * replaced picture reaches an open tab. On a past save that is worse than
   * useless: the bytes at a commit cannot change, so the revision would only
   * defeat the browser cache — and it bumps on every save of the file, which
   * for a version pane means re-reading a version that is not what changed.
   * So a pinned read says so, and the revision is dropped.
   */
  pinnedToVersion: boolean;
}
