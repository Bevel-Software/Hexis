import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../../../shared/components';
import { useAppRegistry } from '../../../core/registry';
import { isViewOnlyFile, pickFileRenderer } from '../../workspace/components/renderers';
import { CanDownloadContext } from '../../workspace/components/renderers/DownloadFileButton';
import {
  RendererSurfaceContext,
  type RendererSurface,
} from '../../workspace/components/renderers/rendererSurface';
import { RendererWorkspaceContext } from '../../workspace/components/renderers/rendererWorkspace';
import {
  cancelEmbed,
  embedRawUrl,
  EmbedApiError,
  heartbeatEmbed,
  loadEmbed,
  lockEmbed,
  proposeEmbed,
  saveEmbed,
  type EmbedFileView,
} from '../services/embed.api';
import { EMBED_EXPIRED, EMBED_HEIGHT_MESSAGE, hostOrigin, openThroughHost } from '../embed-host';
import { embedBaseUrl, embedSizing, embedToken } from '../embed-config';
import { kbFileUrl } from '../../workspace/routing/kb-routes';

/** How often a held lock is kept alive while somebody is editing. */
const HEARTBEAT_MS = 30_000;

/** Said when a save arrives while the lock is being taken again after a hidden tab. */
const REACQUIRING = 'Taking the edit lock again after the tab was hidden — try saving in a moment.';

/** Said when a heartbeat finds the viewer's write access withdrawn mid-edit. */
const WRITE_WITHDRAWN =
  'You can no longer edit this page directly. Your changes are still here — send them as a proposal instead.';

/** Said when a heartbeat finds the viewer's READ access withdrawn too. */
const READ_WITHDRAWN =
  "You no longer have access to this page, so these changes can't be saved or proposed. " +
  'Copy anything you want to keep before you discard them.';

function lockLostMessage(holder: string): string {
  return `${holder} started editing this page while it was in the background — your draft can't be saved over theirs.`;
}

/**
 * An app path as an absolute URL on the deployment, so a host can open it
 * cross-site — the deployment's address, not this document's, which inside a
 * chat host's sandbox is the sandbox's own.
 */
