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
 * Audit log under the page's path (`X-Bevel-Page`). The five members map to
 * what an agent calls:
 *
 *   searchTools(query)        → `list_tools`, narrowed to the names that
 *                               contain every word of `query` (all of them
 *                               for an empty one)
 *   toolsInfo(names)          → `tools_info`
 *   callTool(name, args)      → `tools/call`
 *   callToolChain(code)       → `call_tool_chain`
 *   uploadFile(file, options) → `request_file_upload`, the bytes POSTed to the
 *                               upload endpoint, then `apply_file_upload`
 *
 * A call that only reads runs at once. A call that may write — a tool the
 * deployment's UTCP manual tags `write`, a tool the manual does not list (a
 * `.tool`'s, a plugin's MCP server's: nothing says they only read), every
 * chain (a chain may call writers) and every upload — waits for the viewer's
 * answer to one card per page view. See {@link PageConsent}.
 */

/** What a host that is the platform tells the HTML renderer: that tools are answered here, and for which page. */
export interface PageTools {
  /** The page's knowledge-base path (`Dashboards/Roadmap.html`), what the Audit log shows as the agent. */
  pagePath: string;
}

/**
 * Its presence is what gives a page `window.bevel.tools`. The hosts that
 * provide it — the surfaces the app itself shows a page on, and only those:
 *
 *   - the file page (`FileViewer.tsx`);
 *   - the skill page's file pane (`SkillFilePane.tsx`), under the file's
 *     knowledge-base path — the one the file page uses — never the
 *     skill-relative tab name.
 *
 * Every other mount goes without, and its pages get `null`: the embed and
 * the MCP App pane (outside the platform — they show the "only available in
 * the platform" card), the change-request file preview and the history
 * preview (a page shown as a version, not opened). A new host is added
 * here, deliberately, or not at all.
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

/**
 * The file a page's links resolve against, for a host whose `filePath` is not
 * a workspace path on this tab's branch — a skill page names its files
 * relative to the skill and reads them from the default branch. Absent, a
 * link resolves against `filePath` on the branch this tab stands on.
 */
export interface PageLinkHome {
  /** The page's workspace path. */
  path: string;
  /** The branch the page was read from. */
  branch: string;
}

export const PageLinkHomeContext = createContext<PageLinkHome | null>(null);

export function usePageLinkHome(): PageLinkHome | null {
  return useContext(PageLinkHomeContext);
}

/** The five members a page calls, by the name the frame posts. */
export type PageToolFunction = 'searchTools' | 'toolsInfo' | 'callTool' | 'callToolChain' | 'uploadFile';

const PAGE_TOOL_FUNCTIONS: ReadonlySet<string> = new Set([
  'searchTools',
  'toolsInfo',
  'callTool',
  'callToolChain',
  'uploadFile',
]);

/** The code-mode meta-tools by the name a page may also `callTool` them under: two read, the chain may write. */
const READING_META_TOOLS: ReadonlySet<string> = new Set(['list_tools', 'tools_info']);
const CHAIN_TOOL = 'call_tool_chain';
/** The agent upload path a page's `uploadFile` runs: the token, then the bytes, then the landing. */
const UPLOAD_REQUEST_TOOL = 'request_file_upload';
const UPLOAD_APPLY_TOOL = 'apply_file_upload';

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
 * How long the manual's read of which tools write is trusted. A page stays
 * open for hours; a tool retagged `write` in that time must ask again, not
 * run on the tag the page was opened under.
 */
export const MANUAL_TTL_MS = 60_000;

/**
 * The viewer's tools for one page: MCP calls with the session, and the read
 * of which tools write.
 */
export class PageToolsClient {
  private seq = 0;
  private writing: Promise<Map<string, boolean> | null> | undefined;
  private writingReadAt = 0;
  private readonly pagePath: string;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;

