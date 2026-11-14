import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLatestRef } from '../../../shared/components';

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