function absolute(pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${embedBaseUrl()}${pathOrUrl}`;
}

/**
 * ONE knowledge-base page, rendered inside somebody else's frame — an MCP
 * App's sandbox in a chat, an Atlassian issue panel.
 *
 * What it renders is the APP'S OWN renderer for the file's type: markdown
 * through the markdown renderer, an HTML page through the sandboxed HTML one,
 * a document, a workbook, a deck, an image, each through the viewer the file
 * page uses. Not a second rendering path — a second one would have to be kept
 * in step with the app's, and would be the one that is wrong. What makes that
 * possible without the app around it is the renderer SURFACE (see
 * `rendererSurface.ts`): the renderers ask their surroundings where bytes come
 * from and what a link click does, and here both answers are the embed's.
 *
 * Who the reader is comes from the token and only the token. A viewer who may
 * write the file on the default branch gets Edit, under the platform's file
 * lock, writing to the default branch exactly as the file page does. A viewer
 * who may not gets Propose changes, which lands a change request authored by
 * them. Neither of them is ever shown a "no access" notice where a control
 * should be: there is always something they can do.
 */
/**
 * A workspace path, as every renderer hands the surface one, in the form the
 * embed's raw route reads: omitted for the embedded file itself, and
 * `/<repo-relative>` for any other file — the leading slash is what makes the
 * server take it from the repository root rather than beside the page. Sending
 * the workspace path as written made the server look for
 * `<page folder>/<kbDir>/<page folder>/shot.png`, and every picture 404'd.
 *
 * A path outside the knowledge-base folder has no file in the repository; it
 * goes as `/..`, which the server refuses as outside the knowledge base.
 */
function embedRawPath(
  path: string,
  view: Pick<EmbedFileView, 'workspacePath' | 'kbDirName'>,
): string | undefined {
  if (path === view.workspacePath) return undefined;
  const prefix = `${view.kbDirName}/`;
  return path.startsWith(prefix) ? `/${path.slice(prefix.length)}` : '/..';
}

export function EmbedView() {
  // Handed over by the MCP App view that mounted this, or read from the
  // page URL on the SPA's `/embed` route — see `embed-config`.
  const token = embedToken();
  const registry = useAppRegistry();
  const graphSource = registry.kbGraphSource;
  const [view, setView] = useState<EmbedFileView | null>(null);
  /** An expired/absent/rejected token — the one state that shows no content. */
  const [expired, setExpired] = useState(!token);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'read' | 'write'>('read');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [sent, setSent] = useState<{ url?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingLink, setAwaitingLink] = useState(false);
  /** Who took the lock while this frame was hidden — null while we hold it. */
  const [lockLost, setLockLost] = useState<string | null>(null);
  /** The frame is hidden: the lock was let go, and the heartbeat has nothing to keep alive. */
  const [hidden, setHidden] = useState(false);
  /** Back from hidden, the lock is being taken again: Save waits for the answer. */
  const [reacquiring, setReacquiring] = useState(false);
  // Read access withdrawn mid-edit. The editor stays open on the draft so
  // nothing typed vanishes, but nothing can be sent from it.
  const [accessLost, setAccessLost] = useState(false);

  const reload = useCallback(() => {
    if (!token) {
      setExpired(true);
      return;
    }
    setNotice(null);
    loadEmbed(token)
      .then((next) => {
        setView(next);
        setExpired(false);
        setLoadError(null);
        setMode('read');
        setLockLost(null);
        setAccessLost(false);
        setSent(null);
        if (next.linked) setAwaitingLink(false);
      })
      .catch((err: unknown) => {
        // 401 is the token: absent, malformed, or past its hour. That is
        // the expired view — a plain sentence and NO content, ever.
        if (err instanceof EmbedApiError && err.status === 401) {
          setExpired(true);
          setView(null);
          return;
        }
        setLoadError(err instanceof Error ? err.message : 'This page could not be loaded.');
      });
  }, [token]);

  useEffect(() => reload(), [reload]);

  // The heading the agent named opens the view there: the renderer's deep
  // link reads the location's hash, and the embed's own address carries
  // none — so the heading is put there, once, before that effect runs.
  const location = useLocation();
  const navigate = useNavigate();
  const heading = view?.heading;
  useEffect(() => {
    if (!heading || location.hash) return;
    navigate({ search: location.search, hash: `#${encodeURIComponent(heading)}` }, { replace: true });
  }, [heading, location.hash, location.search, navigate]);

  // Keep the held lock alive while somebody is editing. Not while proposing:
  // a proposal takes no lock, because nothing it does touches the default
  // branch.
  //
  // A heartbeat refused with 403 means access was withdrawn mid-edit. The page
  // is read again to learn how much: with read access left it now offers a
  // proposal, not a save; with none, the view is NOT swapped for the
  // no-access screen — the editor keeps the draft on screen, nothing can be
  // sent, and the reader is told why. Either way the edits are not lost. Any
  // other failure is left to the lock's TTL and to Save, which refuses with
  // its own reason.
  const holdsLock = mode === 'write' && (view?.canWrite ?? false) && !accessLost;
  useEffect(() => {
    // Nothing to keep alive while the frame is hidden: the lock was let go on
    // the way out, and a heartbeat now would only renew somebody else's.
    if (!holdsLock || hidden) return;
    const id = window.setInterval(() => {
      heartbeatEmbed(token).catch((err: unknown) => {
        if (!(err instanceof EmbedApiError && err.status === 403)) return;
        // The edit lock goes NOW, whichever access went: nothing from this
        // editor can be saved any more, and holding it would block every
        // other writer until the TTL. Releasing needs no access — the
        // server lets go only of a lock this identity holds.
        cancelEmbed(token).catch(() => undefined);
        loadEmbed(token)
          .then((next) => {
            if (!next.linked || !next.canRead) {
              setAccessLost(true);
              setNotice(READ_WITHDRAWN);
              return;
            }
            setNotice(WRITE_WITHDRAWN);
            setView(next);
          })
          .catch((loadErr: unknown) => {
            // A 401 here is the token running out, which Save reports anyway.
            setNotice(loadErr instanceof Error ? loadErr.message : 'Your access to this page changed.');
          });
      });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [holdsLock, hidden, token]);

  // Best-effort lock release when the frame is hidden or closed mid-edit. The
  // server's lock TTL plus the heartbeat above is the real backstop — a
  // cross-origin iframe cannot promise an unload signal fires.
  //
  // Hidden is not closed: a reader who switches tabs comes back to the same
  // open editor. So on the way back the lock is TAKEN AGAIN before Save can
  // mean anything — and if somebody else took it meanwhile, the reader is
  // told so and Save is refused (the server refuses it too: it saves only
  // under a lock this reader holds).
  const holdsLockRef = useRef(holdsLock);
  useEffect(() => {
    holdsLockRef.current = holdsLock;
  }, [holdsLock]);
  useEffect(() => {
    const release = () => {
      if (holdsLockRef.current) cancelEmbed(token).catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setHidden(true);
        release();
        return;
      }
      setHidden(false);
      if (!holdsLockRef.current) return;
      // Until the lock is held again, Save is refused here rather than by
      // the server: the editor is on screen, but the claim behind it is not.
      setReacquiring(true);
      lockEmbed(token)
        .then((result) => {
          setLockLost(result.acquired ? null : (result.holderName ?? 'Someone else'));
        })
        .catch(() => setLockLost('Someone else'))
        .finally(() => setReacquiring(false));
    };
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', release);
      document.removeEventListener('visibilitychange', onVisibility);
      // Taken down mid-edit — a chat view replaced by another mount, a
      // route left — the lock goes with it, rather than shutting the file
      // to other writers until the TTL. Nothing the page did fires for a
      // React unmount, so this is where it has to happen.
      release();
    };
  }, [token]);

  // The content's height, reported to the host whenever it changes, so a
  // host that sizes its frame to the content (the Atlassian issue panel)
  // can follow instead of showing a gap or an inner scrollbar. The app's
  // global CSS pins html, body and #root to 100% height for the three-pane
  // shell; inside a fixed-height frame that is exactly the gap, so the
  // embed relaxes them to natural height for as long as it is mounted.
  // Only for a host that asked to size its frame to the content
  // (`sizing=content`, which the connector's mint puts on the address): a
  // host with a fixed reading pane — the MCP App's — keeps its pane as it
  // is, and the view scrolls inside it as it always did. Nothing is posted
  // when the page is not framed either: there is nobody to tell.
  const fitContent = useMemo(() => embedSizing() === 'content', []);
  const reportHeight = useCallback(() => {
    if (!fitContent || window.parent === window) return;
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    window.parent.postMessage({ type: EMBED_HEIGHT_MESSAGE, height }, hostOrigin() ?? '*');
  }, [fitContent]);
  useEffect(() => {
    if (!fitContent || window.parent === window) return;
    const targets = [document.documentElement, document.body, document.getElementById('root')].filter(
      (el): el is HTMLElement => el !== null,
    );
    const prev = targets.map((el) => ({ el, height: el.style.height, overflow: el.style.overflow }));
    for (const el of targets) {
      el.style.height = 'auto';
      el.style.overflow = 'visible';
    }
    reportHeight();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reportHeight) : null;
    observer?.observe(document.body);
    return () => {
      observer?.disconnect();
      for (const { el, height, overflow } of prev) {
        el.style.height = height;
        el.style.overflow = overflow;
      }
    };
  }, [fitContent, reportHeight]);
  // The height again whenever what is on screen changes — the page arriving,
  // the editor opening or closing, a notice — so the first real height never
  // depends on a `ResizeObserver` the host's runtime may not have. Here, with
  // the other hooks: the view returns early below for a page not yet loaded.
  useEffect(() => {
    reportHeight();
  }, [reportHeight, view, mode, notice, sent, lockLost]);

  /**
   * The surface the app's renderers are mounted on. Rebuilt only when the
   * page changes: the renderers take it as a context, and a fresh object per
   * render would re-run every read effect that depends on it.
   */
  const surface = useMemo<RendererSurface | null>(() => {
    if (!view) return null;
    const open = (href: string, basePath: string) =>
      openThroughHost(href, basePath, { kbDirName: view.kbDirName, branch: view.branch });
    return {
      kbDirName: view.kbDirName,
      openLink: open,
      // A path from a tree, verbatim — never through the link grammar, which
      // would read a `#` in a file name as an anchor.
      openWorkspacePath: (path) => openThroughHost(absolute(kbFileUrl(view.branch, path)), '', null),
      // A node id is handed to the host as the app's own copy-link address;
      // the app resolves it with the reader's session, which is the only
      // place that resolution can be done.
      openNodeId: (idOrLink) => open(`/workspace/${encodeURIComponent(view.branch)}/${idOrLink}`, ''),
      // The page's address without the heading the view opened at: a heading
      // link appends its own fragment, and two fragments is no address.
      canonicalUrlFor: () => absolute(view.appUrl).split('#', 1)[0],
      rawUrl: (path, options) => embedRawUrl(token, embedRawPath(path, view), options),
      rawFetch: (path, options) =>
        fetch(embedRawUrl(token, embedRawPath(path, view), options), {
          credentials: 'omit',
          signal: options?.signal,
        }),
      // No download route under the token: `download:` is its own verb, which
      // the embed has nothing to resolve it with.
      offersDownload: false,
      // The knowledge graph a dashboard draws, as this token's viewer may see
      // it — when the distribution registered where the embed reads it from.
      ...(graphSource ? { loadKbGraph: () => graphSource.inEmbed(token) } : {}),
    };
  }, [view, token, graphSource]);

  /**
   * The workspace the renderers believe they are reading from. Never dialled:
   * every byte comes through the surface above. It is here because
   * `useRendererWorkspaceId` has to ANSWER rather than throw, and the honest
   * answer is the default branch — the branch the embed renders.
   */
  const rendererWorkspace = useMemo(
    () => ({ workspaceId: view ? encodeURIComponent(view.branch) : null }),
    [view],
  );

  const onEdit = useCallback(async () => {
    if (!view) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await lockEmbed(token);
      if (!result.acquired) {
        setNotice(`${result.holderName ?? 'Someone else'} is editing this page — try again shortly.`);
        return;
      }
      setDraft(view.content);
      setLockLost(null);
      setMode('write');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not start editing.');
    } finally {
      setBusy(false);
    }
  }, [view, token]);

  const onPropose = useCallback(() => {
    if (!view) return;
    // No lock, no round trip: a proposal touches nothing on the default
    // branch, so the editor can open on the spot.
    setNotice(null);
    setDraft(view.content);
    setMode('write');
  }, [view]);

  const onSave = useCallback(
    async (content: string) => {
      if (!view) return;
      // Already on screen beside the editor; the refusal is for the
      // renderer's own save shortcut, which does not see the disabled button.
      if (accessLost) throw new Error(READ_WITHDRAWN);
      if (view.canWrite && lockLost) throw new Error(lockLostMessage(lockLost));
      // Back from a hidden tab, the lock is being taken again: a save sent
      // now would race the answer, and the server would refuse it anyway.
      if (view.canWrite && reacquiring) throw new Error(REACQUIRING);
      setBusy(true);
      setNotice(null);
      try {
        if (view.canWrite) {
          await saveEmbed(token, content);
          reload();
        } else {
          const result = await proposeEmbed(token, content);
          setSent({ url: result.url });
          setMode('read');
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'That could not be saved.');
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [view, token, reload, lockLost, accessLost, reacquiring],
  );

  const onCancel = useCallback(async () => {
    setBusy(true);
    try {
      // Released even after access was withdrawn (see the heartbeat above):
      // a second release is a no-op, a skipped one blocks other writers.
      if (view?.canWrite) await cancelEmbed(token).catch(() => undefined);
    } finally {
      setBusy(false);
      setMode('read');
      setLockLost(null);
      setNotice(null);
      // The view on screen predates the withdrawal; read it again so the
      // reader lands on what they may now see, not on the old content.
      if (accessLost) reload();
    }
  }, [view, token, accessLost, reload]);

  // ── the states that show no content ──────────────────────────────────────

  if (expired) {
    return (
      <EmbedNotice>
        {EMBED_EXPIRED}
      </EmbedNotice>
    );
  }
  if (loadError) return <EmbedNotice tone="danger">{loadError}</EmbedNotice>;
  if (!view || !surface) return <EmbedNotice>Opening this page…</EmbedNotice>;
  if (!view.linked) {
    return (
      <EmbedNotice>
        Sign in to see this page.{' '}
        <EmbedLink href={view.linkUrl} onOpen={() => setAwaitingLink(true)}>
          Link your account
        </EmbedLink>
        {awaitingLink && (
          <span className="mt-2 block">
            <Button variant="outline" size="tiny" onClick={reload}>
              I&apos;ve signed in — reload
            </Button>
          </span>
        )}
      </EmbedNotice>
    );
  }
  if (!view.canRead) {
    return (
      <EmbedNotice>
        You don&apos;t have access to this page.{' '}
        <EmbedLink href={view.appUrl}>Open the knowledge base</EmbedLink> to ask an owner for it.
      </EmbedNotice>
    );
  }

  // ── the page ─────────────────────────────────────────────────────────────

  // The app's renderer for this file's type, through the SAME lookup the file
  // page uses — a deployment's registered override first, the built-in map
  // after — so a renderer the enterprise contributes reaches the embed on the
  // day it is added.
  const Renderer = pickFileRenderer(view.workspacePath, registry.renderers);
  // A file with no editing surface behind the control — an image, a PDF, a
  // workbook — offers no write action, exactly as the file page offers none.
  // Nothing is implied about access; there is simply no text to change.
  const viewOnly = isViewOnlyFile(view.workspacePath) || !view.contentIsText;
  const writing = mode === 'write';

  return (
    <div className="flex h-full min-w-0 flex-col gap-2 p-3">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-detail font-semibold text-ink">
          {view.nodeName}
        </span>
        {!viewOnly &&
          (writing ? (
            <>
              <Button variant="quiet" size="tiny" onClick={() => void onCancel()} disabled={busy}>
                Discard
              </Button>
              <Button
                variant="primary"
                size="tiny"
                onClick={() => void onSave(draft).catch(() => undefined)}
                disabled={busy || accessLost || (view.canWrite && lockLost !== null)}
              >
                {busy ? 'Sending…' : view.canWrite ? 'Save' : 'Send proposal'}
              </Button>
            </>
          ) : view.canWrite ? (
            <Button variant="outline" size="tiny" onClick={() => void onEdit()} disabled={busy}>
              {busy ? 'Loading…' : 'Edit'}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="tiny"
              onClick={onPropose}
              disabled={busy}
              title="You can't edit this page directly. Propose a change for its owners to approve"
            >
              Propose changes
            </Button>
          ))}
      </div>

      {writing && view.canWrite && lockLost && (
        <p role="alert" className="shrink-0 text-detail text-danger">
          {lockLostMessage(lockLost)}
        </p>
      )}
      {notice && (
        <p role="alert" className="shrink-0 text-detail text-danger">
          {notice}
        </p>
      )}
      {sent && (
        <p className="shrink-0 text-detail text-ink-muted">
          Your proposal was sent for approval.{' '}
          {sent.url && <EmbedLink href={sent.url}>Open the change request</EmbedLink>}
        </p>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <RendererSurfaceContext.Provider value={surface}>
          {/* The renderers read bytes through the surface above, so the
              workspace id here is never dialled — it is the default branch's,
              which is the branch the embed renders, and it keeps
              `useRendererWorkspaceId` answering rather than throwing. */}
          <RendererWorkspaceContext.Provider value={rendererWorkspace}>
            <CanDownloadContext.Provider value={false}>
              <Renderer
                content={writing ? draft : view.content}
                savedContent={view.content}
                filePath={view.workspacePath}
                onSave={onSave}
                onValueChange={writing ? setDraft : undefined}
                readOnly={!writing}
              />
            </CanDownloadContext.Provider>
          </RendererWorkspaceContext.Provider>
        </RendererSurfaceContext.Provider>
      </div>
    </div>
  );
}

/** A plain sentence, which is all some states have to say. */
function EmbedNotice({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'danger';
}) {
  return (
    <p
      className={`p-3 text-detail ${tone === 'danger' ? 'text-danger' : 'text-ink-muted'}`}
      {...(tone === 'danger' ? { role: 'alert' } : {})}
    >
      {children}
    </p>
  );
}

/** A link out of the embed: always a new tab, through the host. */
function EmbedLink({
  href,
  onOpen,
  children,
}: {
  href: string;
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  return (
    <a
      className="cursor-pointer text-accent underline"
      href={absolute(href)}
      onClick={(event) => {
        event.preventDefault();
        openThroughHost(absolute(href), '', null);
        onOpen?.();
      }}
    >
      {children}
    </a>
  );
}