  constructor(pagePath: string, fetchImpl: Fetch = authFetch, now: () => number = Date.now) {
    this.pagePath = pagePath;
    this.fetchImpl = fetchImpl;
    this.now = now;
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
   * Put a file into the knowledge base the way an agent does, with the
   * viewer's session: `request_file_upload` for a token, the file's bytes
   * POSTed as the raw body to the upload endpoint with the token in the
   * `x-upload-token` header (never in the address, and never back to the
   * page), then `apply_file_upload` into `destination` on `branch`.
   *
   * Resolves with what `apply_file_upload` answers, every path listed (the
   * apply is asked with `all: true`). Rejects with the message
   * of the step that failed: the upload endpoint's own (a file over the
   * deployment's limit is refused there, naming it, before the apply runs),
   * or the apply's — thrown whole (a destination the viewer may not write),
   * or, when the upload landed no path at all, the first path's refusal with
   * its code (`exists` under `create`, `missing` under `update`).
   *
   * The token is this call's alone — the page never sees it, so nobody can
   * retry with it — so whenever no apply answered, it is given up at once
   * (`DELETE` on the same endpoint, the token again in the header) and any
   * bytes staged with it are deleted rather than left until it expires. An
   * apply that answered has spent the token itself.
   */
  async uploadFile(file: unknown, options: unknown): Promise<unknown> {
    const opts = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
    if (!(file instanceof Blob)) throw new PageToolError('uploadFile needs a File, or a Blob with a `name` option.');
    const name = typeof opts.name === 'string' && opts.name !== '' ? opts.name : file instanceof File ? file.name : '';
    if (name === '') throw new PageToolError('uploadFile needs a file name: pass a File, or a Blob with a `name` option.');
    const { branch, destination, mode } = opts;
    if (typeof branch !== 'string' || branch === '') throw new PageToolError('uploadFile needs `branch`.');
    if (typeof destination !== 'string' || destination === '') {
      throw new PageToolError('uploadFile needs `destination`, the folder the file lands in.');
    }

    const issued = (await this.callTool(UPLOAD_REQUEST_TOOL, { body: {} })) as { uploadUrl?: unknown; token?: unknown };
    if (typeof issued?.uploadUrl !== 'string' || typeof issued.token !== 'string') {
      throw new PageToolError('The upload could not start: the server answered no upload address.');
    }
    const token = issued.token;
    const address = headerAddress(issued.uploadUrl);
    let answer: { count?: unknown; files?: unknown };
    try {
      const sent = await this.fetchImpl(`${address}?filename=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-upload-token': token },
        body: file,
      });
      if (!sent.ok) throw new PageToolError(await refusalOf(sent));
      // `all: true`: the page gets every path's outcome, never the tool's
      // 25-entry cut with a `truncated` flag it has no way to act on.
      answer = (await this.callTool(UPLOAD_APPLY_TOOL, {
        body: { branch, token, destination, all: true, ...(mode !== undefined ? { mode } : {}) },
      })) as { count?: unknown; files?: unknown };
    } catch (err) {
      await this.discardUpload(address, token);
      throw err;
    }
    const files = Array.isArray(answer?.files) ? (answer.files as Array<Record<string, unknown>>) : [];
    if (answer?.count === 0 && files.length > 0) {
      const refused = files[0]!;
      throw new PageToolError(
        typeof refused.message === 'string' ? refused.message : 'Nothing was written.',
        typeof refused.error === 'string' ? refused.error : undefined,
      );
    }
    return answer;
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
    if (fn === 'callToolChain' || fn === 'uploadFile') return true;
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

  /** Give an unapplied upload token up, with its staged bytes. Best-effort: the refusal stands either way. */
  private async discardUpload(address: string, token: string): Promise<void> {
    try {
      await this.fetchImpl(address, { method: 'DELETE', headers: { 'x-upload-token': token } });
    } catch {
      // Unreached, the token still expires, and its bytes with it.
    }
  }

  /** The deployment's UTCP manual, read at most once a `MANUAL_TTL_MS`: tool name → whether it is tagged `write`. */
  private writingTools(): Promise<Map<string, boolean> | null> {
    const now = this.now();
    if (this.writing && now - this.writingReadAt < MANUAL_TTL_MS) return this.writing;
    this.writingReadAt = now;
    this.writing = this.fetchImpl('/api/agent/utcp')
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

/**
 * The upload endpoint's header-token address: `uploadUrl` without its token
 * segment, on this app's own origin — the server builds `uploadUrl` from its
 * public base URL, which the browser may reach under another name.
 */
function headerAddress(uploadUrl: string): string {
  return new URL(uploadUrl, 'http://app.invalid').pathname.replace(/\/[^/]*$/, '');
}

/** The `{ error }` an HTTP refusal carries, or its status when it carries none. */
async function refusalOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error !== '') return body.error;
  } catch {
    // Not JSON: say what the status says.
  }
  return `The upload was refused (HTTP ${res.status}).`;
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
 *
 * When the view ends the renderer {@link PageConsent.close}s it: from then on
 * nothing asks and nothing is allowed, so a call the old view made that is
 * still being decided when it ends is answered `closed` instead of opening a
 * card in the next view, or running on an Allow the old view gave.
 */
export class PageConsent {
  private allowed = false;
  private ended = false;
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

  /** Whether the view this consent belongs to has ended. */
  get closed(): boolean {
    return this.ended;
  }

  /** The view ended: every request from now on answers null and asks nobody. */
  close(): void {
    this.ended = true;
  }

  /** Whether the viewer allows this page to write, asking them if no answer holds; null when nobody answered or the view ended. */
  request(): Promise<boolean | null> {
    if (this.ended) return Promise.resolve(null);
    if (this.allowed) return Promise.resolve(true);
    this.asking ??= this.ask().then(
      (ok) => {
        this.asking = null;
        if (this.ended) return null;
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
  /** The identity the app minted for the document that posted this (see `htmlSandbox.ts`), when it was given one. */
  documentId?: string;
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
  return {
    type: 'bevel.tool.call',
    requestId: msg.requestId,
    ...(typeof msg.documentId === 'string' ? { documentId: msg.documentId } : {}),
    fn: msg.fn,
    args: Array.isArray(msg.args) ? msg.args : [],
  };
}

const CLOSED_MESSAGE = 'The page was closed before the viewer answered.';

/**
 * Answer one of a page's tool calls: wait out an open card, ask for consent
 * when the call may write, run it, and say how it went. A call whose view
 * ended (its `consent` closed) before it was decided runs nothing and is
 * answered `closed`. Never throws — every outcome is a response for the frame.
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
      if (allowed === null) return fail(CLOSED_MESSAGE, 'closed');
      if (!allowed) {
        const { name, args } = refusedCall(msg);
        void client.recordRefusal(name, args);
        return fail(DENIED, DENIED);
      }
    } else {
      // Nothing of the page runs while the viewer is being asked about it.
      while (consent.open) await consent.open;
    }
    // The view ended while the call was being decided: it is no longer the view's to run.
    if (consent.closed) return fail(CLOSED_MESSAGE, 'closed');
    const [a, b] = msg.args;
    const result =
      msg.fn === 'searchTools'
        ? await client.searchTools(a)
        : msg.fn === 'toolsInfo'
          ? await client.toolsInfo(a)
          : msg.fn === 'callToolChain'
            ? await client.callToolChain(a)
            : msg.fn === 'uploadFile'
              ? await client.uploadFile(a, b)
              : await client.callTool(a, b);
    return { type: 'bevel.tool.response', requestId: msg.requestId, ok: true, result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), err instanceof PageToolError ? err.code : undefined);
  }
}

/**
 * A refused call as the Audit log names it: the tool the page asked for, with
 * the arguments it would have run with. An upload is refused as the
 * `apply_file_upload` it would have ended in: its `body` holds only what that
 * tool takes (no token, since none was asked for), and the file's name — not
 * an argument of the tool, it travels with the bytes — sits beside it as
 * `file`, so the record says what was refused without inventing an argument.
 */
function refusedCall(msg: ToolCallMessage): { name: string; args: unknown } {
  const [a, b] = msg.args;
  if (msg.fn === 'callToolChain') return { name: CHAIN_TOOL, args: { code: a } };
  if (msg.fn === 'uploadFile') {
    const opts = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    const file = typeof opts.name === 'string' ? opts.name : a instanceof File ? a.name : undefined;
    return {
      name: UPLOAD_APPLY_TOOL,
      args: { body: { branch: opts.branch, destination: opts.destination, mode: opts.mode }, file },
    };
  }
  return { name: String(a ?? ''), args: b };
}

/** A page's display name: its file name without the extension. */
export function pageName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}
