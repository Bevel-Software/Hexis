import { createContext, useContext } from 'react';
import { WorkspaceContext } from '../../state/workspace.context';

/**
 * The workspace a renderer should fetch its bytes from, when that is NOT the
 * workspace the app has checked out.
 *
 * Every viewer here reads the file itself — `rawFileUrl(workspaceId, path)` —
 * rather than the text buffer, and until now `workspaceId` could only be the
 * one the user is browsing. The change-request dialog needs the same viewers
 * pointed at a DIFFERENT branch's workspace (the request's), so it provides
 * this override around them.
 *
 * A narrow context on purpose: `workspaceId` is the only thing any renderer
 * takes from the workspace, and standing up a whole `WorkspaceContextValue`
 * (forty methods that mutate a working tree the dialog must never touch) to
 * pass one string would be a lie about what the pane can do.
 */
export const RendererWorkspaceContext = createContext<{ workspaceId: string | null } | null>(
  null,
);

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
