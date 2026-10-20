import { useEffect } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { IconButton, useModalLayer, useLatestRef } from '../../../shared/components';

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
