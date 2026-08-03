import { DEFAULT_BRANCH, type PullRequestSummary } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';
import { createBranch } from '../../git/services/git.api';
import { getOrCreateWorkspace, readFile, writeFile } from '../../workspace/services/workspace.api';
import { openChangeRequest } from '../../pr/services/pr-open.api';
import { postPrComment } from '../../pr/services/pr-comments.api';

/**
 * Library data access. Skills come from the browser skill routes
 * (`GET /api/skills`, `GET /api/skills/:name[?file=…]`) — the same
 * default-branch, per-user-`canRead`-filtered catalog the agent sees.
 * Change requests come from the workflow routes the pr module already talks
 * to. Integration (tool) data is NOT here — the Library reuses
 * `secrets-vault/services/tool-secrets.api.ts` directly.
 */

/** The default-branch workspace id — derivable client-side (id = encodeURIComponent(branch)). */
export const DEFAULT_WORKSPACE_ID = encodeURIComponent(DEFAULT_BRANCH);

export interface LibrarySkillSummary {
  /** Canonical id = the skill's folder name (e.g. `rfi`). */
  name: string;
  description: string;
  version?: string;
  /** Repo-root-relative skill folder, e.g. `Skills/rfi`. */
  path: string;
}

export interface LibrarySkill extends LibrarySkillSummary {
  /** The SKILL.md markdown body. */
  body: string;
  allowedTools?: string[];
  /** Repo-root-relative bundled file paths (SKILL.md itself is not listed). */
  files: string[];
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

/** Content of a bundled skill file. `file` is relative to the skill folder. */
export async function getSkillFile(name: string, file: string): Promise<string> {
  const data = await handleApiResponse<GetSkillPayload>(
    await authFetch(`/api/skills/${encodeURIComponent(name)}?file=${encodeURIComponent(file)}`),
  );
  if (!data.ok || data.kind !== 'file') throw new Error("Couldn't load this file.");
  return data.file.content;
}

/** All open change requests (the Library filters them to a skill's folder). */
export async function listOpenChangeRequests(): Promise<PullRequestSummary[]> {
  return handleApiResponse<PullRequestSummary[]>(
    await authFetch('/api/workflow/change-requests'),
  );
}

/** The caller's own change requests (any state; callers filter to open). */
export async function listMyChangeRequests(): Promise<PullRequestSummary[]> {
  return handleApiResponse<PullRequestSummary[]>(
    await authFetch('/api/workflow/change-requests/mine'),
  );
}

/** Read a file from a branch's shared workspace (bootstraps the clone if needed). */
export async function readFileOnBranch(branch: string, repoRelativePath: string): Promise<string> {
  const { workspace } = await getOrCreateWorkspace(branch);
  return readFile(workspace.id, `${workspace.kbDirName}/${repoRelativePath}`);
}

/** Keep only characters git branch segments accept; collapse the rest to '-'. */
function branchSegment(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[.]+$/, '');
  return cleaned || 'user';
}

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
export async function proposeChange(input: ProposeChangeInput): Promise<{ branch: string }> {
  const branch = input.existingCr?.branch ?? suggestionBranchFor(input.userEmail, input.skillName);

  if (!input.existingCr) {
    try {
      await createBranch(DEFAULT_WORKSPACE_ID, branch, DEFAULT_BRANCH);
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
      title: `Changes from ${input.userName} — ${input.skillName}`,
      description: input.note || undefined,
    });
  }
  return { branch };
}
