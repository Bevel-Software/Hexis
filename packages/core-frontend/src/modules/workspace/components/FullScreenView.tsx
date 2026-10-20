import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { IconButton, useModalLayer, useLatestRef } from '../../../shared/components';

/**
 * The file page's "fill the window" view — the host's, never a renderer's.
 *
 * The URL IS the state: `?fullscreen=1` on the file's address. There is no
 * React state beside it, so a reload, a shared link and the button all reach
 * the same view the same way. Entering and leaving REPLACE the history entry:
 * the view is a way of looking at the same file, not a place of its own, so
 * Back leaves the file rather than the view.
 *
 * "Full screen" is the browser's viewport, not the Fullscreen API: no
 * permission prompt, it works when the app is itself framed, and the address
 * bar stays so the URL can be copied.
 */
export const FULL_SCREEN_PARAM = 'fullscreen';

export interface FullScreenView {
  fullscreen: boolean;
  enter(): void;
  leave(): void;
}

export function useFullScreenView(): FullScreenView {
  const location = useLocation();
  const navigate = useNavigate();
  const fullscreen = new URLSearchParams(location.search).get(FULL_SCREEN_PARAM) === '1';
  // Read at the moment of the toggle, so the handlers stay stable.
  const locationRef = useLatestRef(location);

  const setParam = useCallback(
    (on: boolean) => {
      const current = locationRef.current;
      const params = new URLSearchParams(current.search);
      if (on) params.set(FULL_SCREEN_PARAM, '1');
      else params.delete(FULL_SCREEN_PARAM);
      const search = params.toString();
      // The same entry under a different view: its router state (a
      // `startEditing` request not yet acted on) and its hash ride along.
      navigate(
        { pathname: current.pathname, search: search ? `?${search}` : '', hash: current.hash },
        { replace: true, state: current.state },
      );
    },
    [locationRef, navigate],
  );
  const enter = useCallback(() => setParam(true), [setParam]);
  const leave = useCallback(() => setParam(false), [setParam]);
  return { fullscreen, enter, leave };
}

/** The way in: an icon button beside the file's other actions. */
export function FullScreenButton({ onEnter }: { onEnter(): void }) {
  return (
    <IconButton aria-label="Full screen" title="Full screen" onClick={onEnter}>
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
 */
export function ExitFullScreenButton({ onExit }: { onExit(): void }) {
  const isTopLayer = useModalLayer(true);
  const onExitRef = useLatestRef(onExit);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !isTopLayer()) return;
      e.stopPropagation();
      onExitRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isTopLayer, onExitRef]);

  return (
    <IconButton
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
