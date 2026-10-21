import { ConnectionScope } from './connection-scope.js';

/** One `.agent` file a person may connect as — a row of the "Connect as" choice. */
export interface AgentChoice {
  /** Repo-relative path of the file — what a connection records. */
  path: string;
  /** Its `name`, else its base name. */
  name: string;
  /** Its `description`, one line; empty when it has none. */
  description: string;
}

/**
 * The connection-scope mechanism: which `.agent` files a person may connect
 * as, and what a connection made as one may load right now.
 *
 * Every agent surface resolves its caller's scope here, with the agent path
 * its credential carries — a connection key's `api_tokens.agent_path`, an
 * agent connection's `agent_connections.agent_path` — and asks the scope;
 * none reads an `.agent` file itself.
 */
export interface IAgentScopeResolver {
  /**
   * The scope of a connection made as `agentPath` for the person `userEmail`.
   * No path is Everything. The file is read, through the person's read gate,
   * on EVERY call — the connection follows the file, not a copy of it — and a
   * file that is missing, unreadable to the person or not a valid agent
   * definition yields a scope that loads nothing, never Everything.
   */
  resolve(userEmail: string | undefined, agentPath: string | null | undefined): Promise<ConnectionScope>;
  /**
   * The `.agent` files on the default branch `userEmail` may read, by name —
   * what the consent step and the key-mint dialog offer below Everything.
   */
  listChoices(userEmail: string): Promise<AgentChoice[]>;
  /**
   * `agentPath` normalized when it is one of {@link listChoices}' paths, else
   * null — one answer for a file that does not exist and one the person may
   * not read, so a refused choice says nothing about either.
   */
  choosable(userEmail: string, agentPath: string): Promise<string | null>;
}

/**
 * The scope of a caller whose credential connects as `agentPath` — THE way
 * every agent surface turns a credential into a scope. No path is
 * Everything, without asking anything. A path with no resolver to read it
 * (a construction that wired none) loads nothing: a narrowing that cannot be
 * read is never read as Everything.
 */
export async function resolveConnectionScope(
  resolver: Pick<IAgentScopeResolver, 'resolve'> | undefined,
  userEmail: string | undefined,
  agentPath: string | null | undefined,
): Promise<ConnectionScope> {
  if (!agentPath) return ConnectionScope.everything();
  return resolver ? resolver.resolve(userEmail, agentPath) : ConnectionScope.gone(agentPath);
}
