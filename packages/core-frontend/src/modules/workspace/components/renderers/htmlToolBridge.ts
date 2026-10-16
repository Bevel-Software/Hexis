import { createContext, useContext } from 'react';
import { authFetch } from '../../../../lib/api';

/**
 * The app's half of `window.bevel.tools`: what answers an HTML page's tool
 * calls, and what decides when the viewer is asked first.
 *
 * A page's call is answered over the hosted MCP server (`POST /api/mcp`) with
 * the viewer's session, so a page sees and reaches exactly the tools the
 * viewer's own agent does — the same listing, the same refusals, nothing of
 * the enterprise agent's internal tools — and the server records it in the
 * Audit log under the page's path (`X-Bevel-Page`). The four members map to
 * what an agent calls:
 *
 *   searchTools(query)   → `list_tools`, narrowed to the names that contain
 *                          every word of `query` (all of them for an empty one)
 *   toolsInfo(names)     → `tools_info`
 *   callTool(name, args) → `tools/call`
 *   callToolChain(code)  → `call_tool_chain`
 *
 * A call that only reads runs at once. A call that may write — a tool the
 * deployment's UTCP manual tags `write`, a tool the manual does not list (a
 * `.tool`'s, a plugin's MCP server's: nothing says they only read), and every
 * chain (a chain may call writers) — waits for the viewer's answer to one
 * card per page view. See {@link PageConsent}.
 */

/** What the file page tells the HTML renderer: that tools are answered here, and for which page. */
export interface PageTools {
  /** The page's knowledge-base path (`Dashboards/Roadmap.html`), what the Audit log shows as the agent. */
  pagePath: string;
}

/**
 * Provided by the app's file page and nowhere else: its presence is what
 * gives a page `window.bevel.tools`. The embed, a skill page and every other
 * preview mount the renderer without it, and their pages get `null`.
 */
export const PageToolsContext = createContext<PageTools | null>(null);

export function usePageTools(): PageTools | null {
  return useContext(PageToolsContext);
}

/**
 * How to open the page on the app's file page, for a host whose `filePath` is
 * not a workspace path — a skill page names its files relative to the skill
 * (`view.html`). Absent, the renderer opens its own `filePath` (the embed's
 * surface does that in a new tab, through its host).
 */
export const OpenPageInPlatformContext = createContext<(() => void) | null>(null);

export function useOpenPageInPlatform(): (() => void) | null {
  return useContext(OpenPageInPlatformContext);
}

/** The four members a page calls, by the name the frame posts. */
export type PageToolFunction = 'searchTools' | 'toolsInfo' | 'callTool' | 'callToolChain';

const PAGE_TOOL_FUNCTIONS: ReadonlySet<string> = new Set(['searchTools', 'toolsInfo', 'callTool', 'callToolChain']);

/** The code-mode meta-tools by the name a page may also `callTool` them under: two read, the chain may write. */
const READING_META_TOOLS: ReadonlySet<string> = new Set(['list_tools', 'tools_info']);
const CHAIN_TOOL = 'call_tool_chain';

/** The answer a page gets when its viewer chose Deny. */
export const DENIED = 'denied';

/** A tool call's failure, as the page receives it: the message, and a code for the cases a page may handle. */
export class PageToolError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'PageToolError';
    this.code = code;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One MCP `CallToolResult`, as much of it as the bridge reads. */
interface CallToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/**
 * The viewer's tools for one page: MCP calls with the session, and the read
 * of which tools write.
 */
export class PageToolsClient {
  private seq = 0;
  private writing: Promise<Map<string, boolean> | null> | undefined;
  private readonly pagePath: string;
  private readonly fetchImpl: Fetch;

  constructor(pagePath: string, fetchImpl: Fetch = authFetch) {
    this.pagePath = pagePath;
    this.fetchImpl = fetchImpl;
  }

  /** `list_tools`' names, narrowed to those containing every word of `query`. */
  async searchTools(query: unknown): Promise<{ tools: string[] }> {
    const listed = (await this.callTool('list_tools', {})) as { tools?: unknown };
    const names = Array.isArray(listed?.tools) ? listed.tools.filter((n): n is string => typeof n === 'string') : [];
    const words = String(query ?? '')
      .toLowerCase()
      .split(/[\s_.]+/)
      .filter(Boolean);
    const fold = (n: string) => n.toLowerCase().replace(/[_.]+/g, ' ');
    return { tools: words.length === 0 ? names : names.filter((n) => words.every((w) => fold(n).includes(w))) };
  }

