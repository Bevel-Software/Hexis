import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useFileNav } from '../../routing/kb-routes';
import { useRendererSurface } from './rendererSurface';
import { Button, Dialog } from '../../../../shared/components';
import {
  PageConsent,
  PageToolsClient,
  answerToolCall,
  asToolCall,
  pageName,
  useOpenPageInPlatform,
  usePageTools,
} from './htmlToolBridge';

/**
 * The card the app shows over a page, outside its frame: the page cannot draw,
 * see or answer it. `write`: the page's first writing call asks the viewer.
 * `platform`: a page that needs tools asked for them where there are none.
 */
type PageCard = { kind: 'write' | 'platform'; answer: (ok: boolean | null) => void };

export interface HtmlToolBridgeOptions {
  /** The renderer's frame: only messages from its window are answered, and only to it. */
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** The file the renderer shows, as its own props name it: what the cards name, and what Open in the platform opens. */
  filePath: string;
  /**
   * The page VIEW's identity, compared with `Object.is`: change it whenever
   * the frame's document goes — a reload, a rebuilt document, the frame
   * unmounted (Edit). The viewer's answer about writes holds for one view;
   * when the key changes an open card closes and every call the old view
   * made that has not yet run is answered `closed` and runs nothing. A key
   * that does not change across a reload keeps the consent across it.
   */
  viewKey: unknown;
}

export interface HtmlToolBridgeResult {
  /** Whether the frame's document is built with `window.bevel.tools` — `buildSandboxedHtml`'s `toolBridge`. */
  toolBridge: boolean;
  /** The two cards, for the renderer to render beside its frame. */
  cards: ReactNode;
}

/**
 * The app's half of a page's `window.bevel.tools` and `requireTools()`, for
 * any renderer that shows an HTML page in a sandboxed frame: which pages get
 * tools (the app's file page, never a surface), the viewer's tool client, the
 * per-view consent, the cards, and the frame's tool messages. A renderer
 * passes its frame, its file and its view key, builds its document with
 * `toolBridge`, and renders `cards` — it holds no bridge logic of its own.
 */
export function useHtmlToolBridge({ iframeRef, filePath, viewKey }: HtmlToolBridgeOptions): HtmlToolBridgeResult {
  const { openFilePage } = useFileNav();
  const surface = useRendererSurface();
  // The viewer's tools, for a page on the app's file page — the one place
  // that provides them. Everywhere else the page gets `bevel.tools = null`.
  const pageTools = usePageTools();
  const openPageInPlatform = useOpenPageInPlatform();
  const toolPagePath = surface === null && pageTools ? pageTools.pagePath : null;
  const toolsClient = useMemo(() => (toolPagePath ? new PageToolsClient(toolPagePath) : null), [toolPagePath]);
  const [card, setCard] = useState<PageCard | null>(null);
  const cardRef = useRef<PageCard | null>(null);
  // The viewer's answer about this page's writes holds for one VIEW of it: a
  // new frame document (a reload, a saved edit, another file) asks again.
  const consentRef = useRef<PageConsent | null>(null);

  /** Show one of the app's cards over the page and resolve with the viewer's answer. A card already up answers this ask too. */
  const showCard = useCallback((kind: PageCard['kind']): Promise<boolean | null> => {
    const open = cardRef.current;
    if (open && open.kind === kind) {
      return new Promise((resolve) => {
        const first = open.answer;
        open.answer = (ok) => {
          first(ok);
          resolve(ok);
        };
      });
    }
    return new Promise((resolve) => {
      const next: PageCard = { kind, answer: resolve };
      cardRef.current = next;
      setCard(next);
    });
  }, []);

  /** Close the card with the viewer's answer, or null when the view went before they gave one. */
  const closeCard = useCallback((ok: boolean | null) => {
    const open = cardRef.current;
    cardRef.current = null;
    setCard(null);
    open?.answer(ok);
  }, []);

  // When the page's view ends its consent is closed — a call the old view
  // made that is still deciding (the manual lookup in flight) or waiting is
  // answered `closed` and runs nothing — and a card left open answers no:
  // nothing the old view asked for runs in, or asks from, the new one.
  useEffect(
    () => () => {
      consentRef.current?.close();
      consentRef.current = null;
      closeCard(null);
    },
    [viewKey, closeCard],
  );

  // A page's `window.bevel.tools` calls and its `requireTools()`, posted by
  // the runtime in the frame (see `htmlSandbox.ts`), answered here with the
  // viewer's session.
  useEffect(() => {
    function onToolMessage(event: MessageEvent) {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return;
      const reply = (message: unknown) => {
        // Only to the document that asked: a reloaded frame is a new window.
        if (iframeRef.current?.contentWindow === iframeWin) iframeWin.postMessage(message, '*');
      };
      const data = event.data as { type?: unknown; requestId?: unknown } | null;
      if (data && data.type === 'bevel.tools.require' && typeof data.requestId === 'string') {
        const requestId = data.requestId;
        if (toolsClient) {
          reply({ type: 'bevel.tools.require.response', requestId, ok: true, result: true });
          return;
        }
        void showCard('platform').then(() =>
          // Either way the page that asked carries on without tools: Open in
          // the platform opened it elsewhere, it did not give it tools here.
          reply({ type: 'bevel.tools.require.response', requestId, ok: true, result: false }),
        );
        return;
      }
      const call = asToolCall(data);
      if (!call) return;
      if (!toolsClient) {
        reply({
          type: 'bevel.tool.response',
          requestId: call.requestId,
          ok: false,
          error: 'Tools are only available on the page in the platform.',
          code: 'unavailable',
        });
        return;
      }
      consentRef.current ??= new PageConsent(() => showCard('write'));
      void answerToolCall(call, toolsClient, consentRef.current).then(reply);
    }
    window.addEventListener('message', onToolMessage);
    return () => window.removeEventListener('message', onToolMessage);
  }, [iframeRef, toolsClient, showCard]);

  const openInPlatform = useCallback(() => {
    closeCard(false);
    // The host's own way when it has one (a skill page, whose filePath is
    // relative to the skill); otherwise the file page, by an address that
    // asks for it outright: on the embed the surface opens it through the
    // host in a new tab, which carries no router state, and a page inside a
    // skill's folder would otherwise open as that skill's page again.
    if (openPageInPlatform) openPageInPlatform();
    else openFilePage(filePath);
  }, [closeCard, openPageInPlatform, openFilePage, filePath]);

  const cards = (
    <>
      <Dialog
        open={card?.kind === 'write'}
        onClose={() => closeCard(false)}
        title={`${pageName(filePath)} wants to write to the knowledge base`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => closeCard(false)}>
              Deny
            </Button>
            <Button variant="primary" onClick={() => closeCard(true)}>
              Allow while open
            </Button>
          </>
        }
      >
        <p className="font-mono text-detail text-ink-muted break-all">{toolPagePath ?? filePath}</p>
      </Dialog>
      <Dialog
        open={card?.kind === 'platform'}
        onClose={() => closeCard(false)}
        title={`${pageName(filePath)} uses tools that are only available in the platform`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => closeCard(false)}>
              Continue without tools
            </Button>
            <Button variant="primary" onClick={openInPlatform}>
              Open in the platform
            </Button>
          </>
        }
      >
        <p className="font-mono text-detail text-ink-muted break-all">{filePath}</p>
      </Dialog>
    </>
  );

  return { toolBridge: toolPagePath !== null, cards };
}
