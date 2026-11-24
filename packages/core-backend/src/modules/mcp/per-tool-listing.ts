import { AsyncLocalStorage } from 'node:async_hooks';
import { McpCommunicationProtocol } from '@utcp/mcp';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { inputSchemaDefect } from '@bevel-software/platform-mcp-core';

/**
 * A connected server's `tools/list`, read one tool at a time while the
 * downstream pool registers the server.
 *
 * Two parsers stand between a server's answer and Hexis, and both take the
 * tool list WHOLE: the MCP SDK client parses the answer with one schema for
 * the whole array, and `@utcp/mcp` then parses the server's tools as one UTCP
 * manual. So one tool whose input schema breaks either of them (a `required`
 * that is not a list, a nested `type` that names no JSON type) fails the whole
 * answer: the server registers with none of its tools, and the schema guard is
 * never shown the one that is wrong.
 *
 * Inside {@link listPerTool}, the answer is read raw instead. Each tool whose
 * input schema fails the JSON Schema check (`inputSchemaDefect`, the same check
 * `ToolSchemaGuard` runs) is left out of the list and recorded, and the rest is
 * parsed exactly as the SDK parses it. The caller hands the recorded tools to
 * the guard, which hides and marks them like any other tool it finds invalid.
 * Outside `listPerTool` nothing here changes anything.
 *
 * Only that check decides. A tool whose schema passes it is left in the list,
 * so the SDK's own parse still decides it as before (a root `type` other than
 * `"object"` is valid JSON Schema, and still fails the whole list).
 */

/** A tool left out of its server's list, with the input schema the server sent. */
export interface InvalidSchemaTool {
  /** The tool's name on its server. */
  name: string;
  inputSchema: unknown;
}

/**
 * Per server name (a key of the manual's `mcpServers`), the tools its latest
 * listing left out. Each listing replaces its own server's entry, so the map
 * always describes the listing the registered tools came from.
 */
export type InvalidSchemaTools = Map<string, InvalidSchemaTool[]>;

/**
 * Run `run` (a registration) with every connected server's tools listed one by
 * one, recording the tools left out into `into`.
 */
export function listPerTool<T>(into: InvalidSchemaTools, run: () => Promise<T>): Promise<T> {
  return listings().run(into, run);
}

const PATCHED = Symbol.for('bevel.core-backend.mcp.perToolListing');

type Operation = (client: Client) => Promise<unknown>;
type WithSession = (serverName: string, serverConfig: unknown, auth: unknown, operation: Operation) => Promise<unknown>;

/**
 * The listings in progress, read by `@utcp/mcp`'s `_withSession`, patched the
 * first time this is asked for. `_withSession` is where the protocol hands an
 * operation the SDK client of one named server, and the `tools/list` of a
 * registration is one such operation: the one place where both the server's
 * name and its client are in reach.
 *
 * Patched on the class, once per process, rather than through the protocol
 * factory registry: `installGetHasNoBody` (mcp-core) re-wraps that factory on
 * every registration and marks only its own wrapper, so a second wrapper there
 * would be wrapped again, and wrap again in turn, each time. The storage is
 * kept on the class too, so a second copy of this module in one process reads
 * the same listings instead of patching a second time. A version of
 * `@utcp/mcp` without `_withSession` is left as it is, and the end-to-end tests
 * that pin per-tool listing fail.
 */
function listings(): AsyncLocalStorage<InvalidSchemaTools> {
  const proto = McpCommunicationProtocol.prototype as unknown as { _withSession?: WithSession } & Record<symbol, unknown>;
  const patched = proto[PATCHED];
  if (patched instanceof AsyncLocalStorage) return patched as AsyncLocalStorage<InvalidSchemaTools>;
  const storage = new AsyncLocalStorage<InvalidSchemaTools>();
  const original = proto._withSession;
  if (typeof original !== 'function') return storage;
  proto[PATCHED] = storage;
  proto._withSession = function perToolWithSession(this: unknown, serverName, serverConfig, auth, operation) {
    const into = storage.getStore();
    if (!into) return original.call(this, serverName, serverConfig, auth, operation);
    return original.call(this, serverName, serverConfig, auth, (client) =>
      operation(listingPerTool(client, (invalid) => into.set(serverName, invalid))),
    );
  };
  return storage;
}

/**
 * `client`, with its `tools/list` requests parsed one tool at a time. The
 * SDK's own `listTools` still runs (and caches what it caches); only the
 * request under it answers with the invalid tools taken out.
 */
function listingPerTool(client: Client, record: (invalid: InvalidSchemaTool[]) => void): Client {
  const send = client.request.bind(client) as (req: unknown, schema: unknown, options?: unknown) => Promise<unknown>;
  const request = async (req: { method: string }, resultSchema: { parse(data: unknown): unknown }, options?: unknown) => {
    if (req.method !== 'tools/list') return send(req, resultSchema, options);
    const raw = (await send(req, ResultSchema, options)) as Record<string, unknown>;
    // Not a list: the SDK's own schema refuses it, as it always has.
    if (!Array.isArray(raw.tools)) return resultSchema.parse(raw);
    const kept: unknown[] = [];
    const invalid: InvalidSchemaTool[] = [];
    for (const tool of raw.tools as unknown[]) {
      const entry = tool as { name?: unknown; inputSchema?: unknown } | null;
      if (entry && typeof entry.name === 'string' && inputSchemaDefect(entry.inputSchema)) {
        invalid.push({ name: entry.name, inputSchema: entry.inputSchema });
      } else {
        kept.push(tool);
      }
    }
    const result = resultSchema.parse({ ...raw, tools: kept });
    record(invalid);
    return result;
  };
  return new Proxy(client, {
    get: (target, prop, receiver) => (prop === 'request' ? request : Reflect.get(target, prop, receiver)),
  });
}
