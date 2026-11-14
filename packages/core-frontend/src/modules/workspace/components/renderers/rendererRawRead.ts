import { useMemo } from 'react';
import { authFetch } from '../../../../lib/api';
import { rawFileUrl } from '../../services/workspace.api';
import { useRendererFileRef, useRendererWorkspaceId } from './rendererWorkspace';
import { useRendererSurface, type RendererRawRead } from './rendererSurface';

/**
 * Where THIS renderer reads a file's bytes from.
 *
 * In the app: the workspace raw file route under the session, for the
 * workspace the renderer is pointed at and the save it is bound to — which
 * every byte-reading viewer here used to spell out for itself, five times
 * over, each one re-deriving the version-ref rules. On a
 * {@link RendererSurface} (the embed): that surface's own route, with its own
 * credential, because there is no session to send.
 *
 * Null while there is no workspace to read from, which is the same "nothing
 * to read yet" every caller already handled.
 */
export function useRendererRawRead(): RendererRawRead | null {
  const surface = useRendererSurface();
  const workspaceId = useRendererWorkspaceId();
  const fileRef = useRendererFileRef();
  // The save as PRIMITIVES, so the memo depends on exactly what it reads
  // rather than on a context object a provider may rebuild per render.
  const versionRef = fileRef?.ref ?? null;
  const versionSide = fileRef?.side;
  return useMemo<RendererRawRead | null>(() => {
    if (surface) {
      // A surface shows one page's working tree and has no history to point
      // at, so it is never pinned to a save.
      return {
        url: (path, options) => surface.rawUrl(path, options),
        fetch: (path, options) => surface.rawFetch(path, options),
        pinnedToVersion: false,
      };
    }
    if (!workspaceId) return null;
    const url = (path: string, options?: { version?: number }) =>
      rawFileUrl(
        workspaceId,
        path,
        versionRef === null
          ? { version: options?.version }
          : { ref: versionRef, side: versionSide },
      );
    return {
      url,
      fetch: (path, options) => authFetch(url(path, options), { signal: options?.signal }),
      pinnedToVersion: versionRef !== null,
    };
  }, [surface, workspaceId, versionRef, versionSide]);
}
