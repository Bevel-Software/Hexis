import {
  DEFAULT_BRANCH,
  PLUGINS_DIR,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { workspaceIdForBranch, type WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { hashEmail } from '../../shared/hash-email.js';
import { resolveDeclaredId } from '../../shared/frontmatter-id.js';
import { isSafeSkillName, parseSkillFrontmatter } from './skills.service.js';
import type { IPendingSkillService, ISkillService, PendingSkill } from './skills.contract.js';

const SKILL_DOC = 'SKILL.md';

/**
 * Skills that exist only on an open change request — proposed, not released.
 *
 * The catalog (`SkillService`) is pinned to the default branch, which is the
 * right answer for everything that LOADS a skill and the wrong one for the
 * person who just proposed it: a change request that ADDS a skill folder has
 * nothing on the default branch to hang itself off, so until it merged the
 * proposal was invisible to its author and to the people who had to approve it.
 * This service is that missing half, and it is deliberately a separate surface
 * rather than a widening of the catalog — an unapproved skill must never become
 * loadable just because it became visible.
 *
 * WHO MAY SEE ONE is narrower than who may see the catalog: the author, and
 * whoever could approve it. "Could approve it" is not re-stated here as a
 * group-admin check — it is `canWrite` on the SKILL.md the request would
 * create. The new folder carries no `access.md` of its own, so that verdict
 * inherits from the group folder, which IS the group's admin; asking the access
 * tree keeps this surface and the merge gate answering with one voice, and it
 * keeps working for skills nested in a category subfolder that carries rules of
 * its own.
 *
 * Everything degrades to "nothing pending" rather than throwing: this hangs off
 * the library's list load, and a review surface that cannot answer must not
 * take the shelf down with it.
 */
export class PendingSkillsService implements IPendingSkillService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly skillService: ISkillService,
    private readonly workflow: IWorkflowService,
  ) {}

  async listPendingSkills(userEmail: string): Promise<PendingSkill[]> {
    const email = userEmail.trim().toLowerCase();
    if (!email) return [];

    let crs: ChangeRequest[];
    try {
      crs = (await this.workflow.listChangeRequests()).filter((c) => c.state === 'open');
    } catch {
      return [];
    }
    if (crs.length === 0) return [];

    // The released set, UNFILTERED by the caller's read access. A skill someone
    // else can read and this caller cannot is still released — counting it as
    // pending would invent a review that is not happening, and would leak the
    // fact that the folder exists.
    let released: Set<string>;
    try {
      released = new Set((await this.skillService.listSkills()).map((s) => s.path));
    } catch {
      return [];
    }

    const candidates = crs.flatMap((cr) =>
      cr.touchedNodePaths
        .filter((p) => isSkillDoc(p) && !released.has(folderOf(p)))
        .map((p) => ({ cr, docPath: p, folder: folderOf(p) })),
    );
    if (candidates.length === 0) return [];

    const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
    const authorHash = hashEmail(email);

    // One access load for every candidate. Resolved on the DEFAULT branch —
    // the tree as it stands is what says who owns the group the skill is
    // arriving into; the branch's own copy is written by the proposer and must
    // not get a say in who reviews them.
    const writable = await this.accessControl
      .canWriteBatch(
        wsId,
        email,
        candidates.map((c) => c.docPath),
      )
      .catch(() => new Map<string, boolean>());

    // The branch copies are read through the default branch's clone at
    // `origin/<branch>`, so a proposal never needs a clone of its own. Refresh
    // first, best-effort: a request pushed seconds ago is worth one fetch, and
    // a failed fetch should degrade to "read what we have".
    await this.workspaceService.ensureRemotesFetched(wsId).catch(() => undefined);

    const out: PendingSkill[] = [];
    for (const { cr, docPath, folder } of candidates) {
      const isAuthor = !!cr.authorId && cr.authorId === authorHash;
      // Fail closed, matching the catalog: only an explicit `true` admits a
      // reviewer. A missing entry (the batch skipped the path, the tree could
      // not be read) means denied, never shown.
      if (!isAuthor && writable.get(docPath) !== true) continue;

      const raw = await this.readAt(wsId, cr.branch, docPath);
      // Nothing to describe: the request touched the path but the file is gone
      // at its head (proposed then withdrawn within the branch), or unreadable.
      if (raw === null) continue;

      const fm = parseSkillFrontmatter(raw);
      const folderName = folder.split('/').pop() ?? folder;
      const declared = resolveDeclaredId(fm.frontmatter, folderName);
      out.push({
        name: isSafeSkillName(declared) ? declared : folderName,
        description: fm.description,
        version: fm.version,
        path: folder,
        changeRequestNumber: cr.number,
        branch: cr.branch,
        authorName: cr.appAuthor?.name ?? cr.author.name ?? 'Someone',
        createdAt: cr.createdAt,
        isAuthor,
      });
    }
    // Oldest first — the one that has been waiting longest is the one that
    // needs answering, and a list that reorders as requests arrive moves under
    // the pointer.
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The file at a branch, or null when it is absent/unreadable there. */
  private async readAt(
    wsId: string,
    branch: string,
    repoRelPath: string,
  ): Promise<string | null> {
    try {
      return await this.workspaceService.readFileAtRef(wsId, `origin/${branch}`, repoRelPath);
    } catch {
      return null;
    }
  }
}

/**
 * Is this touched path a skill's own SKILL.md?
 *
 * `Groups/<group>/<skill>/SKILL.md` is the shallowest shape, hence four
 * segments; deeper ones are skills nested in a category subfolder, which the
 * catalog already supports. `Groups/<group>/SKILL.md` is NOT a skill — a group
 * folder is not itself one.
 */
function isSkillDoc(repoRelPath: string): boolean {
  const segments = repoRelPath.split('/');
  return (
    segments.length >= 4 &&
    segments[0] === PLUGINS_DIR &&
    segments[segments.length - 1] === SKILL_DOC
  );
}

/** The skill folder holding a SKILL.md. */
function folderOf(skillDocPath: string): string {
  return skillDocPath.slice(0, -(SKILL_DOC.length + 1));
}
