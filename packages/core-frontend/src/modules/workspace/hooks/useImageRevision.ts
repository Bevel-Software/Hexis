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
 * design, and it had two holes with one cause: it carried counters across a
 * workspace switch, and it grew for the life of the tab. A single revision
 * cannot express either: a switch starts at 0, and there is nothing to evict.
 * The cost is that one changed image revalidates every image on the page;
 * with `Cache-Control: private, no-cache` and the ETag Express sets, each of
 * those is a 304 with no bytes.
 *
 * Only `file-changed` feeds it, never `fs-tree-changed`. The tree event names
 * no file and follows EVERY write (`withLock` in `workspace.routes.ts` emits
 * it after each save, text or image), so it would revalidate every screenshot
 * on each text save and bump twice on an image save. The per-file event is
 * enough: a folder delete, a move, a bulk upload and a sync each announce the
 * paths they touched one `file-changed` at a time (the sync up to its cap),
 * and where the backend sends the tree event alone (a plugin install, a sync
 * past the cap) the document's text is as stale as its pictures, and the same
 * reload fixes both.
 *
 * `fsRevision` is not this signal: it is bumped by the local user's own
 * mutations, never by the SSE handler, and every bump re-polls git status.
 *
 * Views of another revision than the checked-out tree (the change-request
 * dialog, the file history) do not use it: they show no live image at all.
 *
 * The hook also WATCHES `workspaceId` on the bus for as long as it is mounted,
 * so the events it counts are actually delivered even when that workspace is
 * not the one the session is focused on. See `watchWorkspace`.
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
    // ASK FOR THE EVENTS, don't assume they arrive. The SSE stream delivers
    // workspace-scoped events for the workspaces the session has declared, and
    // the focus binder declares exactly one: the branch in the address bar.
    // Every caller that resolves images from ANOTHER workspace — the skill
    // page, which renders the default branch's files while the reader stands
    // on their own suggestion branch — was therefore counting an event that
    // could never arrive, and its images stayed stale for as long as the tab
    // was open. Watching here rather than at the call site means a resolver
    // cannot forget: the hook that needs the events is the one that requests
    // them, and it releases on unmount.
    const release = bus.watchWorkspace(workspaceId);
    // Canonicalise once: the event carries the decoded branch, local state the
    // encoded one. See `canonicalizeWorkspaceId`.
    const subscribedCanon = canonicalizeWorkspaceId(workspaceId);
    const unsubscribe = bus.subscribe('file-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      // A text save must not revalidate every screenshot on the page.
      if (!isImagePath(event.path)) return;
      setRevision((prev) => ({
        workspaceId,
        count: prev.workspaceId === workspaceId ? prev.count + 1 : 1,
      }));
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [bus, workspaceId]);

  return revision.workspaceId === workspaceId ? revision.count : 0;
}
