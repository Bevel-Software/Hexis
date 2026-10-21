import { withinEntry } from './agent-file.js';

/** The agent a connection was made as, by the file that defines it. */
export interface ScopeAgent {
  /** Repo-relative path of the `.agent` file. */
  path: string;
  /** Its name — the frontmatter `name`, else the file's base name; the path when the file cannot be read. */
  name: string;
}

/**
 * What a connection's scope says about itself on the wire — the `connection`
 * field of `GET /api/agent/all-tools` and `GET /api/agent/catalog-revision`,
 * which the MCP proxy (hosted and local) reads to word its listing, its
 * refusals and its handshake text. Absent for Everything.
 */
export interface ConnectionScopeWire {
  agent: ScopeAgent;
  /** Set when the connection loads nothing because its file cannot be used: the one sentence saying why. */
  unavailable?: string;
}

/**
 * The answer to a call of `toolName` that the connection described by
 * `wire` does not load: names the tool and the agent, so the caller knows
 * the tool was refused by the connection's choice and not missing from the
 * deployment; for a file that cannot be used, the sentence that says why.
 * The ONE wording — the tool route and the MCP proxy both answer with it.
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

/**
 * The resolved roots a usable `.agent` file narrows a connection to — what
 * {@link ConnectionScope.narrowed} is built from.
 */
export interface ScopeRoots {
  /** Skill folders and subtrees: the `skills:` entries, each plugin folder, and the skills its manifest links. */
  skills: readonly string[];
  /** Connector files and subtrees: the `connectors:` entries and each plugin folder. */
  connectors: readonly string[];
  /** Platform tool names; null for all of them. */
  platformTools: readonly string[] | null;
}

type State =
  | { kind: 'everything' }
  | { kind: 'narrowed'; agent: ScopeAgent; roots: ScopeRoots; fingerprint: string }
  | { kind: 'unavailable'; agent: ScopeAgent; sentence: string; fingerprint: string };

/**
 * What one connection may load — the ONE answer every agent surface asks
 * (`all-tools`, the `/agent/utcp` manual, the tool route, the skill tools,
 * the setup tools, the catalog revision). Everything is the scope of every
 * connection made without a choice, and asks nothing of anyone: each of its
 * predicates is true, so a surface that consults it serves exactly what it
 * served before connections could be narrowed.
 *
 * A scope only ever NARROWS. It is applied to what the person may already
 * read — each surface asks it about items that passed the person's own read
 * gate — so no list in an `.agent` file can add an item to a connection.
 */
export class ConnectionScope {
  private constructor(private readonly state: State) {}

  static everything(): ConnectionScope {
    return new ConnectionScope({ kind: 'everything' });
  }

  static narrowed(agent: ScopeAgent, roots: ScopeRoots, fingerprint: string): ConnectionScope {
    return new ConnectionScope({ kind: 'narrowed', agent, roots, fingerprint });
  }

  /** A chosen file that cannot be used: nothing at all is loaded, and `sentence` says why. */
  static unavailable(agent: ScopeAgent, sentence: string, fingerprint: string): ConnectionScope {
    return new ConnectionScope({ kind: 'unavailable', agent, sentence, fingerprint });
  }

  /**
   * A chosen file that is not there for the person — missing, or one they may
   * no longer read: ONE answer for both, so the sentence discloses neither.
   */
  static gone(agentPath: string): ConnectionScope {
    return ConnectionScope.unavailable(
      { path: agentPath, name: agentPath },
      `This connection was made as the agent file \`${agentPath}\`, which no longer exists or which you can no ` +
        'longer read, so it loads no tools and no skills. Reconnect and choose another agent, or Everything.',
      `agent\u0000${agentPath}\u0000gone`,
    );
  }

  /** True for Everything: the connection was made without choosing an agent. */
  isEverything(): boolean {
    return this.state.kind === 'everything';
  }

  /** Whether the skill in `skillFolder` (repo-relative) is loaded. */
  allowsSkill(skillFolder: string): boolean {
    const s = this.state;
    if (s.kind === 'everything') return true;
    if (s.kind === 'unavailable') return false;
    return s.roots.skills.some((root) => withinEntry(root, skillFolder));
  }

  /** Whether the connector defined at `definitionPath` (a `.tool` file or an MCP server definition) is loaded. */
  allowsConnector(definitionPath: string): boolean {
    const s = this.state;
    if (s.kind === 'everything') return true;
    if (s.kind === 'unavailable') return false;
    return s.roots.connectors.some((root) => withinEntry(root, definitionPath));
  }

  /**
   * Whether any connector this connection loads is defined in `folder`
   * (repo-relative) or in a folder that contains it — what a plugin's
   * archive asks, since the local MCP server materializes a plugin only to
   * run a connector it defines.
   */
  loadsConnectorIn(folder: string): boolean {
    const s = this.state;
    if (s.kind === 'everything') return true;
    if (s.kind === 'unavailable') return false;
    return s.roots.connectors.some((root) => withinEntry(root, folder) || withinEntry(folder, root));
  }

  /**
   * {@link allowsSkill} as the narrowing a skill listing takes, or undefined
   * for Everything — so an Everything caller's listing runs exactly the code
   * it ran before connections could be narrowed.
   */
  skillFilter(): ((skillFolder: string) => boolean) | undefined {
    return this.state.kind === 'everything' ? undefined : (p) => this.allowsSkill(p);
  }

  /** {@link allowsConnector} as the narrowing a catalog read takes, or undefined for Everything. */
  connectorFilter(): ((definitionPath: string) => boolean) | undefined {
    return this.state.kind === 'everything' ? undefined : (p) => this.allowsConnector(p);
  }

  /**
   * Whether the connection's prompts may be read: its skills, served as MCP
   * prompts. Not a platform tool, so `platformTools` has no say — an agent
   * that names skills gets them as prompts whatever tools it is offered. False
   * only for a file that cannot be used, which loads nothing at all.
   */
  allowsPrompts(): boolean {
    return this.state.kind !== 'unavailable';
  }

  /** Whether the platform's own tool `name` is loaded. */
  allowsPlatformTool(name: string): boolean {
    const s = this.state;
    if (s.kind === 'everything') return true;
    if (s.kind === 'unavailable') return false;
    return s.roots.platformTools === null || s.roots.platformTools.includes(name);
  }

  /**
   * The answer to a call of `toolName`, a tool this connection does not load:
   * names the tool and the agent, so the caller knows the tool was refused by
   * the connection's choice and not missing from the deployment. For a file
   * that cannot be used, the sentence that says why.
   */
  refusal(toolName: string): string {
    return connectionRefusal(toolName, this.toWire());
  }

  /**
   * One line for the text an agent is told about its connection (the MCP
   * handshake, the agent guide); null for Everything, which is told nothing
   * new.
   */
  describe(): string | null {
    return describeConnection(this.toWire());
  }

  /**
   * What moves the catalog revision when the agent's FILE changes — its path
   * and a digest of its bytes, or the reason it cannot be used. Null for
   * Everything, whose revision is exactly what it was before agents existed.
   */
  fingerprint(): string | null {
    const s = this.state;
    return s.kind === 'everything' ? null : s.fingerprint;
  }

  /** See {@link ConnectionScopeWire}; undefined for Everything. */
  toWire(): ConnectionScopeWire | undefined {
    const s = this.state;
    if (s.kind === 'everything') return undefined;
    if (s.kind === 'unavailable') return { agent: s.agent, unavailable: s.sentence };
    return { agent: s.agent };
  }
}
