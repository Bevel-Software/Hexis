import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { printable } from '@bevel-software/platform-mcp-core';

/**
 * Who is running this local server — learned from the MCP handshake.
 *
 * The agent that spawned this process (Claude Code, Cursor, Codex, …) is
 * the thing a person sees on the deployment's Audit log and the thing they
 * revoke; "hexis-mcp on <hostname>" told them neither which agent it was nor
 * let two agents on one machine be told apart. The very first message an MCP
 * client sends is `initialize`, and it carries `clientInfo` — the client's
 * own name and version. That is the identity a browser sign-in registers
 * under, and what keys the stored credential, so each agent signs in once
 * and gets its own row. A client that names itself to nobody gets a GUESS
 * from the process tree instead (parent-process.ts), marked as such; only
 * when that fails too does the sign-in say "Unknown agent".
 *
 * The catch is ordering: the sign-in has to happen BEFORE the handshake is
 * answered (the deployment's agent instructions ride the `initialize`
 * result and need the credential), yet the identity arrives IN the
 * handshake. So the transport is started early, the `initialize` request is
 * held (with anything that follows it), the sign-in runs with the identity
 * in hand, and the held messages are replayed to the server once it exists.
 * From the client's side this is the same wait a first keyless run always
 * was — the response to `initialize` arrives once the person has signed in.
 */

export interface AgentIdentity {
  /** `clientInfo.name` as the client sent it, e.g. `claude-code` — or, when guessed, the program that spawned this server. */
  name: string;
  version?: string;
  /**
   * True when the client named itself to nobody and the name is the parent
   * program's (see parent-process.ts). Said on stderr at sign-in, so a wrong
   * guess can be traced to its source.
   */
  guessed?: boolean;
}

/**
 * How the well-known clients name themselves in `clientInfo`, and what a
 * person calls them. Anything else is shown title-cased from the raw name,
 * so an unknown client still reads as a name rather than an identifier.
 */
const KNOWN_AGENTS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  'claude-ai': 'Claude',
  cursor: 'Cursor',
  'cursor-vscode': 'Cursor',
  windsurf: 'Windsurf',
  cline: 'Cline',
  codex: 'Codex',
  'codex-mcp-client': 'Codex',
  'gemini-cli-mcp-client': 'Gemini CLI',
  'gemini-cli': 'Gemini CLI',
  'visual studio code': 'VS Code',
  // Program names, for an identity guessed from the parent process. `claude`
  // is both the Claude Desktop app and the Claude Code CLI on disk, so the
  // guess can only say "Claude".
  claude: 'Claude',
  code: 'VS Code',
  'code - insiders': 'VS Code',
  codium: 'VSCodium',
  zed: 'Zed',
};

/** "Claude Code", "Cursor" — the agent as a person names it. */
export function agentDisplayName(agent: AgentIdentity): string {
  const key = agent.name.trim().toLowerCase();
  const known = KNOWN_AGENTS[key];
  if (known) return known;
  const words = agent.name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1));
  return words.length ? words.join(' ') : 'Unknown agent';
}

/**
 * The agent's part of a stored-credential file name: lowercase, one hyphen
 * per run of anything else, bounded — a file name, not a display name.
 */
export function agentStoreKey(agent: AgentIdentity): string {
  const slug = agent.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'agent').slice(0, 40);
}

/**
 * What a browser sign-in registers this server as with the deployment — the
 * name the Audit log then shows for the connection. With an agent known or
 * guessed: "Claude Code · local server on LAPTOP-1". With none at all: the
 * truth, "Unknown agent · local server on LAPTOP-1". It used to say
 * "hexis-mcp on LAPTOP-1", which read as if the local server itself were the
 * agent — the one thing the Audit log must never suggest.
 */
export function registrationName(agent: AgentIdentity | null, host: string): string {
  return `${agent ? agentDisplayName(agent) : 'Unknown agent'} · local server on ${host}`;
}

/**
 * The one stderr line that says who this server is signing in as and where
 * that came from — so a wrong name on the Audit log can be traced in the
 * client's server log, instead of being a mystery for a week.
 */
