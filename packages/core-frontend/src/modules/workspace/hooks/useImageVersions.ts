import { useCallback, useEffect, useState } from 'react';
import { useEventBus, canonicalizeWorkspaceId } from '../../workflow/state/event-bus.context';

/**
 * The extensions the raw file route serves as pictures, which is what a
 * markdown `<img>` can show. Kept in step with the route's MIME table
 * (`workspace.routes.ts`) and the renderer registry's image entries; folding
 * the three into one table is the MIME TODO in TODOS.md.
 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase());
}

/**
 * How many times each image in `workspaceId` has changed since this hook
 * mounted, as a lookup the image resolvers fold into the raw file URL (`&v=`).
 *
 * A markdown image is a plain `<img>`, so the browser caches it by URL and the
 * raw route answers 304 on revisit, which is what makes a page of thirty
 * screenshots cheap to reopen. The cost is that a teammate replacing
 * `assets/approval.png` under the same name leaves the old picture in every
 * open tab until a reload: a `file-changed` event re-reads the DOCUMENT
 * (`useWorkspaceState`), but nothing re-read the images it embeds. This hook
 * listens for the same event and, for image paths only, bumps a per-path
 * counter; a changed counter is a changed URL, and the browser fetches again.
 *
 * `fsRevision` is not this signal: it is bumped by the local user's own
 * mutations, never by the SSE handler, and every bump re-polls git status.
 *
 * Diff viewers do not use it: they show a revision, not the live tree.
 */
export function useImageVersions(workspaceId: string | null): (path: string) => number {
  const bus = useEventBus();
  const [versions, setVersions] = useState<ReadonlyMap<string, number>>(() => new Map());

  useEffect(() => {
    if (!bus || !workspaceId) return;
    // Canonicalise once: the event carries the decoded branch, local state the
    // encoded one. See `canonicalizeWorkspaceId`.
    const subscribedCanon = canonicalizeWorkspaceId(workspaceId);
    return bus.subscribe('file-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      if (!isImagePath(event.path)) return;
      setVersions((prev) => {
        const next = new Map(prev);
        next.set(event.path, (prev.get(event.path) ?? 0) + 1);
        return next;
      });
    });
  }, [bus, workspaceId]);

  return useCallback((path: string) => versions.get(path) ?? 0, [versions]);
}
