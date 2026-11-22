import {
  BOT_ONLY_TOOLS,
  NOT_AVAILABLE_TO_CONNECTION,
  connectionRefusal,
  describeConnection,
  type ConnectionScopeWire,
  type ScopeAgent,
} from '@bevel-software/platform-mcp-core';

// The wire and its words are the MCP core's (`connection-scope-wire.ts`),
// so the hosted proxy and the local server read and word a connection the
// same way; offered here too, as this module's callers learnt them.
export { NOT_AVAILABLE_TO_CONNECTION, connectionRefusal, describeConnection, type ConnectionScopeWire, type ScopeAgent };

type State =
  | { kind: 'myself' }
  | { kind: 'bot'; agent: ScopeAgent; platformTools: readonly string[] | null; fingerprint: string }
  | { kind: 'unavailable'; agent: ScopeAgent; sentence: string; fingerprint: string };

/**
 * What one connection may load — the ONE answer every agent surface asks
 * (`all-tools`, the `/agent/utcp` manual, the tool route, the skill tools,
 * the setup tools, the catalog revision). Resolved once per call, by the
 * credential verifier, from whom the connection was made as (`modules/bots`):
 *
 *  - Myself: the person who made it. Every predicate is true, so a surface
 *    serves exactly what it served before connections could be made as bots.
 *  - A bot: the call is ALREADY judged for the bot's own row — the verifier
 *    put the bot's identity on the request — so the scope narrows nothing
 *    but the platform tools the distribution offers the bot.
 *  - Unavailable: the bot cannot be used, or its maker may no longer act as
 *    it. Nothing at all is loaded, and the sentence says why. Never the
 *    person's access.
 */
export class ConnectionScope {
  private constructor(private readonly state: State) {}

  /** A connection made as the person themselves. */
  static myself(): ConnectionScope {
    return new ConnectionScope({ kind: 'myself' });
  }

  /** A connection made as a usable bot, offered `platformTools` (null: all of them). */
  static asBot(agent: ScopeAgent, platformTools: readonly string[] | null, fingerprint: string): ConnectionScope {
    return new ConnectionScope({ kind: 'bot', agent, platformTools, fingerprint });
  }

  /** A connection made as a bot that cannot be used now: nothing at all is loaded, and `sentence` says why. */
  static unavailable(agent: ScopeAgent, sentence: string, fingerprint: string): ConnectionScope {
    return new ConnectionScope({ kind: 'unavailable', agent, sentence, fingerprint });
  }

  /** True for Myself: the connection acts as the person who made it. */
  isMyself(): boolean {
    return this.state.kind === 'myself';
  }

  /**
   * True while the connection loads anything at all: every skill, connector
   * and plugin its actor may read (a bot's connection is already judged for
   * the bot), or — for a bot that cannot be used — nothing.
   */
  loadsAnything(): boolean {
    return this.state.kind !== 'unavailable';
  }

  /** The narrowing a skill listing takes: undefined when it narrows nothing, else one that admits nothing. */
  skillFilter(): ((skillFolder: string) => boolean) | undefined {
    return this.loadsAnything() ? undefined : () => false;
  }

  /** The narrowing a catalog read takes: undefined when it narrows nothing, else one that admits nothing. */
  connectorFilter(): ((definitionPath: string) => boolean) | undefined {
    return this.loadsAnything() ? undefined : () => false;
  }

  /**
   * Whether the connection's surface may be discovered: its skills read as
   * MCP prompts, and its local-only connectors read by the local server.
   * False only for a connection that loads nothing.
   */
  allowsDiscovery(): boolean {
    return this.loadsAnything();
  }

  /**
   * Whether the platform's own tool `name` is loaded. Myself loads every
   * platform tool but the bot-only ones (`BOT_ONLY_TOOLS`: approving and
   * applying a change request), which only a connection made as a bot is
   * offered — the one place that decides it, for every listing and every
   * call.
   */
  allowsPlatformTool(name: string): boolean {
    const s = this.state;
    if (s.kind === 'myself') return !BOT_ONLY_TOOLS.has(name);
    if (s.kind === 'unavailable') return false;
    return s.platformTools === null || s.platformTools.includes(name);
  }

  /**
   * The answer to a call of `toolName`, a tool this connection does not load:
   * names the tool and the bot, so the caller knows the tool was refused by
   * the connection's choice and not missing from the deployment. For a bot
   * that cannot be used, the sentence that says why.
   */
  refusal(toolName: string): string {
    return connectionRefusal(toolName, this.toWire());
  }

  /**
   * THE policy for a call of the platform tool `toolName` by this connection:
   * null when the call may proceed, else the body the route answers with a
   * 403 — the refusal naming the tool and the bot, and the code that says it
   * was the connection's choice. `discovery` marks a route that is a
   * discovery read of the surface (the skill routes, the local-only tool
   * list), answered to a bot whatever tools it is offered; a connection that
   * loads nothing is refused it like everything else.
   */
  platformToolRefusal(
    toolName: string,
    opts: { discovery?: boolean } = {},
  ): { error: string; code: typeof NOT_AVAILABLE_TO_CONNECTION } | null {
    if (this.allowsPlatformTool(toolName)) return null;
    if (opts.discovery === true && this.allowsDiscovery()) return null;
    return { error: this.refusal(toolName), code: NOT_AVAILABLE_TO_CONNECTION };
  }

  /** One line for what an agent is told about its connection; null for Myself, which is told nothing new. */
  describe(): string | null {
    return describeConnection(this.toWire());
  }

  /**
   * What moves the catalog revision when whom the connection acts as
   * changes; null for Myself, whose revision is what it was before bots.
   */
  fingerprint(): string | null {
    const s = this.state;
    return s.kind === 'myself' ? null : s.fingerprint;
  }

  /** See {@link ConnectionScopeWire}; undefined for Myself. */
  toWire(): ConnectionScopeWire | undefined {
    const s = this.state;
    if (s.kind === 'myself') return undefined;
    if (s.kind === 'unavailable') return { agent: s.agent, unavailable: s.sentence };
    return { agent: s.agent };
  }
}
