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
import { spliceGrant, type Principal } from './access-splice.js';
import { isAccessMdPath } from './access-control.service.js';
import { toKbRelative } from './kb-read-filter.js';

/**
 * How a pending creation gets its creator read grant.
 *   - `seed-access-md`: merge the grant into `wsRelPath` (a new directory's
 *     own `access.md`, workspace-relative) — BEFORE or alongside the creation,
 *     via the caller's own lock+commit machinery. The caller MUST re-read the
 *     file's CURRENT text under its lock and write `apply(current)` ('' when
 *     absent), never a precomputed fresh file: two concurrent creators can
 *     both plan a seed for the same new directory, and a blind overwrite
 *     would silently revoke whichever grant landed first. Skip the write when
 *     `apply` returns the input unchanged, and call `noteAccessFileWritten`
 *     after a write so the resolver cache drops.
 *   - `frontmatter`: run the new file's content through `apply` before
 *     writing it, so the grant lands atomically inside the created file.
 */
export type CreationGrantPlan =
  | { kind: 'seed-access-md'; wsRelPath: string; apply: (current: string) => string }
  | { kind: 'frontmatter'; apply: (content: string) => string };

/** The creator identity a grant is written for. */
export interface Creator {
  name: string;
  email: string;
}

/**
 * Injection seam for the creation surfaces (routes, lock-aware filesystem,
 * upload apply). Kept as an interface so callers depend on the contract, not
 * the class.
 */
export interface ICreatorAccess {
  planForCreate(
    workspaceId: string,
    creator: Creator,
    wsRelPath: string,
    kind: 'file' | 'dir',
  ): Promise<CreationGrantPlan | null>;

  grantInExtractedFile(
    workspaceId: string,
    creator: Creator,
    wsRelPath: string,
  ): Promise<string | null>;

  noteAccessFileWritten(workspaceId: string): void;
}

/**
 * `Name <email>`-safe display name: `validatePrincipal` rejects control
 * chars, `<`, `>`, and `#`, so strip those from the user's name and fall
 * back to the email local part (which the email regex already keeps free of
 * `<>`/whitespace) when nothing usable remains.
 */
function safeDisplayName(creator: Creator): string {
  const strip = (s: string) =>
    // eslint-disable-next-line no-control-regex -- same intentional control-char guard as access-splice
    s.replace(/[<>#\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return strip(creator.name) || strip(creator.email.split('@')[0] ?? '') || 'KB user';
}

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
        return {
          kind: 'seed-access-md',
          wsRelPath: `${this.kbDirName}/${acc}/access.md`,
          apply: (current: string) => {
            try {
              // Idempotent merge into whatever is on disk by write time — a
              // concurrent creator's grant survives; ours lands next to it.
              return spliceGrant(current, 'read', principal, { allowScalar: false }).text;
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
    return { kind: 'user', email: creator.email, displayName: safeDisplayName(creator) };
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
