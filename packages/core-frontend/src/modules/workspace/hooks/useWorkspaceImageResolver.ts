import { useCallback, useContext } from 'react';
import { resolveKbHref } from '../routing/kb-routes';
import { rawFileUrl } from '../services/workspace.api';
import { WorkspaceContext } from '../state/workspace.context';
import { useRendererSurface } from '../components/renderers/rendererSurface';
import { useImageRevision } from './useImageRevision';
import type { KbImageResolver } from '../components/renderers/kbMarkdownPipeline';

/**
 * The resolver every surface that renders workspace markdown hands to
 * `KbMarkdownView` / the diff viewer: an image `src` as the author wrote it →
 * the raw-file URL that serves those bytes, or null when the destination is
 * not ours to serve.
 *
 * There were three copies of this — the markdown renderer, the review panel
 * and the skill page — each spelling out resolve → kind-check → the raw URL
 * with its own workspace id. That is the same drift-shape this PR removed for
 * the LINK handlers (one decoded its href, one did not) and it was already
 * paying out: the repair-heuristic bug below had to be fixed in one place, not
 * three, before the next copy re-introduced it.
 *
 * `workspaceId` is the workspace whose bytes to serve, and it is NOT always
 * the one the user is standing on: the skill page renders the default
 * branch's tree no matter which branch is checked out. `basePath` is the file
 * the image sits in; null means "no file yet" and every src resolves to null.
 *
 * On a {@link RendererSurface} — the embed — the bytes come from that
 * surface's own route instead, because there is no session to send; the
 * grammar above is unchanged. `workspaceId` is then not consulted at all: a
 * surface shows one page of one branch, and the token is what names it.
 *
 * The image revision is folded into the URL as `&v=` so a teammate replacing
 * a picture under the same name reaches an open tab. `useImageRevision`
 * subscribes to `workspaceId` — including one the session is not focused on,
 * which is what makes the skill page's default-branch images refresh from a
 * suggestion branch.
 */
export function useWorkspaceImageResolver(
  workspaceId: string | null,
  basePath: string | null,
): KbImageResolver {
  const surface = useRendererSurface();
  // Read optionally: a surface knows its own `kbDirName` and stands up no
  // workspace provider.
  const workspaceKbDirName = useContext(WorkspaceContext)?.kbDirName ?? null;
  const kbDirName = surface?.kbDirName ?? workspaceKbDirName;
  const revision = useImageRevision(workspaceId);
  return useCallback<KbImageResolver>(
    (src) => {
      // In the app, the workspace this resolver was POINTED AT — which is not
      // always the one on screen (the skill page renders the default branch's
      // tree from a suggestion branch), so it must stay the resolver's own
      // argument and never be re-derived from a renderer context.
      if (!surface && !workspaceId) return null;
      if (basePath === null || kbDirName === null) return null;
      // `repairMangledPath: false` — the junk-segment repair is for LINK
      // destinations a model may have mangled. An image src is a path the
      // author wrote, and the repair rewrites any path with a later segment
      // named like the KB dir, so on `./assets/knowledge-base/shot.png` it
      // would truncate a correct path into a 404. See `resolveKbHref`.
      const target = resolveKbHref(src, { basePath, kbDirName, repairMangledPath: false });
      if (target?.kind !== 'workspace') return null;
      return {
        src: surface
          ? surface.rawUrl(target.path, { version: revision })
          : rawFileUrl(workspaceId!, target.path, { version: revision }),
        path: target.path,
      };
    },
    [surface, workspaceId, basePath, kbDirName, revision],
  );
}