  /** `tools_info` for `names`. */
  toolsInfo(names: unknown): Promise<unknown> {
    return this.callTool('tools_info', { tool_names: names });
  }

  /** `call_tool_chain` with `code`. */
  callToolChain(code: unknown): Promise<unknown> {
    return this.callTool(CHAIN_TOOL, { code });
  }

  /**
   * `tools/call`, answered the way the page reads it: the tool's structured
   * content when it has some, else its text — parsed when it is JSON. A tool
   * that answers with an error, or a request the server refuses, rejects
   * with the tool's (or the server's) own message.
   */
  async callTool(name: unknown, args: unknown): Promise<unknown> {
    if (typeof name !== 'string' || name === '') throw new PageToolError('callTool needs a tool name.');
    const params = { name, arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} };
    return toPageResult((await this.rpc('tools/call', params)) as CallToolResult);
  }

  /**
   * Whether a call may write, and so needs the viewer's consent: a chain, a
   * tool the manual tags `write`, or a tool the manual does not list. When the
   * manual cannot be read, everything but the two reading meta-tools counts
   * as writing — the card shows once more than it had to, never once less.
   */
  async mayWrite(fn: PageToolFunction, args: unknown[]): Promise<boolean> {
    if (fn === 'searchTools' || fn === 'toolsInfo') return false;
    if (fn === 'callToolChain') return true;
    const name = args[0];
    if (typeof name !== 'string') return false; // refused by callTool itself, before anything runs
    if (READING_META_TOOLS.has(name)) return false;
    if (name === CHAIN_TOOL) return true;
    const writing = await this.writingTools();
    const tagged = writing?.get(name);
    return tagged === undefined ? true : tagged;
  }

  /** Tell the server the viewer refused this page a call, for the Audit log. Best-effort. */
  async recordRefusal(name: string, args: unknown): Promise<void> {
    try {
      await this.fetchImpl('/api/mcp/page-refusals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: this.pagePath, tool: name, args: args && typeof args === 'object' ? args : {} }),
      });
    } catch {
      // The refusal stands whether or not the log heard of it.
    }
  }

  /** The deployment's UTCP manual, read once: tool name → whether it is tagged `write`. */
  private writingTools(): Promise<Map<string, boolean> | null> {
    this.writing ??= this.fetchImpl('/api/agent/utcp')
      .then(async (res) => {
        if (!res.ok) return null;
        const manual = (await res.json()) as { tools?: Array<{ name?: unknown; tags?: unknown }> };
        const map = new Map<string, boolean>();
        for (const tool of manual.tools ?? []) {
          if (typeof tool.name !== 'string') continue;
          const tags = Array.isArray(tool.tags) ? tool.tags : [];
          // The manual names a tool bare or under its namespace; the page calls it bare.
          map.set(tool.name.slice(tool.name.lastIndexOf('.') + 1), tags.includes('write'));
        }
        return map;
      })
      .catch(() => null);
    return this.writing;
  }

  /** One JSON-RPC request to the hosted MCP server, as this page. */
  private async rpc(method: string, params: unknown): Promise<unknown> {
    this.seq += 1;
    const id = this.seq;
    const res = await this.fetchImpl('/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Bevel-Page': encodeURIComponent(this.pagePath),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const messages = await readMessages(res);
    const answer = messages.find((m) => m.id === id) ?? messages[0];
    if (!answer) throw new PageToolError(`The tool server answered HTTP ${res.status} with nothing to read.`);
    if (answer.error) throw new PageToolError(String(answer.error.message ?? 'The tool server refused the call.'));
    return answer.result;
  }
}

interface RpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

/** The JSON-RPC messages in a response, whether it came back as one JSON body or as a stream of events. */
async function readMessages(res: Response): Promise<RpcMessage[]> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .flatMap((line) => {
        try {
          return [JSON.parse(line.slice('data:'.length)) as RpcMessage];
        } catch {
          return [];
        }
      });
  }
  try {
    return [JSON.parse(text) as RpcMessage];
  } catch {
    return [];
  }
}

