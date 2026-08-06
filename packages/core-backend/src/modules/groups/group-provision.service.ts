/**
 * Group provisioning — the ONE privileged door for bringing a `Groups/<name>/`
 * folder into existence.
 *
 * Creating a group is the single operation the access model cannot govern
 * from inside: the folder that will carry the rules does not exist yet, and
 * the root's own rule (`write: Admin`) says no. The old answer was a
 * carve-out inside the generic write gate — every write path could claim an
 * unused name under `Groups/`, and the gate had to re-derive "is this that
 * one blessed case?" on every check. This service replaces that: the generic
 * gate is uniformly strict again, and the privilege lives here, named,
 * behind its own endpoint.
 *
 * What a provision IS: one exclusive write of the new folder's `access.md`
 * (flag `wx`, so two concurrent creators race for the fs, not for the
 * overwrite), then one SYNCHRONOUS commit+push. Synchronous on purpose — the
 * write gate reads rules at HEAD, so a creation whose access.md were still
 * sitting in the async commit queue would 403 the very next thing its
 * creator does (writing the first skill into it).
 *
 * Two shapes, two templates:
 *
 *   - A NAMED group: discoverable by design. The access.md's own frontmatter
 *     reads `everyone` — anyone may open the FILE, see the group listed, and
 *     ask to join — while the BODY (the folder's actual rules) names only
 *     the creator under read, write and owner.
 *   - A PERSONAL folder (`personal-<user-id>`): private by design. No
 *     frontmatter grant at all, so nobody else can even see it exists; the
 *     body names its owner. Created lazily (ensure semantics) on the first
 *     personal skill.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_BRANCH,
  GROUPS_DIR,
  PERSONAL_GROUP_PREFIX,
  personalGroupFolderName,
  type AuthUser,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { creatorPrincipal } from '../access/creator-access.js';
import { spliceGrant } from '../access/access-splice.js';

/** Commit machinery the provision rides — the pending-commit pipeline, run inline. */
export interface ProvisionCommitDriver {
  runPendingCommit(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
  ): Promise<void>;
}

export interface ProvisionedGroup {
  /** The folder name under `Groups/` (not the full path). */
  folder: string;
  /** False when an ensure found the folder already there. */
  created: boolean;
}

/** A refusal the route can pass through: message + HTTP status. */
export class GroupProvisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GroupProvisionError';
  }
}

