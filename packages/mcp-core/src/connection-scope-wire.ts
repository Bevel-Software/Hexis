/**
 * What a connection's scope says about itself on the wire, and the words
 * both MCP servers — the hosted proxy and the local `hexis-mcp` — build from
 * it: the handshake line, the refusal of a tool the connection does not
 * load, and the sentence a connection that loads nothing carries. ONE
 * module, so the two servers cannot word the same connection differently.
 *
 * The deployment puts the wire on `GET /api/agent/all-tools` and
 * `GET /api/agent/catalog-revision` as their `connection` field; absent for
 * a connection made as Everything, which is told nothing new.
 */

/** The `code` beside a refusal of what the caller's connection does not load. */
export const NOT_AVAILABLE_TO_CONNECTION = 'not_available_to_connection';

/**
 * Where the sentence saying why a connection loads nothing rides a
 * `tools/list` answer: the listing has no description of its own, and an
 * empty `tools` array alone would read as an outage.
 */
export const CONNECTION_META_KEY = 'software.bevel.hexis/connection';

/** The agent a connection was made as, by the file that defines it. */
export interface ScopeAgent {
  /** Repo-relative path of the agent configuration, as the distribution records it. */
  path: string;
  /** Its name — the frontmatter `name`, else the file's base name; the path when the file cannot be read. */
  name: string;
}

/** The `connection` field of the two deployment answers above. */
export interface ConnectionScopeWire {
  agent: ScopeAgent;
  /** Set when the connection loads nothing because its file cannot be used: the one sentence saying why. */
  unavailable?: string;
}

/**
 * The wire an answer carries, validated at the boundary: HTTP loses the
 * type. A malformed one is dropped — undefined, the Everything reading —
 * which serves what the answer listed, itself already narrowed by the
 * deployment's agent surfaces.
 */
export function connectionWireOf(body: unknown): ConnectionScopeWire | undefined {
  const raw = (body as { connection?: { agent?: { path?: unknown; name?: unknown }; unavailable?: unknown } } | null)
    ?.connection;
  if (!raw || typeof raw.agent?.path !== 'string' || typeof raw.agent.name !== 'string') return undefined;
  return {
    agent: { path: raw.agent.path, name: raw.agent.name },
    ...(typeof raw.unavailable === 'string' && raw.unavailable ? { unavailable: raw.unavailable } : {}),
  };
}

/**
 * The answer to a call of `toolName` that the connection described by
 * `wire` does not load: names the tool and the agent, so the caller knows
 * the tool was refused by the connection's choice and not missing from the
 * deployment; for a file that cannot be used, the sentence that says why.
 * The ONE wording — the tool route and both MCP servers answer with it.
 */
export function connectionRefusal(toolName: string, wire: ConnectionScopeWire | undefined): string {
  if (!wire) return `The tool "${toolName}" is not available to this connection.`;
  if (wire.unavailable) return wire.unavailable;
  return (
    `The tool "${toolName}" is not available to this connection: it is connected as the agent ` +
    `"${wire.agent.name}" (\`${wire.agent.path}\`), which does not load it.`
  );
}

/**
 * The one line an agent is told about its connection (the MCP handshake, the
 * agent guide); null for Everything, which is told nothing new.
 */
export function describeConnection(wire: ConnectionScopeWire | undefined): string | null {
  if (!wire) return null;
  if (wire.unavailable) return wire.unavailable;
  return (
    `This connection is connected as the agent "${wire.agent.name}" (\`${wire.agent.path}\`): it loads only the ` +
    'platform tools, connectors, skills and plugins that file lists, and of those only what you may read.'
  );
}
