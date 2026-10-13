import type { IAccessControl } from '../access/access-control.interface.js';
import type { ToolContext } from './tool.contract.js';

/**
 * What the read tools need to say whether a change can land directly: the
 * access layer and the default branch's workspace. A function for the
 * workspace, not a value, because first-run setup may name the default branch
 * after the tools are mounted.
 */
export interface DefaultBranchWriteDeps {
  accessControl: Pick<IAccessControl, 'canWriteBatch'>;
  defaultWorkspaceId: () => string;
}

/**
 * The `canWrite` verdicts `list_skills`, `get_skill`, `list_files` and
 * `read_file` report: whether the caller may commit a change to each
 * repo-relative path DIRECTLY on the default branch, under the default
 * branch's current access rules. `false` means "make the change on a branch
 * and open a change request", never "you cannot write at all" — on a draft,
 * anyone who may read a path may write it, so "writable on the branch read"
 * would say yes exactly where a direct write is later refused.
 *
 * Always judged against the default branch, whichever branch the call read:
 * that is where a direct change lands. ONE batched check per call, against the
 * rules the access layer already holds for that workspace.
 *
 * Fails closed: a read-only credential gets `false` for every path without
 * the access layer being asked; a check that throws, or a path the answer
 * leaves out, is `false`. Read the result with `=== true`.
 *
 * Per caller and never cached here: a verdict belongs to one caller's answer,
 * not to anything shared across users.
 */
export async function defaultBranchWriteVerdicts(
  deps: DefaultBranchWriteDeps,
  ctx: Pick<ToolContext, 'scope' | 'user'>,
  paths: readonly string[],
): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>(paths.map((p) => [p, false]));
  if (ctx.scope !== 'write' || paths.length === 0) return verdicts;
  try {
    const answer = await deps.accessControl.canWriteBatch(deps.defaultWorkspaceId(), ctx.user.email, [...new Set(paths)]);
    for (const p of paths) verdicts.set(p, answer.get(p) === true);
  } catch {
    // A verdict that cannot be computed is `false`: the agent then proposes
    // the change, which can land; a wrong `true` would offer a direct write
    // that is refused.
  }
  return verdicts;
}

/**
 * The clause each of the four tools carries in its description. Said the
 * same way everywhere so an agent reading any one of them learns the rule.
 */
export const CAN_WRITE_CLAUSE = '`canWrite: false` means use a branch and a change request; do not offer a direct write.';
