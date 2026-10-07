import '@utcp/http';
import { HttpCallTemplateSerializer } from '@utcp/http';
import { ToolSerializer } from '@utcp/sdk';
import type { JsonSchema, UtcpTool } from '../tool-registry/tool.contract.js';
import { declareRouteTool } from './route-tool-schemas.js';

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

/** Add a required `branch` property to an object input schema (KB tools). */
export function withBranchInput(inputs: JsonSchema): JsonSchema {
  const o = inputs as { properties?: Record<string, JsonSchema>; required?: string[] };
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
   * Arguments this tool's own handler refuses by name, with a message of its
   * own. The generic argument check its route runs then says nothing about
   * them, so that message is what the caller reads — which is the point of
   * having written it. A missing `branch` needs no entry here: the route
   * check leaves a call that names no branch to `branch-required`.
   */
  refusesItself?: string[];
}

/**
 * Build a self-describing UTCP `Tool` def for a module-hosted endpoint. The flat
 * `inputs` are wrapped under a single `body` property (`body_field: 'body'`) —
 * the only standard-http way to ride multiple fields in the JSON body — so the
 * agent calls `Bevel.<name>({ body: { ... } })` and the endpoint reads `req.body`
 * as the flat args. The URL + bearer are `${API_URL}` / `${CONNECTION_KEY}`
 * placeholders the consumer resolves (public URL + key for external; loopback +
 * internal token for our agent), so one def serves both surfaces.
 */
export function toolDef(spec: ToolDefSpec): UtcpTool {
  // Declaring the tool IS declaring its arguments to the check that its route
  // runs, which is why the envelope comes back from the declaration rather than
  // being built here: a tool declared with this helper — the platform's own and
  // a deployment's alike — refuses a call whose arguments do not match it on
  // every way in, the REST route included, with no code of its own.
  const wire = declareRouteTool(spec.name, spec.inputs, spec.refusesItself, spec.path);
  return toolSerializer.validateDict({
    name: spec.name,
    description: spec.description,
    inputs: wire,
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
