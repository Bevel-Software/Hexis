import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
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
  /**
   * The tree this question is being asked in — the workspace id, which
   * encodes the branch. A question outlives nothing: switching branch or
   * workspace answers the open one FALSE, because the folder it names, the
   * read verdict behind it and the upload waiting on it all belonged to the
   * tree that is gone. The same stamping the move/delete confirmation uses.
   */
  identity: string | null;
  /** Strips the workspace-relative prefix; null for a path outside the KB. */
  toRepoRelative(workspaceRelativeFolder: string): string | null;
  canRead(repoRelativeFolder: string): Promise<boolean>;
}): {
  gate: UnreadableCreateGate;
  pending: UnreadableCreateRequest | null;
  answer(ok: boolean): void;
} {
  const [pending, setPending] = useState<
    (UnreadableCreateRequest & { identity: string | null; resolve(ok: boolean): void }) | null
  >(null);
  // The options object is rebuilt every render by its caller; reading it
  // through a ref keeps `gate` stable, so the handlers holding it do not
  // churn. Only ever read from `gate`, which runs from an event handler.
  const optsRef = useLatestRef(opts);
  // A dialog still open when the tree unmounts must not leave its caller's
  // promise pending forever — that would strand an upload half-dispatched.
  // `alive` covers the other half of the same hazard: a gate still awaiting
  // its read check when the tree goes has no dialog to open and nobody left
  // to press a button, so it must answer rather than hang.
  const pendingRef = useLatestRef(pending);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingRef.current?.resolve(false);
    };
  }, [pendingRef]);

  const { identity } = opts;
  useEffect(() => {
    // Dropped outright, so switching back does not bring it back either —
    // its promise is answered here and could not be answered twice.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the question is gone, and its caller is waiting for exactly this
    setPending((open) => {
      if (!open || open.identity === identity) return open;
      open.resolve(false);
      return null;
    });
  }, [identity]);

  const gate = useCallback<UnreadableCreateGate>(
    async (folder, names) => {
      if (names.length === 0) return true;
      const asked = optsRef.current.identity;
      const repoRelative = optsRef.current.toRepoRelative(folder);
      // Outside the KB repo there is no access model and nothing to hide from.
      if (repoRelative === null) return true;
      try {
        if (await optsRef.current.canRead(repoRelative)) return true;
      } catch (err) {
        console.warn('[FileExplorer] read check before create failed:', err);
        return true;
      }
      // The check is a round trip; the tree can be gone, or showing another
      // branch, by the time it answers. Either way there is no question left
      // to ask, so the batch is dropped rather than created unannounced.
      if (!alive.current || optsRef.current.identity !== asked) return false;
      return new Promise<boolean>((resolve) => {
        setPending((open) => {
          // A question already open is SUPERSEDED, not stranded: a second
          // gate-passing action resolves the first one false, so its batch
          // creates nothing instead of waiting on a dialog it lost.
          open?.resolve(false);
          return { names, folder: repoRelative, identity: asked, resolve };
        });
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
