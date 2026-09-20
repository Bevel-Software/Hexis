/**
 * Creator read-grant on creation — for the one place a creation may land
 * where its creator cannot read: a NEW FOLDER directly under one of the three
 * roots (knowledge, skills, plugins).
 *
 * `read` is default-deny (see `IAccessControl.canRead`), and the roots grant
 * read to nobody by default, so a folder started there by someone the root
 * does not name would vanish from their own explorer the moment it appeared.
 * This service decides — BEFORE the bytes land — whether a creation is that
 * case, and plans the grant: a `read:` line for the creator, seeded into the
 * new folder's own `access.md`. Chain inheritance carries it to the whole new
 * subtree, the explorer's dir-chain check sees it, and it can never widen
 * access to pre-existing content — everything under a brand-new folder was
 * created by this very operation.
 *
 * Everywhere else the read-before-write gate (`ChangeReadGate`) refuses a
 * creation the creator could not see, so no other grant is needed: a file or
 * folder made inside a readable folder inherits that folder's rules, and the
 * creator reads it as they read its parent. The per-file frontmatter grant
 * that used to cover loose markdown files in unreadable folders is gone with
 * the case it covered.
 *
 * The grant is best-effort UX, not an authorization gate: any failure here
 * (unreadable access config, splice error) must never fail the creation
 * itself, so every decision path degrades to "no grant" with a warning.
 */

import path from 'node:path';
import { creatableRootDirNames } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';

const log = logger('creator-access');

import type { IFsProbe } from '../../shared/fs.contract.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from './access-control.interface.js';
import { spliceGrant, type Principal } from '../access-model/access-splice.js';
import { isAccessMdPath } from '../access-model/access-grammar.js';
import { toKbRelative } from '../access-model/kb-read-filter.js';
import {
  creatorPrincipal,
  type CreationGrantPlan,
  type Creator,
  type ICreatorAccess,
} from '../access-model/creator.js';

export class CreatorAccessService implements ICreatorAccess {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    private readonly disk: IFsProbe,
  ) {}

  /** Whether something is at `abs`, links followed: a link to a real file is "there", a dangling one is not. */
  private async exists(abs: string): Promise<boolean> {
    return (await this.disk.statOrNull(abs)) !== null;
  }

  /**
   * Decide whether creating `wsRelPath` (workspace-relative) needs a creator
   * read grant, and compute it. Returns null when no grant is needed or none
   * is possible: the path is outside the KB repo, is itself access config
   * (`access.md` / `roles.yaml`) or a `.gitkeep` placeholder, already exists
   * on disk (not a create), is already readable by the creator, or does not
   * bring a new folder directly under one of the three roots into existence
   * — the only creation the read-before-write gate lets past an unreadable
   * spot. Must be called BEFORE the creation mutates the disk — the
   * new-folder detection stats the current tree.
   */
  async planForCreate(
    workspaceId: string,
    creator: Creator,
    wsRelPath: string,
    kind: 'file' | 'dir',
  ): Promise<CreationGrantPlan | null> {
    const rel = this.grantablePath(wsRelPath);
    if (rel === null) return null;

    let repoDir: string;
    try {
      const wsDir = await this.workspaceService.getWorkspacePath(workspaceId);
      repoDir = path.join(wsDir, this.kbDirName);
      if (await this.exists(path.join(repoDir, rel))) return null; // not a create
      if (await this.accessControl.canRead(workspaceId, creator.email, rel)) return null;
    } catch (err) {
      // Unusable access config (e.g. missing roles.yaml) or workspace lookup
      // failure — read gating is inoperative there, so there is nothing to
      // grant against. Never fail the creation over the grant.
      warnSkipped(rel, err);
      return null;
    }

    // The folder the creation would bring into existence directly under a
    // root: for a dir target that may be the dir itself, for a file target
    // only its ancestors are candidates. Anything else — a loose file at a
    // root, a create inside an existing folder — is not this service's case:
    // the gate refuses what the creator cannot read, and what they can read
    // needs no grant.
    const segments = rel.split('/');
    if (kind === 'file') segments.pop();
    const root = segments[0];
    if (root === undefined || segments.length < 2 || !creatableRootDirNames().has(root)) return null;
    const top = `${root}/${segments[1]}`;
    if (await this.exists(path.join(repoDir, top))) return null;

    const principal = this.principalFor(creator);
    try {
      // Validate the principal now (a bad one throws), so a doomed plan is
      // dropped here instead of surfacing at every write site.
      spliceGrant('', 'read', principal, { allowScalar: false });
    } catch (err) {
      warnSkipped(rel, err);
      return null;
    }
    // NOTE: a direct plugin folder (`Plugins/<Name>`) is not special here.
    // Plugins — and personal folders — are made by the dedicated provisioning
    // endpoint (`PluginProvisionService`), which writes the full ownership
    // template itself; this generic read-grant covers the ad-hoc folder a
    // person starts at a root by any other route.
    return {
      kind: 'seed-access-md',
      wsRelPath: `${this.kbDirName}/${top}/access.md`,
      apply: (current: string) => {
        try {
          // Idempotent merge into whatever is on disk by write time — a
          // concurrent creator's grant survives; ours lands next to it.
          // `target: 'folder'` so a new-format access.md (body-governed)
          // gets the grant in its FOLDER rules, never its self-frontmatter.
          return spliceGrant(current, 'read', principal, {
            allowScalar: false,
            target: 'folder',
          }).text;
        } catch (err) {
          warnSkipped(rel, err);
          return current;
        }
      },
    };
  }

  /**
   * Drop the resolver's cached model after a seeded `access.md` lands, so the
   * very next tree build / read check sees the new grant instead of waiting
   * out the cache TTL.
   */
  noteAccessFileWritten(workspaceId: string): void {
    this.accessControl.invalidate(workspaceId);
  }

  /**
   * Map a workspace-relative path to its KB-repo-relative form when it is a
   * grantable creation target; null for non-KB paths, access config files
   * (`access.md` frontmatter governs its directory, `roles.yaml` is
   * admin-only), and `.gitkeep` placeholders (invisible in the tree anyway).
   */
  private grantablePath(wsRelPath: string): string | null {
    const rel = toKbRelative(wsRelPath, this.kbDirName);
    if (rel === null) return null;
    if (isAccessMdPath(rel) || rel === 'roles.yaml') return null;
    if ((rel.split('/').pop() ?? '') === '.gitkeep') return null;
    return rel;
  }

  private principalFor(creator: Creator): Principal {
    return creatorPrincipal(creator);
  }
}

function warnSkipped(rel: string, err: unknown): void {
  log.warn(`skipped creator read grant for "${rel}":`, { err });
}
