import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useLatestRef } from '../../../shared/components';

/**
 * The gate the tree puts in front of anything that would land where its
 * creator cannot see it. Why that happens at all is in
 * `../utils/unreadableCreate.ts`; the dialog that asks is
 * `../components/UnreadableCreateConfirm.tsx`.
 *
 * One gate serves the new-file box, the drop targets and the upload buttons,
 * which is what makes "once per batch" true: every entry point hands the
 * whole batch to the SAME call and awaits one answer.
 */

/** One pending question: what would be invisible, and where. */
export interface UnreadableCreateRequest {
  /** The affected file names, in the order they were given. */
  names: string[];
  /** Repo-relative target folder; `''` is the KB root. */
  folder: string;
}

/**
 * Ask before adding `names` to `folder`. Resolves TRUE when the creation may
 * go ahead — because nothing would be hidden, because the question could not
 * be answered, or because the user pressed Continue — and FALSE only on an
 * explicit Cancel, where the caller must create nothing at all.
 *
 * `folder` is WORKSPACE-relative (what the tree holds); the gate converts it.
 */
export type UnreadableCreateGate = (folder: string, names: string[]) => Promise<boolean>;

/** No chrome around the tree (a bare `FileTreeNode` in a test) never asks. */
const ALWAYS_ALLOW: UnreadableCreateGate = async () => true;

export const UnreadableCreateContext = createContext<UnreadableCreateGate>(ALWAYS_ALLOW);

export const useUnreadableCreateGate = () => useContext(UnreadableCreateContext);

/**
 * The gate's state, for the chrome that owns it: the `gate` to hand down, the
 * request the dialog should be rendering, and the answer to that request.
 *
 * `canRead` is the caller's read verdict for a repo-relative folder, asked of
 * the server — never guessed from the tree. The tree cannot answer it: it
 * shows the folders a user can see, and the question is about one they
 * cannot. A lookup that throws resolves the gate TRUE — the warning is a
 * courtesy, and no courtesy is worth blocking a creation the server would
 * have accepted.
 */
export function useUnreadableCreateGateState(opts: {
  /** Strips the workspace-relative prefix; null for a path outside the KB. */
  toRepoRelative(workspaceRelativeFolder: string): string | null;
  canRead(repoRelativeFolder: string): Promise<boolean>;
}): {
  gate: UnreadableCreateGate;
  pending: UnreadableCreateRequest | null;
  answer(ok: boolean): void;
} {
  const [pending, setPending] = useState<
    (UnreadableCreateRequest & { resolve(ok: boolean): void }) | null
  >(null);
  // The options object is rebuilt every render by its caller; reading it
  // through a ref keeps `gate` stable, so the handlers holding it do not
  // churn. Only ever read from `gate`, which runs from an event handler.
  const optsRef = useLatestRef(opts);
  // A dialog still open when the tree unmounts must not leave its caller's
  // promise pending forever — that would strand an upload half-dispatched.
  const pendingRef = useLatestRef(pending);
  useEffect(
    () => () => {
      pendingRef.current?.resolve(false);
    },
    [pendingRef],
  );

  const gate = useCallback<UnreadableCreateGate>(
    async (folder, names) => {
      if (names.length === 0) return true;
      const repoRelative = optsRef.current.toRepoRelative(folder);
      // Outside the KB repo there is no access model and nothing to hide from.
      if (repoRelative === null) return true;
      try {
        if (await optsRef.current.canRead(repoRelative)) return true;
      } catch (err) {
        console.warn('[FileExplorer] read check before create failed:', err);
        return true;
      }
      return new Promise<boolean>((resolve) => {
        setPending({ names, folder: repoRelative, resolve });
      });
    },
    [optsRef],
  );

  const answer = useCallback((ok: boolean) => {
    setPending((open) => {
      open?.resolve(ok);
      return null;
    });
  }, []);

  return { gate, pending, answer };
}
