import { ConnectionScope } from './connection-scope.js';

/** One agent configuration a person may connect as — a row of the "Connect as" choice. */
export interface AgentChoice {
  /** Repo-relative path of the configuration — what the connection records. */
  path: string;
  /** Its name, as the choice shows it. */
  name: string;
  /** Its description, one line; empty when it has none. */
  description: string;
}

/**
 * The connection-scope mechanism: which agent configurations a person may
 * connect as, and what a connection made as one may load right now.
 *
 * Core owns the MECHANISM and none of the configurations: what an agent
 * configuration is — the file kind, where it lives, what its definition
 * says — is the distribution's (`CorePorts.agentScope`), exactly as the
 * file kinds whose frontmatter carries access verbs are
 * (`registerAccessFrontmatterExtensions`). Core itself offers no agent to
 * connect as ({@link noAgentConfigurations}): every connection it makes is
 * Everything, and a connection recorded as some path by a distribution that
 * is no longer there loads nothing, never Everything.
 *
 * Every agent surface resolves its caller's scope here, with the agent path
 * its credential carries — a connection key's `api_tokens.agent_path`, an
 * agent connection's `agent_connections.agent_path` — and asks the scope;
 * none reads a configuration itself.
 */
export interface IAgentScopeResolver {
  /**
   * The scope of a connection made as `agentPath` for the person `userEmail`.
   * No path is Everything. The configuration is read, through the person's
   * read gate, on EVERY call — the connection follows the configuration, not
   * a copy of it — and one that is missing, unreadable to the person or not
   * a valid definition yields a scope that loads nothing, never Everything.
   */
  resolve(userEmail: string | undefined, agentPath: string | null | undefined): Promise<ConnectionScope>;
  /**
   * The agent configurations `userEmail` may connect as, by name — what the
   * consent step and the key-mint dialog offer below Everything. Rejects
   * when they cannot be listed at all (the default branch cannot be opened):
   * that is a failed listing, which the caller says, never an empty one.
   */
  listChoices(userEmail: string): Promise<AgentChoice[]>;
  /**
   * `agentPath` normalized when it is one of {@link listChoices}' paths, else
   * null — one answer for a configuration that does not exist and one the
   * person may not read, so a refused choice says nothing about either.
   */
  choosable(userEmail: string, agentPath: string): Promise<string | null>;
}

/**
 * The resolver of a distribution that has no agent configurations — core's
 * own default. Nothing is offered, nothing is choosable, and a recorded path
 * resolves to a scope that loads nothing: a narrowing that cannot be read is
 * never read as Everything.
 */
export function noAgentConfigurations(): IAgentScopeResolver {
  return {
    resolve: async (_userEmail, agentPath) => (agentPath ? ConnectionScope.gone(agentPath) : ConnectionScope.everything()),
    listChoices: async () => [],
    choosable: async () => null,
  };
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
