import { AccessDeniedError } from './access-errors.js';
import type { ChangeTargetKind, IChangeReadGate } from './change-gate.js';

/**
 * The refusal of a write that the write rule refused at `HEAD`, one answer
 * for the two places that give it: the lock's gate
 * (`VersionControlService.acquireLock`) and the write tools' preflight, which
 * refuses before any lock is asked for.
 *
 * Read first: a caller who may not read `wsPath` gets the read-before-write
 * gate's refusal, and not who may write the path, because the writers a
 * file's own entries name would say the file is there. Otherwise the refusal
 * names who may write `repoRelative` at `HEAD`, the path the caller asked the
 * write rule about. Null names no one.
 *
 * `kind` is what `wsPath` is. It is the question put to the read gate and the
 * `targetKind` the refusal carries. The lock passes `'file'`, because a lock
 * is always taken on a file; the tools pass `'dir'` for a folder they judged.
 *
 * `changeGate` is optional because the write tools take it as optional
 * (`registerWorkspaceTools`). Without one the read is not asked and the
 * refusal names the writers. The lock always passes one.
 *
 * Returned, not thrown, so each caller throws it from its own flow.
 */
export async function unwritableRefusal(
  gates: {
    accessControl: {
      eligibleWritersAtRef(
        workspaceId: string,
        ref: string,
        relativePath: string,
      ): Promise<{ roles: string[]; users: { name: string; email: string }[] } | null>;
    };
    changeGate?: IChangeReadGate;
  },
  workspaceId: string,
  userEmail: string,
  target: { wsPath: string; repoRelative: string | null; kind: ChangeTargetKind },
): Promise<AccessDeniedError> {
  const { wsPath, repoRelative, kind } = target;
  if (gates.changeGate) {
    const verdict = await gates.changeGate.judge(workspaceId, userEmail, wsPath, kind);
    if (!verdict.allowed) {
      return new AccessDeniedError({
        path: wsPath,
        eligibleRoles: [],
        eligibleUsers: [],
        unreadable: verdict.unreadable,
        targetKind: kind,
      });
    }
  }
  const eligible =
    repoRelative === null ? null : await gates.accessControl.eligibleWritersAtRef(workspaceId, 'HEAD', repoRelative);
  return new AccessDeniedError({
    path: wsPath,
    eligibleRoles: eligible?.roles ?? [],
    eligibleUsers: eligible?.users ?? [],
    targetKind: kind,
  });
}
