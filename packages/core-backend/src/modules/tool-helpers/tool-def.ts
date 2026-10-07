import '@utcp/http';
import { HttpCallTemplateSerializer } from '@utcp/http';
import { ToolSerializer } from '@utcp/sdk';
import type { JsonSchema, UtcpTool } from '../tool-registry/tool.contract.js';

const httpTemplate = new HttpCallTemplateSerializer();
const toolSerializer = new ToolSerializer();

/**
 * The required `branch` input every KB tool declares — the model names the
 * workspace (draft) the call acts on. Since the credential is identity-only
 * (internal token == connection key), the workspace is never implied; it always
 * comes from this argument.
 */
export const BRANCH_INPUT: JsonSchema = {
  type: 'string',
  minLength: 1,
  description: 'The branch (draft) whose workspace this operates on — pass the branch you are currently working on.',
};

/**
 * The optional `branch` of a tool that declares `defaults-to-default-branch`:
 * the same input, saying what happens without it.
 */
export const DEFAULTED_BRANCH_INPUT: JsonSchema = {
  type: 'string',
  minLength: 1,
  description:
    "Optional: the branch (draft) to read. Without it the call runs on the deployment's default branch, " +
    "and the answer's `branch` field names that branch.",
};

/**
 * How a tool treats its `branch` input — the declaration the tool handler
 * resolves the branch from, once, before the tool runs:
 *
 *  - `required`: the call must name a branch. A call without one, or with an
 *    empty or non-string one, is refused with the `branch-required` refusal
 *    and the tool does not run. The default for a tool whose inputs require
 *    `branch`.
 *  - `defaults-to-default-branch`: a call without a branch runs on the
 *    deployment's default branch, and an object answer without a `branch`
 *    field gets one naming it. An empty or non-string branch is still refused:
 *    only an ABSENT one is defaulted. Read-only tools only — a writing tool
 *    declaring it fails at startup, since its write would land on the default
 *    branch without the caller having named it.
 *
 * A tool that declares neither, and whose inputs have no `branch`, takes no
 * branch.
 *
 * Under both declarations a branch that is given must exist: one that does not
 * is answered 404 naming it, before the tool runs. The tool reads the resolved
 * name from `ctx.branch` — or from `args.branch`, which the handler overwrites
 * with it — and never sees a missing, empty or non-string one.
 */
export type BranchDeclaration = 'required' | 'defaults-to-default-branch';

/**
 * What the tool handler does with a call's `branch`: a {@link BranchDeclaration},
 * `none` for a tool that takes no branch, or `own` for a tool with an OPTIONAL
 * `branch` and no declaration (the platform's skill tools, `list_tool_setup`)
 * — such a tool keeps its own handling of an absent branch, and gets only the
 * 404 for a named branch that does not exist.
 */
export type BranchHandling = BranchDeclaration | 'none' | 'own';

/**
 * Every route path a `toolDef` was built for, with how its branch is handled.
 * Kept here rather than on the registry so the tool handler finds a tool's
 * declaration from its route alone: a deployment's tool is covered by building
 * its def with `toolDef` and mounting its route with `toolHandler`, as it
 * already does, with nothing in between to keep in step.
 */
const branchHandlingByPath = new Map<string, BranchHandling>();

/** How the tool hosted at `path` treats its branch; `undefined` for a route no `toolDef` described. */
export function branchHandlingFor(path: string): BranchHandling | undefined {
  return branchHandlingByPath.get(path);
}

type ObjectSchema = { properties?: Record<string, JsonSchema>; required?: string[] };

/** A tool's branch handling read off inputs that carry no declaration. */
function inferBranchHandling(inputs: JsonSchema): BranchHandling {
  const o = inputs as ObjectSchema;
  if ((o.required ?? []).includes('branch')) return 'required';
  return o.properties && 'branch' in o.properties ? 'own' : 'none';
}

/**
 * The input schema with `branch` as `declaration` says: required, or optional
 * with the sentence about the default. A tool that declares its own `branch`
 * property with its own meaning (a fork base, a switch target) keeps that
 * property under `required`.
 */
