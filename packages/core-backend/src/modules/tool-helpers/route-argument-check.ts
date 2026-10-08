import {
  ARGS_UNDER_BODY_LINE,
  ARGUMENTS_DO_NOT_MATCH_KIND,
  argumentsDoNotMatchMessage,
  checkFor,
} from '@bevel-software/platform-mcp-core';
import { EXTERNAL_KB_MANUAL_NAME } from '../tool-manuals/tool-manuals.contract.js';
import { branchProvided } from '../../shared/domain-errors.js';
import { logger } from '../../shared/logging.js';
import { ToolError } from './tool.contract.js';
import { routeToolName, routeToolSchemasForRequest } from './route-tool-schemas.js';
import { DEFAULTED_BRANCH_INPUT } from './tool-def.js';

const log = logger('tools');

/**
 * The argument check of a tool THIS SERVER HOSTS AS A ROUTE, run in that
 * route's handler.
 *
 * It lives here, and not in the MCP layer, because the route is the one place
 * every caller of such a tool arrives at: an agent over MCP, a `call_tool_chain`
 * chain, the in-process agent over loopback, and a runner or script calling
 * `POST /api/agent/tools/<name>` with a connection key. A check one layer up
 * covered the first two and left the last answering a 500 for a missing
 * argument, or — worse — running: `grep` without a `pattern` matched every file
 * in the knowledge base.
 *
 * The arguments are checked FLAT, which is what the handler receives and what a
 * script sends. The call example at the end of the refusal is generated from the
 * wire schema instead, so the line an agent is invited to copy is the line it
 * would really type.
 */

/** Tools called without a check, so the reason is logged once each (never per call). */
const unchecked = new Set<string>();

function noteUnchecked(toolName: string, reason: string): null {
  if (!unchecked.has(toolName)) {
    unchecked.add(toolName);
    log.warn(
      `calling "${toolName}" without checking its arguments — ${reason}. Its calls are passed through as they are.`,
    );
  }
  return null;
}

/**
 * The names the tool declares at its top level. Used only to recognise the
 * mirror-image wrong shape below; nothing is checked against it.
 */
function declaredNames(flat: unknown): string[] {
  const properties = (flat as { properties?: unknown }).properties;
  return typeof properties === 'object' && properties !== null ? Object.keys(properties) : [];
}

/** Does this tool require a `branch`? Read off its own declaration, never assumed. */
function requiresBranch(flat: unknown): boolean {
  const required = (flat as { required?: unknown }).required;
  return Array.isArray(required) && required.includes('branch');
}

/** Does this tool declare `defaults-to-default-branch`? Its `branch` is then the defaulted input. */
function defaultsBranch(flat: unknown): boolean {
  return (flat as { properties?: Record<string, unknown> }).properties?.branch === DEFAULTED_BRANCH_INPUT;
}

/**
 * Did this call pass the tool's arguments at the top level, to a tool that takes
 * them under `body`?
 *
 * The http protocol sends the argument named by the template's `body_field`
 * (`body`, for every tool `toolDef` declares) as the request body and EVERY
 * OTHER argument as a query parameter. So a flat call to one of these tools
 * arrives with an empty body and the arguments in the query string — which is
 * what this recognises, so the refusal can name the mistake instead of listing
 * every argument as missing and leaving the agent to guess why.
 */
function argumentsCameAsQuery(flat: unknown, query: unknown, args: Record<string, unknown>): boolean {
  if (typeof query !== 'object' || query === null) return false;
  const sent = Object.keys(query as Record<string, unknown>);
  if (sent.length === 0) return false;
  const names = new Set(declaredNames(flat));
  // An argument the body DOES carry was not misplaced, whatever else the URL
  // holds: only one that reached the route by the query string alone was.
  return sent.some((name) => names.has(name) && args[name] === undefined);
}

/**
 * The refusal this call deserves, or `null` when the arguments match the tool
 * (or when it has nothing to check them against, which is logged once).
 *
 * Never changes the call: a checker that repaired arguments would hide the
 * mistake it exists to report.
 */
export function argumentsRefusal(
  requestPath: string,
  args: Record<string, unknown>,
  query?: unknown,
): ToolError | null {
  const schemas = routeToolSchemasForRequest(requestPath);
  if (!schemas) return noteUnchecked(routeToolName(requestPath), 'no input schema is declared for its route');
  const toolName = schemas.name;
  const check = checkFor(schemas.flat);
  if (!check.checkable) return noteUnchecked(toolName, check.reason);
  // The shape first, before anything may wave the call through: arguments
  // passed flat reach this route as query parameters and leave the body
  // empty, so a call whose arguments are all optional would otherwise MATCH —
  // as `{}` — and run on defaults, silently dropping what was passed.
  const cameAsQuery = argumentsCameAsQuery(schemas.flat, query, args);
  // A call that names no branch is answered by the refusal that NAMES it, and
  // that refusal comes first, exactly as it does today. It says what a branch
  // is and what to pass, and it is one message rather than a list; putting a
  // second fault ahead of it would replace an answer the caller can act on
  // with one it has to read twice. Whatever else is wrong with such a call is
  // reported on the next one, which at least names its workspace.
  // A tool that defaults its branch is defaulted only when the branch is
  // ABSENT; an empty or non-string one gets the same refusal by name.
  if (!cameAsQuery && !branchProvided(args.branch)) {
    if (requiresBranch(schemas.flat)) return null;
    if (args.branch !== undefined && defaultsBranch(schemas.flat)) return null;
  }
  // A mismatch about an argument the tool refuses itself is dropped, so the
  // tool's own message — which says what that argument is FOR — is the one the
  // caller reads. Every mismatch line opens with the argument it is about.
  const mismatches = check
    .check(args)
    .filter((line) => !schemas.refusesItself.has(/^"([^".]+)"/.exec(line)?.[1] ?? ''));
  // The shape first, when that is what went wrong: the lines below (every
  // required argument missing) are its symptoms, not the mistake.
  if (cameAsQuery) mismatches.unshift(ARGS_UNDER_BODY_LINE);
  if (mismatches.length === 0) return null;
  // The namespace of the example is the one manual the whole catalog is served
  // as, so the line matches the `Call:` line at the top of this tool's own
  // description. A connection that renames the manual (the local stdio server
  // names it after the deployment) reads a different namespace there; the
  // arguments, which are what the refusal is about, are the same either way.
  const message = argumentsDoNotMatchMessage(
    toolName,
    `${EXTERNAL_KB_MANUAL_NAME}.${toolName}`,
    schemas.flat,
    mismatches,
    { exampleInputs: schemas.wire },
  );
  return new ToolError(message, 400, { kind: ARGUMENTS_DO_NOT_MATCH_KIND });
}
