/**
 * Knowledge views as MCP Apps.
 *
 * Every HTML knowledge view the caller can read (a page built with the
 * `html-knowledge-view` skill, recognised by its `kb-snapshot` block) becomes
 * a tool whose result an MCP Apps host renders: the page itself, in the chat,
 * with live data. Nothing about a view is configured here; the knowledge base
 * is the catalog, and a view a team approves into it shows up as a tool.
 *
 * Per view:
 * - a tool, `show_<name>`, whose `_meta.ui.resourceUri` points at the view. It
 *   reads the view's data live and returns a text summary for the model, plus
 *   the snapshot for the page in `_meta` (which hosts hand the view, not the
 *   model);
 * - a `ui://hexis/views/<name>.html` resource: the page as committed, with the
 *   bridge (bridge.ts) and the compact presentation (native.ts) injected.
 *
 * And two app-only tools: `hexis_view_data`, the bridge's fallback for live
 * data when no tool result reached it, and `hexis_view_link`, which turns a
 * link the person followed in a view into the address to open, by the app's
 * own link grammar (platform-shared `kbHrefToAppUrl`).
 *
 * Reads go through the caller's own KB tools (`/api/agent/tools/*`), so the
 * caller's read access decides what a view can show, exactly as in the app.
 *
 * NOTHING SHOWN FROM A COPY. A page and a view's data are read from the
 * knowledge base for the request that shows them, so what a reader sees is
 * what the knowledge base lets them read at that moment, never what it let
 * them (or someone else) read before. Nothing is kept on disk.
 *
 * What is kept is the LIST of views, in memory, the way the server keeps the
 * tools discovery found: finding the views is one search over the whole
 * knowledge base (about five seconds on a large one), so it starts the moment
 * the catalog exists, beside discovery, and is refreshed behind a listing
 * when it is older than five minutes (or right away, for a view not in it). A
 * change the refresh finds is announced with `list_changed` notifications.
 * The list belongs to the reader whose credential found it: a credential
 * that changes drops it, the session and any search in flight, and an answer
 * read for one reader is never given to the next. A renewed credential cannot
 * be told apart from another person's, so it starts afresh too.
 */
