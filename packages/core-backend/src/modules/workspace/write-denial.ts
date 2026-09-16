import { isProtectedBranch } from '@bevel-software/platform-shared';
import { ToolError } from '../tool-helpers/tool.contract.js';
import { AccessDeniedError } from '../access-model/access-errors.js';
import { toKbRelative } from '../access-model/kb-read-filter.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';

/**
 * Appended to the description of every workspace tool whose refusal is mapped
 * by `writeDenial`, so an agent knows before it is refused that a refusal is
 * not necessarily the end of the road.
 */
export const PROPOSAL_ROUTE_NOTE =
  ' If this is refused for permissions, the `write-denied` error says whether you may propose the change instead (create a branch from this one, repeat this call on it, then `open_change_request` into this branch) and lists those steps.';

/** One step of the proposal route, named by the tool the agent calls. */
export interface ProposalStep {
  tool: string;
  args: Record<string, unknown>;
  note: string;
}

/**
 * The structured body of a permission refusal from a write tool. Carries no
 * request arguments beyond the tool name and branch: file contents are the
 * caller's own and may hold anything, so they are never echoed back.
 */
export interface WriteDeniedDetails {
  code: 'write-denied';
  path: string;
  reason: string;
  canPropose: boolean;
  /** Present exactly when `canPropose` is true. */
  proposal?: { targetBranch: string; draftBranch: string; steps: ProposalStep[] };
  /** One sentence, present exactly when `canPropose` is false. */
  cannotProposeReason?: string;
}

/**
 * What the refusal said beyond "you may not write here": the eligible
 * principals, or the sentence naming a principal excluded at the folder.
 * Taken from the error's own message so the reason reads exactly as the UI's.
 */
function reasonOf(err: AccessDeniedError): string {
  const lead = `You don't have permission to write to "${err.access.path}".`;
  return err.message.startsWith(lead) ? err.message.slice(lead.length).trim() || err.message : err.message;
}

/** A suggested draft name on the `<email-localpart>/<kebab-slug>` convention. */
function draftNameFor(email: string, path: string): string {
  const local = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'agent';
  const base = path.split('/').filter(Boolean).pop() ?? 'change';
  const slug = base.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change';
  return `${local}/propose-${slug}`;
}

/**
 * A suggested change-request title, within `open_change_request`'s 256-character
 * limit. Cut on a code-point boundary, so an emoji at the cut is dropped whole
 * rather than leaving half a surrogate pair; the result is at most 256 UTF-16
 * units, so it fits however the limit is counted.
 */
export function proposalTitleFor(path: string): string {
  const title = `Propose a change to ${path}`;
  if (title.length <= 256) return title;
  let cut = title.slice(0, 255);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Turn a permission refusal from a write tool into a `write-denied` ToolError
 * that says whether the caller may propose the change instead, and how.
 *
 * `canPropose` follows the rule that routes a UI upload to a suggestion: the
 * refusal is on a protected branch (the only kind that takes change requests
 * as a target) and the caller may READ the path. Nothing is created here —
 * the agent decides whether to follow the steps.
 */
export async function writeDenial(
  err: AccessDeniedError,
  input: { tool: string; branch: string; userEmail: string },
  accessControl: IAccessControl,
  kbDirName: string,
): Promise<ToolError> {
  const path = err.access.path;
  const base = { code: 'write-denied' as const, path, reason: reasonOf(err) };
  const refuse = (cannotProposeReason: string): ToolError => {
    const details: WriteDeniedDetails = { ...base, canPropose: false, cannotProposeReason };
    return new ToolError(`${err.message} ${cannotProposeReason}`, 403, { ...details });
  };

  if (!isProtectedBranch(input.branch)) {
    return refuse(`Proposing is not available: "${input.branch}" is not a branch that accepts change requests.`);
  }
  // The lock gate reports workspace paths, the git gates repo-relative ones.
  const rel = toKbRelative(path, kbDirName) ?? path.replace(/^\.?\/+/, '');
  let readable: boolean;
  try {
    readable = await accessControl.canRead(workspaceIdForBranch(input.branch), input.userEmail, rel);
  } catch {
    // Fail closed: offering a route the caller may not take is worse than none.
    return refuse('Proposing is not offered: whether you can read this path could not be determined; try again.');
  }
  if (!readable) return refuse('Proposing is not available: you cannot read this path.');

  const draft = draftNameFor(input.userEmail, path);
  const details: WriteDeniedDetails = {
    ...base,
    canPropose: true,
    proposal: {
      targetBranch: input.branch,
      draftBranch: draft,
      steps: [
        {
          tool: 'create_branch',
          args: { name: draft, branch: input.branch },
          note: `Create a draft from "${input.branch}" (any unused name on the same convention works).`,
        },
        {
          tool: input.tool,
          args: { branch: draft },
          note: 'Repeat the same call with `branch` set to the draft; every other argument unchanged.',
        },
        {
          tool: 'open_change_request',
          args: { sourceBranch: draft, targetBranch: input.branch, title: proposalTitleFor(rel) },
          note: 'Open a change request from the draft into the target; a sharper title saying what changes is better than the suggested one.',
        },
      ],
    },
  };
  return new ToolError(
    `${err.message} You may propose this change instead: create a branch from "${input.branch}", repeat this call on it, then open_change_request into "${input.branch}" (steps in \`proposal\`).`,
    403,
    { ...details },
  );
}

/** Rethrow a permission refusal as `write-denied`; anything else passes through untouched. */
export async function rethrowAsWriteDenial(
  err: unknown,
  input: { tool: string; branch: unknown; userEmail: string },
  accessControl: IAccessControl,
  kbDirName: string,
): Promise<never> {
  if (err instanceof AccessDeniedError && typeof input.branch === 'string') {
    throw await writeDenial(err, { ...input, branch: input.branch }, accessControl, kbDirName);
  }
  throw err;
}
