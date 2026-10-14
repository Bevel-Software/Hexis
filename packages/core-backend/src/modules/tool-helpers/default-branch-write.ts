import type { IAccessControl } from '../access/access-control.interface.js';
import type { ToolContext } from './tool.contract.js';

/**
 * What the read tools need to say whether a change can land directly: the
 * access layer and the default branch's workspace. A function for the
 * workspace, not a value, because first-run setup may name the default branch
 * after the tools are mounted.
 */
export interface DefaultBranchWriteDeps {
  accessControl: Pick<IAccessControl, 'canWriteBatchAtRef'>;
  defaultWorkspaceId: () => string;
}

/**
 * The `canWrite` verdicts `list_skills`, `get_skill`, `list_files` and
 * `read_file` report: whether the caller may commit a change to each
 * repo-relative path DIRECTLY on the default branch, under the access rules
 * COMMITTED there. `false` means "make the change on a branch and open a
 * change request", never "you cannot write at all" — on a draft, anyone who
 * may read a path may write it, so "writable on the branch read" would say
 * yes exactly where a direct write is later refused.
 *
 * Always judged against the default branch, whichever branch the call read:
 * that is where a direct change lands. And judged at that clone's `HEAD`, the
 * way the direct write itself is gated (`assertCanWriteAtRef` in the git
 * service), not from the rules as the working tree has them: a grant written
 * to disk but not yet committed — a queued save, an edit in flight — would
 * otherwise say `true` for a write that is then refused. ONE batched check
 * per call.
 *
 * Fails closed: a read-only credential gets `false` for every path without
 * the access layer being asked; a check that throws, or a path the answer
 * leaves out, is `false`. Read the result with `=== true`. The one answer
 * that is not closed is the gate's own: `null` — no rules at `HEAD` yet, a
 * knowledge base being set up — is where the direct write is allowed
 * (bootstrap, `assertCanWriteAtRef`), so every path is `true` there; a
 * `false` would send the agent to a change request the gate does not ask
 * for.
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
    const answer = await deps.accessControl.canWriteBatchAtRef(deps.defaultWorkspaceId(), 'HEAD', ctx.user.email, [
      ...new Set(paths),
    ]);
    // Bootstrap: no rules at HEAD, and the gate lets the write through.
    if (!answer) return new Map(paths.map((p) => [p, true]));
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
