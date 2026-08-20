/**
 * Creator read-grant on creation.
 *
 * `read` is default-deny (see `IAccessControl.canRead`), so a brand-new file
 * or folder created at a spot whose `access.md` chain never names the creator
 * would instantly vanish from the creator's own explorer and be unreadable to
 * them. This service decides — BEFORE the bytes land — whether a creation
 * needs an automatic `read:` grant for the creator, and where that grant must
 * live so the thing stays visible:
 *
 *   - When the creation brings a NEW directory into existence (a new folder,
 *     or a file whose path mkdirs ancestors), the grant is seeded into the
 *     TOPMOST new directory's own `access.md`. That covers the entire new
 *     subtree via chain inheritance, is visible to the explorer's shallow
 *     (dir-chain-only) check, and can never widen access to pre-existing
 *     content — everything under a brand-new directory was created by this
 *     very operation.
 *   - When a loose `.md` file is created directly inside a PRE-EXISTING
 *     folder, the grant is spliced into the file's own frontmatter (the
 *     per-file scope; granting on the existing folder's `access.md` would
 *     leak read on all its siblings). Frontmatter is invisible to the
 *     explorer's shallow check by design (read-filter plan D5); the tree
 *     route compensates with a bounded full check for entries directly under
 *     the structural roots — the only place a loose file can sit inside a
 *     visible folder without sharing its chain verdict.
 *   - Non-markdown files in a pre-existing unreadable folder can't carry
 *     frontmatter, so no per-file grant is possible; the creation proceeds
 *     ungranted (logged).
 *
 * The grant is best-effort UX, not an authorization gate: any failure here
 * (unreadable access config, splice error) must never fail the creation
 * itself, so every decision path degrades to "no grant" with a warning.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

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
  ) {}

  /**
   * Decide whether creating `wsRelPath` (workspace-relative) needs a creator
   * read grant, and compute it. Returns null when no grant is needed or none
   * is possible: the path is outside the KB repo, is itself access config
   * (`access.md` / `roles.yaml`) or a `.gitkeep` placeholder, already exists
   * on disk (not a create), is already readable by the creator, or is a
   * non-markdown file in a pre-existing folder. Must be called BEFORE the
   * creation mutates the disk — the topmost-new-directory detection stats the
   * current tree.
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
      if (await exists(path.join(repoDir, rel))) return null; // not a create
      if (await this.accessControl.canRead(workspaceId, creator.email, rel)) return null;
    } catch (err) {
      // Unusable access config (e.g. missing roles.yaml) or workspace lookup
      // failure — read gating is inoperative there, so there is nothing to
      // grant against. Never fail the creation over the grant.
      warnSkipped(rel, err);
      return null;
    }

    const principal = this.principalFor(creator);

    // Topmost path segment that does not exist yet: for a dir target that is
    // at worst the dir itself (its absence was established above), for a file
    // target only the ancestor directories are candidates.
    const segments = rel.split('/');
    if (kind === 'file') segments.pop();
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!(await exists(path.join(repoDir, acc)))) {
        try {
          // Validate the principal now (a bad one throws), so a doomed plan
          // is dropped here instead of surfacing at every write site.
          spliceGrant('', 'read', principal, { allowScalar: false });
        } catch (err) {
          warnSkipped(rel, err);
          return null;
        }
        // NOTE: a direct plugin folder (`Plugins/<Name>`) is no longer special
        // here. Plugins — and personal folders — are made by the dedicated
        // provisioning endpoint (`PluginProvisionService`), which writes the
        // full ownership template itself; this generic read-grant only covers
        // ad-hoc folder creation elsewhere in the tree.
        return {
          kind: 'seed-access-md',
          wsRelPath: `${this.kbDirName}/${acc}/access.md`,
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
    }

    // No new directory — a file created directly inside an existing folder.
    // Only markdown can carry a per-file frontmatter grant.
    if (!rel.endsWith('.md')) {
      console.warn(
        `[creator-access] cannot grant creator read on "${rel}" — a non-markdown file in a folder without a read grant carries no frontmatter`,
      );
      return null;
    }
    return {
      kind: 'frontmatter',
      apply: (content: string) => {
        try {
          return spliceGrant(content, 'read', principal, { allowScalar: true }).text;
        } catch (err) {
          warnSkipped(rel, err);
          return content;
        }
      },
    };
  }

  /**
   * The after-the-fact variant for files that are ALREADY on disk when we
   * first see them (zip extraction writes straight to the working tree).
   * Returns the file's content with the creator's read grant spliced into its
   * frontmatter — for the caller to write back under its lock — or null when
   * no grant is needed/possible (non-KB path, non-markdown, already readable,
   * unreadable config, no-op splice).
   */
  async grantInExtractedFile(
    workspaceId: string,
    creator: Creator,
    wsRelPath: string,
  ): Promise<string | null> {
    const rel = this.grantablePath(wsRelPath);
    if (rel === null || !rel.endsWith('.md')) return null;
    try {
      if (await this.accessControl.canRead(workspaceId, creator.email, rel)) return null;
      const content = await this.workspaceService.readFile(workspaceId, wsRelPath);
      const result = spliceGrant(content, 'read', this.principalFor(creator), {
        allowScalar: true,
      });
      return result.changed ? result.text : null;
    } catch (err) {
      warnSkipped(rel, err);
      return null;
    }
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

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function warnSkipped(rel: string, err: unknown): void {
  console.warn(
    `[creator-access] skipped creator read grant for "${rel}":`,
    err instanceof Error ? err.message : err,
  );
}