export function withBranchDeclaration(inputs: JsonSchema, declaration: BranchDeclaration): JsonSchema {
  const o = inputs as ObjectSchema;
  const properties = { ...(o.properties ?? {}) };
  const others = (o.required ?? []).filter((r) => r !== 'branch');
  if (declaration === 'required') {
    properties.branch = properties.branch ?? BRANCH_INPUT;
    return { ...inputs, properties, required: [...others, 'branch'] } as JsonSchema;
  }
  properties.branch = DEFAULTED_BRANCH_INPUT;
  const out = { ...inputs, properties } as ObjectSchema;
  if (others.length > 0) out.required = others;
  else delete out.required;
  return out as JsonSchema;
}

/** Add a required `branch` property to an object input schema (KB tools). */
export function withBranchInput(inputs: JsonSchema): JsonSchema {
  const o = inputs as ObjectSchema;
  return {
    ...inputs,
    properties: { ...(o.properties ?? {}), branch: BRANCH_INPUT },
    required: [...new Set([...(o.required ?? []), 'branch'])],
  } as JsonSchema;
}

export interface ToolDefSpec {
  /** Unique within its surface; also the namespace member the agent calls (`Bevel.<name>`). */
  name: string;
  description: string;
  /** The LOGICAL (flat) input schema — what the handler receives and the agent passes. */
  inputs: JsonSchema;
  outputs?: JsonSchema;
  tags?: string[];
  /** The route the owning module hosts, e.g. `/agent/tools/list_branches`. */
  path: string;
  /**
   * How the tool treats `branch` — see {@link BranchDeclaration}. Given, the
   * `branch` input is added to `inputs` to match. Omitted, a tool whose
   * `inputs` require `branch` is `required`, and one without `branch` takes
   * no branch.
   */
  branch?: BranchDeclaration;
  /**
   * The tool writes. A `write` tag says the same. A writing tool cannot
   * declare `defaults-to-default-branch`.
   */
  write?: boolean;
}

/**
 * Build a self-describing UTCP `Tool` def for a module-hosted endpoint. The flat
 * `inputs` are wrapped under a single `body` property (`body_field: 'body'`) —
 * the only standard-http way to ride multiple fields in the JSON body — so the
 * agent calls `Bevel.<name>({ body: { ... } })` and the endpoint reads `req.body`
 * as the flat args. The URL + bearer are `${API_URL}` / `${CONNECTION_KEY}`
 * placeholders the consumer resolves (public URL + key for external; loopback +
 * internal token for our agent), so one def serves both surfaces.
 *
 * Also records the tool's branch handling for its route, which is what the
 * tool handler mounted on that route resolves the branch from. Throws — at
 * startup, where defs are built — for a writing tool that declares
 * `defaults-to-default-branch`.
 */
export function toolDef(spec: ToolDefSpec): UtcpTool {
  if (spec.branch === 'defaults-to-default-branch' && (spec.write || (spec.tags ?? []).includes('write'))) {
    throw new Error(
      `Tool "${spec.name}" writes, so it cannot declare branch: 'defaults-to-default-branch' — a write must ` +
        "name its branch. Declare branch: 'required' instead.",
    );
  }
  const inputs = spec.branch ? withBranchDeclaration(spec.inputs, spec.branch) : spec.inputs;
  branchHandlingByPath.set(spec.path, spec.branch ?? inferBranchHandling(inputs));
  return toolSerializer.validateDict({
    name: spec.name,
    description: spec.description,
    inputs: {
      type: 'object',
      properties: { body: inputs },
      required: ['body'],
      additionalProperties: false,
    },
    outputs: spec.outputs ?? { type: 'object', properties: {} },
    tags: spec.tags ?? [],
    tool_call_template: httpTemplate.validateDict({
      call_template_type: 'http',
      http_method: 'POST',
      url: `\${API_URL}${spec.path}`,
      content_type: 'application/json',
      headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
      body_field: 'body',
    }),
  });
}
