/**
 * The tool-author SDK — everything needed to build a tool, in ONE import.
 * Internal tools use it today; it is the surface a third-party marketplace
 * plugin will code against (eventually shipped as a standalone `@bevel-software/tool-sdk`
 * package). A tool author never needs the registry internals, the Express
 * middleware, or the internal-token service — only what is re-exported here.
 *
 *   import { validateToken, toolDef, ToolError } from '<tool-sdk>';
 *
 *   // in your endpoint:
 *   const ctx = await validateToken(bearerToken, body);   // verify + resolve, throws ToolError
 *   const fs = await ctx.getFilesystem();                  // lock-aware (write) / read-only (read)
 *   const def = toolDef({ name, description, inputs, path }); // self-describing UTCP Tool to register
 *
 * ## The branch
 *
 * A tool that works on a knowledge-base branch declares how, and the tool
 * handler resolves the branch before the tool runs — the tool itself carries
 * no guard and reads the result from `ctx.branch`:
 *
 *   toolDef({ name, description, inputs, path, branch: 'required' });
 *   toolDef({ name, description, inputs, path, branch: 'defaults-to-default-branch' });
 *
 *  - `required` (what a tool whose `inputs` require `branch` gets without
 *    saying so): a call without a branch, or with an empty or non-string one,
 *    is answered 400 `branch-required` and the tool does not run.
 *  - `defaults-to-default-branch`, for a READ-ONLY tool: a call without a
 *    branch runs on the deployment's default branch, the input schema shows
 *    `branch` as optional and says so, and an object answer without a
 *    `branch` field gets one naming the branch used. A deployment with no
 *    default branch configured answers such a call 503
 *    `default-branch-unset`. A writing tool (`write: true`, or a `write`
 *    tag) that declares it makes `toolDef` throw at startup, naming the tool.
 *  - neither, with no `branch` in `inputs`: the tool takes no branch, and
 *    a stray `branch` in a call is dropped before the tool runs.
 *
 * Under either branch declaration, a given branch that does not exist is
 * answered 404 `branch-not-found`, naming it, before the tool runs.
 */
export { createToolValidator, type ValidateToken, type ToolValidatorDeps } from './validate-token.js';
export {
  toolDef,
  BRANCH_INPUT,
  DEFAULTED_BRANCH_INPUT,
  type ToolDefSpec,
  type BranchDeclaration,
} from './tool-def.js';
export { ToolError, hasHttpStatus, type ToolContext, type ToolHandler } from './tool.contract.js';
export type { JsonSchema, UtcpTool } from '../tool-registry/tool.contract.js';
