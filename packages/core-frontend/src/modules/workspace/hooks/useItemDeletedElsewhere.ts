import { useContext, useEffect, useState } from 'react';
import { useLatestRef } from '../../../shared/components';
import { canonicalizeWorkspaceId, useEventBus } from '../../workflow/state/event-bus.context';
import { readFile, WorkspaceApiError } from '../services/workspace.api';
import { WorkspaceContext } from '../state/workspace.context';
import type { DeletedBy } from '../components/DeletedFileNotice';

/**
 * Whether someone else deleted the item a page shows, and who — for the pages
 * that render a file WITHOUT an open tab: a skill's page and a tool's page in
 * Skills & Tools. The Knowledge file page learns the same thing through its
 * tab (`OpenTab.deletedBy`); this is that rule for a page with no tab, so both
 * apps' viewers can show the one `DeletedFileNotice`.
 *
 * `itemPath` is the item's workspace path (a skill's folder, a tool's file),
 * `keyFile` the file whose absence means the item is gone (a skill's
 * `SKILL.md`, the tool's own file). A `file-changed` at or under `itemPath`, or
 * an `fs-tree-changed` (a folder delete past the per-file event cap), re-reads
 * `keyFile`; only a 404 is a delete, and a later successful read (the item
 * came back) clears it. The name is the event's person; a pull from the git
 * host (the `system` user) and a tree-wide event name nobody.
 *
 * Never this person's own delete: a path this session is deleting
 * (`isPendingDelete`) is skipped, and `suppressed` lets a page skip while its
 * own delete dialog runs — that dialog lands the page somewhere else.
 *
 * The workspace is WATCHED for as long as the page is mounted: the Library
 * renders the default branch while the session may be focused on another.
 */
export function useItemDeletedElsewhere({
  workspaceId,
  itemPath,
  keyFile,
  suppressed = false,
}: {
  workspaceId: string | null;
  itemPath: string | null;
  keyFile: string | null;
  suppressed?: boolean;
}): DeletedBy | null {
  const bus = useEventBus();
  // Read softly: a tool page may be mounted with no workspace around it.
  const isPendingDelete = useContext(WorkspaceContext)?.isPendingDelete;
  const isPendingDeleteRef = useLatestRef(isPendingDelete);
  const suppressedRef = useLatestRef(suppressed);
  const key = workspaceId && itemPath && keyFile ? `${workspaceId}\n${keyFile}` : null;
  // Stored WITH the item it is about, so another item reads as not deleted.
  const [deleted, setDeleted] = useState<{ key: string; by: DeletedBy } | null>(null);

  useEffect(() => {
    if (!bus || !workspaceId || !itemPath || !keyFile || !key) return;
    const release = bus.watchWorkspace(workspaceId);
    const subscribedCanon = canonicalizeWorkspaceId(workspaceId);
    let cancelled = false;
    // One read at a time: a folder delete sends one event per file, and they
    // all ask the same question. Events during a read ask once more after it.
    let inFlight = false;
    let again = false;
    let pendingName: string | null = null;

    const check = (name: string | null) => {
      if (inFlight) {
        again = true;
        pendingName = pendingName ?? name;
        return;
      }
      inFlight = true;
      readFile(workspaceId, keyFile)
        .then(
          () => {
            if (!cancelled) setDeleted((prev) => (prev?.key === key ? null : prev));
          },
          (err) => {
            if (cancelled) return;
            if (!(err instanceof WorkspaceApiError && err.status === 404)) return;
            if (suppressedRef.current || isPendingDeleteRef.current?.(keyFile)) return;
            // The first answer that names someone is the delete; later ones
            // do not rename who did it.
            setDeleted((prev) =>
              prev?.key === key && (prev.by.name !== null || name === null)
                ? prev
                : { key, by: { name, at: prev?.key === key ? prev.by.at : Date.now() } },
            );
          },
        )
        .finally(() => {
          inFlight = false;
          if (cancelled || !again) return;
          again = false;
          const next = pendingName;
          pendingName = null;
          check(next);
        });
    };

    const offFileChanged = bus.subscribe('file-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      if (event.path !== itemPath && !event.path.startsWith(`${itemPath}/`)) return;
      check(event.byUserId === 'system' || !event.byUserName ? null : event.byUserName);
    });
    const offTreeChanged = bus.subscribe('fs-tree-changed', (event) => {
      if (canonicalizeWorkspaceId(event.workspaceId) !== subscribedCanon) return;
      check(null);
    });
    return () => {
      cancelled = true;
      offFileChanged();
      offTreeChanged();
      release();
    };
  }, [bus, workspaceId, itemPath, keyFile, key, isPendingDeleteRef, suppressedRef]);

  return deleted && deleted.key === key ? deleted.by : null;
}
