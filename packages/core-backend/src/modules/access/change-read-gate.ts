/**
 * Read-before-write: the gate every change passes on its way to the lock
 * (`WorkflowService.acquireLock`), on every branch. Contract and rationale in
 * `access-model/change-gate.ts`; this is the service that answers.
 *
 * The verdict is taken against the WORKING TREE, not `HEAD` as the write gate
 * does. That is deliberate. The creator grant a new top-level folder gets is
 * seeded into its `access.md` in a lock+commit cycle of its own and the
 * commit lands from a background queue, so the first file written into that
 * folder would find `HEAD` without the grant and be refused. The working
 * tree has it at once. The self-grant a `HEAD` reading guards against does
 * not open here: a person can only edit an `access.md` they may write, that
 * write is itself gated, and on a draft the edit reaches a shared branch
 * only through a change request that shows it.
 */

import path from 'node:path';
import { creatableRootDirNames } from '@bevel-software/platform-shared';
import type { IFsProbe } from '../../shared/fs.contract.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from './access-control.interface.js';
import { AccessConfigError, AccessDeniedError } from '../access-model/access-errors.js';
import { SYNCED_GROUPS_YAML } from '../access-model/group-files.js';
import { toKbRelative } from '../access-model/kb-read-filter.js';
import type { ChangeReadVerdict, ChangeTargetKind, IChangeReadGate } from '../access-model/change-gate.js';

/**
 * Whether `kbRel` (repo-relative) is, or lies inside, a folder directly under
 * one of the three roots that does not exist yet — the read-before-write
 * exception. Pure over `exists`, so the rule can be read and tested on its
 * own; the service supplies the disk.
 *
 * A `'dir'` target is the folder itself (`Skills/new-skill`); a `'file'`
 * target must lie INSIDE the new folder (`Skills/new-skill/SKILL.md`,
 * `Plugins/team/access.md`): a loose file directly at a root has no folder
 * to carry a creator grant and is not excepted.
 */
export async function isNewTopLevelFolderPath(
  kbRel: string,
  kind: ChangeTargetKind,
  exists: (kbRel: string) => Promise<boolean>,
): Promise<boolean> {
  const segments = kbRel.split('/');
  const root = segments[0];
  if (root === undefined || !creatableRootDirNames().has(root)) return false;
  if (segments.length < (kind === 'dir' ? 2 : 3)) return false;
  return !(await exists(`${root}/${segments[1]}`));
}

export class ChangeReadGate implements IChangeReadGate {
  constructor(
    private readonly workspaceService: Pick<WorkspaceService, 'getWorkspacePath'>,
    private readonly accessControl: Pick<IAccessControl, 'canRead' | 'holdsAdminRootWrite'>,
    private readonly kbDirName: string,
    private readonly disk: IFsProbe,
  ) {}

  async judge(
    workspaceId: string,
    userEmail: string,
    wsPath: string,
    kind: ChangeTargetKind,
  ): Promise<ChangeReadVerdict> {
    // A FOLDER target may be the repository root itself (the KB clone's own
    // folder, which `toKbRelative` reads as "outside": no file lives there
    // without rules). As a folder it is the root scope, `''`, and is judged
    // like any other folder — an extraction into it is an extraction into
    // whatever the root grants.
    const norm = wsPath.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    const rel = kind === 'dir' && norm === this.kbDirName ? '' : toKbRelative(wsPath, this.kbDirName);
    if (rel === null) return { allowed: true, via: 'outside-kb' };

    const exists = (p: string) => this.exists(workspaceId, p);
    try {
      // The two rescues the write rule already has, for FILE targets only —
      // both name files, and a folder target is never one of them.
      if (kind === 'file') {
        // The directory-sync bot's file: its writer is named by the write
        // rule (`machineOwnedWriteRule`), and read rules never name a machine.
        if (rel === SYNCED_GROUPS_YAML) return { allowed: true, via: 'machine-owned' };
        // The admin rescue, in the same shape the write floor has it: an
        // admin holds write on the repository root's own files (`roles.yaml`,
        // `access.md`, `groups.yaml`, the agent guide, …) whatever the root rules
        // say, so that a tree whose root grants nobody can still be repaired
        // from inside the app. A subfolder's `access.md` is an ordinary path:
        // an admin who cannot read the folder cannot change it either.
        if (!rel.includes('/') && (await this.accessControl.holdsAdminRootWrite(workspaceId, userEmail))) {
          return { allowed: true, via: 'admin-rescue' };
        }
      }
      if (await isNewTopLevelFolderPath(rel, kind, exists)) {
        return { allowed: true, via: 'new-top-level-folder' };
      }
      if (await this.accessControl.canRead(workspaceId, userEmail, rel)) {
        return { allowed: true, via: 'readable' };
      }
    } catch (err) {
      // No config on this tree at all (a repository before its first
      // `roles.yaml`): the write gate treats the same state as "nothing to
      // decide against" and so does this one. A `roles.yaml` that is THERE
      // but unusable is a different thing — a broken rule set must not read
      // as an open door — and propagates, as does any other failure: a
      // verdict from a half-read tree is not a verdict.
      if (err instanceof AccessConfigError && !(await exists('roles.yaml'))) {
        return { allowed: true, via: 'no-rules' };
      }
      throw err;
    }
    return { allowed: false, unreadable: await this.unreadablePlace(rel, exists) };
  }

  async assertMayChange(
    workspaceId: string,
    userEmail: string,
    wsPath: string,
    kind: ChangeTargetKind,
  ): Promise<void> {
    const verdict = await this.judge(workspaceId, userEmail, wsPath, kind);
    if (verdict.allowed) return;
    throw new AccessDeniedError({
      path: wsPath,
      eligibleRoles: [],
      eligibleUsers: [],
      unreadable: verdict.unreadable,
    });
  }

  /**
   * What to name in the refusal: the target when it is there (a change to
   * something the caller cannot see), otherwise the folder the new thing
   * would land in — the place whose rules decided.
   */
  private async unreadablePlace(rel: string, exists: (p: string) => Promise<boolean>): Promise<string> {
    if (await exists(rel)) return rel;
    const parent = path.posix.dirname(rel);
    return parent === '.' ? '' : parent;
  }

  /**
   * Whether something is at the repo-relative `rel` on this workspace's disk.
   * Links are NOT followed: a link, dangling or not, is something there — a
   * folder it stands in for is not "new", and no exception is read through it.
   */
  private async exists(workspaceId: string, rel: string): Promise<boolean> {
    const wsDir = await this.workspaceService.getWorkspacePath(workspaceId);
    return (await this.disk.lstatOrNull(path.join(wsDir, this.kbDirName, rel))) !== null;
  }
}
