import { DEFAULT_BRANCH, PLUGINS_DIR, type PullRequestSummary } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';
import { createBranch } from '../../git/services/git.api';
import { deleteFile, getOrCreateWorkspace, writeFile } from '../../workspace/services/workspace.api';
import { openChangeRequest } from '../../pr/services/pr-open.api';
import { postPrComment } from '../../pr/services/pr-comments.api';
import { branchSegment } from '../../change-requests/services/propose.api';
import { ensurePersonalGroup } from './groups.api';

/**
 * Library data access. Skills come from the browser skill routes
 * (`GET /api/skills`, `GET /api/skills/:name[?file=…]`) — the same
 * default-branch, per-user-`canRead`-filtered catalog the agent sees.
 * Change requests come from the workflow routes the pr module already talks
 * to. Integration (tool) data is NOT here — the Library reuses
 * `secrets-vault/services/tool-secrets.api.ts` directly.
 */

/** The default-branch workspace id — derivable client-side (id = encodeURIComponent(branch)). */
/**
 * The default branch's workspace id. A FUNCTION because the branch model is
 * applied during boot from `/api/config`: a module-scope constant would capture
 * the empty string that exists before it, and being exported would spread that
 * snapshot to every importer.
 */
export const defaultWorkspaceId = () => encodeURIComponent(DEFAULT_BRANCH);

export interface LibrarySkillSummary {
  /** Canonical id = the skill's folder name (e.g. `rfi`). */
  name: string;
  description: string;
  version?: string;
  /** Repo-root-relative skill folder, e.g. `Groups/Everyone/rfi`. */
  path: string;
}

export interface LibrarySkill extends LibrarySkillSummary {
  /** The SKILL.md markdown body. */
  body: string;
  allowedTools?: string[];
  /** Repo-root-relative bundled file paths (SKILL.md itself is not listed). */
  files: string[];
}

/**
 * A skill that exists only on an open change request's branch — proposed, and
 * waiting on somebody to approve it. Separate from `LibrarySkillSummary`
 * because it is not in the catalog: nothing loads it, nothing runs it, and it
 * is visible only to its author and to whoever could approve it.
 */
export interface PendingSkillSummary extends LibrarySkillSummary {
  changeRequestNumber: number;
  branch: string;
  authorName: string;
  createdAt: string;
  /** True when the caller proposed it themselves. */
  isAuthor: boolean;
}

interface SkillFilePayload {
  name: string;
  file: string;
  path: string;
  content: string;
}

type GetSkillPayload =
  | { ok: true; kind: 'skill'; skill: LibrarySkill }
  | { ok: true; kind: 'file'; file: SkillFilePayload }
  | { ok: false; error: 'not_found' | 'forbidden' | 'invalid_file' };

export async function listSkills(): Promise<LibrarySkillSummary[]> {
  const data = await handleApiResponse<{ skills: LibrarySkillSummary[] }>(
    await authFetch('/api/skills'),
  );
  return data.skills;
}

export async function getSkill(name: string): Promise<LibrarySkill> {
  const data = await handleApiResponse<GetSkillPayload>(
    await authFetch(`/api/skills/${encodeURIComponent(name)}`),
  );
  if (!data.ok || data.kind !== 'skill') throw new Error("Couldn't load this skill.");
  return data.skill;
}

/**
 * Skills awaiting approval that the caller may see. The backend does the
 * filtering — author or possible approver — so this is a plain read.
 */
export async function listPendingSkills(): Promise<PendingSkillSummary[]> {
  const data = await handleApiResponse<{ skills: PendingSkillSummary[] }>(
    await authFetch('/api/skills/pending'),
  );
  // Guarded, not trusted: a backend BUILT BEFORE this route existed answers
  // through `/skills/:name` with `{ok:false}` — a 200 whose shape is not this
  // one. The review shelf degrading to empty is the right failure; `undefined`
  // reaching the item mapper took the whole library down (blank page).
  return Array.isArray(data.skills) ? data.skills : [];
}

/** Content of a bundled skill file. `file` is relative to the skill folder. */
export async function getSkillFile(name: string, file: string): Promise<string> {
  const data = await handleApiResponse<GetSkillPayload>(
    await authFetch(`/api/skills/${encodeURIComponent(name)}?file=${encodeURIComponent(file)}`),
  );
  if (!data.ok || data.kind !== 'file') throw new Error("Couldn't load this file.");
  return data.file.content;
}

// The cross-surface change-request reads (listOpenChangeRequests,
// listMyChangeRequests, readFileOnBranch) and the Knowledge propose flow
// live in `modules/change-requests/services/` now — this file keeps only
// what is specific to the Library's catalog and the per-skill propose flow.

/** The one suggestion branch per user per skill (see mocks/README.md — suggestions are git). */
export function suggestionBranchFor(userEmail: string, skillName: string): string {
  return `suggestions/${branchSegment(userEmail.split('@')[0])}/${branchSegment(skillName)}`;
}

export interface ProposeChangeInput {
  skillName: string;
  /** Repo-root-relative path of the file being proposed on. */
  repoRelativePath: string;
  /** The file's full new text — what the author typed in the editor. */
  content: string;
  /** Optional "why" — lands in the change-request description / a comment. */
  note?: string;
  userEmail: string;
  userName: string;
  /** The caller's open change request for this skill, if any. */
  existingCr?: PullRequestSummary | null;
}

/**
 * Propose a change: commit the new text to the author's suggestion branch
 * (`suggestions/<user>/<skill>`, forked from the default branch) and make sure
 * an open change request against the default branch exists for it.
 *
 * Save = share: `writeFile` on the branch workspace auto-commits and pushes, so
 * the proposal is durable the moment this resolves — there is no local-only
 * state that could be lost between here and the owner reading it.
 *
 * One branch and one change request PER PERSON PER SKILL, not per file: a
 * proposal that rewrites a step and its example touches two files and is one
 * decision, so it has to arrive as one thing to approve.
 */
