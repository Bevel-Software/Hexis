import { useCallback, useEffect, useRef, useState } from 'react';
import type { PullRequestFile } from '@bevel-software/platform-shared';
import { getOrCreateWorkspace } from '../../workspace/services/workspace.api';
import { fileExistsOnWorkspace, readFileAtCommit } from '../services/change-requests.api';
import { describeReadFailure } from '../services/denied-file.api';
import type { ReadFailure } from '../utils/readFailure';

/**
 * One file of an APPLIED change request, as it was applied.
 *
 * The request's draft branch is removed by the apply, so nothing is read
 * from it (that read is the "HTTP 410" this replaces). Instead both sides
 * come from the request's own merge commit on the branch it was applied to:
 * the commit for "after", its first parent — the target just before the
 * apply — for "before", a rename reading its OLD path there. Both reads go
 * through the raw route's read gate, so a file the viewer may not read is
 * refused exactly as on an open request, and shows locked.
 *
 * With no merge commit of its own (`appliedSha` null: the target already held
 * everything) there is nothing to read as applied, and only the question
 * below is asked.
 *
 * Plus one question about today: is the page still on the target branch?
 * That decides between "Open page" and "This page has since been deleted."
 * A file the request itself deleted asks nothing of the kind.
 *
 * Lazy: only the file on screen is read, once; a settled answer is kept per
 * path so the tree's locks stay on files the reader has moved past.
 */
export interface AppliedFileRead {
  /** Both reads (and the existence check) settled. */
  loaded: boolean;
  /** The file just before the apply; `null` when the request added it. */
  before: string | null;
  /** The file as the apply left it; `null` when the request deleted it. */
  after: string | null;
  /** Why it could not be read; `null` when it could. */
  failure: ReadFailure | null;
  /**
   * The page on the target branch now: its workspace path when it is there,
   * `'deleted'` when it has since been deleted, `null` when not asked (a
   * file the request deleted, or one that could not be read).
   */
  pageNow: { workspacePath: string } | 'deleted' | null;
}

const PENDING: AppliedFileRead = {
  loaded: false,
  before: null,
  after: null,
  failure: null,
  pageNow: null,
};

export function useAppliedFile(
  appliedSha: string | null,
  file: PullRequestFile | undefined,
  targetBranch: string,
  opts: { readText: boolean },
): {
  read: AppliedFileRead | null;
  failureOf(path: string): ReadFailure | undefined;
  retry(path: string): void;
} {
  const [settled, setSettled] = useState<ReadonlyMap<string, AppliedFileRead>>(new Map());
  const [revision, setRevision] = useState(0);
  // In-flight guard as a ref: asking again for a path already asked is a
  // no-op, without a render to record the asking.
  const asked = useRef<Map<string, object>>(new Map());
  const keyOf = useCallback((path: string) => `${appliedSha ?? ''}::${path}`, [appliedSha]);
  const path = file?.path ?? '';
  const key = keyOf(path);
  const status = file?.status;
  const previousPath = file?.previousPath;
  const { readText } = opts;

  useEffect(() => {
    if (!path || asked.current.has(key)) return;
    const token = {};
    asked.current.set(key, token);
    const land = (read: AppliedFileRead) => {
      if (asked.current.get(key) !== token) return;
      setSettled((m) => new Map(m).set(key, read));
    };
    const added = status === 'added';
    const removed = status === 'removed';
    void (async () => {
      try {
        const { workspace } = await getOrCreateWorkspace(targetBranch);
        const at = (p: string) => `${workspace.kbDirName}/${p}`;
        // No merge commit of its own: nothing to read "as applied" — only
        // whether the page is still there (which is also the read gate).
        const sha = appliedSha;
        const [before, after] = readText && sha
          ? await Promise.all([
              added
                ? Promise.resolve(null)
                : readFileAtCommit(workspace.id, at(previousPath || path), sha, 'before'),
              removed
                ? Promise.resolve(null)
                : readFileAtCommit(workspace.id, at(path), sha, 'after'),
            ])
          : [null, null];
        const pageNow: AppliedFileRead['pageNow'] = removed
          ? null
          : (await fileExistsOnWorkspace(workspace.id, at(path)))
            ? { workspacePath: at(path) }
            : 'deleted';
        land({ loaded: true, before, after, failure: null, pageNow });
      } catch (err) {
        const failure = await describeReadFailure(err, targetBranch, path);
        land({ ...PENDING, loaded: true, failure });
      }
    })();
  }, [appliedSha, path, key, status, previousPath, targetBranch, readText, revision]);

  const failureOf = useCallback(
    (p: string) => settled.get(keyOf(p))?.failure ?? undefined,
    [settled, keyOf],
  );

  /** Forget a path's answer and read it again — the failure sentence's "Try again". */
  const retry = useCallback(
    (p: string) => {
      const k = keyOf(p);
      asked.current.delete(k);
      setSettled((m) => {
        const next = new Map(m);
        next.delete(k);
        return next;
      });
      setRevision((r) => r + 1);
    },
    [keyOf],
  );

  const read = !path ? null : (settled.get(key) ?? PENDING);
  return { read, failureOf, retry };
}