export class GroupProvisionService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly commits: ProvisionCommitDriver,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    private readonly events?: { emit(event: { kind: 'fs-tree-changed'; workspaceId: string; branch: string }): void },
  ) {}

  /**
   * Create `Groups/<name>/` for `user`. Throws `GroupProvisionError` 422 on a
   * name the filesystem or the model cannot carry, 409 when the name is taken
   * (case-insensitively — the workspaces live on case-insensitive
   * filesystems too, where `GTM` and `gtm` are one folder).
   */
  async createGroup(user: AuthUser, rawName: string): Promise<ProvisionedGroup> {
    const name = rawName.trim();
    if (!name) throw new GroupProvisionError('A group needs a name.', 422);
    if (/[/\\]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
      throw new GroupProvisionError(
        'A group name can\'t contain / or \\, or start with a dot.',
        422,
      );
    }
    if (name.toLowerCase().startsWith(PERSONAL_GROUP_PREFIX)) {
      // Reserved: the personal-folder namespace. A group squatting there
      // would collide with somebody's future personal folder.
      throw new GroupProvisionError(
        `Group names starting with "${PERSONAL_GROUP_PREFIX}" are reserved.`,
        422,
      );
    }
    const existing = await this.existingFolder(name);
    if (existing !== null) {
      throw new GroupProvisionError(`A group named "${existing}" already exists.`, 409);
    }
    await this.provision(user, name, groupAccessMd(user));
    return { folder: name, created: true };
  }

  /**
   * Ensure the caller's personal folder exists — idempotent, keyed to the
   * stable user id. Returns `created: false` when it is already there.
   */
  async ensurePersonalGroup(user: AuthUser): Promise<ProvisionedGroup> {
    const folder = personalGroupFolderName(user.id);
    if ((await this.existingFolder(folder)) !== null) {
      return { folder, created: false };
    }
    await this.provision(user, folder, personalAccessMd(user));
    return { folder, created: true };
  }

  /** The taken name (in its on-disk casing) colliding with `name`, or null. */
  private async existingFolder(name: string): Promise<string | null> {
    const wsId = await this.readyWorkspaceId();
    const wsDir = await this.workspaceService.getWorkspacePath(wsId);
    let children: string[];
    try {
      children = await fs.readdir(path.join(wsDir, this.kbDirName, GROUPS_DIR));
    } catch {
      return null; // no Groups/ root yet — nothing can collide
    }
    const lower = name.toLowerCase();
    return children.find((c) => c.toLowerCase() === lower) ?? null;
  }

  private async provision(user: AuthUser, folder: string, accessMd: string): Promise<void> {
    const wsId = await this.readyWorkspaceId();
    const wsRelPath = `${this.kbDirName}/${GROUPS_DIR}/${folder}/access.md`;
    try {
      // Exclusive create — the fs is the arbiter of a same-name race, not
      // the (stale-able) existence check above.
      await this.workspaceService.writeFile(wsId, wsRelPath, accessMd, { failIfExists: true });
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        throw new GroupProvisionError(`A group named "${folder}" already exists.`, 409);
      }
      throw err;
    }
    try {
      // Inline, not enqueued: the gate reads rules at HEAD, so the folder is
      // only real once this commit lands. `runPendingCommit` is the same
      // commit+push (with pull-rebase recovery) the queue worker runs.
      await this.commits.runPendingCommit(wsId, DEFAULT_BRANCH, wsRelPath, user);
    } catch (err) {
      // The commit did not land: roll the seeded file back off the disk,
      // best-effort, so a retry doesn't find a half-made group and report
      // "already exists" for something that never got committed. Only OUR
      // file and — when that leaves it empty — the folder; never recursive,
      // so a concurrent writer's bytes can't be collateral.
      try {
        const wsDir = await this.workspaceService.getWorkspacePath(wsId);
        const folderDir = path.join(wsDir, this.kbDirName, GROUPS_DIR, folder);
        await fs.rm(path.join(folderDir, 'access.md'), { force: true });
        await fs.rmdir(folderDir).catch(() => {});
      } catch {
        /* leave it for the next attempt's wx conflict — better than masking the real error */
      }
      throw err;
    }
    // The folder's rules changed the access model — drop the resolver cache
    // so the very next check (the creator's first skill write) sees them.
    this.accessControl.invalidate(wsId);
    this.events?.emit({ kind: 'fs-tree-changed', workspaceId: wsId, branch: DEFAULT_BRANCH });
  }

  private async readyWorkspaceId(): Promise<string> {
    const ws = await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH);
    return ws.id;
  }
}

/**
 * A named group's access.md: discoverable file (frontmatter `read: everyone`
 * — anyone may see the group listed and ask to join), creator-run folder
 * (body read/write/owner name the creator). The `read: []` placeholder makes
 * the body parse as rules from the first byte, so every later splice targets
 * the body rather than the frontmatter.
 */
export function groupAccessMd(creator: { name: string; email: string }): string {
  return withCreatorGrants('---\nread:\n  - everyone\n---\nread: []\n', creator);
}

/**
 * A personal folder's access.md: PRIVATE — no frontmatter grant, so the
 * folder is invisible to everyone but its owner; the body names the owner
 * under read, write and owner.
 */
export function personalAccessMd(creator: { name: string; email: string }): string {
  return withCreatorGrants('read: []\n', creator);
}

function withCreatorGrants(base: string, creator: { name: string; email: string }): string {
  const principal = creatorPrincipal(creator);
  let out = base;
  for (const verb of ['read', 'write', 'owner'] as const) {
    out = spliceGrant(out, verb, principal, { allowScalar: false, target: 'folder' }).text;
  }
  return out;
}
