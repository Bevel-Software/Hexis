import { useEffect, useState } from 'react';
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
 * How many times the images of `workspaceId` have changed since this hook
 * started counting for it. The image resolvers fold it into the raw file URL
 * as `&v=`, so a changed number is a changed URL and the browser fetches
 * again.
 *
 * A markdown image is a plain `<img>`, so the browser caches it by URL and the
 * raw route answers 304 on revisit, which is what makes a page of thirty
 * screenshots cheap to reopen. The cost is that a teammate replacing
 * `assets/approval.png` under the same name leaves the old picture in every
 * open tab until a reload: a `file-changed` event re-reads the DOCUMENT
 * (`useWorkspaceState`), but nothing re-read the images it embeds.
 *
 * One counter per workspace, not a map per path. A per-path map was the first
 * design, and it had three holes with one cause: it carried counters across a
 * workspace switch, it missed a bulk change (`fs-tree-changed`, which the
 * backend sends instead of per-file events for a folder delete or a large
 * sync), and it grew for the life of the tab. A single revision cannot express
 * any of them: a switch starts at 0, any tree change bumps it, and there is
 * nothing to evict. The cost is that one changed image revalidates every image
 * on the page; with `Cache-Control: private, no-cache` and the ETag Express
 * sets, each of those is a 304 with no bytes.
 *
 * `fsRevision` is not this signal: it is bumped by the local user's own
 * mutations, never by the SSE handler, and every bump re-polls git status.
 *
 * Views of another revision than the checked-out tree (the change-request
 * dialog, the file history) do not use it: they show no live image at all.
 */
export function useImageRevision(workspaceId: string | null): number {
  const bus = useEventBus();
  // The count is stored WITH the workspace it counts for, so a workspace this
  // hook has not counted yet reads as 0 rather than as the previous one's
  // number.
  const [revision, setRevision] = useState<{ workspaceId: string | null; count: number }>(
    () => ({ workspaceId, count: 0 }),
  );

  useEffect(() => {
    if (!bus || !workspaceId) return;
    // Canonicalise once: the event carries the decoded branch, local state the
    // encoded one. See `canonicalizeWorkspaceId`.
    const subscribedCanon = canonicalizeWorkspaceId(workspaceId);
    const bump = () =>
      setRevision((prev) => ({
        workspaceId,
        count: prev.workspaceId === workspaceId ? prev.count + 1 : 1,
      }));
    const offFileChanged = bus.subscribe('file-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      // A text save must not revalidate every screenshot on the page.
      if (!isImagePath(event.path)) return;
      bump();
    });
    // A folder delete, a rename, a sync of many paths: the backend announces
    // those as one tree change and names no file, so every image may be stale.
    const offTreeChanged = bus.subscribe('fs-tree-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      bump();
    });
    return () => {
      offFileChanged();
      offTreeChanged();
    };
  }, [bus, workspaceId]);

  return revision.workspaceId === workspaceId ? revision.count : 0;
}
