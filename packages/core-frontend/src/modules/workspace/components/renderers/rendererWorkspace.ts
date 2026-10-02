import { createContext, useContext } from 'react';
import { WorkspaceContext } from '../../state/workspace.context';

/**
 * A PAST SAVE the renderers should read instead of the working tree.
 *
 * Version history shows a file as it was after one particular save, in the
 * very viewer the file page uses. A viewer only ever asks two things of its
 * surroundings — which workspace, which path — so pointing it at a past
 * version is one more coordinate on the same question rather than a second
 * kind of viewer: the byte-reading renderers pass this straight to
 * `rawFileUrl`, and the backend serves `git show <ref>:<path>` under the
 * file's own read gate.
 *
 * `side: 'before'` reads `<sha>^`, which is what the save that DELETED a file
 * has to show — there is nothing at that path after such a save.
 */
export interface RendererFileRef {
  /** The save, as a commit sha. */
  ref: string;
  /** Which side of that save. Defaults to `'after'`. */
  side?: 'after' | 'before';
}

/**
 * The workspace a renderer should fetch its bytes from, when that is NOT the
 * workspace the app has checked out — and, optionally, the past save within
 * it.
 *
 * Every viewer here reads the file itself — `rawFileUrl(workspaceId, path)` —
 * rather than the text buffer, and until now `workspaceId` could only be the
 * one the user is browsing. The change-request dialog needs the same viewers
 * pointed at a DIFFERENT branch's workspace (the request's), so it provides
 * this override around them; Version history needs them pointed at a past
 * save of THIS workspace, which is `fileRef`.
 *
 * A narrow context on purpose: `workspaceId` (and now the save) is the only
 * thing any renderer takes from the workspace, and standing up a whole
 * `WorkspaceContextValue` (forty methods that mutate a working tree neither
 * pane must ever touch) to pass one string would be a lie about what the pane
 * can do.
 */
export const RendererWorkspaceContext = createContext<{
  workspaceId: string | null;
  /** A past save to read instead of the working tree; omitted = the tree. */
  fileRef?: RendererFileRef | null;
} | null>(null);

/**
 * The workspace id the renderer should read from: the override when one is
 * provided, otherwise the checked-out workspace.
 *
 * Throws when neither is present, exactly as `useWorkspace()` did — a renderer
 * with no workspace at all would otherwise sit on "Loading…" forever.
 */
export function useRendererWorkspaceId(): string | null {
  const override = useContext(RendererWorkspaceContext);
  const workspace = useContext(WorkspaceContext);
  if (override !== null) return override.workspaceId;
  if (workspace === null) {
    throw new Error(
      'useRendererWorkspaceId must be used within WorkspaceContext.Provider or RendererWorkspaceContext.Provider',
    );
  }
  return workspace.workspaceId;
}

/**
 * The past save this renderer is bound to, or `null` for the working tree.
 *
 * Never throws and needs no provider: reading the working tree is the answer
 * for every surface that has not asked for a version, which is all of them
 * except Version history.
 *
 * Renderers spread the two FIELDS into their effect dependencies rather than
 * this object, so a provider that rebuilds its context value on an unrelated
 * render cannot re-trigger a read.
 */
export function useRendererFileRef(): RendererFileRef | null {
  return useContext(RendererWorkspaceContext)?.fileRef ?? null;
}
