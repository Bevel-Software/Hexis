import { randomUUID } from 'node:crypto';
import { CommunicationProtocol } from '@utcp/sdk';

/**
 * A GET tool never sends a request body — whatever it is called with, and
 * whoever registered it.
 *
 * A UTCP http tool sends the one argument named by its template's `body_field`
 * (which DEFAULTS to `body`) as the request body, for any method. So a flat GET
 * tool called with its arguments wrapped in `body` — the shape the platform's
 * own tools take, and the mistake an agent makes most often — sends a GET with
 * a body. Services answer that with whatever their edge does: three users of
 * the enterprise deployment got an HTML error page where a search result was
 * expected.
 *
 * The fix is in the request client rather than in each tool's definition,
 * because the definitions come from three places (the platform's own
 * `toolDef`, a deployment's tools, and an administrator's tool manual) and a
 * rule enforced in three places is a rule that holds in two. Here, the
 * protocol that would send the body is handed a template whose `body_field`
 * names an argument no tool declares, so there is nothing to put in the body;
 * the argument itself is untouched and travels as a query parameter, exactly as
 * every other argument does.
 */

/**
 * The `body_field` a GET template is given. Deliberately not a name any schema
 * would declare: the leading `__` and the markers make it unreachable from a
 * generated call example or a described interface, so no agent is ever told to
 * send it. The tail is drawn once per process, so a manual cannot write the
 * name into its own template and have an argument of that name sent as the
 * body after all: the name it would have to guess does not exist until the
 * server starts.
 */
export const NO_BODY_FIELD = `__utcp_get_sends_no_body_${randomUUID().replace(/-/g, '')}__`;

/** Marks a protocol instance as already decorated, so installing twice is free. */
const GUARDED = Symbol.for('bevel.mcp-core.getHasNoBody');

interface HttpishTemplate {
  http_method?: unknown;
  body_field?: unknown;
}

/**
 * The template a GET tool is actually called with. Returns the template
 * unchanged for anything that is not an http-family GET, so a POST tool, an
 * `mcp` tool and a template with no method at all all pass through untouched.
 */
export function withoutBodyOnGet<T>(template: T): T {
  const t = template as HttpishTemplate | null;
  if (!t || typeof t !== 'object') return template;
  const method = typeof t.http_method === 'string' ? t.http_method.toUpperCase() : undefined;
  if (method !== 'GET') return template;
  if (t.body_field === NO_BODY_FIELD) return template;
  return { ...(template as object), body_field: NO_BODY_FIELD } as T;
}

type Protocol = {
  callTool?: (...args: unknown[]) => unknown;
  callToolStreaming?: (...args: unknown[]) => unknown;
};

/** Decorate one protocol instance in place. Returns it, decorated or already so. */
function decorate(protocol: CommunicationProtocol): CommunicationProtocol {
  const p = protocol as unknown as Protocol & Record<symbol, unknown>;
  if (!p || p[GUARDED] === true) return protocol;
  p[GUARDED] = true;
  // The template is the LAST argument of both methods (`caller, toolName,
  // toolArgs, toolCallTemplate`), already variable-substituted by the client.
  // Replacing it here is the last moment before the request is built, and the
  // only one where every registration path has converged.
  for (const name of ['callTool', 'callToolStreaming'] as const) {
    const original = p[name];
    if (typeof original !== 'function') continue;
    p[name] = function guardedCall(this: unknown, ...args: unknown[]) {
      if (args.length > 0) args[args.length - 1] = withoutBodyOnGet(args[args.length - 1]);
      return original.apply(this, args);
    };
  }
  return protocol;
}

/**
 * Install the guard over every communication protocol registered in this
 * process, instances and factories alike — the registry the UTCP SDK documents
 * as "the right home for a registry a decorator writes into".
 *
 * Process-wide and idempotent, so every client built afterwards is covered
 * without being told to be: the hosted proxy's per-request clients, the pooled
 * downstream clients, the local server's client, and a client a deployment
 * builds on top of Hexis.
 */
export function installGetHasNoBody(): void {
  const instances = CommunicationProtocol.communicationProtocols;
  for (const type of Object.keys(instances)) {
    const instance = instances[type];
    if (instance) decorate(instance);
  }
  const factories = CommunicationProtocol.communicationProtocolFactories;
  for (const type of Object.keys(factories)) {
    const factory = factories[type];
    if (!factory) continue;
    const marked = factory as typeof factory & Record<symbol, unknown>;
    if (marked[GUARDED] === true) continue;
    const wrapped = (() => decorate(factory())) as typeof factory & Record<symbol, unknown>;
    wrapped[GUARDED] = true;
    factories[type] = wrapped;
  }
}