/** A tool result as a page reads it. */
function toPageResult(result: CallToolResult | undefined): unknown {
  const text = (result?.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
  if (result?.isError) throw new PageToolError(text || 'The tool failed.');
  if (result?.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The viewer's answer about one page view's writes: asked once, on the first
 * writing call, and held until the page is reloaded or left (a new instance).
 *
 * Allow holds: every later writing call runs without a card. Deny does not:
 * it answers the calls that were waiting on that card, and the next writing
 * call asks again. Calls that arrive while the card is open wait on that same
 * card, so a page that fires ten writes at once sees one card, and every one
 * of the ten gets the answer.
 */
export class PageConsent {
  private allowed = false;
  private asking: Promise<boolean | null> | null = null;
  private readonly ask: () => Promise<boolean | null>;

  /** `ask` shows the card: true for Allow, false for Deny, null when the view ended with the card still open. */
  constructor(ask: () => Promise<boolean | null>) {
    this.ask = ask;
  }

  /** Whether a card is open right now — no call of the page runs while it is. */
  get open(): Promise<boolean | null> | null {
    return this.asking;
  }

  /** Whether the viewer allows this page to write, asking them if no answer holds; null when nobody answered. */
  request(): Promise<boolean | null> {
    if (this.allowed) return Promise.resolve(true);
    this.asking ??= this.ask().then(
      (ok) => {
        this.asking = null;
        if (ok) this.allowed = true;
        return ok;
      },
      () => {
        this.asking = null;
        return null;
      },
    );
    return this.asking;
  }
}

/** A frame's message asking for a tool call. */
export interface ToolCallMessage {
  type: 'bevel.tool.call';
  requestId: string;
  fn: PageToolFunction;
  args: unknown[];
}

/** What goes back to the frame. */
export type ToolCallResponse =
  | { type: 'bevel.tool.response'; requestId: string; ok: true; result: unknown }
  | { type: 'bevel.tool.response'; requestId: string; ok: false; error: string; code?: string };

/** The frame's message, when it is a well-formed tool call; null otherwise. */
export function asToolCall(data: unknown): ToolCallMessage | null {
  if (!data || typeof data !== 'object') return null;
  const msg = data as Partial<ToolCallMessage>;
  if (msg.type !== 'bevel.tool.call' || typeof msg.requestId !== 'string') return null;
  if (typeof msg.fn !== 'string' || !PAGE_TOOL_FUNCTIONS.has(msg.fn)) return null;
  return { type: 'bevel.tool.call', requestId: msg.requestId, fn: msg.fn, args: Array.isArray(msg.args) ? msg.args : [] };
}

/**
 * Answer one of a page's tool calls: wait out an open card, ask for consent
 * when the call may write, run it, and say how it went. Never throws — every
 * outcome is a response for the frame.
 */
export async function answerToolCall(
  msg: ToolCallMessage,
  client: PageToolsClient,
  consent: PageConsent,
): Promise<ToolCallResponse> {
  const fail = (error: string, code?: string): ToolCallResponse => ({
    type: 'bevel.tool.response',
    requestId: msg.requestId,
    ok: false,
    error,
    ...(code ? { code } : {}),
  });
  try {
    if (await client.mayWrite(msg.fn, msg.args)) {
      // A write that arrives while the card is open joins it, and gets its answer.
      const allowed = await consent.request();
      // The view ended before the viewer chose: nothing ran, and nobody refused.
      if (allowed === null) return fail('The page was closed before the viewer answered.', 'closed');
      if (!allowed) {
        const name = msg.fn === 'callToolChain' ? CHAIN_TOOL : String(msg.args[0] ?? '');
        const args = msg.fn === 'callToolChain' ? { code: msg.args[0] } : msg.args[1];
        void client.recordRefusal(name, args);
        return fail(DENIED, DENIED);
      }
    } else {
      // Nothing of the page runs while the viewer is being asked about it.
      while (consent.open) await consent.open;
    }
    const [a, b] = msg.args;
    const result =
      msg.fn === 'searchTools'
        ? await client.searchTools(a)
        : msg.fn === 'toolsInfo'
          ? await client.toolsInfo(a)
          : msg.fn === 'callToolChain'
            ? await client.callToolChain(a)
            : await client.callTool(a, b);
    return { type: 'bevel.tool.response', requestId: msg.requestId, ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), err instanceof PageToolError ? err.code : undefined);
  }
}

/** A page's display name: its file name without the extension. */
export function pageName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}
