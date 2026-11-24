/**
 * What a connection's scope says about itself on the wire, and the words
 * both MCP servers — the hosted proxy and the local `hexis-mcp` — build from
 * it: the handshake line, the refusal of a tool the connection does not
 * load, and the sentence a connection that loads nothing carries. ONE
 * module, so the two servers cannot word the same connection differently.
 *
 * The deployment puts the wire on `GET /api/agent/all-tools` and
 * `GET /api/agent/catalog-revision` as their `connection` field; absent for
 * a connection made as Myself, which is told nothing new.
 */

/** The `code` beside a refusal of what the caller's connection does not load. */
export const NOT_AVAILABLE_TO_CONNECTION = 'not_available_to_connection';

/**
 * Where the sentence saying why a connection loads nothing rides a
 * `tools/list` answer: the listing has no description of its own, and an
 * empty `tools` array alone would read as an outage.
 */
export const CONNECTION_META_KEY = 'software.bevel.hexis/connection';

/**
 * The platform tools offered ONLY to a connection made as a bot: approving
 * and applying a change request. A bot is an identity of its own, granted
 * like a person, and may approve and apply where its grants allow; an agent
 * acting as a person proposes, and the person reviews and applies in the
 * app. A connection made as Myself is never offered these, and a call is
 * refused with {@link connectionRefusal}'s sentence for them.
 */
export const BOT_ONLY_TOOLS: ReadonlySet<string> = new Set(['approve_change_request', 'apply_change_request']);

/** The bot a connection was made as. */
export interface ScopeAgent {
  /**
   * How the bot is addressed: its address (`<id>@agent.hexis`), or what
   * the connection recorded when the bot cannot be found. Named `path` on the
   * wire because local servers released before bots read it by that name.
   */
  path: string;
  /** The bot's name. */
  name: string;
}

/** The `connection` field of the two deployment answers above. */
export interface ConnectionScopeWire {
  agent: ScopeAgent;
  /** Set when the connection loads nothing because its bot cannot be used: the one sentence saying why. */
  unavailable?: string;
}

/**
 * The wire an answer carries, validated at the boundary: HTTP loses the
 * type. A malformed one is dropped — undefined, the Myself reading — which
 * serves what the answer listed, itself already judged by the deployment's
 * agent surfaces for whom the connection acts as.
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
 * `wire` does not load: names the tool and the bot, so the caller knows
 * the tool was refused by the connection's choice and not missing from the
 * deployment; for a bot that cannot be used, the sentence that says why.
 * The ONE wording — the tool route and both MCP servers answer with it.
 */
export function connectionRefusal(toolName: string, wire: ConnectionScopeWire | undefined): string {
  if (!wire) {
    return BOT_ONLY_TOOLS.has(toolName)
      ? `The tool "${toolName}" is offered only to a connection made as a bot. A change request you propose is reviewed and applied by a person in the app: ask the user to do it there.`
      : `The tool "${toolName}" is not available to this connection.`;
  }
  if (wire.unavailable) return wire.unavailable;
  return (
    `The tool "${toolName}" is not available to this connection: it acts as the bot ` +
    `"${wire.agent.name}" (${wire.agent.path}), which is not offered it.`
  );
}

/**
 * The answer to a call of a tool the surface does not list: on a connection
 * made as a bot, or for a tool offered only to one (a Myself connection
 * calling `approve_change_request`), the connection's refusal, naming why;
 * otherwise an unknown tool. The ONE place both MCP servers decide it, so
 * neither answers "unknown" for a tool the connection merely does not load.
 */
export function unlistedToolAnswer(toolName: string, wire: ConnectionScopeWire | undefined): string {
  return wire || BOT_ONLY_TOOLS.has(toolName) ? connectionRefusal(toolName, wire) : `Unknown tool "${toolName}".`;
}

/**
 * The one line an agent is told about its connection (the MCP handshake, the
 * agent guide); null for Myself, which is told nothing new.
 */
export function describeConnection(wire: ConnectionScopeWire | undefined): string | null {
  if (!wire) return null;
  if (wire.unavailable) return wire.unavailable;
  return (
    `This connection acts as the bot "${wire.agent.name}" (${wire.agent.path}), not as the person who made it: ` +
    "every read, write, skill and tool is judged for the bot's own access, with the bot's secrets and tool sign-ins."
  );
}