export function identityLine(agent: AgentIdentity | null, host: string, version: string): string {
  // The client's name and version, and the host name, are not ours: each is
  // rendered `printable`, so a newline or an escape in them cannot forge a
  // second log line or paint the terminal.
  const as = `signing in as ${printable(registrationName(agent, host))}`;
  const from = !agent
    ? 'the client named itself to nobody and no parent process could be read'
    : agent.guessed
      ? `guessed from the parent process (${printable(agent.name)}); the client named itself to nobody`
      : `named by the client's handshake (${printable(agent.name)}${agent.version ? ` ${printable(agent.version)}` : ''})`;
  return `[hexis-mcp ${version}] ${as} — ${from}`;
}

/** The agent an `initialize` request names, or null for any other message or a nameless client. */
export function agentFromInitialize(message: JSONRPCMessage): AgentIdentity | null {
  const request = message as { method?: unknown; params?: { clientInfo?: { name?: unknown; version?: unknown } } };
  if (request.method !== 'initialize') return null;
  const name = request.params?.clientInfo?.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  const version = request.params?.clientInfo?.version;
  return { name, ...(typeof version === 'string' && version ? { version } : {}) };
}

interface HeldMessage {
  message: JSONRPCMessage;
  extra?: MessageExtraInfo;
}

export interface HeldHandshake {
  /** Who sent `initialize`; null when the first message was not one, named no client, or the client hung up first. */
  agent: AgentIdentity | null;
  /** The transport to hand the server: already started, replaying what was held once the server listens. */
  transport: Transport;
}

export interface HoldOptions {
  /**
   * Resolves when the client has let go — stdin's `end`/`close` for the
   * stdio transport, which fires `onclose` only from its own `close()` and
   * never on EOF. Without it a client that spawns the server and dies before
   * saying anything would leave the hold waiting forever.
   */
  hangUp?: Promise<void>;
}

/**
 * Start `inner`, wait for the client's first message, and hand back a
 * transport the server can `connect()` as if nothing had happened.
 *
 * Every message that arrives before the server exists is kept, in order,
 * and delivered on the wrapper's `start()` — which the SDK calls only after
 * it has installed its own `onmessage`, so nothing is delivered into the
 * void. A client that hangs up before saying anything resolves with no
 * agent; the caller's let-go handling sees the closed stdin and leaves.
 */
export async function holdInitialize(inner: Transport, options: HoldOptions = {}): Promise<HeldHandshake> {
  const held: HeldMessage[] = [];
  let settled = false;
  let settle: (agent: AgentIdentity | null) => void = () => {};
  const first = new Promise<AgentIdentity | null>((resolve) => {
    settle = (agent) => {
      if (settled) return;
      settled = true;
      resolve(agent);
    };
  });
  const wrapper = new ReplayingTransport(inner, held, (message) => settle(agentFromInitialize(message)), () =>
    settle(null),
  );
  options.hangUp?.then(() => settle(null), () => settle(null));
  await inner.start();
  return { agent: await first, transport: wrapper };
}

/**
 * The transport the server is given in place of the one already started:
 * it forwards everything, and `start()` — a no-op for the inner transport,
 * which would refuse a second start — becomes the moment the held messages
 * are replayed. Until then anything the client sends is held too.
 */
class ReplayingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  private listening = false;

  constructor(
    private readonly inner: Transport,
    private readonly held: HeldMessage[],
    onFirstMessage: (message: JSONRPCMessage) => void,
    onClosedEarly: () => void,
  ) {
    inner.onmessage = (message, extra) => {
      if (!this.listening) {
        this.held.push({ message, extra });
        onFirstMessage(message);
        return;
      }
      this.onmessage?.(message, extra);
    };
    inner.onclose = () => {
      onClosedEarly();
      this.onclose?.();
    };
    inner.onerror = (error) => this.onerror?.(error);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  async start(): Promise<void> {
    this.listening = true;
    for (const { message, extra } of this.held.splice(0)) this.onmessage?.(message, extra);
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
