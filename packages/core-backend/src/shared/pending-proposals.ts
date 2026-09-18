import { DEFAULT_BRANCH, type ChangeRequest, type IWorkflowService } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../modules/workspace/workspace.service.js';
import { workspaceIdForBranch } from './workspace-id.js';
import type { IAccessControl } from '../modules/access/access-control.interface.js';
import { canonicalEmail, hashEmail } from './email-identity.js';

/**
 * The mechanics every "proposed, not released" surface shares.
 *
 * Skills and tools both have a half of their catalog that is NOT on the default
 * branch: a change request that ADDS a declaration has nothing on the default
 * branch to hang itself off, so until it merged the proposal was invisible to
 * its author and to the people who had to approve it. Both surfaces answer that
 * the same way — walk the OPEN change requests, keep the touched paths that
 * look like the declaration in question, decide who may see each one, and read
 * the file at the request's own branch — and only the "looks like" predicate and
 * the parsing differ.
 *
 * Kept in one place so the two cannot drift on the part that matters most: WHO
 * MAY SEE A PROPOSAL. It is narrower than who may see the catalog — the author,
 * and whoever could approve it. "Could approve it" is not re-stated as an
 * admin check; it is `canWrite` on the very path the request would create,
 * resolved on the DEFAULT branch. The new file carries no `access.md` of its
 * own, so that verdict inherits from the plugin folder, which IS the plugin's
 * admin; asking the access tree keeps these surfaces and the merge gate
 * answering with one voice. The branch's own copy of the tree is written by the
 * proposer and must not get a say in who reviews them.
 */
export interface ProposalSources {
  workspaceService: Pick<WorkspaceService, 'ensureRemotesFetched' | 'readFileAtRef'>;
  accessControl: Pick<IAccessControl, 'canWriteBatch'>;
  workflow: Pick<IWorkflowService, 'listChangeRequests'>;
}

/** One file an open change request proposes, already read at that request's branch. */
export interface ProposedFile {
  /** The open change request that would release it. */
  cr: ChangeRequest;
  /** Repo-root-relative path of the proposed file. */
  path: string;
  /** The file's content at the request's branch. */
  content: string;
  /** True when the caller opened the request themselves. */
  isAuthor: boolean;
}

/**
 * Every file matching `matches` that an OPEN change request proposes and this
 * caller is entitled to see, with its branch content in hand.
 *
 * Never throws: these surfaces hang off the library's list load, and a review
 * shelf that cannot answer must not take the shelf down with it. Everything
 * degrades to "nothing pending".
 *
 * `matches` is where a surface states what it is looking for — and, because it
 * runs BEFORE the access batch, also where it drops what it already serves from
 * the default branch, so the batch stays as small as the answer.
 *
 * Order follows the change requests as the workflow service listed them; a
 * caller that wants a stable reading order sorts the result itself.
 */
export async function visibleProposedFiles(
  sources: ProposalSources,
  userEmail: string,
  matches: (repoRelPath: string) => boolean,
): Promise<ProposedFile[]> {
  const email = canonicalEmail(userEmail);
  if (!email) return [];

  let crs: ChangeRequest[];
  try {
    crs = (await sources.workflow.listChangeRequests()).filter((c) => c.state === 'open');
  } catch {
    return [];
  }
  if (crs.length === 0) return [];

  const candidates = crs.flatMap((cr) =>
    cr.touchedNodePaths.filter(matches).map((path) => ({ cr, path })),
  );
  if (candidates.length === 0) return [];

  const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
  const authorHash = hashEmail(email);

  // One access load for every candidate, resolved on the DEFAULT branch — see
  // the note on {@link ProposalSources}.
  const writable = await sources.accessControl
    .canWriteBatch(
      wsId,
      email,
      candidates.map((c) => c.path),
    )
    .catch(() => new Map<string, boolean>());

  // The branch copies are read through the default branch's clone at
  // `origin/<branch>`, so a proposal never needs a clone of its own. Refresh
  // first, best-effort: a request pushed seconds ago is worth one fetch, and a
  // failed fetch should degrade to "read what we have".
  await sources.workspaceService.ensureRemotesFetched(wsId).catch(() => undefined);

  const out: ProposedFile[] = [];
  for (const { cr, path } of candidates) {
    const isAuthor = !!cr.authorId && cr.authorId === authorHash;
    // Fail closed, matching the catalog: only an explicit `true` admits a
    // reviewer. A missing entry (the batch skipped the path, the tree could not
    // be read) means denied, never shown.
    if (!isAuthor && writable.get(path) !== true) continue;

    const content = await readAt(sources.workspaceService, wsId, cr.branch, path);
    // Nothing to describe: the request touched the path but the file is gone at
    // its head (proposed then withdrawn within the branch), or unreadable.
    if (content === null) continue;
    out.push({ cr, path, content, isAuthor });
  }
  return out;
}

/** The file at a branch, or null when it is absent/unreadable there. */
export async function readAt(
  workspaceService: Pick<WorkspaceService, 'readFileAtRef'>,
  wsId: string,
  branch: string,
  repoRelPath: string,
): Promise<string | null> {
  try {
    return await workspaceService.readFileAtRef(wsId, `origin/${branch}`, repoRelPath);
  } catch {
    return null;
  }
}
