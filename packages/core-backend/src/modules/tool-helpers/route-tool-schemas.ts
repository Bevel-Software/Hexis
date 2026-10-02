import type { JsonSchema } from '../tool-registry/tool.contract.js';

/**
 * What a route-hosted tool declared about its own arguments, so the route that
 * hosts it can check a call against it.
 *
 * Written by {@link declareRouteTool} — which `toolDef` calls for every tool it
 * builds, the platform's own and a deployment's alike — and read by the tool
 * handler. That is what makes the check free for a deployment: it declares its
 * tool exactly as it does today and its route refuses a call that does not
 * match, with no code of its own.
 *
 * Keyed by TOOL NAME, which is also the last segment of the route each tool
 * hosts (`/api/agent/tools/<name>`) and is unique across the catalog — so the
 * handler finds the schema from the request path alone, without every module
 * having to hand it over a second time.
 */
export interface RouteToolSchemas {
  /**
   * The LOGICAL (flat) schema: what the handler receives as `args`, and what a
   * script calling `POST /api/agent/tools/<name>` sends as its JSON body. The
   * arguments are checked against this one.
   */
  flat: JsonSchema;
  /**
   * The WIRE schema: the flat one inside the `{ body: … }` envelope, which is
   * what an agent passes over MCP or inside a chain. Only the call example in a
   * refusal is generated from it — so the line the agent is invited to copy is
   * the line it would actually type.
   */
  wire: JsonSchema;
  /**
   * Arguments this tool refuses BY NAME ITSELF, with a message of its own — so
   * the generic check says nothing about them and that message is what the
   * caller reads. `create_branch`'s `name` is one: it answers
   * `name-required`, which says what the name is for.
   */
  refusesItself: ReadonlySet<string>;
}

/** Tool name → what it declared. One catalog per process, so one map. */
const declared = new Map<string, RouteToolSchemas>();

/** Does this flat input schema require any argument at all? */
function requiresAnything(inputs: JsonSchema): boolean {
  const required = (inputs as { required?: unknown }).required;
  return Array.isArray(required) && required.length > 0;
}

/**
 * The flat inputs inside the `body` envelope every module-hosted tool advertises
 * — the only standard-http way to ride multiple fields in a JSON body.
 *
 * The envelope is required only when something inside it is. A tool whose flat
 * inputs are all optional is legitimately called as `Bevel.<name>({})` — agents
 * have always called `list_branches` and `start_session` that way, and the
 * endpoint reads `req.body` as `{}` either way — so declaring `body` required
 * would make the schema disagree with the tool, and a check must never refuse a
 * call the tool accepts.
 */
function bodyEnvelope(inputs: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: { body: inputs },
    ...(requiresAnything(inputs) ? { required: ['body'] } : {}),
    additionalProperties: false,
  } as JsonSchema;
}

/**
 * Record what the route-hosted tool `name` takes, and answer with the wire
 * schema its def must advertise.
 *
 * `toolDef` calls this for every tool it builds, so declaring a tool IS
 * declaring its arguments to the check. A module that builds its def lazily
 * (the skill tools rebuild theirs per catalog listing, to name the skills that
 * exist now) calls it once at registration as well, so a direct REST call that
 * lands before the first catalog listing is checked too.
 *
 * Idempotent in effect: a tool whose def is rebuilt re-declares the same
 * arguments, and the last declaration for a name is the one in force.
 */
export function declareRouteTool(
  name: string,
  inputs: JsonSchema,
  refusesItself: readonly string[] = [],
): JsonSchema {
  const wire = bodyEnvelope(inputs);
  if (name) declared.set(name, { flat: inputs, wire, refusesItself: new Set(refusesItself) });
  return wire;
}

/** What the tool named `name` takes, or `undefined` when nothing declared it. */
export function routeToolSchemas(name: string): RouteToolSchemas | undefined {
  return declared.get(name);
}

/**
 * The tool a request to `/api/agent/tools/<name>` is for: the last segment of
 * the path, query and trailing slash left out.
 *
 * Read off the path rather than taken as a parameter, because the path is the
 * only thing every mounting style agrees on — the modules mount their routes on
 * a router at `/api`, the tests mount theirs wherever they like, and a
 * deployment mounts its own.
 */
export function routeToolName(path: string): string {
  const withoutQuery = path.split('?')[0] ?? '';
  const segments = withoutQuery.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? '';
}