import { createHash } from 'node:crypto';
import type { Resource, Tool as McpTool, CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { kbHrefToAppUrl } from '@bevel-software/platform-shared';
import type { HexisMcpConfig } from '../config.js';
import { callKbTool } from '../deployment.js';
import { injectBridge, VIEW_META_KEY, type BridgeConfig } from './bridge.js';
import {
  buildSnapshot,
  isKnowledgeView,
  mirrorFiles,
  readEmbeddedSnapshot,
  type KbReader,
  type Selection,
  type Snapshot,
} from './snapshot.js';

/** The MCP Apps resource type (`text/html;profile=mcp-app`). */
export const VIEW_MIME_TYPE = 'text/html;profile=mcp-app';
export const VIEW_DATA_TOOL = 'hexis_view_data';
export const VIEW_LINK_TOOL = 'hexis_view_link';
const VIEW_TOOL_PREFIX = 'show_';
const URI_PREFIX = 'ui://hexis/views/';
/** The repository's folder in KB tool paths and workspace URLs, until a search names it. */
const DEFAULT_KB_DIR = 'knowledge-base';
const DEFAULT_BRANCH = 'main';
/** How long a catalog is trusted before the next use refreshes it (in the background). */
const CATALOG_TTL_MS = 5 * 60_000;
/** Nodes the model's summary lists before it says how many more there are. */
const SUMMARY_NODES = 80;
/** The answer to a request whose reader changed while it was being read. */
const READER_CHANGED = 'The sign-in changed while this was being read, so it is not answered. Ask again.';
/**
 * The search matches the snapshot block alone, one line per view, so its
 * result cap is spent on views. A title pattern beside it matched the title of
 * every HTML page in the knowledge base and filled the cap with pages that are
 * not views. Titles come from the pages, which are read anyway.
 */
const SNAPSHOT_LINE = /<script\b[^>]*\bid=["']kb-snapshot["']/i;
const TITLE_LINE = /<title>([^<]+)<\/title>/i;
/** The search's cap, the most the grep tool allows. */
const SEARCH_CAP = 1000;

export interface ViewEntry {
  tool: string;
  uri: string;
  /** Repo path, without the repository folder (`knowledge-base/`). */
  path: string;
  title: string;
}

type CallKb = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ViewCatalogOptions {
  /** How the KB tools are called; the deployment's `/api/agent/tools/*` by default. */
  callKb?: CallKb;
  /** Called when a background refresh changed the list of views. */
  onChange?: () => void;
}

/** `To-Do-List.html` -> `To Do List`: the file name as a reader would say it. */
export function titleFromPath(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.html?$/i, '');
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A tool name for a view, unique among `taken`: `show_to_do_list`, then `show_to_do_list_2`. */
export function viewToolName(p: string, taken: Set<string>): string {
  const slug =
    titleFromPath(p)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'view';
  let name = `${VIEW_TOOL_PREFIX}${slug}`;
  for (let n = 2; taken.has(name); n += 1) name = `${VIEW_TOOL_PREFIX}${slug}_${n}`;
  taken.add(name);
  return name;
}

const splitRepoPath = (raw: string): { dir: string; rel: string } | null => {
  const full = raw.replace(/^\/+/, '');
  const slash = full.indexOf('/');
  return slash < 0 ? null : { dir: full.slice(0, slash), rel: full.slice(slash + 1) };
};

/**
 * The knowledge views in a search result, as repo paths, plus the repository's
 * folder name (every KB tool path starts with it). Only lines that are a
 * snapshot block count; skill templates are left out.
 */
export function viewPathsFromGrep(result: unknown): { kbDir: string | null; paths: string[] } {
  const matches = (result as { matches?: { path?: unknown; text?: unknown }[] } | null)?.matches ?? [];
  const paths = new Set<string>();
  let kbDir: string | null = null;
  for (const m of matches) {
    if (typeof m.path !== 'string' || typeof m.text !== 'string' || !SNAPSHOT_LINE.test(m.text)) continue;
    const split = splitRepoPath(m.path);
    if (!split) continue;
    kbDir ??= split.dir;
    if (!/\.html?$/i.test(split.rel)) continue;
    // A skill's own template carries an (empty) snapshot block too: not a view.
    if (/(^|\/)skills\/[^/]+\/assets\//.test(split.rel)) continue;
    paths.add(split.rel);
  }
  return { kbDir, paths: [...paths].sort() };
}

/** The model's view of a snapshot: one line per node, the short fields only. */
export function summarize(snapshot: Snapshot, limit = SUMMARY_NODES): string {
  const nodes = Object.values(snapshot.nodes);
  const lines = nodes.slice(0, limit).map((n) => {
    const name = n.fields.Name?.text || n.fields.Title?.text || n.file_path.split('/').pop();
    const facts = Object.entries(n.fields)
      .filter(([k, f]) => !['Name', 'Title', 'name', 'title'].includes(k) && f.text && f.text.length <= 60 && !f.text.includes('\n'))
      .map(([k, f]) => `${k} ${f.text}`);
    return `- [${n.node_type}] ${name}${facts.length ? ` · ${facts.join(' · ')}` : ''} (${n.file_path})`;
  });
  if (nodes.length > limit) lines.push(`- …and ${nodes.length - limit} more`);
  return lines.join('\n');
}

export interface ViewCatalog {
  /** Start finding the views now (idempotent): a listing later finds them ready. */
  prefetch(): void;
  handles(tool: string): boolean;
  listTools(): Promise<McpTool[]>;
  callTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Whether `uri` is a knowledge view's address, whether or not that view exists. */
  handlesResource(uri: string): boolean;
  listResources(): Promise<{ resources: Resource[] }>;
  readResource(uri: string): Promise<ReadResourceResult>;
}

const sameViews = (a: ViewEntry[], b: ViewEntry[]): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createViewCatalog(config: HexisMcpConfig, options: ViewCatalogOptions = {}): ViewCatalog {
  const call: CallKb = options.callKb ?? ((tool, args) => callKbTool(config, tool, args));
  const webBase = config.baseUrl.replace(/\/+$/, '');

  // -- state: the list of views, for one reader ---------------------------------------------
  /** The reader the list below was found for: a fingerprint of the credential. */
  const readerOf = (): string => createHash('sha256').update(config.connectionKey ?? '').digest('hex').slice(0, 32);
  let keptFor = readerOf();
  /** Bumped when the reader changes, so a read begun for the last one keeps nothing it finds. */
  let generation = 0;
  let kbDir = DEFAULT_KB_DIR;
  let views: ViewEntry[] | null = null;
  let viewsAt = 0;

  // One KB session for every view read: views only read, so the
  // one-ontology-per-session write boundary never comes into play.
  let session: Promise<string> | null = null;
  const sessionId = (): Promise<string> => {
    session ??= call('start_session', {}).then(
      (r) => {
        const id = (r as { sessionId?: unknown } | null)?.sessionId;
        if (typeof id !== 'string') throw new Error('start_session returned no sessionId');
        return id;
      },
      (err: unknown) => {
        session = null; // a failed mint is retried by the next read
        throw err;
      },
    );
    return session;
  };
  const kb = async (tool: string, body: Record<string, unknown>): Promise<unknown> =>
    call(tool, { ...body, sessionId: await sessionId() });
  const reader = (branch: string): KbReader => ({
    list: async (p) => {
      const r = (await kb('list_files', { branch, path: `${kbDir}/${p}` })) as { entries?: { name: string; type: string }[] };
      return r?.entries ?? [];
    },
    read: async (p) => {
      const r = (await kb('read_file', { branch, path: `${kbDir}/${p}` })) as { content?: unknown };
      if (typeof r?.content !== 'string') throw new Error(`no text content for ${p}`);
      return r.content;
    },
  });

  // -- finding the views ----------------------------------------------------------------
  let refreshing: Promise<ViewEntry[]> | null = null;
  const refresh = (): Promise<ViewEntry[]> => {
    const gen = generation;
    refreshing ??= (async () => {
      try {
        // Case-insensitive, as the pattern's own `i` is: `.source` drops the flag.
        const result = await kb('grep', {
          branch: DEFAULT_BRANCH,
          pattern: SNAPSHOT_LINE.source,
          ignore_case: true,
          max_results: SEARCH_CAP,
        });
        // Found for a reader who is no longer the one asking.
        if (gen !== generation) return [];
        const found = viewPathsFromGrep(result);
        if (found.kbDir) kbDir = found.kbDir;
        let paths = found.paths;
        if ((result as { truncated?: unknown } | null)?.truncated) {
          // A capped search says nothing about the views it did not reach, so
          // those are kept rather than dropped. A view deleted meanwhile stays
          // listed until a search completes.
          console.error('[hexis-mcp] the views search hit its result cap; views it did not reach are kept from before.');
          paths = [...new Set([...paths, ...(views ?? []).map((v) => v.path)])].sort();
        }
        // Each view keeps the title it was last served with; a new one starts
        // with its file's name until its page names it (see `titlePages`).
        const known = new Map((views ?? []).map((v) => [v.path, v.title]));
        const taken = new Set<string>();
        const next: ViewEntry[] = paths.map((p) => {
          const tool = viewToolName(p, taken);
          return {
            tool,
            uri: `${URI_PREFIX}${tool.slice(VIEW_TOOL_PREFIX.length)}.html`,
            path: p,
            title: known.get(p) ?? titleFromPath(p),
          };
        });
        const changed = views !== null && !sameViews(views, next);
        views = next;
        viewsAt = Date.now();
        console.error(`[hexis-mcp] ${next.length} knowledge view(s) served as MCP Apps.`);
        if (changed) options.onChange?.();
        void titlePages(next);
        return next;
      } catch (err) {
        console.error(`[hexis-mcp] knowledge views unavailable: ${err instanceof Error ? err.message : String(err)}`);
        // Keep serving what was found before rather than dropping every view.
        return gen === generation ? (views ?? []) : [];
      } finally {
        // A changed reader has already let go of this search, and may have started its own.
        if (gen === generation) refreshing = null;
      }
    })();
    return refreshing;
  };
  /**
   * Titles the views from their pages, behind the listing: a listing never
   * waits on a page read, which can take as long as the deployment's fetch
   * timeout. Reading the pages also warms them, so the first view opened is
   * served from memory. A title that changed is announced like any other
   * change to the list; a page that cannot be read keeps the title it has.
   */
  async function titlePages(list: ViewEntry[]): Promise<void> {
    const gen = generation;
    let renamed = false;
    await Promise.all(
      list.map(async (v) => {
        const title = await page(v, DEFAULT_BRANCH).then((html) => html.match(TITLE_LINE)?.[1]?.trim(), () => undefined);
        if (title && title !== v.title) {
          v.title = title;
          renamed = true;
        }
      }),
    );
    // Only for the list still served: a newer search has titled its own.
    if (renamed && gen === generation && views === list) options.onChange?.();
  }
  /** The views now: the known list at once (refreshed behind it when old), or the first search. */
  const current = async (): Promise<ViewEntry[]> => {
    if (views === null) return refresh();
    if (Date.now() - viewsAt > CATALOG_TTL_MS) void refresh();
    return views;
  };
  const byTool = async (tool: string): Promise<ViewEntry | undefined> =>
    (await current()).find((v) => v.tool === tool) ?? (await refresh()).find((v) => v.tool === tool);

  // -- a view's page and its live data ---------------------------------------------------------
  /**
   * The page as the knowledge base answers it now, for this reader: read for
   * each request that shows it, never served from a copy.
   */
  const page = (view: ViewEntry, branch: string): Promise<string> => reader(branch).read(view.path);

  async function liveSnapshot(view: ViewEntry, branch: string): Promise<{ snapshot: Snapshot; errors: string[] }> {
    const embedded = readEmbeddedSnapshot(await page(view, branch));
    const selection = embedded?.selection as Selection | undefined;
    const mirror = selection?.mirror;
    if (!selection || !mirror) {
      throw new Error(
        'this page records no mirror configuration (its snapshot was built from a folder, or by hand), so it cannot be read live',
      );
    }
    const { files, errors } = await mirrorFiles(reader(branch), mirror);
    const snapshot = buildSnapshot(files, selection, branch);
    return { snapshot, errors };
  }

  /**
   * Lets go of everything kept when the credential is no longer the one it
   * was kept for: the views, their pages, their last live data, the knowledge
   * base session and any search in flight. Every way in calls this first.
   */
  function forgetAnotherReader(): void {
    const now = readerOf();
    if (now === keptFor) return;
    keptFor = now;
    generation += 1;
    kbDir = DEFAULT_KB_DIR;
    views = null;
    viewsAt = 0;
    session = null;
    refreshing = null;
  }

  const branchOf = (args: Record<string, unknown>): string =>
    typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : DEFAULT_BRANCH;

  const viewTool = (view: ViewEntry): McpTool => ({
    name: view.tool,
    title: view.title,
    description:
      `Show the "${view.title}" view from the Hexis knowledge base (${view.path}) to the user as an interactive ` +
      'page in the chat, with live data. Returns a summary of what the view shows (each item with its file path), so ' +
      'you can act on it: edit those files with the knowledge-base tools when the user asks for a change. In clients ' +
      'without MCP Apps the summary is all that is shown.',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: `Branch to read the view and its data from (default ${DEFAULT_BRANCH}).` } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    // Both spellings: `ui.resourceUri` is current, `ui/resourceUri` is what older hosts read.
    _meta: { ui: { resourceUri: view.uri }, 'ui/resourceUri': view.uri },
  });

  const dataTool: McpTool = {
    name: VIEW_DATA_TOOL,
    title: 'Knowledge view data',
    description:
      'Used by Hexis knowledge views to load their live data. Not for direct use: call a show_* tool to show a view.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: "The view's show_* tool name." },
        branch: { type: 'string', description: `Branch (default ${DEFAULT_BRANCH}).` },
      },
      required: ['view'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };

  const linkTool: McpTool = {
    name: VIEW_LINK_TOOL,
    title: 'Knowledge view link',
    description:
      'Used by Hexis knowledge views to open a link the person followed in a view. Not for direct use: call a show_* tool to show a view.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: "The view's show_* tool name." },
        href: { type: 'string', description: 'The link as the page wrote it.' },
        branch: { type: 'string', description: `Branch the view was shown from (default ${DEFAULT_BRANCH}).` },
      },
      required: ['view', 'href'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };

  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** A view tool's answer, for the reader of the moment (see `callTool`). */
  async function answerTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (tool === VIEW_LINK_TOOL) {
      const view = await byTool(String(args.view ?? ''));
      if (!view) return { isError: true, content: [{ type: 'text', text: `Unknown view "${String(args.view)}".` }] };
      const href = String(args.href ?? '');
      // Where the same link goes in the app: its grammar, against the page
      // the link sits in (an app path starts with the repository's folder),
      // and its scheme allowlist, since the host opens what this answers.
      const url = kbHrefToAppUrl(href, {
        basePath: `${kbDir}/${view.path}`,
        kbDirName: kbDir,
        branch: branchOf(args),
        base: webBase,
      });
      if (url === null) return { isError: true, content: [{ type: 'text', text: `This link cannot be opened: ${href}` }] };
      return { content: [{ type: 'text', text: url }], structuredContent: { url } };
    }
    if (tool === VIEW_DATA_TOOL) {
      const view = await byTool(String(args.view ?? ''));
      if (!view) return { isError: true, content: [{ type: 'text', text: `Unknown view "${String(args.view)}".` }] };
      try {
        const { snapshot } = await liveSnapshot(view, branchOf(args));
        return {
          content: [{ type: 'text', text: `${Object.keys(snapshot.nodes).length} node(s), live.` }],
          structuredContent: { snapshot },
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: errorText(err) }] };
      }
    }
    const view = await byTool(tool);
    if (!view) return { isError: true, content: [{ type: 'text', text: `Unknown view "${tool}".` }] };
    const branch = branchOf(args);
    try {
      const { snapshot, errors } = await liveSnapshot(view, branch);
      const count = Object.keys(snapshot.nodes).length;
      const lines = [
        `Showing "${view.title}" (${view.path}), live from branch ${branch}: ${count} item(s). ` +
          'The user sees the page rendered in the chat; changes they make there arrive as a message.',
      ];
      if (errors.length) lines.push(`Some files could not be read (${errors.length}): ${errors.slice(0, 3).join('; ')}`);
      lines.push('', summarize(snapshot));
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        _meta: { [VIEW_META_KEY]: { path: view.path, branch, snapshot } },
      };
    } catch (err) {
      // The page still renders, from the snapshot it carries.
      return {
        content: [
          {
            type: 'text',
            text: `Showing "${view.title}" (${view.path}) from its embedded snapshot; live data did not load: ${errorText(err)}`,
          },
        ],
        _meta: { [VIEW_META_KEY]: { path: view.path, branch, liveError: errorText(err) } },
      };
    }
  }

  /** A view's page, for the reader of the moment (see `readResource`). */
  async function readPage(uri: string): Promise<ReadResourceResult> {
    const view = (await current()).find((v) => v.uri === uri) ?? (await refresh()).find((v) => v.uri === uri);
    if (!view) throw new Error(`Unknown resource ${uri}`);
    const html = await page(view, DEFAULT_BRANCH);
    if (!isKnowledgeView(html)) throw new Error(`${view.path} is no longer a knowledge view`);
    const bridge: BridgeConfig = {
      view: view.tool,
      dataTool: VIEW_DATA_TOOL,
      linkTool: VIEW_LINK_TOOL,
      pagePath: view.path,
      branch: DEFAULT_BRANCH,
      kbDir,
    };
    return {
      contents: [
        {
          uri,
          mimeType: VIEW_MIME_TYPE,
          text: injectBridge(html, bridge),
          // Self-contained pages: no network origins to declare.
          _meta: { ui: { prefersBorder: true, csp: {} } },
        },
      ],
    };
  }

  /**
   * The views for the reader of the moment. A list read for a reader who
   * changed while it was read is not answered; the new reader's is read
   * instead (once: a credential that keeps changing gets an empty list).
   */
  async function currentForReader(): Promise<ViewEntry[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      forgetAnotherReader();
      const gen = generation;
      const list = await current();
      forgetAnotherReader();
      if (gen === generation) return list;
    }
    return [];
  }

  return {
    prefetch() {
      forgetAnotherReader();
      // Search now, alongside discovery, so the first listing finds the views ready.
      if (views === null) void refresh();
    },

    handles: (tool) => {
      forgetAnotherReader();
      return tool === VIEW_DATA_TOOL || tool === VIEW_LINK_TOOL || (views ?? []).some((v) => v.tool === tool);
    },

    async listTools() {
      const list = await currentForReader();
      return list.length ? [...list.map(viewTool), dataTool, linkTool] : [];
    },

    async callTool(tool, args) {
      forgetAnotherReader();
      const gen = generation;
      const result = await answerTool(tool, args);
      // Read for a reader who is no longer the one asking: say so instead of answering with it.
      forgetAnotherReader();
      return gen === generation ? result : { isError: true, content: [{ type: 'text', text: READER_CHANGED }] };
    },

    handlesResource: (uri) => uri.startsWith(URI_PREFIX),

    async listResources() {
      return {
        resources: (await currentForReader()).map((v) => ({
          uri: v.uri,
          name: v.tool,
          title: v.title,
          description: `Knowledge view ${v.path}`,
          mimeType: VIEW_MIME_TYPE,
        })),
      };
    },

    async readResource(uri) {
      forgetAnotherReader();
      const gen = generation;
      const result = await readPage(uri);
      forgetAnotherReader();
      if (gen !== generation) throw new Error(READER_CHANGED);
      return result;
    },
  };
}
