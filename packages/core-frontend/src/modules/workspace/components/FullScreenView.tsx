import { useEffect, type Ref, type RefObject } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { IconButton, useModalLayer, useLatestRef } from '../../../shared/components';
import { isFrameEscape } from '../utils/frameEscape';

/**
 * Names the way in, so leaving the view can hand focus back to it: the
 * control that was pressed is withdrawn while the view fills the window, and
 * the one that comes back is a new element.
 */
export const FULL_SCREEN_ENTRY_SELECTOR = '[data-full-screen-entry]';

/** The way in: an icon button beside the file's other actions. */
export function FullScreenButton({ onEnter }: { onEnter(): void }) {
  return (
    <IconButton data-full-screen-entry="" aria-label="Full screen" title="Full screen" onClick={onEnter}>
      <Maximize2 size={14} />
    </IconButton>
  );
}

/**
 * The way out: one small control pinned to the viewport's top right, and
 * Escape.
 *
 * `fixed` and a layer above the surface it sits in, so neither the renderer's
 * own content nor an HTML page's iframe can scroll it away or cover it.
 * Escape goes through the modal layer stack: a dialog opened on top of the
 * view registers after it, so it is the topmost layer and takes Escape first.
 *
 * An Escape pressed inside a page's frame never reaches this document, so the
 * frame posts one the page left alone instead (`bevel.key`, see
 * `htmlSandbox.ts`), a task after the key. One that comes from a frame inside
 * `surface` (`isFrameEscape`) is pressed here again, on the document, so it
 * meets the app's document- and window-level Escape listeners in their usual
 * order — the modal layer's among them, so a card over the page takes it
 * first. A handler on an element of the app's does not see it: none of them
 * had focus. Any other window's message is not the view's to act on.
 */
export function ExitFullScreenButton({
  onExit,
  surface,
  ref,
}: {
  onExit(): void;
  /** The element filling the window; only frames inside it are heard. */
  surface: RefObject<HTMLElement | null>;
  /** The view moves focus here when it opens with none in the renderer. */
  ref?: Ref<HTMLButtonElement>;
}) {
  const isTopLayer = useModalLayer(true);
  const onExitRef = useLatestRef(onExit);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !isTopLayer()) return;
      e.stopPropagation();
      onExitRef.current();
    }
    function onFrameKey(e: MessageEvent) {
      if (!isFrameEscape(e, surface.current)) return;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('message', onFrameKey);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('message', onFrameKey);
    };
  }, [isTopLayer, onExitRef, surface]);

  return (
    <IconButton
      ref={ref}
      data-testid="exit-full-screen"
      aria-label="Exit full screen"
      title="Exit full screen (Esc)"
      aria-keyshortcuts="Escape"
      onClick={onExit}
      className="fixed right-3 top-3 z-[41] bg-surface shadow-md"
    >
      <Minimize2 size={14} />
    </IconButton>
  );
}

/**
 * The classes that make the read pane fill the viewport: above the app's
 * chrome (the sidebar's grip is z-30, its drawer's scrim z-40 only at phone
 * width, where the view hides the toggle that opens it), BELOW the dialogs
 * and menus (z-50 and up), so a confirm opened from the renderer still shows
 * on top.
 */
export const FULL_SCREEN_SURFACE = 'fixed inset-0 z-40 overflow-auto bg-canvas';
