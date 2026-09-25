import type { KbLayout } from '@bevel-software/platform-shared';
import { type WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { KbContext } from '../../shared/kb-context.js';
import { resolveDeclaredId } from '../../shared/frontmatter-id.js';
import { visibleProposedFiles } from '../../shared/pending-proposals.js';
import { isSafeSkillName, parseSkillFrontmatter } from './skills.service.js';
import type { IPendingSkillService, ISkillService, PendingSkill } from './skills.contract.js';
import type { IWorkflowService } from '@bevel-software/platform-shared';

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
 * WHO MAY SEE ONE, and how a proposal is read at its own branch, live in
 * `shared/pending-proposals.ts` — shared with the tool surface, which is the
 * same shape for the same reasons. What stays here is what is specific to a
 * skill: which touched paths are a skill of their own, and how a SKILL.md
 * names itself.
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
    private readonly kb: KbContext,
  ) {}

  async listPendingSkills(userEmail: string): Promise<PendingSkill[]> {
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

    const layout = this.kb.layout;
    const proposed = await visibleProposedFiles(
      {
        workspaceService: this.workspaceService,
        accessControl: this.accessControl,
        workflow: this.workflow,
        kb: this.kb,
      },
      userEmail,
      (p) => isSkillDoc(p, layout) && !released.has(folderOf(p)),
    );

    const out: PendingSkill[] = proposed.map(({ cr, path, content, isAuthor }) => {
      const folder = folderOf(path);
      const fm = parseSkillFrontmatter(content);
      const folderName = folder.split('/').pop() ?? folder;
      const declared = resolveDeclaredId(fm.frontmatter, folderName);
      return {
        name: isSafeSkillName(declared) ? declared : folderName,
        description: fm.description,
        version: fm.version,
        path: folder,
        changeRequestNumber: cr.number,
        branch: cr.branch,
        authorName: cr.appAuthor?.name ?? cr.author.name ?? 'Someone',
        createdAt: cr.createdAt,
        isAuthor,
      };
    });
    // Oldest first — the one that has been waiting longest is the one that
    // needs answering, and a list that reorders as requests arrive moves under
    // the pointer.
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/**
 * Is this touched path a skill's own SKILL.md?
 *
 * `Plugins/<plugin>/<skill>/SKILL.md` is the shallowest shape, hence four
 * segments; deeper ones are skills nested in a category subfolder, which the
 * catalog already supports. `Plugins/<plugin>/SKILL.md` is NOT a skill — a plugin
 * folder is not itself one.
 */
function isSkillDoc(repoRelPath: string, layout: KbLayout): boolean {
  const segments = repoRelPath.split('/');
  if (segments[segments.length - 1] !== SKILL_DOC) return false;
  // Under `Skills/` a skill may sit directly below the root: `Skills/<skill>/SKILL.md`.
  if (segments[0] === layout.skillsDir) return segments.length >= 3;
  return segments.length >= 4 && segments[0] === layout.pluginsDir;
}

/** The skill folder holding a SKILL.md. */
function folderOf(skillDocPath: string): string {
  return skillDocPath.slice(0, -(SKILL_DOC.length + 1));
}
