import { useMemo } from 'react';
import { useAppRegistry } from '../../../../core/registry';
import { useRendererSurface } from './rendererSurface';

/**
 * How a renderer that draws the knowledge graph (a dashboard's HTML) loads
 * it on the surface it is mounted on — the ONE place both answers live:
 *
 *  - On a surface that offers the graph (the embed, which reads it with its
 *    token), the surface's own loader.
 *  - In the app, where there is no surface by design, the registry's source
 *    read with the reader's session for `workspaceId`.
 *
 * Null when the distribution registered no graph source at all; the renderer
 * then draws its "open this in the app" fallback. The renderer never picks
 * an address itself, so the same one draws inside an issue panel or a chat
 * as it draws in the app. See `AppRegistry.kbGraphSource`.
 */
export function useKbGraphLoader(workspaceId: string | null): (() => Promise<unknown>) | null {
  const surface = useRendererSurface();
  const source = useAppRegistry().kbGraphSource;
  return useMemo(() => {
    if (surface) return surface.loadKbGraph ?? null;
    if (!source || !workspaceId) return null;
    return () => source.inApp(workspaceId);
  }, [surface, source, workspaceId]);
}