export async function proposeChange(
  input: ProposeChangeInput,
): Promise<{ branch: string; kbDirName: string }> {
  const branch = input.existingCr?.branch ?? suggestionBranchFor(input.userEmail, input.skillName);

  if (!input.existingCr) {
    try {
      await createBranch(defaultWorkspaceId(), branch, DEFAULT_BRANCH);
    } catch {
      // Branch may already exist from an earlier (merged/cancelled) round —
      // reuse it; the change request below is what makes it reviewable again.
    }
  }

  const { workspace } = await getOrCreateWorkspace(branch);
  await writeFile(
    workspace.id,
    `${workspace.kbDirName}/${input.repoRelativePath}`,
    input.content,
  );

  if (input.existingCr) {
    if (input.note) {
      await postPrComment(input.existingCr.number, { body: input.note });
    }
  } else {
    await openChangeRequest({
      sourceBranch: branch,
      targetBranch: DEFAULT_BRANCH,
      title: `Changes from ${input.userName}. ${input.skillName}`,
      description: input.note || undefined,
    });
  }
  return { branch, kbDirName: workspace.kbDirName };
}

/**
 * What a brand-new SKILL.md contains: the frontmatter fence, an empty
 * `description`, and nothing else.
 *
 * Not zero bytes, and the difference matters. The catalog reads a skill's
 * description straight out of this frontmatter (`skills.service.ts`
 * `parseSkillFrontmatter`), so a file with no fence at all lists as a card with
 * a blank subtitle and no visible hint that a description is a thing it could
 * have. The fence is the shape of the thing; the emptiness inside it is the
 * point. The skill's NAME is deliberately not written here — identity falls
 * back to the folder name, and two places to change a skill's name is one place
 * too many.
 */
export const EMPTY_SKILL_MD = '---\ndescription:\n---\n\n';

export type CreateSkillInput = {
  /** The skill's name, which becomes its folder name. */
  name: string;
  userEmail: string;
  userName: string;
} & (
  | {
      /** Repo-root-relative group folder the skill lands in — `Groups/GTM`. */
      parentPath: string;
      /** False (or unknown) routes the new file through a change request instead. */
      canWrite: boolean;
    }
  | {
      /**
       * The skill is the caller's own: it lands in their personal folder
       * (`Groups/personal-<id>/`), which the provisioning endpoint ensures —
       * and commits — first. Always a direct write: the ensured folder's
       * access.md names the caller as owner, so the write gate passes on its
       * own, with no permission special-case anywhere.
       */
      personal: true;
    }
);

export interface CreatedSkill {
  /** Repo-root-relative path of the new `SKILL.md`. */
  repoRelativePath: string;
  /** Workspace-relative path — what the file route wants. */
  workspacePath: string;
  /** Where it landed: the default branch, or the author's suggestion branch. */
  branch: string;
  /** True when it went in directly; false when it arrived as a change request. */
  direct: boolean;
}

/**
 * Make a new, empty skill: `<parentPath>/<name>/SKILL.md`.
 *
 * The folder is not created separately — `writeFile` mkdir's the parents — so
 * this is one round trip, and there is no window in which an empty skill folder
 * exists without the file that makes it a skill.
 *
 * Where it lands depends on whether the caller may write the destination, which
 * is the same fork the "add" dialogs already describe in words: an owner's skill
 * goes straight onto the default branch, and everyone else's arrives on their
 * suggestion branch with a change request open against it. Callers get `direct`
 * back so they can say which of the two happened rather than guess.
 */
export async function createEmptySkill(input: CreateSkillInput): Promise<CreatedSkill> {
  const parentPath =
    'personal' in input
      ? `${PLUGINS_DIR}/${(await ensurePersonalGroup()).folder}`
      : input.parentPath;
  const repoRelativePath = `${parentPath}/${input.name}/SKILL.md`;

  if (!('personal' in input) && !input.canWrite) {
    const { branch, kbDirName } = await proposeChange({
      skillName: input.name,
      repoRelativePath,
      content: EMPTY_SKILL_MD,
      userEmail: input.userEmail,
      userName: input.userName,
    });
    return {
      repoRelativePath,
      workspacePath: `${kbDirName}/${repoRelativePath}`,
      branch,
      direct: false,
    };
  }

  const { workspace } = await getOrCreateWorkspace(DEFAULT_BRANCH);
  const workspacePath = `${workspace.kbDirName}/${repoRelativePath}`;
  // Exclusive create: the panel's collision check runs against a skill list
  // that can be stale, so the backend must be the one to refuse a name that
  // was claimed since — a plain write here would silently empty the existing
  // SKILL.md. The 409 surfaces through the panel's normal error toast.
  await writeFile(workspace.id, workspacePath, EMPTY_SKILL_MD, { ifAbsent: true });
  return { repoRelativePath, workspacePath, branch: DEFAULT_BRANCH, direct: true };
}

/**
 * Delete a skill folder or tool file from the default branch — the group
 * manager's "remove from group". One call for both shapes: the backend's
 * delete route recurses a folder into per-file lock+commit cycles, and every
 * one of those locks runs the per-path ACL gate, so a caller who does not
 * manage the group is refused by the same rule that governs editing it.
 */
export async function removeLibraryItem(repoRelativePath: string): Promise<void> {
  const { workspace } = await getOrCreateWorkspace(DEFAULT_BRANCH);
  await deleteFile(workspace.id, `${workspace.kbDirName}/${repoRelativePath}`);
}
