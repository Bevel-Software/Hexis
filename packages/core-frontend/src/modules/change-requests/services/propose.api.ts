import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { createBranch } from '../../git/services/git.api';
import { getOrCreateWorkspace, writeFile } from '../../workspace/services/workspace.api';
import { openChangeRequest } from '../../pr/services/pr-open.api';
import { listMyChangeRequests } from './change-requests.api';

/** The default branch's workspace id (id = encodeURIComponent(branch)), read lazily. */
const defaultWorkspaceId = () => encodeURIComponent(DEFAULT_BRANCH);

/** Keep only characters git branch segments accept; collapse the rest to '-'. */
export function branchSegment(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[.]+$/, '');
  return cleaned || 'user';
}

/**
 * The one personal suggestions branch bundling ALL of a user's Knowledge
 * proposals. Skills keep their per-skill branches (a skill is one decision);
 * the knowledge folder gets one branch and one change request per person, so
 * every edit a reader proposes lands in the same reviewable bundle.
 *
 * Shares the `suggestions/<user>/<segment>` shape with the skill branches —
 * a skill literally named `knowledge` would collide, which is accepted: the
 * two flows would then share one branch and one change request, which is
 * untidy but loses nothing.
 */
export function knowledgeSuggestionBranchFor(userEmail: string): string {
  return `suggestions/${branchSegment(userEmail.split('@')[0])}/knowledge`;
}

export interface ProposeKnowledgeChangeInput {
  /** Repo-root-relative path of the file being proposed on (no kbDirName prefix). */
  repoRelativePath: string;
  /** The file's full new text — what the author typed in the editor. */
  content: string;
  userEmail: string;
  userName: string;
}

/**
 * Propose a change to a Knowledge file: commit the new text to the author's
 * personal suggestions branch (forked from the default branch) and make sure
 * an open change request against the default branch exists for it.
 *
 * Save = share: `writeFile` on the branch workspace auto-commits and pushes,
 * so the proposal survives the tab closing the moment this resolves. The
 * existing-request lookup is by BRANCH against the caller's own requests —
 * `touchedNodePaths` is empty until computed, so a path-derived check would
 * open a second request against the branch that already has one.
 */
export async function proposeKnowledgeChange(
  input: ProposeKnowledgeChangeInput,
): Promise<{ branch: string }> {
  const branch = knowledgeSuggestionBranchFor(input.userEmail);

  const mine = await listMyChangeRequests();
  const existing = mine.find((c) => c.state === 'open' && c.branch === branch) ?? null;

  if (!existing) {
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

  if (!existing) {
    await openChangeRequest({
      sourceBranch: branch,
      targetBranch: DEFAULT_BRANCH,
      title: `Changes from ${input.userName} — Knowledge`,
    });
  }
  return { branch };
}
